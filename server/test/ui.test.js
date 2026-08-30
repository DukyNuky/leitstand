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
  for (const v of ["kurz", "lage", "sites", "virt", "compute", "netz", "vpn", "dienste", "mail", "post", "links", "cfg", "verwaltung"]) {
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

  for (const ansicht of ["post", "vpn", "netz"])
    assert.match(seiten[ansicht], />Beispiel</, `${ansicht} kennzeichnet sein Beispiel nicht`);

  /* Die Ansichten, die aus Messwerten leben, dürfen kein Beispiel enthalten.
     „compute" steht seit den Sicherungsaufträgen dabei: was dort stand, war
     das letzte Beispiel dieser Ansicht — jetzt liest sie die Aufträge aus
     Proxmox und die Datastores aus PBS. */
  for (const ansicht of ["lage", "sites", "compute", "links", "cfg", "verwaltung"])
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

/* Wer ein Gerät anlegt, sitzt Minuten in diesem Formular — und alle 15
   Sekunden kam ein Zustand aus dem Netz und zeichnete die ganze Seite neu.
   Das Formular überlebte das zwar (Eingaben werden gesichert), aber es
   flackerte, der Bildlauf sprang nach oben und ein offenes Auswahlmenü war
   weg. Solange ein Formular steht, bleibt die Seite darunter deshalb
   unberührt; die Daten kommen trotzdem an und stehen beim nächsten
   vollständigen Strich da. */
test("Ein offenes Formular hält den Zustandsstrom von der Seite fern", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "verwaltung";
  ui.render();

  vm.runInContext(`openForm("hosts","new")`, sandbox);
  assert.match(ziele.get("#overlays").innerHTML, /System anlegen/);

  ziele.get("#wrap").innerHTML = "UNBERÜHRT";
  ziele.get("#overlays").innerHTML = "RAHMEN";
  ui.applyLive(zustand);                       /* der nächste Zustand aus dem Netz */

  assert.equal(ziele.get("#wrap").innerHTML, "UNBERÜHRT",
    "die Seite unter dem Formular darf nicht neu gezeichnet werden");
  assert.equal(ziele.get("#overlays").innerHTML, "RAHMEN",
    "die Schublade selbst schon gar nicht — mit ihr ginge das Auswahlmenü verloren");

  /* Und der Zustand ist trotzdem angekommen: er stand nur nicht da. */
  assert.equal(ui.state.hosts.length, zustand.hosts.length);

  /* Erst das Schließen holt nach. */
  vm.runInContext("state.form = null; render();", sandbox);
  assert.notEqual(ziele.get("#wrap").innerHTML, "UNBERÜHRT",
    "nach dem Schließen muss die Seite den neuesten Stand zeigen");
});

/* Ein Klick im Formular ändert das Formular, nicht die Seite darunter.
   Nachgezogen werden deshalb nur Rumpf und Fuß der Schublade — ihr Rahmen
   bleibt stehen, und damit auch die Einblendbewegung, die sonst bei jeder
   Auswahl von vorn anfinge. */
