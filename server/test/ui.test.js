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
  for (const v of ["lage", "sites", "virt", "compute", "netz", "vpn", "dienste", "post", "links", "cfg", "verwaltung"]) {
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
  # Nur eine Prüfung statt der abgeleiteten drei: jede läuft gegen eine
  # absichtlich unerreichbare Adresse in ihr Zeitlimit, und das zahlt die
  # ganze Datei. Unerreichbar ist sie mit einer Prüfung genauso.
  - { id: fw,  type: opnsense, site: rz, ip: 10.255.255.1, checks: [{ kind: tcp, port: 443 }] }
  - { id: lab, type: other, site: hq, ip: 10.255.255.2, monitor: false }
tunnels:
  - { id: wg-hq-rz, a: hq, b: rz, iface: wg0, net: 10.99.0.0/30, probe: { ip: 10.255.255.3, port: 22 } }
links:
  - group: Werkzeuge
    items: [ { name: Firewall, host: fw }, { name: Extern, url: "https://example.org" } ]
`;

/* Ein Durchlauf gegen absichtlich unerreichbare Adressen kostet gut zwei
   Sekunden — die Prüfungen laufen bis in ihr Zeitlimit. Für einen Test ist
   das gut angelegt, für zwanzig kippt die Datei ins Zeitlimit des
   Testläufers, und zwar erst auf einem langsamen Bauknecht: hier lief sie
   noch, dort nicht mehr.

   Der Zustand wird deshalb je Bestand einmal erzeugt und für jeden Test
   kopiert. Er bleibt echt — er kommt weiter aus einem laufenden Dienst mit
   einem echten Durchlauf. Gemessen wird hier ohnehin die Oberfläche und
   nicht der Prober, und die ist eine reine Funktion ihres Zustands.

   Kopiert wird, weil die Tests ihren Zustand verändern (Peers ergänzen,
   Ampeln umsetzen). Ohne Kopie schleppte ein Test seine Änderungen in den
   nächsten — der übelste Fehler in einer Testreihe, weil er von der
   Reihenfolge abhängt. */
const LEER = `
settings: { icmp: false, timeout: 1 }
sites: [ { id: hq, name: Zuhause, primary: true } ]
hosts: []
tunnels: []
links: []
`;

const zustaende = new Map();

async function echterZustand(text = BESTAND) {
  if (!zustaende.has(text)) zustaende.set(text, await baueZustand(text));
  return structuredClone(zustaende.get(text));
}

async function baueZustand(text) {
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
  const leer = await echterZustand(LEER);
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(leer);
  const seiten = zeichneAlles(sandbox, ziele);

  for (const [name, html] of Object.entries(seiten)) {
    assert.ok(!/NaN|undefined|Infinity/.test(html), `Ansicht ${name} rechnet mit Nichts`);
  }
  assert.match(seiten.lage, /Noch kein System angelegt|Willkommen/);
});

/* Der gefährlichste leere Bildschirm ist der, der harmlos aussieht: „noch
   nichts angelegt" liest sich wie ein Anfang, kann aber heißen, dass der
   Dienst eine andere Ablage liest als gestern. Dann muss die Datei dabeistehen. */
test("Ein selbst angelegter Bestand sagt, aus welcher Datei er kommt", async () => {
  const zustand = await echterZustand(LEER);
  zustand.meta.runtime.bestand = { datei: "/data/inventory.yaml", angelegt: true, vorlage: false, sicherung: true };
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  const seiten = zeichneAlles(sandbox, ziele);

  for (const ansicht of ["lage", "compute"]) {
    assert.match(seiten[ansicht], /selbst angelegt/, `${ansicht} verschweigt, woher der leere Bestand kommt`);
    assert.match(seiten[ansicht], /\/data\/inventory\.yaml/, `${ansicht} nennt die Datei nicht`);
    assert.match(seiten[ansicht], /inventory\.yaml\.bak/, `${ansicht} verschweigt die Sicherung`);
  }

  /* Lag die Datei schon da, ist der leere Bestand keine Überraschung —
     dann steht sie nur da, ohne Warnung. */
  const zweiter = await echterZustand(LEER);
  zweiter.meta.runtime.bestand = { datei: "/data/inventory.yaml", angelegt: false, vorlage: false, sicherung: false };
  const b = ladeUi();
  b.sandbox.window.LeitstandUI.applyLive(zweiter);
  const ohne = zeichneAlles(b.sandbox, b.ziele);
  assert.ok(!/selbst angelegt/.test(ohne.lage), "ohne Not gewarnt");
  assert.match(ohne.lage, /Gelesen wird/);
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

  /* „host" fehlt hier mit Absicht: ein System hat seit dem Verlauf über
     Tage eine eigene Seite statt einer Schublade — geprüft wird sie unten
     im eigenen Test. */
  for (const [kind, id] of [["tunnel", "wg-hq-rz"],
                            ["site", "hq"], ["incident", zustand.incidents[0]?.id]]) {
    if (!id) continue;
    ui.state.inspector = { kind, id };
    ui.render();
    sauber(ziele.get("#overlays").innerHTML, `Inspector ${kind}/${id}`);
  }
  ui.state.inspector = null;

  /* Frühere Stände kommen aus einem eigenen Abruf; hier wird eingesetzt,
     was der Dienst liefert — samt eines unlesbaren Standes, denn genau der
     darf nicht als Zahl daherkommen. */
  ui.state.staende = {
    datei: { datei: "/data/inventory.yaml", name: "inventory.yaml", zeit: "2026-08-21T10:00:00Z", lesbar: true, sites: 2, hosts: 3, tunnels: 1 },
    sicherung: { datei: "/data/inventory.yaml.bak", name: "inventory.yaml.bak", zeit: "2026-08-21T09:00:00Z", lesbar: true, sites: 2, hosts: 4, tunnels: 1 },
    archiv: [
      { datei: "/data/archiv/inventory-2026-08-21.yaml", name: "inventory-2026-08-21.yaml", zeit: "2026-08-21T08:00:00Z", lesbar: true, sites: 2, hosts: 4, tunnels: 1 },
      { datei: "/data/archiv/inventory-2026-08-14.yaml", name: "inventory-2026-08-14.yaml", zeit: "2026-08-14T08:00:00Z", lesbar: false, fehler: "YAML lässt sich nicht lesen" }
    ],
    verzeichnis: "/data/archiv", behalten: 14
  };

  ui.state.view = "verwaltung";
  for (const tab of ["hosts", "sites", "tunnels", "links", "settings", "staende"]) {
    ui.state.adminTab = tab;
    ui.render();
    sauber(ziele.get("#wrap").innerHTML, `Verwaltung/${tab}`);
  }
  /* Der zuletzt gezeichnete Reiter ist „staende": ein unlesbarer Stand wird
     benannt statt angeboten, ein lesbarer lässt sich zurückholen. */
  const staende = ziele.get("#wrap").innerHTML;
  assert.match(staende, /data-action="admin-restore" data-quelle="\.bak"/);
  assert.match(staende, /data-quelle="inventory-2026-08-21\.yaml"/);
  assert.match(staende, /nicht lesbar/);
  assert.ok(!/data-quelle="inventory-2026-08-14\.yaml"/.test(staende), "ein unlesbarer Stand darf nicht anklickbar sein");
  ui.state.adminTab = "hosts";

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
  for (const v of ["lage", "sites", "virt", "compute", "netz", "vpn", "dienste", "links"]) {
    ui.state.view = v;
    ui.render();
    sauber(ziele.get("#wrap").innerHTML, `gefiltert/${v}`);
  }
});

/* Die Schalter im Formular („Überwachen", „Hauptstandort") tragen dieselbe
   data-field-Kennung wie die Eingabefelder, sind aber <span> ohne `value`.
   Wurden sie beim Einsammeln mitgelesen, überschrieb `undefined` den
   gesetzten Wert: der Schalter ließ sich nicht umlegen, und beim Speichern
   ging seine Stellung verloren. Hier steht ein DOM, das beide Fälle
   auseinanderhält — genau wie ein Browser es täte. */
test("Ein Schalter im Formular überlebt das Einsammeln der Eingaben", async () => {
  const zustand = await echterZustand();
  const { sandbox } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);

  const eingabe = { dataset: { field: "name" }, value: "Zweigstelle", tagName: "INPUT" };
  const schalter = { dataset: { field: "primary" }, tagName: "SPAN" };      /* kein value */
  sandbox.document.querySelectorAll = sel =>
    sel.startsWith("[data-field]") ? [eingabe, schalter]                    /* wie früher: alles */
      : /input\[data-field\]/.test(sel) ? [eingabe]                         /* jetzt: nur Felder */
      : [];

  vm.runInContext(`openForm("sites","new")`, sandbox);
  vm.runInContext(`state.form.data = { id:"zweig", name:"", primary:true }`, sandbox);
  vm.runInContext(`collectForm()`, sandbox);

  assert.equal(vm.runInContext("state.form.data.primary", sandbox), true,
    "der Schalter darf vom Einsammeln nicht zurückgesetzt werden");
  assert.equal(vm.runInContext("state.form.data.name", sandbox), "Zweigstelle",
    "echte Eingabefelder werden weiterhin gelesen");

  /* Und er lässt sich umlegen, statt beim nächsten Zeichnen zurückzuspringen. */
  vm.runInContext(`state.form.data.primary = !state.form.data.primary; collectForm();`, sandbox);
  assert.equal(vm.runInContext("state.form.data.primary", sandbox), false);
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

/* ============================================================
   Topologie

   Die Karte ist kein Stern: zwischen zwei Nebenstandorten darf eine eigene
   Strecke liegen, und die läuft dann gerade nicht über die Mitte. Der
   Zustand wird hier von Hand um einen dritten Standort ergänzt — geprüft
   wird die Zeichnung, und die ist eine reine Funktion des Zustands.
   ============================================================ */

async function mitDrittemStandort(zusatz = []) {
  const zustand = await echterZustand();
  zustand.sites.push({ id: "ch", name: "Drittstandort", short: "CHZH", place: "Zürich",
    isp: "—", wan: "—", wan6: "—", primary: false, down: false, hosts: 0, problems: 0,
    tunnelsOk: 1, tunnels: 1 });
  zustand.tunnels.push({ id: "wg-rz-ch", a: "rz", b: "ch", iface: "wg1", net: "10.99.1.0/30",
    status: "ok", rtt: 24, quelle: "probe", handshake: null, rx: null, tx: null, peer: null,
    hist: [], lastSeen: null, note: null }, ...zusatz);
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "sites";
  ui.render();
  return { html: ziele.get("#wrap").innerHTML, sandbox, ziele };
}

/* Der Scheitel einer quadratischen Kurve liegt auf halbem Weg zwischen
   Sehnenmitte und Steuerpunkt — das ist die Stelle, an der sie der Nabe am
   nächsten kommt. */
function scheitel(d) {
  const z = d.match(/-?[\d.]+/g).map(Number);
  const [px, py, kx, ky, qx, qy] = z;
  return { x: 0.25 * px + 0.5 * kx + 0.25 * qx, y: 0.25 * py + 0.5 * ky + 0.25 * qy };
}

test("Ein Tunnel zwischen zwei Nebenstandorten steht in der Karte", async () => {
  const { html } = await mitDrittemStandort();

  const direkt = html.match(/<path d="([^"]+)"[^>]*>\s*<title>Zweitstandort ↔ Drittstandort[^<]*<\/title>/);
  assert.ok(direkt, "die Direktstrecke fehlt in der Zeichnung");
  assert.match(direkt[1], /Q/, "sie wird gebogen gezeichnet, sonst liefe sie durch die Nabe");
  assert.match(html, /24 ms/, "ihre Latenz steht an der Linie");

  /* Sie darf die Mitte nicht berühren: dort steht der Hauptstandort, 68
     breit und 40 hoch. Ginge sie hindurch, sähe sie aus wie zwei
     Sternstrecken — also wie das Gegenteil dessen, was sie ist. */
  const s = scheitel(direkt[1]);
  assert.ok(Math.hypot(s.x - 380, s.y - 130) > 40,
    `die Kurve läuft durch die Nabe (Scheitel ${s.x.toFixed(0)}/${s.y.toFixed(0)})`);

  /* Und die Sternstrecken bleiben, wie sie waren. */
  assert.ok(/<title>Hauptstandort ↔ Zweitstandort/.test(html), "der Tunnel zur Mitte fehlt");
});

test("Mehrere Tunnel auf derselben Strecke zeigen den schlechtesten Zustand", async () => {
  const { html } = await mitDrittemStandort([{ id: "wg-rz-ch-2", a: "ch", b: "rz", iface: "wg2",
    net: "10.99.2.0/30", status: "crit", rtt: null, quelle: "probe", handshake: null,
    rx: null, tx: null, peer: null, hist: [], lastSeen: null, note: null }]);

  const direkt = html.match(/<path d="[^"]+" fill="none" stroke="([^"]+)"[^>]*>\s*<title>Zweitstandort ↔ Drittstandort([^<]*)<\/title>/);
  assert.ok(direkt, "die Direktstrecke fehlt");
  assert.equal(direkt[1], "var(--crit)", "eine tote zweite Strecke darf nicht hinter einer lebenden verschwinden");
  assert.match(direkt[2], /2 Strecken/, "dass es zwei sind, steht am Zeiger");
});

/* ============================================================
   Tunnel ↔ WireGuard-Peer

   Der Zustand wird hier von Hand ergänzt, wo der Testserver ihn nicht
   liefern kann: die Peers kämen von einer echten Firewall. Was hier
   geprüft wird, ist ohnehin die Oberfläche — die ist eine reine Funktion
   des Zustands, gleich woher der kommt.
   ============================================================ */

const PEERZUSTAND = [
  { id: "fw/wg0/WG-Schweiz", name: "WG-Schweiz", key: "Aqujl", iface: "wg0", von: "fw", site: "rz",
    device: "erlaubt: 0.0.0.0/0", status: "ok", handshake: 80, seit: "2026-08-20 14:15:56",
    ip: "0.0.0.0/0", endpoint: "178.39.98.174:8909", rx: "1.1 GB", tx: "3.9 GB", tunnel: "wg-hq-rz" },
  { id: "fw/wg1/laptop", name: "laptop", key: "Bbcd", iface: "wg1", von: "fw", site: "rz",
    device: "erlaubt: 10.99.0.2/32", status: "idle", handshake: null, seit: null,
    ip: "10.99.0.2/32", endpoint: "—", rx: null, tx: null, tunnel: null }
];

async function mitPeers(peer = { host: "fw", iface: "wg0", name: "WG-Schweiz", key: "Aqujl" }, gefunden = true) {
  const zustand = await echterZustand();
  zustand.peers = PEERZUSTAND;
  Object.assign(zustand.tunnels[0], {
    handshake: gefunden ? 80 : null,
    rx: gefunden ? "1.1 GB" : null, tx: gefunden ? "3.9 GB" : null,
    peer: peer && { ...peer, gefunden, endpoint: gefunden ? "178.39.98.174:8909" : null,
      allowed: gefunden ? "0.0.0.0/0" : null, seit: gefunden ? "2026-08-20 14:15:56" : null,
      keepalive: gefunden ? "10" : null, note: gefunden ? null : "Den Peer „WG-Schweiz“ meldet fw nicht mehr" }
  });
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  return { sandbox, ziele, zustand };
}

test("Der verknüpfte Peer steht mit echtem Handshake in der Tunnelzeile", async () => {
  const { sandbox, ziele } = await mitPeers();
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "vpn";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.match(html, /1 min 20 s/, "das Handshake-Alter, nicht ein Strich");
  assert.match(html, /1\.1 GB \/ 3\.9 GB/);
  assert.ok(!/noch nicht zugeordnet|Stufe 3/.test(html), "der alte Vorbehalt gehört weg, sobald es zugeordnet ist");
  /* Die Peertabelle zeigt umgekehrt, welcher Peer eine Strecke trägt. */
  assert.match(html, /data-kind="tunnel" data-id="wg-hq-rz"/);
});

test("Ein hinterlegter, aber nicht gemeldeter Peer wird nicht als „nie“ ausgegeben", async () => {
  const { sandbox, ziele } = await mitPeers(
    { host: "fw", iface: "wg0", name: "WG-Schweiz", key: "Aqujl" }, false);
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "vpn";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  assert.match(html, /nicht gemeldet/);

  ui.state.inspector = { kind: "tunnel", id: "wg-hq-rz" };
  ui.render();
  assert.match(ziele.get("#overlays").innerHTML, /nicht mehr/);
});

test("Ohne Verknüpfung sagt die Oberfläche, wo man sie herstellt", async () => {
  const { sandbox, ziele } = await mitPeers(null);
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "vpn";
  ui.render();
  assert.match(ziele.get("#wrap").innerHTML, /Verwaltung → Tunnel/);
});

/* Das Formular ist der Ort, an dem die Verknüpfung entsteht — und der
   Ort, an dem sie am ehesten verlorengeht. */
test("Das Tunnelformular bietet die gemeldeten Peers zur Auswahl an", async () => {
  const { sandbox, ziele } = await mitPeers();
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz")`, sandbox);
  const html = ziele.get("#overlays").innerHTML;

  assert.match(html, /data-field="peerRef"/);
  assert.match(html, /<optgroup label="fw">/);
  assert.match(html, /wg1 · laptop/, "auch die, die noch an keiner Strecke hängen");
  assert.match(html, /value="fw\/wg0\/WG-Schweiz" selected/, "die bestehende Verknüpfung ist vorgewählt");
});

