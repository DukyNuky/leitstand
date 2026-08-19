/* Leitstand — Beispielbestand (Rückfallebene).

   Wird vom Server überschrieben, sobald /api/state antwortet — siehe
   live.js. Ohne Server (Doppelklick auf index.html) bleibt es hierbei.

   Ursprünglich:
   Alle Werte sind erfunden. Struktur entspricht dem geplanten API-Schema
   (siehe docs/DATA-SOURCES.md), damit der Mockup 1:1 gegen echte Daten
   ausgetauscht werden kann. */

const DOMAIN = "kraemersippe.de";

let SITES = [
  { id:"hq",  name:"HQ Zuhause",        short:"HQ",  place:"Köln",           kind:"primary", isp:"Vodafone Kabel 1000/50", wan:"91.64.203.17",  wan6:"2a02:908:1a::/56", uptimeDays:212, primary:true },
  { id:"rz",  name:"RZ Falkenstein",    short:"RZ",  place:"Hetzner AX41",   kind:"remote",  isp:"Hetzner Online",         wan:"116.203.44.91", wan6:"2a01:4f8:1c1e::/64", uptimeDays:463 },
  { id:"elt", name:"Standort Eltern",   short:"ELT", place:"Bergisch Gladbach", kind:"remote", isp:"Telekom VDSL 250/40",  wan:"91.20.118.204", wan6:"—", uptimeDays:87 },
  { id:"bue", name:"Büro Aachen",       short:"BÜR", place:"Aachen",         kind:"remote",  isp:"NetAachen Glas 500/500", wan:"185.32.77.40",  wan6:"2a03:2260:11::/56", uptimeDays:151 },
  { id:"fh",  name:"Ferienhaus Eifel",  short:"FH",  place:"Monschau",       kind:"remote",  isp:"Telekom DSL 50/10",      wan:"—",             wan6:"—", uptimeDays:0, down:true }
];

