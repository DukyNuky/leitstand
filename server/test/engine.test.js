import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import * as Inv from "../src/inventory.js";
import { Engine, findePeer, frischerPeer, peerAbstand, tlsBewerten } from "../src/engine.js";

/* Ein echter, offener Port als Prüfziel — keine Attrappe der Prüfung selbst. */
function openPort() {
  return new Promise(r => {
    const s = net.createServer(c => c.end());
    s.listen(0, "127.0.0.1", () => r({ port: s.address().port, close: () => new Promise(x => s.close(x)) }));
  });
}

function inventoryFor(port) {
  return Inv.normalize({
    settings: { interval: 60, timeout: 1, fail_threshold: 3, icmp: false, history: 10 },
    sites: [{ id: "hq", name: "HQ" }],
    hosts: [{ id: "ziel", type: "other", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port }] }],
    tunnels: [], links: []
  });
}

test("Offener Port ergibt Grün mit Messwert", async () => {
  const p = await openPort();
  const e = new Engine(inventoryFor(p.port));
  await e.runOnce();
  const st = e.hosts.get("ziel");
  assert.equal(st.status, "ok");
  assert.ok(st.ms >= 0);
  assert.equal(st.hist.length, 1, "Verlauf wächst mit jedem Durchlauf");
  assert.equal(e.incidents.size, 0);
  await p.close();
});

test("Ausfall geht erst nach der eingestellten Anzahl auf Rot", async () => {
  const p = await openPort();
  const e = new Engine(inventoryFor(p.port));
  await e.runOnce();
  await p.close();

  await e.runOnce();
  assert.equal(e.hosts.get("ziel").status, "warn", "erster Fehlschlag ist noch keine Störung");
  assert.equal([...e.incidents.values()][0].sev, "warn");

  await e.runOnce();
  assert.equal(e.hosts.get("ziel").status, "warn");

  await e.runOnce();
  assert.equal(e.hosts.get("ziel").status, "crit", "ab dem dritten Fehlschlag");
  const inc = [...e.incidents.values()][0];
  assert.equal(inc.sev, "crit");
  assert.equal(inc.count, 3, "dieselbe Ursache bleibt eine Störung");
  assert.match(inc.title, /nicht erreichbar/);
});

test("Eskalation hebt eine Quittierung wieder auf", async () => {
  const p = await openPort();
  const e = new Engine(inventoryFor(p.port));
  await e.runOnce();
  await p.close();
  await e.runOnce();
  const inc = [...e.incidents.values()][0];
  e.ack(inc.id, true);
  assert.equal(inc.ack, true);
  await e.runOnce();
  await e.runOnce();                      /* jetzt kritisch */
  assert.equal(inc.sev, "crit");
  assert.equal(inc.ack, false, "was schlimmer wird, muss erneut gesehen werden");
});

test("Erholung schließt die Störung", async () => {
  const p = await openPort();
  const inv = inventoryFor(p.port);
  const e = new Engine(inv);
  await p.close();
  await e.runOnce();
  assert.equal(e.incidents.size, 1);

  const p2 = await new Promise(r => {
    const s = net.createServer(c => c.end());
    s.listen(p.port, "127.0.0.1", () => r({ close: () => new Promise(x => s.close(x)) }));
  });
  try {
    await e.runOnce();
    assert.equal(e.hosts.get("ziel").status, "ok");
    assert.equal(e.incidents.size, 0, "geschlossen, nicht bloß auf grün gesetzt");
  } finally { await p2.close(); }
});

test("Unüberwachte Systeme bleiben grau und erzeugen nichts", async () => {
  const inv = Inv.normalize({
    settings: { icmp: false, timeout: 1 },
    sites: [{ id: "hq", name: "HQ" }],
    hosts: [{ id: "labor", type: "other", site: "hq", ip: "10.255.255.1", monitor: false }],
    tunnels: [], links: []
  });
  const e = new Engine(inv);
  await e.runOnce();
  assert.equal(e.hosts.get("labor").status, "idle");
  assert.equal(e.incidents.size, 0);
});

