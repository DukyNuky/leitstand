/* Proxmox Mail Gateway.

   Der wichtigste Fall steht ganz oben: PMG nimmt keine API-Token. Das
   war lange anders eingebaut — mit dem Ergebnis, dass die Anbindung
   gegen den Testserver grün meldete und gegen das Gerät im Netz nie
   eine Zahl lieferte. */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fakePmg, listen, BENUTZER, PASSWORT } from "./fake-pmg.js";
import { collectPmg, testConnection, anmelden, api, bauzeit,
  ticketVergessen, speicherVergessen } from "../src/collectors/pmg.js";

let srv, url;
before(async () => { srv = fakePmg(); url = await listen(srv); });
after(() => srv.close());
beforeEach(() => { ticketVergessen(); speicherVergessen(); });

const cred = { user: BENUTZER, password: PASSWORT };
/* Erst beim Aufruf gebaut: `url` steht erst nach `before` fest. */
const host = () => ({ id: "pmg-01", name: "pmg-01", type: "pmg", url });
/* Ohne eigenen Takt zwischen zwei Aufrufen desselben Tests: die Tests
   wollen messen, nicht warten. */
const sofort = { pmg_takt: 0, pmg_takt_lang: 0 };

test("Eine Token-Kopfzeile wird von PMG abgewiesen", async () => {
  const r = await fetch(`${url}/api2/json/version`, {
    headers: { Authorization: "PMGAPIToken=leitstand@pmg!ro=1a2b3c4d" }
  });
  assert.equal(r.status, 401, "PMG kennt keine API-Token — die Dokumentation sagt etwas anderes als der Dienst");
});

test("Angemeldet wird mit Ticket und Cookie", async () => {
  const an = await anmelden(host(), cred);
  assert.equal(an.ok, true);
  assert.equal(an.rolle, "audit");
  const r = await api(host(), cred, "/version");
  assert.equal(r.ok, true);
  assert.equal(r.data.data.version, "8.1.4");
});

test("Falsches Passwort meldet 401 statt einer leeren Zahl", async () => {
  const an = await anmelden(host(), { user: BENUTZER, password: "falsch" });
  assert.equal(an.ok, false);
  assert.equal(an.status, 401);
});

/* Ein Anmeldevorgang je Durchlauf stünde alle 15 s im Syslog des
   Gateways — und wäre in einer Überwachung, die nur liest, schwer zu
   erklären. */
test("Das Ticket wird wiederverwendet, nicht bei jedem Abruf neu geholt", async () => {
  const vorher = srv.zustand.anmeldungen;
  await api(host(), cred, "/version");
  await api(host(), cred, "/nodes");
  await api(host(), cred, "/version");
  assert.equal(srv.zustand.anmeldungen - vorher, 1);
});

test("Sammler liest Verkehr, Warteschlange, Quarantäne und Signaturen", async () => {
  const r = await collectPmg(host(), cred, sofort);
  assert.equal(r.node, "pmg-01");
  assert.equal(r.version, "8.1.4");
  assert.equal(r.in24, 1840);
  assert.equal(r.out24, 96);
  assert.equal(r.spam, 1216);
  assert.equal(r.spamAnteil, 66, "Anteil am angenommenen Eingang, nicht an allem");
  assert.equal(r.virus, 3);
  assert.equal(r.abgewiesen, 5100 + 830 + 12 + 240, "was an der Tür abgewiesen wurde, ist nie eingegangen");
  assert.equal(r.avgMs, 430, "PMG rechnet in Sekunden, der Leitstand in Millisekunden");
  assert.equal(r.queueDeferred, 4);
  assert.equal(r.queueAktiv, 1);
  assert.equal(r.queueHold, 0, "eine leere Warteschlange ist gemessen und nicht unbekannt");
  assert.equal(r.quarSpam, 812);
  assert.equal(r.quarVirus, 9);
  assert.equal(r.ram, 40);
  assert.equal(r.disk, 42);
  assert.equal(r.cores, 4);
  assert.equal(r.insync, true);
  assert.equal(r.updates, 1);
  assert.equal(r.domains.length, 2);
  assert.equal(r.viren[0].name, "Html.Phishing.Bank-1234");
  assert.equal(r.signaturen.find(s => s.name === "daily").alterStunden, 3);
});

