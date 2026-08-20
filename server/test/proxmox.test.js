import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeProxmox, listen, GOOD, WEAK } from "./fake-proxmox.js";
import { collectPve, collectPbs, collectPmg, testConnection, authHeader, baseUrl } from "../src/collectors/proxmox.js";

let srv, url;
before(async () => { srv = fakeProxmox(); url = await listen(srv); });
after(() => srv.close());

const cred = { user: "leitstand@pve", tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555" };
const host = id => ({ id, name: id, type: "pve", url });

test("Token-Kopfzeile wird nach Proxmox-Schema gebaut", () => {
  assert.equal(authHeader("pve", cred).Authorization, GOOD);
  assert.equal(authHeader("pbs", { tokenId: "leitstand@pbs!ro", secret: "x" }).Authorization, "PBSAPIToken=leitstand@pbs!ro=x");
  assert.equal(authHeader("pve", null), null, "ohne Zugangsdaten keine Kopfzeile");
});

test("Standardport je Bauart, wenn die url keinen nennt", () => {
  assert.match(baseUrl({ ip: "10.0.0.1" }, "pve"), /:8006$/);
  assert.match(baseUrl({ ip: "10.0.0.1" }, "pbs"), /:8007$/);
  assert.equal(baseUrl({ url: "https://10.0.0.1:9999" }, "pve"), "https://10.0.0.1:9999");
});

test("Verbindungstest meldet Erfolg mit Version", async () => {
  const r = await testConnection(host("pve-hq-01"), cred, "pve");
  assert.equal(r.ok, true);
  assert.match(r.detail, /Proxmox VE 8\.3\.2/);
});

test("Verbindungstest erklärt abgelehnte Zugangsdaten verständlich", async () => {
  const r = await testConnection(host("pve-hq-01"), { tokenId: "ro", secret: "falsch" }, "pve");
  assert.equal(r.ok, false);
  assert.match(r.detail, /401/);
  assert.match(r.hint, /Token-ID/);
});

test("Verbindungstest ohne Zugangsdaten schlägt sauber fehl statt zu werfen", async () => {
  const r = await testConnection(host("pve-hq-01"), null, "pve");
  assert.equal(r.ok, false);
  assert.match(r.detail, /Kein API-Token/);
});

test("PVE-Sammler ordnet den richtigen Knoten zu und rechnet Prozente", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  assert.equal(r.node, "pve-hq-01");
  assert.equal(r.cpu, 34);
  assert.equal(r.ram, 61);
  assert.equal(r.vms, 2, "zwei qemu auf diesem Knoten");
  assert.equal(r.lxc, 1);
  assert.equal(r.running, 2);
  assert.equal(r.stopped, 1);
  assert.equal(r.cluster, "cl-hq");
  assert.equal(r.quorum, true);
  assert.equal(r.uptime, "41 T");
});

test("PVE-Sammler stuft vollen Speicher selbst als kritisch ein", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  assert.equal(r.status, "crit");
  assert.match(r.note, /local-lvm zu 91 % belegt/);
});

test("PVE-Sammler trennt die Knoten eines Clusters", async () => {
  const r = await collectPve(host("pve-hq-02"), cred);
  assert.equal(r.node, "pve-hq-02");
  assert.equal(r.cpu, 71);
  assert.equal(r.vms, 1);
  assert.equal(r.lxc, 0);
});

test("Unbekannter Knotenname führt zu einer erklärenden Meldung, nicht zum Absturz", async () => {
  const r = await collectPve(host("pve-gibtsnicht"), cred);
  assert.match(r.error, /nicht gefunden/);
  assert.match(r.note, /pve-hq-01, pve-hq-02/);
});

test("Zu schwaches Token: Fehler wird als Warnung durchgereicht", async () => {
  const r = await collectPve(host("pve-hq-01"), { tokenId: "schwach", secret: "aaaa", user: "leitstand@pve" });
  assert.equal(r.status, "warn");
  assert.match(r.note, /403/);
});