test("Eine Auswahl im Formular zeichnet nur die Schublade nach", async () => {
  const zustand = await echterZustand();
  const { sandbox } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "verwaltung";
  ui.render();

  const knoten = sel => sandbox.document.querySelector(sel);
  vm.runInContext(`openForm("hosts","new")`, sandbox);
  knoten("#wrap").innerHTML = "UNBERÜHRT";
  knoten("#overlays").innerHTML = "RAHMEN";
  knoten(".inspector-body").innerHTML = "";
  knoten(".inspector-foot").innerHTML = "";

  /* Wie ein gewählter Typ: der Wert steht im Zustand, gezeichnet wird nach. */
  vm.runInContext(`state.form.data.type = "adguard"; zeichneFormular();`, sandbox);

  assert.equal(knoten("#wrap").innerHTML, "UNBERÜHRT",
    "die Seite darunter geht die Auswahl nichts an");
  assert.equal(knoten("#overlays").innerHTML, "RAHMEN",
    "der Rahmen der Schublade bleibt stehen — sonst liefe die Einblendbewegung erneut");
  assert.match(knoten(".inspector-body").innerHTML, /Zugangsdaten — AdGuard Home/,
    "der Rumpf muss die Felder zum gewählten Typ zeigen");
  assert.match(knoten(".inspector-foot").innerHTML, /data-action="form-save"/);

  /* Ist das Formular zu — gerade gespeichert —, zeichnet dieselbe Funktion
     die ganze Seite: dann ist sie wieder das Thema. */
  vm.runInContext("state.form = null; zeichneFormular();", sandbox);
  assert.notEqual(knoten("#wrap").innerHTML, "UNBERÜHRT");
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

/* ============================================================
   pfSense: dieselbe Ansicht, mehr Zahlen

   Der Sammler sorgt dafür, dass beide Firewall-Typen dieselben Feldnamen
   liefern — die Oberfläche muss sie nicht auseinanderhalten. Was pfSense
   zusätzlich hergibt (Gateways, Zustandstabelle, CARP), bekommt eigene
   Zeilen; bei OPNsense bleiben sie weg statt leer dazustehen.
   ============================================================ */
function pfsenseMit(extra = {}) {
  return {
    id: "fw-02", name: "fw-02", type: "pfsense", site: "hq", role: "pfSense · Firewall",
    status: "crit", ms: 9, hist: [9], monitored: true, checks: [], version: "2.7.2",
    apiFassung: "v2", ram: 43, disk: 61, uptime: "3 T 20 h", load: "0.68, 0.41, 0.35",
    states: 4210, statesMax: 98000, statesPct: 4, carp: "MASTER", carpWartung: false,
    schwellen: { disk_warn: 80, disk_crit: 90, ram_warn: 85, ram_crit: 95 },
    gateways: [
      { name: "WAN_DHCP", status: "online", monitor: "1.1.1.1", quelle: "192.0.2.10", rtt: 8.4, stddev: 1.1, verlust: 0 },
      { name: "LTE_BACKUP", status: "down", monitor: "8.8.8.8", quelle: "198.51.100.4", rtt: null, stddev: null, verlust: 100 }
    ],
    interfaces: [
      { name: "igb1", label: "WAN", beschreibung: "WAN", link: "down", mtu: 1492,
        in: 12.5, out: 3.25, inPps: 1400, outPps: 900,
        rxBytes: 562_774_671_970, txBytes: 78_304_533_217,
        fehler: 17, fehlerNeu: 0, verworfen: 0, verworfenNeu: 0, kollisionen: 0 }
    ],
    ...extra
  };
}

test("Eine pfSense steht in derselben Tabelle wie eine OPNsense", async () => {
  const zustand = await zustandMitDiensten();
  zustand.hosts.push(pfsenseMit());
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "netz";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.ok(!/undefined|NaN|\[object Object\]/.test(html), "Platzhalterwert in der Netzansicht");
  assert.match(html, /fw-02/);
  assert.match(html, /2\.7\.2/);
  assert.match(html, /CARP MASTER/);
  assert.match(html, /4210 \/ 98000/, "die Zustandstabelle als Verhältnis");
  assert.match(html, /igb1/, "die Schnittstelle steht in derselben Tabelle wie bei OPNsense");
});

test("Gateways bekommen eine eigene Tabelle, der ausgefallene fällt auf", async () => {
  const zustand = await zustandMitDiensten();
  zustand.hosts.push(pfsenseMit());
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "netz";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.match(html, /Gateways/);
  assert.match(html, /WAN_DHCP/);
  assert.match(html, /LTE_BACKUP/);
  assert.match(html, /8\.4 ms/);
  assert.match(html, /100 %/, "voller Verlust am ausgefallenen Uplink");
  assert.match(html, /1 auffällig/);
});

/* Eine OPNsense liefert diese drei nicht. Eine Zeile „CARP: —" wäre dort
   eine Aussage über etwas, wonach gar nicht gefragt wurde. */
test("Bei OPNsense bleiben Gateways und CARP weg statt leer dazustehen", async () => {
  const zustand = await zustandMitDiensten();
  zustand.hosts.push(firewallMit([
    { name: "vtnet0", label: "LAN", beschreibung: "LAN", link: "up", mtu: 1500,
      in: 1, out: 1, inPps: 10, outPps: 10, rxBytes: 100, txBytes: 100,
      fehler: 0, fehlerNeu: 0, verworfen: 0, verworfenNeu: 0, kollisionen: 0 }
  ]));
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "netz";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  assert.equal(/<h3>Gateways<\/h3>/.test(html), false, "ohne gemeldete Gateways keine Gateway-Tabelle");
  assert.match(html, /vtnet0/);
});

test("Die Detailseite zeigt für pfSense Zustandstabelle, CARP und Gateways", async () => {
  const zustand = await zustandMitDiensten();
  zustand.hosts.push(pfsenseMit());
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.openSystem("fw-02");
  ui.state.detail.busy = false;
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.ok(!/undefined|NaN|\[object Object\]/.test(html), "Platzhalterwert auf der Detailseite");
  assert.match(html, /Zustandstabelle/);
  assert.match(html, /MASTER/);
  assert.match(html, /pfSense-pkg-API v2/, "woher die Zahlen kommen, gehört dazu");
  assert.match(html, /Durchsatz je Schnittstelle/);
});

test("Das Formular kennt beide Anmeldewege des API-Pakets", async () => {
  const zustand = await zustandMitDiensten();
  zustand.hosts.push(pfsenseMit());
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  vm.runInContext("openForm('hosts','edit','fw-02')", sandbox);
  const html = ziele.get("#overlays").innerHTML;
  assert.match(html, /pfSense-pkg-API/);
  assert.match(html, /data-cred="key"/);
  assert.match(html, /data-cred="clientId"/);
  /* Der Schlüssel ist bei pfSense die ganze Anmeldung — er darf nie
     vorbelegt in einer Browserseite stehen. */
  assert.match(html, /data-cred="key" type="password"[^>]*value=""/);
});

/* Die Typtabelle der Oberfläche ist eine Abschrift der im Dienst — und
   eine Abschrift läuft auseinander. Genau das ist beim pfSense-Sammler
   passiert: der Dienst konnte längst mehr, die Oberfläche bot die
   Zugangsfelder nicht an, und zu sehen war nur, dass nichts ankommt. */
test("Die Typen der Oberfläche stimmen mit denen des Dienstes überein", async () => {
  const { sandbox } = ladeUi();
  /* Aus der VM kommen Felder mit fremdem Prototyp — `assert/strict`
     vergleicht den mit. Also über die Werte gehen, nicht über die Felder. */
  const ui = [...vm.runInContext("HOST_TYPES", sandbox)].map(t => [...t]);
  const { TYPES } = await import("../src/inventory.js");

  assert.equal(ui.map(t => t[0]).sort().join(" "), Object.keys(TYPES).sort().join(" "), "dieselben Typen");
  for (const [id, label, port, hatApi] of ui) {
    assert.equal(label, TYPES[id].label, `Beschriftung von ${id}`);
    assert.equal(port, TYPES[id].port, `Standardport von ${id}`);
    assert.equal(hatApi, !!TYPES[id].api,
      `„${id}“ hat im Dienst ${TYPES[id].api ? "einen" : "keinen"} Sammler — die Oberfläche sagt das Gegenteil`);
  }
});

/* ============================================================
   Beide Enden einer Strecke in der Oberfläche
   ============================================================ */

const PEERZUSTAND2 = [
  ...PEERZUSTAND,
  { id: "fw2/wg0/nach-HQ", name: "nach-HQ", key: "Kx7Qd", iface: "wg0", von: "fw2", site: "hq",
    device: "erlaubt: 10.99.0.1/32", status: "ok", handshake: 95, seit: "2026-08-20 14:15:41",
    ip: "10.99.0.1/32", allowed: "10.99.0.1/32", ips: ["10.99.0.1"], netze: [],
    endpoint: "203.0.113.5:51820", rx: "3.9 GB", tx: "1.1 GB", tunnel: "wg-hq-rz" }
];

async function mitBeidenEnden() {
  const zustand = await echterZustand();
  zustand.peers = PEERZUSTAND2.map(p => ({ ...p, ips: p.ips ?? [], netze: p.netze ?? [] }));
  Object.assign(zustand.tunnels[0], {
    handshake: 80, rx: "1.1 GB", tx: "3.9 GB",
    ips: ["10.99.0.2", "10.99.0.1"], netze: ["192.168.20.0/24"],
    peer: { host: "fw", name: "WG-Schweiz", key: "Aqujl", iface: "wg0", gefunden: true,
      endpoint: "178.39.98.174:8909", allowed: "10.99.0.2/32, 192.168.20.0/24",
      ips: ["10.99.0.2"], netze: ["192.168.20.0/24"], handshake: 80, rx: "1.1 GB", tx: "3.9 GB", note: null },
    peerB: { host: "fw2", name: "nach-HQ", key: "Kx7Qd", iface: "wg0", gefunden: true,
      endpoint: "203.0.113.5:51820", allowed: "10.99.0.1/32",
      ips: ["10.99.0.1"], netze: [], handshake: 95, rx: "3.9 GB", tx: "1.1 GB", note: null }
  });
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  return { sandbox, ziele, zustand };
}

test("Die Tunnelzeile nennt beide Firewalls, nicht nur eine", async () => {
  const { sandbox, ziele } = await mitBeidenEnden();
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "vpn";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  assert.match(html, /fw <span class="faint">↔<\/span> fw2|fw ↔ fw2/, "beide Enden stehen in der Zeile");
  assert.ok(!/nur ein Ende/.test(html), "mit zwei Enden ist der Hinweis gegenstandslos");
});

/* Der Anlass: eine verknüpfte Strecke, und die Gegenzeile in der
   Peertabelle behauptete, zu keiner zu gehören. */
test("Beide Gegenstellen zeigen dieselbe Strecke", async () => {
  const { sandbox, ziele } = await mitBeidenEnden();
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "vpn";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  const treffer = html.match(/data-kind="tunnel" data-id="wg-hq-rz"/g) || [];
  assert.ok(treffer.length >= 2, `nur ${treffer.length} Verweis(e) auf die Strecke — beide Enden gehören dazu`);
});

test("Mit nur einem Ende sagt die Zeile, dass das zweite fehlt", async () => {
  const { sandbox, ziele } = await mitPeers();
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "vpn";
  ui.render();
  assert.match(ziele.get("#wrap").innerHTML, /nur ein Ende/);
});

test("Der Tunnel-Inspektor zeigt beide Enden und die gelesenen Adressen", async () => {
  const { sandbox, ziele } = await mitBeidenEnden();
  const ui = sandbox.window.LeitstandUI;
  ui.state.inspector = { kind: "tunnel", id: "wg-hq-rz" };
  ui.render();
  const html = ziele.get("#overlays").innerHTML;
  assert.match(html, /WG-Schweiz/);
  assert.match(html, /nach-HQ/);
  assert.match(html, /10\.99\.0\.2/, "die Adressen im Tunnel, von der Firewall gelesen");
  assert.match(html, /192\.168\.20\.0\/24/, "und die Netze dahinter");
});

test("Das Tunnelformular bietet beide Enden an und die gelesenen Adressen zur Übernahme", async () => {
  const { sandbox, ziele } = await mitBeidenEnden();
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz")`, sandbox);
  const html = ziele.get("#overlays").innerHTML;
  assert.match(html, /data-field="peerRef"/);
  assert.match(html, /data-field="peerBRef"/);
  assert.match(html, /data-action="form-set" *\n? *data-field="probeIp" data-value="10\.99\.0\.1"/,
    "eine gelesene Adresse lässt sich als Gegenstelle übernehmen");
});

test("Beide Enden werden gespeichert, und ein gelöstes zweites geht als null", async () => {
  const { sandbox } = await mitBeidenEnden();
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz")`, sandbox);
  const p = JSON.parse(vm.runInContext("JSON.stringify(formPayload())", sandbox));
  assert.equal(p.peer.key, "Aqujl");
  assert.equal(p.peerB.key, "Kx7Qd");

  vm.runInContext(`state.form.data.peerBRef = "";`, sandbox);
  const q = JSON.parse(vm.runInContext("JSON.stringify(formPayload())", sandbox));
  assert.equal(q.peerB, null, "ein fehlendes Feld ließe die alte Verknüpfung stehen");
});

/* ============================================================
   Datastores des Backup Servers
   ============================================================ */

async function mitBackupServer(ab = {}) {
  const zustand = await echterZustand();
  zustand.hosts.push({
    id: "pbs-01", name: "pbs-01", type: "pbs", site: "hq", status: "ok", monitored: true,
    checks: [], hist: [], schwellen: { disk_warn: 80, disk_crit: 90, ram_warn: 85, ram_crit: 95 },
    used: 90, failed: 0, lastGood: "2026-08-23T01:00:00.000Z", datastores: 2,
    stores: [
      { name: "main", used: 74, usedBytes: 3_700_000_000_000, totalBytes: 5_000_000_000_000,
        availBytes: 1_100_000_000_000, vollInTagen: 9, vollAm: "2026-09-01T00:00:00.000Z",
        comment: "Tägliche Sicherung", wartung: null,
        lastBackup: "2026-08-23T01:00:00.000Z", backupOk: true,
        lastGc: "2026-08-22T03:00:00.000Z", gcOk: true, lastVerify: null, verifyOk: null },
      { name: "nas-archive", used: 90, usedBytes: 900_000_000_000, totalBytes: 1_000_000_000_000,
        availBytes: 100_000_000_000, vollInTagen: null, vollAm: null, comment: null, wartung: "read-only",
        lastBackup: null, backupOk: null, lastGc: null, gcOk: null,
        lastVerify: "2026-08-23T02:00:00.000Z", verifyOk: false }
    ],
    ...ab
  });
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  return { sandbox, ziele };
}

test("Jeder Datastore steht mit Belegung, freiem Platz und seinen Läufen da", async () => {
  const { sandbox, ziele } = await mitBackupServer();
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "compute";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.match(html, /main/);
  assert.match(html, /nas-archive/);
  assert.match(html, /Tägliche Sicherung/);
  assert.match(html, /in 9 T/, "die Schätzung von PBS, wann er voll ist");
  assert.match(html, /nie/, "nie geprüft ist eine Auskunft, kein Strich");
  assert.ok(!/undefined|NaN/.test(html));
});

test("Ein Datastore ohne Schätzung bekommt keine erfundene", async () => {
  const { sandbox, ziele } = await mitBackupServer();
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "compute";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  /* nas-archive hat keine — dort steht ein Strich, nicht „in 0 T". */
  assert.ok(!/in 0 T/.test(html));
});

/* ============================================================
   Zertifikate ohne Ampel
   ============================================================ */

test("Ein nicht bewertetes Zertifikat steht da, ohne zu leuchten", async () => {
  const zustand = await echterZustand();
  zustand.certs = [
    { cn: "fw.local", issuer: "eigensigniert", days: -40, where: "fw:443",
      selfSigned: true, bewertet: false, status: "idle" }
  ];
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "dienste";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  assert.match(html, /seit 40 T abgelaufen/, "verschwiegen wird nichts");
  assert.match(html, /nicht bewertet/);
  assert.match(html, /tls_selfsigned_ignore/, "und wo man es umstellt");
});

/* ============================================================
   Das Interface: gelesen, ausgewählt, getippt
   ============================================================ */

/* Ist ein Peer verknüpft, weiß die Firewall den Namen besser als jede
   Eingabe — dann gehört die Frage weg, nicht bloß vorbelegt. */
test("Mit verknüpftem Peer wird das Interface gelesen, nicht gefragt", async () => {
  const { sandbox, ziele } = await mitPeers();
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz")`, sandbox);
  const html = ziele.get("#overlays").innerHTML;
  assert.ok(!/data-field="iface"/.test(html), "ein zweites Feld für dieselbe Angabe wäre eines zu viel");
  assert.ok(!/data-field="ifaceWahl"/.test(html));
  assert.match(html, /gelesen/);
});

/* Und wenn das andere Ende niemandem hier gehört: keine leere Zeile,
   sondern die Auswahl über das, was die erreichbaren Geräte melden. */
test("Ohne Verknüpfung wird das Interface zur Auswahl statt zum leeren Feld", async () => {
  const { sandbox, ziele } = await mitPeers(null);
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz")`, sandbox);
  const html = ziele.get("#overlays").innerHTML;
  assert.match(html, /data-field="ifaceWahl"/);
  assert.match(html, /<option value="wg0" selected>/, "der hinterlegte Name ist vorgewählt");
  assert.match(html, /<option value="wg1"/, "auch das, was sonst noch gemeldet wird");
  assert.match(html, /__frei/, "und ein Weg zum eigenen Namen");
});

test("„Andere“ führt zurück zum Textfeld", async () => {
  const { sandbox, ziele } = await mitPeers(null);
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz"); state.form.data.ifaceWahl = "__frei"; render();`, sandbox);
  assert.match(ziele.get("#overlays").innerHTML, /data-field="iface"/);
});

test("Meldet die Firewall das Interface, wird die getippte Angabe gelöscht", async () => {
  const { sandbox } = await mitPeers();
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz")`, sandbox);
  const p = JSON.parse(vm.runInContext("JSON.stringify(formPayload())", sandbox));
  assert.equal(p.iface, null, "sonst stünde eine zweite Quelle daneben, die still veraltet");
});

test("Ohne Verknüpfung wird der ausgewählte Name gespeichert", async () => {
  const { sandbox } = await mitPeers(null);
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz"); state.form.data.ifaceWahl = "wg1";`, sandbox);
  const p = JSON.parse(vm.runInContext("JSON.stringify(formPayload())", sandbox));
  assert.equal(p.iface, "wg1");
});

/* ============================================================
   Neuzeichnen aus dem Netz
   ============================================================ */

/* Alle 15 Sekunden kommt ein Zustand. Ein aufgeklapptes Auswahlmenü hängt
   am Knoten des <select> und ist mit dem nächsten Strich weg — mitten im
   Auswählen. Aufgeschoben wird deshalb das Bild, nicht die Daten. */
test("Während einer Auswahl wird nicht neu gezeichnet", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);

  sandbox.document.activeElement = { tagName: "SELECT", dataset: {} };
  ziele.get("#wrap").innerHTML = "MARKE";
  sandbox.window.LeitstandUI.applyLive(zustand);
  assert.equal(ziele.get("#wrap").innerHTML, "MARKE", "das Neuzeichnen hätte die Auswahl zugeworfen");

  /* Ist die Auswahl vorbei, wird nachgeholt — die Daten waren die ganze
     Zeit da, nur das Bild stand still. */
  sandbox.document.activeElement = null;
  vm.runInContext("renderLive()", sandbox);
  assert.notEqual(ziele.get("#wrap").innerHTML, "MARKE");
});

