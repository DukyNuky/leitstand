import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import * as Inv from "../src/inventory.js";
import { Engine } from "../src/engine.js";

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
