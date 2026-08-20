/* Die Brücke zum Server (ui/assets/live.js).

   Sie entscheidet, ob die Oberfläche Daten hat oder leer bleibt — und
   genau da lag ein Fehler, den man nur im Betrieb sah: schlug der
   Erstabruf fehl, blieb die Seite leer, bis jemand von Hand neu lud. Es
   gab weder einen zweiten Versuch noch einen Ereignisstrom, der hätte
   nachliefern können.

   Geprüft wird hier ohne Browser: live.js läuft in einer VM mit
   nachgestelltem fetch, nachgestelltem EventSource und einer Uhr, die der
   Test selbst stellt. So kostet der Test keine Wartezeit. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "assets", "live.js");

const ZUSTAND = { meta: { lastRun: "2026-08-20T14:00:00Z", interval: 15, counts: { hosts: 3 } }, hosts: [{ id: "fw" }] };

/* `antworten` wird der Reihe nach abgearbeitet: je Aufruf von fetch eine
   Zusage. Was übrig bleibt, wird wiederholt verwendet. */
function ladeLive(antworten) {
  const abrufe = [];
  const uhren = [];                      /* gestellte Wecker, vom Test ausgelöst */
  const stroeme = [];
  const zustaende = [], fehler = [];

  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; stroeme.push(this); }
    close() { this.closed = true; }
  }

  const sandbox = {
    console,
    fetch: (url, opts) => {
      abrufe.push({ url, opts });
      const naechste = antworten[Math.min(abrufe.length - 1, antworten.length - 1)];
      return naechste();
    },
    setTimeout: (fn, ms) => { uhren.push({ fn, ms }); return uhren.length; },
    clearTimeout: id => { if (uhren[id - 1]) uhren[id - 1].fn = null; },
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController,
    EventSource: FakeEventSource,
    JSON, Promise, Error, Date,
    document: { hidden: false, horcher: {}, addEventListener(n, fn) { this.horcher[n] = fn; } }
  };
  sandbox.window = { EventSource: FakeEventSource, horcher: {}, addEventListener(n, fn) { this.horcher[n] = fn; } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(LIVE, "utf8"), sandbox, { filename: "live.js" });

  const L = sandbox.window.LEITSTAND;
  L.onState(st => zustaende.push(st));
  L.onFail(e => fehler.push(e));

  /* Alle fälligen Wecker auslösen — wie eine vorgespulte Uhr. */
  const tick = () => {
    const faellig = uhren.splice(0, uhren.length).filter(u => u.fn);
    for (const u of faellig) u.fn();
  };

  return { sandbox, L, abrufe, uhren, stroeme, zustaende, fehler, tick };
}

const gelingt = () => Promise.resolve({ ok: true, json: async () => ZUSTAND });
const faellt = () => Promise.reject(new Error("Failed to fetch"));
const warte = () => new Promise(r => setImmediate(r));

/* ============================================================ */

test("Ein fehlgeschlagener Erstabruf wird wiederholt statt aufgegeben", async () => {
  const t = ladeLive([faellt, gelingt]);
  await warte();

  assert.equal(t.abrufe.length, 1);
  assert.equal(t.L.live, false);
  assert.equal(t.fehler.length, 1, "der Fehlschlag wird gemeldet");

  const wiederholung = t.uhren.find(u => u.ms >= 1000 && u.ms <= 32000);
  assert.ok(wiederholung, "es ist kein zweiter Versuch geplant — genau das war der Fehler");

  t.tick();
  await warte();
  assert.equal(t.abrufe.length, 2, "der zweite Versuch läuft");
  assert.equal(t.L.live, true);
  assert.deepEqual(t.zustaende.at(-1), ZUSTAND);
});

/* Der Strom trägt als erste Nachricht den vollständigen Zustand. Er kann
   die Seite also allein füllen — auch dann, wenn der Erstabruf scheiterte. */
test("Auch nach einem Fehlschlag wird der Ereignisstrom geöffnet", async () => {
  const t = ladeLive([faellt]);
  await warte();

  assert.equal(t.stroeme.length, 1, "ohne Strom bliebe die Seite leer");
  assert.match(t.stroeme[0].url, /api\/stream/);

  t.stroeme[0].onmessage({ data: JSON.stringify(ZUSTAND) });
  assert.equal(t.L.live, true);
  assert.equal(t.L.pending, false);
  assert.deepEqual(t.zustaende.at(-1), ZUSTAND);
});

test("Kam der Zustand über den Strom, entfällt die geplante Wiederholung", async () => {
  const t = ladeLive([faellt]);
  await warte();
  t.stroeme[0].onmessage({ data: JSON.stringify(ZUSTAND) });

  const vorher = t.abrufe.length;
  t.tick();
  await warte();
  assert.equal(t.abrufe.length, vorher, "es wird nachgefragt, obwohl die Daten längst da sind");
});

test("Es gibt nie zwei Ströme nebeneinander", async () => {
  const t = ladeLive([faellt, faellt, gelingt]);
  await warte();
  t.tick();                                  /* zweiter Versuch — scheitert wieder */
  await warte();
  t.tick();                                  /* dritter Versuch — gelingt */
  await warte();

  assert.equal(t.L.live, true);
  assert.equal(t.stroeme.filter(s => !s.closed).length, 1,
    "jeder offene Strom belegt dauerhaft eine der sechs Verbindungen des Browsers");
});

/* Ein Browser hält je Gegenstelle nur sechs Verbindungen offen, und jeder
   offene Reiter belegt eine davon mit dem Ereignisstrom. Ein Erstabruf
   wartet dann in der Schlange, statt langsam zu sein — mit einem knappen
   Zeitlimit bricht er ab, und die Seite bleibt leer. */
test("Der Erstabruf bekommt genug Zeit, um in der Schlange zu warten", async () => {
  const t = ladeLive([gelingt]);
  const abbruch = t.uhren.find(u => u.ms >= 5000);
  assert.ok(abbruch, "das Zeitlimit des Erstabrufs ist zu knapp für einen Seitenaufbau");
  await warte();
});

test("Der Erstabruf verbietet dem Browser ausdrücklich den Zwischenspeicher", async () => {
  const t = ladeLive([gelingt]);
  await warte();
  assert.equal(t.abrufe[0].opts.cache, "no-store",
    "ein aufgehobener Zustand sieht aus wie eine Messung von jetzt");
});

test("Zurück auf dem Reiter wird sofort erneut verbunden", async () => {
  const t = ladeLive([faellt, gelingt]);
  await warte();
  assert.equal(t.L.live, false);

  t.sandbox.document.horcher.visibilitychange();
  await warte();
  assert.equal(t.L.live, true, "wer zurückwechselt, soll nicht auf den nächsten Wecker warten");
});
