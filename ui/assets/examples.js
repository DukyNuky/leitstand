/* Leitstand — je ein Beispiel für das, was noch nicht angebunden ist.

   Dies sind KEINE Messwerte und werden nie als solche angezeigt. Jede
   Ansicht, die daraus zeichnet, kennzeichnet den Eintrag ausdrücklich als
   Beispiel und schreibt daneben, was fehlt, damit dort echte Werte stehen.

   Zweck: die Form dokumentieren, die der Server später liefern muss —
   dieselben Feldnamen, die api.js dann füllt. Sobald eine Stufe geliefert
   ist, verschwindet der zugehörige Block hier ersatzlos.

   Was hier fehlt, fehlt mit Absicht: Systeme, Standorte, Tunnel,
   Störungen und Zertifikate kommen ausschließlich vom laufenden Dienst.
   Für sie gibt es keine Beispieldaten — eine Überwachung, die im Zweifel
   etwas Erfundenes zeigt, ist schlimmer als eine, die schweigt. */

const EXAMPLES = {

  /* Stufe 4 — Alarm-Postfach (IMAP IDLE + Regelwerk) */
  mail: {
    id: "beispiel", from: "pbs@pbs-01.example.org", subject: "Verify job 'v-archiv' failed",
    time: "05:40", sev: "crit", parsed: true, rule: "Proxmox Backup Server",
    host: "pbs-01", incident: "INC-0001", read: true,
    raw: [
      "Datastore: archiv",
      "Job-ID:    v-archiv",
      "Status:    FAILED",
      "",
      "verify vm/141/2026-08-17T02:00:12Z",
      "  check drive-scsi0.img.fidx",
      "  ERROR: chunk 0f3a9c22...c81 has wrong checksum",
      "  verify vm/141 failed",
      "",
      "TASK ERROR: verification failed - please check the log for details"
    ].join("\n")
  },

  mailrule: {
    id: "beispiel", name: "Proxmox Backup Server",
    match: "from ~ /^pbs@/ · subject ~ /Verify job .* failed/",
    sev: "crit", target: "Störung + Push", hits: null, active: true
  },

  /* Stufe 6 — Benachrichtigungswege */
  route: {
    channel: "ntfy", to: "ntfy.example.org/leitstand", sev: "kritisch + Warnung",
    quiet: "nein", on: false
  },

  /* Stufe 3 — WireGuard über die Firewall-API */
  peer: {
    id: "beispiel", name: "laptop", device: "Notebook · Linux", site: null,
    status: "ok", handshake: 14, ip: "10.99.10.2", rx: "18,4 GB", tx: "3,1 GB",
    endpoint: "203.0.113.44:51820"
  },

  /* Stufe 3 — HAProxy-Statistik von der Firewall */
  haproxy: {
    id: "beispiel", host: "fw-01", site: null, status: "ok", frontends: 2, sessions: 126,
    ssl: "ACME/Let's Encrypt",
    backends: [
      { name: "be_cloud", servers: "2/2", status: "ok",   ms: 41,  route: "cloud.example.org" },
      { name: "be_wiki",  servers: "0/1", status: "crit", ms: null, route: "wiki.example.org" }
    ]
  }
};
