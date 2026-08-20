/* Die Oberfläche gegen echte Serverantworten zeichnen.

   Kein Browser, kein Framework — die Ansichten sind reine Funktionen von
   Zustand nach HTML-Zeichenkette. Genau das lässt sich hier ausnutzen:
   app.js wird in einer VM mit einem winzigen DOM-Ersatz ausgeführt, mit
   einem echten `/api/state` gefüttert und jede Ansicht einmal gezeichnet.

   Damit fallen die Fehler auf, die vorher nur im Betrieb sichtbar wurden:
   ein Verweis auf etwas Entferntes, eine Division durch null bei leerem
   Bestand, ein NaN in einer Summe über lauter unbekannte Werte. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "assets");

/* ---------- DOM, so klein wie es eben geht ---------- */
function fakeDom() {
  const knoten = () => {
    const n = {
      innerHTML: "", textContent: "", value: "", scrollTop: 0,
      dataset: {}, style: {}, classList: { add() {}, remove() {} },
      appendChild() {}, remove() {}, focus() {}, setSelectionRange() {},
      setAttribute() {}, getAttribute: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener() {}, closest: () => null
    };
    return n;
  };
  const ziele = new Map();
  const document = {
    documentElement: knoten(),
    activeElement: null,
    querySelector: sel => ziele.get(sel) || (ziele.set(sel, knoten()), ziele.get(sel)),
    querySelectorAll: () => [],
    createElement: () => knoten(),
    addEventListener() {}
  };
  return { document, ziele };
}

function ladeUi({ live = true } = {}) {
  const { document, ziele } = fakeDom();
  const ausgabe = [];
  const LEITSTAND = {
    live, pending: false, stale: false, lastRun: null, interval: 15, error: null,
    onState() {}, onFail() {}, onStale() {},
    call: async () => ({}), retry() {}
  };
  const sandbox = {
    document, console,
    window: { LEITSTAND, matchMedia: () => ({ matches: true }), open() {}, addEventListener() {}, confirm: () => true },
    location: { hash: "" },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    Intl, Math, Date, JSON, fetch: async () => ({ ok: false })
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const datei of ["examples.js", "app.js"])
    vm.runInContext(fs.readFileSync(path.join(UI, datei), "utf8"), sandbox, { filename: datei });
  return { sandbox, ziele, ausgabe, LEITSTAND };
}

/* Jede Ansicht einmal zeichnen und einsammeln, was dabei herauskommt. */
function zeichneAlles(sandbox, ziele) {
  const ui = sandbox.window.LeitstandUI;
  const seiten = {};
  for (const v of ["lage", "sites", "compute", "netz", "vpn", "dienste", "post", "links", "cfg", "verwaltung"]) {
    ui.state.view = v;
    ui.render();
    seiten[v] = ziele.get("#wrap").innerHTML + ziele.get("#top").innerHTML + ziele.get("#rail-nav").innerHTML;
  }
  return seiten;
}

/* ---------- Ein echter Zustand aus einem echten Bestand ---------- */
const BESTAND = `
settings: { interval: 15, icmp: false, timeout: 1 }
sites:
  - { id: hq, name: Hauptstandort, short: HQ, primary: true }
  - { id: rz, name: Zweitstandort, short: RZ }
hosts:
  - { id: web, type: pve, site: hq, url: "http://127.0.0.1:1/" }
  - { id: fw,  type: opnsense, site: rz, ip: 10.255.255.1 }
  - { id: lab, type: other, site: hq, ip: 10.255.255.2, monitor: false }
tunnels:
  - { id: wg-hq-rz, a: hq, b: rz, iface: wg0, net: 10.99.0.0/30, probe: { ip: 10.255.255.3, port: 22 } }
links:
  - group: Werkzeuge
    items: [ { name: Firewall, host: fw }, { name: Extern, url: "https://example.org" } ]
`;

async function echterZustand(text = BESTAND) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-ui-"));
  const datei = path.join(dir, "inventory.yaml");
  fs.writeFileSync(datei, text);
  const server = createServer({ inventory: datei, secrets: path.join(dir, "s.json"), state: path.join(dir, "i.json") });
  await server.engine.runOnce();
  const { buildState } = await import("../src/api.js");
  return buildState(server.engine, server.secrets);
}

/* ============================================================ */

test("Jede Ansicht zeichnet aus einer echten Serverantwort", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  const seiten = zeichneAlles(sandbox, ziele);

  for (const [name, html] of Object.entries(seiten)) {
    assert.ok(html.length > 200, `Ansicht ${name} ist leer geblieben`);
    assert.ok(!/undefined|NaN|\[object Object\]/.test(html), `Ansicht ${name} zeigt einen Platzhalterwert an`);
  }
  assert.match(seiten.compute, /Hauptstandort|HQ/);
  assert.match(seiten.links, /example\.org/);
});

