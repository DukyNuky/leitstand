/* Der OPNsense-Sammler, geprüft gegen die Feldgestalt einer echten
   OPNsense 26.1 — abgelesen aus einem Diagnosebericht aus dem Betrieb,
   nicht aus der Dokumentation, die keine Antwortschemata nennt.

   Die Eigenheiten, an denen man sich sonst schneidet, stehen hier je in
   einem eigenen Fall: Zahlen als Zeichenketten, Bindestriche statt
   Unterstriche, gemischte Listen und kumulative Zähler. */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { collectOpnsense, authHeader, baseUrl } from "../src/collectors/opnsense.js";

const KEY = "rCRAOZpe", SECRET = "streng-geheim";
const CRED = { key: KEY, secret: SECRET };

/* Antworten wie vom echten Gerät. Was ein Test verändern will, geht als
   Abweichung hinein — der Rest bleibt so, wie er wirklich aussieht. */
function opnsense(ab = {}) {
  let runde = 0;
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => {
      const b = JSON.stringify(obj);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
      res.end(b);
    };
    const auth = Buffer.from((req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString();
    if (auth !== `${KEY}:${SECRET}`) return send(401, { message: "Authentication failed" });
    const p = new URL(req.url, "http://x").pathname;

    if (p === "/api/core/firmware/status")
      return send(200, {
        product_version: "26.1.11_10", product_abi: "26.1", os_version: "FreeBSD 14.3-RELEASE-p16",
        needs_reboot: ab.needsReboot ?? "0", upgrade_needs_reboot: "1",
        last_check: "Wed Aug 19 19:00:15 CEST 2026",
        new_packages: ab.newPackages ?? [], upgrade_packages: ab.upgradePackages ?? [],
        reinstall_packages: [], remove_packages: [], downgrade_packages: [],
        upgrade_major_version: ab.major ?? "26.7",
        upgrade_sets: [{ name: "packages" }, { name: "base" }, { name: "kernel" }]
      });

    if (p === "/api/diagnostics/system/system_information")
      return send(200, { name: "OPNsense.serverzero.de", versions: ["OPNsense 26.1.11_10-amd64"] });

    if (p === "/api/diagnostics/system/system_resources")
      /* total als Zeichenkette, used als Zahl — genau so kommt es an. */
      return send(200, { memory: { total: "2100785152", total_frmt: "2003", used: 1215534357, arc: "436057280" } });

    if (p === "/api/diagnostics/system/system_time") {
      if (ab.zeit === false) return send(404, { message: "not found" });
      /* Genau die Felder, die eine echte 26.1 zurückgibt. */
      return send(200, ab.zeit ?? {
        uptime: "3 days, 20:56:43", datetime: "Thu Aug 20 15:43:31 CEST 2026",
        boottime: "Sun Aug 16 18:46:48 CEST 2026", config: "Thu Aug 20 14:15:35 CEST 2026",
        loadavg: "0.68, 0.41, 0.35"
      });
    }

    if (p === "/api/diagnostics/system/system_disk")
      /* Bei ZFS teilen sich viele Datensätze denselben Vorrat. */
      return send(200, { devices: ab.devices ?? [
        { device: "zroot/var/log", type: "zfs", used_pct: 4, mountpoint: "/var/log" },
        { device: "zroot/ROOT/default", type: "zfs", used_pct: 39, mountpoint: "/" },
        { device: "zroot/tmp", type: "zfs", used_pct: 4, mountpoint: "/tmp" }
      ] });

    if (p === "/api/diagnostics/interface/get_interface_statistics") {
      runde++;
      const zu = n => (ab.ruecksetzen && runde > 1 ? 0 : n + (runde - 1) * 1_500_000);
      return send(200, { statistics: {
        "[LAN] (vtnet0) / bc:24:11:e9:8c:61": { name: "vtnet0", network: "<Link#1>",
          "received-bytes": zu(81_386_215_378), "sent-bytes": zu(557_996_298_083),
          "received-errors": 0, "send-errors": 0 },
        "[LAN] (vtnet0) / 192.168.0.254": { name: "vtnet0", network: "192.168.0.0/24",
          "received-bytes": 305_715_533, "sent-bytes": 0 },
        "[WAN] (vtnet1) / bc:24:11:43:3a:26": { name: "vtnet1", network: "<Link#2>",
          "received-bytes": zu(562_774_671_970), "sent-bytes": zu(78_304_533_217),
          "received-errors": 0, "send-errors": 0 },
        "[Loopback] (lo0) / lo0": { name: "lo0", network: "<Link#3>",
          "received-bytes": 536_125_847, "sent-bytes": 536_125_847 }
      } });
    }

    if (p === "/api/wireguard/service/show") {
      if (ab.wireguard === false) return send(404, { message: "not found" });
      if (ab.wireguard === 403) return send(403, { message: "denied" });
      return send(200, { total: 3, rows: [
        { if: "wg0", type: "interface", "public-key": "zQPF17", "listen-port": "51822",
          status: "up", name: "WG-Schweiz", "latest-handshake-age": null, "peer-status": "offline" },
        { if: "wg0", type: "peer", "public-key": "Aqujl", endpoint: "178.39.98.174:8909",
          "allowed-ips": "0.0.0.0/0", "transfer-rx": 1_157_470_889, "transfer-tx": 4_185_660_632,
          "persistent-keepalive": "10", name: "WG-Schweiz",
          "latest-handshake-age": 80, "latest-handshake-epoch": "2026-08-20 14:15:56" },
        { if: "wg1", type: "peer", "public-key": "Bbcd", "allowed-ips": "10.99.0.2/32",
          "transfer-rx": 0, "transfer-tx": 0, name: "laptop", "latest-handshake-age": null }
      ] });
    }
    return send(404, { message: "endpoint not found" });
  });
  return srv;
}