test("Was der Benutzer selbst auslöst, zeichnet sofort", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);

  sandbox.document.activeElement = { tagName: "SELECT", dataset: {} };
  ziele.get("#wrap").innerHTML = "MARKE";
  vm.runInContext(`state.view = "vpn"; render();`, sandbox);
  assert.notEqual(ziele.get("#wrap").innerHTML, "MARKE", "ein Klick darf nicht auf den nächsten Zustand warten");
});

test("„Ohne Angabe“ löscht den früher getippten Namen", async () => {
  const { sandbox } = await mitPeers(null);
  vm.runInContext(`openForm("tunnels", "edit", "wg-hq-rz"); state.form.data.ifaceWahl = "";`, sandbox);
  const p = JSON.parse(vm.runInContext("JSON.stringify(formPayload())", sandbox));
  assert.equal(p.iface, null, "die Auswahl gilt, nicht der Wert von vorhin");
});

test("Ohne gemeldete Interfaces bleibt es beim Textfeld", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  vm.runInContext(`openForm("tunnels", "new", null)`, sandbox);
  const html = ziele.get("#overlays").innerHTML;
  assert.match(html, /data-field="iface"/);
  assert.ok(!/data-field="ifaceWahl"/.test(html), "eine leere Auswahlliste hilft niemandem");

  vm.runInContext(`state.form.data.iface = "wg7";`, sandbox);
  const p = JSON.parse(vm.runInContext("JSON.stringify(formPayload())", sandbox));
  assert.equal(p.iface, "wg7");
});

/* ============================================================
   Spalten sortieren

   Sortiert wird, was in der Zelle steht — geprüft wird deshalb der
   Vergleich, nicht der DOM-Griff drumherum. Er muss die Schreibweisen
   verstehen, die in diesem Werkzeug vorkommen, und vor allem darf ein
   Strich nicht als Null durchgehen.
   ============================================================ */

function sortiert(sandbox, zellen, richtung = 1) {
  const code = `JSON.stringify(sortReihenfolge(${JSON.stringify(zellen)}, ${richtung}))`;
  return JSON.parse(vm.runInContext(code, sandbox)).map(i => zellen[i].text);
}

