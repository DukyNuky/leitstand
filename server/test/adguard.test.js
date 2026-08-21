/* AdGuard Home: der Dienst, dessen Ausfall im ganzen Netz sofort weh tut.

   Geprüft wird gegen einen nachgebauten Endpunkt über echtes HTTP — samt
   der beiden Fälle, die ein offener Port nicht sieht: abgeschalteter
   Schutz und ein DNS-Dienst, der steht, während die Oberfläche antwortet. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAdguard, testConnection, bearbeitungszeit, fenster, baseUrl } from "../src/collectors/adguard.js";
import { diagnoseHost } from "../src/diagnose.js";
import { fakeAdguard, listen, close, ADGUARD_USER, ADGUARD_PASS } from "./fake-dienste.js";

const CRED = { user: ADGUARD_USER, password: ADGUARD_PASS };

async function mitFake(opt, fn) {
  const s = fakeAdguard(opt);
  const url = await listen(s);
  try { return await fn({ id: "dns-01", type: "adguard", name: "AdGuard", url }); }
  finally { await close(s); }
}

test("Der Sammler liest Anfragen, Blockanteil und Bearbeitungszeit", async () => {
  const out = await mitFake({}, h => collectAdguard(h, CRED));

  assert.equal(out.version, "v0.107.52");
  assert.equal(out.dnsRunning, true);
  assert.equal(out.protection, true);
  /* Der Fake führt 48 Stundeneimer à 100 Anfragen — „24 h" muss die
     letzten 24 summieren, nicht alle 48. */
  assert.equal(out.statsFenster, "24 h");
  assert.equal(out.dnsQueries, 2400);
  assert.equal(out.dnsBlocked, 480);
  assert.equal(out.blockRate, 20);
  assert.equal(out.avgMs, 23.4);
  assert.equal(out.filtersAktiv, 2);
  assert.equal(out.filterRules, 73000);
  assert.equal(out.upstreams, 1, "Kommentarzeilen sind keine Upstreams");
  assert.equal(out.status, undefined, "nichts Auffälliges, also keine Farbe");
  assert.match(out.note, /2400 Anfragen \/ 24 h, 20 % geblockt/);
});

/* Ein AdGuard mit abgeschaltetem Schutz antwortet tadellos — und lässt
   alles durch. Genau dafür gibt es diesen Sammler. */
test("Abgeschalteter Schutz ist gelb, nicht grün", async () => {
  const out = await mitFake({ protection: false }, h => collectAdguard(h, CRED));
  assert.equal(out.status, "warn");
  assert.match(out.note, /Schutz ist abgeschaltet/);
});

test("Abgeschaltete Filterung wird ebenso genannt", async () => {
  const out = await mitFake({ filtering: false }, h => collectAdguard(h, CRED));
  assert.equal(out.status, "warn");
  assert.match(out.note, /Filterung ist abgeschaltet/);
});

test("Steht der DNS-Dienst, ist das rot — auch wenn die Oberfläche antwortet", async () => {
  const out = await mitFake({ running: false }, h => collectAdguard(h, CRED));
  assert.equal(out.status, "crit");
  assert.match(out.note, /läuft nicht/);
});

test("Träge Upstreams gehen auf Gelb", async () => {
  const out = await mitFake({ avg: 0.145 }, h => collectAdguard(h, CRED));
  assert.equal(out.avgMs, 145);
  assert.equal(out.status, "warn");
  assert.match(out.note, /145 ms/);
});

/* Die Statistik läuft über ein einstellbares Fenster. „Anfragen 24 h" an
   eine Zahl zu schreiben, die 90 Tage umfasst, wäre schlicht falsch. */
test("Ein anderes Statistikfenster wird benannt, nicht als 24 h ausgegeben", async () => {
  const out = await mitFake({ einheit: "days", eimer: 90, proAnfragen: 1000, proGeblockt: 100 },
    h => collectAdguard(h, CRED));
  assert.equal(out.statsFenster, "90 Tage");
  assert.equal(out.dnsQueries, 90000);
  assert.equal(out.blockRate, 10);
});