test("PBS-Sammler erkennt fehlgeschlagenen Verify-Job", async () => {
  const r = await collectPbs({ id: "pbs", url }, { tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555", user: "leitstand@pve" });
  assert.equal(r.datastores, 2);
  assert.equal(r.used, 90, "der vollste Datastore zählt");
  assert.equal(r.failed, 1);
  assert.equal(r.status, "crit");
  assert.match(r.note, /verify nas-archive/);
});

test("PMG-Sammler liest die Tagesstatistik", async () => {
  const r = await collectPmg({ id: "pmg", url }, { tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555", user: "leitstand@pve" });
  assert.equal(r.in24, 1840);
  assert.equal(r.spam, 1216);
  assert.equal(r.status, "warn", "Virenfunde sind eine Warnung");
});

/* ---------- Was nicht gelesen werden kann, ist nicht null Stück ----------
   Proxmox filtert /cluster/resources nach Rechten: ein zu schwacher Token
   bekommt 200 mit leerer Liste statt einer Ablehnung. Gezählt wurden daraus
   früher 0 VMs und 0 Container — bei grüner Ampel. Ein erfundener Messwert
   an genau der Stelle, an der man ihn für bare Münze nimmt. */
import http from "node:http";

function pveMit(resources, { status = 200 } = {}) {
  return http.createServer((req, res) => {
    const send = (code, data) => {
      const b = JSON.stringify({ data });
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
      res.end(b);
    };
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/api2/json/version") return send(200, { version: "8.3.2" });
    if (p === "/api2/json/nodes") return send(200, [
      { node: "n1", status: "online", cpu: 0.2, mem: 20e9, maxmem: 64e9, disk: 100e9, maxdisk: 500e9, uptime: 864000 }
    ]);
    if (p === "/api2/json/cluster/resources") return send(status, status === 200 ? resources : null);
    if (p === "/api2/json/cluster/status") return send(200, []);
    return send(404, null);
  });
}
const anMit = async (resources, opt) => {
  const srv = pveMit(resources, opt);
  const u = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
  return { srv, host: { id: "n1", url: u } };
};
const irgendeinToken = { user: "leitstand@pve", tokenId: "ro", secret: "x" };

test("Leere Bestandsliste zählt nicht als null Gäste", async () => {
  const { srv, host: h } = await anMit([]);
  try {
    const r = await collectPve(h, irgendeinToken);
    assert.equal(r.vms, null, "unbekannt, nicht null Stück");
    assert.equal(r.lxc, null);
    assert.equal(r.storages, null);
    assert.equal(r.status, "warn", "und die Ampel bleibt nicht grün");
    assert.match(r.note, /PVEAuditor/, "mit dem Hinweis, woran es liegt");
    assert.equal(r.cpu, 20, "was gelesen werden konnte, bleibt erhalten");
  } finally { srv.close(); }
});

test("Abgelehnte Bestandsliste zählt nicht als null Gäste", async () => {
  const { srv, host: h } = await anMit(null, { status: 403 });
  try {
    const r = await collectPve(h, irgendeinToken);
    assert.equal(r.vms, null);
    assert.equal(r.status, "warn");
    assert.match(r.note, /nicht abrufbar/);
    assert.match(r.error, /403/);
  } finally { srv.close(); }
});

test("Ein Knoten ohne Gäste, aber mit Speicher, meldet ehrlich null", async () => {
  const { srv, host: h } = await anMit([
    { type: "storage", node: "n1", storage: "local", disk: 10e9, maxdisk: 100e9 }
  ]);
  try {
    const r = await collectPve(h, irgendeinToken);
    assert.equal(r.vms, 0, "hier ist 0 ein Messwert, kein Platzhalter");
    assert.equal(r.lxc, 0);
    assert.equal(r.storages.length, 1);
    assert.notEqual(r.status, "warn");
  } finally { srv.close(); }
});

/* /version darf jeder angemeldete Benutzer lesen. Der Test war deshalb grün,
   während der Token die Kennzahlen gar nicht sehen durfte — und der Knoten
   danach leer blieb, ohne dass jemand wusste warum. */
test("Verbindungstest deckt auf, wenn nur die Version lesbar ist", async () => {
  const { srv, host: h } = await anMit([]);
  try {
    const r = await testConnection(h, irgendeinToken, "pve");
    assert.equal(r.ok, false, "das ist kein brauchbarer Zugang");
    assert.match(r.detail, /8\.3\.2/, "die Version steht trotzdem dabei");
    assert.match(r.detail, /leer/);
    assert.match(r.hint, /PVEAuditor/);
  } finally { srv.close(); }
});

test("Verbindungstest nennt bei Erfolg, was der Token sehen darf", async () => {
  const { srv, host: h } = await anMit([
    { type: "qemu", node: "n1", vmid: 100, status: "running" },
    { type: "storage", node: "n1", storage: "local", disk: 10e9, maxdisk: 100e9 }
  ]);
  try {
    const r = await testConnection(h, irgendeinToken, "pve");
    assert.equal(r.ok, true);
    assert.match(r.detail, /1 Gäste und 1 Speicher sichtbar/);
  } finally { srv.close(); }
});