test("Mengen mit Einheit werden als Mengen verglichen, nicht als Text", async () => {
  const { sandbox } = ladeUi();
  assert.deepEqual(
    sortiert(sandbox, [{ text: "1.1 GB" }, { text: "536 MB" }, { text: "2.4 TB" }, { text: "980 B" }]),
    ["980 B", "536 MB", "1.1 GB", "2.4 TB"]);
});

test("Zeiten auch — eine Minute ist mehr als 900 Millisekunden", async () => {
  const { sandbox } = ladeUi();
  assert.deepEqual(
    sortiert(sandbox, [{ text: "3 T" }, { text: "900 ms" }, { text: "1 min 20 s" }, { text: "5 h" }]),
    ["900 ms", "1 min 20 s", "5 h", "3 T"]);
});

test("Ein Strich bleibt hinten — in beide Richtungen", async () => {
  const { sandbox } = ladeUi();
  const zellen = [{ text: "—" }, { text: "74 %" }, { text: "12 %" }, { text: "—" }];
  assert.deepEqual(sortiert(sandbox, zellen, 1), ["12 %", "74 %", "—", "—"]);
  assert.deepEqual(sortiert(sandbox, zellen, -1), ["74 %", "12 %", "—", "—"],
    "ein Unbekanntes ist keine Null und darf keine Spalte anführen");
});

test("Eine leere Zelle ist die Ampel — dann gilt die Dringlichkeit der Zeile", async () => {
  const { sandbox } = ladeUi();
  const zellen = [{ text: "", sev: "ok" }, { text: "", sev: "crit" }, { text: "", sev: "warn" }];
  const code = `JSON.stringify(sortReihenfolge(${JSON.stringify(zellen)}, 1))`;
  assert.deepEqual(JSON.parse(vm.runInContext(code, sandbox)).map(i => zellen[i].sev),
    ["crit", "warn", "ok"]);
});

test("Zeitpunkte: heute steht hinter gestern, und der Tag zählt vor der Uhrzeit", async () => {
  const { sandbox } = ladeUi();
  assert.deepEqual(
    sortiert(sandbox, [{ text: "14:15" }, { text: "23.08. 09:00" }, { text: "22.08. 23:59" }, { text: "09:00" }]),
    ["22.08. 23:59", "23.08. 09:00", "09:00", "14:15"]);
});

test("Ein Name mit Ziffern bleibt ein Name", async () => {
  const { sandbox } = ladeUi();
  assert.deepEqual(
    sortiert(sandbox, [{ text: "pve-hq-02" }, { text: "pve-hq-01" }, { text: "fw-01" }]),
    ["fw-01", "pve-hq-01", "pve-hq-02"]);
});

test("Zahlen stehen vor dem Wort, das für eine fehlende steht", async () => {
  const { sandbox } = ladeUi();
  assert.deepEqual(
    sortiert(sandbox, [{ text: "nie" }, { text: "in 9 T" }, { text: "in 2 T" }]),
    ["in 2 T", "in 9 T", "nie"]);
});

test("Gleiche Werte behalten die Reihenfolge der Ansicht", async () => {
  const { sandbox } = ladeUi();
  const zellen = [{ text: "80 %" }, { text: "80 %" }, { text: "10 %" }];
  const code = `JSON.stringify(sortReihenfolge(${JSON.stringify(zellen)}, 1))`;
  assert.deepEqual(JSON.parse(vm.runInContext(code, sandbox)), [2, 0, 1]);
});

/* Dreimal klicken heißt: auf, ab, und wieder die Ordnung der Ansicht —
   die ist nach Dringlichkeit und damit die einzige, die von selbst das
   Wichtige nach oben bringt. */
test("Der dritte Klick nimmt die Sortierung zurück", async () => {
  const { sandbox } = ladeUi();
  const lauf = vm.runInContext(`
    const a = sortKlick("t", 2);
    const b = sortKlick("t", 2);
    const c = sortKlick("t", 2);
    const d = sortKlick("t", 3);
    JSON.stringify([a, b, c, d, Object.keys(state.sort)])`, sandbox);
  const [a, b, c, d, schluessel] = JSON.parse(lauf);
  assert.deepEqual(a, { spalte: 2, richtung: 1 });
  assert.deepEqual(b, { spalte: 2, richtung: -1 });
  assert.equal(c, null);
  assert.deepEqual(d, { spalte: 3, richtung: 1 }, "eine andere Spalte fängt wieder aufsteigend an");
  assert.deepEqual(schluessel, ["t"]);
});

/* ============================================================
   Sicherungsaufträge in der Oberfläche
   ============================================================ */

async function mitSicherungen(ab = []) {
  const zustand = await echterZustand();
  zustand.backups = ab.length ? ab : [
    { host: "web", hostName: "web", node: "pve-hq-01", id: "backup-1a", name: "Nacht — alles",
      aktiv: true, zeitplan: "02:00", ziel: "pbs-main", modus: "snapshot", umfang: "alle Gäste",
      naechster: "2026-08-24T00:00:00.000Z", zuletzt: "2026-08-23T00:12:00.000Z", letzterStatus: "ok",
      zuletztOk: "2026-08-23T00:12:00.000Z", zuletztFehler: "2026-08-21T00:31:00.000Z",
      laeufe: 12, quelle: "auftrag", status: "ok" },
    { host: "web", hostName: "web", node: "pve-hq-01", id: "backup-9f", name: "Wochenende",
      aktiv: false, zeitplan: "sat 05:00", ziel: "nas", modus: "stop", umfang: "3 Gäste",
      naechster: null, zuletzt: null, letzterStatus: null,
      zuletztOk: null, zuletztFehler: null, laeufe: 0, quelle: "knoten", status: "idle" }
  ];
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "compute";
  ui.render();
  return ziele.get("#wrap").innerHTML;
}

test("Jeder Sicherungsauftrag steht mit Zeitplan, Ziel und seinen drei Zeitpunkten da", async () => {
  const html = await mitSicherungen();
  assert.match(html, /Nacht — alles/);
  assert.match(html, /alle Gäste/);
  assert.match(html, /pbs-main/);
  assert.match(html, /02:00/);
  assert.match(html, /erfolgreich/);
  assert.ok(!/undefined|NaN/.test(html));
});

test("Ein Auftrag, der nie lief, sagt das — statt eines Strichs", async () => {
  const html = await mitSicherungen();
  assert.match(html, /noch nie gelaufen/);
  assert.match(html, /abgeschaltet/, "und ein abgeschalteter gibt sich als solcher zu erkennen");
});

/* Ein Fehlschlag von vorgestern verschwindet nicht, weil heute Nacht alles
   klappte — er beantwortet eine andere Frage. */
test("Der letzte Fehlschlag bleibt sichtbar, auch wenn danach einer glückte", async () => {
  const html = await mitSicherungen();
  assert.match(html, /21\.08\./, "der Zeitpunkt des Fehlschlags steht in seiner eigenen Spalte");
});

test("Wo die Zuordnung nur der Knoten hergibt, steht das dabei", async () => {
  const html = await mitSicherungen([
    { host: "web", hostName: "web", node: "pve-hq-01", id: "b", name: "Wochenende", aktiv: true,
      zeitplan: "sat 05:00", ziel: "nas", umfang: "3 Gäste", naechster: null,
      zuletzt: "2026-08-23T00:12:00.000Z", letzterStatus: "ok",
      zuletztOk: "2026-08-23T00:12:00.000Z", zuletztFehler: null, laeufe: 4,
      quelle: "knoten", status: "ok" }
  ]);
  assert.match(html, /vom Knoten/);
  assert.match(html, /Auftragskennung/, "und darunter, warum das so ist");
});

/* ============================================================
   Kurzlage

   Die eine Ansicht, auf die sich jemand morgens im Vorbeigehen verlässt.
   Grün ist hier eine Behauptung — geprüft wird deshalb vor allem, wann
   sie NICHT gemacht werden darf.
   ============================================================ */

function kurzlage(anpassen = () => {}, zustand) {
  const { sandbox, ziele } = ladeUi();
  const st = zustand;
  sandbox.window.LeitstandUI.applyLive(st);
  const ui = sandbox.window.LeitstandUI;
  anpassen(ui, sandbox);
  ui.state.view = "kurz";
  ui.render();
  return { html: ziele.get("#wrap").innerHTML + ziele.get("#top").innerHTML, sandbox, ui };
}

