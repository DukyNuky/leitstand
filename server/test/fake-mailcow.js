/* Nachgebautes Mailcow.

   Streng an den Stellen, an denen das echte Gerät streng ist:

   - Ohne gültigen `X-API-Key` kommt eine **401** — und zwar mit dem
     Rumpf, den mailcow schickt.
   - Steht die Quell-IP nicht in „allow from", kommt **ebenfalls 401**,
     aber mit einer anderen Meldung: `api access denied for ip …`. Das
     ist der Fall, den man ohne diese Zeile stundenlang für einen
     falschen Schlüssel hält — deshalb lässt er sich hier auslösen.
   - Ein unbekannter Pfad antwortet 404 mit `route not found`, nicht mit
     einer leeren Liste. */

import http from "node:http";

export const KEY = "1A2B3C-4D5E6F-7A8B9C-0D1E2F-3A4B5C";

export function fakeMailcow(opt = {}) {
  const zustand = {
    ipVerweigert: opt.ipVerweigert ?? false,
    containerAus: opt.containerAus || [],     /* Namen, die nicht laufen */
    queue: opt.queue ?? null,                 /* eigene Warteschlange */
    vmailProzent: opt.vmailProzent ?? "42%",
    quarantaene: opt.quarantaene ?? 3,
    mailboxVoll: opt.mailboxVoll ?? 12,       /* Prozent des vollsten Postfachs */
    abrufe: []
  };

  const CONTAINER = [
    ["postfix-mailcow", "mailcow/postfix:1.78"], ["dovecot-mailcow", "mailcow/dovecot:1.29"],
    ["mysql-mailcow", "mariadb:10.11"], ["nginx-mailcow", "nginx:mainline-alpine"],
    ["php-fpm-mailcow", "mailcow/phpfpm:1.90"], ["rspamd-mailcow", "mailcow/rspamd:1.100"],
    ["redis-mailcow", "redis:7-alpine"], ["unbound-mailcow", "mailcow/unbound:1.22"],
    ["clamd-mailcow", "mailcow/clamd:1.66"], ["sogo-mailcow", "mailcow/sogo:1.126"],
    ["acme-mailcow", "mailcow/acme:1.87"], ["watchdog-mailcow", "mailcow/watchdog:2.05"],
    ["netfilter-mailcow", "mailcow/netfilter:1.61"], ["dockerapi-mailcow", "mailcow/dockerapi:2.09"]
  ];

  const jetzt = () => Math.floor(Date.now() / 1000);
  const queueVorgabe = () => ([
    { queue_name: "deferred", queue_id: "B98C6260CA1", arrival_time: jetzt() - 40 * 3600, message_size: 1848,
      sender: "buchhaltung@example.de", recipients: ["empfang@kunde.de (connect to mx.kunde.de[203.0.113.9]:25: Connection timed out)"] },
    { queue_name: "deferred", queue_id: "C11D7361DB2", arrival_time: jetzt() - 900, message_size: 24000,
      sender: "newsletter@example.de", recipients: ["leser@verein.org (host mx.verein.org said: 452 4.2.2 mailbox full)"] },
    { queue_name: "active", queue_id: "D22E8472EC3", arrival_time: jetzt() - 20, message_size: 5200,
      sender: "info@example.de", recipients: ["kontakt@partner.de"] }
  ]);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, data) => {
      const b = JSON.stringify(data);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
      res.end(b);
    };

    if ((req.headers["x-api-key"] || "") !== KEY)
      return send(401, { type: "error", msg: "authentication failed" });
    if (zustand.ipVerweigert)
      return send(401, { type: "error", msg: "api access denied for ip 10.0.0.7" });

    zustand.abrufe.push(u.pathname);

    switch (u.pathname) {
      case "/api/v1/get/status/version":
        return send(200, { version: "2026-03a" });

      case "/api/v1/get/status/containers": {
        const out = {};
        for (const [name, image] of CONTAINER) {
          out[name] = {
            type: "info", container: name, image,
            state: zustand.containerAus.includes(name) ? "exited" : "running",
            started_at: new Date(Date.now() - 9 * 86400_000).toISOString()
          };
        }
        return send(200, out);
      }

      case "/api/v1/get/mailq/all":
        return send(200, zustand.queue ?? queueVorgabe());

      case "/api/v1/get/status/vmail":
        return send(200, {
          type: "info", disk: "/dev/mapper/vg-vmail",
          total: "500G", used: "210G", used_percent: zustand.vmailProzent
        });

      case "/api/v1/get/status/host":
        return send(200, {
          cpu: { cores: 8, usage: 12.4 },
          memory: { total: 16_777_216_000, usage: 61.2, swap: [2_147_483_648, 0] },
          uptime: 3_542_400, system_time: "24.08.2026 22:41:07", architecture: "x86_64"
        });

      /* rspamd zählt seit seinem eigenen Start — die Laufzeit gehört
         deshalb zur Antwort und in jede Anzeige dieser Zahlen. */
      case "/api/v1/get/logs/rspamd-stats":
        return send(200, {
          version: "3.9.1", uptime: 604_800, scanned: 48_120, learned: 640,
          spam_count: 21_400, ham_count: 26_720, connections: 3,
          actions: { reject: 12_800, "soft reject": 900, "rewrite subject": 0, "add header": 8_600, greylist: 4_200, "no action": 26_720 }
        });

      case "/api/v1/get/domain/all":
        return send(200, [
          { domain_name: "example.de", active_int: 1, mboxes_in_domain: 12, max_num_mboxes_for_domain: 50,
            bytes_total: 42_000_000_000, msgs_total: 184_000, max_quota_for_domain: 100_000_000_000, backupmx_int: 0 },
          { domain_name: "verein.org", active_int: 1, mboxes_in_domain: 3, max_num_mboxes_for_domain: 10,
            bytes_total: 3_100_000_000, msgs_total: 9_400, max_quota_for_domain: 20_000_000_000, backupmx_int: 0 }
        ]);

      case "/api/v1/get/mailbox/reduced":
        return send(200, [
          { username: "voll@example.de", domain: "example.de", active_int: 1, quota: 5_368_709_120,
            quota_used: Math.round(5_368_709_120 * zustand.mailboxVoll / 100), percent_in_use: zustand.mailboxVoll,
            messages: 40_120, last_imap_login: jetzt() - 600, last_smtp_login: jetzt() - 3600 },
          { username: "ruhig@example.de", domain: "example.de", active_int: 1, quota: 5_368_709_120,
            quota_used: 268_435_456, percent_in_use: 5, messages: 1_204, last_imap_login: 0, last_smtp_login: 0 },
          /* Ohne gesetzte Quote schreibt mailcow „- " — das ist keine
             Null, sondern „unbegrenzt". */
          { username: "ohne-quote@verein.org", domain: "verein.org", active_int: 1, quota: 0,
            quota_used: 900_000_000, percent_in_use: "- ", messages: 3_400, last_imap_login: 0, last_smtp_login: 0 }
        ]);

      case "/api/v1/get/quarantine/all": {
        const liste = [];
        for (let i = 0; i < zustand.quarantaene; i++) {
          liste.push({
            id: i + 1, qid: `q${i}`, subject: "Ihre Rechnung", virus_flag: i === 0 ? 1 : 0,
            score: 14.2, rcpt: "empfang@example.de", sender: "spam@example.invalid",
            action: "reject", created: jetzt() - i * 1800, notified: 0
          });
        }
        return send(200, liste);
      }

      case "/api/v1/get/fail2ban":
        return send(200, {
          ban_time: 604800, max_attempts: 3, netban_ipv4: 32,
          perm_bans: [{ network: "45.82.153.37/32", ip: "45.82.153.37" }],
          active_bans: [
            { network: "203.0.113.44/32", ip: "203.0.113.44", banned_until: "12h 03m 40s", queued_for_unban: 0 },
            { network: "198.51.100.7/32", ip: "198.51.100.7", banned_until: "01h 12m 00s", queued_for_unban: 0 }
          ],
          whitelist: "10.0.0.0/8"
        });

      default:
        return send(404, { type: "error", msg: "route not found" });
    }
  });
  server.zustand = zustand;
  return server;
}

export function listen(server) {
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
}
