/* Nachgebauter Proxmox Mail Gateway.

   Antwortet wie ein echtes Gerät — und zwar auch da, wo es unbequem ist:

   - **Eine Token-Kopfzeile wird abgewiesen.** Der echte PMG-Dienst tut
     genau das (`die "API tokens not implemented"`), obwohl seine eigene
     API-Dokumentation Token an jedem Endpunkt ausweist. Ein Testserver,
     der Token freundlich annimmt, hätte die Anbindung grün gemeldet,
     während gegen das echte Gerät jeder Abruf mit 401 endet.
   - Ein Ticket gilt und wird als Cookie erwartet, nicht als Kopfzeile.
   - **Ein Rumpf ohne `Content-Length` wird mit 501 abgewiesen.** Der
     HTTP-Dienst von Proxmox nimmt `Transfer-Encoding: chunked` nicht an
     (`$self->error($reqstate, 501, "chunked transfer encoding not
     supported")`, pve-http-server) — und Node schickt genau das, wenn
     man die Länge nicht ansagt. Ein Testserver, der chunked klaglos
     annimmt, meldet Grün, während am echten Gerät jede Anmeldung mit
     einer 501 endet, die wie ein Gerätefehler aussieht.
   - Ein Benutzername ohne Realm wird abgelehnt, wie es PMG tut: es hängt
     dann „@quarantine" an und findet das Konto nicht. */

import http from "node:http";

export const BENUTZER = "leitstand@pmg";
export const PASSWORT = "geheim";
const TICKET = "PMG:leitstand@pmg:5F2D3E4A::abcdef";