test("Ist alles in Ordnung, sagt die Kurzlage genau das", async () => {
  const zustand = await echterZustand();
  /* Der Testbestand misst gegen unerreichbare Adressen — für diesen Fall
     wird daraus ein gesunder Stand gemacht. Geprüft wird die Aussage, nicht
     der Prober. */
  zustand.incidents = [];
  for (const h of zustand.hosts) h.status = "ok";
  for (const t of zustand.tunnels) t.status = "ok";
  const { html } = kurzlage(() => {}, zustand);
  assert.match(html, /Passt alles/);
  assert.ok(!/undefined|NaN/.test(html));
});

test("Eine Störung macht aus Grün eine Zahl und nennt die erste", async () => {
  const zustand = await echterZustand();
  zustand.incidents = [
    { id: "INC-1", sev: "crit", host: "fw", site: "rz", title: "fw nicht erreichbar", ack: false, ageMin: 12, count: 3 },
    { id: "INC-2", sev: "warn", host: "web", site: "hq", title: "langsame Antwort", ack: false, ageMin: 4, count: 1 }
  ];
  const { html } = kurzlage(() => {}, zustand);
  assert.match(html, /Eine Störung/);
  assert.match(html, /fw nicht erreichbar/);
  assert.match(html, /seit 12 min/);
});

/* „Quittiert" heißt, dass jemand hinsieht — nicht, dass es behoben ist.
   Eine grüne Fläche darüber wäre die gefährlichste Anzeige des Werkzeugs. */
test("Eine quittierte Störung macht die Fläche nicht grün", async () => {
  const zustand = await echterZustand();
  zustand.incidents = [{ id: "INC-1", sev: "crit", host: "fw", site: "rz", title: "fw nicht erreichbar", ack: true, ageMin: 90, count: 9 }];
  const { html } = kurzlage(() => {}, zustand);
  assert.ok(!/Passt alles/.test(html));
  assert.match(html, /Eine Störung/);
  assert.match(html, /quittiert/);
});

/* Der gefährlichste Zustand ist nicht Rot, sondern Grün ohne Grundlage. */
test("Hängt der Zustandsstrom, ist der Stand unklar und nicht in Ordnung", async () => {
  const zustand = await echterZustand();
  zustand.incidents = [];
  for (const h of zustand.hosts) h.status = "ok";
  const { html } = kurzlage((ui, sandbox) => { sandbox.window.LEITSTAND.stale = true; }, zustand);
  assert.match(html, /Stand unklar/);
  assert.ok(!/Passt alles/.test(html));
});

/* Ohne Dienst zeigt die Oberfläche ohnehin ihre Offline-Seite — geprüft
   wird deshalb der Befund selbst, damit er auch dann nichts behauptet. */
test("Ohne Dienst behauptet der Befund gar nichts", async () => {
  const zustand = await echterZustand();
  zustand.incidents = [];
  const { sandbox } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  sandbox.window.LEITSTAND.live = false;
  const b = JSON.parse(vm.runInContext("JSON.stringify(kurzBefund())", sandbox));
  assert.equal(b.ton, "idle");
  assert.match(b.wort, /Kein Stand/);
});

/* Grün ist nur so viel wert wie das, worüber es schweigt. */
test("Unter der Fläche steht, was in ihr nicht enthalten ist", async () => {
  const zustand = await echterZustand();
  zustand.incidents = [];
  for (const h of zustand.hosts) h.status = "ok";
  zustand.integrations = [
    { name: "OPNsense", type: "opnsense", targets: 2, mitZugang: 0, unterstuetzt: true, status: "idle", method: "", every: "15 s", note: "" },
    { name: "TrueNAS SCALE", type: "truenas", targets: 1, mitZugang: 0, unterstuetzt: false, status: "idle", method: "", every: "15 s", note: "" }
  ];
  const { html } = kurzlage(() => {}, zustand);
  assert.match(html, /ohne hinterlegte Zugangsdaten/);
  assert.match(html, /noch keinen\s*\n?\s*Sammler|keinen Sammler/);
  assert.match(html, /von der Überwachung ausgenommen/, "das Laborsystem im Bestand steht mit dabei");
});

/* Abgeschaltetes ICMP ist eine solche Lücke: reine Ping-Ziele werden dann
   gar nicht geprüft, und der Testbestand hat es abgeschaltet. */
test("Abgeschaltetes ICMP steht als Lücke da", async () => {
  const zustand = await echterZustand();
  zustand.incidents = [];
  const { html } = kurzlage(() => {}, zustand);
  assert.match(html, /ICMP ist abgeschaltet/);
});

test("Ist wirklich nichts offen, sagt der Absatz auch das", async () => {
  const zustand = await echterZustand();
  zustand.incidents = [];
  zustand.integrations = [{ name: "OPNsense", type: "opnsense", targets: 1, mitZugang: 1, unterstuetzt: true, status: "ok", method: "", every: "15 s", note: "" }];
  zustand.hosts = zustand.hosts.filter(h => h.monitored !== false).map(h => ({ ...h, status: "ok" }));
  zustand.meta.runtime = { ...zustand.meta.runtime, icmp: { configured: true, working: true, note: "läuft" } };
  const { html } = kurzlage(() => {}, zustand);
  assert.match(html, /Jedes angelegte System wird geprüft/);
});

/* Auf einem Telefon zählt, was fehlt: Suchfeld und Tastenkürzel sind dort
   Zierrat und nehmen die halbe Kopfzeile. */
test("Die Kurzlage trägt keine Suchleiste und keinen Kürzelknopf", async () => {
  const zustand = await echterZustand();
  const { html } = kurzlage(() => {}, zustand);
  assert.ok(!/id="q"/.test(html));
  assert.ok(!/Nur Probleme/.test(html));
  assert.match(html, /data-action="site"/, "der Standortfilter bleibt");
});

/* Der Anlass: eine Strecke stand rot da, und dieselbe Adresse ließ sich
   aus dem Behälter von Hand anpingen. Der Inspektor muss sagen, welche
   Prüfung was gesagt hat — sonst rät man. */
test("Der Tunnel-Inspektor zeigt jede Prüfung einzeln", async () => {
  const zustand = await echterZustand();
  Object.assign(zustand.tunnels[0], {
    checks: [
      { kind: "tcp", port: 22, ok: false, ms: null, detail: "Zeitüberschreitung", skipped: false },
      { kind: "icmp", port: null, ok: null, ms: null, skipped: true,
        detail: "ICMP nicht erlaubt — der Dienst läuft unprivilegiert. Dem Behälter fehlt NET_RAW" }
    ]
  });
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  const ui = sandbox.window.LeitstandUI;
  ui.state.inspector = { kind: "tunnel", id: "wg-hq-rz" };
  ui.render();
  const html = ziele.get("#overlays").innerHTML;
  assert.match(html, /Prüfungen/);
  assert.match(html, /Zeitüberschreitung/);
  assert.match(html, /NET_RAW/, "warum ICMP nicht lief, gehört dazu");
});

test("Ist keine Prüfung gelaufen, sagt der Inspektor, dass nichts gemessen wurde", async () => {
  const zustand = await echterZustand();
  Object.assign(zustand.tunnels[0], {
    checks: [{ kind: "icmp", port: null, ok: null, ms: null, skipped: true, detail: "ICMP nicht erlaubt" }]
  });
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  const ui = sandbox.window.LeitstandUI;
  ui.state.inspector = { kind: "tunnel", id: "wg-hq-rz" };
  ui.render();
  assert.match(ziele.get("#overlays").innerHTML, /nichts gemessen/);
});

/* ============================================================
   Mail Gateway in der Oberfläche

   Wieder über die ganze Kette: ein nachgebautes Gerät, ein echter
   Bestand mit hinterlegtem Konto, ein echter Durchlauf — und erst
   daraus die Ansicht. Genau hier wäre aufgefallen, dass der Sammler
   sich mit einem API-Token anmeldet, das es bei PMG gar nicht gibt.
   ============================================================ */