test("Tunnel wird durch den Tunnel gemessen", async () => {
  const p = await openPort();
  const inv = Inv.normalize({
    settings: { icmp: false, timeout: 1, fail_threshold: 2 },
    sites: [{ id: "hq", name: "HQ" }, { id: "rz", name: "RZ" }],
    hosts: [], links: [],
    tunnels: [{ id: "wg-hq-rz", a: "hq", b: "rz", iface: "wg0", net: "10.99.0.0/30", probe: { ip: "127.0.0.1", port: p.port } }]
  });
  const e = new Engine(inv);
  await e.runOnce();
  assert.equal(e.tunnels.get("wg-hq-rz").status, "ok");

  await p.close();
  await e.runOnce(); await e.runOnce();
  assert.equal(e.tunnels.get("wg-hq-rz").status, "crit");
  const inc = [...e.incidents.values()][0];
  assert.equal(inc.kind, "tunnel");
  assert.match(inc.title, /trägt nicht/);
});

test("Bestand lässt sich tauschen, ohne den Verlauf zu verlieren", async () => {
  const p = await openPort();
  const e = new Engine(inventoryFor(p.port));
  await e.runOnce();
  await e.runOnce();
  const vorher = e.hosts.get("ziel").hist.length;
  assert.equal(vorher, 2);

  const erweitert = Inv.normalize({
    settings: { interval: 60, timeout: 1, icmp: false },
    sites: [{ id: "hq", name: "HQ" }],
    hosts: [
      { id: "ziel", type: "other", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port: p.port }] },
      { id: "neu",  type: "other", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port: p.port }] }
    ],
    tunnels: [], links: []
  });
  e.reload(erweitert);
  assert.equal(e.hosts.get("ziel").hist.length, vorher, "bestehender Verlauf bleibt");
  assert.equal(e.hosts.get("neu").status, "unknown", "neues System startet leer");
  await p.close();
});

test("Der Sammler darf den Kern nicht umwerfen", async () => {
  const p = await openPort();
  const e = new Engine(inventoryFor(p.port), {
    collectors: { other: async () => { throw new Error("API kaputt"); } }
  });
  try {
    await e.runOnce();
    const st = e.hosts.get("ziel");
    assert.equal(st.reachable, true, "die Erreichbarkeit wird unabhängig vom Sammler gemessen");
    assert.equal(st.checks.find(c => c.kind === "tcp").ok, true);
    assert.match(st.extra.error, /API kaputt/);
    assert.equal(st.status, "warn", "sichtbar, aber kein Ausfall — der Host antwortet ja");
    assert.match(st.note, /Abruf nicht möglich/);
  } finally { await p.close(); }
});

test("Ein Sammler darf die Ampel verschärfen", async () => {
  const p = await openPort();
  const e = new Engine(inventoryFor(p.port), {
    collectors: { other: async () => ({ status: "crit", note: "Speicher zu 95 % belegt", cpu: 12 }) }
  });
  await e.runOnce();
  assert.equal(e.hosts.get("ziel").status, "crit");
  assert.match(e.hosts.get("ziel").note, /95 %/);
  await p.close();
});

test("Wechselt die Ursache, bleibt keine verwaiste Störung zurück", async () => {
  const p = await openPort();
  const inv = inventoryFor(p.port);
  inv.settings.slow_ms = -1;                 /* jede Antwort gilt jetzt als zu langsam */
  const e = new Engine(inv);
  await p.close();
  await e.runOnce();                          /* nicht erreichbar */
  assert.equal([...e.incidents.values()][0].rule, "host.unreachable");

  const p2 = await new Promise(r => {
    const s = net.createServer(c => c.end());
    s.listen(p.port, "127.0.0.1", () => r({ close: () => new Promise(x => s.close(x)) }));
  });
  try {
    await e.runOnce();                        /* erreichbar, aber "langsam" */
    assert.equal(e.incidents.size, 1, "genau eine Störung, nicht zwei");
    assert.equal([...e.incidents.values()][0].rule, "host.degraded");
  } finally { await p2.close(); }
});

