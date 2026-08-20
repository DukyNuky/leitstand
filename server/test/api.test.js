/* Die Form, die die Oberfläche bekommt.

   Geprüft wird hier nur, was zwischen Zustandsmaschine und Oberfläche
   passiert: dass ein aufgelöster Peer an der richtigen Strecke landet,
   dass Mengen lesbar werden — und dass nichts erfunden wird, wo nichts
   gemessen wurde. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Inv from "../src/inventory.js";
import { Engine } from "../src/engine.js";
import { buildState } from "../src/api.js";

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