/* ---------- Hosts ---------- */
let HOSTS = [
  /* Proxmox VE */
  { id:"pve-hq-01", name:"pve-hq-01", type:"pve", site:"hq", role:"Cluster-Node · Ryzen 9 5950X", ip:"10.10.1.11", url:"https://pve-hq-01.int."+DOMAIN+":8006",
    status:"ok", version:"8.3.2", cluster:"cl-hq", quorum:true, cpu:34, ram:61, disk:47, vms:14, lxc:9, uptime:"41 T", temp:52,
    hist:[28,31,35,30,38,42,36,33,30,34,37,34] },
  { id:"pve-hq-02", name:"pve-hq-02", type:"pve", site:"hq", role:"Cluster-Node · Dell R730", ip:"10.10.1.12", url:"https://pve-hq-02.int."+DOMAIN+":8006",
    status:"warn", version:"8.3.2", cluster:"cl-hq", quorum:true, cpu:72, ram:88, disk:64, vms:11, lxc:16, uptime:"41 T", temp:67,
    note:"RAM-Auslastung dauerhaft > 85 % — Ballooning greift nicht",
    hist:[55,62,70,74,69,78,81,86,88,84,87,88] },
  { id:"pve-hq-03", name:"pve-hq-03", type:"pve", site:"hq", role:"Cluster-Node · Intel NUC 13", ip:"10.10.1.13", url:"https://pve-hq-03.int."+DOMAIN+":8006",
    status:"ok", version:"8.3.2", cluster:"cl-hq", quorum:true, cpu:19, ram:44, disk:38, vms:6, lxc:12, uptime:"18 T", temp:48,
    hist:[15,18,22,17,19,25,21,18,16,20,19,19] },
  { id:"pve-rz-01", name:"pve-rz-01", type:"pve", site:"rz", role:"Standalone · Hetzner AX41-NVMe", ip:"10.30.1.10", url:"https://pve-rz-01."+DOMAIN+":8006",
    status:"ok", version:"8.2.7", cluster:"—", quorum:null, cpu:41, ram:57, disk:52, vms:9, lxc:7, uptime:"126 T", temp:44,
    note:"Update auf 8.3 ausstehend", hist:[38,42,45,40,44,39,43,41,46,42,40,41] },
  { id:"pve-elt-01", name:"pve-elt-01", type:"pve", site:"elt", role:"Standalone · HP EliteDesk 800", ip:"10.40.1.10", url:"https://pve-elt-01.int."+DOMAIN+":8006",
    status:"warn", version:"8.3.1", cluster:"—", quorum:null, cpu:23, ram:49, disk:91, vms:4, lxc:5, uptime:"63 T", temp:51,
    note:"local-lvm zu 91 % belegt — Snapshots aufräumen", hist:[20,22,25,21,24,23,26,22,20,24,23,23] },
  { id:"pve-bue-01", name:"pve-bue-01", type:"pve", site:"bue", role:"Standalone · Fujitsu TX1330", ip:"10.50.1.10", url:"https://pve-bue-01.int."+DOMAIN+":8006",
    status:"ok", version:"8.3.2", cluster:"—", quorum:null, cpu:28, ram:52, disk:44, vms:7, lxc:4, uptime:"94 T", temp:46,
    hist:[24,27,30,26,29,31,28,25,27,29,28,28] },

  /* Firewalls */
  { id:"fw-hq-01", name:"fw-hq-01", type:"opnsense", site:"hq", role:"OPNsense · CARP MASTER · HAProxy", ip:"10.10.0.1", url:"https://fw-hq-01.int."+DOMAIN,
    status:"ok", version:"25.1.4", update:null, ha:"MASTER", haPeer:"fw-hq-02", states:18432, statesMax:198000,
    thrIn:212, thrOut:64, wgPeers:9, uptime:"71 T", cpu:12, ram:38, haproxy:"haproxy-hq",
    hist:[180,205,240,198,221,265,310,244,212,198,230,212] },
  { id:"fw-hq-02", name:"fw-hq-02", type:"opnsense", site:"hq", role:"OPNsense · CARP BACKUP", ip:"10.10.0.2", url:"https://fw-hq-02.int."+DOMAIN,
    status:"warn", version:"25.1.3", update:"25.1.4", ha:"BACKUP", haPeer:"fw-hq-01", states:340, statesMax:198000,
    thrIn:3, thrOut:1, wgPeers:9, uptime:"71 T", cpu:4, ram:31,
    note:"Version weicht vom MASTER ab — Config-Sync meldet Warnung",
    hist:[3,4,3,5,4,3,4,6,3,4,3,3] },
  { id:"fw-rz-01", name:"fw-rz-01", type:"opnsense", site:"rz", role:"OPNsense · Standalone · HAProxy", ip:"10.30.0.1", url:"https://fw-rz-01."+DOMAIN,
    status:"ok", version:"25.1.4", update:null, ha:"—", states:9120, statesMax:120000,
    thrIn:88, thrOut:141, wgPeers:6, uptime:"126 T", cpu:9, ram:34, haproxy:"haproxy-rz",
    hist:[70,84,96,88,102,120,94,88,79,91,88,88] },
  { id:"fw-elt-01", name:"fw-elt-01", type:"opnsense", site:"elt", role:"OPNsense · Standalone", ip:"10.40.0.1", url:"https://fw-elt-01.int."+DOMAIN,
    status:"ok", version:"24.7.11", update:"25.1.4", ha:"—", states:2140, statesMax:96000,
    thrIn:31, thrOut:12, wgPeers:3, uptime:"63 T", cpu:7, ram:41,
    note:"Zwei Major-Versionen zurück", hist:[25,29,34,31,28,36,30,27,33,31,29,31] },
  { id:"pf-bue-01", name:"pf-bue-01", type:"pfsense", site:"bue", role:"pfSense CE · Standalone", ip:"10.50.0.1", url:"https://pf-bue-01.int."+DOMAIN,
    status:"ok", version:"2.7.2", update:null, ha:"—", states:4310, statesMax:98000,
    thrIn:54, thrOut:37, wgPeers:4, uptime:"151 T", cpu:11, ram:29,
    hist:[44,51,60,54,49,58,63,52,48,55,54,54] },
  { id:"pf-fh-01", name:"pf-fh-01", type:"pfsense", site:"fh", role:"pfSense CE · Standalone", ip:"10.60.0.1", url:"https://pf-fh-01.int."+DOMAIN,
    status:"crit", version:"2.7.2", update:null, ha:"—", states:0, statesMax:64000,
    thrIn:0, thrOut:0, wgPeers:2, uptime:"—", cpu:0, ram:0,
    note:"Nicht erreichbar seit 02:14 — WAN-Ausfall beim Provider bestätigt",
    hist:[18,21,17,19,22,14,0,0,0,0,0,0] },
  { id:"pf-lab-01", name:"pf-lab-01", type:"pfsense", site:"hq", role:"pfSense CE · Labor (nested)", ip:"10.10.9.1", url:"https://pf-lab-01.int."+DOMAIN,
    status:"idle", version:"2.8.0-BETA", update:null, ha:"—", states:96, statesMax:32000,
    thrIn:1, thrOut:0, wgPeers:1, uptime:"3 T", cpu:2, ram:18,
    note:"Testinstanz, absichtlich unüberwacht", hist:[1,0,2,1,1,0,1,2,1,0,1,1] },

  /* Storage / Backup / Mail */
  { id:"nas-hq-01", name:"nas-hq-01", type:"truenas", site:"hq", role:"TrueNAS SCALE · 8× 12 TB Z2", ip:"10.10.2.20", url:"https://nas-hq-01.int."+DOMAIN,
    status:"warn", version:"24.10.1", pool:"tank", poolUsed:68, scrub:"vor 6 Tagen · ok", smart:"1 Laufwerk auffällig",
    note:"/dev/sdg: 8 Current_Pending_Sector — Austausch einplanen", cpu:16, ram:71, uptime:"98 T",
    hist:[62,64,66,65,67,68,68,68,68,68,68,68] },
  { id:"pbs-hq-01", name:"pbs-hq-01", type:"pbs", site:"hq", role:"Proxmox Backup Server · lokal", ip:"10.10.2.30", url:"https://pbs-hq-01.int."+DOMAIN+":8007",
    status:"crit", version:"3.3.2", datastores:2, used:74, lastGood:"heute 03:12", failed:1,
    note:"Verify-Job 'nas-archive' fehlgeschlagen: Chunk-Prüfsumme ungültig",
    hist:[70,71,72,72,73,73,74,74,74,74,74,74] },
  { id:"pbs-rz-01", name:"pbs-rz-01", type:"pbs", site:"rz", role:"Proxmox Backup Server · Offsite-Sync", ip:"10.30.2.30", url:"https://pbs-rz-01."+DOMAIN+":8007",
    status:"ok", version:"3.3.2", datastores:1, used:58, lastGood:"heute 04:40", failed:0,
    hist:[52,53,54,55,55,56,57,57,58,58,58,58] },
  { id:"pmg-rz-01", name:"pmg-rz-01", type:"pmg", site:"rz", role:"Proxmox Mail Gateway", ip:"10.30.2.40", url:"https://pmg-rz-01."+DOMAIN+":8006",
    status:"ok", version:"8.1.4", in24:1840, spam:1216, virus:3, quarantine:212, queue:0,
    hist:[1620,1710,1880,1740,1920,2010,1840,1760,1690,1830,1840,1840] },
  { id:"mailcow-rz-01", name:"mailcow-rz-01", type:"mailcow", site:"rz", role:"Mailcow dockerized", ip:"10.30.2.50", url:"https://mail."+DOMAIN,
    status:"warn", version:"2025-02", queue:47, domains:6, mailboxes:23, storage:63, rbl:"UCEPROTECT L3",
    note:"47 Mails deferred an gmail.com — Greylisting oder Reputation prüfen",
    hist:[2,1,4,3,8,19,31,42,47,47,47,47] },

  /* Dienste */
  { id:"adguard-hq-01", name:"adguard-hq-01", type:"adguard", site:"hq", role:"AdGuard Home · primär", ip:"10.10.3.10", url:"https://dns1.int."+DOMAIN,
    status:"ok", version:"0.107.55", queries:184320, blockedPct:31.4, avgMs:14, top:"telemetry.microsoft.com",
    hist:[142,158,171,166,180,192,184,176,168,181,184,184] },
  { id:"adguard-hq-02", name:"adguard-hq-02", type:"adguard", site:"hq", role:"AdGuard Home · sekundär", ip:"10.10.3.11", url:"https://dns2.int."+DOMAIN,
    status:"ok", version:"0.107.55", queries:96140, blockedPct:29.8, avgMs:16, top:"app-measurement.com",
    hist:[88,91,94,90,96,99,96,93,89,95,96,96] },
  { id:"adguard-rz-01", name:"adguard-rz-01", type:"adguard", site:"rz", role:"AdGuard Home · Remote/DoH", ip:"10.30.3.10", url:"https://dns."+DOMAIN,
    status:"warn", version:"0.107.52", queries:41220, blockedPct:26.1, avgMs:212, top:"doubleclick.net",
    note:"Upstream 9.9.9.9 antwortet zeitweise > 500 ms", hist:[40,44,120,210,180,240,212,190,205,212,212,212] },
  { id:"ha-hq-01", name:"ha-hq-01", type:"hass", site:"hq", role:"Home Assistant OS", ip:"10.10.4.10", url:"https://ha.int."+DOMAIN,
    status:"info", version:"2025.2.4", entities:1284, unavailable:6, automations:97, integrations:41,
    note:"6 Entitäten nicht verfügbar (Zigbee-Repeater Werkstatt)", hist:[1,2,1,3,6,6,6,6,6,6,6,6] },

  /* Container */
  { id:"portainer-hq", name:"portainer-hq", type:"portainer", site:"hq", role:"Portainer CE · Docker Standalone", ip:"10.10.5.10", url:"https://portainer-hq.int."+DOMAIN+":9443",
    status:"ok", version:"2.27.1", stacks:12, containers:47, unhealthy:0, images:88,
    hist:[45,46,47,47,46,47,48,47,47,47,47,47] },
  { id:"portainer-nas", name:"portainer-nas", type:"portainer", site:"hq", role:"Portainer Agent · TrueNAS Apps", ip:"10.10.2.21", url:"https://portainer-nas.int."+DOMAIN+":9443",
    status:"ok", version:"2.27.1", stacks:6, containers:19, unhealthy:0, images:31,
    hist:[19,19,18,19,19,20,19,19,19,19,19,19] },
  { id:"portainer-rz", name:"portainer-rz", type:"portainer", site:"rz", role:"Portainer CE · Docker Standalone", ip:"10.30.5.10", url:"https://portainer-rz."+DOMAIN+":9443",
    status:"ok", version:"2.27.0", stacks:9, containers:34, unhealthy:0, images:52,
    hist:[33,34,34,33,34,35,34,34,34,34,34,34] },
  { id:"portainer-bue", name:"portainer-bue", type:"portainer", site:"bue", role:"Portainer CE · Docker Standalone", ip:"10.50.5.10", url:"https://portainer-bue.int."+DOMAIN+":9443",
    status:"warn", version:"2.26.1", stacks:5, containers:21, unhealthy:2, images:29,
    note:"2 Container in Restart-Schleife: paperless-gotenberg, paperless-tika",
    hist:[21,21,20,21,21,21,21,21,21,21,21,21] }
];

