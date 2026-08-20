/* Die Diagnose ist das Werkzeug für den Fall „erreichbar, Rechte gesetzt,
   trotzdem keine Werte". Sie muss deshalb zweierlei leisten: den Schritt
   benennen, an dem es klemmt — und dabei nichts preisgeben, was nicht in
   einen Fehlerbericht gehört. */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { diagnoseHost, alsText } from "../src/diagnose.js";

const GEHEIM = "streng-geheim-4711";
const TOKEN = `leitstand@pve!ro=${GEHEIM}`;
const CRED = { user: "leitstand@pve", tokenId: "ro", secret: GEHEIM };

function pve({ resStatus = 200, resLeer = false, nodes = null } = {}) {
  return http.createServer((req, res) => {
    const send = (code, data) => {
      const b = JSON.stringify({ data });
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
      res.end(b);
    };
    if ((req.headers.authorization || "").replace(/^PVEAPIToken=/, "") !== TOKEN) return send(401, null);
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/api2/json/version") return send(200, { version: "8.3.2", release: "8.3" });
    if (p === "/api2/json/nodes") return send(200, nodes || [
      { node: "pve-01", status: "online", cpu: 0.2, mem: 20e9, maxmem: 64e9, disk: 100e9, maxdisk: 500e9, uptime: 864000 }
    ]);
    if (p === "/api2/json/cluster/resources") {
      if (resStatus !== 200) return send(resStatus, null);
      return send(200, resLeer ? [] : [
        { type: "qemu", node: "pve-01", vmid: 100, status: "running" },
        { type: "storage", node: "pve-01", storage: "local", disk: 10e9, maxdisk: 100e9 }
      ]);
    }
    if (p === "/api2/json/cluster/status") return send(200, []);
    return send(404, null);
  });
}

async function stelle(opt = {}, { id = "pve-01", cred = CRED } = {}) {
  const srv = pve(opt);
  const url = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
  const host = { id, name: id, type: "pve", url, checks: [{ kind: "tcp", port: Number(new URL(url).port) }] };
  const b = await diagnoseHost(host, cred, { icmp: false, timeout: 2 });
  srv.close();
  return b;
}

test("Alles in Ordnung wird als solches gemeldet", async () => {
  const b = await stelle();
  assert.equal(b.ok, true);
  assert.match(b.fazit, /kommen durch/);
  assert.equal(b.api.length, 4, "alle vier Aufrufe wurden gemacht");
  assert.ok(b.api.every(a => a.ok));
  assert.match(b.api.find(a => a.pfad === "/cluster/resources").befund, /qemu 1.*storage 1/);
});

test("Leere Bestandsliste wird als Rechteproblem benannt", async () => {
  const b = await stelle({ resLeer: true });
  assert.equal(b.ok, false);
  assert.match(b.fazit, /Rechten/);
  assert.ok(b.api.find(a => a.pfad === "/cluster/resources").ok, "der Aufruf selbst kam ja durch");
});

test("Abgelehnter Aufruf nennt Pfad, Code und was zu tun ist", async () => {
  const b = await stelle({ resStatus: 403 });
  assert.equal(b.ok, false);
  assert.match(b.fazit, /403/);
  assert.match(b.fazit, /PVEAuditor/);
  const a = b.api.find(x => x.pfad === "/cluster/resources");
  assert.equal(a.ok, false);
  assert.equal(a.status, 403);
});

/* Nach einem harten Fehlschlag weiterzufragen erzeugt nur Rauschen in einem
   Bericht, der Klarheit schaffen soll. */
test("Nach einem Fehlschlag wird nicht weitergefragt", async () => {
  const b = await stelle({ resStatus: 403 });
  assert.equal(b.api.at(-1).pfad, "/cluster/resources");
  assert.ok(!b.api.some(a => a.pfad === "/cluster/status"));
});

test("Kennung, die zu keinem Knoten passt, wird erkannt", async () => {
  const b = await stelle({
    nodes: [{ node: "pve-a", status: "online", cpu: .1, mem: 1, maxmem: 2, disk: 1, maxdisk: 2, uptime: 1 },
            { node: "pve-b", status: "online", cpu: .1, mem: 1, maxmem: 2, disk: 1, maxdisk: 2, uptime: 1 }]
  }, { id: "proxmox" });
  assert.equal(b.ok, false);
  assert.match(b.fazit, /Knotenliste nicht vor/);
  assert.match(b.api.find(a => a.pfad === "/nodes").befund, /pve-a, pve-b/);
});

test("Ein einzelner Knoten wird auch bei abweichender Kennung genommen", async () => {
  const b = await stelle({}, { id: "irgendwas" });
  assert.match(b.api.find(a => a.pfad === "/nodes").befund, /nur einen/);
});

test("Ohne hinterlegtes Token wird gar nicht erst gefragt", async () => {
  const b = await stelle({}, { cred: null });
  assert.equal(b.api.length, 0);
  assert.equal(b.zugang.vorhanden, false);
  assert.match(b.fazit, /kein API-Token/);
  assert.ok(b.netz.length, "die Netzprüfung läuft trotzdem");
});