async function an(ab) {
  const srv = opnsense(ab);
  const url = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
  return { srv, host: { id: "os-zornheim", name: "os-zornheim", type: "opnsense", url } };
}

/* ---------- Zugang ---------- */
test("Die Anmeldung ist HTTP Basic aus Schlüssel und Secret", () => {
  const k = authHeader({ key: "abc", secret: "xyz" });
  assert.equal(k.Authorization, "Basic " + Buffer.from("abc:xyz").toString("base64"));
  assert.equal(authHeader({ key: "abc" }), null, "ohne Secret kein Kopf");
  assert.equal(authHeader(null), null);
});

test("Die Adresse kommt aus der url, sonst aus der IP", () => {
  assert.equal(baseUrl({ url: "https://192.168.0.254" }), "https://192.168.0.254");
  assert.equal(baseUrl({ url: "https://fw:8443/irgendwas" }), "https://fw:8443");
  assert.equal(baseUrl({ ip: "10.0.0.1" }), "https://10.0.0.1");
});

/* ---------- Fassung ---------- */
test("Fassung, Aktualisierungen und Neustart werden richtig gelesen", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.version, "26.1.11_10");
    assert.equal(r.abi, "26.1");
    assert.equal(r.updates, 0, "keine offenen Pakete");
    assert.equal(r.majorUpgrade, "26.7", "aber eine neue Hauptfassung");
    assert.equal(r.needsReboot, false, "needs_reboot ist die Zeichenkette 0");
    assert.match(r.note, /26\.7/, "und das steht als Hinweis da");
    assert.equal(r.status, undefined, "ohne die Ampel zu drehen");
  } finally { srv.close(); }
});

test("Ein ausstehender Neustart wird gemeldet, ohne zu alarmieren", async () => {
  const { srv, host } = await an({ needsReboot: "1", major: null });
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.needsReboot, true);
    assert.match(r.note, /Neustart steht aus/);
    assert.equal(r.status, undefined);
  } finally { srv.close(); }
});

