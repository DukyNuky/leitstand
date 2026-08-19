/* Leitstand — Mockup-Logik.
   Kein Framework, kein Build: Zustand -> HTML-String -> Delegation.
   Alle Aktionen sind simuliert; nichts verlässt den Browser. */

/* ============================================================
   Hilfsmittel
   ============================================================ */
const $  = (s, r=document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const byId = (arr, id) => arr.find(x => x.id === id);
const siteName = id => (SITES.find(s => s.id === id) || {}).name || "—";
const siteShort = id => (SITES.find(s => s.id === id) || {}).short || "—";

const SEV_ORDER = { crit:0, warn:1, info:2, ok:3, idle:4, unparsed:1 };
const SEV_LABEL = { crit:"Kritisch", warn:"Warnung", info:"Info", ok:"OK", idle:"Ruhend", unparsed:"Unverarbeitet" };

const TYPE_LABEL = {
  pve:"Proxmox VE", pbs:"Proxmox Backup", pmg:"Mail Gateway", opnsense:"OPNsense", pfsense:"pfSense",
  truenas:"TrueNAS", mailcow:"Mailcow", adguard:"AdGuard Home", hass:"Home Assistant", portainer:"Portainer"
};

function dot(s) { return `<span class="dot dot--${esc(s)}" title="${esc(SEV_LABEL[s] || s)}"></span>`; }
function chip(s, text) { return `<span class="chip chip--${esc(s)}">${esc(text ?? SEV_LABEL[s] ?? s)}</span>`; }

function tone(pct, warn=75, crit=90) { return pct >= crit ? "crit" : pct >= warn ? "warn" : "ok"; }

function meter(label, pct, opts={}) {
  const t = opts.tone || tone(pct, opts.warn, opts.crit);
  return `<div class="meter">
    <div class="meter-top"><span>${esc(label)}</span><b>${opts.text ?? pct + " %"}</b></div>
    <div class="bar" data-tone="${t}"><i style="width:${Math.max(2, Math.min(100, pct))}%"></i></div>
  </div>`;
}

/* Sparkline als Inline-SVG: Fläche + betonter Endpunkt. */
function spark(vals, opts={}) {
  const w = opts.w || 108, h = opts.h || 28, pad = 2;
  const max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  const span = (max - min) || 1;
  const x = i => pad + (i * (w - pad * 2)) / (vals.length - 1);
  const y = v => h - pad - ((v - min) / span) * (h - pad * 2);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const col = opts.color || "var(--accent)";
  const id = "sg" + Math.random().toString(36).slice(2, 8);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="${col}" stop-opacity=".28"/><stop offset="100%" stop-color="${col}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="${pad},${h - pad} ${pts} ${w - pad},${h - pad}" fill="url(#${id})"/>
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(vals[vals.length - 1]).toFixed(1)}" r="2.1" fill="${col}"/>
  </svg>`;
}

function ago(min) {
  if (min == null) return "—";
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${Math.round(min)} min`;
  if (min < 1440) return `vor ${Math.floor(min / 60)} h ${Math.round(min % 60)} min`;
  return `vor ${Math.floor(min / 1440)} T`;
}
function hs(sec) {
  if (sec >= 3600) return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
  if (sec >= 60) return `${Math.floor(sec / 60)} min ${sec % 60} s`;
  return `${sec} s`;
}
const SRC_LABEL = { mail:"E-Mail", poll:"Abfrage", api:"API", webhook:"Webhook" };

const ICON = {
  lage:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 13h4l2.5-7 4 14 2.5-7H21"/></svg>',
  sites:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/></svg>',
  compute:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01"/></svg>',
  netz:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l8 4v6c0 4-3.5 7-8 8-4.5-1-8-4-8-8V7z"/></svg>',
  vpn:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 11l7.6-3.8M8.2 13l7.6 3.8"/></svg>',
  dienste:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  post:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 7l9 6 9-6"/></svg>',
  links:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 13a5 5 0 007.5.5l2-2a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7.5-.5l-2 2a5 5 0 007 7l1-1"/></svg>',
  cfg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 006 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 15H3a2 2 0 110-4h.1A1.6 1.6 0 004.6 6l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 0010 3V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8v.1A1.6 1.6 0 0021 10h0a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/></svg>',
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  ext:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/></svg>'
};

const VIEWS = [
  { id:"lage",    label:"Lagebild",     icon:"lage",    group:"Übersicht" },
  { id:"sites",   label:"Standorte",    icon:"sites",   group:"Übersicht" },
  { id:"compute", label:"Compute",      icon:"compute", group:"Infrastruktur" },
  { id:"netz",    label:"Netz & Proxy", icon:"netz",    group:"Infrastruktur" },
  { id:"vpn",     label:"VPN-Tunnel",   icon:"vpn",     group:"Infrastruktur" },
  { id:"dienste", label:"Dienste",      icon:"dienste", group:"Infrastruktur" },
  { id:"post",    label:"Alarm-Postfach", icon:"post",  group:"Betrieb" },
  { id:"links",   label:"Startseite",   icon:"links",   group:"Betrieb" },
  { id:"cfg",     label:"Einstellungen",icon:"cfg",     group:"Betrieb" }
];

/* ============================================================
   Zustand
   ============================================================ */
const state = {
  view: "lage",
  site: "all",
  onlyProblems: false,
  q: "",
  mail: "m1",
  mailTab: "inbox",
  paletteOpen: false,
  paletteQ: "",
  paletteIdx: 0,
  inspector: null,
  incidents: INCIDENTS.map(i => ({ ...i })),
  mails: MAILS.map(m => ({ ...m })),
  hosts: HOSTS.map(h => ({ ...h })),
  tunnels: TUNNELS.map(t => ({ ...t })),
  injected: false
};

const inSite = o => state.site === "all" || o.site === state.site;
const isProblem = s => s === "crit" || s === "warn";
const openIncidents = () => state.incidents.filter(i => inSite(i) && i.sev !== "info");
const critCount = () => state.incidents.filter(i => i.sev === "crit" && !i.ack).length;
const warnCount = () => state.incidents.filter(i => i.sev === "warn" && !i.ack).length;
const unreadMails = () => state.mails.filter(m => !m.read).length;

function visibleHosts() {
  let hs = state.hosts.filter(inSite);
  if (state.onlyProblems) hs = hs.filter(h => isProblem(h.status));
  if (state.q) {
    const q = state.q.toLowerCase();
    hs = hs.filter(h => (h.name + h.role + h.ip + (TYPE_LABEL[h.type] || "")).toLowerCase().includes(q));
  }
  return hs;
}

/* ============================================================
   Rahmen
   ============================================================ */
function renderRail() {
  let out = "", lastGroup = null;
  for (const v of VIEWS) {
    if (v.group !== lastGroup) { out += `<div class="nav-label">${esc(v.group)}</div>`; lastGroup = v.group; }
    let badge = "";
    if (v.id === "lage" && critCount()) badge = `<span class="nav-badge">${critCount()}</span>`;
    if (v.id === "post" && unreadMails()) badge = `<span class="nav-badge" data-tone="warn">${unreadMails()}</span>`;
    if (v.id === "vpn") { const b = state.tunnels.filter(t => isProblem(t.status)).length; if (b) badge = `<span class="nav-badge" data-tone="warn">${b}</span>`; }
    out += `<button class="nav-item" data-action="view" data-view="${v.id}" aria-current="${state.view === v.id}">
      ${ICON[v.icon]}<span>${esc(v.label)}</span>${badge}</button>`;
  }
  return `<div class="nav">${out}</div>`;
}

function renderAlarmstrip() {
  const hostsUp = state.hosts.filter(h => h.status !== "crit").length;
  const tunOk = state.tunnels.filter(t => t.status === "ok").length;
  const bkOk = BACKUPS.filter(b => b.status === "ok").length;
  const certWarn = CERTS.filter(c => c.days <= 30).length;
  const cells = [
    { k:"Kritisch", v:critCount(), tone: critCount() ? "crit" : "ok", go:"lage", pulse: critCount() > 0 },
    { k:"Warnungen", v:warnCount(), tone: warnCount() ? "warn" : "ok", go:"lage" },
    { k:"Systeme", v:`${hostsUp}/${state.hosts.length}`, tone: hostsUp === state.hosts.length ? "ok" : "warn", go:"compute" },
    { k:"Tunnel", v:`${tunOk}/${state.tunnels.length}`, tone: tunOk === state.tunnels.length ? "ok" : "warn", go:"vpn" },
    { k:"Backups 24 h", v:`${bkOk}/${BACKUPS.length}`, tone: bkOk === BACKUPS.length ? "ok" : "warn", go:"dienste" },
    { k:"Zert. < 30 T", v:certWarn, tone: certWarn ? "warn" : "ok", go:"dienste" },
    { k:"Alarm-Mails", v:unreadMails(), tone: unreadMails() ? "warn" : "ok", go:"post" }
  ];
  return `<div class="alarmstrip">${cells.map(c => `
    <button class="alarmcell" data-tone="${c.tone}" data-action="view" data-view="${c.go}">
      ${c.pulse ? '<span class="pulse"></span>' : dot(c.tone)}
      <span>${esc(c.k)}</span><b>${esc(String(c.v))}</b>
    </button>`).join("")}</div>`;
}

function renderTopbar() {
  const v = VIEWS.find(x => x.id === state.view);
  const now = new Date().toLocaleTimeString("de-DE", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
  return `<div class="topbar">
    <div class="topbar-row">
      <div>
        <div class="view-kicker">${esc(v.group)}</div>
        <h1 class="view-title">${esc(v.label)}</h1>
      </div>
      <div class="spacer"></div>
      <div class="seg" role="group" aria-label="Standortfilter">
        <button data-action="site" data-site="all" aria-pressed="${state.site === "all"}">Alle</button>
        ${SITES.map(s => `<button data-action="site" data-site="${s.id}" aria-pressed="${state.site === s.id}" title="${esc(s.name)}">${esc(s.short)}</button>`).join("")}
      </div>
      <button class="btn" data-action="toggle-problems" aria-pressed="${state.onlyProblems}">
        ${dot(state.onlyProblems ? "warn" : "idle")} Nur Probleme
      </button>
      <div class="search">${ICON.search}<input id="q" placeholder="Host, IP, Dienst…" value="${esc(state.q)}" aria-label="Suchen"></div>
      <button class="btn" data-action="palette">⌘K</button>
      <button class="btn" data-action="theme" title="Hell/Dunkel umschalten">◐</button>
      <span class="mono faint" style="font-size:11px" title="Letzte Aktualisierung">${now}</span>
    </div>
    ${renderAlarmstrip()}
  </div>`;
}

/* ============================================================
   Ansicht: Lagebild
   ============================================================ */
function incidentRows(list) {
  if (!list.length) return `<tr><td colspan="6"><div class="empty">Keine offenen Meldungen für diese Auswahl.</div></td></tr>`;
  return list.map(i => `<tr data-sev="${i.sev}" data-ack="${i.ack}" data-action="inspect" data-kind="incident" data-id="${i.id}">
    <td class="sev">${dot(i.sev)}</td>
    <td><div>${esc(i.title)}</div><div class="t-sub mono">${esc(i.id)} · ${esc(i.rule)}</div></td>
    <td class="mono">${esc(i.host)}</td>
    <td>${chip("plain", siteShort(i.site))}</td>
    <td class="mono faint">${esc(SRC_LABEL[i.src])}</td>
    <td class="mono right">${esc(ago(i.ageMin))}${i.ack ? ' <span class="chip chip--plain">quittiert</span>' : ""}</td>
  </tr>`).join("");
}

function viewLage() {
  const inc = openIncidents().sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || a.ageMin - b.ageMin);
  const hosts = state.hosts.filter(inSite);
  const kpis = [
    { l:"Erreichbarkeit", v:`${Math.round(hosts.filter(h => h.status !== "crit").length / hosts.length * 100)} %`, s:`${hosts.filter(h => h.status === "crit").length} Systeme ohne Antwort`, t: hosts.some(h => h.status === "crit") ? "warn" : "ok", go:"compute" },
    { l:"Offene Störungen", v:critCount() + warnCount(), s:`${critCount()} kritisch · ${warnCount()} Warnung`, t: critCount() ? "crit" : "warn", go:"lage" },
    { l:"VPN-Tunnel", v:`${state.tunnels.filter(t => t.status === "ok").length}/${state.tunnels.length}`, s:"Site-to-Site WireGuard", t: state.tunnels.some(t => t.status === "crit") ? "crit" : "warn", go:"vpn" },
    { l:"Ø Tunnel-Latenz", v:`${Math.round(state.tunnels.filter(t => t.rtt).reduce((a, t) => a + t.rtt, 0) / state.tunnels.filter(t => t.rtt).length)} ms`, s:"über alle aktiven Strecken", t:"ok", go:"vpn" }
  ];

  const events = [
    { t:"10:08", s:"api",  txt:"Portainer Büro: <b>paperless-gotenberg</b> neu gestartet (Exit 137)", sev:"warn" },
    { t:"09:32", s:"mail", txt:"Mailcow-Watchdog: Queue über Schwellwert (47)", sev:"warn" },
    { t:"09:00", s:"poll", txt:"AdGuard RZ: Upstream-Latenz > 100 ms", sev:"warn" },
    { t:"08:41", s:"poll", txt:"HAProxy RZ: Backend <b>be_wiki</b> DOWN", sev:"warn" },
    { t:"08:02", s:"mail", txt:"UniFi-Ereignis ohne passende Regel eingegangen", sev:"info" },
    { t:"05:40", s:"mail", txt:"PBS: Verify-Job <b>nas-archive</b> fehlgeschlagen", sev:"crit" },
    { t:"04:40", s:"api",  txt:"PBS-Sync ins RZ abgeschlossen — 41,8 GB", sev:"ok" },
    { t:"03:12", s:"mail", txt:"vzdump cl-hq: 3 Gäste gesichert, 33,3 GB", sev:"ok" },
    { t:"02:14", s:"poll", txt:"Standort <b>Ferienhaus</b> nicht mehr erreichbar", sev:"crit" }
  ];

  return `
  <div class="grid g4">
    ${kpis.map(k => `<div class="panel"><button class="kpi" data-tone="${k.t}" data-action="view" data-view="${k.go}">
      <span class="kpi-label">${esc(k.l)}</span><span class="kpi-value">${esc(String(k.v))}</span><span class="kpi-sub">${esc(k.s)}</span>
    </button></div>`).join("")}
  </div>

  <div class="grid g-side">
    <div class="panel">
      <div class="panel-head"><h3>Offene Störungen</h3><span class="hint">nach Schwere</span>
        <div class="spacer"></div><span class="hint">Zeile anklicken für Details</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>Meldung</th><th>System</th><th>Standort</th><th>Quelle</th><th class="right">Alter</th></tr></thead>
        <tbody>${incidentRows(inc)}</tbody></table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Ereignisstrom</h3><span class="hint">heute</span></div>
      <div class="panel-body panel-body--flush"><div class="tl">
        ${events.map(e => `<div class="tl-item">
          <span class="tl-time">${esc(e.t)}</span>
          <span class="tl-rail">${dot(e.sev)}</span>
          <span><span class="tl-text">${e.txt}</span><br><span class="tl-src">${esc(SRC_LABEL[e.s])}</span></span>
        </div>`).join("")}
      </div></div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>Standorte</h3><span class="hint">WAN · Tunnel · Systeme</span></div>
    <div class="panel-body"><div class="grid g3">
      ${SITES.map(s => siteCard(s)).join("")}
    </div></div>
  </div>`;
}

function siteCard(s) {
  const hosts = state.hosts.filter(h => h.site === s.id);
  const bad = hosts.filter(h => isProblem(h.status)).length;
  const tuns = state.tunnels.filter(t => t.a === s.id || t.b === s.id);
  const st = s.down ? "crit" : bad ? "warn" : "ok";
  return `<div class="card" data-action="inspect" data-kind="site" data-id="${s.id}">
    <div class="card-head">
      <span style="padding-top:4px">${dot(st)}</span>
      <div style="min-width:0">
        <div class="card-title">${esc(s.name)}</div>
        <div class="card-meta">${esc(s.place)} · ${esc(s.isp)}</div>
      </div>
      <div class="spacer"></div>${chip("plain", s.short)}
    </div>
    <div class="stat-row">
      <div class="stat"><span class="stat-k">WAN</span><span class="stat-v">${esc(s.wan)}</span></div>
      <div class="stat"><span class="stat-k">Systeme</span><span class="stat-v">${hosts.length}${bad ? ` <span style="color:var(--warn)">▲${bad}</span>` : ""}</span></div>
      <div class="stat"><span class="stat-k">Tunnel</span><span class="stat-v">${tuns.filter(t => t.status === "ok").length}/${tuns.length}</span></div>
      <div class="stat"><span class="stat-k">Uptime</span><span class="stat-v">${s.uptimeDays ? s.uptimeDays + " T" : "—"}</span></div>
    </div>
  </div>`;
}

/* ============================================================
   Ansicht: Standorte
   ============================================================ */
function topoSvg() {
  const W = 760, H = 260, cx = W / 2, cy = H / 2;
  const spokes = SITES.filter(s => !s.primary);
  const pts = spokes.map((s, i) => {
    const a = (-90 + (360 / spokes.length) * i) * Math.PI / 180;
    return { s, x: cx + Math.cos(a) * 250, y: cy + Math.sin(a) * 95 };
  });
  const lines = pts.map(p => {
    const t = state.tunnels.find(t => (t.a === "hq" && t.b === p.s.id) || (t.b === "hq" && t.a === p.s.id));
    const col = !t ? "var(--idle)" : t.status === "ok" ? "var(--ok)" : t.status === "warn" ? "var(--warn)" : "var(--crit)";
    const dash = t && t.status === "crit" ? '6 5' : t && t.status === "warn" ? '3 3' : '0';
    return `<line x1="${cx}" y1="${cy}" x2="${p.x}" y2="${p.y}" stroke="${col}" stroke-width="1.8" stroke-dasharray="${dash}" opacity=".85"/>
      <text x="${(cx + p.x) / 2}" y="${(cy + p.y) / 2 - 6}" fill="var(--faint)" font-size="10" font-family="IBM Plex Mono, monospace" text-anchor="middle">${t ? (t.status === "crit" ? "kein Handshake" : t.rtt + " ms") : ""}</text>`;
  }).join("");
  const node = (x, y, s, big) => {
    const bad = s.down ? "crit" : state.hosts.filter(h => h.site === s.id && isProblem(h.status)).length ? "warn" : "ok";
    const col = `var(--${bad})`;
    const r = big ? 34 : 26;
    return `<g class="topo-node" data-action="inspect" data-kind="site" data-id="${s.id}" style="cursor:pointer">
      <rect x="${x - r}" y="${y - 20}" width="${r * 2}" height="40" rx="2" fill="var(--panel-2)" stroke="${col}" stroke-width="1.4"/>
      <text x="${x}" y="${y - 3}" text-anchor="middle" fill="var(--text)" font-size="12" font-family="Archivo, sans-serif" font-weight="600">${esc(s.short)}</text>
      <text x="${x}" y="${y + 11}" text-anchor="middle" fill="var(--faint)" font-size="9" font-family="IBM Plex Mono, monospace">${state.hosts.filter(h => h.site === s.id).length} Sys.</text>
    </g>`;
  };
  return `<svg class="topo" viewBox="0 0 ${W} ${H}" role="img" aria-label="Netztopologie: HQ als Zentrum, Standorte per WireGuard verbunden">
    ${lines}${pts.map(p => node(p.x, p.y, p.s)).join("")}${node(cx, cy, SITES[0], true)}
  </svg>`;
}

function viewSites() {
  const sites = state.site === "all" ? SITES : SITES.filter(s => s.id === state.site);
  return `
  <div class="panel">
    <div class="panel-head"><h3>Topologie</h3><span class="hint">WireGuard Site-to-Site</span>
      <div class="spacer"></div>
      <span class="legend">${dot("ok")} stabil ${dot("warn")} instabil ${dot("crit")} ausgefallen</span></div>
    <div class="panel-body">${topoSvg()}</div>
  </div>
  ${sites.map(s => {
    const hosts = state.hosts.filter(h => h.site === s.id);
    return `<div class="panel">
      <div class="panel-head">
        ${dot(s.down ? "crit" : hosts.some(h => isProblem(h.status)) ? "warn" : "ok")}
        <h3>${esc(s.name)}</h3><span class="hint">${esc(s.place)}</span>
        <div class="spacer"></div>
        <span class="mono faint" style="font-size:11.5px">${esc(s.isp)} · WAN ${esc(s.wan)} · IPv6 ${esc(s.wan6)}</span>
      </div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>System</th><th>Typ</th><th>Adresse</th><th>Version</th><th>Auslastung</th><th class="right">Verlauf</th></tr></thead><tbody>
        ${hosts.map(h => `<tr data-sev="${h.status}" data-action="inspect" data-kind="host" data-id="${h.id}">
          <td class="sev">${dot(h.status)}</td>
          <td><div class="mono">${esc(h.name)}</div><div class="t-sub">${esc(h.role)}</div></td>
          <td>${chip("plain", TYPE_LABEL[h.type] || h.type)}</td>
          <td class="mono faint">${esc(h.ip)}</td>
          <td class="mono">${esc(h.version || "—")}${h.update ? ` <span class="chip chip--warn">→ ${esc(h.update)}</span>` : ""}</td>
          <td style="min-width:160px">${h.cpu != null ? meter("CPU", h.cpu) : '<span class="faint">—</span>'}</td>
          <td class="right">${spark(h.hist || [1, 1, 1], { color: h.status === "crit" ? "var(--crit)" : h.status === "warn" ? "var(--warn)" : "var(--accent)" })}</td>
        </tr>`).join("")}
        </tbody></table>
      </div>
    </div>`;
  }).join("")}`;
}

/* ============================================================
   Ansicht: Compute
   ============================================================ */
function pveCard(h) {
  return `<div class="card" data-action="inspect" data-kind="host" data-id="${h.id}">
    <div class="card-head">
      <span style="padding-top:4px">${dot(h.status)}</span>
      <div><div class="card-title mono">${esc(h.name)}</div><div class="card-meta">${esc(h.role)}</div></div>
      <div class="spacer"></div>
      <div class="right"><div class="card-meta">${esc(h.cluster !== "—" ? h.cluster : "standalone")}</div>
      <div class="card-meta">v${esc(h.version)}</div></div>
    </div>
    <div class="col" style="gap:7px">
      ${meter("CPU", h.cpu)}${meter("RAM", h.ram)}${meter("Speicher", h.disk)}
    </div>
    <div class="stat-row">
      <div class="stat"><span class="stat-k">VMs</span><span class="stat-v">${h.vms}</span></div>
      <div class="stat"><span class="stat-k">LXC</span><span class="stat-v">${h.lxc}</span></div>
      <div class="stat"><span class="stat-k">Temp</span><span class="stat-v">${h.temp} °C</span></div>
      <div class="stat"><span class="stat-k">Laufzeit</span><span class="stat-v">${esc(h.uptime)}</span></div>
      <div class="spacer"></div>${spark(h.hist, { color: h.status === "warn" ? "var(--warn)" : "var(--accent)" })}
    </div>
    ${h.note ? `<div class="row" style="gap:7px;font-size:12px;color:var(--${h.status})">${dot(h.status)}<span>${esc(h.note)}</span></div>` : ""}
  </div>`;
}

function simpleRows(hosts, cols) {
  return hosts.map(h => `<tr data-sev="${h.status}" data-action="inspect" data-kind="host" data-id="${h.id}">
    <td class="sev">${dot(h.status)}</td>
    <td><div class="mono">${esc(h.name)}</div><div class="t-sub">${esc(h.role)}</div></td>
    <td>${chip("plain", siteShort(h.site))}</td>
    ${cols.map(c => `<td>${c(h)}</td>`).join("")}
  </tr>`).join("");
}

function viewCompute() {
  const hs = visibleHosts();
  const pve = hs.filter(h => h.type === "pve");
  const store = hs.filter(h => ["truenas", "pbs"].includes(h.type));
  const cont = hs.filter(h => h.type === "portainer");
  return `
  <div class="panel">
    <div class="panel-head"><h3>Proxmox VE</h3><span class="hint">${pve.length} Knoten · ${pve.reduce((a, h) => a + h.vms, 0)} VMs · ${pve.reduce((a, h) => a + h.lxc, 0)} Container</span></div>
    <div class="panel-body"><div class="grid g3">${pve.length ? pve.map(pveCard).join("") : '<div class="empty">Keine Treffer.</div>'}</div></div>
  </div>

  <div class="grid g2">
    <div class="panel">
      <div class="panel-head"><h3>Speicher & Sicherung</h3><span class="hint">TrueNAS · PBS</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>System</th><th>Standort</th><th>Belegung</th><th>Letzter Lauf</th></tr></thead><tbody>
        ${store.length ? simpleRows(store, [
          h => meter("", h.poolUsed ?? h.used, { text:(h.poolUsed ?? h.used) + " %" }),
          h => `<span class="mono">${esc(h.lastGood || h.scrub || "—")}</span>`
        ]) : '<tr><td colspan="5"><div class="empty">Keine Treffer.</div></td></tr>'}
        </tbody></table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Container-Plattformen</h3><span class="hint">Portainer</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>System</th><th>Standort</th><th>Stacks</th><th>Container</th><th>Ungesund</th></tr></thead><tbody>
        ${cont.length ? simpleRows(cont, [
          h => `<span class="mono">${h.stacks}</span>`,
          h => `<span class="mono">${h.containers}</span>`,
          h => h.unhealthy ? `<span class="chip chip--warn">${h.unhealthy}</span>` : `<span class="mono faint">0</span>`
        ]) : '<tr><td colspan="6"><div class="empty">Keine Treffer.</div></td></tr>'}
        </tbody></table>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>Sicherungsaufträge</h3><span class="hint">letzte 24 Stunden</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Auftrag</th><th>Ziel</th><th>Zuletzt</th><th>Umfang</th><th>Dauer</th></tr></thead><tbody>
      ${BACKUPS.map(b => `<tr data-sev="${b.status}">
        <td class="sev">${dot(b.status)}</td><td>${esc(b.job)}</td>
        <td class="mono faint">${esc(b.target)}</td><td class="mono">${esc(b.last)}</td>
        <td class="mono">${esc(b.size)}</td><td class="mono faint">${esc(b.dur)}</td></tr>`).join("")}
      </tbody></table>
    </div>
  </div>`;
}

/* ============================================================
   Ansicht: Netz & Proxy
   ============================================================ */
function viewNetz() {
  const fws = visibleHosts().filter(h => ["opnsense", "pfsense"].includes(h.type));
  const prox = HAPROXY.filter(p => state.site === "all" || p.site === state.site);
  return `
  <div class="panel">
    <div class="panel-head"><h3>Firewalls</h3>
      <span class="hint">${fws.filter(f => f.type === "opnsense").length}× OPNsense · ${fws.filter(f => f.type === "pfsense").length}× pfSense</span>
      <div class="spacer"></div><span class="hint">Zustandstabelle = aktive Verbindungen</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        <th style="width:34px"></th><th>Gerät</th><th>Standort</th><th>Version</th><th>HA/CARP</th>
        <th>Zustände</th><th>WAN ein/aus</th><th>WG-Peers</th><th class="right">Durchsatz</th></tr></thead><tbody>
      ${fws.length ? fws.map(f => `<tr data-sev="${f.status}" data-action="inspect" data-kind="host" data-id="${f.id}">
        <td class="sev">${dot(f.status)}</td>
        <td><div class="mono">${esc(f.name)}</div><div class="t-sub">${esc(f.role)}</div></td>
        <td>${chip("plain", siteShort(f.site))}</td>
        <td class="mono">${esc(f.version)}${f.update ? `<br><span class="chip chip--warn">→ ${esc(f.update)}</span>` : ""}</td>
        <td>${f.ha === "MASTER" ? chip("ok", "Master") : f.ha === "BACKUP" ? chip("info", "Backup") : '<span class="faint">—</span>'}</td>
        <td style="min-width:150px">${meter("", Math.round(f.states / f.statesMax * 100), { text: f.states.toLocaleString("de-DE") })}</td>
        <td class="mono">${f.thrIn} / ${f.thrOut} Mbit</td>
        <td class="mono">${f.wgPeers}</td>
        <td class="right">${spark(f.hist, { color: f.status === "crit" ? "var(--crit)" : f.status === "warn" ? "var(--warn)" : "var(--accent)" })}</td>
      </tr>`).join("") : '<tr><td colspan="9"><div class="empty">Keine Treffer.</div></td></tr>'}
      </tbody></table>
    </div>
  </div>

  <div class="grid g2">
    ${prox.map(p => `<div class="panel">
      <div class="panel-head">${dot(p.status)}<h3>HAProxy auf ${esc(p.host)}</h3>
        <span class="hint">${p.frontends} Frontends · ${p.sessions} Sitzungen</span>
        <div class="spacer"></div><span class="hint">${esc(p.ssl)}</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>Backend</th><th>Server</th><th>Veröffentlicht als</th><th class="right">Antwort</th></tr></thead><tbody>
        ${p.backends.map(b => `<tr data-sev="${b.status}">
          <td class="sev">${dot(b.status)}</td>
          <td class="mono">${esc(b.name)}</td>
          <td class="mono ${b.status === "ok" ? "" : "faint"}">${esc(b.servers)}</td>
          <td class="mono faint">${esc(b.route)}</td>
          <td class="right mono">${b.ms ? b.ms + " ms" : "—"}</td>
        </tr>`).join("")}
        </tbody></table>
      </div>
    </div>`).join("") || '<div class="panel"><div class="empty">Für diesen Standort ist kein HAProxy konfiguriert.</div></div>'}
  </div>`;
}

/* ============================================================
   Ansicht: VPN
   ============================================================ */
function viewVpn() {
  const tun = state.tunnels.filter(t => state.site === "all" || t.a === state.site || t.b === state.site);
  const peers = PEERS.filter(p => state.site === "all" || p.site === state.site);
  const ids = SITES.map(s => s.id);

  const matrix = `<table class="matrix"><thead><tr><th></th>${ids.map(i => `<th>${esc(siteShort(i))}</th>`).join("")}</tr></thead><tbody>
    ${ids.map(a => `<tr><th>${esc(siteShort(a))}</th>${ids.map(b => {
      if (a === b) return `<td><div class="mcell" data-s="none">·</div></td>`;
      const t = state.tunnels.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
      if (!t) return `<td><div class="mcell" data-s="none">–</div></td>`;
      return `<td><button class="mcell" data-s="${t.status}" data-action="inspect" data-kind="tunnel" data-id="${t.id}" title="${esc(siteName(a))} ↔ ${esc(siteName(b))}">${t.status === "crit" ? "×" : t.rtt + "ms"}</button></td>`;
    }).join("")}</tr>`).join("")}
  </tbody></table>`;

  return `
  <div class="grid g-side">
    <div class="panel">
      <div class="panel-head"><h3>Site-to-Site-Tunnel</h3><span class="hint">WireGuard</span>
        <div class="spacer"></div><span class="hint">Alarm ab 180 s ohne Handshake</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>Strecke</th><th>Interface</th><th>Letzter Handshake</th><th>Verlust</th><th>RX / TX</th><th class="right">Latenz</th></tr></thead><tbody>
        ${tun.length ? tun.map(t => `<tr data-sev="${t.status}" data-action="inspect" data-kind="tunnel" data-id="${t.id}">
          <td class="sev">${dot(t.status)}</td>
          <td><div>${esc(siteName(t.a))} <span class="faint">↔</span> ${esc(siteName(t.b))}</div><div class="t-sub mono">${esc(t.net)}</div></td>
          <td class="mono faint">${esc(t.iface)}</td>
          <td class="mono" style="color:var(--${t.status === "ok" ? "text" : t.status})">${esc(hs(t.handshake))}</td>
          <td class="mono">${t.loss} %</td>
          <td class="mono faint">${esc(t.rx)} / ${esc(t.tx)}</td>
          <td class="right">${t.rtt ? `<span class="mono">${t.rtt} ms</span> ` : ""}${spark(t.hist, { w:74, color: t.status === "crit" ? "var(--crit)" : t.status === "warn" ? "var(--warn)" : "var(--ok)" })}</td>
        </tr>`).join("") : '<tr><td colspan="7"><div class="empty">Keine Tunnel für diese Auswahl.</div></td></tr>'}
        </tbody></table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Verbindungsmatrix</h3><span class="hint">Latenz in ms</span></div>
      <div class="panel-body" style="overflow-x:auto">${matrix}
        <div class="legend" style="margin-top:12px">${dot("ok")} stabil ${dot("warn")} auffällig ${dot("crit")} kein Handshake <span class="faint">– keine Strecke</span></div>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>Endgeräte / Road-Warrior</h3><span class="hint">${peers.filter(p => p.status === "ok").length} von ${peers.length} aktiv</span>
      <div class="spacer"></div><span class="hint">Als ruhend gilt: > 12 h ohne Handshake</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Peer</th><th>Gerät</th><th>Terminiert auf</th><th>Tunnel-IP</th><th>Endpunkt</th><th>RX / TX</th><th class="right">Handshake</th></tr></thead><tbody>
      ${peers.map(p => `<tr data-sev="${p.status}" data-action="inspect" data-kind="peer" data-id="${p.id}">
        <td class="sev">${dot(p.status)}</td>
        <td class="mono">${esc(p.name)}</td>
        <td>${esc(p.device)}</td>
        <td>${chip("plain", siteShort(p.site))}</td>
        <td class="mono faint">${esc(p.ip)}</td>
        <td class="mono faint">${esc(p.endpoint)}</td>
        <td class="mono faint">${esc(p.rx)} / ${esc(p.tx)}</td>
        <td class="right mono">${esc(hs(p.handshake))}</td>
      </tr>`).join("")}
      </tbody></table>
    </div>
  </div>`;
}

/* ============================================================
   Ansicht: Dienste
   ============================================================ */
function serviceCard(h, body) {
  return `<div class="card" data-action="inspect" data-kind="host" data-id="${h.id}">
    <div class="card-head"><span style="padding-top:4px">${dot(h.status)}</span>
      <div><div class="card-title mono">${esc(h.name)}</div><div class="card-meta">${esc(h.role)}</div></div>
      <div class="spacer"></div>${chip("plain", siteShort(h.site))}</div>
    ${body}
    ${h.note ? `<div class="row" style="gap:7px;font-size:12px;color:var(--${h.status})">${dot(h.status)}<span>${esc(h.note)}</span></div>` : ""}
  </div>`;
}

function viewDienste() {
  const hs = visibleHosts();
  const ag = hs.filter(h => h.type === "adguard");
  const mail = hs.filter(h => ["mailcow", "pmg"].includes(h.type));
  const ha = hs.filter(h => h.type === "hass");

  return `
  <div class="panel">
    <div class="panel-head"><h3>DNS-Filter</h3><span class="hint">AdGuard Home</span>
      <div class="spacer"></div><span class="hint">${ag.reduce((a, h) => a + h.queries, 0).toLocaleString("de-DE")} Anfragen / 24 h</span></div>
    <div class="panel-body"><div class="grid g3">${ag.map(h => serviceCard(h, `
      <div class="stat-row">
        <div class="stat"><span class="stat-k">Anfragen 24 h</span><span class="stat-v">${(h.queries / 1000).toFixed(1)}k</span></div>
        <div class="stat"><span class="stat-k">Geblockt</span><span class="stat-v">${h.blockedPct} %</span></div>
        <div class="stat"><span class="stat-k">Ø Antwort</span><span class="stat-v" style="color:var(--${h.avgMs > 100 ? "warn" : "text"})">${h.avgMs} ms</span></div>
        <div class="spacer"></div>${spark(h.hist, { w:80, color: h.status === "warn" ? "var(--warn)" : "var(--accent)" })}
      </div>
      <div class="card-meta">Top-Blockade: <span class="mono">${esc(h.top)}</span></div>`)).join("") || '<div class="empty">Keine Treffer.</div>'}</div></div>
  </div>

  <div class="grid g2">
    <div class="panel">
      <div class="panel-head"><h3>Mail</h3><span class="hint">Mailcow · Proxmox Mail Gateway</span></div>
      <div class="panel-body"><div class="col">${mail.map(h => serviceCard(h, h.type === "mailcow" ? `
        <div class="col" style="gap:7px">${meter("Speicher", h.storage)}</div>
        <div class="stat-row">
          <div class="stat"><span class="stat-k">Warteschlange</span><span class="stat-v" style="color:var(--${h.queue > 25 ? "warn" : "text"})">${h.queue}</span></div>
          <div class="stat"><span class="stat-k">Domains</span><span class="stat-v">${h.domains}</span></div>
          <div class="stat"><span class="stat-k">Postfächer</span><span class="stat-v">${h.mailboxes}</span></div>
          <div class="stat"><span class="stat-k">RBL</span><span class="stat-v" style="color:var(--warn)">${esc(h.rbl)}</span></div>
          <div class="spacer"></div>${spark(h.hist, { w:80, color:"var(--warn)" })}
        </div>` : `
        <div class="stat-row">
          <div class="stat"><span class="stat-k">Eingang 24 h</span><span class="stat-v">${h.in24}</span></div>
          <div class="stat"><span class="stat-k">Spam</span><span class="stat-v">${h.spam}</span></div>
          <div class="stat"><span class="stat-k">Viren</span><span class="stat-v">${h.virus}</span></div>
          <div class="stat"><span class="stat-k">Quarantäne</span><span class="stat-v">${h.quarantine}</span></div>
          <div class="spacer"></div>${spark(h.hist, { w:80 })}
        </div>`)).join("") || '<div class="empty">Keine Treffer.</div>'}</div></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Smart Home</h3><span class="hint">Home Assistant</span></div>
      <div class="panel-body"><div class="col">${ha.map(h => serviceCard(h, `
        <div class="stat-row">
          <div class="stat"><span class="stat-k">Entitäten</span><span class="stat-v">${h.entities}</span></div>
          <div class="stat"><span class="stat-k">Nicht verfügbar</span><span class="stat-v" style="color:var(--info)">${h.unavailable}</span></div>
          <div class="stat"><span class="stat-k">Automationen</span><span class="stat-v">${h.automations}</span></div>
          <div class="stat"><span class="stat-k">Integrationen</span><span class="stat-v">${h.integrations}</span></div>
        </div>`)).join("") || '<div class="empty">Keine Treffer.</div>'}</div></div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>Zertifikate</h3><span class="hint">Ablaufüberwachung</span>
      <div class="spacer"></div><span class="hint">Warnung ab 30 Tagen</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Common Name</th><th>Aussteller</th><th>Terminiert auf</th><th>Restlaufzeit</th><th class="right"></th></tr></thead><tbody>
      ${CERTS.map(c => `<tr data-sev="${c.status}">
        <td class="sev">${dot(c.status)}</td><td class="mono">${esc(c.cn)}</td>
        <td class="faint">${esc(c.issuer)}</td><td class="mono faint">${esc(c.where)}</td>
        <td style="min-width:180px">${meter("", Math.max(3, Math.min(100, Math.round(c.days / 90 * 100))), { text: c.days + " Tage", tone: c.days <= 14 ? "crit" : c.days <= 30 ? "warn" : "ok" })}</td>
        <td class="right">${c.days <= 30 ? `<button class="btn btn--sm" data-action="renew" data-cn="${esc(c.cn)}">Erneuerung anstoßen</button>` : ""}</td>
      </tr>`).join("")}
      </tbody></table>
    </div>
  </div>`;
}

/* ============================================================
   Ansicht: Alarm-Postfach
   ============================================================ */
function viewPost() {
  if (state.mailTab === "rules") return viewPostRules();
  if (state.mailTab === "cfg") return viewPostCfg();
  const list = state.mails;
  const sel = byId(list, state.mail) || list[0];
  return `
  ${postTabs()}
  <div class="panel">
    <div class="panel-head"><h3>Posteingang</h3><span class="hint">alarm@kraemersippe.de</span>
      <div class="spacer"></div>
      <span class="hint">${unreadMails()} ungelesen · ${list.filter(m => !m.parsed).length} ohne Regel</span></div>
    <div class="panel-body panel-body--flush">
      <div class="mail-layout">
        <div class="mail-list">
          ${list.map(m => `<div class="mail-item" data-sev="${m.sev}" aria-selected="${sel && m.id === sel.id}" data-action="mail" data-id="${m.id}">
            <div class="mail-from"><span>${esc(m.from)}</span><span>${esc(m.time)}</span></div>
            <div class="mail-subj" style="${m.read ? "" : "font-weight:600"}">${esc(m.subject)}</div>
            <div class="row" style="gap:6px">
              ${m.parsed ? chip(m.sev) : chip("warn", "Keine Regel")}
              ${m.host ? `<span class="mono faint" style="font-size:10.5px">${esc(m.host)}</span>` : ""}
              ${m.incident ? `<span class="mono faint" style="font-size:10.5px">→ ${esc(m.incident)}</span>` : ""}
            </div>
          </div>`).join("")}
        </div>
        <div class="mail-body">
          ${sel ? `
          <div>
            <h2 style="font-size:17px">${esc(sel.subject)}</h2>
            <div class="mono faint" style="font-size:11.5px;margin-top:4px">${esc(sel.from)} · ${esc(sel.time)}</div>
          </div>
          <div class="panel" style="background:var(--panel-2)">
            <div class="panel-head" style="background:transparent"><h3>Auswertung</h3>
              <div class="spacer"></div>${sel.parsed ? chip(sel.sev) : chip("warn", "Keine Regel getroffen")}</div>
            <div class="panel-body">
              <dl class="kv">
                <dt>Regel</dt><dd>${sel.rule ? esc(sel.rule) : '<span class="faint">— unverarbeitet, Rohtext archiviert</span>'}</dd>
                <dt>System</dt><dd class="mono">${sel.host ? esc(sel.host) : '<span class="faint">nicht zugeordnet</span>'}</dd>
                <dt>Einstufung</dt><dd>${sel.parsed ? esc(SEV_LABEL[sel.sev]) : "—"}</dd>
                <dt>Störung</dt><dd>${sel.incident ? `<a href="#" data-action="inspect" data-kind="incident" data-id="${sel.incident}" class="mono">${esc(sel.incident)}</a>` : '<span class="faint">keine erzeugt</span>'}</dd>
                <dt>Benachrichtigt</dt><dd>${sel.sev === "crit" ? "ntfy, Telegram, E-Mail" : sel.sev === "warn" ? "ntfy, E-Mail" : '<span class="faint">nein</span>'}</dd>
              </dl>
            </div>
          </div>
          <div>
            <div class="sec-title">Rohtext</div>
            <pre class="raw">${esc(sel.raw)}</pre>
          </div>
          <div class="row row-wrap">
            ${sel.parsed
              ? `<button class="btn" data-action="toast" data-msg="Regel „${esc(sel.rule)}“ geöffnet">Regel bearbeiten</button>`
              : `<button class="btn btn--primary" data-action="mkrule" data-id="${sel.id}">Regel aus dieser Mail erstellen</button>`}
            <button class="btn" data-action="toast" data-msg="Absender ${esc(sel.from)} zur Positivliste hinzugefügt">Absender freigeben</button>
            <button class="btn" data-action="toast" data-msg="Mail archiviert">Archivieren</button>
          </div>` : '<div class="empty">Keine Nachricht ausgewählt.</div>'}
        </div>
      </div>
    </div>
  </div>`;
}

function postTabs() {
  const tabs = [["inbox", "Posteingang"], ["rules", "Regeln"], ["cfg", "Annahme & Versand"]];
  return `<div class="row"><div class="seg">${tabs.map(([id, l]) =>
    `<button data-action="mailtab" data-tab="${id}" aria-pressed="${state.mailTab === id}">${esc(l)}</button>`).join("")}</div>
    <div class="spacer"></div>
    <span class="faint" style="font-size:12px">Geräte melden per E-Mail — der Leitstand macht daraus Ampeln.</span></div>`;
}

function viewPostRules() {
  return `${postTabs()}
  <div class="panel">
    <div class="panel-head"><h3>Auswerteregeln</h3><span class="hint">${MAILRULES.filter(r => r.active).length} aktiv</span>
      <div class="spacer"></div><button class="btn btn--sm btn--primary" data-action="toast" data-msg="Regel-Editor geöffnet">Neue Regel</button></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Name</th><th>Bedingung</th><th>Einstufung</th><th>Wirkung</th><th>Treffer</th><th class="right">Aktiv</th></tr></thead><tbody>
      ${MAILRULES.map(r => `<tr data-sev="${r.active ? "ok" : "idle"}">
        <td class="sev">${dot(r.active ? "ok" : "idle")}</td>
        <td>${esc(r.name)}</td>
        <td class="mono faint" style="white-space:normal">${esc(r.match)}</td>
        <td>${r.sev === "—" ? '<span class="faint">—</span>' : esc(r.sev)}</td>
        <td class="faint">${esc(r.target)}</td>
        <td class="mono">${r.hits.toLocaleString("de-DE")}</td>
        <td class="right"><span class="switch" role="switch" aria-checked="${r.active}" data-action="toast" data-msg="Regel „${esc(r.name)}“ umgeschaltet"></span></td>
      </tr>`).join("")}
      </tbody></table>
    </div>
  </div>
  <div class="panel">
    <div class="panel-head"><h3>Verarbeitungskette</h3><span class="hint">von der Mail zur Ampel</span></div>
    <div class="panel-body">
      <div class="grid g4">
        ${[["IMAP IDLE", "Postfach alarm@ wird dauerhaft offen gehalten — neue Mail kommt ohne Verzögerung an."],
           ["Zuordnen", "Absender, Betreff und Rohtext werden gegen die Regeln geprüft und einem System zugeordnet."],
           ["Einstufen", "Die Regel setzt die Schwere; identische Meldungen werden zu einer Störung gebündelt."],
           ["Melden", "Ampel im Lagebild, Push nach Kanalregel, Rohtext bleibt 90 Tage durchsuchbar."]]
          .map(([t, d], i) => `<div class="card" style="cursor:default">
            <div class="card-meta mono">Schritt ${i + 1}</div>
            <div class="card-title">${esc(t)}</div>
            <div class="muted" style="font-size:12.5px">${esc(d)}</div></div>`).join("")}
      </div>
    </div>
  </div>`;
}

function viewPostCfg() {
  return `${postTabs()}
  <div class="grid g2">
    <div class="panel">
      <div class="panel-head"><h3>Annahme</h3><span class="hint">wohin die Geräte melden</span></div>
      <div class="panel-body"><dl class="kv">
        <dt>Adresse</dt><dd class="mono">alarm@kraemersippe.de</dd>
        <dt>Abholung</dt><dd>IMAP IDLE über <span class="mono">mail.kraemersippe.de:993</span> (TLS)</dd>
        <dt>Vorfilter</dt><dd>Proxmox Mail Gateway — Spam wird nie zugestellt</dd>
        <dt>Positivliste</dt><dd class="mono" style="white-space:normal">*@int.kraemersippe.de, *@kraemersippe.de, noreply@notifications.unifi.com</dd>
        <dt>Unbekannt</dt><dd>wird als „ohne Regel“ aufbewahrt statt verworfen</dd>
        <dt>Aufbewahrung</dt><dd>90 Tage Volltext, danach nur Kennzahlen</dd>
      </dl></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Sendende Systeme</h3><span class="hint">so hinterlegt</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th>System</th><th>Einstellung</th></tr></thead><tbody>
        ${[["Proxmox VE (6×)", "Datacenter → Notifications → SMTP-Ziel „leitstand“"],
           ["Proxmox Backup Server (2×)", "Notification-Matcher für verify/gc/sync"],
           ["Proxmox Mail Gateway", "Tagesbericht + Queue-Alarm"],
           ["OPNsense (4×)", "System → Settings → Notifications (SMTP)"],
           ["pfSense (3×)", "System → Advanced → Notifications"],
           ["TrueNAS SCALE", "Alert Services → E-Mail, Level ≥ WARNING"],
           ["Mailcow", "Watchdog-Benachrichtigung an alarm@"],
           ["smartd auf allen Hosts", "DEVICESCAN -m alarm@…"]]
          .map(([a, b]) => `<tr><td class="mono">${esc(a)}</td><td class="faint">${esc(b)}</td></tr>`).join("")}
        </tbody></table>
      </div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-head"><h3>Benachrichtigungswege</h3><span class="hint">wer wann gestört wird</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Kanal</th><th>Ziel</th><th>Ab Schwere</th><th>Ruhezeit</th><th class="right">Aktiv</th></tr></thead><tbody>
      ${ROUTES.map(r => `<tr data-sev="${r.on ? "ok" : "idle"}">
        <td class="sev">${dot(r.on ? "ok" : "idle")}</td><td>${esc(r.channel)}</td>
        <td class="mono faint">${esc(r.to)}</td><td>${esc(r.sev)}</td><td class="faint">${esc(r.quiet)}</td>
        <td class="right"><span class="switch" role="switch" aria-checked="${r.on}" data-action="toast" data-msg="Kanal ${esc(r.channel)} umgeschaltet"></span></td>
      </tr>`).join("")}
      </tbody></table>
    </div>
  </div>`;
}

/* ============================================================
   Ansicht: Startseite (Linkpage)
   ============================================================ */
function viewLinks() {
  const q = state.q.toLowerCase();
  const groups = LINKGROUPS.map(g => ({
    ...g,
    links: g.links.filter(l => {
      const h = l.h ? byId(state.hosts, l.h) : null;
      if (state.site !== "all" && (!h || h.site !== state.site)) return false;
      if (state.onlyProblems && !(h && isProblem(h.status))) return false;
      if (q && !(l.n + l.u).toLowerCase().includes(q)) return false;
      return true;
    })
  })).filter(g => g.links.length);

  if (!groups.length) return `<div class="panel"><div class="empty">Keine Verknüpfung passt zu Filter und Suche.</div></div>`;

  return `
  <div class="row row-wrap">
    <span class="faint" style="font-size:12.5px">Jede Kachel zeigt den Zustand des dahinterliegenden Systems — die Startseite ist gleichzeitig die Ampelwand.</span>
    <div class="spacer"></div>
    <span class="legend">${dot("ok")} erreichbar ${dot("warn")} auffällig ${dot("crit")} gestört ${dot("idle")} nicht überwacht</span>
  </div>
  ${groups.map(g => `<div class="panel">
    <div class="panel-head"><h3>${esc(g.name)}</h3><span class="hint">${g.links.length}</span>
      <div class="spacer"></div>
      <button class="btn btn--sm" data-action="toast" data-msg="${g.links.length} Tabs würden geöffnet — im Mockup deaktiviert">Alle öffnen</button></div>
    <div class="panel-body"><div class="linkgrid">
      ${g.links.map(l => {
        const h = l.h ? byId(state.hosts, l.h) : null;
        const st = h ? h.status : "idle";
        return `<a class="link" href="${esc(l.u)}" target="_blank" rel="noopener" title="${esc(l.u)}">
          <span class="link-mark" style="${h && isProblem(st) ? `border-color:var(--${st});color:var(--${st})` : ""}">${esc(l.n.slice(0, 2).toUpperCase())}</span>
          <span class="link-body"><span class="link-name">${esc(l.n)}</span><span class="link-url">${esc(l.u.replace(/^https?:\/\//, ""))}</span></span>
          <span style="margin-left:auto">${dot(st)}</span>
        </a>`;
      }).join("")}
    </div></div>
  </div>`).join("")}`;
}

/* ============================================================
   Ansicht: Einstellungen
   ============================================================ */
function viewCfg() {
  return `
  <div class="panel">
    <div class="panel-head"><h3>Datenquellen</h3><span class="hint">${INTEGRATIONS.length} Anbindungen · ${INTEGRATIONS.reduce((a, i) => a + i.targets, 0)} Ziele</span>
      <div class="spacer"></div><span class="hint">alle Zugänge nur lesend</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Quelle</th><th>Zugang</th><th>Ziele</th><th>Intervall</th><th>Hinweis</th><th class="right"></th></tr></thead><tbody>
      ${INTEGRATIONS.map(i => `<tr data-sev="${i.status}">
        <td class="sev">${dot(i.status)}</td><td>${esc(i.name)}</td>
        <td class="mono faint">${esc(i.method)}</td><td class="mono">${i.targets}</td>
        <td class="mono faint">${esc(i.every)}</td><td class="faint" style="white-space:normal">${esc(i.note)}</td>
        <td class="right"><button class="btn btn--sm" data-action="toast" data-msg="Verbindungstest für ${esc(i.name)} gestartet">Testen</button></td>
      </tr>`).join("")}
      </tbody></table>
    </div>
  </div>

  <div class="grid g2">
    <div class="panel">
      <div class="panel-head"><h3>Schwellwerte</h3><span class="hint">wann eine Ampel umspringt</span></div>
      <div class="panel-body"><dl class="kv">
        <dt>Host offline</dt><dd>3 Prüfungen à 15 s ohne Antwort → kritisch</dd>
        <dt>WG-Handshake</dt><dd>> 180 s → Warnung · > 600 s → kritisch</dd>
        <dt>Speicher</dt><dd>> 80 % Warnung · > 90 % kritisch</dd>
        <dt>RAM</dt><dd>> 85 % über 15 min → Warnung</dd>
        <dt>Zertifikate</dt><dd>< 30 Tage Warnung · < 14 Tage kritisch</dd>
        <dt>Mail-Queue</dt><dd>> 25 Warnung · > 100 kritisch</dd>
        <dt>Backup</dt><dd>kein Erfolg in 26 h → kritisch</dd>
        <dt>DNS-Latenz</dt><dd>> 100 ms im 5-min-Mittel → Warnung</dd>
      </dl></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Zugriff & Betrieb</h3><span class="hint">so läuft der Leitstand selbst</span></div>
      <div class="panel-body"><dl class="kv">
        <dt>Betrieb</dt><dd>Container auf <span class="mono">pve-hq-01</span>, gespiegelt auf <span class="mono">pve-rz-01</span></dd>
        <dt>Erreichbar</dt><dd class="mono">leitstand.int.kraemersippe.de</dd>
        <dt>Von außen</dt><dd>nur über WireGuard oder HAProxy mit mTLS</dd>
        <dt>Anmeldung</dt><dd>Authentik (OIDC) · Passkey · 2 Konten</dd>
        <dt>Geheimnisse</dt><dd>API-Token in Vaultwarden, Einbindung zur Laufzeit</dd>
        <dt>Zeitreihen</dt><dd>VictoriaMetrics, 400 Tage Vorhaltung</dd>
        <dt>Selbstüberwachung</dt><dd>Totmannschalter meldet an ntfy, wenn der Leitstand schweigt</dd>
      </dl></div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>Was dieser Mockup zeigt</h3><span class="hint">und was noch fehlt</span></div>
    <div class="panel-body"><div class="grid g2">
      <div>
        <div class="sec-title">Bereits im Entwurf</div>
        <ul class="muted" style="margin:0;padding-left:18px;line-height:1.9;font-size:13px">
          <li>Sammelalarm, Störungsliste, Quittieren und Stummschalten</li>
          <li>Standorte samt Topologie und Tunnelmatrix</li>
          <li>Compute, Firewalls, HAProxy-Backends, Dienste, Zertifikate</li>
          <li>Alarm-Postfach mit Regelwerk und Rohtext</li>
          <li>Startseite mit Zustandsampel je Verknüpfung</li>
        </ul>
      </div>
      <div>
        <div class="sec-title">Nächste Ausbaustufe</div>
        <ul class="muted" style="margin:0;padding-left:18px;line-height:1.9;font-size:13px">
          <li>Wartungsfenster, in denen keine Meldung ausgelöst wird</li>
          <li>Abhängigkeiten: Standort offline unterdrückt Folgemeldungen</li>
          <li>Zeitreihen-Detailseite je System (Grafana-Einbettung)</li>
          <li>Steuerbefehle: Dienst neu starten, Tunnel neu aushandeln</li>
          <li>Mobile Ansicht als Bereitschaftsbildschirm</li>
        </ul>
      </div>
    </div></div>
  </div>`;
}

/* ============================================================
   Inspector
   ============================================================ */
function inspectorContent(kind, id) {
  if (kind === "incident") {
    const i = byId(state.incidents, id); if (!i) return null;
    const h = byId(state.hosts, i.host);
    return {
      kicker:`Störung ${i.id}`, title:i.title, sev:i.sev,
      body:`
        <div><div class="sec-title">Beschreibung</div><p class="muted" style="margin:0">${esc(i.detail)}</p></div>
        <div><div class="sec-title">Eckdaten</div><dl class="kv">
          <dt>System</dt><dd class="mono">${esc(i.host)}</dd>
          <dt>Standort</dt><dd>${esc(siteName(i.site))}</dd>
          <dt>Erkannt</dt><dd>${esc(i.first)} (${esc(ago(i.ageMin))})</dd>
          <dt>Quelle</dt><dd>${esc(SRC_LABEL[i.src])}</dd>
          <dt>Regel</dt><dd class="mono">${esc(i.rule)}</dd>
          <dt>Status</dt><dd>${i.ack ? "quittiert" : "offen"}</dd>
        </dl></div>
        ${h ? `<div><div class="sec-title">Verlauf ${esc(h.name)}</div>${spark(h.hist, { w:460, h:70, color:`var(--${i.sev})` })}</div>` : ""}`,
      foot:`
        <button class="btn btn--primary" data-action="ack" data-id="${i.id}">${i.ack ? "Quittierung aufheben" : "Quittieren"}</button>
        <button class="btn" data-action="toast" data-msg="${esc(i.host)} für 2 Stunden stummgeschaltet">2 h stummschalten</button>
        ${h ? `<a class="btn" href="${esc(h.url)}" target="_blank" rel="noopener">${ICON.ext} System öffnen</a>` : ""}
        <button class="btn" data-action="toast" data-msg="Notiz zu ${esc(i.id)} gespeichert">Notiz</button>`
    };
  }
  if (kind === "host") {
    const h = byId(state.hosts, id); if (!h) return null;
    const inc = state.incidents.filter(x => x.host === h.id);
    const rows = [
      ["Typ", TYPE_LABEL[h.type] || h.type], ["Rolle", h.role], ["Standort", siteName(h.site)],
      ["Adresse", h.ip], ["Version", h.version + (h.update ? ` (Update ${h.update})` : "")],
      ["Laufzeit", h.uptime || "—"]
    ].filter(r => r[1] != null && r[1] !== "undefined");
    return {
      kicker:TYPE_LABEL[h.type] || h.type, title:h.name, sev:h.status,
      body:`
        ${h.note ? `<div class="row" style="gap:8px;align-items:flex-start">${dot(h.status)}<span style="color:var(--${h.status});font-size:13px">${esc(h.note)}</span></div>` : ""}
        <div><div class="sec-title">Stammdaten</div><dl class="kv">
          ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd class="${k === "Adresse" || k === "Version" ? "mono" : ""}">${esc(v)}</dd>`).join("")}
        </dl></div>
        ${h.cpu != null ? `<div><div class="sec-title">Auslastung</div><div class="col" style="gap:8px">
          ${meter("CPU", h.cpu)}${h.ram != null ? meter("RAM", h.ram) : ""}${h.disk != null ? meter("Speicher", h.disk) : ""}
        </div></div>` : ""}
        <div><div class="sec-title">Verlauf (12 h)</div>${spark(h.hist || [1, 1], { w:460, h:70, color:`var(--${h.status === "ok" ? "accent" : h.status})` })}</div>
        ${inc.length ? `<div><div class="sec-title">Offene Meldungen</div>${inc.map(i => `
          <div class="row" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer" data-action="inspect" data-kind="incident" data-id="${i.id}">
            ${dot(i.sev)}<span style="font-size:12.5px">${esc(i.title)}</span>
            <span class="spacer"></span><span class="mono faint" style="font-size:11px">${esc(i.id)}</span></div>`).join("")}</div>` : ""}`,
      foot:`
        <a class="btn btn--primary" href="${esc(h.url)}" target="_blank" rel="noopener">${ICON.ext} Oberfläche öffnen</a>
        <button class="btn" data-action="toast" data-msg="Abfrage für ${esc(h.name)} ausgelöst">Jetzt abfragen</button>
        <button class="btn" data-action="toast" data-msg="${esc(h.name)} für 2 Stunden stummgeschaltet">Stummschalten</button>`
    };
  }
  if (kind === "tunnel") {
    const t = byId(state.tunnels, id); if (!t) return null;
    return {
      kicker:"WireGuard-Tunnel", title:`${siteName(t.a)} ↔ ${siteName(t.b)}`, sev:t.status,
      body:`
        ${t.note ? `<div class="row" style="gap:8px;align-items:flex-start">${dot(t.status)}<span style="color:var(--${t.status});font-size:13px">${esc(t.note)}</span></div>` : ""}
        <div><div class="sec-title">Verbindung</div><dl class="kv">
          <dt>Interface</dt><dd class="mono">${esc(t.iface)}</dd>
          <dt>Transfernetz</dt><dd class="mono">${esc(t.net)}</dd>
          <dt>Letzter Handshake</dt><dd class="mono">${esc(hs(t.handshake))}</dd>
          <dt>Paketverlust</dt><dd class="mono">${t.loss} %</dd>
          <dt>Latenz</dt><dd class="mono">${t.rtt ? t.rtt + " ms" : "—"}</dd>
          <dt>Übertragen</dt><dd class="mono">${esc(t.rx)} empfangen · ${esc(t.tx)} gesendet</dd>
          <dt>MTU</dt><dd class="mono">${t.mtu}</dd>
          <dt>Keepalive</dt><dd class="mono">${t.keepalive} s</dd>
        </dl></div>
        <div><div class="sec-title">Latenzverlauf (12 h)</div>${spark(t.hist, { w:460, h:70, color:`var(--${t.status === "ok" ? "ok" : t.status})` })}</div>`,
      foot:`
        <button class="btn btn--primary" data-action="toast" data-msg="Neuaushandlung für ${esc(t.iface)} angestoßen">Neu aushandeln</button>
        <button class="btn" data-action="toast" data-msg="MTR von ${esc(siteName(t.a))} nach ${esc(siteName(t.b))} läuft">Route messen</button>
        <button class="btn" data-action="toast" data-msg="Konfiguration angezeigt">Konfiguration</button>`
    };
  }
  if (kind === "peer") {
    const p = byId(PEERS, id); if (!p) return null;
    return {
      kicker:"VPN-Endgerät", title:p.name, sev:p.status,
      body:`<div><div class="sec-title">Peer</div><dl class="kv">
        <dt>Gerät</dt><dd>${esc(p.device)}</dd>
        <dt>Terminiert auf</dt><dd>${esc(siteName(p.site))}</dd>
        <dt>Tunnel-IP</dt><dd class="mono">${esc(p.ip)}</dd>
        <dt>Endpunkt</dt><dd class="mono">${esc(p.endpoint)}</dd>
        <dt>Letzter Handshake</dt><dd class="mono">${esc(hs(p.handshake))}</dd>
        <dt>Übertragen</dt><dd class="mono">${esc(p.rx)} / ${esc(p.tx)}</dd>
      </dl></div>`,
      foot:`<button class="btn" data-action="toast" data-msg="QR-Code für ${esc(p.name)} erzeugt">Profil als QR</button>
        <button class="btn" data-action="toast" data-msg="Peer ${esc(p.name)} deaktiviert">Peer sperren</button>`
    };
  }
  if (kind === "site") {
    const s = SITES.find(x => x.id === id); if (!s) return null;
    const hosts = state.hosts.filter(h => h.site === s.id);
    const tuns = state.tunnels.filter(t => t.a === s.id || t.b === s.id);
    return {
      kicker:"Standort", title:s.name, sev: s.down ? "crit" : hosts.some(h => isProblem(h.status)) ? "warn" : "ok",
      body:`
        <div><div class="sec-title">Anbindung</div><dl class="kv">
          <dt>Ort</dt><dd>${esc(s.place)}</dd>
          <dt>Anschluss</dt><dd>${esc(s.isp)}</dd>
          <dt>WAN IPv4</dt><dd class="mono">${esc(s.wan)}</dd>
          <dt>WAN IPv6</dt><dd class="mono">${esc(s.wan6)}</dd>
          <dt>Stabil seit</dt><dd>${s.uptimeDays ? s.uptimeDays + " Tagen" : "—"}</dd>
        </dl></div>
        <div><div class="sec-title">Systeme (${hosts.length})</div>
          ${hosts.map(h => `<div class="row" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer" data-action="inspect" data-kind="host" data-id="${h.id}">
            ${dot(h.status)}<span class="mono" style="font-size:12.5px">${esc(h.name)}</span>
            <span class="spacer"></span><span class="faint" style="font-size:11.5px">${esc(TYPE_LABEL[h.type] || h.type)}</span></div>`).join("")}</div>
        <div><div class="sec-title">Tunnel (${tuns.length})</div>
          ${tuns.map(t => `<div class="row" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer" data-action="inspect" data-kind="tunnel" data-id="${t.id}">
            ${dot(t.status)}<span style="font-size:12.5px">nach ${esc(siteName(t.a === s.id ? t.b : t.a))}</span>
            <span class="spacer"></span><span class="mono faint" style="font-size:11.5px">${esc(hs(t.handshake))}</span></div>`).join("")}</div>`,
      foot:`<button class="btn btn--primary" data-action="site-filter" data-id="${s.id}">Auf diesen Standort filtern</button>
        <button class="btn" data-action="toast" data-msg="Wartungsfenster für ${esc(s.name)} angelegt">Wartungsfenster</button>`
    };
  }
  return null;
}

function renderInspector() {
  if (!state.inspector) return "";
  const c = inspectorContent(state.inspector.kind, state.inspector.id);
  if (!c) return "";
  return `<div class="scrim" data-action="close-inspector"></div>
  <aside class="inspector" role="dialog" aria-label="${esc(c.title)}">
    <div class="inspector-head">
      <span style="padding-top:5px">${dot(c.sev)}</span>
      <div style="min-width:0">
        <div class="view-kicker">${esc(c.kicker)}</div>
        <h2 style="font-size:17px">${esc(c.title)}</h2>
      </div>
      <div class="spacer"></div>
      <button class="btn btn--ghost" data-action="close-inspector" aria-label="Schließen">✕</button>
    </div>
    <div class="inspector-body">${c.body}</div>
    <div class="inspector-foot">${c.foot}</div>
  </aside>`;
}

/* ============================================================
   Kommandopalette
   ============================================================ */
function paletteItems() {
  const items = [];
  for (const v of VIEWS) items.push({ kind:"Ansicht", label:v.label, sub:v.group, run:() => go(v.id) });
  for (const h of state.hosts) items.push({ kind:"System", label:h.name, sub:`${TYPE_LABEL[h.type] || h.type} · ${siteShort(h.site)}`, run:() => open("host", h.id) });
  for (const s of SITES) items.push({ kind:"Standort", label:s.name, sub:s.place, run:() => open("site", s.id) });
  for (const t of state.tunnels) items.push({ kind:"Tunnel", label:`${siteShort(t.a)} ↔ ${siteShort(t.b)}`, sub:t.iface, run:() => open("tunnel", t.id) });
  for (const i of state.incidents) items.push({ kind:"Störung", label:i.title, sub:`${i.id} · ${i.host}`, run:() => open("incident", i.id) });
  for (const g of LINKGROUPS) for (const l of g.links) items.push({ kind:"Link", label:l.n, sub:l.u.replace(/^https?:\/\//, ""), run:() => window.open(l.u, "_blank", "noopener") });
  items.push({ kind:"Aktion", label:"Nur Probleme anzeigen", sub:"Filter umschalten", run:() => { state.onlyProblems = !state.onlyProblems; render(); } });
  items.push({ kind:"Aktion", label:"Hell/Dunkel umschalten", sub:"Darstellung", run:toggleTheme });
  items.push({ kind:"Aktion", label:"Alle Warnungen quittieren", sub:"Störungen", run:() => { state.incidents.forEach(i => { if (i.sev === "warn") i.ack = true; }); toast("Quittiert", "Alle Warnungen wurden quittiert.", "ok"); render(); } });
  return items;
}
function paletteFiltered() {
  const q = state.paletteQ.toLowerCase().trim();
  const all = paletteItems();
  if (!q) return all.slice(0, 9);
  return all.filter(i => (i.label + " " + i.sub + " " + i.kind).toLowerCase().includes(q)).slice(0, 40);
}
function renderPalette() {
  if (!state.paletteOpen) return "";
  const list = paletteFiltered();
  return `<div class="palette-scrim" data-action="close-palette">
    <div class="palette" role="dialog" aria-label="Kommandopalette">
      <input id="pq" placeholder="Springen zu… Host, Standort, Tunnel, Störung, Link" value="${esc(state.paletteQ)}" autocomplete="off">
      <div class="palette-list">
        ${list.length ? list.map((i, n) => `<div class="palette-row" aria-selected="${n === state.paletteIdx}" data-action="palette-run" data-idx="${n}">
          <span class="p-kind">${esc(i.kind)}</span><span>${esc(i.label)}</span><span class="p-sub">${esc(i.sub)}</span>
        </div>`).join("") : '<div class="empty">Nichts gefunden.</div>'}
      </div>
    </div>
  </div>`;
}

/* ============================================================
   Toasts
   ============================================================ */
function toast(title, msg, tone) {
  const el = document.createElement("div");
  el.className = "toast"; el.dataset.tone = tone || "";
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(msg)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

/* ============================================================
   Zeichnen & Verdrahten
   ============================================================ */
const RENDERERS = { lage:viewLage, sites:viewSites, compute:viewCompute, netz:viewNetz, vpn:viewVpn, dienste:viewDienste, post:viewPost, links:viewLinks, cfg:viewCfg };

function render() {
  const scroll = $("#scroll") ? $("#scroll").scrollTop : 0;
  $("#rail-nav").innerHTML = renderRail();
  $("#top").innerHTML = renderTopbar();
  $("#wrap").innerHTML = (RENDERERS[state.view] || viewLage)();
  $("#overlays").innerHTML = renderInspector() + renderPalette();
  if ($("#scroll")) $("#scroll").scrollTop = scroll;
  const pq = $("#pq");
  if (pq) { pq.focus(); pq.setSelectionRange(pq.value.length, pq.value.length); }
}

function go(view) { state.view = view; state.inspector = null; state.paletteOpen = false; location.hash = "#/" + view; render(); }
function open(kind, id) { state.inspector = { kind, id }; state.paletteOpen = false; render(); }
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "light" ? "dark" : cur === "dark" ? "light"
    : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", next);
  toast("Darstellung", next === "dark" ? "Dunkle Ansicht aktiv." : "Helle Ansicht aktiv.");
}

document.addEventListener("click", ev => {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;

  if (a === "close-palette" && ev.target !== el) return;      /* nur Klick auf den Schleier */

  switch (a) {
    case "view": ev.preventDefault(); go(el.dataset.view); break;
    case "site": state.site = el.dataset.site; state.inspector = null; render(); break;
    case "site-filter": state.site = el.dataset.id; state.inspector = null; go(state.view); break;
    case "toggle-problems": state.onlyProblems = !state.onlyProblems; render(); break;
    case "theme": toggleTheme(); break;
    case "palette": state.paletteOpen = true; state.paletteQ = ""; state.paletteIdx = 0; render(); break;
    case "close-palette": state.paletteOpen = false; render(); break;
    case "palette-run": { const it = paletteFiltered()[+el.dataset.idx]; state.paletteOpen = false; render(); if (it) it.run(); break; }
    case "inspect": ev.preventDefault(); open(el.dataset.kind, el.dataset.id); break;
    case "close-inspector": state.inspector = null; render(); break;
    case "mail": {
      const m = byId(state.mails, el.dataset.id);
      if (m) m.read = true;
      state.mail = el.dataset.id; render(); break;
    }
    case "mailtab": state.mailTab = el.dataset.tab; render(); break;
    case "mkrule": {
      const m = byId(state.mails, el.dataset.id);
      if (m) { m.parsed = true; m.rule = "UniFi Events"; m.sev = "warn"; m.host = "usw-lite-8-werkstatt"; }
      toast("Regel angelegt", "Künftige UniFi-Meldungen werden als Warnung eingestuft.", "ok");
      render(); break;
    }
    case "ack": {
      const i = byId(state.incidents, el.dataset.id);
      if (i) { i.ack = !i.ack; toast(i.ack ? "Quittiert" : "Quittierung aufgehoben", `${i.id} — ${i.title}`, i.ack ? "ok" : ""); }
      render(); break;
    }
    case "renew": toast("Erneuerung angestoßen", `ACME-Lauf für ${el.dataset.cn} eingeplant.`, "ok"); break;
    case "toast": toast("Erledigt", el.dataset.msg); break;
  }
});

document.addEventListener("input", ev => {
  if (ev.target.id === "q") { state.q = ev.target.value; const p = ev.target.selectionStart; render(); const q = $("#q"); if (q) { q.focus(); q.setSelectionRange(p, p); } }
  if (ev.target.id === "pq") { state.paletteQ = ev.target.value; state.paletteIdx = 0; render(); }
});

document.addEventListener("keydown", ev => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
    ev.preventDefault(); state.paletteOpen = true; state.paletteQ = ""; state.paletteIdx = 0; render(); return;
  }
  if (ev.key === "Escape") {
    if (state.paletteOpen) { state.paletteOpen = false; render(); }
    else if (state.inspector) { state.inspector = null; render(); }
    return;
  }
  if (state.paletteOpen) {
    const list = paletteFiltered();
    if (ev.key === "ArrowDown") { ev.preventDefault(); state.paletteIdx = Math.min(state.paletteIdx + 1, list.length - 1); render(); }
    if (ev.key === "ArrowUp") { ev.preventDefault(); state.paletteIdx = Math.max(state.paletteIdx - 1, 0); render(); }
    if (ev.key === "Enter") { ev.preventDefault(); const it = list[state.paletteIdx]; state.paletteOpen = false; render(); if (it) it.run(); }
    return;
  }
  if (!/^[1-9]$/.test(ev.key) || ev.target.tagName === "INPUT") return;
  const v = VIEWS[+ev.key - 1]; if (v) go(v.id);
});

window.addEventListener("hashchange", () => {
  const v = location.hash.replace("#/", "");
  if (RENDERERS[v] && v !== state.view) { state.view = v; render(); }
});

/* ============================================================
   Bewegung: leichte Schwankung + ein eingespieltes Ereignis
   ============================================================ */
const jitter = (v, amp, lo=0, hi=100) => Math.max(lo, Math.min(hi, Math.round(v + (Math.random() - .5) * amp)));

setInterval(() => {
  if (state.paletteOpen || document.activeElement === $("#q")) return;
  for (const h of state.hosts) {
    if (h.status === "crit" && h.cpu === 0) continue;
    if (h.cpu != null) h.cpu = jitter(h.cpu, 6);
    if (h.hist) h.hist = [...h.hist.slice(1), jitter(h.hist[h.hist.length - 1], Math.max(4, h.hist[h.hist.length - 1] * .12))];
  }
  for (const t of state.tunnels) {
    if (t.status === "crit") { t.handshake += 8; continue; }
    t.handshake = t.status === "warn" ? jitter(t.handshake, 30, 120, 400) : jitter(t.handshake, 20, 8, 150);
    t.rtt = jitter(t.rtt, 3, 5, 90);
    t.hist = [...t.hist.slice(1), t.rtt];
  }
  render();
}, 8000);

/* Nach kurzer Zeit trifft eine Alarm-Mail ein — zeigt den Weg
   Gerät -> Postfach -> Regel -> Störung -> Ampel in einem Rutsch. */
setTimeout(() => {
  if (state.injected) return;
  state.injected = true;
  state.mails.unshift({
    id:"m0", from:"root@pve-hq-02.int.kraemersippe.de", subject:"pve-hq-02: swap usage critical (94 %)",
    time:new Date().toLocaleTimeString("de-DE", { hour:"2-digit", minute:"2-digit" }), sev:"crit", parsed:true,
    rule:"Proxmox Host-Alarm", host:"pve-hq-02", incident:"INC-0413", read:false,
    raw:"Host: pve-hq-02\nSwap: 7.6G / 8.0G (94 %)\nRAM: 88 %\nTop consumer: 121 (nextcloud-vm) 24.0G\n\nTriggered by: leitstand-agent check host.swap"
  });
  state.incidents.unshift({
    id:"INC-0413", sev:"crit", host:"pve-hq-02", site:"hq", title:"Swap-Auslastung kritisch (94 %)",
    detail:"Der Knoten lagert seit 20 Minuten dauerhaft aus. Größter Verbraucher: VM 121 (nextcloud-vm) mit 24 GB zugewiesen bei 88 % Host-RAM.",
    src:"mail", ageMin:0, ack:false, first:"gerade eben", rule:"mail.pve.host_alarm"
  });
  const h = byId(state.hosts, "pve-hq-02"); if (h) { h.status = "crit"; h.note = "Swap 94 % — Auslagerung dauerhaft aktiv"; }
  toast("Neue kritische Meldung", "pve-hq-02: Swap-Auslastung 94 % — per E-Mail eingegangen, Regel „Proxmox Host-Alarm“.", "crit");
  render();
}, 24000);

/* Start */
(() => {
  const v = location.hash.replace("#/", "");
  if (RENDERERS[v]) state.view = v;
  render();
})();