test("Ein stiller Standort ergibt eine Meldung, nicht zwölf", async () => {
  const p = await openPort();
  const inv = Inv.normalize({
    settings: { icmp: false, timeout: 1, fail_threshold: 1 },
    sites: [{ id: "hq", name: "HQ" }, { id: "fh", name: "Ferienhaus" }],
    hosts: [
      { id: "hq-1", type: "other", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port: p.port }] },
      { id: "fh-1", type: "other", site: "fh", ip: "127.0.0.1", checks: [{ kind: "tcp", port: 9 }] },
      { id: "fh-2", type: "other", site: "fh", ip: "127.0.0.1", checks: [{ kind: "tcp", port: 9 }] },
      { id: "fh-3", type: "other", site: "fh", ip: "127.0.0.1", checks: [{ kind: "tcp", port: 9 }] }
    ],
    tunnels: [{ id: "wg-hq-fh", a: "hq", b: "fh", iface: "wg0", net: "10.99.0.0/30", probe: { ip: "127.0.0.1", port: 9 } }],
    links: []
  });
  const e = new Engine(inv);
  await e.runOnce();

  const sichtbar = [...e.incidents.values()].filter(i => !i.suppressedBy);
  assert.equal(sichtbar.length, 1, "genau eine sichtbare Meldung");
  const s = sichtbar[0];
  assert.equal(s.kind, "site");
  assert.match(s.title, /Standort Ferienhaus nicht erreichbar/);
  assert.equal(s.affected.length, 4, "drei Systeme und ein Tunnel hängen daran");
  assert.match(s.note, /vermutlich die Anbindung, nicht die Geräte/);

  assert.equal(e.hosts.get("hq-1").status, "ok", "der gesunde Standort bleibt unberührt");
  await p.close();
});

test("Kommt der Standort zurück, löst sich die Bündelung auf", async () => {
  const inv = Inv.normalize({
    settings: { icmp: false, timeout: 1, fail_threshold: 1 },
    sites: [{ id: "fh", name: "Ferienhaus" }],
    hosts: [
      { id: "fh-1", type: "other", site: "fh", ip: "127.0.0.1", checks: [{ kind: "tcp", port: 9 }] },
      { id: "fh-2", type: "other", site: "fh", ip: "127.0.0.1", checks: [{ kind: "tcp", port: 9 }] }
    ],
    tunnels: [], links: []
  });
  const e = new Engine(inv);
  await e.runOnce();
  assert.ok([...e.incidents.values()].some(i => i.kind === "site"));

  const p = await openPort();
  try {
    for (const h of inv.hosts) h.checks = [{ kind: "tcp", port: p.port }];
    e.reload(inv);
    await e.runOnce();
    assert.equal(e.incidents.size, 0, "alles zu, nichts bleibt hängen");
  } finally { await p.close(); }
});

test("Ein einzelnes stilles System an einem gesunden Standort wird nicht gebündelt", async () => {
  const p = await openPort();
  const inv = Inv.normalize({
    settings: { icmp: false, timeout: 1, fail_threshold: 1 },
    sites: [{ id: "hq", name: "HQ" }],
    hosts: [
      { id: "gut", type: "other", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port: p.port }] },
      { id: "still", type: "other", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port: 9 }] }
    ],
    tunnels: [], links: []
  });
  const e = new Engine(inv);
  await e.runOnce();
  const sichtbar = [...e.incidents.values()].filter(i => !i.suppressedBy);
  assert.equal(sichtbar.length, 1);
  assert.equal(sichtbar[0].host, "still", "das einzelne System, kein Standortalarm");
  assert.notEqual(sichtbar[0].kind, "site");
  await p.close();
});

test("Erreichbar, aber Abruf scheitert — das darf nicht grün bleiben", async () => {
  const p = await openPort();
  const e = new Engine(inventoryFor(p.port), {
    collectors: { other: async () => ({ error: "403 — Token fehlen Rechte" }) }
  });
  await e.runOnce();
  const st = e.hosts.get("ziel");
  assert.equal(st.status, "warn");
  assert.match(st.note, /Abruf nicht möglich.*403/);
  await p.close();
});

/* ============================================================
   Tunnel ↔ WireGuard-Peer

   Die Firewall meldet Peers, der Bestand benennt einen davon. Was hier
   schiefgehen kann, ist nicht die Zuordnung an sich, sondern ihre
   Nachlässigkeit: der falsche Peer, ein Peer aus der Vorrunde, oder eine
   Ampel, die aus einer Verknüpfung mehr macht, als sie hergibt.
   ============================================================ */

/* Ein Bestand mit Firewall und Strecke; `peers` ist, was der Sammler meldet. */
function mitPeer({ peer, probe, peers, timeoutPort }) {
  return Inv.normalize({
    settings: { icmp: false, timeout: 1, fail_threshold: 2, history: 10 },
    sites: [{ id: "hq", name: "HQ" }, { id: "rz", name: "RZ" }],
    hosts: [{ id: "fw", type: "opnsense", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port: timeoutPort }] }],
    links: [],
    tunnels: [{ id: "wg", a: "hq", b: "rz", iface: "wg0", ...(probe ? { probe } : {}), ...(peer ? { peer } : {}) }]
  });
}