test("Gespeichert wird der Schlüssel, nicht nur der Name", async () => {
  const { sandbox } = await mitPeers();
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz")`, sandbox);
  const p = JSON.parse(vm.runInContext("JSON.stringify(formPayload())", sandbox));
  assert.deepEqual(p.peer, { host: "fw", iface: "wg0", name: "WG-Schweiz", key: "Aqujl" });
  assert.deepEqual(p.probe, { ip: "10.255.255.3", port: 22 }, "und die Messung bleibt daneben stehen");
});

test("Die Verknüpfung zu lösen schickt ausdrücklich null", async () => {
  const { sandbox } = await mitPeers();
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz"); state.form.data.peerRef = "";`, sandbox);
  const p = JSON.parse(vm.runInContext("JSON.stringify(formPayload())", sandbox));
  assert.equal(p.peer, null, "ein fehlendes Feld ließe die alte Verknüpfung stehen");
});

/* Meldet die Firewall gerade nicht, darf allein das Öffnen des Formulars
   die Verknüpfung nicht wegwerfen. */
test("Ein nicht gemeldeter Peer überlebt das Öffnen des Formulars", async () => {
  const { sandbox, ziele } = await mitPeers(
    { host: "fw", iface: "wg0", name: "WG-Anderswo", key: "Zzzz" }, false);
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz")`, sandbox);
  assert.match(ziele.get("#overlays").innerHTML, /zurzeit nicht gemeldet/);

  const p = JSON.parse(vm.runInContext("JSON.stringify(formPayload())", sandbox));
  assert.equal(p.peer.key, "Zzzz");
});