export function fakePmg(opt = {}) {
  const zustand = {
    /* Was der Test verstellen können muss, ohne den Server neu zu bauen. */
    dienste: opt.dienste || null,
    signaturStunden: opt.signaturStunden ?? 3,
    deferred: opt.deferred ?? 4,
    deferredAlt: opt.deferredAlt ?? 0,
    hold: opt.hold ?? 0,
    virusAus: opt.virusAus ?? 0,
    insync: opt.insync ?? 1,
    /* Angemeldet, aber das Gerät antwortet nicht mehr auf die lesenden
       Aufrufe — der Fall, in dem stehengebliebene Zahlen gefährlich
       werden, weil sie aussehen wie gemessene. */
    kaputt: opt.kaputt ?? false,
    anmeldungen: 0,
    chunked: 0,
    abrufe: []
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, data) => {
      const b = JSON.stringify({ data });
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
      res.end(b);
    };

    /* So streng wie pmgproxy: die Länge des Rumpfs gehört angesagt. */
    if (/chunked/i.test(req.headers["transfer-encoding"] || "")) {
      zustand.chunked++;
      return send(501, null);
    }

    /* Anmeldung */
    if (u.pathname === "/api2/json/access/ticket" && req.method === "POST") {
      let roh = "";
      req.on("data", c => { roh += c; });
      req.on("end", () => {
        const f = new URLSearchParams(roh);
        if (f.get("username") !== BENUTZER || f.get("password") !== PASSWORT) return send(401, null);
        zustand.anmeldungen++;
        send(200, { ticket: TICKET, username: BENUTZER, role: "audit", CSRFPreventionToken: "x" });
      });
      return;
    }

    /* Jeder lesende Abruf braucht das Cookie — eine Token-Kopfzeile nicht. */
    if (/APIToken=/.test(req.headers.authorization || "")) return send(401, null);
    const cookie = req.headers.cookie || "";
    const ticket = (/PMGAuthCookie=([^;]+)/.exec(cookie) || [])[1];
    if (ticket !== TICKET) return send(401, null);

    zustand.abrufe.push(u.pathname + (u.search || ""));
    if (zustand.kaputt) return send(500, null);
    const jetzt = Math.floor(Date.now() / 1000);

    switch (u.pathname) {
      case "/api2/json/version":
        return send(200, { version: "8.1.4", release: "8.1", repoid: "abc" });
      case "/api2/json/nodes":
        return send(200, [{ node: "pmg-01" }]);
      case "/api2/json/nodes/pmg-01/status":
        return send(200, {
          time: jetzt, uptime: 1_209_600, insync: zustand.insync,
          loadavg: ["0.18", "0.22", "0.19"],
          kversion: "Linux 6.8.12-4-pmg #1 SMP PREEMPT_DYNAMIC PMX 6.8.12-4",
          pmgversion: "pmg-api/8.1.4/abcdef",
          cpuinfo: { cpus: 4, cores: 4, sockets: 1, model: "Intel(R) Xeon(R) E-2224" },
          cpu: 0.07, wait: 0.01,
          memory: { total: 8_589_934_592, used: 3_435_973_836, free: 5_153_960_756 },
          swap: { total: 2_147_483_648, used: 0, free: 2_147_483_648 },
          rootfs: { total: 100_000_000_000, used: 42_000_000_000, avail: 53_000_000_000, free: 58_000_000_000 }
        });
      case "/api2/json/nodes/pmg-01/services":
        return send(200, zustand.dienste || [
          { service: "postfix", name: "postfix", desc: "Postfix Mail Transport Agent", state: "running", "active-state": "active", "unit-state": "enabled" },
          { service: "pmg-smtp-filter", name: "pmg-smtp-filter", desc: "Proxmox SMTP Filter", state: "running", "active-state": "active", "unit-state": "enabled" },
          { service: "pmgproxy", name: "pmgproxy", desc: "PMG API Proxy Server", state: "running", "active-state": "active", "unit-state": "enabled" },
          { service: "pmgdaemon", name: "pmgdaemon", desc: "PMG API Daemon", state: "running", "active-state": "active", "unit-state": "enabled" },
          { service: "pmgpolicy", name: "pmgpolicy", desc: "PMG Policy Daemon", state: "running", "active-state": "active", "unit-state": "enabled" },
          { service: "postgres", name: "postgres", desc: "PostgreSQL Cluster", state: "running", "active-state": "active", "unit-state": "enabled" },
          { service: "clamav-daemon", name: "clamav-daemon", desc: "Clam AntiVirus userspace daemon", state: "running", "active-state": "active", "unit-state": "enabled" },
          { service: "clamav-freshclam", name: "clamav-freshclam", desc: "ClamAV virus database updater", state: "running", "active-state": "active", "unit-state": "enabled" },
          /* Ein Zeitgeber ist „exited" und trotzdem in Ordnung — wer auf
             „läuft nicht" prüft, statt auf „fehlgeschlagen", meldet hier
             jede Nacht einen Ausfall. */
          { service: "pmg-daily", name: "pmg-daily", desc: "Daily PMG maintenance", state: "exited", "active-state": "inactive", "unit-state": "enabled" }
        ]);
      case "/api2/json/nodes/pmg-01/postfix/qshape": {
        const q = u.searchParams.get("queue") || "deferred";
        if (q === "active") return send(200, [{ domain: "TOTAL", total: 1, "5m": 1, "10m": 0, "20m": 0, "40m": 0, "80m": 0, "160m": 0, "320m": 0, "640m": 0, "1280m": 0, "1280m+": 0 }]);
        if (q === "hold") {
          if (!zustand.hold) return send(200, []);   /* leere Warteschlange: qshape gibt gar nichts aus */
          return send(200, [{ domain: "TOTAL", total: zustand.hold, "5m": 0, "10m": 0, "20m": 0, "40m": 0, "80m": 0, "160m": 0, "320m": 0, "640m": 0, "1280m": 0, "1280m+": zustand.hold }]);
        }
        if (!zustand.deferred) return send(200, []);
        const alt = zustand.deferredAlt;
        return send(200, [
          { domain: "TOTAL", total: zustand.deferred, "5m": Math.max(0, zustand.deferred - alt), "10m": 0, "20m": 0, "40m": 0, "80m": 0, "160m": 0, "320m": 0, "640m": 0, "1280m": 0, "1280m+": alt },
          { domain: "beispiel.de", total: zustand.deferred, "5m": Math.max(0, zustand.deferred - alt), "10m": 0, "20m": 0, "40m": 0, "80m": 0, "160m": 0, "320m": 0, "640m": 0, "1280m": 0, "1280m+": alt }
        ]);
      }
      case "/api2/json/statistics/mail":
        return send(200, {
          count: 1936, count_in: 1840, count_out: 96,
          spamcount_in: 1216, spamcount_out: 0,
          viruscount_in: 3, viruscount_out: zustand.virusAus,
          bytes_in: 2_400_000_000, bytes_out: 90_000_000,
          glcount: 240, rbl_rejects: 5100, pregreet_rejects: 830, spfcount: 12,
          bounces_in: 4, bounces_out: 2, junk_in: 7401, junk_out: 0,
          avptime: 0.43
        });
      case "/api2/json/statistics/virus":
        return send(200, [{ name: "Html.Phishing.Bank-1234", count: 2 }, { name: "Doc.Downloader.Emotet", count: 1 }]);
      case "/api2/json/statistics/domains":
        return send(200, [
          { domain: "kunde.de", count_in: 1200, count_out: 60, spamcount_in: 900, viruscount_in: 2, bytes_in: 1_500_000_000, bytes_out: 50_000_000 },
          { domain: "verein.org", count_in: 640, count_out: 36, spamcount_in: 316, viruscount_in: 1, bytes_in: 900_000_000, bytes_out: 40_000_000 }
        ]);
      case "/api2/json/quarantine/spamstatus":
        return send(200, { count: 812, avgbytes: 41_000, mbytes: 33.4, avgspam: 6.7 });
      case "/api2/json/quarantine/virusstatus":
        return send(200, { count: 9, avgbytes: 120_000, mbytes: 1.1 });
      case "/api2/json/nodes/pmg-01/clamav/database": {
        const d = new Date(Date.now() - zustand.signaturStunden * 3600_000);
        const monat = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
        const zz = n => String(n).padStart(2, "0");
        return send(200, [
          { name: "main", type: "ClamAV-VDB", build_time: "16 Mar 2024 23-17 +0000", version: "62", nsigs: 6_647_427 },
          { name: "daily", type: "ClamAV-VDB", version: "27412",
            build_time: `${d.getUTCDate()} ${monat} ${d.getUTCFullYear()} ${zz(d.getUTCHours())}-${zz(d.getUTCMinutes())} +0000`,
            nsigs: 2_066_311 }
        ]);
      }
      case "/api2/json/nodes/pmg-01/apt/update":
        return send(200, [{ Package: "pmg-api", OldVersion: "8.1.3", Version: "8.1.4", Title: "Proxmox Mail Gateway API" }]);
      default:
        return send(404, null);
    }
  });
  server.zustand = zustand;
  return server;
}

export function listen(server) {
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
}