async function zustandMitGateway(fakeOpt = {}) {
  const { fakePmg, listen: hoere, BENUTZER, PASSWORT } = await import("./fake-pmg.js");
  const srv = fakePmg(fakeOpt);
  const url = await hoere(srv);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-pmg-"));
  try {
    fs.writeFileSync(path.join(dir, "inventory.yaml"), `
settings: { interval: 3600, icmp: false, timeout: 2, pmg_takt: 0, pmg_takt_lang: 0 }
sites: [ { id: hq, name: Hauptstandort, short: DEKO, primary: true } ]
hosts:
  - { id: pmg-01, type: pmg, site: hq, url: "${url}", role: Mail Gateway }
tunnels: []
links: []
`);
    fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({
      "pmg-01": { user: BENUTZER, password: PASSWORT }
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
    await new Promise(r => srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Der Mail Gateway zeigt Durchsatz, Warteschlange, Quarantäne und Signaturen", async () => {
  const zustand = await zustandMitGateway();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "mail";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.ok(!/undefined|NaN|\[object Object\]/.test(html), "Platzhalterwert in der Mail-Ansicht");
  assert.match(html, /1840/, "eingehende Mail in 24 h");
  assert.match(html, /66 %/, "Spamanteil am angenommenen Eingang");
  assert.match(html, /deferred/, "die Warteschlangen einzeln");
  assert.match(html, /812/, "Umfang der Spam-Quarantäne");
  assert.match(html, /daily/, "die Signaturdatenbank mit Stand");
  assert.match(html, /pmg-smtp-filter/, "die Dienste, die filtern");
  assert.match(html, /kunde\.de/, "Verkehr je Domäne");

  /* Und dieselben Zahlen auf der Detailseite. */
  ui.openSystem("pmg-01");
  ui.state.detail.busy = false;
  ui.state.detail.daten = null;
  ui.render();
  const seite = ziele.get("#wrap").innerHTML;
  assert.match(seite, /Gateway im Einzelnen/);
  assert.match(seite, /Vor der Annahme abgewiesen/);
  assert.ok(!/undefined|NaN/.test(seite));
});

/* Ein Gateway, das Viren abfängt, tut seinen Dienst — eine Ampel dafür
   wäre nach zwei Wochen abtrainiert. Ein Virus, das hinausgeht, ist
   etwas völlig anderes. */
test("Eingehende Viren stehen da, ohne zu leuchten — ausgehende sind rot", async () => {
  const ruhig = await zustandMitGateway();
  const h = ruhig.hosts.find(x => x.id === "pmg-01");
  assert.equal(h.virus, 3);
  assert.notEqual(h.status, "crit");
  assert.notEqual(h.status, "warn");

  const befallen = await zustandMitGateway({ virusAus: 2 });
  const b = befallen.hosts.find(x => x.id === "pmg-01");
  assert.equal(b.status, "crit");
  assert.match(b.note, /eigenen Netz/);

  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(befallen);
  ui.state.view = "mail";
  ui.render();
  assert.match(ziele.get("#wrap").innerHTML, /Viren ausgehend/);
});

test("Ohne hinterlegtes Konto steht in der Mail-Ansicht, was fehlt", async () => {
  const zustand = await zustandMitGateway();
  const h = zustand.hosts.find(x => x.id === "pmg-01");
  for (const k of ["in24", "out24", "spam", "virus", "queueDeferred", "queueAktiv", "queueHold",
                   "quarSpam", "quarVirus", "signaturAlter", "updates", "cpu", "ram", "disk"]) h[k] = null;
  h.warteschlange = null; h.dienste = null; h.signaturen = null; h.domains = null; h.viren = null;
  h.note = null;
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "mail";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  assert.match(html, /kennt keine API-Token/, "der häufigste Irrtum gehört genau hierhin");
  assert.match(html, /Auditor/);
  assert.ok(!/undefined|NaN/.test(html));
});

/* ============================================================
   Mailcow in der Oberfläche
   ============================================================ */

async function zustandMitMailcow(fakeOpt = {}) {
  const { fakeMailcow, listen: hoere, KEY } = await import("./fake-mailcow.js");
  const srv = fakeMailcow(fakeOpt);
  const url = await hoere(srv);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-mailcow-"));
  try {
    fs.writeFileSync(path.join(dir, "inventory.yaml"), `
settings: { interval: 3600, icmp: false, timeout: 2, mailcow_takt: 0, mailcow_takt_lang: 0 }
sites: [ { id: hq, name: Hauptstandort, short: DEKO, primary: true } ]
hosts:
  - { id: mailcow-01, type: mailcow, site: hq, url: "${url}", role: Mailserver }
tunnels: []
links: []
`);
    fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ "mailcow-01": { apiKey: KEY } }));
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
    await new Promise(r => srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Mailcow zeigt Container, Warteschlange mit Grund, Postfächer und Platz", async () => {
  const zustand = await zustandMitMailcow();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "mail";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.ok(!/undefined|NaN|\[object Object\]/.test(html), "Platzhalterwert in der Mail-Ansicht");
  assert.match(html, /2026-03a/, "die Fassung");
  assert.match(html, /postfix-mailcow/, "die Container einzeln");
  assert.match(html, /Connection timed out/, "warum eine Mail liegt — die Zeile, wegen der man nachsieht");
  assert.match(html, /example\.de/, "Domänen mit Postfächern");
  assert.match(html, /Postfachablage/, "der Platz, ohne den Dovecot nichts mehr annimmt");
  assert.match(html, /seit dem Start von rspamd/, "die Filterzahlen ohne ihren Zeitraum wären eine Behauptung");

  /* Und dieselben Zahlen auf der Detailseite. */
  ui.openSystem("mailcow-01");
  ui.state.detail.busy = false;
  ui.state.detail.daten = null;
  ui.render();
  const seite = ziele.get("#wrap").innerHTML;
  assert.match(seite, /Mailcow im Einzelnen/);
  assert.match(seite, /Warum es liegt/);
  assert.ok(!/undefined|NaN/.test(seite));
});

test("Ein stehender Kern-Container färbt die Ampel rot, ein abgeschalteter Zusatz nur gelb", async () => {
  const kaputt = await zustandMitMailcow({ containerAus: ["dovecot-mailcow"] });
  const h = kaputt.hosts.find(x => x.id === "mailcow-01");
  assert.equal(h.status, "crit");
  assert.match(h.note, /dovecot-mailcow/);

  const zusatz = await zustandMitMailcow({ containerAus: ["clamd-mailcow"] });
  assert.equal(zusatz.hosts[0].status, "warn");

  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(kaputt);
  ui.state.view = "mail";
  ui.render();
  assert.match(ziele.get("#wrap").innerHTML, /Kern-Container stehen/);
});

/* Betreffzeilen fremder Post haben in einer Überwachung nichts zu
   suchen — und was nicht in den Zustand kommt, kann auch nicht in der
   Oberfläche landen. */
test("Aus der Quarantäne kommt die Zahl, nicht der Inhalt", async () => {
  const zustand = await zustandMitMailcow();
  const roh = JSON.stringify(zustand);
  assert.ok(!roh.includes("Ihre Rechnung"));
  assert.ok(!roh.includes("spam@example.invalid"));
  assert.equal(zustand.hosts[0].quarantaene, 3);
});

test("Ohne hinterlegten Schlüssel steht in der Mail-Ansicht, was fehlt", async () => {
  const zustand = await zustandMitMailcow();
  const h = zustand.hosts.find(x => x.id === "mailcow-01");
  for (const k of ["containerGesamt", "containerLaufen", "queueDeferred", "queueAktiv", "queueHold",
                   "vmailPct", "cpu", "ram", "disk", "quarantaene", "geprueft", "postfaecher"]) h[k] = null;
  h.containerListe = null; h.warteschlange = null; h.domains = null; h.mailboxen = null;
  h.kernSteht = null; h.nebenSteht = null; h.note = null;
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "mail";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  assert.match(html, /allow from/, "der häufigste Irrtum gehört genau hierhin");
  assert.match(html, /Read-Only/);
  assert.ok(!/undefined|NaN/.test(html));
});

/* ============================================================
   Prüfungen anhaken

   Der Fall, für den es gebaut ist: ein Gerät, das nur ICMP und SSH
   kann. Ohne eigene Liste bekommt es tcp/443 und ein Zertifikat
   angedichtet und leuchtet für immer gelb.
   ============================================================ */

async function zustandMitGeraeten() {
  return echterZustand(`
settings: { icmp: false, timeout: 1 }
sites: [ { id: hq, name: Hauptstandort, short: DEKO, primary: true } ]
hosts:
  - { id: switch-01, type: other, site: hq, ip: 10.255.255.9,
      checks: [ { kind: icmp }, { kind: tcp, port: 22 } ] }
  - { id: nas-01, type: other, site: hq, ip: 10.255.255.8,
      checks: [ { kind: icmp }, { kind: tcp, port: 443 },
                { kind: tls, port: 443, servername: "nas.example.org" } ] }
tunnels: []
links: []
`);
}

/* Damit das Formular den Rohbestand sieht wie im Betrieb — die Ansicht
   führt Prüfungen als Ergebnisse, nicht als Konfiguration. */
async function mitRohbestand(ui, zustand) {
  const { normalizeHost, eigeneChecks } = await import("../src/inventory.js");
  ui.state.rawHosts = zustand.hosts.map(h => {
    const roh = normalizeHost({
      id: h.id, type: h.type, site: h.site, ip: h.ip, url: h.url,
      checks: h.checks.map(c => (c.port ? { kind: c.kind, port: c.port } : { kind: c.kind }))
    });
    return { ...roh, checksEigen: eigeneChecks(roh) };
  });
}

/* Aus der VM kommen Objekte mit fremdem Prototyp — `assert/strict`
   vergleicht ihn mit. Über JSON bleibt der Inhalt und die Herkunft geht
   verloren; denselben Kniff braucht schon der Typvergleich weiter oben. */
function nutzlast(sandbox) {
  return JSON.parse(JSON.stringify(vm.runInContext("formPayload()", sandbox)));
}

test("Ein Gerät, das nur ICMP und SSH kann, lässt sich genau so anhaken", async () => {
  const zustand = await zustandMitGeraeten();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  await mitRohbestand(ui, zustand);

  vm.runInContext(`openForm("hosts","edit","switch-01")`, sandbox);
  const f = ui.state.form;
  assert.equal(f.data.checksEigen, true, "die Liste steht so in der Datei");
  assert.deepEqual([...f.data.pruef], ["icmp:", "tcp:22"]);

  ui.render();
  const html = ziele.get("#overlays").innerHTML;
  assert.match(html, /Prüfungen selbst festlegen/);
  assert.match(html, /SSH · 22/);
  assert.match(html, /RDP · 3389/, "auch das Nichtangehakte steht zur Wahl");
  assert.ok(!/undefined|NaN/.test(html));

  /* Und was daraus wieder in den Bestand ginge, ist genau das, was
     dastand — eine Liste, die beim Anzeigen etwas hinzuerfindet, schreibt
     es beim nächsten Speichern fest. */
  const payload = nutzlast(sandbox);
  assert.deepEqual(payload.checks, [{ kind: "icmp" }, { kind: "tcp", port: 22 }]);
});

test("Anhaken und Abwählen ändert genau eine Prüfung", async () => {
  const zustand = await zustandMitGeraeten();
  const { sandbox } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  await mitRohbestand(ui, zustand);
  vm.runInContext(`openForm("hosts","edit","switch-01")`, sandbox);

  const um = id => {
    const liste = new Set(ui.state.form.data.pruef);
    if (liste.has(id)) liste.delete(id); else liste.add(id);
    ui.state.form.data.pruef = [...liste];
  };
  um("tcp:443");
  assert.deepEqual(nutzlast(sandbox).checks,
    [{ kind: "icmp" }, { kind: "tcp", port: 443 }, { kind: "tcp", port: 22 }],
    "in der Reihenfolge der Liste, nicht in der des Klickens");
  um("icmp:");
  assert.deepEqual(nutzlast(sandbox).checks,
    [{ kind: "tcp", port: 443 }, { kind: "tcp", port: 22 }]);
});

/* Eine Prüfung, die mehr trägt als Art und Port, passt in kein Kästchen.
   Sie darf davon aber nicht verschwinden — beim nächsten Speichern wäre
   sonst der eigene `servername` weg, und das Zertifikat würde gegen die
   IP geprüft statt gegen den Namen. */
test("Was in kein Kästchen passt, bleibt trotzdem stehen", async () => {
  const zustand = await zustandMitGeraeten();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  await mitRohbestand(ui, zustand);

  /* Der Rohbestand dieses Tests trägt den servername mit. */
  const nas = ui.state.rawHosts.find(h => h.id === "nas-01");
  nas.checks = [{ kind: "icmp" }, { kind: "tcp", port: 443 },
    { kind: "tls", port: 443, servername: "nas.example.org" }];
  nas.checksEigen = true;

  vm.runInContext(`openForm("hosts","edit","nas-01")`, sandbox);
  const f = ui.state.form;
  assert.deepEqual(JSON.parse(JSON.stringify(f.data.pruefRest)), [{ kind: "tls", port: 443, servername: "nas.example.org" }]);
  ui.render();
  assert.match(ziele.get("#overlays").innerHTML, /nas\.example\.org/);
  assert.deepEqual(nutzlast(sandbox).checks[2],
    { kind: "tls", port: 443, servername: "nas.example.org" });
});

test("Freie Ports kommen als TCP-Prüfung dazu, doppelte nur einmal", async () => {
  const zustand = await zustandMitGeraeten();
  const { sandbox } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  await mitRohbestand(ui, zustand);
  vm.runInContext(`openForm("hosts","edit","switch-01")`, sandbox);
  ui.state.form.data.pruefPorts = "32400, 8123, 22, Unfug";
  const checks = nutzlast(sandbox).checks;
  assert.deepEqual(checks, [
    { kind: "icmp" }, { kind: "tcp", port: 22 },
    { kind: "tcp", port: 32400 }, { kind: "tcp", port: 8123 }
  ], "22 steht schon in der Liste, „Unfug“ ist kein Port");
});

/* Ohne eigene Liste darf das Formular nichts festschreiben: sonst fröre
   das erste Speichern die abgeleiteten Prüfungen ein, und eine spätere
   Änderung am Typ erreichte dieses System nie mehr. */
test("Ohne eigene Liste geht eine leere hinaus — das heißt „wieder ableiten“", async () => {
  const zustand = await zustandMitGeraeten();
  const { sandbox } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  await mitRohbestand(ui, zustand);
  vm.runInContext(`openForm("hosts","edit","switch-01")`, sandbox);
  ui.state.form.data.checksEigen = false;
  assert.deepEqual(nutzlast(sandbox).checks, []);
});

/* ============================================================
   Die WAN-Adresse in der Oberfläche
   ============================================================ */

test("Die gelesene WAN-Adresse steht am Standort, und eine Abweichung fällt auf", async () => {
  const zustand = await echterZustand();
  Object.assign(zustand.sites[0], {
    wan: "203.0.113.9", wanIst: "203.0.113.17", wan6Ist: "2001:db8::17",
    wanQuelle: "fw-01", wanIface: "wan", wanPrivat: false, wanAliase: 2
  });
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);

  ui.state.view = "lage";
  ui.render();
  const lage = ziele.get("#wrap").innerHTML;
  assert.match(lage, /203\.0\.113\.17/, "gezeigt wird das Gemessene");
  assert.ok(!/undefined|NaN/.test(lage));

  ui.state.inspector = { kind: "site", id: zustand.sites[0].id };
  ui.render();
  const insp = ziele.get("#overlays").innerHTML;
  assert.match(insp, /203\.0\.113\.17/);
  assert.match(insp, /eingetragen steht 203\.0\.113\.9/, "die Abweichung gehört benannt");
  assert.match(insp, /gelesen von fw-01/);
  assert.match(insp, /\+2 Alias/);
});

