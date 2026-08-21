/* Nachgebaute Endpunkte für AdGuard Home und Portainer.

   Wie bei fake-proxmox.js: ein echter HTTP-Server, der antwortet wie das
   Gerät — samt 401 ohne Zugang und samt der Eigenheiten, an denen der
   Sammler sonst im Betrieb auffällt (Portainer filtert Listen nach
   Rechten, statt abzulehnen; AdGuard führt die Statistik über ein
   einstellbares Fenster). Geprüft wird damit der ganze Weg über HTTP,
   nicht eine Attrappe der eigenen Funktionen. */

import http from "node:http";

export const ADGUARD_USER = "leitstand";
export const ADGUARD_PASS = "geheim";
export const PORTAINER_TOKEN = "ptr_1a2b3c4d5e6f";

function json(res, code, data) {
  const b = JSON.stringify(data);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
  res.end(b);
}

export function listen(server) {
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
}

/* Keep-alive hält den Prozess sonst am Leben, nachdem der Test durch ist. */
export function close(server) {
  return new Promise(r => { server.closeAllConnections(); server.close(r); });
}

/* ---------- AdGuard Home ---------- */
export function fakeAdguard(opt = {}) {
  const {
    running = true, protection = true, filtering = true,
    avg = 0.0234,                       /* Sekunden, wie AdGuard es dokumentiert */
    einheit = "hours", eimer = 48,      /* Statistikfenster */
    proAnfragen = 100, proGeblockt = 20,
    statsStatus = 200,
    version = "v0.107.52"
  } = opt;

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || "";
    const erwartet = "Basic " + Buffer.from(`${ADGUARD_USER}:${ADGUARD_PASS}`).toString("base64");
    if (auth !== erwartet) return json(res, 401, { message: "Forbidden" });

    const u = new URL(req.url, "http://x");
    switch (u.pathname) {
      case "/control/status":
        return json(res, 200, {
          version, running, protection_enabled: protection,
          dns_addresses: ["10.0.0.5", "fd00::5"], dns_port: 53,
          dhcp_available: false, language: "de"
        });
      case "/control/stats":
        if (statsStatus !== 200) return json(res, statsStatus, { message: "no" });
        return json(res, 200, {
          time_units: einheit,
          num_dns_queries: proAnfragen * eimer,
          num_blocked_filtering: proGeblockt * eimer,
          avg_processing_time: avg,
          dns_queries: Array(eimer).fill(proAnfragen),
          blocked_filtering: Array(eimer).fill(proGeblockt),
          replaced_safebrowsing: Array(eimer).fill(0),
          top_queried_domains: [{ "example.org": 12 }]
        });
      case "/control/filtering/status":
        return json(res, 200, {
          enabled: filtering,
          filters: [
            { id: 1, enabled: true, name: "AdGuard DNS filter", rules_count: 61000, last_updated: "2026-08-20T04:00:00Z" },
            { id: 2, enabled: true, name: "EasyList", rules_count: 12000, last_updated: "2026-08-18T04:00:00Z" },
            { id: 3, enabled: false, name: "Alte Liste", rules_count: 4, last_updated: "2025-01-01T04:00:00Z" }
          ],
          whitelist_filters: [],
          user_rules: ["@@||example.org^"]
        });
      case "/control/dns_info":
        return json(res, 200, {
          upstream_dns: ["https://dns.quad9.net/dns-query", "# ein Kommentar", "  "],
          cache_size: 4194304, protection_enabled: protection
        });
      default:
        return json(res, 404, { message: "not found" });
    }
  });
  return server;
}

/* ---------- Portainer ---------- */
/* Vorgabe: zwei Umgebungen, die zweite antwortet nicht; in der ersten ein
   Container in der Neustartschleife und einer, den der Kernel wegen der
   Speichergrenze abgeräumt hat. */
export const UMGEBUNGEN = [
  {
    Id: 3, Name: "docker-hq", Type: 1, Status: 1,
    Snapshots: [{
      Time: Math.floor(Date.now() / 1000) - 120,
      DockerVersion: "27.3.1", RunningContainerCount: 14, StoppedContainerCount: 2,
      HealthyContainerCount: 11, UnhealthyContainerCount: 1, StackCount: 5,
      VolumeCount: 21, ImageCount: 40
    }]
  },
  {
    Id: 7, Name: "docker-rz", Type: 2, Status: 2,
    Snapshots: [{
      Time: Math.floor(Date.now() / 1000) - 9000,
      DockerVersion: "26.1.4", RunningContainerCount: 6, StoppedContainerCount: 0,
      HealthyContainerCount: 6, UnhealthyContainerCount: 0, StackCount: 2
    }]
  }
];

export const CONTAINER = [
  { Id: "aaa", Names: ["/leitstand"], State: "running", Status: "Up 3 days (healthy)", Image: "ghcr.io/x/leitstand" },
  { Id: "bbb", Names: ["/vaultwarden"], State: "running", Status: "Up 2 hours (unhealthy)", Image: "vaultwarden/server" },
  { Id: "ccc", Names: ["/paperless"], State: "restarting", Status: "Restarting (1) 12 seconds ago", Image: "paperless" },
  { Id: "ddd", Names: ["/jellyfin"], State: "exited", Status: "Exited (137) 4 minutes ago", Image: "jellyfin" },
  { Id: "eee", Names: ["/alt"], State: "exited", Status: "Exited (0) 3 weeks ago", Image: "alt" }
];

export function fakePortainer(opt = {}) {
  const {
    endpoints = UMGEBUNGEN,
    container = CONTAINER,
    stacks = [{ Id: 1, Name: "leitstand", Status: 1 }, { Id: 2, Name: "alt", Status: 2 }],
    systemStatus = true,            /* false = nur der alte /api/status */
    containerStatus = 200,
    stacksStatus = 200,
    version = "2.21.4"
  } = opt;

  const server = http.createServer((req, res) => {
    if (req.headers["x-api-key"] !== PORTAINER_TOKEN) return json(res, 401, { message: "Invalid API key" });

    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/system/status")
      return systemStatus ? json(res, 200, { Version: version, InstanceID: "abc" }) : json(res, 404, { message: "not found" });
    if (u.pathname === "/api/status") return json(res, 200, { Version: version });
    if (u.pathname === "/api/endpoints") return json(res, 200, endpoints);
    if (u.pathname === "/api/stacks")
      return stacksStatus === 200 ? json(res, 200, stacks) : json(res, stacksStatus, { message: "no" });

    const m = /^\/api\/endpoints\/(\d+)\/docker\/containers\/json$/.exec(u.pathname);
    if (m) {
      if (containerStatus !== 200) return json(res, containerStatus, { message: "no" });
      const id = Number(m[1]);
      /* Nur die erste Umgebung führt die auffälligen Container — sonst
         zählte der Test doppelt und merkte es nicht. */
      return json(res, 200, id === endpoints[0]?.Id ? container : []);
    }
    return json(res, 404, { message: "not found" });
  });
  return server;
}