test("Ohne gemeldete Peers steht im Formular, was dafür fehlt", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  vm.runInContext(`openForm("tunnels", "new", null)`, sandbox);
  const html = ziele.get("#overlays").innerHTML;
  assert.ok(!/data-field="peerRef"/.test(html), "eine leere Auswahlliste hilft niemandem");
  assert.match(html, /API-Schlüssel/);
});

/* ============================================================
   Die Detailseite eines Systems

   Sie ist der Grund, aus dem Messwerte überhaupt auf die Platte gehen.
   Geprüft wird das, was an ihr schiefgehen kann, ohne dass es auffällt:
   eine Linie, die über eine Nacht ohne Messung hinwegläuft, und ein
   leeres Diagramm, das wie eine Messung aussieht.
   ============================================================ */

/* Ein Verlauf, wie ihn /api/verlauf liefert. */
function verlaufDaten(punkte, extra = {}) {
  return {
    id: "web", art: "host", name: "web", tage: 1, takt: 60,
    punkte, gemessen: punkte.length, gezeigt: punkte.length,
    reihen: [{ key: "ms", label: "Antwortzeit", einheit: "ms" }],
    von: punkte[0] ? new Date(punkte[0].t * 1000).toISOString() : null,
    bis: punkte.at(-1) ? new Date(punkte.at(-1).t * 1000).toISOString() : null,
    ablage: { verzeichnis: "/data/verlauf", takt: 60, tage: 30, vorhanden: 1, seit: "2026-08-21", bytes: 4096, fehler: null },
    ...extra
  };
}

