/* Mailcow.

   Der Fall, der diesem Sammler seine Form gibt, steht in der Mitte:
   eine 401 von mailcow heißt nicht unbedingt „falscher Schlüssel". Sie
   heißt oft „diese Adresse steht nicht in „allow from““ — und welche
   Adresse mailcow gesehen hat, steht nur im Rumpf der Antwort. */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fakeMailcow, listen, KEY } from "./fake-mailcow.js";
import { collectMailcow, testConnection, api, ipAusAntwort, hintFor,
  speicherVergessen } from "../src/collectors/mailcow.js";

let srv, url;
before(async () => { srv = fakeMailcow(); url = await listen(srv); });
after(() => srv.close());
beforeEach(() => speicherVergessen());

const cred = { apiKey: KEY };
const host = () => ({ id: "mailcow-01", name: "mailcow-01", type: "mailcow", url });
const sofort = { mailcow_takt: 0, mailcow_takt_lang: 0 };

test("Ohne Schlüssel gibt es keine Auskunft", async () => {
  const r = await api(host(), {}, "/get/status/version");
  assert.equal(r.ok, false);
  assert.match(r.error, /Kein API-Schlüssel/);

  const falsch = await api(host(), { apiKey: "falsch" }, "/get/status/version");
  assert.equal(falsch.status, 401);
});

/* Der teuerste Irrtum dieser Anbindung: der Schlüssel stimmt, die
   Adresse nicht. mailcow antwortet in beiden Fällen mit 401 — nur die
   Meldung im Rumpf unterscheidet sie, und sie nennt die Adresse, die
   mailcow tatsächlich gesehen hat. Hinter einem Reverse Proxy ist das
   dessen Adresse. */
test("Eine abgewiesene Quell-IP wird als solche erkannt, nicht als falscher Schlüssel", async () => {
  srv.zustand.ipVerweigert = true;
  try {
    const r = await api(host(), cred, "/get/status/version");
    assert.equal(r.status, 401);
    assert.equal(ipAusAntwort(r.body), "10.0.0.7");
    const hinweis = hintFor(r);
    assert.match(hinweis, /10\.0\.0\.7/);
    assert.match(hinweis, /allow from/);
    assert.match(hinweis, /Reverse Proxy/);
  } finally { srv.zustand.ipVerweigert = false; }
});

test("Sammler liest Container, Warteschlange, Platz und Wirt", async () => {
  const r = await collectMailcow(host(), cred, sofort);
  assert.equal(r.version, "2026-03a");
  assert.equal(r.containerGesamt, 14);
  assert.equal(r.containerLaufen, 14);
  assert.deepEqual(r.kernSteht, []);
  assert.equal(r.queueDeferred, 2);
  assert.equal(r.queueAktiv, 1);
  assert.equal(r.queueHold, 0, "eine leere Warteschlange ist gemessen, nicht unbekannt");
  assert.equal(r.vmailPct, 42);
  assert.equal(r.disk, 42, "unter dem Namen, unter dem der Leitstand Belegung überall führt");
  assert.equal(r.cpu, 12.4);
  assert.equal(r.ram, 61.2);
  assert.equal(r.cores, 8);
  assert.equal(r.uptime, "41 T");
});

/* Die Zahl allein sagt nicht, warum etwas liegen bleibt. mailcow hängt
   den Grund an die Empfängeradresse — das ist die Zeile, wegen der man
   überhaupt nachsieht. */
test("Zu jeder liegen gebliebenen Mail steht der Grund", async () => {
  const r = await collectMailcow(host(), cred, sofort);
  const gruende = r.queueGruende.map(g => g.grund);
  assert.ok(gruende.some(g => /Connection timed out/.test(g)));
  assert.ok(gruende.some(g => /mailbox full/.test(g)));
  const deferred = r.warteschlange.find(q => q.queue === "deferred");
  assert.equal(deferred.aelter, 1, "eine der beiden liegt seit über zehn Stunden");
  assert.ok(deferred.domains.some(d => d.domain === "kunde.de"));
  assert.equal(r.status, "warn");
  assert.match(r.note, /zehn Stunden/);
});

test("Steht ein Kern-Container, ist das kritisch — ein abgeschalteter Zusatz nicht", async () => {
  srv.zustand.containerAus = ["postfix-mailcow"];
  speicherVergessen();
  try {
    const r = await collectMailcow(host(), cred, sofort);
    assert.equal(r.status, "crit");
    assert.deepEqual(r.kernSteht, ["postfix-mailcow"]);
  } finally { srv.zustand.containerAus = []; }

  srv.zustand.containerAus = ["clamd-mailcow"];
  speicherVergessen();
  try {
    const r = await collectMailcow(host(), cred, sofort);
    assert.equal(r.status, "warn", "clamd darf abgeschaltet sein, ohne dass Mail stehen bleibt");
    assert.match(r.note, /clamd-mailcow/);
  } finally { srv.zustand.containerAus = []; }
});

test("Eine volle Postfachablage ist kritisch", async () => {
  srv.zustand.vmailProzent = "94%";
  speicherVergessen();
  try {
    const r = await collectMailcow(host(), cred, sofort);
    assert.equal(r.status, "crit");
    assert.match(r.note, /Dovecot nichts mehr an/);
  } finally { srv.zustand.vmailProzent = "42%"; }
});