/* ---------- HAProxy ---------- */
let HAPROXY = [
  { id:"haproxy-hq", host:"fw-hq-01", site:"hq", status:"ok", frontends:4, sessions:126, ssl:"ACME/Let's Encrypt",
    backends:[
      { name:"be_ha",        servers:"1/1", status:"ok",   ms:23,  route:"ha."+DOMAIN },
      { name:"be_nextcloud", servers:"2/2", status:"ok",   ms:41,  route:"cloud."+DOMAIN },
      { name:"be_paperless", servers:"1/1", status:"ok",   ms:66,  route:"docs."+DOMAIN },
      { name:"be_vaultwarden",servers:"1/1",status:"ok",   ms:18,  route:"vault."+DOMAIN },
      { name:"be_grafana",   servers:"1/2", status:"warn", ms:130, route:"stats."+DOMAIN },
      { name:"be_jellyfin",  servers:"1/1", status:"ok",   ms:37,  route:"media."+DOMAIN }
    ]},
  { id:"haproxy-rz", host:"fw-rz-01", site:"rz", status:"warn", frontends:3, sessions:318, ssl:"ACME/Let's Encrypt",
    backends:[
      { name:"be_mailcow",   servers:"1/1", status:"ok",   ms:29,  route:"mail."+DOMAIN },
      { name:"be_webmail",   servers:"1/1", status:"ok",   ms:34,  route:"webmail."+DOMAIN },
      { name:"be_gitea",     servers:"1/1", status:"ok",   ms:22,  route:"git."+DOMAIN },
      { name:"be_uptime",    servers:"1/1", status:"ok",   ms:11,  route:"status."+DOMAIN },
      { name:"be_wiki",      servers:"0/1", status:"crit", ms:0,   route:"wiki."+DOMAIN }
    ]}
];