function reihe(n, ab = 1755000000, schritt = 60) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ t: ab + i * schritt, k: "h", id: "web", ms: 10 + (i % 5), min: 8, max: 20, n: 4, st: "ok" });
  return out;
}

test("Ein System hat eine eigene Seite mit Verlauf statt einer Schublade", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);

  ui.openSystem("web");
  assert.equal(ui.state.view, "system", "der Klick führt auf die Seite, nicht in die Schublade");
  assert.equal(ui.state.detail.id, "web");

  ui.state.detail.busy = false;
  ui.state.detail.daten = verlaufDaten(reihe(120));
  ui.render();
  const html = ziele.get("#wrap").innerHTML + ziele.get("#top").innerHTML;

  assert.ok(!/undefined|NaN|\[object Object\]/.test(html), "die Seite zeigt einen Platzhalterwert");
  assert.match(html, /Antwortzeit/);
  assert.match(html, /<svg class="vd"/, "das Diagramm fehlt");
  assert.match(html, /Prüfungen im letzten Durchlauf/);
  assert.match(html, /Stammdaten/);
});

/* Eine durchgezogene Linie über eine Nacht ohne Messwerte wäre eine
   Behauptung — genau die Sorte, die eine Überwachung nicht machen darf. */
test("Wo nichts gemessen wurde, ist die Linie unterbrochen", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);

  const vorher = reihe(30);
  const nachher = reihe(30, vorher.at(-1).t + 6 * 3600);      /* sechs Stunden Funkstille */
  ui.openSystem("web");
  ui.state.detail.busy = false;
  ui.state.detail.daten = verlaufDaten([...vorher, ...nachher]);
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  const linien = (html.match(/<polyline/g) || []).length;
  assert.equal(linien, 2, "die Lücke wird übermalt statt gezeigt");
});