/* Ein volles Postfach weist Mail ab, während der Dienst tadellos läuft.
   Gemeldet wird das von niemandem — außer hier. */
test("Ein volllaufendes Postfach fällt mit Namen auf", async () => {
  /* Ohne liegen gebliebene Mail — sonst meldet der Sammler zu Recht das
     Dringendere, und das ist die Warteschlange. */
  srv.zustand.queue = [];
  srv.zustand.mailboxVoll = 97;
  speicherVergessen();
  try {
    const r = await collectMailcow(host(), cred, sofort);
    assert.equal(r.status, "warn");
    assert.match(r.note, /voll@example\.de/);
    assert.equal(r.mailboxVollste.prozent, 97);
  } finally { srv.zustand.mailboxVoll = 12; srv.zustand.queue = null; }
});

/* Die Rangfolge selbst ist eine Aussage: wenn beides zutrifft, gehört
   die hängende Mail nach oben. Ein volles Postfach trifft einen
   Menschen, eine stehende Warteschlange alle. */
test("Steht beides an, meldet der Sammler das Dringendere", async () => {
  srv.zustand.mailboxVoll = 97;
  speicherVergessen();
  try {
    const r = await collectMailcow(host(), cred, sofort);
    assert.match(r.note, /Warteschlange/);
    assert.equal(r.mailboxVollste.prozent, 97, "das Postfach steht trotzdem in den Zahlen");
  } finally { srv.zustand.mailboxVoll = 12; }
});

test("Ein Postfach ohne Quote ist nicht zu 0 % voll, sondern unbegrenzt", async () => {
  const r = await collectMailcow(host(), cred, sofort);
  assert.equal(r.mailboxenGesamt, 3);
  assert.equal(r.mailboxenOhneQuote, 1);
  assert.ok(!r.mailboxen.some(m => m.name === "ohne-quote@verein.org"),
    "was keine Quote hat, gehört nicht in die Liste der vollsten");
});

test("Die Filterzahlen kommen mit dem Zeitraum, für den sie gelten", async () => {
  const r = await collectMailcow(host(), cred, sofort);
  assert.equal(r.geprueft, 48_120);
  assert.equal(r.spam, 21_400);
  assert.equal(r.spamAnteil, 44);
  assert.equal(r.rspamdSeit, 604_800, "rspamd zählt seit seinem Start — ohne diese Zahl wäre der Rest eine Behauptung");
  assert.equal(r.aktionen[0].name, "no action");
});

test("Domänen, Quarantäne und Sperren werden gezählt, nicht gelesen", async () => {
  const r = await collectMailcow(host(), cred, sofort);
  assert.equal(r.domainsGesamt, 2);
  assert.equal(r.postfaecher, 15);
  assert.equal(r.nachrichten, 193_400);
  assert.equal(r.quarantaene, 3);
  assert.equal(r.quarantaeneViren, 1);
  assert.equal(r.gesperrt, 2);
  /* Betreff, Absender und Empfänger fremder Post haben in einer
     Überwachung nichts verloren — was hier nicht ankommt, kann auch
     nicht in einer Zeitreihe landen. */
  assert.ok(!JSON.stringify(r).includes("Ihre Rechnung"));
  assert.ok(!JSON.stringify(r).includes("spam@example.invalid"));
});

test("Der eigene Takt hält die Zahl der Abrufe klein", async () => {
  const vorher = srv.zustand.abrufe.length;
  await collectMailcow(host(), cred, {});
  const erste = srv.zustand.abrufe.length - vorher;
  await collectMailcow(host(), cred, {});
  await collectMailcow(host(), cred, {});
  assert.equal(srv.zustand.abrufe.length - vorher, erste,
    "mailq und df laufen in Containern — nicht alle 15 Sekunden");
});

test("Verbindungstest nennt Fassung und Container", async () => {
  const r = await testConnection(host(), cred);
  assert.equal(r.ok, true);
  assert.match(r.detail, /2026-03a/);
  assert.match(r.detail, /14 Container/);
});

test("Die Diagnose zeigt jeden Aufruf einzeln", async () => {
  const { diagnoseHost } = await import("../src/diagnose.js");
  const bericht = await diagnoseHost({ ...host(), checks: [] }, cred);
  assert.equal(bericht.ok, true);
  assert.equal(bericht.api[0].pfad, "/get/status/version");
  assert.match(bericht.zugang.form, /X-API-Key/);
  assert.ok(!bericht.zugang.form.includes(KEY), "der Schlüssel selbst bleibt im Dienst");
  assert.match(bericht.api.find(a => a.pfad === "/get/mailq/all").befund, /Warteschlange/);
});

test("Ohne Schlüssel sagt die Diagnose, wo einer herkommt", async () => {
  const { diagnoseHost } = await import("../src/diagnose.js");
  const bericht = await diagnoseHost({ ...host(), checks: [] }, null);
  assert.equal(bericht.ok, false);
  assert.match(bericht.fazit, /Read-Only/);
  assert.match(bericht.fazit, /allow from/);
});