test("Offene Pakete werden über alle Listen gezählt", async () => {
  const { srv, host } = await an({ newPackages: [{ name: "a" }], upgradePackages: [{ name: "b" }, { name: "c" }] });
  try {
    assert.equal((await collectOpnsense(host, CRED)).updates, 3);
  } finally { srv.close(); }
});

/* ---------- Speicher und Platte ---------- */
test("memory.total als Zeichenkette ergibt trotzdem einen Prozentwert", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.ram, 58, "1215534357 von 2100785152");
    assert.equal(r.ramTotalMb, 2003);
    assert.equal(r.ramArcMb, 416, "der ZFS-Cache wird getrennt ausgewiesen");
  } finally { srv.close(); }
});

test("Bei ZFS zählt der Wert für / und nicht der erste Datensatz", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.disk, 39, "die Wurzel, nicht /var/log mit 4 %");
    assert.equal(r.disks.length, 3);
  } finally { srv.close(); }
});

test("Eine volle Platte dreht die Ampel auf Rot", async () => {
  const { srv, host } = await an({ devices: [{ device: "zroot", used_pct: 94, mountpoint: "/" }] });
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.status, "crit");
    assert.match(r.note, /94 %/);
  } finally { srv.close(); }
});

/* ---------- Durchsatz ---------- */
test("Durchsatz gibt es erst ab dem zweiten Durchlauf", async () => {
  const { srv, host } = await an();
  try {
    const erst = await collectOpnsense(host, CRED);
    assert.equal(erst.thrIn, null, "ein einzelner Zählerstand ergibt keine Rate");
    assert.equal(erst.thrOut, null);

    await new Promise(r => setTimeout(r, 1100));
    const dann = await collectOpnsense(host, CRED);
    assert.ok(dann.thrIn > 0, "jetzt liegt eine Differenz vor");
    /* 1,5 MB in gut einer Sekunde sind rund 12 Mbit/s. */
    assert.ok(dann.thrIn > 8 && dann.thrIn < 13, `unerwartete Rate: ${dann.thrIn}`);
    assert.equal(dann.thrQuelle, "WAN", "die als WAN beschriebene Schnittstelle zählt");
  } finally { srv.close(); }
});

test("Nur Zeilen auf Verbindungsebene zählen, Loopback nicht", async () => {
  const { srv, host } = await an();
  try {
    await collectOpnsense(host, CRED);
    await new Promise(r => setTimeout(r, 200));
    const r = await collectOpnsense(host, CRED);
    const namen = r.interfaces.map(i => i.name);
    assert.deepEqual(namen.sort(), ["vtnet0", "vtnet1"], "lo0 fliegt raus, IP-Zeilen ebenso");
  } finally { srv.close(); }
});

/* Ein Neustart setzt die Zähler zurück. Eine negative Differenz als
   Durchsatz zu melden, wäre schlimmer als kein Wert. */
test("Zurückgesetzte Zähler ergeben keinen Wert statt eines falschen", async () => {
  const { srv, host } = await an({ ruecksetzen: true });
  try {
    await collectOpnsense(host, CRED);
    await new Promise(r => setTimeout(r, 200));
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.thrIn, null);
  } finally { srv.close(); }
});

/* ---------- WireGuard ---------- */
test("Peers werden gelesen, die Schnittstellenzeile zählt nicht mit", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.wgPeers, 2, "zwei Peers");
    assert.equal(r.wgIfaces, 1, "eine Schnittstelle — die ist kein Peer");

    const schweiz = r.peers.find(p => p.name === "WG-Schweiz");
    assert.equal(schweiz.handshake, 80, "latest-handshake-age mit Bindestrichen");
    assert.equal(schweiz.rx, 1_157_470_889);
    assert.equal(schweiz.tx, 4_185_660_632);
    assert.equal(schweiz.endpoint, "178.39.98.174:8909");
    assert.equal(schweiz.allowed, "0.0.0.0/0");

    const laptop = r.peers.find(p => p.name === "laptop");
    assert.equal(laptop.handshake, null, "nie verbunden ist nicht null Sekunden");
    assert.equal(r.wgStill, 1);
  } finally { srv.close(); }
});

