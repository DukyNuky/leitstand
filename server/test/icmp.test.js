/* Warum `ping` nicht konnte.

   Der Anlass kam aus dem Betrieb: eine Strecke stand rot da, und dieselbe
   Adresse ließ sich aus demselben Behälter von Hand anpingen — von Hand
   nämlich als root, während der Dienst unprivilegiert läuft. Gemeldet
   wurde „keine Antwort", gesendet war aber kein einziges Paket.

   Ein Rechteproblem ist keine Auskunft über das Ziel. Es gehört
   übersprungen wie ein fehlendes `ping` und benannt wie ein Fehler in der
   eigenen Einrichtung. */

import test from "node:test";
import assert from "node:assert/strict";
import { icmpGrund, icmpCheck } from "../src/probe.js";

test("Ein Rechteproblem wird nicht für Schweigen gehalten", () => {
  assert.equal(icmpGrund("ping: socket: Operation not permitted"), "recht");
  assert.equal(icmpGrund("ping: Permission denied"), "recht");
  assert.equal(icmpGrund("ping: socket: Address family not supported by protocol"), "recht");
});

test("Ein unauflösbarer Name bleibt ein unauflösbarer Name", () => {
  assert.equal(icmpGrund("ping: bad.example: Name or service not known"), "name");
  assert.equal(icmpGrund("ping: unknown host wg-gegenstelle"), "name");
});

test("Schweigen ist keins von beidem", () => {
  assert.equal(icmpGrund(""), null);
  assert.equal(icmpGrund("1 packets transmitted, 0 received, 100% packet loss"), null);
  assert.equal(icmpGrund(null), null);
});

/* Die eigene Adresse antwortet immer — außer der Prozess darf gar nicht
   fragen. Beides ist ein gültiges Ergebnis; erfunden wird keins. */
test("Gegen sich selbst kommt entweder eine Messung oder ein Übersprungen", async () => {
  const r = await icmpCheck({ host: "127.0.0.1", timeout: 2000 });
  if (r.skipped) {
    assert.equal(r.ok, null, "übersprungen heißt unbekannt, nicht fehlgeschlagen");
    assert.match(r.detail, /nicht erlaubt|nicht verfügbar/);
  } else {
    assert.equal(r.ok, true);
    assert.ok(r.ms >= 0);
  }
});

/* Eine Adresse, die es nicht gibt, ist eine Aussage über den Eintrag —
   und muss sich von einer schweigenden unterscheiden. */
test("Ein Netz statt einer Adresse scheitert erkennbar", async () => {
  const r = await icmpCheck({ host: "10.99.0.0/30", timeout: 2000 });
  if (r.skipped) return;                       /* ohne ICMP-Recht nicht prüfbar */
  assert.equal(r.ok, false);
  assert.match(r.detail, /Name nicht auflösbar/);
});