test("Ohne Zahlen wird nichts gerechnet", () => {
  const f = fenster({});
  assert.equal(f.queries, null);
  assert.equal(f.blocked, null);
  assert.equal(f.label, null);
});

/* AdGuard dokumentiert Sekunden, ältere Fassungen lieferten Millisekunden.
   Umgedeutet wird nur, was als Sekunde absurd wäre. */
test("Sekunden und Millisekunden werden auseinandergehalten", () => {
  assert.equal(bearbeitungszeit(0.0234), 23.4, "Sekunden, wie dokumentiert");
  assert.equal(bearbeitungszeit(0.0005), 0.5, "eine halbe Millisekunde bleibt eine halbe");
  assert.equal(bearbeitungszeit(42), 42, "42 Sekunden je Anfrage gibt es nicht — das sind Millisekunden");
  assert.equal(bearbeitungszeit(null), null);
  assert.equal(bearbeitungszeit("kaputt"), null);
});

test("Falsches Passwort: Warnung mit Klartext statt stiller Lücke", async () => {
  const out = await mitFake({}, h => collectAdguard(h, { user: "leitstand", password: "falsch" }));
  assert.equal(out.status, "warn");
  assert.match(out.error, /401/);
  assert.equal(out.dnsQueries, undefined, "erfunden wird nichts");
});

test("Ist nur die Statistik gesperrt, bleibt der Zustand lesbar", async () => {
  const out = await mitFake({ statsStatus: 403 }, h => collectAdguard(h, CRED));
  assert.equal(out.version, "v0.107.52");
  assert.equal(out.dnsQueries, null);
  assert.equal(out.status, "warn");
  assert.match(out.note, /Statistik nicht/);
});

test("Der Verbindungstest prüft auch die Statistik, nicht nur die Anmeldung", async () => {
  const gut = await mitFake({}, h => testConnection(h, CRED));
  assert.equal(gut.ok, true);
  assert.match(gut.detail, /AdGuard Home v0\.107\.52/);
  assert.match(gut.detail, /2400 Anfragen/);

  const halb = await mitFake({ statsStatus: 403 }, h => testConnection(h, CRED));
  assert.equal(halb.ok, false, "angemeldet, aber unbrauchbar — das ist kein grüner Test");
  assert.match(halb.detail, /Statistik ist nicht lesbar/);

  const weg = await mitFake({}, h => testConnection(h, { user: "x", password: "y" }));
  assert.equal(weg.ok, false);
  assert.match(weg.hint, /Oberfläche/);
});

/* Hinter einem Reverse Proxy liegt AdGuard oft unter einem Unterpfad —
   ohne ihn ginge jeder Aufruf in die Startseite des Proxys. */
test("Ein Unterpfad in der Adresse bleibt erhalten", () => {
  assert.equal(baseUrl({ url: "https://proxy.example/adguard/" }), "https://proxy.example/adguard");
  assert.equal(baseUrl({ url: "http://10.0.0.5:3000/" }), "http://10.0.0.5:3000");
  assert.equal(baseUrl({ ip: "10.0.0.5" }), "https://10.0.0.5");
});

test("Die Diagnose zeigt jeden Aufruf mit dem, was zurückkam", async () => {
  const b = await mitFake({}, h => diagnoseHost({ ...h, checks: [] }, CRED, { icmp: false, timeout: 1 }));
  assert.equal(b.ok, true);
  assert.equal(b.api.length, 4);
  assert.ok(b.api.every(a => a.ok));
  assert.match(b.api[0].befund, /Schutz an/);
  assert.match(b.api[1].befund, /2400 Anfragen/);
  assert.match(b.zugang.form, /Basic leitstand:•/);
  assert.ok(!/geheim/.test(JSON.stringify(b)), "das Passwort verlässt den Dienst nicht");
  assert.match(b.fazit, /Alle nötigen Aufrufe/);
});

test("Ohne hinterlegten Zugang sagt die Diagnose, was fehlt", async () => {
  const b = await mitFake({}, h => diagnoseHost({ ...h, checks: [] }, null, { icmp: false }));
  assert.equal(b.ok, false);
  assert.match(b.fazit, /kein Zugang hinterlegt/i);
  assert.equal(b.api.length, 0);
});
