import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createServer } from "../src/server.js";
import { fakeProxmox, listen as listenFake } from "./fake-proxmox.js";

let dir, srv, base, fake, fakeUrl, openSrv, openPort;

const START = `
settings: { interval: 3600, timeout: 1, icmp: false, fail_threshold: 2 }
sites:
  - { id: hq, name: HQ Zuhause, place: Köln, primary: true }
  - { id: rz, name: RZ, place: Falkenstein }
hosts:
  - { id: alt, type: other, site: hq, ip: 127.0.0.1, checks: [{ kind: tcp, port: 9 }] }
tunnels: []
links:
  - group: Test
    items: [{ name: Alt, host: alt }]
`;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-srv-"));
  fs.writeFileSync(path.join(dir, "inventory.yaml"), START);
  fake = fakeProxmox(); fakeUrl = await listenFake(fake);
  await new Promise(r => { openSrv = net.createServer(c => c.end()); openSrv.listen(0, "127.0.0.1", () => { openPort = openSrv.address().port; r(); }); });

  srv = createServer({
    inventory: path.join(dir, "inventory.yaml"),
    secrets: path.join(dir, "secrets.json"),
    state: path.join(dir, "incidents.json")
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => { srv.engine.stop(); srv.close(); fake.close(); openSrv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (m, p, body) => {
  const res = await fetch(base + p, {
    method: m,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
};

test("Zustand kommt in der Form, die die Oberfläche erwartet", async () => {
  const { body } = await call("GET", "/api/state");
  assert.equal(body.meta.live, true);
  for (const k of ["sites", "hosts", "tunnels", "incidents", "certs", "links", "integrations"])
    assert.ok(Array.isArray(body[k]), `${k} fehlt`);
  assert.equal(body.hosts[0].id, "alt");
  assert.equal(body.sites[0].short, "HQ", "Kürzel wird abgeleitet");
});

test("Erfundene Bereiche bleiben leer statt gefüllt", async () => {
  const { body } = await call("GET", "/api/state");
  for (const k of ["peers", "haproxy", "backups", "mails"]) assert.deepEqual(body[k], []);
  assert.equal(body.hosts[0].cpu, null, "ohne Sammler keine Auslastung");
});

test("Proxmox anlegen — genau der Weg aus der Oberfläche", async () => {
  const add = await call("POST", "/api/admin/hosts",
    { id: "pve-hq-01", type: "pve", site: "hq", ip: "127.0.0.1", url: fakeUrl, role: "Cluster-Node" });
  assert.equal(add.status, 201);
  assert.deepEqual(add.body.item.checks.map(c => c.kind), ["icmp", "tcp"], "http-Attrappe: kein TLS");

  const inv = await call("GET", "/api/admin/inventory");
  assert.ok(inv.body.hosts.some(h => h.id === "pve-hq-01"));
  assert.ok(fs.readFileSync(path.join(dir, "inventory.yaml"), "utf8").includes("pve-hq-01"), "steht in der Datei");
});

test("Doppelte id wird abgewiesen", async () => {
  const r = await call("POST", "/api/admin/hosts", { id: "pve-hq-01", type: "pve", site: "hq", ip: "10.0.0.1" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /gibt es bereits/);
});

test("Unsinniger Bestand wird abgelehnt und die Datei bleibt heil", async () => {
  const vorher = fs.readFileSync(path.join(dir, "inventory.yaml"), "utf8");
  const r = await call("POST", "/api/admin/hosts", { id: "kaputt", type: "pve", site: "gibtsnicht", ip: "10.0.0.2" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Standort/);
  assert.equal(fs.readFileSync(path.join(dir, "inventory.yaml"), "utf8"), vorher);
});

test("Verbindungstest ohne Zugangsdaten meldet nur Erreichbarkeit", async () => {
  const r = await call("POST", "/api/admin/test", { id: "pve-hq-01", type: "pve", url: fakeUrl, ip: "127.0.0.1" });
  assert.equal(r.body.reachable, true);
  assert.equal(r.body.api.ok, false);
  assert.match(r.body.api.detail, /Keine Zugangsdaten/);
});

test("Verbindungstest mit Zugangsdaten spricht die echte API", async () => {
  const r = await call("POST", "/api/admin/test", {
    id: "pve-hq-01", type: "pve", url: fakeUrl, ip: "127.0.0.1",
    credentials: { user: "leitstand@pve", tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555" }
  });
  assert.equal(r.body.api.ok, true);
  assert.match(r.body.summary, /Proxmox VE 8\.3\.2/);
});

test("Falsches Geheimnis wird erklärt, nicht nur abgelehnt", async () => {
  const r = await call("POST", "/api/admin/test", {
    id: "pve-hq-01", type: "pve", url: fakeUrl, ip: "127.0.0.1",
    credentials: { user: "leitstand@pve", tokenId: "ro", secret: "falsch" }
  });
  assert.equal(r.body.api.ok, false);
  assert.match(r.body.api.hint, /Token-ID/);
});

test("Zugangsdaten werden gespeichert, aber nur maskiert zurückgegeben", async () => {
  const geheim = "1a2b3c4d-0000-1111-2222-333344445555";
  const r = await call("POST", "/api/admin/credentials/pve-hq-01", { user: "leitstand@pve", tokenId: "ro", secret: geheim });
  assert.equal(r.body.credentials.user, "leitstand@pve");
  assert.match(r.body.credentials.secret, /^••••••/);
  assert.ok(!JSON.stringify(r.body).includes(geheim), "das Geheimnis verlässt den Server nicht");

  const inv = await call("GET", "/api/admin/inventory");
  assert.ok(!JSON.stringify(inv.body).includes(geheim));
  assert.ok(!fs.readFileSync(path.join(dir, "inventory.yaml"), "utf8").includes(geheim), "und steht nicht im Bestand");

  const mode = fs.statSync(path.join(dir, "secrets.json")).mode & 0o777;
  assert.equal(mode, 0o600, "nur für den Dienstbenutzer lesbar");
});

test("Teilweises Ändern behält das Geheimnis", async () => {
  const r = await call("POST", "/api/admin/credentials/pve-hq-01", { user: "anderer@pve" });
  assert.equal(r.body.credentials.user, "anderer@pve");
  assert.match(r.body.credentials.secret, /^••••••/, "Geheimnis blieb bestehen");
});

test("Mit hinterlegtem Token liefert der Durchlauf echte Kennzahlen", async () => {
  await call("POST", "/api/admin/credentials/pve-hq-01", { user: "leitstand@pve", tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555" });
  await call("POST", "/api/admin/check");
  const { body } = await call("GET", "/api/state");
  const h = body.hosts.find(x => x.id === "pve-hq-01");
  assert.equal(h.cpu, 34);
  assert.equal(h.vms, 2);
  assert.equal(h.cluster, "cl-hq");
  assert.equal(h.status, "crit", "der Sammler meldet vollen Speicher");
});

test("Störung lässt sich quittieren", async () => {
  await call("POST", "/api/admin/check");
  const { body } = await call("GET", "/api/state");
  const inc = body.incidents[0];
  assert.ok(inc, "es gibt eine offene Störung");
  const r = await call("POST", `/api/incidents/${inc.id}/ack`, { on: true });
  assert.equal(r.status, 200);
  const nach = await call("GET", "/api/state");
  assert.equal(nach.body.incidents.find(i => i.id === inc.id).ack, true);
});

test("Datenquellen-Übersicht spiegelt den echten Stand", async () => {
  const { body } = await call("GET", "/api/state");
  const pve = body.integrations.find(i => i.type === "pve");
  assert.match(pve.method, /API-Token/);
  assert.match(pve.note, /1 von 1 mit Zugangsdaten/);
  const other = body.integrations.find(i => i.type === "other");
  assert.match(other.method, /nur Erreichbarkeit/);
});

test("System ändern zieht Prüfungen und Verknüpfungen nach", async () => {
  const r = await call("PUT", "/api/admin/hosts/alt", { role: "Umbenannt", ip: "127.0.0.1", checks: [{ kind: "tcp", port: openPort }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.role, "Umbenannt");
  await call("POST", "/api/admin/check");
  const { body } = await call("GET", "/api/state");
  assert.equal(body.hosts.find(h => h.id === "alt").status, "ok", "neuer Port wird sofort geprüft");
});

test("Standort mit Systemen lässt sich nicht versehentlich löschen", async () => {
  const r = await call("DELETE", "/api/admin/sites/hq");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /trägt noch/);
});

test("System löschen entfernt Zugangsdaten und Verknüpfungen mit", async () => {
  await call("DELETE", "/api/admin/hosts/alt");
  const inv = await call("GET", "/api/admin/inventory");
  assert.ok(!inv.body.hosts.some(h => h.id === "alt"));
  assert.ok(!inv.body.links.some(g => g.items.some(i => i.host === "alt")), "verwaiste Kachel wäre ein toter Link");
});

test("Oberfläche wird ausgeliefert", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Leitstand/);
});

test("Kein Ausbruch aus dem Auslieferungsverzeichnis", async () => {
  const res = await fetch(base + "/../server/secrets.json");
  assert.ok(res.status === 404 || res.status === 403, `unerwartet ${res.status}`);
});