/* Ein Mail Gateway, das Viren abfängt, tut genau das, wofür es dasteht.
   Eine Ampel, die dabei jedes Mal gelb wird, ist nach zwei Wochen
   abtrainiert — und mit ihr die Ampel für alles andere. */
test("Eingehende Virenfunde sind eine Auskunft, keine Warnung", async () => {
  const r = await collectPmg(host(), cred, sofort);
  assert.equal(r.status, undefined, "grün bleibt grün");
  assert.match(r.note, /3 eingehende/);
});

test("Ausgehende Virenfunde sind rot", async () => {
  srv.zustand.virusAus = 2;
  try {
    const r = await collectPmg(host(), cred, sofort);
    assert.equal(r.status, "crit");
    assert.match(r.note, /eigenen Netz/);
  } finally { srv.zustand.virusAus = 0; }
});

test("Steht ein Kerndienst, ist das kritisch — ein Zeitgeber im Ruhezustand nicht", async () => {
  const alle = await api(host(), cred, "/nodes/pmg-01/services");
  srv.zustand.dienste = alle.data.data.map(d =>
    d.service === "pmg-smtp-filter" ? { ...d, state: "dead", "active-state": "failed" } : d);
  speicherVergessen();
  try {
    const r = await collectPmg(host(), cred, sofort);
    assert.equal(r.status, "crit");
    assert.deepEqual(r.diensteSteht, ["pmg-smtp-filter"]);
    assert.match(r.note, /geprüft/);
  } finally { srv.zustand.dienste = null; }
});

test("Eine volle Warteschlange springt erst auf Gelb, dann auf Rot", async () => {
  srv.zustand.deferred = 30;
  speicherVergessen();
  try {
    let r = await collectPmg(host(), cred, sofort);
    assert.equal(r.status, "warn");
    srv.zustand.deferred = 140;
    speicherVergessen();
    r = await collectPmg(host(), cred, sofort);
    assert.equal(r.status, "crit");
    assert.match(r.note, /kritisch ab 100/);
  } finally { srv.zustand.deferred = 4; }
});

/* Zehn Mail in der Zustellung sind Betrieb. Zehn Mail, die seit gestern
   liegen, sind ein Empfänger, der nicht mehr antwortet — die Menge
   allein sagt das nicht. */
test("Alte Mail in der Warteschlange fällt auch unterhalb der Menge auf", async () => {
  srv.zustand.deferred = 6;
  srv.zustand.deferredAlt = 6;
  speicherVergessen();
  try {
    const r = await collectPmg(host(), cred, sofort);
    assert.equal(r.queueAlt, 6);
    assert.equal(r.status, "warn");
    assert.match(r.note, /zehn Stunden/);
  } finally { srv.zustand.deferred = 4; srv.zustand.deferredAlt = 0; }
});

/* Der stillste Ausfall: freshclam kommt nicht mehr durch, ClamAV läuft
   weiter und scannt mit dem Stand von vorgestern. */
test("Veraltete Virensignaturen sind eine Warnung", async () => {
  srv.zustand.signaturStunden = 50;
  speicherVergessen();
  try {
    const r = await collectPmg(host(), cred, sofort);
    assert.equal(r.status, "warn");
    assert.match(r.note, /Virensignaturen sind 50 Stunden alt/);
  } finally { srv.zustand.signaturStunden = 3; }
});

test("Ein Knoten ohne Abgleich im Verbund wird gemeldet", async () => {
  srv.zustand.insync = 0;
  speicherVergessen();
  try {
    const r = await collectPmg(host(), cred, sofort);
    assert.equal(r.insync, false);
    assert.equal(r.status, "warn");
    assert.match(r.note, /Regeldatenbank/);
  } finally { srv.zustand.insync = 1; }
});

/* Der Durchlauf kommt alle 15 s; qshape startet je Abruf einen Prozess
   auf dem Gerät, und die Tagesstatistik ändert sich in 15 s nicht. */
test("Der eigene Takt hält die Zahl der Abrufe klein", async () => {
  const vorher = srv.zustand.abrufe.length;
  await collectPmg(host(), cred, {});
  const ersteRunde = srv.zustand.abrufe.length - vorher;
  await collectPmg(host(), cred, {});
  await collectPmg(host(), cred, {});
  assert.equal(srv.zustand.abrufe.length - vorher, ersteRunde,
    "innerhalb des Taktes wird das zuletzt Gelesene weitergereicht");
});