const PEERLISTE = [
  { name: "WG-Schweiz", key: "AqujlFK4", iface: "wg0", handshake: 80, rx: 1157470889, tx: 4185660632, endpoint: "178.39.98.174:8909", allowed: "0.0.0.0/0" },
  { name: "laptop", key: "BbcdEfGh", iface: "wg1", handshake: null, rx: 0, tx: 0, endpoint: null, allowed: "10.99.0.2/32" }
];

test("Der verknüpfte Peer landet am Tunnel, samt Handshake und Mengen", async () => {
  const p = await openPort();
  const e = new Engine(
    mitPeer({ peer: { host: "fw", name: "WG-Schweiz", key: "AqujlFK4" }, probe: { ip: "127.0.0.1", port: p.port }, timeoutPort: p.port }),
    { collectors: { opnsense: async () => ({ peers: PEERLISTE }) } });
  await e.runOnce();

  const st = e.tunnels.get("wg");
  assert.equal(st.status, "ok", "gemessen wird weiterhin durch den Tunnel");
  assert.equal(st.peer.name, "WG-Schweiz");
  assert.equal(st.peer.handshake, 80);
  assert.equal(st.peer.rx, 1157470889);
  assert.equal(st.peerNote, null);
  await p.close();
});

/* Der Handshake steht in den Daten der Firewall, und die werden im selben
   Durchlauf erst geholt. Würde er während der Tunnelprüfung gelesen, wäre
   er stets eine Runde alt — beim ersten Durchlauf also gar nicht da. */
test("Der Handshake ist schon im ersten Durchlauf da, nicht erst im zweiten", async () => {
  const p = await openPort();
  const e = new Engine(
    mitPeer({ peer: { host: "fw", key: "AqujlFK4" }, probe: { ip: "127.0.0.1", port: p.port }, timeoutPort: p.port }),
    { collectors: { opnsense: async () => ({ peers: PEERLISTE }) } });
  await e.runOnce();
  assert.equal(e.tunnels.get("wg").peer?.handshake, 80);
  await p.close();
});

test("Ohne Gegenstelle im Transfernetz entsteht der Zustand aus dem Handshake", async () => {
  const p = await openPort();
  let alter = 80;
  const e = new Engine(
    mitPeer({ peer: { host: "fw", key: "AqujlFK4" }, timeoutPort: p.port }),
    { collectors: { opnsense: async () => ({ peers: [{ ...PEERLISTE[0], handshake: alter }] }) } });

  await e.runOnce();
  assert.equal(e.tunnels.get("wg").status, "ok");
  assert.equal(e.tunnels.get("wg").rtt, undefined, "ohne Messung gibt es keine Latenz");
  assert.equal(e.incidents.size, 0);

  alter = 400;
  await e.runOnce();
  assert.equal(e.tunnels.get("wg").status, "warn");

  alter = 4000;
  await e.runOnce();
  const st = e.tunnels.get("wg");
  assert.equal(st.status, "crit");
  assert.match(st.note, /Seit 1 h 6 min kein Handshake/);
  const inc = [...e.incidents.values()].find(i => i.kind === "tunnel");
  assert.equal(inc.rule, "tunnel.handshake");
  assert.match(inc.detail, /Durch den Tunnel wird nicht gemessen/);
  await p.close();
});

/* Ein Handshake, den es nie gab, ist kein Ausfall: die Gegenstelle hat
   sich schlicht noch nicht gemeldet. Grau, nicht rot. */
test("Ein Peer ohne jeden Handshake bleibt grau", async () => {
  const p = await openPort();
  const e = new Engine(
    mitPeer({ peer: { host: "fw", key: "BbcdEfGh" }, timeoutPort: p.port }),
    { collectors: { opnsense: async () => ({ peers: PEERLISTE }) } });
  await e.runOnce();
  assert.equal(e.tunnels.get("wg").status, "idle");
  assert.equal(e.incidents.size, 0, "„noch nie gemeldet“ ist keine Störung");
  await p.close();
});

