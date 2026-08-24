/* Nachgebauter Proxmox-Endpunkt für die Tests.
   Antwortet wie ein echter Cluster — inklusive 401 ohne Token
   und 403 bei zu schwachem Token. */

import http from "node:http";

export const GOOD = "PVEAPIToken=leitstand@pve!ro=1a2b3c4d-0000-1111-2222-333344445555";
export const WEAK = "PVEAPIToken=leitstand@pve!schwach=aaaa";

const TRENNER = { PVE: "=", PBS: ":" };

/* Zerlegt die Kopfzeile so, wie das jeweilige Produkt sie erwartet — und
   gibt nichts zurück, wenn das Trennzeichen nicht dazu passt. */
export function zerlegen(auth) {
  const m = /^(PVE|PBS)APIToken=(.+)$/.exec(auth || "");
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
        /* So, wie ein echter Cluster es liefert: laufende Gäste tragen
           Werte, gestoppte tragen Nullen (keine Messung!), und bei
           virtuellen Maschinen bleibt `disk` auf 0, weil der Wirt die
           Belegung im Gast nicht kennt. Eine Vorlage ist auch dabei. */
        return send(200, [
          { type: "qemu", node: "pve-hq-01", vmid: 101, name: "vm-web", status: "running",
            cpu: 0.12, maxcpu: 4, mem: 3_200_000_000, maxmem: 8_589_934_592,
            disk: 0, maxdisk: 68_719_476_736, uptime: 864_000, tags: "prod" },
          { type: "qemu", node: "pve-hq-01", vmid: 141, name: "vm-alt", status: "stopped",
            cpu: 0, maxcpu: 2, mem: 0, maxmem: 4_294_967_296, disk: 0, maxdisk: 34_359_738_368, uptime: 0 },
          { type: "qemu", node: "pve-hq-01", vmid: 900, name: "vorlage-debian", status: "stopped", template: 1,
            cpu: 0, maxcpu: 2, mem: 0, maxmem: 2_147_483_648, disk: 0, maxdisk: 8_589_934_592 },
          { type: "lxc",  node: "pve-hq-01", vmid: 201, name: "ct-dns", status: "running",
            cpu: 0.41, maxcpu: 2, mem: 400_000_000, maxmem: 1_073_741_824,
            disk: 2_000_000_000, maxdisk: 8_589_934_592, uptime: 3_600 },
          { type: "qemu", node: "pve-hq-02", vmid: 301, name: "vm-fremd", status: "running", cpu: 0.9, maxcpu: 8 },
          { type: "storage", node: "pve-hq-01", storage: "local-lvm", disk: 410_000_000_000, maxdisk: 450_000_000_000 },
          { type: "storage", node: "pve-hq-01", storage: "local", disk: 20_000_000_000, maxdisk: 100_000_000_000 }
        ]);
      case "/api2/json/cluster/status":
        return send(200, [{ type: "cluster", name: "cl-hq", quorate: 1, nodes: 3 }]);
      case "/api2/json/nodes/pve-hq-01/status":
        return send(200, {
          kversion: "Linux 6.8.12-4-pve #1 SMP PREEMPT_DYNAMIC PMX 6.8.12-4 (2026-06-02T14:00Z)",
          pveversion: "pve-manager/8.3.2/abc123",
          cpuinfo: { cpus: 16, cores: 8, sockets: 1, model: "AMD Ryzen 9 5950X" },
          loadavg: ["0.42", "0.51", "0.60"],
          rootfs: { used: 21_000_000_000, total: 100_000_000_000 },
          swap: { used: 0, total: 0 },
          uptime: 3_542_400
        });
      case "/api2/json/nodes/pve-hq-01/apt/update":
        /* Ein Knoten mit offenen Paketen. Ein Token ohne Sys.Audit bekäme
           hier 403 — der Sammler meldet dann „unbekannt" statt „keine". */
        return send(200, [
          { Package: "pve-manager", OldVersion: "8.3.1", Version: "8.3.2", Title: "Proxmox VE Verwaltung" },
          { Package: "openssl", OldVersion: "3.0.14", Version: "3.0.15", Title: "Kryptobibliothek" }
        ]);
      /* Zwei Aufträge, wie sie in einer gewachsenen Anlage nebeneinander
         stehen: einer als Kalenderausdruck neuerer Fassungen, einer noch
         als Wochentag plus Uhrzeit — und abgeschaltet. */
      case "/api2/json/cluster/backup":
        return send(200, [
          { id: "backup-1a2b3c4d-5678", enabled: 1, schedule: "02:00", storage: "pbs-main",
            mode: "snapshot", all: 1, comment: "Nacht — alles",
            "next-run": Math.floor(Date.now() / 1000) + 3600 },
          { id: "backup-9f8e7d6c-4321", enabled: 0, dow: "sat", starttime: "05:00", storage: "nas",
            mode: "stop", vmid: "101,102,103", comment: "Wochenende" }
        ]);
      /* Die Aufgabenliste eines Knotens. Der erste Lauf trägt die Kennung
         des Auftrags — neuere Proxmox-Fassungen schreiben sie hinein —,
         der letzte nicht: so sieht eine gemischte Anlage aus. */
      case "/api2/json/nodes/pve-hq-01/tasks":
        return send(200, [
          { upid: "UPID:pve-hq-01:0000A1:vzdump::root@pam:", type: "vzdump", id: "backup-1a2b3c4d-5678",
            node: "pve-hq-01", starttime: Math.floor(Date.now() / 1000) - 7800, endtime: Math.floor(Date.now() / 1000) - 7000, status: "OK" },
          { upid: "UPID:pve-hq-01:00009F:vzdump::root@pam:", type: "vzdump", id: "backup-1a2b3c4d-5678",
            node: "pve-hq-01", starttime: Math.floor(Date.now() / 1000) - 94000, endtime: Math.floor(Date.now() / 1000) - 93000,
            status: "job errors" },
          { upid: "UPID:pve-hq-01:00009A:vzdump::root@pam:", type: "vzdump", id: "",
            node: "pve-hq-01", starttime: Math.floor(Date.now() / 1000) - 180000, endtime: Math.floor(Date.now() / 1000) - 179000, status: "OK" }
        ]);
      /* Der zweite Knoten hat es heute Nacht nicht geschafft. */
      case "/api2/json/nodes/pve-hq-02/tasks":
        return send(200, [
          { upid: "UPID:pve-hq-02:0000B1:vzdump::root@pam:", type: "vzdump", id: "backup-1a2b3c4d-5678",
            node: "pve-hq-02", starttime: Math.floor(Date.now() / 1000) - 7800, endtime: Math.floor(Date.now() / 1000) - 7600,
            status: "unable to open file '/mnt/pbs/…' - No space left on device" },
          { upid: "UPID:pve-hq-02:0000AF:vzdump::root@pam:", type: "vzdump", id: "backup-1a2b3c4d-5678",
            node: "pve-hq-02", starttime: Math.floor(Date.now() / 1000) - 94000, endtime: Math.floor(Date.now() / 1000) - 93000, status: "OK" }
        ]);
      case "/api2/json/status/datastore-usage":
        /* So, wie PBS es liefert: `avail` steht daneben und ist bei ZFS
           nicht total − used. Die Schätzung, wann es voll ist, gibt es
           nur, wo genug Verlauf da ist — beim Archiv fehlt sie. */
        return send(200, [
          { store: "main", used: 3_700_000_000_000, total: 5_000_000_000_000, avail: 1_100_000_000_000,
            "estimated-full-date": Math.floor(Date.now() / 1000) + 9 * 86400 },
          { store: "nas-archive", used: 900_000_000_000, total: 1_000_000_000_000, avail: 100_000_000_000,
            "estimated-full-date": 0 }
        ]);
      case "/api2/json/admin/datastore":
        return send(200, [
          { store: "main", comment: "Tägliche Sicherung" },
          { store: "nas-archive", comment: null, maintenance: "read-only" }
        ]);
      case "/api2/json/nodes/localhost/tasks":
        /* Die Kennung einer Aufgabe trägt den Datastore vorn — außer bei
           älteren Sicherungsläufen, die nur den Gast nennen. Genau daran
           darf sich der Sammler keinen Datastore ausdenken. */
        return send(200, [
          { worker_type: "verify", worker_id: "nas-archive", status: "verification failed", endtime: Math.floor(Date.now() / 1000) - 3600 },
          { worker_type: "backup", worker_id: "main:host/web-01/2026-08-23T01:00:00Z", status: "OK", endtime: Math.floor(Date.now() / 1000) - 5400 },
          { worker_type: "garbage_collection", worker_id: "main", status: "OK", endtime: Math.floor(Date.now() / 1000) - 86_400 },
          { worker_type: "backup", worker_id: "vm/101", status: "OK", endtime: Math.floor(Date.now() / 1000) - 7200 }
        ]);
      default:
        return send(404, null);
    }
  });
  return server;
}

export function listen(server) {
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
}
