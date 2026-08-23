/* Die Form, die die Oberfläche bekommt.

   Geprüft wird hier nur, was zwischen Zustandsmaschine und Oberfläche
   passiert: dass ein aufgelöster Peer an der richtigen Strecke landet,
   dass Mengen lesbar werden — und dass nichts erfunden wird, wo nichts
   gemessen wurde. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Inv from "../src/inventory.js";
import { Engine } from "../src/engine.js";
import { buildState, netzeAus } from "../src/api.js";

const PEERS = [
  { name: "WG-Schweiz", key: "Aqujl", iface: "wg0", handshake: 80,
    rx: 1_157_470_889, tx: 4_185_660_632, endpoint: "178.39.98.174:8909",
    allowed: "0.0.0.0/0", seit: "2026-08-20 14:15:56", keepalive: "10" },
  { name: "laptop", key: "Bbcd", iface: "wg1", handshake: null, rx: 0, tx: 0,
    endpoint: null, allowed: "10.99.0.2/32", seit: null, keepalive: null }
];

function zustand({ peer, peers = PEERS } = {}) {
  const inv = Inv.normalize({
    settings: { icmp: false, timeout: 1 },
    sites: [{ id: "hq", name: "HQ", short: "DEKO" }, { id: "rz", name: "RZ", short: "DEFR" }],
    hosts: [{ id: "fw", type: "opnsense", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port: 1 }] }],
    links: [],
    tunnels: [{ id: "wg", a: "hq", b: "rz", iface: "wg0", probe: { ip: "127.0.0.1", port: 22 }, ...(peer ? { peer } : {}) }]
  });
  const e = new Engine(inv);
  /* Der Sammler wird hier nicht nachgestellt — sein Ergebnis wird
     eingesetzt. Was er liefert, prüft opnsense.test.js. */
  e.hosts.get("fw").extra = { peers };
  return { e, inv };
}

test("Ein aufgelöster Peer bringt Handshake und Mengen an die Strecke", () => {
  const { e } = zustand({ peer: { host: "fw", key: "Aqujl", name: "WG-Schweiz" } });
  e.tunnels.get("wg").peer = { ...PEERS[0], host: "fw" };

  const t = buildState(e, null).tunnels[0];
  assert.equal(t.handshake, 80);
  assert.equal(t.rx, "1.1 GB", "Bytes werden lesbar, nicht roh durchgereicht");
  assert.equal(t.tx, "3.9 GB");
  assert.equal(t.peer.gefunden, true);
  assert.equal(t.peer.endpoint, "178.39.98.174:8909");
  assert.equal(t.quelle, "probe", "gemessen wird weiterhin durch den Tunnel");
});

test("Ohne Verknüpfung bleibt der Handshake null statt null Sekunden", () => {
  const { e } = zustand();
  const t = buildState(e, null).tunnels[0];
  assert.equal(t.peer, null);
  assert.equal(t.handshake, null);
  assert.equal(t.rx, null);
});

test("Eine Verknüpfung ins Leere wird als solche ausgewiesen", () => {
  const { e } = zustand({ peer: { host: "fw", key: "weg", name: "WG-Weg" } });
  e.tunnels.get("wg").peerNote = "Den Peer „WG-Weg“ meldet fw nicht mehr";

  const t = buildState(e, null).tunnels[0];
  assert.equal(t.peer.gefunden, false, "hinterlegt, aber nicht gemeldet — das ist nicht dasselbe wie „nicht verknüpft“");
  assert.equal(t.peer.name, "WG-Weg", "der hinterlegte Name bleibt sichtbar");
  assert.equal(t.handshake, null);
  assert.match(t.peer.note, /nicht mehr/);
});

/* Die Peertabelle soll zeigen, welche Gegenstelle eine angelegte Strecke
   trägt. Die Zuordnung wird dafür umgedreht, nicht neu bestimmt. */
test("Die Peertabelle nennt die Strecke, die an einem Peer hängt", () => {
  const { e } = zustand({ peer: { host: "fw", key: "Aqujl" } });
  e.tunnels.get("wg").peer = { ...PEERS[0], host: "fw" };

  const peers = buildState(e, null).peers;
  assert.equal(peers.find(p => p.name === "WG-Schweiz").tunnel, "wg");
  assert.equal(peers.find(p => p.name === "laptop").tunnel, null, "ein Endgerät trägt keine Strecke");
});

test("Der Port der Gegenstelle geht beim Bearbeiten nicht verloren", () => {
  const { e } = zustand();
  const t = buildState(e, null).tunnels[0];
  assert.equal(t.probe, "127.0.0.1");
  assert.equal(t.probePort, 22, "sonst schriebe das Formular den Tunnel ohne Port zurück");
});

/* ============================================================
   Beide Enden, und was die Firewalls über die Strecke wissen
   ============================================================ */