/* ---------- WireGuard ---------- */
let TUNNELS = [
  { id:"wg-hq-rz",  a:"hq",  b:"rz",  iface:"wg0", status:"ok",   handshake:22,  rx:"412 GB", tx:"188 GB", rtt:11, loss:0,   mtu:1420, keepalive:25, net:"10.99.0.0/30", hist:[11,12,10,11,13,11,10,12,11,11,12,11] },
  { id:"wg-hq-elt", a:"hq",  b:"elt", iface:"wg1", status:"warn", handshake:186, rx:"88 GB",  tx:"41 GB",  rtt:34, loss:2.4, mtu:1420, keepalive:25, net:"10.99.0.4/30", hist:[18,19,22,26,31,44,38,29,33,36,34,34],
    note:"Handshake älter als 3 Minuten, Paketverlust 2,4 % — DSL-Reconnect um 04:03" },
  { id:"wg-hq-bue", a:"hq",  b:"bue", iface:"wg2", status:"ok",   handshake:41,  rx:"204 GB", tx:"96 GB",  rtt:9,  loss:0,   mtu:1420, keepalive:25, net:"10.99.0.8/30", hist:[8,9,10,9,8,9,11,9,8,9,10,9] },
  { id:"wg-hq-fh",  a:"hq",  b:"fh",  iface:"wg3", status:"crit", handshake:9840,rx:"12 GB",  tx:"6 GB",   rtt:0,  loss:100, mtu:1420, keepalive:25, net:"10.99.0.12/30", hist:[24,26,25,27,0,0,0,0,0,0,0,0],
    note:"Kein Handshake seit 02:14 — Gegenstelle pf-fh-01 offline" },
  { id:"wg-rz-elt", a:"rz",  b:"elt", iface:"wg1", status:"ok",   handshake:58,  rx:"31 GB",  tx:"19 GB",  rtt:29, loss:0,   mtu:1420, keepalive:25, net:"10.99.0.16/30", hist:[27,29,31,28,30,29,28,31,29,30,29,29] },
  { id:"wg-rz-bue", a:"rz",  b:"bue", iface:"wg2", status:"ok",   handshake:77,  rx:"64 GB",  tx:"52 GB",  rtt:17, loss:0,   mtu:1420, keepalive:25, net:"10.99.0.20/30", hist:[16,17,18,17,16,18,19,17,16,17,18,17] }
];

let PEERS = [
  { id:"p1", name:"laptop-andreas",   device:"ThinkPad T14s · Linux", site:"hq",  status:"ok",   handshake:14,   ip:"10.99.10.2",  rx:"18,4 GB", tx:"3,1 GB",  endpoint:"84.118.9.44:51820" },
  { id:"p2", name:"pixel-andreas",    device:"Pixel 8 · Android",     site:"hq",  status:"ok",   handshake:96,   ip:"10.99.10.3",  rx:"6,2 GB",  tx:"1,4 GB",  endpoint:"149.86.203.7:38214" },
  { id:"p3", name:"ipad-wohnzimmer",  device:"iPad Air · iOS",        site:"hq",  status:"idle", handshake:74400,ip:"10.99.10.4",  rx:"2,1 GB",  tx:"0,4 GB",  endpoint:"—" },
  { id:"p4", name:"nb-service",       device:"Dell Latitude · Win11", site:"bue", status:"ok",   handshake:210,  ip:"10.99.10.11", rx:"41,8 GB", tx:"12,6 GB", endpoint:"185.32.77.40:51820" },
  { id:"p5", name:"tablet-werkstatt", device:"Galaxy Tab · Android",  site:"hq",  status:"warn", handshake:1980, ip:"10.99.10.12", rx:"0,9 GB",  tx:"0,2 GB",  endpoint:"84.118.9.44:51299" },
  { id:"p6", name:"handy-eltern",     device:"iPhone 13 · iOS",       site:"elt", status:"ok",   handshake:132,  ip:"10.99.10.21", rx:"3,4 GB",  tx:"0,8 GB",  endpoint:"91.20.118.204:51820" },
  { id:"p7", name:"backup-runner",    device:"Skript · restic",       site:"rz",  status:"ok",   handshake:31,   ip:"10.99.10.31", rx:"212 GB",  tx:"1,9 TB",  endpoint:"116.203.44.91:51820" }
];

