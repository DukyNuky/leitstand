/* Nachgebauter Proxmox-Endpunkt für die Tests.
   Antwortet wie ein echter Cluster — inklusive 401 ohne Token
   und 403 bei zu schwachem Token. */

import http from "node:http";

export const GOOD = "PVEAPIToken=leitstand@pve!ro=1a2b3c4d-0000-1111-2222-333344445555";
export const WEAK = "PVEAPIToken=leitstand@pve!schwach=aaaa";

const TRENNER = { PVE: "=", PBS: ":", PMG: "=" };

/* Zerlegt die Kopfzeile so, wie das jeweilige Produkt sie erwartet — und
   gibt nichts zurück, wenn das Trennzeichen nicht dazu passt. */
export function zerlegen(auth) {
  const m = /^(PVE|PBS|PMG)APIToken=(.+)$/.exec(auth || "");
  if (!m) return null;
  const i = m[2].lastIndexOf(TRENNER[m[1]]);
  if (i < 1) return null;
  return { produkt: m[1], id: m[2].slice(0, i), secret: m[2].slice(i + 1) };
}

export function fakeProxmox() {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || "";
    const send = (code, data) => {
      const b = JSON.stringify({ data });
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
      res.end(b);
    };
    /* Wie ein echtes Gerät: das Präfix verrät das Produkt, und das Produkt
       bestimmt das Trennzeichen vor dem Geheimnis. Wer PBS mit „=“ anspricht,
       bekommt hier dieselbe wortlose 401 wie draußen. */
    const t = zerlegen(auth);
    if (!auth) return send(401, null);
    if (!t) return send(401, null);
    const token = `${t.id}=${t.secret}`;
    const good = GOOD.replace(/^PVEAPIToken=/, "");
    const weak = WEAK.replace(/^PVEAPIToken=/, "");
    if (token !== good && token !== weak) return send(401, null);
    /* Ein Token ohne PVEAuditor darf die privilegierten Pfade nicht lesen. */
    if (token === weak && /^\/api2\/json\/(nodes|cluster)/.test(req.url)) return send(403, null);

    const u = new URL(req.url, "http://x");
    switch (u.pathname) {
      case "/api2/json/version":
        return send(200, { version: "8.3.2", release: "8.3", repoid: "abc123" });
      case "/api2/json/nodes":
        return send(200, [
          { node: "pve-hq-01", status: "online", cpu: 0.34, mem: 41_000_000_000, maxmem: 67_000_000_000, disk: 210_000_000_000, maxdisk: 450_000_000_000, uptime: 3_542_400 },
          { node: "pve-hq-02", status: "online", cpu: 0.71, mem: 59_000_000_000, maxmem: 67_000_000_000, disk: 280_000_000_000, maxdisk: 450_000_000_000, uptime: 3_542_400 }
        ]);
      case "/api2/json/cluster/resources":
        return send(200, [
          { type: "qemu", node: "pve-hq-01", vmid: 101, status: "running" },
          { type: "qemu", node: "pve-hq-01", vmid: 141, status: "stopped" },
          { type: "lxc",  node: "pve-hq-01", vmid: 201, status: "running" },
          { type: "qemu", node: "pve-hq-02", vmid: 301, status: "running" },
          { type: "storage", node: "pve-hq-01", storage: "local-lvm", disk: 410_000_000_000, maxdisk: 450_000_000_000 },
          { type: "storage", node: "pve-hq-01", storage: "local", disk: 20_000_000_000, maxdisk: 100_000_000_000 }
        ]);
      case "/api2/json/cluster/status":
        return send(200, [{ type: "cluster", name: "cl-hq", quorate: 1, nodes: 3 }]);
      case "/api2/json/status/datastore-usage":
        return send(200, [
          { store: "main", used: 3_700_000_000_000, total: 5_000_000_000_000 },
          { store: "nas-archive", used: 900_000_000_000, total: 1_000_000_000_000 }
        ]);
      case "/api2/json/nodes/localhost/tasks":
        return send(200, [
          { worker_type: "verify", worker_id: "nas-archive", status: "verification failed", endtime: Math.floor(Date.now() / 1000) - 3600 },
          { worker_type: "backup", worker_id: "vm/101", status: "OK", endtime: Math.floor(Date.now() / 1000) - 7200 }
        ]);
      case "/api2/json/statistics/mail":
        return send(200, { count_in: 1840, count_out: 96, spamin: 1216, viruscount_in: 3 });
      default:
        return send(404, null);
    }
  });
  return server;
}

export function listen(server) {
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
}