test("Ohne gelesene Adresse steht da, dass sie nur eingetragen ist", async () => {
  const zustand = await echterZustand();
  Object.assign(zustand.sites[0], { wan: "203.0.113.9" });
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.inspector = { kind: "site", id: zustand.sites[0].id };
  ui.render();
  assert.match(ziele.get("#overlays").innerHTML, /eingetragen, nicht gelesen/);
});

/* Eine private Adresse am WAN sagt: die Firewall hängt hinter einem
   Modem-Router. Wer das übersieht, sucht den Standort im Internet unter
   einer Adresse, unter der er nie zu finden war. */
test("Eine private WAN-Adresse wird als solche gekennzeichnet", async () => {
  const zustand = await echterZustand();
  Object.assign(zustand.sites[0], { wanIst: "192.168.100.2", wanQuelle: "fw-01", wanPrivat: true });
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.inspector = { kind: "site", id: zustand.sites[0].id };
  ui.render();
  assert.match(ziele.get("#overlays").innerHTML, /privat/);
});

test("Auf der Seite der Firewall steht jeder Anschluss mit seinen Adressen", async () => {
  const zustand = await echterZustand();
  const fw = zustand.hosts.find(h => h.type === "opnsense");
  Object.assign(fw, {
    version: "26.1", ram: 41, disk: 22,
    wan: "203.0.113.17", wanPraefix: 29, wanIface: "wan", wanAliase: 2, wanPrivat: false,
    uplinks: [{
      name: "wan", geraet: "vtnet1", beschreibung: "Uplink Glasfaser", zustand: "up", art: "dhcp",
      gateways: ["WAN_GW"],
      ipv4: { ip: "203.0.113.17", praefix: 29, privat: false },
      ipv6: { ip: "2001:db8::17", praefix: 64, privat: false },
      aliase: [
        { ip: "203.0.113.18", praefix: 29, privat: false },
        { ip: "203.0.113.19", praefix: 29, privat: false, vhid: "10", carp: "master" }
      ]
    }]
  });
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.openSystem(fw.id);
  ui.state.detail.busy = false;
  ui.state.detail.daten = null;
  ui.render();
  const seite = ziele.get("#wrap").innerHTML;
  assert.match(seite, /Uplink Glasfaser/);
  assert.match(seite, /203\.0\.113\.18/, "der Alias gehört sichtbar dazu");
  assert.match(seite, /CARP 10/, "eine geteilte Adresse ist als solche gekennzeichnet");
  assert.match(seite, /WAN_GW/);
  assert.match(seite, /Nach außen/);
  assert.ok(!/undefined|NaN/.test(seite));
});