/* ---------- Störungen ---------- */
let INCIDENTS = [
  { id:"INC-0412", sev:"crit", host:"pf-fh-01",     site:"fh", title:"Standort Ferienhaus nicht erreichbar",
    detail:"ICMP und WireGuard-Handshake seit 02:14 ohne Antwort. Provider-Störungsmeldung Telekom für Monschau aktiv (Ticket TS-88214, ETA 14:00).",
    src:"poll", ageMin:342, ack:false, first:"02:14", rule:"host.unreachable > 5m" },
  { id:"INC-0411", sev:"crit", host:"pbs-hq-01",    site:"hq", title:"Verify-Job fehlgeschlagen (nas-archive)",
    detail:"Datastore nas-archive: Chunk 0f3a…c81 mit ungültiger Prüfsumme. Betroffen: 2 Snapshots von vm/141 (docs-vm).",
    src:"mail", ageMin:196, ack:false, first:"05:40", rule:"mail.pbs.verify_failed" },
  { id:"INC-0410", sev:"warn", host:"wg-hq-elt",    site:"elt", title:"WireGuard-Tunnel instabil",
    detail:"Handshake-Alter 186 s, Paketverlust 2,4 %. Korreliert mit DSL-Reconnect um 04:03.",
    src:"poll", ageMin:171, ack:true, first:"06:05", rule:"wg.handshake > 180s" },
  { id:"INC-0409", sev:"warn", host:"nas-hq-01",    site:"hq", title:"SMART-Warnung /dev/sdg",
    detail:"8 Current_Pending_Sector, Tendenz steigend (vor 7 Tagen: 2). Pool tank läuft weiter redundant (Z2).",
    src:"mail", ageMin:640, ack:false, first:"gestern 22:30", rule:"mail.smartd.error" },
  { id:"INC-0408", sev:"warn", host:"mailcow-rz-01",site:"rz", title:"47 Mails in der Ausgangswarteschlange",
    detail:"Alle deferred an gmail.com, Fehler 421-4.7.28 (rate limited). IP steht zusätzlich auf UCEPROTECT L3.",
    src:"api",  ageMin:88, ack:false, first:"09:32", rule:"mailcow.queue > 25" },
  { id:"INC-0407", sev:"warn", host:"pve-elt-01",   site:"elt", title:"Speicher local-lvm zu 91 % belegt",
    detail:"Wachstum ~1,2 %/Tag. Prognose: voll in 7 Tagen. Größter Posten: 4 alte Snapshots von vm/302.",
    src:"poll", ageMin:410, ack:true, first:"04:10", rule:"storage.usage > 90%" },
  { id:"INC-0406", sev:"warn", host:"portainer-bue",site:"bue", title:"2 Container in Restart-Schleife",
    detail:"paperless-gotenberg und paperless-tika starten alle ~40 s neu. Exit-Code 137 (OOM).",
    src:"api",  ageMin:52, ack:false, first:"10:08", rule:"docker.restart_loop" },
  { id:"INC-0405", sev:"warn", host:"fw-hq-02",     site:"hq", title:"HA-Config-Sync meldet Abweichung",
    detail:"BACKUP läuft auf 25.1.3, MASTER auf 25.1.4. XMLRPC-Sync überträgt keine Paketstände.",
    src:"poll", ageMin:1450, ack:false, first:"gestern 11:20", rule:"carp.version_mismatch" },
  { id:"INC-0404", sev:"warn", host:"adguard-rz-01",site:"rz", title:"DNS-Upstream langsam",
    detail:"Ø 212 ms gegen 9.9.9.9 (Normalwert 18 ms). Fallback auf 1.1.1.1 nicht konfiguriert.",
    src:"poll", ageMin:120, ack:false, first:"09:00", rule:"dns.latency > 100ms" },
  { id:"INC-0403", sev:"warn", host:"haproxy-rz",   site:"rz", title:"Backend be_wiki ohne aktiven Server",
    detail:"Einziger Server 10.30.5.22:3000 seit 08:41 DOWN (L4 connect timeout). Container gestoppt?",
    src:"poll", ageMin:145, ack:false, first:"08:41", rule:"haproxy.backend_down" },
  { id:"INC-0402", sev:"info", host:"ha-hq-01",     site:"hq", title:"6 Entitäten nicht verfügbar",
    detail:"Alle hinter Zigbee-Router 'werkstatt-plug'. Vermutlich Stromausfall am Zwischenstecker.",
    src:"api",  ageMin:300, ack:true, first:"05:55", rule:"hass.entity_unavailable" }
];