test("Der Schlüssel sticht den Namen — eine Umbenennung bricht die Verknüpfung nicht", async () => {
  const p = await openPort();
  const e = new Engine(
    mitPeer({ peer: { host: "fw", name: "WG-Schweiz", key: "AqujlFK4" }, timeoutPort: p.port }),
    { collectors: { opnsense: async () => ({ peers: [{ ...PEERLISTE[0], name: "WG-Zuerich" }] }) } });
  await e.runOnce();
  assert.equal(e.tunnels.get("wg").peer.name, "WG-Zuerich", "gefunden wurde er über den Schlüssel");
  assert.equal(e.tunnels.get("wg").status, "ok");
  await p.close();
});

test("Einen Peer, den die Firewall nicht mehr meldet, sagt der Tunnel an", async () => {
  const p = await openPort();
  const e = new Engine(
    mitPeer({ peer: { host: "fw", name: "WG-Weg", key: "ZZZZ" }, probe: { ip: "127.0.0.1", port: p.port }, timeoutPort: p.port }),
    { collectors: { opnsense: async () => ({ peers: PEERLISTE }) } });
  await e.runOnce();
  const st = e.tunnels.get("wg");
  assert.equal(st.peer, null);
  assert.match(st.peerNote, /WG-Weg.*nicht mehr/);
  assert.equal(st.status, "ok", "die Messung durch den Tunnel bleibt davon unberührt");
  await p.close();
});

/* Lieber kein Treffer als der falsche: ein falscher Treffer meldete den
   Handshake eines fremden Geräts als den dieser Strecke. */
test("Ein mehrdeutiger Name ergibt keinen Treffer", () => {
  const doppelt = [
    { name: "WG", key: "A", iface: "wg0", handshake: 10 },
    { name: "WG", key: "B", iface: "wg1", handshake: 900 }
  ];
  assert.equal(findePeer(doppelt, { host: "fw", name: "WG" }), null);
  assert.equal(findePeer(doppelt, { host: "fw", name: "WG", iface: "wg1" })?.key, "B",
    "mit Interface ist es eindeutig");
  assert.equal(findePeer(doppelt, { host: "fw", name: "WG", key: "A" })?.key, "A");
});

/* Kommt durch den Tunnel eine Antwort, während der verknüpfte Peer seit
   zehn Minuten schweigt, trägt eine andere Strecke als die verknüpfte.
   Das ist keine Störung — aber es gehört gesagt. */
test("Widersprechen sich Messung und Handshake, gibt es eine Notiz statt einer Störung", async () => {
  const p = await openPort();
  const e = new Engine(
    mitPeer({ peer: { host: "fw", key: "AqujlFK4" }, probe: { ip: "127.0.0.1", port: p.port }, timeoutPort: p.port }),
    { collectors: { opnsense: async () => ({ peers: [{ ...PEERLISTE[0], handshake: 4000 }] }) } });
  await e.runOnce();
  const st = e.tunnels.get("wg");
  assert.equal(st.status, "ok");
  assert.match(st.note, /richtigen Peer/);
  assert.equal([...e.incidents.values()].filter(i => i.kind === "tunnel").length, 0);
  await p.close();
});

/* ---------- Kacheln der Startseite ----------
   Ein Lesezeichen ohne verknüpftes System kann trotzdem sagen, ob die
   Seite antwortet. Was es nicht darf: eine Störung erzeugen. Hinter diesen
   Kacheln stehen fremde Dienste, für die niemand nachts geweckt wird. */