/* Der gefährlichste Fall ist der erste Start: kein Standort, kein System,
   keine Messung. Dann darf nichts gerechnet und nichts behauptet werden. */
test("Leerer Bestand ergibt keine erfundenen Zahlen", async () => {
  const leer = await echterZustand(`
settings: { icmp: false, timeout: 1 }
sites: [ { id: hq, name: Zuhause, primary: true } ]
hosts: []
tunnels: []
links: []
`);
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(leer);
  const seiten = zeichneAlles(sandbox, ziele);

  for (const [name, html] of Object.entries(seiten)) {
    assert.ok(!/NaN|undefined|Infinity/.test(html), `Ansicht ${name} rechnet mit Nichts`);
  }
  assert.match(seiten.lage, /Noch kein System angelegt|Willkommen/);
});

test("Ohne Dienst zeigt die Oberfläche nichts an statt irgendetwas", () => {
  const { sandbox, ziele } = ladeUi({ live: false });
  sandbox.window.LeitstandUI.state.offline = "Kein Server erreichbar";
  const seiten = zeichneAlles(sandbox, ziele);

  assert.match(seiten.lage, /Kein Leitstand erreichbar/);
  assert.match(seiten.compute, /Kein Leitstand erreichbar/);
  /* Die Verwaltung bleibt erreichbar — dort steht, wie man den Dienst startet. */
  assert.match(seiten.verwaltung, /npm start/);
});

/* Beispiele sind erlaubt, aber nur dort, wo es noch keine Messung gibt —
   und nur sichtbar gekennzeichnet. */
test("Beispiele stehen nur in den Bereichen ohne Anbindung, und zwar markiert", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  const seiten = zeichneAlles(sandbox, ziele);

  for (const ansicht of ["post", "vpn", "compute", "netz"])
    assert.match(seiten[ansicht], />Beispiel</, `${ansicht} kennzeichnet sein Beispiel nicht`);

  /* Die Ansichten, die aus Messwerten leben, dürfen kein Beispiel enthalten. */
  for (const ansicht of ["lage", "sites", "links", "cfg", "verwaltung"])
    assert.ok(!/>Beispiel</.test(seiten[ansicht]), `${ansicht} zeigt ein Beispiel, obwohl es messen kann`);
});

/* Inspector, Verwaltung und Formulare sind der Teil, den man beim Umbauen
   am ehesten übersieht: sie werden erst durch einen Klick sichtbar. */
test("Inspector, Verwaltung und Formulare zeichnen für jeden Fall", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.rawSites = [{ id: "hq", name: "Hauptstandort", primary: true }, { id: "rz", name: "Zweitstandort" }];
  ui.state.rawLinks = [{ group: "Werkzeuge", items: [{ name: "Firewall", host: "fw" }, { name: "Extern", url: "https://example.org" }] }];

  const sauber = (html, was) => {
    assert.ok(html.length > 100, `${was} ist leer`);
    assert.ok(!/undefined|NaN|\[object Object\]/.test(html), `${was} zeigt einen Platzhalterwert`);
  };

  for (const [kind, id] of [["host", "web"], ["host", "lab"], ["tunnel", "wg-hq-rz"],
                            ["site", "hq"], ["incident", zustand.incidents[0]?.id]]) {
    if (!id) continue;
    ui.state.inspector = { kind, id };
    ui.render();
    sauber(ziele.get("#overlays").innerHTML, `Inspector ${kind}/${id}`);
  }
  ui.state.inspector = null;

  ui.state.view = "verwaltung";
  for (const tab of ["hosts", "sites", "tunnels", "links", "settings"]) {
    ui.state.adminTab = tab;
    ui.render();
    sauber(ziele.get("#wrap").innerHTML, `Verwaltung/${tab}`);
  }

  for (const [kind, mode, id] of [["hosts", "new", null], ["hosts", "edit", "web"],
                                  ["sites", "new", null], ["sites", "edit", "hq"],
                                  ["tunnels", "new", null], ["tunnels", "edit", "wg-hq-rz"]]) {
    vm.runInContext(`openForm(${JSON.stringify(kind)}, ${JSON.stringify(mode)}, ${JSON.stringify(id)})`, sandbox);
    sauber(ziele.get("#overlays").innerHTML, `Formular ${kind}/${mode}`);
  }
  vm.runInContext("state.form = null", sandbox);

  /* Ein Standortfilter darf keine Ansicht kippen, auch wenn dort nichts liegt. */
  ui.state.site = "rz";
  ui.state.onlyProblems = true;
  for (const v of ["lage", "sites", "compute", "netz", "vpn", "dienste", "links"]) {
    ui.state.view = v;
    ui.render();
    sauber(ziele.get("#wrap").innerHTML, `gefiltert/${v}`);
  }
});