/* ---------- Alarm-Postfach ---------- */
let MAILS = [
  { id:"m1", from:"pbs@pbs-hq-01.int."+DOMAIN, subject:"Verify job 'v-nas-archive' failed", time:"05:40", sev:"crit", parsed:true,
    rule:"Proxmox Backup Server", host:"pbs-hq-01", incident:"INC-0411", read:false,
    raw:"Datastore: nas-archive\nJob-ID:    v-nas-archive\nStatus:    FAILED\n\nverify vm/141/2026-08-17T02:00:12Z\n  check qemu-server.conf.blob\n  check drive-scsi0.img.fidx\n  ERROR: chunk 0f3a9c22...c81 has wrong checksum\n  verify vm/141 failed\n\nTASK ERROR: verification failed - please check the log for details" },
  { id:"m2", from:"smartd@nas-hq-01.int."+DOMAIN, subject:"SMART error (CurrentPendingSector) detected on /dev/sdg", time:"gestern 22:30", sev:"warn", parsed:true,
    rule:"smartd", host:"nas-hq-01", incident:"INC-0409", read:true,
    raw:"This message was generated by the smartd daemon running on:\n   host name:  nas-hq-01\n   DNS domain: int."+DOMAIN+"\n\nThe following warning/error was logged by the smartd daemon:\n\nDevice: /dev/sdg [SAT], 8 Currently unreadable (pending) sectors\n\nDevice info:\nWDC WD120EDAZ-11F3RA0, S/N:5PGX7A2B, FW:81.00A81, 12.0 TB" },
  { id:"m3", from:"root@pve-hq-01.int."+DOMAIN, subject:"vzdump backup status (pve-hq-01): backup successful", time:"03:12", sev:"ok", parsed:true,
    rule:"Proxmox vzdump", host:"pve-hq-01", incident:null, read:true,
    raw:"Details\n=======\nVMID  NAME              STATUS   TIME      SIZE     FILENAME\n101   docker-hq         ok       00:02:41  8.42GB   vzdump-qemu-101-2026_08_19-03_00_02.vma.zst\n104   gitea             ok       00:01:12  2.10GB   vzdump-qemu-104-2026_08_19-03_02_44.vma.zst\n141   docs-vm           ok       00:06:03  22.8GB   vzdump-qemu-141-2026_08_19-03_03_58.vma.zst\n\nTotal running time: 00:09:56\nTotal size: 33.32GB" },
  { id:"m4", from:"root@fw-hq-01.int."+DOMAIN, subject:"OPNsense: Configuration change by 'andreas'", time:"gestern 19:44", sev:"info", parsed:true,
    rule:"OPNsense Config-Change", host:"fw-hq-01", incident:null, read:true,
    raw:"Firewall: Rules changed\nUser: andreas (10.10.1.44)\nSection: filter\nDescription: Allow VLAN40 -> NAS SMB\nRevision: 1755641040.72" },
  { id:"m5", from:"mailcow@mail."+DOMAIN, subject:"[mailcow] Postfix queue above threshold (47)", time:"09:32", sev:"warn", parsed:true,
    rule:"Mailcow Watchdog", host:"mailcow-rz-01", incident:"INC-0408", read:false,
    raw:"Service: postfix-mailcow\nQueue size: 47 (threshold 25)\nOldest message: 41 minutes\n\nTop destination: gmail.com (44)\nLast error: 421-4.7.28 [116.203.44.91] Our system has detected an unusual\n rate of unsolicited mail originating from your IP address." },
  { id:"m6", from:"noreply@notifications.unifi.com", subject:"USW-Lite-8-PoE: Port 6 link down", time:"08:02", sev:"unparsed", parsed:false,
    rule:null, host:null, incident:null, read:false,
    raw:"Your UniFi device reported an event.\n\nSite: HQ Zuhause\nDevice: USW-Lite-8-PoE (Werkstatt)\nEvent: Port 6 (werkstatt-ap) link down\nTime: 2026-08-19 08:02:11 CEST" },
  { id:"m7", from:"root@pmg-rz-01."+DOMAIN, subject:"Proxmox Mail Gateway - Daily report", time:"06:00", sev:"ok", parsed:true,
    rule:"PMG Daily Report", host:"pmg-rz-01", incident:null, read:true,
    raw:"Mail Gateway Report für 2026-08-18\n\nEingehend:  1840 Mails / 214 MB\nSpam:       1216 (66,1 %)\nViren:      3\nQuarantäne: 212 Objekte\nAusgehend:  96 Mails / 18 MB\nQueue:      0" },
  { id:"m8", from:"acme@fw-rz-01."+DOMAIN, subject:"ACME client: certificate renewal reminder", time:"gestern 03:00", sev:"warn", parsed:true,
    rule:"ACME/Zertifikate", host:"fw-rz-01", incident:null, read:true,
    raw:"Certificate: *.int."+DOMAIN+"\nIssuer: Let's Encrypt R11\nExpires: 2026-08-30 (in 11 days)\nRenewal: scheduled 2026-08-23 03:00\nValidation: DNS-01 (Cloudflare)" }
];

let MAILRULES = [
  { id:"r1", name:"Proxmox Backup Server", match:"from ~ /^pbs@/ · subject ~ /Verify job .* failed/", sev:"crit", target:"Störung + Push", hits:14, active:true },
  { id:"r2", name:"Proxmox vzdump",        match:"subject ~ /vzdump backup status/", sev:"ableiten aus 'successful|failed'", target:"Backup-Status", hits:1284, active:true },
  { id:"r3", name:"smartd",                match:"from ~ /^smartd@/", sev:"warn", target:"Störung + Push", hits:6, active:true },
  { id:"r4", name:"Mailcow Watchdog",      match:"from = mailcow@mail."+DOMAIN, sev:"aus Betreff", target:"Störung", hits:31, active:true },
  { id:"r5", name:"OPNsense Config-Change",match:"subject ~ /Configuration change/", sev:"info", target:"Audit-Log", hits:212, active:true },
  { id:"r6", name:"PMG Daily Report",      match:"subject ~ /Mail Gateway.*report/i", sev:"ok", target:"Kennzahlen", hits:463, active:true },
  { id:"r7", name:"ACME/Zertifikate",      match:"subject ~ /certificate .*(renewal|expir)/i", sev:"warn", target:"Zertifikatsliste", hits:88, active:true },
  { id:"r8", name:"UniFi Events",          match:"—", sev:"—", target:"—", hits:0, active:false }
];

