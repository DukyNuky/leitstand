/* Herkunft der laufenden Fassung.

   Die Angabe muss entweder stimmen oder fehlen. Ein nicht ersetzter
   Bauparameter — der Klassiker, wenn `build-args` im Arbeitsablauf fehlen —
   darf nicht als Commit durchgehen: eine falsche Fassungsangabe ist beim
   Ausrollen schlimmer als gar keine, weil man ihr glaubt. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";

/* version.js merkt sich das Ergebnis. Für jeden Fall wird deshalb ein
   frisches Modul geladen — die Zeitmarke im Anfragepfad erzwingt das. */
async function frisch(env = {}) {
  const vorher = {};
  for (const [k, v] of Object.entries(env)) { vorher[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try {
    const m = await import(`../src/version.js?t=${Date.now()}${Math.random()}`);
    return m.buildInfo();
  } finally {
    for (const [k, v] of Object.entries(vorher)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const LEER = { LEITSTAND_COMMIT: null, LEITSTAND_BRANCH: null, LEITSTAND_COMMITTED: null,
  LEITSTAND_BUILT: null, LEITSTAND_VERSION: null };

test("Die Umgebung des Abbilds hat Vorrang", async () => {
  const b = await frisch({
    LEITSTAND_COMMIT: "0123456789abcdef0123456789abcdef01234567",
    LEITSTAND_BRANCH: "main",
    LEITSTAND_COMMITTED: "2026-08-20T04:22:40Z",
    LEITSTAND_BUILT: "2026-08-20T04:25:00Z",
    LEITSTAND_VERSION: "0.2.0"
  });
  assert.equal(b.source, "abbild");
  assert.equal(b.shortCommit, "0123456");
  assert.equal(b.branch, "main");
  assert.equal(b.version, "0.2.0");
  assert.equal(b.built, "2026-08-20T04:25:00.000Z");
});

test("Unix-Sekunden werden als Zeitpunkt verstanden", async () => {
  const b = await frisch({ ...LEER, LEITSTAND_COMMIT: "abc1234", LEITSTAND_BUILT: "1755663760" });
  assert.equal(new Date(b.built).getUTCFullYear(), 2025);
});

/* Wer `build-args` vergisst, bekommt in der Umgebung buchstäblich
   „${LEITSTAND_COMMIT}" — das ist keine Fassung. */
test("Ein nicht ersetzter Bauparameter gilt nicht als Fassung", async () => {
  const b = await frisch({ ...LEER, LEITSTAND_COMMIT: "${LEITSTAND_COMMIT}", LEITSTAND_BUILT: "  " });
  assert.notEqual(b.source, "abbild", "das darf nicht als Abbild-Angabe durchgehen");
});

test("Ohne Abbild-Angaben kommt die Fassung aus dem Arbeitsbaum", async () => {
  const b = await frisch(LEER);
  /* Im Repository gibt es ein .git; in einem ausgepackten Abbild nicht,
     dann bleibt der Dateistand. Erfunden wird in keinem Fall etwas. */
  assert.ok(["arbeitsbaum", "dateistand", "unbekannt"].includes(b.source), `unerwartete Herkunft: ${b.source}`);
  if (b.source === "arbeitsbaum") {
    assert.match(b.commit, /^[0-9a-f]{40}$/);
    assert.equal(b.shortCommit, b.commit.slice(0, 7));
    assert.ok(b.branch, "und der Zweig steht dabei");
  }
  if (b.source === "dateistand") {
    assert.equal(b.commit, null, "ohne Commit wird auch keiner behauptet");
    assert.ok(b.built, "aber der Zeitpunkt steht fest");
  }
});

/* Jede Herkunft muss eine Angabe liefern, mit der die Oberfläche etwas
   anfangen kann — sonst bliebe die Zeile unten links leer. */
test("Jede Herkunft nennt entweder Commit oder Zeitpunkt", async () => {
  const b = await frisch(LEER);
  if (b.source === "unbekannt") return;
  assert.ok(b.commit || b.built || b.committed, "irgendetwas Datierbares muss dabei sein");
});

test("Die Fassung ist auch ohne Zustand abrufbar", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-ver-"));
  fs.writeFileSync(path.join(dir, "inventory.yaml"),
    "settings: { icmp: false }\nsites: [ { id: hq, name: Zuhause } ]\nhosts: []\ntunnels: []\nlinks: []\n");
  const server = createServer({ inventory: path.join(dir, "inventory.yaml"),
    secrets: path.join(dir, "s.json"), state: path.join(dir, "i.json") });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`);
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.ok("commit" in b && "source" in b, "Commit und Herkunft stehen dabei");
    assert.ok(b.started, "und seit wann der Prozess läuft");
    assert.equal(typeof b.uptimeSeconds, "number");

    /* Derselbe Stand muss auch im Zustand stehen — die Oberfläche liest ihn dort. */
    const st = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(st.meta.runtime.build.commit, b.commit);
  } finally { server.close(); }
});