test("Falsches Geheimnis wird als abgelehnte Anmeldung erklärt", async () => {
  const b = await stelle({}, { cred: { ...CRED, secret: "falsch" } });
  assert.equal(b.ok, false);
  assert.match(b.fazit, /401|abgelehnt/);
});

/* Ein Diagnosebericht wird herumgereicht — in eine Meldung kopiert, in
   einen Chat gestellt. Das Geheimnis darf da unter keinen Umständen mit. */
test("Das Geheimnis steht in keiner Fassung des Berichts", async () => {
  for (const opt of [{}, { resLeer: true }, { resStatus: 403 }]) {
    const b = await stelle(opt);
    const alles = JSON.stringify(b) + "\n" + alsText(b);
    assert.ok(!alles.includes(GEHEIM), `Geheimnis steht im Bericht (${JSON.stringify(opt)})`);
    assert.match(alles, /••••/, "die Form der Kopfzeile wird aber gezeigt");
    assert.match(alles, /leitstand@pve!ro/, "damit ein Tippfehler in der Token-ID auffällt");
  }
});

test("Die Textfassung nennt Fazit und jeden Schritt", async () => {
  const t = alsText(await stelle({ resStatus: 403 }));
  assert.match(t, /Woran es hängt/);
  assert.match(t, /\/version/);
  assert.match(t, /\/nodes/);
  assert.match(t, /403/);
});

test("Ein Typ ohne Sammler sagt das, statt Aufrufe zu erfinden", async () => {
  const b = await diagnoseHost(
    { id: "nas", type: "truenas", ip: "127.0.0.1", checks: [{ kind: "tcp", port: 9 }] },
    null, { icmp: false, timeout: 1 });
  assert.equal(b.api.length, 0);
  assert.match(b.fazit, /noch keinen Sammler/);
});

/* ---------- Der Fall aus dem Betrieb ----------
   Ein Token, das die Knoten sehen darf, aber sonst nichts: /cluster/resources
   antwortet mit 200 und liefert ausschließlich node-Einträge, /cluster/status
   wird mit „Permission check failed (/, Sys.Audit)" abgelehnt. Weil der Knoten
   selbst in der Liste steht, sah sie nicht leer aus — gezählt wurden 0 VMs bei
   grüner Ampel, und die Diagnose gab Entwarnung. */
const TOKEN_BETRIEB = `monitoring@pam!leitstand=${GEHEIM}`;
const CRED_BETRIEB = { user: "monitoring@pam", tokenId: "leitstand", secret: GEHEIM };

function pveNurKnoten() {
  const namen = ["pve2", "pve3", "pve1", "zeus"];
  return http.createServer((req, res) => {
    const send = (code, data, roh) => {
      const b = roh || JSON.stringify({ data });
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
      res.end(b);
    };
    if ((req.headers.authorization || "").replace(/^PVEAPIToken=/, "") !== TOKEN_BETRIEB) return send(401, null);
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/api2/json/version") return send(200, { version: "9.2.5", release: "9.2" });
    if (p === "/api2/json/nodes")
      return send(200, namen.map(n => ({ node: n, status: "online", cpu: .11, mem: 8e9, maxmem: 32e9, disk: 2e10, maxdisk: 1e11, uptime: 5e5 })));
    if (p === "/api2/json/cluster/resources")
      return send(200, namen.map(n => ({ type: "node", node: n, status: "online", id: "node/" + n })));
    if (p === "/api2/json/cluster/status")
      return send(403, null, '{"message":"Permission check failed (/, Sys.Audit)\\n","data":null}');
    return send(404, null);
  });
}

test("Nur Knoten-Einträge sind kein Bestand — die Diagnose sagt das", async () => {
  const srv = pveNurKnoten();
  const url = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
  try {
    const b = await diagnoseHost(
      { id: "pve2", name: "pve2", type: "pve", url, checks: [{ kind: "tcp", port: Number(new URL(url).port) }] },
      CRED_BETRIEB, { icmp: false, timeout: 2 });

    assert.equal(b.ok, false, "das ist keine Entwarnung wert");
    assert.match(b.api.find(a => a.pfad === "/cluster/resources").befund, /NUR Knoten-Einträge/);
    assert.match(b.fazit, /keine Gäste/);
    assert.match(b.fazit, /Sys\.Audit/, "der abgelehnte Aufruf wird als Beleg genannt");
    assert.match(b.fazit, /API Token Permission/, "und was konkret zu tun ist");
  } finally { srv.close(); }
});

/* Ein abgelehnter Aufruf, der als „optional" gilt, ist trotzdem ein Befund:
   er benennt das fehlende Recht. */
test("Auch ein abgelehnter optionaler Aufruf zählt als Befund", async () => {
  const b = await stelle({ resStatus: 200 });
  assert.equal(b.ok, true, "hier ist alles in Ordnung — Gegenprobe");

  const srv = pveNurKnoten();
  const url = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
  try {
    const b2 = await diagnoseHost({ id: "pve2", name: "pve2", type: "pve", url, checks: [] },
      CRED_BETRIEB, { icmp: false, timeout: 2 });
    const status = b2.api.find(a => a.pfad === "/cluster/status");
    assert.equal(status.optional, true);
    assert.equal(status.ok, false);
    assert.equal(b2.ok, false, "trotz „optional“ kein Freispruch");
  } finally { srv.close(); }
});