/* Bei automatischem Redeploy läuft im Browser weiter das alte JavaScript,
   während der Dienst schon der neue ist. Genau das muss auffallen. */
test("Ein neu ausgerollter Stand wird erkannt und gemeldet", async () => {
  const zustand = await echterZustand();
  zustand.meta.runtime.build = { version: "0.1.0", commit: "aaaaaaa1111", shortCommit: "aaaaaaa",
    branch: "main", built: "2026-08-20T05:00:00Z", committed: "2026-08-20T04:55:00Z", source: "abbild" };

  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  assert.equal(ui.state.fassung.shortCommit, "aaaaaaa", "der erste Stand wird gemerkt");
  assert.equal(ui.state.neueFassung, null, "und gilt nicht als Wechsel");

  /* Derselbe Stand noch einmal — das ist kein Redeploy. */
  ui.applyLive(JSON.parse(JSON.stringify(zustand)));
  assert.equal(ui.state.neueFassung, null, "gleicher Stand meldet nichts");

  const neuer = JSON.parse(JSON.stringify(zustand));
  neuer.meta.runtime.build = { ...neuer.meta.runtime.build, commit: "bbbbbbb2222", shortCommit: "bbbbbbb",
    built: "2026-08-20T06:30:00Z" };
  ui.applyLive(neuer);
  assert.equal(ui.state.neueFassung.shortCommit, "bbbbbbb", "der Wechsel wird bemerkt");
  assert.equal(ui.state.fassung.shortCommit, "aaaaaaa", "die Seite bleibt der alte Stand");

  ui.state.view = "lage";
  ui.render();
  const oben = ziele.get("#top").innerHTML;
  assert.match(oben, /Neue Fassung ausgerollt/);
  assert.match(oben, /data-action="reload"/, "mit Schaltfläche zum Neuladen");

  ui.state.view = "cfg";
  ui.render();
  assert.match(ziele.get("#wrap").innerHTML, /Fassung/);
  assert.match(ziele.get("#wrap").innerHTML, /aaaaaaa/, "die eigene Fassung steht in den Einstellungen");
});

/* Der Fall, der ohne Bauparameter sonst durchrutschen würde: das Abbild nennt
   keine Fassung, aber der Prozess ist nach einem Redeploy ein anderer. */
test("Auch ein bloßer Neustart des Dienstes fällt auf", async () => {
  const zustand = await echterZustand();
  zustand.meta.runtime.build = { version: null, commit: null, shortCommit: null, branch: null,
    committed: null, built: null, source: "unbekannt" };
  zustand.meta.runtime.started = "2026-08-20T05:00:00Z";

  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  assert.equal(ui.state.neuGestartet, null, "der erste Start ist kein Neustart");

  ui.applyLive(JSON.parse(JSON.stringify(zustand)));
  assert.equal(ui.state.neuGestartet, null, "derselbe Prozess meldet nichts");

  const nachRedeploy = JSON.parse(JSON.stringify(zustand));
  nachRedeploy.meta.runtime.started = "2026-08-20T06:00:00Z";
  ui.applyLive(nachRedeploy);
  assert.ok(ui.state.neuGestartet, "der neue Prozess fällt auf");

  ui.state.view = "lage";
  ui.render();
  const oben = ziele.get("#top").innerHTML;
  assert.match(oben, /neu gestartet/);
  assert.match(oben, /data-action="reload"/);
});

test("Ohne Bauparameter wird keine Fassung erfunden", async () => {
  const zustand = await echterZustand();
  zustand.meta.runtime.build = { version: null, commit: null, shortCommit: null, branch: null,
    committed: null, built: null, source: "unbekannt" };
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "cfg";
  ui.render();
  assert.match(ziele.get("#wrap").innerHTML, /unbekannt/);
  assert.equal(ui.state.neueFassung, null);
});

test("Schwellwerte in der Anzeige kommen aus dem Dienst", async () => {
  const zustand = await echterZustand(`
settings: { interval: 42, tls_warn_days: 21, icmp: false, timeout: 1 }
sites: [ { id: hq, name: Zuhause, primary: true } ]
hosts: [ { id: a, type: other, site: hq, ip: 10.255.255.9 } ]
tunnels: []
links: []
`);
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  const seiten = zeichneAlles(sandbox, ziele);
  assert.match(seiten.cfg, /alle <span class="mono">42 s/, "das echte Intervall steht da");
  assert.match(seiten.dienste, /Warnung ab 21 Tagen/, "die echte Zertifikatsschwelle steht da");
});