test("Ohne aufgezeichnete Punkte behauptet die Seite nichts", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);

  ui.openSystem("web");
  ui.state.detail.busy = false;
  ui.state.detail.daten = verlaufDaten([]);
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.ok(!/<svg class="vd"/.test(html), "ein leeres Diagramm sieht aus wie eine Messung");
  assert.match(html, /noch nichts auf der Platte/i);

  /* Und wenn der Abruf scheitert, steht das da — nicht eine leere Fläche. */
  ui.state.detail.daten = null;
  ui.state.detail.error = "HTTP 500";
  ui.render();
  assert.match(ziele.get("#wrap").innerHTML, /nicht abrufbar/);
});

/* Eine Kachel ohne verknüpftes System darf grün sein — aber nur, wenn
   jemand die Adresse tatsächlich abgerufen hat. */
test("Die Kachel der Startseite zeigt die geprüfte Erreichbarkeit", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;

  zustand.links = [{ name: "Werkzeuge", links: [
    { n: "Geprüft", u: "https://example.org/", h: null, p: true, st: "ok", ms: 42, detail: "HTTP 200", stand: "2026-08-21T10:00:00Z" },
    { n: "Kaputt", u: "https://example.net/", h: null, p: true, st: "crit", ms: null, detail: "Verbindung abgewiesen", stand: "2026-08-21T10:00:00Z" },
    { n: "Ungeprüft", u: "https://example.com/", h: null, p: false, st: null, ms: null, detail: null, stand: null },
    { n: "Wartet", u: "https://example.edu/", h: null, p: true, st: null, ms: null, detail: null, stand: null }
  ] }];
  ui.applyLive(zustand);
  ui.state.view = "links";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  const ampel = name => {
    const teil = html.split(name)[1] || "";
    return (teil.match(/dot dot--(\w+)/) || [])[1];
  };
  assert.equal(ampel("Geprüft"), "ok");
  assert.equal(ampel("Kaputt"), "crit");
  assert.equal(ampel("Ungeprüft"), "idle", "ein Lesezeichen behauptet nichts");
  assert.equal(ampel("Wartet"), "idle", "„noch nicht geprüft“ ist nicht „in Ordnung“");
  assert.match(html, /HTTP 200/);
});