function zweiEnden({ peer, peerB } = {}) {
  const inv = Inv.normalize({
    settings: { icmp: false, timeout: 1 },
    sites: [{ id: "hq", name: "HQ", short: "DEKO" }, { id: "rz", name: "RZ", short: "DEFR" }],
    hosts: [
      { id: "fw-a", type: "opnsense", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port: 1 }] },
      { id: "fw-b", type: "opnsense", site: "rz", ip: "127.0.0.1", checks: [{ kind: "tcp", port: 1 }] }
    ],
    links: [],
    tunnels: [{ id: "wg", a: "hq", b: "rz", iface: "wg0",
      ...(peer ? { peer } : {}), ...(peerB ? { peerB } : {}) }]
  });
  const e = new Engine(inv);
  const a = { name: "nach-RZ", key: "Aqujl", iface: "wg0", handshake: 80, rx: 100, tx: 200,
    endpoint: "198.51.100.7:51820", allowed: "10.99.0.2/32, 192.168.20.0/24" };
  const b = { name: "nach-HQ", key: "Kx7Qd", iface: "wg0", handshake: 95, rx: 200, tx: 100,
    endpoint: "203.0.113.5:51820", allowed: "10.99.0.1/32, 192.168.10.0/24" };
  e.hosts.get("fw-a").extra = { peers: [a] };
  e.hosts.get("fw-b").extra = { peers: [b] };
  if (peer) e.tunnels.get("wg").peer = { ...a, host: "fw-a" };
  if (peerB) e.tunnels.get("wg").peerB = { ...b, host: "fw-b" };
  return { e };
}

/* Der Anlass: eine Strecke war verknüpft, und die Gegenzeile in der
   Peertabelle behauptete trotzdem, zu keiner zu gehören. */
test("Beide Enden einer Strecke sind ihr in der Peertabelle zugeordnet", () => {
  const { e } = zweiEnden({ peer: { host: "fw-a", key: "Aqujl" }, peerB: { host: "fw-b", key: "Kx7Qd" } });
  const peers = buildState(e, null).peers;
  assert.equal(peers.find(p => p.name === "nach-RZ").tunnel, "wg");
  assert.equal(peers.find(p => p.name === "nach-HQ").tunnel, "wg", "das andere Ende gehört zu derselben Strecke");
});

test("Ist nur ein Ende verknüpft, bleibt das andere ohne Strecke", () => {
  const { e } = zweiEnden({ peer: { host: "fw-a", key: "Aqujl" } });
  const peers = buildState(e, null).peers;
  assert.equal(peers.find(p => p.name === "nach-RZ").tunnel, "wg");
  assert.equal(peers.find(p => p.name === "nach-HQ").tunnel, null);
});

/* Die Adressen im Transfernetz und die Netze dahinter stehen in den
   erlaubten Netzen der Peers — bislang musste man sie abschreiben. */
test("Tunnel-Adressen und Netze werden aus den Peers gelesen", () => {
  const { e } = zweiEnden({ peer: { host: "fw-a", key: "Aqujl" }, peerB: { host: "fw-b", key: "Kx7Qd" } });
  const t = buildState(e, null).tunnels[0];
  assert.deepEqual(t.ips, ["10.99.0.2", "10.99.0.1"]);
  assert.deepEqual(t.netze, ["192.168.20.0/24", "192.168.10.0/24"]);
  assert.equal(t.peerB.name, "nach-HQ");
  assert.equal(t.handshake, 80, "für Handshake und Mengen zählt das frischere Ende");
});

test("Was keine Adresse und kein Netz ist, wird zu keinem gemacht", () => {
  assert.deepEqual(netzeAus("10.99.0.2/32, 192.168.20.0/24"), { ips: ["10.99.0.2"], netze: ["192.168.20.0/24"] });
  assert.deepEqual(netzeAus("fd00::1/128"), { ips: ["fd00::1"], netze: [] });
  assert.deepEqual(netzeAus("0.0.0.0/0"), { ips: [], netze: ["0.0.0.0/0"] });
  assert.deepEqual(netzeAus(null), { ips: [], netze: [] });
  assert.deepEqual(netzeAus("—"), { ips: ["—"], netze: [] }, "was dasteht, wird gezeigt, nicht verworfen");
});

/* ---------- Zertifikate ohne Ampel ---------- */

test("Ein nicht bewertetes Zertifikat bleibt in der Liste, verliert aber die Ampel", () => {
  const { e } = zweiEnden({ peer: { host: "fw-a", key: "Aqujl" } });
  e.hosts.get("fw-a").tls = { cn: "fw-a.local", issuer: "eigensigniert", days: -40,
    selfSigned: true, bewertet: false, port: 443 };
  e.hosts.get("fw-b").tls = { cn: "fw-b.local", issuer: "Let's Encrypt", days: 5,
    selfSigned: false, bewertet: true, port: 443 };

  const certs = buildState(e, null).certs;
  const eigen = certs.find(c => c.cn === "fw-a.local");
  assert.equal(eigen.status, "idle", "kein Rot für etwas, das niemand prüft");
  assert.equal(eigen.bewertet, false);
  assert.equal(eigen.days, -40, "verschwiegen wird nichts");
  assert.equal(certs.find(c => c.cn === "fw-b.local").status, "crit");
});
