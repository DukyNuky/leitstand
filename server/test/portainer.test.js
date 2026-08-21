/* Portainer: Stacks, Container — und wer klemmt.

   Geprüft wird gegen einen nachgebauten Endpunkt über echtes HTTP. Die
   Fälle, an denen es im Betrieb hängt, sind hier alle vertreten: eine
   Umgebung, deren Agent schweigt, ein Container in der Neustartschleife,
   einer mit Exit 137 — und die Eigenheit, dass Portainer Listen nach
   Rechten filtert, statt sie abzulehnen. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPortainer, testConnection, baseUrl } from "../src/collectors/portainer.js";
import { diagnoseHost } from "../src/diagnose.js";
import { fakePortainer, listen, close, PORTAINER_TOKEN, UMGEBUNGEN } from "./fake-dienste.js";

const CRED = { token: PORTAINER_TOKEN };

async function mitFake(opt, fn) {
  const s = fakePortainer(opt);
  const url = await listen(s);
  try { return await fn({ id: "ptr-01", type: "portainer", name: "Portainer", url }); }
  finally { await close(s); }
}

test("Der Sammler zählt aus der Momentaufnahme, ohne jeden Container einzeln zu fragen", async () => {
  const out = await mitFake({}, h => collectPortainer(h, CRED));

  assert.equal(out.version, "2.21.4");
  assert.equal(out.endpoints, 2);
  assert.equal(out.endpointsDown, 1);
  assert.equal(out.running, 20);
  assert.equal(out.stopped, 2);
  assert.equal(out.containers, 22);
  assert.equal(out.unhealthy, 1);
  assert.equal(out.stacks, 2, "aus /api/stacks, nicht aus der Momentaufnahme");
  assert.equal(out.stacksInaktiv, 1);
  assert.equal(out.umgebungen.length, 2);
  assert.equal(out.umgebungen[0].docker, "27.3.1");
  assert.equal(out.umgebungen[1].erreichbar, false);
  assert.ok(out.umgebungen[0].stand, "wie alt die Momentaufnahme ist, gehört dazu");
});

/* Eine Zahl ohne Namen hilft niemandem: gesucht wird der Container, der
   klemmt, nicht die Erkenntnis, dass einer klemmt. */
test("Neustartschleife und Exit 137 werden mit Namen gemeldet", async () => {
  const out = await mitFake({}, h => collectPortainer(h, CRED));

  assert.equal(out.restarting, 1);
  assert.equal(out.oom, 1);
  const namen = out.probleme.map(p => p.name);
  assert.deepEqual(namen.sort(), ["jellyfin", "paperless", "vaultwarden"]);
  assert.match(out.probleme.find(p => p.name === "jellyfin").grund, /Speichergrenze/);
  assert.match(out.probleme.find(p => p.name === "paperless").grund, /neu/);
  assert.match(out.probleme.find(p => p.name === "vaultwarden").grund, /unhealthy/);
  assert.equal(out.probleme.every(p => p.umgebung === "docker-hq"), true);
  assert.ok(!out.probleme.some(p => p.name === "alt"), "ein sauber beendeter Container ist kein Problem");

  assert.equal(out.status, "warn");
  assert.match(out.note, /Exit 137/);
  assert.match(out.note, /Neustartschleife/);
});

/* Portainer lehnt einen Benutzer ohne Rechte nicht ab — es liefert ihm
   eine leere Liste. Ohne diese Unterscheidung stünde da eine ruhige Null. */
test("Keine sichtbare Umgebung ist ein Rechteproblem, keine leere Anlage", async () => {
  const out = await mitFake({ endpoints: [] }, h => collectPortainer(h, CRED));
  assert.equal(out.status, "warn");
  assert.match(out.note, /filtert die Liste nach Rechten/);
  assert.equal(out.containers, null, "gezählt wird nichts, was niemand sehen durfte");
  assert.equal(out.running, null);
});

test("Antwortet keine einzige Umgebung, ist das rot", async () => {
  const nur = [{ ...UMGEBUNGEN[1] }];
  const out = await mitFake({ endpoints: nur }, h => collectPortainer(h, CRED));
  assert.equal(out.status, "crit");
  assert.match(out.note, /antwortet nicht/);
});