/* ============================================================
   AdGuard Home und Portainer in der Oberfläche

   Nicht mit erfundenem Zustand, sondern über die ganze Kette: zwei
   nachgebaute Geräte, ein echter Bestand mit hinterlegten Zugangsdaten,
   ein echter Durchlauf — und erst daraus die Ansichten. Damit fällt auch
   auf, wenn ein Sammler ein Feld anders nennt, als die Ansicht es liest.
   ============================================================ */

async function zustandMitDiensten(fakeOpt = {}) {
  const { fakeAdguard, fakePortainer, listen: hoere, close: schliesse,
    ADGUARD_USER, ADGUARD_PASS, PORTAINER_TOKEN } = await import("./fake-dienste.js");

  const ag = fakeAdguard(fakeOpt.adguard || {});
  const pt = fakePortainer(fakeOpt.portainer || {});
  const agUrl = await hoere(ag), ptUrl = await hoere(pt);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-dienste-"));
  try {
    fs.writeFileSync(path.join(dir, "inventory.yaml"), `
settings: { interval: 3600, icmp: false, timeout: 2 }
sites: [ { id: hq, name: Hauptstandort, short: DEKO, primary: true } ]
hosts:
  - { id: dns-01, type: adguard, site: hq, url: "${agUrl}", role: DNS-Filter }
  - { id: ptr-01, type: portainer, site: hq, url: "${ptUrl}", role: Container }
tunnels: []
links: []
`);
    fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({
      "dns-01": { user: ADGUARD_USER, password: ADGUARD_PASS },
      "ptr-01": { token: PORTAINER_TOKEN }
    }));
    const server = createServer({
      inventory: path.join(dir, "inventory.yaml"),
      secrets: path.join(dir, "secrets.json"),
      state: path.join(dir, "incidents.json")
    });
    await server.engine.runOnce();
    const { buildState } = await import("../src/api.js");
    const zustand = buildState(server.engine, server.secrets);
    server.engine.stop();
    return zustand;
  } finally {
    await schliesse(ag); await schliesse(pt);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("AdGuard zeigt Anfragen, Blockanteil und den Zustand des Schutzes", async () => {
  const zustand = await zustandMitDiensten();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "dienste";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.ok(!/undefined|NaN|\[object Object\]/.test(html), "Platzhalterwert in der Dienste-Ansicht");
  assert.match(html, /2400/, "Anfragen der letzten 24 h");
  assert.match(html, /20 %/, "Blockanteil");
  assert.match(html, /23\.4 ms/, "mittlere Bearbeitungszeit");
  assert.match(html, /Schutz an/);
  assert.match(html, /73000 Regeln/);
  assert.ok(!/Stufe 5/.test(html), "der Hinweis auf den fehlenden Sammler gehört weg");
});

test("Abgeschalteter Schutz steht als Warnung in der Ansicht", async () => {
  const zustand = await zustandMitDiensten({ adguard: { protection: false } });
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "dienste";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  assert.match(html, /Schutz aus/);
  assert.match(html, /Schutz ist abgeschaltet/);
});

test("Portainer zeigt Umgebungen, Container und wer klemmt", async () => {
  const zustand = await zustandMitDiensten();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "virt";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.ok(!/undefined|NaN|\[object Object\]/.test(html), "Platzhalterwert in der Virtualisierungs-Ansicht");
  assert.match(html, /1\/2/, "eine von zwei Umgebungen erreichbar");
  assert.match(html, /20\/22/, "laufende von allen Containern");
  assert.match(html, /jellyfin/, "der Container mit Exit 137 gehört mit Namen hin");
  assert.match(html, /Speichergrenze/);
  assert.match(html, /paperless/);

  /* Und dieselben Zahlen auf der Detailseite des Systems. */
  ui.openSystem("ptr-01");
  ui.state.detail.busy = false;
  ui.state.detail.daten = null;
  ui.render();
  const seite = ziele.get("#wrap").innerHTML;
  assert.match(seite, /docker-hq/);
  assert.match(seite, /Neustartschleife/);
  assert.ok(!/undefined|NaN/.test(seite));
});

/* Ohne Zugangsdaten darf keine Null erscheinen, die wie eine Messung
   aussieht — sondern der Hinweis, was fehlt. */
test("Ohne hinterlegten Zugang steht da, was fehlt — keine Nullen", async () => {
  const zustand = await zustandMitDiensten();
  for (const h of zustand.hosts) {
    for (const k of ["dnsQueries", "dnsBlocked", "blockRate", "avgMs", "protection", "dnsRunning", "filtering",
                     "filters", "filtersAktiv", "filterRules", "upstreams", "endpoints", "endpointsDown",
                     "stacks", "containers", "unhealthy", "restarting", "oom", "running", "stopped"]) h[k] = null;
    h.umgebungen = null; h.probleme = null; h.note = null;
  }
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);

  ui.state.view = "dienste";
  ui.render();
  const dienste = ziele.get("#wrap").innerHTML;
  assert.match(dienste, /Kennzahlen erst mit hinterlegtem Zugang/);
  assert.ok(!/undefined|NaN/.test(dienste));

  ui.state.view = "virt";
  ui.render();
  const virt = ziele.get("#wrap").innerHTML;
  assert.match(virt, /API-Token/);
  assert.ok(!/undefined|NaN/.test(virt));
});