/* ---------- Zertifikate ---------- */
let CERTS = [
  { cn:"*.int."+DOMAIN, issuer:"Let's Encrypt R11", days:11,  where:"fw-hq-01 (HAProxy)", status:"warn" },
  { cn:"mail."+DOMAIN,  issuer:"Let's Encrypt R11", days:47,  where:"mailcow-rz-01",      status:"ok" },
  { cn:"cloud."+DOMAIN, issuer:"Let's Encrypt R11", days:62,  where:"fw-hq-01 (HAProxy)", status:"ok" },
  { cn:"git."+DOMAIN,   issuer:"Let's Encrypt R11", days:29,  where:"fw-rz-01 (HAProxy)", status:"warn" },
  { cn:"pve-hq-01",     issuer:"PVE Cluster CA",    days:308, where:"cl-hq intern",       status:"ok" },
  { cn:"vpn."+DOMAIN,   issuer:"Let's Encrypt R11", days:74,  where:"fw-rz-01",           status:"ok" }
];

/* ---------- Backups (24 h) ---------- */
let BACKUPS = [
  { job:"vzdump cl-hq täglich",     target:"pbs-hq-01/main",   last:"heute 03:12", size:"33,3 GB", status:"ok",   dur:"09:56" },
  { job:"vzdump pve-rz-01",         target:"pbs-rz-01/main",   last:"heute 02:30", size:"18,7 GB", status:"ok",   dur:"06:11" },
  { job:"vzdump pve-elt-01",        target:"pbs-hq-01/remote", last:"heute 02:00", size:"9,1 GB",  status:"ok",   dur:"04:02" },
  { job:"vzdump pve-bue-01",        target:"pbs-hq-01/remote", last:"heute 02:20", size:"12,4 GB", status:"ok",   dur:"05:19" },
  { job:"PBS Sync → Offsite",       target:"pbs-rz-01/sync",   last:"heute 04:40", size:"41,8 GB", status:"ok",   dur:"22:14" },
  { job:"Verify nas-archive",       target:"pbs-hq-01",        last:"heute 05:40", size:"—",       status:"crit", dur:"12:41" },
  { job:"TrueNAS Replication tank", target:"nas-rz (rsync)",   last:"heute 01:00", size:"2,1 TB",  status:"ok",   dur:"41:07" },
  { job:"Config-Backup sense (7×)", target:"git."+DOMAIN,      last:"heute 04:00", size:"1,2 MB",  status:"warn", dur:"00:22" }
];

/* ---------- Linkpage ---------- */
let LINKGROUPS = [
  { name:"Virtualisierung", links:[
    { n:"pve-hq-01",  u:"https://pve-hq-01.int."+DOMAIN+":8006",  h:"pve-hq-01" },
    { n:"pve-hq-02",  u:"https://pve-hq-02.int."+DOMAIN+":8006",  h:"pve-hq-02" },
    { n:"pve-hq-03",  u:"https://pve-hq-03.int."+DOMAIN+":8006",  h:"pve-hq-03" },
    { n:"pve-rz-01",  u:"https://pve-rz-01."+DOMAIN+":8006",      h:"pve-rz-01" },
    { n:"pve-elt-01", u:"https://pve-elt-01.int."+DOMAIN+":8006", h:"pve-elt-01" },
    { n:"pve-bue-01", u:"https://pve-bue-01.int."+DOMAIN+":8006", h:"pve-bue-01" }
  ]},
  { name:"Firewalls & VPN", links:[
    { n:"fw-hq-01 (MASTER)", u:"https://fw-hq-01.int."+DOMAIN, h:"fw-hq-01" },
    { n:"fw-hq-02 (BACKUP)", u:"https://fw-hq-02.int."+DOMAIN, h:"fw-hq-02" },
    { n:"fw-rz-01",          u:"https://fw-rz-01."+DOMAIN,     h:"fw-rz-01" },
    { n:"fw-elt-01",         u:"https://fw-elt-01.int."+DOMAIN,h:"fw-elt-01" },
    { n:"pf-bue-01",         u:"https://pf-bue-01.int."+DOMAIN,h:"pf-bue-01" },
    { n:"pf-fh-01",          u:"https://pf-fh-01.int."+DOMAIN, h:"pf-fh-01" },
    { n:"pf-lab-01",         u:"https://pf-lab-01.int."+DOMAIN,h:"pf-lab-01" }
  ]},
  { name:"Container", links:[
    { n:"Portainer HQ",       u:"https://portainer-hq.int."+DOMAIN+":9443",  h:"portainer-hq" },
    { n:"Portainer NAS",      u:"https://portainer-nas.int."+DOMAIN+":9443", h:"portainer-nas" },
    { n:"Portainer RZ",       u:"https://portainer-rz."+DOMAIN+":9443",      h:"portainer-rz" },
    { n:"Portainer Büro",     u:"https://portainer-bue.int."+DOMAIN+":9443", h:"portainer-bue" }
  ]},
  { name:"Storage & Backup", links:[
    { n:"TrueNAS SCALE", u:"https://nas-hq-01.int."+DOMAIN,        h:"nas-hq-01" },
    { n:"PBS lokal",     u:"https://pbs-hq-01.int."+DOMAIN+":8007",h:"pbs-hq-01" },
    { n:"PBS Offsite",   u:"https://pbs-rz-01."+DOMAIN+":8007",    h:"pbs-rz-01" }
  ]},
  { name:"Mail", links:[
    { n:"Mailcow Admin", u:"https://mail."+DOMAIN+"/admin",     h:"mailcow-rz-01" },
    { n:"Webmail (SOGo)",u:"https://mail."+DOMAIN+"/SOGo",      h:"mailcow-rz-01" },
    { n:"Mail Gateway",  u:"https://pmg-rz-01."+DOMAIN+":8006", h:"pmg-rz-01" },
    { n:"Quarantäne",    u:"https://pmg-rz-01."+DOMAIN+":8006/quarantine", h:"pmg-rz-01" }
  ]},
  { name:"DNS & Smart Home", links:[
    { n:"AdGuard primär",  u:"https://dns1.int."+DOMAIN, h:"adguard-hq-01" },
    { n:"AdGuard sekundär",u:"https://dns2.int."+DOMAIN, h:"adguard-hq-02" },
    { n:"AdGuard RZ/DoH",  u:"https://dns."+DOMAIN,      h:"adguard-rz-01" },
    { n:"Home Assistant",  u:"https://ha.int."+DOMAIN,   h:"ha-hq-01" }
  ]},
  { name:"Werkzeuge", links:[
    { n:"Vaultwarden",  u:"https://vault."+DOMAIN,  h:null },
    { n:"Gitea",        u:"https://git."+DOMAIN,    h:null },
    { n:"Uptime Kuma",  u:"https://status."+DOMAIN, h:null },
    { n:"Grafana",      u:"https://stats."+DOMAIN,  h:null },
    { n:"Wiki.js",      u:"https://wiki."+DOMAIN,   h:null },
    { n:"Paperless",    u:"https://docs."+DOMAIN,   h:null }
  ]},
  { name:"Extern", links:[
    { n:"Hetzner Robot",   u:"https://robot.hetzner.com",       h:null },
    { n:"Cloudflare DNS",  u:"https://dash.cloudflare.com",     h:null },
    { n:"Telekom Störung", u:"https://telekom.de/stoerung",     h:null },
    { n:"MXToolbox Blacklist", u:"https://mxtoolbox.com/blacklists.aspx", h:null }
  ]}
];