/* ---------- UniFi ----------
   Der Weg vom Controller bis in die Tabelle, einmal ganz: echter
   Sammler gegen nachgebauten Controller, echter Zustand aus dem Dienst,
   und daraus gezeichnet. */
async function zustandMitUnifi(fakeOpt = {}) {
  const { fakeUnifi, UNIFI_USER, UNIFI_PASS } = await import("./fake-unifi.js");
  const { listen: hoere, close: schliesse } = await import("./fake-dienste.js");
  const { sitzungVergessen } = await import("../src/collectors/unifi.js");

  const uf = fakeUnifi(fakeOpt);
  const url = await hoere(uf);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-unifi-"));
  try {
    fs.writeFileSync(path.join(dir, "inventory.yaml"), `
settings: { interval: 3600, icmp: false, timeout: 2, wlan_kanal_warn: 80 }
sites: [ { id: hq, name: Hauptstandort, short: DEKO, primary: true } ]
hosts:
  - { id: unifi-01, type: unifi, site: hq, url: "${url}", role: WLAN }
tunnels: []
links: []
`);
    fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({
      "unifi-01": { user: UNIFI_USER, password: UNIFI_PASS }
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
    sitzungVergessen();
    await schliesse(uf);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Die Netzansicht zeigt jeden Access Point mit Zustand, Funk und Uplink", async () => {
  const zustand = await zustandMitUnifi();
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "netz";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.ok(!/undefined|NaN|\[object Object\]/.test(html), "Platzhalterwert in der Netzansicht");
  assert.match(html, /ap-wohnzimmer/);
  assert.match(html, /ap-keller/);
  assert.match(html, /U6LR/, "das Modell gehört unter den Namen");
  assert.match(html, /2,4 GHz · K6/, "Band und Kanal je Funkmodul");
  assert.match(html, /62 %/, "die Kanalbelegung");
  assert.match(html, /sw-keller/, "der Switch, an dem die APs hängen");
  assert.match(html, /23 Clients/);
});

test("Ein getrennter Access Point steht rot in der Zeile, während das System gelb ist", async () => {
  const zustand = await zustandMitUnifi({ zustaende: [1, 0, 1] });
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "netz";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.match(html, /data-sev="crit"[^>]*>[\s\S]{0,400}ap-buero/, "die Zeile des Geräts trägt seine eigene Ampel");
  assert.equal(zustand.hosts[0].status, "warn", "das System selbst bleibt gelb — es läuft ja");
  assert.match(html, /meldet sich nicht mehr/);
});

/* Ein Controller ohne hinterlegten Zugang. Er steht in der Tafel, und
   dort steht auch, warum sie leer ist — eine leere Tabelle allein sähe
   aus wie „kein Access Point vorhanden". */
test("Ohne Zugang sagt die WLAN-Tafel, was fehlt — statt einer leeren Tabelle", async () => {
  const zustand = await echterZustand(`
settings: { icmp: false, timeout: 1 }
sites: [ { id: hq, name: Zuhause, short: DEKO, primary: true } ]
hosts:
  - { id: unifi-01, type: unifi, site: hq, url: "https://10.0.0.9", role: WLAN }
tunnels: []
links: []
`);
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.state.view = "netz";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;
  assert.match(html, /WLAN/);
  assert.match(html, /fehlen die Zugangsdaten/);
  assert.match(html, /Verwaltung → unifi-01/, "und wo man ihn hinterlegt");
});

test("Die Systemseite des Controllers zeigt Kanalbelegung und Isolation", async () => {
  const zustand = await zustandMitUnifi({ zustaende: [1, 11, 1] });
  const { sandbox, ziele } = ladeUi();
  const ui = sandbox.window.LeitstandUI;
  ui.applyLive(zustand);
  ui.openSystem("unifi-01");
  ui.state.detail.busy = false;
  ui.state.detail.daten = null;
  ui.render();
  const seite = ziele.get("#wrap").innerHTML;

  assert.ok(!/undefined|NaN|\[object Object\]/.test(seite), "Platzhalterwert auf der Systemseite");
  assert.match(seite, /Kanalbelegung/);
  assert.match(seite, /Uplink verloren, funkt weiter/);
  assert.match(seite, /2 von 3 verbunden/);
  assert.match(seite, /Anwesenheitsprotokoll/, "warum die Clientliste fehlt, steht dabei");
});

/* ---------- Rot heißt nicht stumm ----------
   Zwei Proxmox-Knoten, deren nächtliche Sicherung fehlgeschlagen war,
   standen in der Übersicht unter „ohne Antwort" — sie antworteten die
   ganze Zeit. Die Kennzahl las die Ampel statt der Messung. */
async function mitBefund() {
  const zustand = await echterZustand();
  for (const h of zustand.hosts) {
    h.reachable = true;
    h.status = h.id === "web" ? "crit" : "ok";
    h.note = h.id === "web" ? "1 fehlgeschlagene Aufgabe(n) in 24 h" : null;
  }
  for (const s of zustand.sites) { s.down = false; s.silent = 0; }
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  return { sandbox, ziele };
}

test("Ein erreichbarer Knoten mit Befund zählt nicht als „ohne Antwort“", async () => {
  const { sandbox, ziele } = await mitBefund();
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "lage";
  ui.render();
  const html = ziele.get("#wrap").innerHTML;

  assert.ok(!/ohne Antwort/.test(html), "es antwortet ja jeder");
  assert.match(html, /100 %/, "die Erreichbarkeit ist vollständig");
  assert.match(html, /mit Befund/, "die Störung wird trotzdem genannt");
});

test("Die Kopfleiste zählt antwortende Systeme, nicht grüne", async () => {
  const { sandbox, ziele } = await mitBefund();
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "lage";                 /* die Kurzlage zeigt keine Kopfleiste */
  ui.render();
  assert.match(ziele.get("#top").innerHTML, /Systeme<\/span><b>2\/2</,
    "beide überwachten Systeme antworten");
});

/* Die Kurzlage ist die Ansicht fürs Telefon, und unter ihrer Zahl steht
   ausdrücklich „antworten". Dann muss auch das gezählt werden. */
test("Auch die Kurzlage zählt Antworten, nicht Ampeln", async () => {
  const { sandbox, ziele } = await mitBefund();
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "kurz";
  ui.render();
  assert.match(ziele.get("#wrap").innerHTML,
    /kurz-kachel-k">Systeme<\/span>\s*<b>2\/2<\/b>\s*<span class="kurz-kachel-s">antworten/);
});

test("Ein wirklich stilles System steht weiterhin ohne Antwort da", async () => {
  const zustand = await echterZustand();
  const { sandbox, ziele } = ladeUi();
  sandbox.window.LeitstandUI.applyLive(zustand);
  const ui = sandbox.window.LeitstandUI;
  ui.state.view = "lage";
  ui.render();
  /* Der Bestand zeigt auf unerreichbare Adressen — genau darum geht es. */
  assert.match(ziele.get("#wrap").innerHTML, /ohne Antwort/);
});