function webserver(status = 200) {
  return new Promise(r => {
    const s = http.createServer((req, res) => { res.writeHead(status); res.end("ok"); });
    s.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${s.address().port}/`, close: () => new Promise(x => { s.closeAllConnections(); s.close(x); }) }));
  });
}

function mitLink(item, port) {
  return Inv.normalize({
    settings: { interval: 60, timeout: 2, fail_threshold: 2, icmp: false, link_takt: 60 },
    sites: [{ id: "hq", name: "HQ" }],
    hosts: [{ id: "ziel", type: "other", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port }] }],
    tunnels: [], links: [{ group: "Werkzeuge", items: [item] }]
  });
}

test("Eine Kachel mit „prüfen“ bekommt ihre Ampel aus dem Abruf", async () => {
  const p = await openPort();
  const web = await webserver(200);
  const e = new Engine(mitLink({ name: "Extern", url: web.url, pruefen: true }, p.port));
  await e.runOnce();

  const st = e.linkChecks.get(web.url);
  assert.equal(st.status, "ok");
  assert.ok(st.ms >= 0);
  assert.equal(e.incidents.size, 0, "eine Kachel erzeugt keine Störung");
  await web.close(); await p.close();
});

test("Antwortet die Seite nicht, wird die Kachel erst gelb, dann rot", async () => {
  const p = await openPort();
  const web = await webserver(200);
  const url = web.url;
  await web.close();                                   /* niemand hört mehr */

  const e = new Engine(mitLink({ name: "Weg", url, pruefen: true }, p.port));
  await e.runOnce();
  assert.equal(e.linkChecks.get(url).status, "warn", "ein einzelner Fehlschlag ist noch keine Aussage");
  e.linkChecks.get(url).stand = 0;                     /* den Takt vorspulen, statt eine Minute zu warten */
  await e.runOnce();
  assert.equal(e.linkChecks.get(url).status, "crit");
  assert.equal(e.incidents.size, 0, "auch rot bleibt eine Ampel, keine Störung");
  await p.close();
});

/* Ein Statuscode ist etwas anderes als keine Antwort: der Dienst steht,
   er mag den Aufruf nur nicht. Das gehört auf Gelb, nicht auf Rot. */
test("Ein Fehlercode ist gelb, kein Ausfall", async () => {
  const p = await openPort();
  const web = await webserver(503);
  const e = new Engine(mitLink({ name: "Krank", url: web.url, pruefen: true }, p.port));
  await e.runOnce();
  e.linkChecks.get(web.url).stand = 0;
  await e.runOnce();
  assert.equal(e.linkChecks.get(web.url).status, "warn");
  assert.match(e.linkChecks.get(web.url).detail, /503/);
  await web.close(); await p.close();
});

test("Ohne Häkchen wird nichts abgerufen — und ein verknüpftes System hat Vorrang", async () => {
  const p = await openPort();
  const web = await webserver(200);
  const e = new Engine(mitLink({ name: "Nur Lesezeichen", url: web.url }, p.port));
  await e.runOnce();
  assert.equal(e.linkChecks.size, 0);

  const mitSystem = new Engine(mitLink({ name: "System", host: "ziel", url: web.url, pruefen: true }, p.port));
  await mitSystem.runOnce();
  assert.equal(mitSystem.linkChecks.size, 0, "die Ampel kommt vom System, nicht aus einem zweiten Abruf");
  await web.close(); await p.close();
});

test("Der eigene Takt bremst den Abruf, ohne den Durchlauf zu bremsen", async () => {
  const p = await openPort();
  const web = await webserver(200);
  const e = new Engine(mitLink({ name: "Extern", url: web.url, pruefen: true }, p.port));
  await e.runOnce();
  const erst = e.linkChecks.get(web.url).stand;
  await e.runOnce();
  assert.equal(e.linkChecks.get(web.url).stand, erst, "innerhalb des Taktes wird nicht erneut abgerufen");
  await web.close(); await p.close();
});

/* ============================================================
   Wesentliche Prüfungen

   Eine Prüfung, die den Dienst selbst misst — die DNS-Auflösung eines
   Resolvers etwa —, ist nicht eine von mehreren. Fällt sie aus, während
   die Weboberfläche weiter antwortet, wäre „Teilausfall, gelb" die
   falsche Auskunft: aufgelöst wird im Netz gerade gar nichts.
   ============================================================ */

/* Zwei Ports: einer bleibt offen (die Oberfläche), einer geht zu (der
   Dienst). Der zweite trägt die Kennzeichnung. */
function inventoryWesentlich(offen, wesentlichPort) {
  return Inv.normalize({
    settings: { interval: 60, timeout: 1, fail_threshold: 3, icmp: false, history: 10 },
    sites: [{ id: "hq", name: "HQ" }],
    hosts: [{ id: "ziel", type: "other", site: "hq", ip: "127.0.0.1", checks: [
      { kind: "tcp", port: offen },
      { kind: "tcp", port: wesentlichPort, wesentlich: true }
    ] }],
    tunnels: [], links: []
  });
}

test("Fällt eine wesentliche Prüfung aus, ist das kein Teilausfall", async () => {
  const a = await openPort(), b = await openPort();
  const e = new Engine(inventoryWesentlich(a.port, b.port));
  await e.runOnce();
  assert.equal(e.hosts.get("ziel").status, "ok");

  await b.close();
  await e.runOnce();
  const st = e.hosts.get("ziel");
  assert.equal(st.status, "warn", "der erste Fehlschlag bleibt eine Warnung");
  assert.equal(/Teilausfall/.test(st.note), false, "„Teilausfall“ verharmlost hier");
  assert.match(st.note, /TCP\//);
  await a.close();
});

test("Bleibt sie aus, wird daraus eine Störung — nicht dauerhaft Gelb", async () => {
  const a = await openPort(), b = await openPort();
  const e = new Engine(inventoryWesentlich(a.port, b.port));
  await e.runOnce();
  await b.close();
  await e.runOnce(); await e.runOnce(); await e.runOnce();

  const st = e.hosts.get("ziel");
  assert.equal(st.status, "crit", "nach der eingestellten Zahl von Fehlschlägen");
  assert.equal(st.reachable, true, "erreichbar ist er ja — nur tut er nicht, wofür es ihn gibt");
  const inc = [...e.incidents.values()][0];
  assert.equal(inc.sev, "crit");
  assert.match(inc.rule, /^dienst\./, "eigene Regel, damit sie sich von „nicht erreichbar“ trennen lässt");
  await a.close();
});

test("Kommt sie zurück, zählt der Zähler wieder von vorn", async () => {
  const a = await openPort(), b = await openPort();
  const e = new Engine(inventoryWesentlich(a.port, b.port));
  await e.runOnce();
  await b.close();
  await e.runOnce();
  assert.equal(e.hosts.get("ziel").wfails, 1);

  /* Denselben Port wieder öffnen — der Dienst ist zurück. */
  const b2 = await new Promise(r => {
    const s = net.createServer(c => c.end());
    s.listen(b.port, "127.0.0.1", () => r({ close: () => new Promise(x => s.close(x)) }));
  });
  await e.runOnce();
  assert.equal(e.hosts.get("ziel").wfails, 0);
  assert.equal(e.hosts.get("ziel").status, "ok");
  assert.equal(e.incidents.size, 0);
  await a.close(); await b2.close();
});

/* ============================================================
   Beide Enden einer Strecke

   Ein Tunnel ist keine Einbahnstraße: an beiden Enden steht eine
   Firewall, und jede meldet die jeweils andere als Peer. Erst mit beiden
   Enden stimmt die Zuordnung in beide Richtungen — und erst dann lassen
   sich die zwei Auskünfte gegeneinander halten.
   ============================================================ */

function mitZweiEnden({ peer, peerB, probe, peersA, peersB, timeoutPort }) {
  return Inv.normalize({
    settings: { icmp: false, timeout: 1, fail_threshold: 2, history: 10 },
    sites: [{ id: "hq", name: "HQ" }, { id: "rz", name: "RZ" }],
    hosts: [
      { id: "fw-a", type: "opnsense", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port: timeoutPort }] },
      { id: "fw-b", type: "opnsense", site: "rz", ip: "127.0.0.1", checks: [{ kind: "tcp", port: timeoutPort }] }
    ],
    links: [],
    tunnels: [{ id: "wg", a: "hq", b: "rz", iface: "wg0",
      ...(probe ? { probe } : {}), ...(peer ? { peer } : {}), ...(peerB ? { peerB } : {}) }]
  });
}

const sammler = (peersA, peersB) => ({
  opnsense: async h => ({ peers: h.id === "fw-a" ? peersA : peersB })
});

test("Beide Enden werden aufgelöst und stehen am Tunnel", async () => {
  const p = await openPort();
  const e = new Engine(
    mitZweiEnden({
      peer: { host: "fw-a", key: "AqujlFK4" }, peerB: { host: "fw-b", key: "Kx7QdZZ1" },
      probe: { ip: "127.0.0.1", port: p.port }, timeoutPort: p.port
    }),
    { collectors: sammler(
      [{ name: "nach-RZ", key: "AqujlFK4", iface: "wg0", handshake: 80, allowed: "10.99.0.2/32" }],
      [{ name: "nach-HQ", key: "Kx7QdZZ1", iface: "wg0", handshake: 95, allowed: "10.99.0.1/32" }]) });
  await e.runOnce();

  const st = e.tunnels.get("wg");
  assert.equal(st.peer.name, "nach-RZ");
  assert.equal(st.peerB.name, "nach-HQ");
  assert.equal(st.peerAbstand, 15, "die beiden Auskünfte liegen 15 Sekunden auseinander");
  assert.equal(st.status, "ok");
  await p.close();
});

/* WireGuard erneuert den Handshake nur, wenn Verkehr fließt, und die
   beiden Firewalls werden zu verschiedenen Zeitpunkten abgefragt. Vom
   älteren Ende auszugehen hieße, eine tragende Strecke rot zu melden. */
test("Ohne Messung zählt das frischere der beiden Enden", async () => {
  const p = await openPort();
  const e = new Engine(
    mitZweiEnden({
      peer: { host: "fw-a", key: "AqujlFK4" }, peerB: { host: "fw-b", key: "Kx7QdZZ1" }, timeoutPort: p.port
    }),
    { collectors: sammler(
      [{ name: "nach-RZ", key: "AqujlFK4", iface: "wg0", handshake: 4000 }],
      [{ name: "nach-HQ", key: "Kx7QdZZ1", iface: "wg0", handshake: 30 }]) });
  await e.runOnce();

  assert.equal(e.tunnels.get("wg").status, "ok", "ein Ende spricht gerade — die Strecke steht");
  assert.equal(e.incidents.size, 0);
  await p.close();
});

/* Dieselbe Strecke ist sich über ihren Handshake einig. Weichen die Enden
   weit voneinander ab, zeigt eine der Verknüpfungen woandershin — das ist
   ein Hinweis, keine Störung. */
test("Widersprechen sich die beiden Enden, steht das als Notiz da", async () => {
  const p = await openPort();
  const e = new Engine(
    mitZweiEnden({
      peer: { host: "fw-a", key: "AqujlFK4" }, peerB: { host: "fw-b", key: "Kx7QdZZ1" },
      probe: { ip: "127.0.0.1", port: p.port }, timeoutPort: p.port
    }),
    { collectors: sammler(
      [{ name: "nach-RZ", key: "AqujlFK4", iface: "wg0", handshake: 20 }],
      [{ name: "nach-HQ", key: "Kx7QdZZ1", iface: "wg0", handshake: 4000 }]) });
  await e.runOnce();

  const st = e.tunnels.get("wg");
  assert.equal(st.status, "ok");
  assert.match(st.note, /widersprechen/);
  assert.equal(e.incidents.size, 0, "eine Notiz, keine Meldung");
  await p.close();
});

test("Von zwei Enden gewinnt das frischere, und „nie“ verliert immer", () => {
  const a = { name: "a", handshake: 400 }, b = { name: "b", handshake: 30 };
  const nie = { name: "c", handshake: null };
  assert.equal(frischerPeer(a, b).name, "b");
  assert.equal(frischerPeer(b, a).name, "b");
  assert.equal(frischerPeer(nie, a).name, "a", "„nie“ darf sich nicht als null Sekunden vordrängen");
  assert.equal(frischerPeer(a, nie).name, "a");
  assert.equal(frischerPeer(null, b).name, "b");
  assert.equal(frischerPeer(null, null), null);
  assert.equal(peerAbstand(a, b), 370);
  assert.equal(peerAbstand(a, nie), null, "gegen ein „nie“ gibt es keinen Abstand");
  assert.equal(peerAbstand(a, null), null);
});

/* ============================================================
   Zertifikate, die niemand prüft
   ============================================================ */

/* Ein eigensigniertes Zertifikat bezeugt keine Herkunft. Läuft es ab,
   ändert sich für den Betrieb nichts — wer es gestern angenommen hat,
   nimmt es heute an. Eine rote Ampel dafür ist genau die Meldung, die man
   zu übergehen lernt, und mit ihr die nächste, die zählt. */
test("Ein eigensigniertes Zertifikat bekommt von sich aus keine Ampel", () => {
  const eigen = { selfSigned: true, days: -30 };
  const echt = { selfSigned: false, days: -30 };
  assert.equal(tlsBewerten({ id: "a" }, eigen, {}), false);
  assert.equal(tlsBewerten({ id: "a" }, echt, {}), true, "ein Zertifikat einer Ausgabestelle bleibt bewertet");
  assert.equal(tlsBewerten({ id: "a" }, eigen, { tls_selfsigned_ignore: false }), true,
    "wer die Ampel will, bekommt sie zurück");
});

test("Ein einzelnes System darf sein Zertifikat ganz aus der Bewertung nehmen", () => {
  const echt = { selfSigned: false, days: 3 };
  assert.equal(tlsBewerten({ id: "a", tls_ignore: true }, echt, {}), false);
  assert.equal(tlsBewerten({ id: "a" }, echt, {}), true);
});