/* ---------- Integrationen (Einstellungen) ---------- */
let INTEGRATIONS = [
  { name:"Proxmox VE",           method:"API-Token (PVEAPIToken)", targets:6, every:"30 s", status:"ok",   note:"Rolle PVEAuditor, read-only" },
  { name:"Proxmox Backup Server",method:"API-Token",               targets:2, every:"5 min",status:"ok",   note:"Datastore- und Job-Status" },
  { name:"Proxmox Mail Gateway", method:"API-Token",               targets:1, every:"5 min",status:"ok",   note:"Statistik + Queue" },
  { name:"OPNsense",             method:"API Key/Secret",          targets:4, every:"30 s", status:"ok",   note:"core/firmware, wireguard, haproxy" },
  { name:"pfSense",              method:"SSH + pfSsh.php",         targets:3, every:"60 s", status:"warn", note:"pf-fh-01 seit 02:14 timeout" },
  { name:"WireGuard",            method:"über Firewall-API",       targets:7, every:"30 s", status:"ok",   note:"Handshake, RX/TX, Endpunkte" },
  { name:"AdGuard Home",         method:"HTTP Basic-Auth",         targets:3, every:"60 s", status:"ok",   note:"/control/stats" },
  { name:"Portainer",            method:"API-Token",               targets:4, every:"60 s", status:"ok",   note:"Endpoints, Stacks, Container" },
  { name:"TrueNAS SCALE",        method:"API-Key v2",              targets:1, every:"2 min",status:"ok",   note:"Pools, SMART, Replikation" },
  { name:"Mailcow",              method:"API-Key (read-only)",     targets:1, every:"2 min",status:"ok",   note:"Queue, Domains, Rspamd" },
  { name:"Home Assistant",       method:"Long-Lived Token",        targets:1, every:"60 s", status:"ok",   note:"/api/states, Automationen" },
  { name:"Alarm-Postfach",       method:"IMAP IDLE",               targets:1, every:"push", status:"ok",   note:"alarm@"+DOMAIN+" · 8 Regeln aktiv" },
  { name:"ICMP/TCP-Prüfung",     method:"eigener Prober",          targets:44,every:"15 s", status:"ok",   note:"Ping, Port, TLS-Ablauf" }
];

let ROUTES = [
  { channel:"ntfy (Self-hosted)", to:"ntfy."+DOMAIN+"/leitstand", sev:"kritisch + Warnung", quiet:"nein",            on:true },
  { channel:"Telegram-Bot",       to:"@leitstand_bot",            sev:"nur kritisch",       quiet:"22:00 – 07:00",   on:true },
  { channel:"E-Mail",             to:"andreas@"+DOMAIN,           sev:"alles ab Warnung",   quiet:"nein",            on:true },
  { channel:"Signal (signal-cli)",to:"+49 ***",                   sev:"nur kritisch",       quiet:"nein",            on:false }
];