test("Ist die Containerliste gesperrt, bleiben die Zahlen — die Namen fehlen", async () => {
  const out = await mitFake({ containerStatus: 403 }, h => collectPortainer(h, CRED));
  assert.equal(out.running, 20, "die Momentaufnahme steht unabhängig davon");
  assert.equal(out.restarting, null, "nichts gelesen heißt nicht „nichts gefunden“");
  assert.equal(out.oom, null);
  assert.equal(out.probleme, null);
  assert.equal(out.status, "warn");
  assert.match(out.note, /docker-hq/);
});

test("Fehlt der Stack-Endpunkt, zählt die Momentaufnahme", async () => {
  const out = await mitFake({ stacksStatus: 404 }, h => collectPortainer(h, CRED));
  assert.equal(out.stacks, 7, "5 + 2 aus den Momentaufnahmen");
  assert.equal(out.stacksInaktiv, null, "ohne den Endpunkt gibt es die Unterscheidung nicht");
});

/* Der Pfad für die Fassung wurde zwischen den Portainer-Ständen
   umbenannt. Beides muss gehen, ohne dass jemand etwas einstellt. */
test("Die Fassung kommt auch vom alten Pfad", async () => {
  const out = await mitFake({ systemStatus: false }, h => collectPortainer(h, CRED));
  assert.equal(out.version, "2.21.4");
});

test("Falscher Token: Warnung mit Klartext statt stiller Lücke", async () => {
  const out = await mitFake({}, h => collectPortainer(h, { token: "falsch" }));
  assert.equal(out.status, "warn");
  assert.match(out.error, /401/);
  assert.equal(out.containers, undefined);
});

test("Der Verbindungstest sagt, was sichtbar ist", async () => {
  const gut = await mitFake({}, h => testConnection(h, CRED));
  assert.equal(gut.ok, true);
  assert.match(gut.detail, /Portainer 2\.21\.4/);
  assert.match(gut.detail, /2 Umgebung\(en\), 1 erreichbar/);

  const leer = await mitFake({ endpoints: [] }, h => testConnection(h, CRED));
  assert.equal(leer.ok, false, "angemeldet ohne Sicht ist kein grüner Test");
  assert.match(leer.hint, /read-only/);

  const weg = await mitFake({}, h => testConnection(h, { token: "x" }));
  assert.equal(weg.ok, false);
  assert.match(weg.hint, /Access tokens/);
});

test("Adresse: Port und Unterpfad bleiben stehen", () => {
  assert.equal(baseUrl({ url: "https://ptr.example:9443/" }), "https://ptr.example:9443");
  assert.equal(baseUrl({ url: "https://proxy.example/portainer/" }), "https://proxy.example/portainer");
  assert.equal(baseUrl({ ip: "10.0.0.9" }), "https://10.0.0.9:9443");
});

test("Die Diagnose setzt die Umgebung aus der Antwort davor ein", async () => {
  const b = await mitFake({}, h => diagnoseHost({ ...h, checks: [] }, CRED, { icmp: false, timeout: 1 }));
  assert.equal(b.ok, true);
  const container = b.api.find(a => a.pfad.includes("/docker/containers/"));
  assert.match(container.pfad, /\/api\/endpoints\/3\/docker/, "die erste erreichbare Umgebung, keine geratene 1");
  assert.match(container.befund, /5 Container, davon 2 laufend/);
  assert.match(b.api.find(a => a.pfad === "/api/endpoints").befund, /docker-rz \(antwortet nicht\)/);
  assert.match(b.zugang.form, /X-API-Key: ptr_…/);
  assert.ok(!JSON.stringify(b).includes(PORTAINER_TOKEN), "der Token verlässt den Dienst nicht");
});

test("Ohne sichtbare Umgebung nennt die Diagnose das Rechteproblem", async () => {
  const b = await mitFake({ endpoints: [] }, h => diagnoseHost({ ...h, checks: [] }, CRED, { icmp: false }));
  assert.equal(b.ok, false);
  assert.match(b.fazit, /nach Rechten/);
  assert.match(b.fazit, /read-only/);
});