/* ============================================================
   Virtualisierung: Knoten und Gäste
   ============================================================ */

/* Ein Zustand mit einem echten Proxmox-Knoten dahinter — dieselbe
   Attrappe, gegen die auch der Sammler geprüft wird. */
async function zustandMitProxmox(extra = "") {
  const { fakeProxmox, listen: hoere } = await import("./fake-proxmox.js");
  const pve = fakeProxmox();
  const url = await hoere(pve);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-virt-"));
  try {
    fs.writeFileSync(path.join(dir, "inventory.yaml"), `
settings: { interval: 3600, icmp: false, timeout: 2 }
sites: [ { id: hq, name: Hauptstandort, short: DEKO, primary: true } ]
hosts:
  - { id: pve-hq-01, type: pve, site: hq, url: "${url}", role: Cluster-Node${extra} }
tunnels: []
links: []
`);
    fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({
      "pve-hq-01": { user: "leitstand@pve", tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555" }
    }));
    const server = createServer({
      inventory: path.join(dir, "inventory.yaml"),
      secrets: path.join(dir, "secrets.json"),
      state: path.join(dir, "incidents.json")
    });
    await server.engine.runOnce();
    const { buildState } = await import("../src/api.js");
    const zustand = buildState(server.engine, server.secrets);
    server.engine.stop();
    return zustand;
  } finally {
    await new Promise(r => { pve.closeAllConnections?.(); pve.close(r); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Die Virtualisierung zeigt den Knoten mit Softwarestand und offenen Paketen", async () => {
  const zustand = await zustandMitProxmox();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "virt";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.ok(!/undefined|NaN|\[object Object\]/.test(html), "Platzhalterwert in der Virtualisierung");
  assert.match(html, /pve-hq-01/);
  assert.match(html, /6\.8\.12-4-pve/, "der Kernel gehört zum Softwarestand");
  assert.match(html, /2 Update\(s\) offen/);
  assert.match(html, /2 von 3 laufen|2 laufen/, "wie viele Gäste laufen");
});

test("Jeder Gast steht mit Namen und Auslastung da", async () => {
  const zustand = await zustandMitProxmox();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "virt";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.match(html, /vm-web/);
  assert.match(html, /ct-dns/);
  assert.match(html, /41 %/, "die CPU-Auslastung des Containers");
  assert.equal(/vorlage-debian/.test(html), false, "eine Vorlage ist kein laufender Gast");
  assert.match(html, /1 Vorlage\(n\)/, "gezählt wird sie am Knoten");
});

/* Der Kern von Regel 5 an dieser Stelle: die Null, die Proxmox für einen
   gestoppten Gast meldet, ist keine Messung. */
test("Ein gestoppter Gast zeigt seinen Zustand statt 0 %", async () => {
  const zustand = await zustandMitProxmox();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "virt";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  const zeile = html.split("vm-alt")[1].split("</tr>")[0];
  assert.match(zeile, /stopped/);
  assert.equal(/>0 %</.test(zeile), false, "eine ausgeschaltete Maschine langweilt sich nicht");
});

/* ============================================================
   Eigene Schwellwerte
   ============================================================ */

test("Ein System mit eigener Grenze sagt das — und die Ampel folgt ihr", async () => {
  /* local-lvm liegt bei 91 %: mit der Vorgabe rot, mit 97 nicht. */
  const streng = await zustandMitProxmox();
  assert.equal(streng.hosts[0].status, "crit");
  assert.match(streng.hosts[0].note, /local-lvm/);

  const locker = await zustandMitProxmox(", schwellen: { disk_warn: 93, disk_crit: 97 }");
  assert.notEqual(locker.hosts[0].status, "crit", "die eigene Grenze greift");
  assert.deepEqual(locker.hosts[0].schwellenEigen, { disk_warn: 93, disk_crit: 97 });
  assert.equal(locker.hosts[0].schwellen.ram_warn, 85, "ungesetzte Werte kommen weiter von oben");

  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(locker);
  ui.state.view = "virt";
  ui.render();
  assert.match(ziele.get("#wrap").innerHTML, /eigene Schwellen/);

  /* Und in den Einstellungen steht, welches System abweicht — eine
     Abweichung, die niemand mehr findet, ist eine stillgelegte Überwachung. */
  ui.state.view = "cfg";
  ui.render();
  const cfg = ziele.get("#wrap").innerHTML;
  assert.match(cfg, /pve-hq-01/);
  assert.match(cfg, /Speicher gelb 93 %/);
});

test("Das Formular zeigt eigene Werte, aber nicht die geerbten", async () => {
  const zustand = await zustandMitProxmox();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  vm.runInContext("openForm('hosts','edit','pve-hq-01')", sandbox);
  const html = ziele.get("#overlays").innerHTML;
  assert.match(html, /Schwellwerte/);
  /* Der globale Wert steht als Platzhalter da, nicht als Inhalt: sonst
     schriebe jedes Speichern ihn als eigenen fest. */
  assert.match(html, /data-field="s_disk_warn"[^>]*value=""/);
  assert.match(html, /placeholder="80"/);
});

/* ============================================================
   Schnittstellen einer Firewall
   ============================================================ */

/* Die Ansicht liest nur Felder — hier genügt ein Gerät, wie der Sammler
   es liefert. Der Weg dorthin ist in opnsense.test.js geprüft. */
function firewallMit(interfaces) {
  return {
    id: "fw-01", name: "fw-01", type: "opnsense", site: "hq", role: "Firewall",
    status: "ok", ms: 12, hist: [12], monitored: true, checks: [], version: "26.1",
    interfaces, thrIn: 4.2, thrOut: 1.1, thrQuelle: "WAN",
    schwellen: { disk_warn: 80, disk_crit: 90, ram_warn: 85, ram_crit: 95 }
  };
}

test("Die Netzansicht zeigt jede Leitung einzeln mit Rate und Zählern", async () => {
  const zustand = await zustandMitDiensten();
  zustand.hosts.push(firewallMit([
    { name: "vtnet0", label: "LAN", beschreibung: "LAN", link: "up", mtu: 1500,
      in: 4.25, out: 0.5, inPps: 900, outPps: 400,
      rxBytes: 81_386_215_378, txBytes: 557_996_298_083, fehler: 0, fehlerNeu: 0, verworfen: 0, verworfenNeu: 0, kollisionen: 0 },
    { name: "vtnet1", label: "WAN", beschreibung: "Uplink Glasfaser", link: "down", mtu: 1492,
      in: null, out: null, inPps: null, outPps: null,
      rxBytes: 562_774_671_970, txBytes: 78_304_533_217, fehler: 17, fehlerNeu: 3, verworfen: 4, verworfenNeu: 1, kollisionen: 0 }
  ]));
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "netz";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.ok(!/undefined|NaN|\[object Object\]/.test(html), "Platzhalterwert in der Netzansicht");
  assert.match(html, /vtnet0/);
  assert.match(html, /Uplink Glasfaser/);
  assert.match(html, /4\.3/, "die Rate herein, auf eine Stelle gerundet");
  assert.match(html, /1 mit neuen Fehlern/);
  assert.match(html, /\(\+4\)/, "Fehler und Verwürfe seit dem letzten Durchlauf zusammen");
  assert.match(html, /75\.8 GB/, "die übertragene Menge lesbar statt in Bytes");
  assert.match(html, /chip--warn">down/, "eine tote Leitung ist als solche zu sehen");
});

/* Ohne zweiten Durchlauf gibt es keinen Durchsatz — und eine Null wäre an
   dieser Stelle eine Behauptung. */
test("Vor der ersten Differenz steht ein Strich, keine Null", async () => {
  const zustand = await zustandMitDiensten();
  zustand.hosts.push(firewallMit([
    { name: "vtnet0", label: "LAN", beschreibung: null, link: null, mtu: null,
      in: null, out: null, inPps: null, outPps: null,
      rxBytes: 1000, txBytes: 2000, fehler: 0, fehlerNeu: null, verworfen: 0, verworfenNeu: null, kollisionen: 0 }
  ]));
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "netz";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  const zeile = html.split("vtnet0")[1].split("</tr>")[0];
  assert.equal(/>0\.00</.test(zeile), false, "ein fehlender Messwert ist keine Null");
  assert.match(zeile, /—/);
});

/* ============================================================
   AdGuard: die Auflösung selbst
   ============================================================ */

test("Die AdGuard-Kachel nennt die Auflösung über UDP/53", async () => {
  const zustand = await zustandMitDiensten();
  const ag = zustand.hosts.find(h => h.type === "adguard");
  ag.checks = [
    { kind: "tcp", port: 443, ok: true, ms: 2, detail: "Port 443 offen", skipped: false, wesentlich: false },
    { kind: "dns", port: 53, ok: true, ms: 7, detail: "example.org → 93.184.216.34 (UDP/53)", skipped: false, wesentlich: true }
  ];
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "dienste";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  assert.match(html, /DNS UDP\/53/);
  assert.match(html, /7 ms/);
});

test("Löst er nicht auf, steht der Befund im Klartext auf der Kachel", async () => {
  const zustand = await zustandMitDiensten();
  const ag = zustand.hosts.find(h => h.type === "adguard");
  ag.checks = [
    { kind: "dns", port: 53, ok: false, ms: null, detail: "keine Antwort über UDP/53 nach 4000 ms",
      skipped: false, wesentlich: true }
  ];
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "dienste";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  assert.match(html, /Löst nicht auf/);
  assert.match(html, /keine Antwort über UDP\/53/);
});