test("Fehlendes WireGuard-Plugin ist kein Fehler", async () => {
  const { srv, host } = await an({ wireguard: false });
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.wgPeers, null, "unbekannt, nicht null Peers");
    assert.equal(r.peers, null);
    assert.equal(r.wgFehler, undefined, "404 heißt: nicht eingerichtet");
    assert.notEqual(r.status, "warn");
    assert.equal(r.version, "26.1.11_10", "alles andere kommt trotzdem an");
  } finally { srv.close(); }
});

test("Verweigerter WireGuard-Zugriff wird dagegen gemeldet", async () => {
  const { srv, host } = await an({ wireguard: 403 });
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.wgPeers, null);
    assert.equal(r.status, "warn");
    assert.match(r.note, /403/);
  } finally { srv.close(); }
});

/* ---------- Zugang fehlt ---------- */
test("Abgelehnte Anmeldung geht als Warnung durch, nicht als Stille", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectOpnsense(host, { key: KEY, secret: "falsch" });
    assert.equal(r.status, "warn");
    assert.match(r.error, /401/);
  } finally { srv.close(); }
});

test("Ohne Schlüssel wird gar nicht erst gefragt", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectOpnsense(host, null);
    assert.match(r.error, /Kein API-Key/);
  } finally { srv.close(); }
});

/* ---------- Laufzeit und Last ----------
   Beides steht nicht in system_information, obwohl der Pfadname das
   nahelegt — die Vermutung hat sich am Gerät nicht bestätigt. Es kommt
   aus system_time, und zwar englisch und als Zeichenkette. */

test("Laufzeit und Last kommen aus system_time", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.uptimeSeconds, 3 * 86400 + 20 * 3600 + 56 * 60 + 43);
    assert.equal(r.uptime, "3 T 20 h", "auf Deutsch und ohne Sekundenkleinkram");
    assert.equal(r.load, "0.68, 0.41, 0.35");
    assert.equal(r.load1, 0.68);
    assert.match(r.boot, /Aug 16/);
  } finally { srv.close(); }
});

test("Fehlt system_time, bleibt es beim Strich statt bei einer Null", async () => {
  const { srv, host } = await an({ zeit: false });
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.uptime, null);
    assert.equal(r.uptimeSeconds, null);
    assert.equal(r.load, null);
    assert.equal(r.load1, null);
  } finally { srv.close(); }
});

test("Eine unbekannte Schreibweise der Laufzeit wird durchgereicht, nicht verbogen", async () => {
  const { srv, host } = await an({ zeit: { uptime: "seit vorgestern", loadavg: "" } });
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.uptimeSeconds, null, "was sich nicht lesen lässt, wird nicht geraten");
    assert.equal(r.uptime, "seit vorgestern");
    assert.equal(r.load, null);
  } finally { srv.close(); }
});

test("Unter einem Tag steht die Laufzeit in Stunden", async () => {
  const { srv, host } = await an({ zeit: { uptime: "4:05:11", loadavg: "1.5, 1.2, 1.0" } });
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.uptime, "4 h 5 min");
    assert.equal(r.load1, 1.5);
  } finally { srv.close(); }
});

/* Der öffentliche Schlüssel ist die Kennung, an der später die Verknüpfung
   mit einem Tunnel hängt — er muss durchkommen. */
test("Jeder Peer trägt seinen öffentlichen Schlüssel", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectOpnsense(host, CRED);
    assert.equal(r.peers.find(p => p.name === "WG-Schweiz").key, "Aqujl");
    assert.equal(r.peers.find(p => p.name === "laptop").key, "Bbcd");
  } finally { srv.close(); }
});