test("Der Zeitstempel der ClamAV-Kopfzeile wird gelesen, nicht geraten", () => {
  assert.equal(bauzeit("16 Mar 2026 23-17 +0000"), "2026-03-16T23:17:00.000Z");
  assert.equal(bauzeit("16 Mar 2026 23-17 +0200"), "2026-03-16T21:17:00.000Z");
  assert.equal(bauzeit("kein Datum"), null, "was sich nicht lesen lässt, bleibt leer");
});

test("Verbindungstest nennt Fassung, Konto und Rolle", async () => {
  const r = await testConnection(host(), cred);
  assert.equal(r.ok, true);
  assert.match(r.detail, /8\.1\.4/);
  assert.match(r.detail, /leitstand@pmg/);
  assert.match(r.detail, /Rolle audit/);
});

test("Verbindungstest ohne Zugangsdaten sagt, was fehlt", async () => {
  const r = await testConnection(host(), {});
  assert.equal(r.ok, false);
  assert.match(r.detail, /Benutzer/);
});

/* Stehengebliebene Zahlen sind gefährlicher als eine Lücke: sie sehen aus
   wie gemessene. Also bleiben sie stehen — aber mit Fehler daneben, aus
   dem der Kern eine gelbe Ampel macht. */
test("Bricht der Abruf ab, bleiben die Werte stehen und der Fehler steht dabei", async () => {
  const erst = await collectPmg(host(), cred, sofort);
  assert.equal(erst.in24, 1840);
  assert.equal(erst.error, undefined);

  srv.zustand.kaputt = true;
  try {
    const dann = await collectPmg(host(), cred, sofort);
    assert.equal(dann.in24, 1840, "die zuletzt gelesene Zahl bleibt");
    assert.ok(dann.error, "aber sie steht nicht ohne Vermerk da");
    assert.ok(dann.stand, "und mit dem Zeitpunkt, an dem sie gelesen wurde");
  } finally { srv.zustand.kaputt = false; }
});

test("Die Diagnose führt die Anmeldung als eigenen Schritt", async () => {
  const { diagnoseHost } = await import("../src/diagnose.js");
  const bericht = await diagnoseHost({ ...host(), checks: [] }, cred);
  assert.equal(bericht.ok, true);
  assert.equal(bericht.api[0].pfad, "/access/ticket");
  assert.match(bericht.api[0].befund, /Rolle audit/);
  assert.match(bericht.zugang.form, /PMGAuthCookie/);
  /* Der Knotenname steht in keiner Adresse fest — er kommt aus /nodes. */
  assert.ok(bericht.api.some(a => a.pfad.includes("/nodes/pmg-01/status")));
});

test("Ohne Realm im Benutzernamen sagt die Diagnose, warum PMG ablehnt", async () => {
  const { diagnoseHost } = await import("../src/diagnose.js");
  const bericht = await diagnoseHost({ ...host(), checks: [] }, { user: "leitstand", password: PASSWORT });
  assert.match(bericht.zugang.hinweis, /@quarantine/);
});

/* Der zweite Fallstrick derselben Anmeldung, und einer, den kein
   gewöhnlicher Testserver zeigt: der HTTP-Dienst von Proxmox nimmt
   `Transfer-Encoding: chunked` nicht an, sondern antwortet mit 501 —
   noch bevor jemand die Zugangsdaten ansieht. Node schickt genau das,
   wenn man die Länge des Rumpfs nicht ansagt. */
test("Die Anmeldung sagt die Länge ihres Rumpfs an", async () => {
  const vorher = srv.zustand.chunked;
  const an = await anmelden(host(), cred);
  assert.equal(an.ok, true);
  assert.equal(srv.zustand.chunked - vorher, 0, "sonst weist pmgproxy sie mit 501 ab");

  /* Und damit diese Prüfung nicht ins Leere greift: derselbe Aufruf ohne
     angesagte Länge — Node schickt ihn dann stückweise. */
  const stueckweise = await new Promise(fertig => {
    const r = http.request(url + "/api2/json/access/ticket",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } },
      res => { res.resume(); fertig(res.statusCode); });
    r.write(`username=${encodeURIComponent(BENUTZER)}&password=${PASSWORT}`);
    r.end();
  });
  assert.equal(stueckweise, 501, "chunked lehnt der HTTP-Dienst von Proxmox ab");
});
