/* Leitstand — Oberfläche.
   Kein Framework, kein Build: Zustand -> HTML-String -> Delegation.

   Alle angezeigten Werte kommen aus /api/state, also aus echten Messungen.
   Es gibt keinen Beispielbestand mehr: antwortet der Dienst nicht, sagt die
   Oberfläche das und zeigt nichts an. Einzig die Bereiche, die der Dienst
   noch gar nicht liefern kann (Alarm-Postfach, HAProxy, Road-Warrior,
   Sicherungsaufträge, Push-Kanäle), zeigen je ein ausdrücklich als solches
   gekennzeichnetes Beispiel aus examples.js — damit sichtbar bleibt, was
   dort einmal stehen wird.

   Aktionen, die nach außen wirken würden, gibt es nicht: der Leitstand
   liest nur. Was hier klickbar ist, ist entweder eine Ansichtssache
   (Filter, Inspector) oder ein Aufruf, den der Dienst wirklich kann
   (quittieren, stummschalten, prüfen, Bestand pflegen). */

/* ============================================================
   Daten — ausschließlich vom Server befüllt (siehe applyLive)
   ============================================================ */
let SITES = [], HOSTS = [], TUNNELS = [], INCIDENTS = [], CERTS = [],
    LINKGROUPS = [], INTEGRATIONS = [], HAPROXY = [], PEERS = [],
    BACKUPS = [], MAILS = [], MAILRULES = [], ROUTES = [];

/* ============================================================
   Hilfsmittel
   ============================================================ */
const $  = (s, r=document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const byId = (arr, id) => arr.find(x => x.id === id);
const siteName = id => (SITES.find(s => s.id === id) || {}).name || "—";
const siteShort = id => (SITES.find(s => s.id === id) || {}).short || "—";

/* Standortkürzel: vier Stellen, Land + Stadt (DEKO = Deutschland/Köln).
   Feste Breite, weil es in Filterleiste, Topologie und jeder Tabellenzeile
   steht — unterschiedlich lange Kürzel ließen diese Spalten springen. */
const KUERZEL = /^[A-Z][A-Z0-9]{3}$/;

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
  if (pct == null || !Number.isFinite(pct)) {
    return `<div class="meter">
      <div class="meter-top"><span>${esc(label)}</span><b class="faint">${esc(opts.text ?? "—")}</b></div>
      <div class="bar" data-tone="idle"><i style="width:0"></i></div>
    </div>`;
  }
  const t = opts.tone || tone(pct, opts.warn, opts.crit);
  return `<div class="meter">
    <div class="meter-top"><span>${esc(label)}</span><b>${opts.text ?? pct + " %"}</b></div>
    <div class="bar" data-tone="${t}"><i style="width:${Math.max(2, Math.min(100, pct))}%"></i></div>
  </div>`;
}

/* Sparkline als Inline-SVG: Fläche + betonter Endpunkt. */
function spark(vals, opts={}) {
  /* Leere oder lückenhafte Reihen kommen vor, solange ein System noch nie
     geantwortet hat — daraus darf kein kaputtes SVG werden. */
  vals = (Array.isArray(vals) ? vals : []).filter(v => Number.isFinite(v));
  if (!vals.length) vals = [0, 0];
  if (vals.length === 1) vals = [vals[0], vals[0]];
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

/* Eine Sparkline aus einer leeren Reihe wäre eine waagerechte Linie auf
   null — und die liest sich wie ein gemessener Wert. Solange nichts
   gemessen wurde, steht hier deshalb ein Strich. */
function histCell(o, opts = {}) {
  const vals = (o.hist || []).filter(v => Number.isFinite(v));
  if (!vals.length) return '<span class="faint mono">—</span>';
  const col = o.status === "crit" ? "var(--crit)" : o.status === "warn" ? "var(--warn)" : (opts.color || "var(--accent)");
  const wert = opts.value !== false && o.ms != null ? `<span class="mono">${o.ms} ms</span> ` : "";
  return wert + spark(vals, { ...opts, color: col });
}

function fmtWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const heute = new Date().toDateString() === d.toDateString();
  const t = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return heute ? t : `${d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })} ${t}`;
}

function ago(min) {
  if (min == null || !Number.isFinite(min)) return "—";
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${Math.round(min)} min`;
  if (min < 1440) return `vor ${Math.floor(min / 60)} h ${Math.round(min % 60)} min`;
  return `vor ${Math.floor(min / 1440)} T`;
}
function hs(sec) {
  if (sec == null || !Number.isFinite(sec)) return "—";
  if (sec >= 3600) return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
  if (sec >= 60) return `${Math.floor(sec / 60)} min ${sec % 60} s`;
  return `${sec} s`;
}
const SRC_LABEL = { mail:"E-Mail", poll:"Abfrage", api:"API", webhook:"Webhook" };

/* Wert anzeigen, wenn er bekannt ist — sonst einen Strich. Stufe 1 kennt
   viele Kennzahlen noch nicht; erfunden wird an dieser Stelle nichts. */
const nz = (v, suffix = "") => (v == null || v === "" || (typeof v === "number" && !Number.isFinite(v)) ? "—" : `${v}${suffix}`);
const LIVE = () => !!(window.LEITSTAND && window.LEITSTAND.live);

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
  { id:"cfg",     label:"Einstellungen",icon:"cfg",     group:"Betrieb" },
  { id:"verwaltung", label:"Verwaltung",  icon:"cfg",     group:"Betrieb" }
];

/* ============================================================
   Zustand
   ============================================================ */
const state = {
  view: "lage",
  site: "all",
  onlyProblems: false,
  q: "",
  mail: null,
  mailTab: "inbox",
  paletteOpen: false,
  paletteQ: "",
  paletteIdx: 0,
  inspector: null,
  adminTab: "hosts",
  form: null,
  credentials: {},
  settings: null,
  runtime: null,
  invFile: null,
  diagnose: null,             /* Befund zu einem System, siehe diagnoseAnsicht */
  fassung: null,              /* der Stand, mit dem diese Seite geladen wurde */
  gestartet: null,            /* Startzeitpunkt des Dienstes beim Laden dieser Seite */
  neueFassung: null,          /* ein davon abweichender Stand im Dienst */
  neuGestartet: null,         /* derselbe Stand, aber ein neuer Prozess */
  rawLinks: null,             /* Startseite in Bearbeitung, null = noch nicht geladen */
  rawSites: [],
  adminLoaded: false,
  connecting: false,
  offline: null,              /* Fehlertext, wenn der Dienst nicht antwortet */
  incidents: [],
  hosts: [],
  tunnels: []
};

const inSite = o => state.site === "all" || o.site === state.site;
const isProblem = s => s === "crit" || s === "warn";
const openIncidents = () => state.incidents.filter(i => inSite(i) && i.sev !== "info");
const critCount = () => state.incidents.filter(i => i.sev === "crit" && !i.ack).length;
const warnCount = () => state.incidents.filter(i => i.sev === "warn" && !i.ack).length;

/* Anteil in Prozent — ohne Grundgesamtheit gibt es keinen Anteil, und
   „0 %" wäre an dieser Stelle eine Aussage, die niemand geprüft hat. */
const pct = (teil, ganz) => (ganz > 0 ? Math.round((teil / ganz) * 100) + " %" : "—");
/* Summe über ein Feld, das noch null sein darf: bekannt ist bekannt,
   unbekannt bleibt unbekannt. null statt 0, damit ein Strich erscheint. */
function sumKnown(list, key) {
  const known = list.map(x => x[key]).filter(v => Number.isFinite(v));
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}
/* Schwellwerte kommen aus dem laufenden Dienst, nicht aus dieser Datei —
   sonst zeigt die Oberfläche etwas anderes an, als gemessen wird. */
const thr = key => (state.settings || {})[key];

function visibleHosts() {
  let hs = state.hosts.filter(inSite);
  if (state.onlyProblems) hs = hs.filter(h => isProblem(h.status));
  if (state.q) {
    const q = state.q.toLowerCase();
    /* Unbekannte Felder dürfen nicht als das Wort „null" durchsuchbar werden. */
    hs = hs.filter(h => [h.id, h.name, h.role, h.ip, h.url, TYPE_LABEL[h.type]]
      .filter(Boolean).join(" ").toLowerCase().includes(q));
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
    if (v.id === "vpn") { const b = state.tunnels.filter(t => isProblem(t.status)).length; if (b) badge = `<span class="nav-badge" data-tone="warn">${b}</span>`; }
    out += `<button class="nav-item" data-action="view" data-view="${v.id}" aria-current="${state.view === v.id}">
      ${ICON[v.icon]}<span>${esc(v.label)}</span>${badge}</button>`;
  }
  return `<div class="nav">${out}</div>`;
}

function renderAlarmstrip() {
  const überwacht = state.hosts.filter(h => h.monitored !== false);
  const hostsUp = überwacht.filter(h => h.status !== "crit").length;
  const tunOk = state.tunnels.filter(t => t.status === "ok").length;
  const bkOk = BACKUPS.filter(b => b.status === "ok").length;
  const certWarn = CERTS.filter(c => c.days <= (thr("tls_warn_days") ?? 30)).length;
  /* Was es noch nicht gibt, wird als Strich gezeigt — nicht als „0 von 0",
     das wie ein Messwert aussieht. */
  const cells = [
    { k:"Kritisch", v:critCount(), tone: critCount() ? "crit" : "ok", go:"lage", pulse: critCount() > 0 },
    { k:"Warnungen", v:warnCount(), tone: warnCount() ? "warn" : "ok", go:"lage" },
    { k:"Systeme", v: überwacht.length ? `${hostsUp}/${überwacht.length}` : "—",
      tone: !überwacht.length ? "idle" : hostsUp === überwacht.length ? "ok" : "warn", go:"compute" },
    { k:"Tunnel", v: state.tunnels.length ? `${tunOk}/${state.tunnels.length}` : "—",
      tone: !state.tunnels.length ? "idle" : tunOk === state.tunnels.length ? "ok" : "warn", go:"vpn" },
    { k:"Backups 24 h", v: BACKUPS.length ? `${bkOk}/${BACKUPS.length}` : "—", tone: !BACKUPS.length ? "idle" : bkOk === BACKUPS.length ? "ok" : "warn", go:"compute" },
    { k:"Zert. knapp", v: CERTS.length ? certWarn : "—", tone: !CERTS.length ? "idle" : certWarn ? "warn" : "ok", go:"dienste" },
    { k:"Alarm-Mails", v: "—", tone:"idle", go:"post" }
  ];
  return `<div class="alarmstrip">${cells.map(c => `
    <button class="alarmcell" data-tone="${c.tone}" data-action="view" data-view="${c.go}">
      ${c.pulse ? '<span class="pulse"></span>' : dot(c.tone)}
      <span>${esc(c.k)}</span><b>${esc(String(c.v))}</b>
    </button>`).join("")}</div>`;
}

/* Veraltete Werte sehen wie aktuelle aus — das ist der gefährlichste
   Zustand einer Überwachung. Deshalb ein Streifen quer über die Anzeige,
   solange der Zustandsstrom hängt. */
function staleBar() {
  const L = window.LEITSTAND;
  if (!L || !L.stale || !L.live) return "";
  return `<div class="stalebar">${dot("warn")}
    <span>Verbindung zum Dienst abgerissen — die Werte unten sind vom
    ${esc(fmtWhen(L.lastRun) || "letzten Durchlauf")} und werden nicht mehr aktualisiert.</span>
    <span class="spacer"></span>
    <button class="btn btn--sm" data-action="reconnect">Erneut verbinden</button></div>`;
}

/* ============================================================
   Welche Fassung läuft?

   Bei automatischem Redeploy ist die Seite im Browser nach dem Ausrollen
   noch die alte: sie hat ihr JavaScript längst geladen, und der wieder
   verbundene Zustandsstrom kommt aus einem anderen Behälter. Deshalb wird
   die Kennung des ersten gesehenen Standes gemerkt und mit jeder Antwort
   verglichen. Weicht sie ab, wird das gesagt — nicht heimlich neu geladen,
   denn ein offenes Formular soll niemand unter den Händen verlieren.
   ============================================================ */
const buildId = b => (b ? [b.commit, b.built, b.committed].filter(Boolean).join("/") || null : null);

function fassungText(b, lang = false) {
  if (!b) return "Fassung unbekannt";
  const stand = b.built || b.committed;
  const zeit = stand ? new Date(stand) : null;
  const wann = zeit && !isNaN(zeit)
    ? `${zeit.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })} ` +
      `${zeit.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
    : null;
  const kurz = b.shortCommit || (b.version ? "v" + b.version : null);
  if (!lang) return [kurz, wann].filter(Boolean).join(" · ") || "Fassung unbekannt";

  const teile = [];
  if (b.version) teile.push(`v${b.version}`);
  if (b.shortCommit) teile.push(`${b.shortCommit}${b.branch ? " (" + b.branch + ")" : ""}`);
  if (b.committed) teile.push(`Commit ${fmtWhen(b.committed)}`);
  if (b.built) teile.push(`${b.source === "dateistand" ? "Dateistand" : "gebaut"} ${fmtWhen(b.built)}`);
  else if (!b.committed) teile.push("kein Zeitpunkt bekannt");
  teile.push({ abbild: "aus dem Abbild", arbeitsbaum: "aus dem Arbeitsbaum",
    dateistand: "ohne Bauparameter gebaut" }[b.source] || "Herkunft unbekannt");
  return teile.join(" · ");
}

/* Nicht die Uhrzeit dieses Browsers, sondern der Zeitpunkt, zu dem
   zuletzt wirklich gemessen wurde. */
function letzterLauf() {
  const L = window.LEITSTAND;
  if (!L || !L.live) return "—";
  const t = L.lastRun && new Date(L.lastRun);
  if (!t || isNaN(t)) return "noch kein Durchlauf";
  return t.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* Der Dienst hat eine neue Fassung — oder wurde neu gestartet. Die Seite hat
   in beiden Fällen noch das JavaScript von vorher. */
function buildBar() {
  if (!state.neueFassung && !state.neuGestartet) return "";
  const text = state.neueFassung
    ? `Neue Fassung ausgerollt: <b class="mono">${esc(fassungText(state.neueFassung))}</b> —
       diese Seite zeigt noch <span class="mono">${esc(fassungText(state.fassung))}</span>.`
    : `Der Dienst wurde neu gestartet (${esc(fmtWhen(state.neuGestartet))}). Nach einem Redeploy
       läuft in dieser Seite noch die Oberfläche von vorher.`;
  return `<div class="buildbar">${dot("info")}
    <span>${text}</span>
    <span class="spacer"></span>
    <button class="btn btn--sm btn--primary" data-action="reload">Neu laden</button>
    <button class="btn btn--sm" data-action="dismiss-build">Später</button></div>`;
}

function renderTopbar() {
  const v = VIEWS.find(x => x.id === state.view);
  return `<div class="topbar">
    ${buildBar()}${staleBar()}
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
      <span class="mono faint" style="font-size:11px" title="Zeitpunkt des letzten Durchlaufs im Dienst — nicht die Uhr dieses Browsers">${esc(letzterLauf())}</span>
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

function avgRtt() {
  const live = state.tunnels.filter(t => t.rtt != null);
  return live.length ? `${Math.round(live.reduce((a, t) => a + t.rtt, 0) / live.length)} ms` : "—";
}

/* ---------- Bausteine für „gibt es noch nicht" ----------
   Ein Bereich ohne Anbindung zeigt genau ein Beispiel, sichtbar als solches
   gekennzeichnet, und daneben, was fehlt, damit dort Messwerte stehen.
   Der Unterschied zwischen „noch nichts angebunden" und „nichts los" muss
   auf einen Blick erkennbar sein — sonst hält man das eine für das andere. */
const BEISPIEL = '<span class="demo-tag" title="Kein Messwert — zeigt nur, wie der Eintrag aussehen wird">Beispiel</span>';

function ausbaupanel(titel, stufe, erklärung, inhalt) {
  return `<div class="panel panel--example">
    <div class="panel-head">${dot("idle")}<h3>${esc(titel)}</h3>${BEISPIEL}
      <div class="spacer"></div><span class="hint">${esc(stufe)}</span></div>
    ${inhalt}
    <div class="panel-note">${erklärung}</div>
  </div>`;
}

function firstStepsBanner() {
  return `<div class="panel panel--hello">
    <div class="panel-body row row-wrap" style="gap:14px">
      <div style="min-width:220px;flex:1">
        <div class="sec-title">Noch kein System angelegt</div>
        <p class="muted" style="margin:0;font-size:13px">Der Dienst läuft und prüft — er weiß nur noch nicht, was.
        Systeme, Standorte, Tunnel und die Startseite werden unter <b>Verwaltung</b> gepflegt.</p>
      </div>
      <button class="btn btn--primary" data-action="view" data-view="verwaltung">Zur Verwaltung</button>
    </div>
  </div>`;
}

function onboarding() {
  return `<div class="panel panel--hello">
    <div class="panel-body">
      <div class="sec-title">Willkommen</div>
      <p class="muted" style="margin:0 0 14px;font-size:13.5px;max-width:64ch">
        Der Bestand ist leer — kein Standort, kein System. Der Leitstand erfindet an dieser Stelle
        nichts, deshalb bleibt alles bis zum ersten Eintrag leer.</p>
      <ol class="muted" style="margin:0 0 16px;padding-left:20px;line-height:2;font-size:13px">
        <li><b>Standort</b> anlegen — ein Ort, an dem Geräte stehen</li>
        <li><b>System</b> anlegen — Kennung, Typ und IP genügen; die Prüfungen leiten sich daraus ab</li>
        <li>Bei Proxmox zusätzlich das <b>API-Token</b> hinterlegen und die Verbindung testen</li>
        <li>Häufig gebrauchte Oberflächen auf die <b>Startseite</b> legen</li>
      </ol>
      <button class="btn btn--primary" data-action="view" data-view="verwaltung">Verwaltung öffnen</button>
    </div>
  </div>`;
}

/* Der Ereignisstrom entsteht aus den Störungen selbst — erfundene Einträge
   wären hier besonders irreführend. */
function liveEvents() {
  return state.incidents.slice(0, 12).map(i => ({
    t: i.first, s: i.src || "poll", sev: i.sev,
    txt: `<b>${esc(i.host)}</b>: ${esc(i.title)}${i.count > 1 ? ` <span class="faint">(${i.count}×)</span>` : ""}`
  }));
}

function viewLage() {
  if (!state.hosts.length && !SITES.length) return onboarding();

  const inc = openIncidents().sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || a.ageMin - b.ageMin);
  const hosts = state.hosts.filter(inSite).filter(h => h.monitored !== false);
  const still = hosts.filter(h => h.status === "crit").length;
  const tunOk = state.tunnels.filter(t => t.status === "ok").length;
  const kpis = [
    { l:"Erreichbarkeit", v: pct(hosts.length - still, hosts.length),
      s: hosts.length ? `${still} von ${hosts.length} ohne Antwort` : "kein überwachtes System",
      t: !hosts.length ? "idle" : still ? "warn" : "ok", go:"compute" },
    { l:"Offene Störungen", v:critCount() + warnCount(), s:`${critCount()} kritisch · ${warnCount()} Warnung`,
      t: critCount() ? "crit" : warnCount() ? "warn" : "ok", go:"lage" },
    { l:"VPN-Tunnel", v: state.tunnels.length ? `${tunOk}/${state.tunnels.length}` : "—",
      s: state.tunnels.length ? "gemessen durch den Tunnel" : "kein Tunnel angelegt",
      t: !state.tunnels.length ? "idle" : state.tunnels.some(t => t.status === "crit") ? "crit" : tunOk === state.tunnels.length ? "ok" : "warn", go:"vpn" },
    { l:"Ø Tunnel-Latenz", v:avgRtt(), s:"über alle tragenden Strecken", t:"ok", go:"vpn" }
  ];

  const events = liveEvents();

  return `
  ${state.hosts.length ? "" : firstStepsBanner()}
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
        ${events.length ? events.map(e => `<div class="tl-item">
          <span class="tl-time">${esc(e.t)}</span>
          <span class="tl-rail">${dot(e.sev)}</span>
          <span><span class="tl-text">${e.txt}</span><br><span class="tl-src">${esc(SRC_LABEL[e.s] || e.s)}</span></span>
        </div>`).join("") : '<div class="empty">Nichts vorgefallen — alle Prüfungen unauffällig.</div>'}
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

/* `down` setzt der Server, wenn kein überwachtes System des Standorts mehr
   antwortet — dieselbe Bedingung, aus der die Standort-Bündelung entsteht. */
function siteCard(s) {
  const hosts = state.hosts.filter(h => h.site === s.id);
  const bad = hosts.filter(h => isProblem(h.status)).length;
  const tuns = state.tunnels.filter(t => t.a === s.id || t.b === s.id);
  const st = s.down ? "crit" : bad ? "warn" : hosts.length ? "ok" : "idle";
  const wan = s.wan && s.wan !== "—" ? s.wan : null;
  const untertitel = [s.place, s.isp].filter(x => x && x !== "—").join(" · ");
  return `<div class="card" data-action="inspect" data-kind="site" data-id="${esc(s.id)}">
    <div class="card-head">
      <span style="padding-top:4px">${dot(st)}</span>
      <div style="min-width:0">
        <div class="card-title">${esc(s.name)}</div>
        <div class="card-meta">${esc(untertitel || s.id)}</div>
      </div>
      <div class="spacer"></div>${chip("plain", s.short)}
    </div>
    <div class="stat-row">
      ${stat("WAN", nz(wan))}
      <div class="stat"><span class="stat-k">Systeme</span><span class="stat-v">${hosts.length}${bad ? ` <span style="color:var(--warn)">▲${bad}</span>` : ""}</span></div>
      <div class="stat"><span class="stat-k">Tunnel</span><span class="stat-v">${tuns.length ? `${tuns.filter(t => t.status === "ok").length}/${tuns.length}` : "—"}</span></div>
      <div class="stat"><span class="stat-k">Meldungen</span><span class="stat-v">${state.incidents.filter(i => i.site === s.id).length || "—"}</span></div>
    </div>
  </div>`;
}

/* ============================================================
   Ansicht: Standorte
   ============================================================ */
function topoSvg() {
  /* Mitte ist der als primär markierte Standort; ist keiner markiert, der
     erste. Ohne Standort gibt es nichts zu zeichnen. */
  const hub = SITES.find(s => s.primary) || SITES[0];
  if (!hub) return '<div class="empty">Kein Standort angelegt.</div>';

  const W = 760, H = 260, cx = W / 2, cy = H / 2;
  const spokes = SITES.filter(s => s.id !== hub.id);
  const pts = spokes.map((s, i) => {
    const a = (-90 + (360 / spokes.length) * i) * Math.PI / 180;
    return { s, x: cx + Math.cos(a) * 250, y: cy + Math.sin(a) * 95 };
  });
  const lines = pts.map(p => {
    const t = state.tunnels.find(t => (t.a === hub.id && t.b === p.s.id) || (t.b === hub.id && t.a === p.s.id));
    const col = !t ? "var(--idle)" : t.status === "ok" ? "var(--ok)" : t.status === "warn" ? "var(--warn)" : "var(--crit)";
    const dash = t && t.status === "crit" ? '6 5' : t && t.status === "warn" ? '3 3' : '0';
    const beschriftung = !t ? "" : t.status === "crit" ? "keine Antwort" : t.rtt != null ? t.rtt + " ms" : "";
    return `<line x1="${cx}" y1="${cy}" x2="${p.x}" y2="${p.y}" stroke="${col}" stroke-width="1.8" stroke-dasharray="${dash}" opacity=".85"/>
      <text x="${(cx + p.x) / 2}" y="${(cy + p.y) / 2 - 6}" fill="var(--faint)" font-size="10" font-family="IBM Plex Mono, monospace" text-anchor="middle">${esc(beschriftung)}</text>`;
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
  return `<svg class="topo" viewBox="0 0 ${W} ${H}" role="img" aria-label="Netztopologie: ${esc(hub.name)} als Zentrum, weitere Standorte per Tunnel verbunden">
    ${lines}${pts.map(p => node(p.x, p.y, p.s)).join("")}${node(cx, cy, hub, true)}
  </svg>`;
}

function viewSites() {
  if (!SITES.length) return onboarding();
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
        <table class="t"><thead><tr><th style="width:34px"></th><th>System</th><th>Typ</th><th>Adresse</th><th>Version</th><th>Auslastung</th><th class="right">Antwortzeit</th></tr></thead><tbody>
        ${hosts.length ? hosts.map(h => `<tr data-sev="${h.status}" data-action="inspect" data-kind="host" data-id="${h.id}">
          <td class="sev">${dot(h.status)}</td>
          <td><div class="mono">${esc(h.name)}</div><div class="t-sub">${esc(h.role)}</div></td>
          <td>${chip("plain", TYPE_LABEL[h.type] || h.type)}</td>
          <td class="mono faint">${esc(nz(h.ip))}</td>
          <td class="mono">${esc(nz(h.version))}</td>
          <td style="min-width:160px">${h.cpu != null ? meter("CPU", h.cpu) : '<span class="faint">—</span>'}</td>
          <td class="right">${histCell(h)}</td>
        </tr>`).join("") : `<tr><td colspan="7"><div class="empty">An diesem Standort ist noch kein System angelegt.</div></td></tr>`}
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
      <div class="right">
        <div class="card-meta">${esc(h.cluster || (h.quorum == null ? "—" : "standalone"))}</div>
        <div class="card-meta">${h.version ? "v" + esc(h.version) : "—"}</div></div>
    </div>
    ${hasMetrics(h) ? `<div class="col" style="gap:7px">
      ${meter("CPU", h.cpu)}${meter("RAM", h.ram)}${meter("Speicher", h.disk)}
    </div>` : `<div class="row" style="gap:8px;font-size:12px;color:var(--faint)">
      ${dot("idle")}<span>${h.collectorError ? esc(h.collectorError) : "Kennzahlen erst mit hinterlegtem API-Token"} — Verwaltung → ${esc(h.name)}</span></div>`}
    <div class="stat-row">
      ${stat("VMs", nz(h.vms))}${stat("LXC", nz(h.lxc))}
      ${stat("Antwort", nz(h.ms, " ms"))}
      ${stat("Laufzeit", nz(h.uptime))}
      <div class="spacer"></div>${histCell(h, { value: false })}
    </div>
    ${h.note ? `<div class="row" style="gap:7px;font-size:12px;color:var(--${h.status})">${dot(h.status)}<span>${esc(h.note)}</span></div>` : ""}
  </div>`;
}

const hasMetrics = h => h.cpu != null || h.ram != null || h.disk != null;
const stat = (k, v) => `<div class="stat"><span class="stat-k">${esc(k)}</span><span class="stat-v">${esc(String(v))}</span></div>`;

function simpleRows(hosts, cols) {
  return hosts.map(h => `<tr data-sev="${h.status}" data-action="inspect" data-kind="host" data-id="${h.id}">
    <td class="sev">${dot(h.status)}</td>
    <td><div class="mono">${esc(h.name)}</div><div class="t-sub">${esc(h.role)}</div></td>
    <td>${chip("plain", siteShort(h.site))}</td>
    ${cols.map(c => `<td>${c(h)}</td>`).join("")}
  </tr>`).join("");
}

function viewCompute() {
  if (!state.hosts.length) return onboarding();
  const hs = visibleHosts();
  const pve = hs.filter(h => h.type === "pve");
  const store = hs.filter(h => ["truenas", "pbs"].includes(h.type));
  const cont = hs.filter(h => h.type === "portainer");
  const vms = sumKnown(pve, "vms"), lxc = sumKnown(pve, "lxc");
  return `
  <div class="panel">
    <div class="panel-head"><h3>Proxmox VE</h3>
      <span class="hint">${pve.length} Knoten · ${nz(vms)} VMs · ${nz(lxc)} Container</span></div>
    <div class="panel-body"><div class="grid g3">${pve.length ? pve.map(pveCard).join("") : '<div class="empty">Kein Proxmox-VE-Knoten in dieser Auswahl.</div>'}</div></div>
  </div>

  <div class="grid g2">
    <div class="panel">
      <div class="panel-head"><h3>Speicher &amp; Sicherung</h3><span class="hint">TrueNAS · Proxmox Backup Server</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>System</th><th>Standort</th><th>Belegung</th><th>Fehlgeschlagen</th><th>Letzter Erfolg</th></tr></thead><tbody>
        ${store.length ? simpleRows(store, [
          h => meter("", h.used, { text: h.used != null ? h.used + " %" : "—" }),
          h => h.failed ? `<span class="chip chip--crit">${h.failed}</span>` : `<span class="mono faint">${nz(h.failed)}</span>`,
          h => `<span class="mono faint">${esc(fmtWhen(h.lastGood) || "—")}</span>`
        ]) : '<tr><td colspan="6"><div class="empty">Kein Speichersystem in dieser Auswahl.</div></td></tr>'}
        </tbody></table>
      </div>
      ${store.some(h => h.type === "truenas") ? `<div class="panel-note">Für TrueNAS gibt es noch keinen Sammler —
        Poolbelegung, SMART-Werte und Replikation kommen mit <b>Stufe 5</b>. Geprüft wird bislang nur die Erreichbarkeit.</div>` : ""}
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Container-Plattformen</h3><span class="hint">Portainer</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>System</th><th>Standort</th><th>Adresse</th><th>Zertifikat</th><th>Antwortzeit</th></tr></thead><tbody>
        ${cont.length ? simpleRows(cont, [
          h => `<span class="mono faint">${esc(nz(h.ip))}</span>`,
          h => certCell(h),
          h => histCell(h)
        ]) : '<tr><td colspan="6"><div class="empty">Kein Portainer in dieser Auswahl.</div></td></tr>'}
        </tbody></table>
      </div>
      ${cont.length ? `<div class="panel-note">Stacks, Container und ungesunde Dienste liest der Leitstand über die
        Portainer-API — <b>Stufe 5</b>.</div>` : ""}
    </div>
  </div>

  ${backupPanel()}`;
}

function backupPanel() {
  const zeilen = BACKUPS.length ? BACKUPS : [EXAMPLES.backup];
  const tabelle = `<div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Auftrag</th><th>Ziel</th><th>Zuletzt</th><th>Umfang</th><th>Dauer</th></tr></thead><tbody>
      ${zeilen.map(b => `<tr data-sev="${b.status}">
        <td class="sev">${dot(b.status)}</td><td>${esc(b.job)}</td>
        <td class="mono faint">${esc(b.target)}</td><td class="mono">${esc(b.last)}</td>
        <td class="mono">${esc(b.size)}</td><td class="mono faint">${esc(b.dur)}</td></tr>`).join("")}
      </tbody></table></div>`;

  if (BACKUPS.length) return `<div class="panel">
    <div class="panel-head"><h3>Sicherungsaufträge</h3><span class="hint">letzte 24 Stunden</span></div>
    ${tabelle}</div>`;

  return ausbaupanel("Sicherungsaufträge", "Stufe 2 · Stufe 4", `Aufträge, Umfang und Dauer stehen im Proxmox Backup Server
    und in den <span class="mono">vzdump</span>-Berichten. Beides ist noch nicht angebunden: für PBS fehlt der Sammler
    über die Aufgabenliste, für vzdump das Alarm-Postfach. Bis dahin bleibt diese Tabelle eine Absichtserklärung.`, tabelle);
}

/* ============================================================
   Ansicht: Netz & Proxy
   ============================================================ */
function viewNetz() {
  if (!state.hosts.length) return onboarding();
  const fws = visibleHosts().filter(h => ["opnsense", "pfsense"].includes(h.type));
  const opn = fws.filter(f => f.type === "opnsense").length;
  const pf = fws.filter(f => f.type === "pfsense").length;

  /* Mit hinterlegtem Schlüssel liest der Sammler Fassung, Speicher, Platte
     und Durchsatz; ohne bleibt es bei der Messung von außen: erreichbar,
     wie schnell, Zertifikat. Beides steht in derselben Tabelle — was fehlt,
     ist ein Strich, keine Null, die man für eine Messung halten könnte. */
  const mitApi = fws.some(f => f.version || f.ram != null);
  const firewalls = `<div class="panel">
    <div class="panel-head"><h3>Firewalls</h3>
      <span class="hint">${opn}× OPNsense · ${pf}× pfSense</span>
      <div class="spacer"></div><span class="hint">${mitApi ? "Kennzahlen über die API, Erreichbarkeit von außen" : "geprüft von außen: Erreichbarkeit, Antwortzeit, Zertifikat"}</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        <th style="width:34px"></th><th>Gerät</th><th>Standort</th><th>Fassung</th>
        <th>Speicher</th><th>Platte</th><th>Durchsatz</th><th>WG-Peers</th>
        <th>Zertifikat</th><th class="right">Antwortzeit</th></tr></thead><tbody>
      ${fws.length ? fws.map(f => `<tr data-sev="${f.status}" data-action="inspect" data-kind="host" data-id="${f.id}">
        <td class="sev">${dot(f.status)}</td>
        <td><div class="mono">${esc(f.name)}</div><div class="t-sub">${esc(f.role)}</div></td>
        <td>${chip("plain", siteShort(f.site))}</td>
        <td class="mono">${fassungsZelle(f)}</td>
        <td style="min-width:120px">${f.ram != null ? meter("", f.ram, { text: f.ram + " %" }) : '<span class="faint">—</span>'}</td>
        <td style="min-width:120px">${f.disk != null ? meter("", f.disk, { text: f.disk + " %", warn: 80, crit: 90 }) : '<span class="faint">—</span>'}</td>
        <td class="mono faint">${durchsatzZelle(f)}</td>
        <td class="mono">${wgZelle(f)}</td>
        <td>${certCell(f)}</td>
        <td class="right">${histCell(f)}</td>
      </tr>`).join("") : '<tr><td colspan="10"><div class="empty">Keine Firewall in dieser Auswahl.</div></td></tr>'}
      </tbody></table>
    </div>
    <div class="panel-note">${mitApi
      ? `Zustandstabelle und CARP-Rolle fehlen noch — sie liegen hinter weiteren Endpunkten der Firewall-API.
         Für pfSense gibt es bislang gar keinen Sammler; dort wird nur von außen gemessen.`
      : `Für Kennzahlen braucht es einen API-Schlüssel: bei OPNsense unter
         <span class="mono">System → Access → Users</span> erzeugen und hier unter <b>Verwaltung</b> hinterlegen.
         Ohne ihn bleibt es bei Erreichbarkeit, Antwortzeit und Zertifikat.`}</div>
  </div>`;

  return firewalls + haproxyPanel();
}

/* Kurzfassung der tatsächlich gelaufenen Prüfungen — was übersprungen
   wurde, wird durchgestrichen, damit ICMP-losigkeit auffällt. */
function checkList(h) {
  const cs = h.checks || [];
  if (!cs.length) return "—";
  return cs.map(c => {
    const name = esc(c.kind + (c.port ? "/" + c.port : ""));
    if (c.skipped) return `<span class="faint" style="text-decoration:line-through" title="${esc(c.detail || "übersprungen")}">${name}</span>`;
    return `<span style="color:var(--${c.ok ? "ok" : "crit"})" title="${esc(c.detail || "")}">${name}</span>`;
  }).join(" · ");
}

/* Fassung, und daneben was ansteht. Ein ausstehender Neustart oder eine
   neue Hauptfassung sind Hinweise, keine Störungen — sie färben die Ampel
   nicht, sollen aber ins Auge fallen. */
function fassungsZelle(f) {
  if (!f.version) return '<span class="faint">—</span>';
  const marken = [];
  if (f.needsReboot) marken.push(chip("warn", "Neustart"));
  if (f.updates) marken.push(chip("info", f.updates + " Updates"));
  if (f.majorUpgrade) marken.push(chip("info", "→ " + f.majorUpgrade));
  return `${esc(f.version)}${marken.length ? `<div class="row" style="gap:4px;margin-top:3px">${marken.join("")}</div>` : ""}`;
}

function durchsatzZelle(f) {
  if (f.thrIn == null && f.thrOut == null) return '<span class="faint">—</span>';
  const z = v => (v == null ? "—" : v < 1 ? v.toFixed(2) : v.toFixed(1));
  return `<span title="${esc(f.thrQuelle || "")}">${z(f.thrIn)} ↓ / ${z(f.thrOut)} ↑ Mbit</span>`;
}

function wgZelle(f) {
  if (f.wgPeers == null) return '<span class="faint">—</span>';
  if (!f.wgPeers) return '<span class="faint">0</span>';
  const still = f.wgStill || 0;
  return `${f.wgPeers - still}/${f.wgPeers}${still ? ` <span style="color:var(--idle)">(${still} still)</span>` : ""}`;
}

function certCell(h) {
  if (!h.tls || h.tls.days == null) return '<span class="faint">—</span>';
  const d = h.tls.days;
  const t = d <= (thr("tls_crit_days") ?? 14) ? "crit" : d <= (thr("tls_warn_days") ?? 30) ? "warn" : "ok";
  return chip(t, d < 0 ? `abgelaufen` : `${d} T`);
}

function haproxyPanel() {
  const prox = HAPROXY.filter(p => state.site === "all" || p.site === state.site);
  const tabelle = p => `<div class="panel-body panel-body--flush tablewrap">
    <table class="t"><thead><tr><th style="width:34px"></th><th>Backend</th><th>Server</th><th>Veröffentlicht als</th><th class="right">Antwort</th></tr></thead><tbody>
    ${p.backends.map(b => `<tr data-sev="${b.status}">
      <td class="sev">${dot(b.status)}</td>
      <td class="mono">${esc(b.name)}</td>
      <td class="mono ${b.status === "ok" ? "" : "faint"}">${esc(b.servers)}</td>
      <td class="mono faint">${esc(b.route)}</td>
      <td class="right mono">${nz(b.ms, " ms")}</td>
    </tr>`).join("")}
    </tbody></table></div>`;

  if (prox.length) return `<div class="grid g2">${prox.map(p => `<div class="panel">
    <div class="panel-head">${dot(p.status)}<h3>HAProxy auf ${esc(p.host)}</h3>
      <span class="hint">${nz(p.frontends)} Frontends · ${nz(p.sessions)} Sitzungen</span>
      <div class="spacer"></div><span class="hint">${esc(p.ssl)}</span></div>
    ${tabelle(p)}</div>`).join("")}</div>`;

  return ausbaupanel("HAProxy — veröffentlichte Dienste", "Stufe 3",
    `Welches Backend gerade trägt, weiß nur die Firewall selbst. Der Leitstand liest das über die
     OPNsense-API (<span class="mono">haproxy/statistics</span>), sobald der Sammler dafür steht. Ein Dienst, der
     von außen erreichbar aussieht, aber intern auf null Servern läuft, fällt sonst erst dem Benutzer auf.`,
    tabelle(EXAMPLES.haproxy));
}

/* ============================================================
   Ansicht: VPN
   ============================================================ */
function viewVpn() {
  if (!SITES.length) return onboarding();
  const tun = state.tunnels.filter(t => state.site === "all" || t.a === state.site || t.b === state.site);
  const ids = SITES.map(s => s.id);

  const matrix = `<table class="matrix"><thead><tr><th></th>${ids.map(i => `<th>${esc(siteShort(i))}</th>`).join("")}</tr></thead><tbody>
    ${ids.map(a => `<tr><th>${esc(siteShort(a))}</th>${ids.map(b => {
      if (a === b) return `<td><div class="mcell" data-s="none">·</div></td>`;
      const t = state.tunnels.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
      if (!t) return `<td><div class="mcell" data-s="none">–</div></td>`;
      return `<td><button class="mcell" data-s="${t.status}" data-action="inspect" data-kind="tunnel" data-id="${t.id}" title="${esc(siteName(a))} ↔ ${esc(siteName(b))}">${t.status === "crit" ? "×" : t.rtt != null ? t.rtt + "ms" : "·"}</button></td>`;
    }).join("")}</tr>`).join("")}
  </tbody></table>`;

  return `
  <div class="grid g-side">
    <div class="panel">
      <div class="panel-head"><h3>Site-to-Site-Tunnel</h3><span class="hint">gemessen durch den Tunnel</span>
        <div class="spacer"></div><span class="hint">${nz(thr("fail_threshold"))} Fehlschläge bis Rot</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>Strecke</th><th>Interface</th><th>Gegenstelle</th><th>Zuletzt erreicht</th><th>Handshake</th><th>RX / TX</th><th class="right">Latenz</th></tr></thead><tbody>
        ${tun.length ? tun.map(t => `<tr data-sev="${t.status}" data-action="inspect" data-kind="tunnel" data-id="${t.id}">
          <td class="sev">${dot(t.status)}</td>
          <td><div>${esc(siteName(t.a))} <span class="faint">↔</span> ${esc(siteName(t.b))}</div><div class="t-sub mono">${esc(t.net || "—")}</div></td>
          <td class="mono faint">${esc(t.iface || "—")}</td>
          <td class="mono faint">${gegenstelle(t)}</td>
          <td class="mono">${esc(fmtWhen(t.lastSeen) || "—")}</td>
          <td class="mono">${handshakeZelle(t)}</td>
          <td class="mono faint">${t.rx ? `${esc(t.rx)} / ${esc(t.tx)}` : "—"}</td>
          <td class="right">${histCell(t, { w: 74, color: "var(--ok)", value: false })}${t.rtt != null ? ` <span class="mono">${t.rtt} ms</span>` : ""}</td>
        </tr>`).join("") : `<tr><td colspan="8"><div class="empty">${SITES.length > 1 ? "Kein Tunnel für diese Auswahl — unter Verwaltung → Tunnel anlegen." : "Kein Tunnel angelegt."}</div></td></tr>`}
        </tbody></table>
      </div>
      <div class="panel-note">Gemessen wird <b>durch</b> den Tunnel auf die Gegenstelle im Transfernetz: das beantwortet
        die Frage, die zählt — trägt die Strecke gerade? ${
          tun.some(t => t.peer)
          ? `Das Handshake-Alter kommt daneben von der Firewall, die den verknüpften Peer meldet. Es sagt etwas anderes:
             wann die Strecke zuletzt stand — nicht, ob gerade etwas hindurchkommt. Wo keine Gegenstelle im Transfernetz
             eingetragen ist, wird der Zustand ersatzweise daraus abgeleitet.`
          : PEERS.length
          ? `Das Handshake-Alter liest der Leitstand von den Firewalls (siehe unten). Damit es hier in der Zeile steht,
             muss am Tunnel hinterlegt sein, welcher Peer gemeint ist — unter <b>Verwaltung → Tunnel</b> auswählen.`
          : `Handshake-Alter und übertragene Menge stehen auf der Firewall; sie kommen dazu, sobald dort ein
             API-Schlüssel hinterlegt ist — ohne diese Messung zu ersetzen.`}</div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Verbindungsmatrix</h3><span class="hint">Latenz in ms</span></div>
      <div class="panel-body" style="overflow-x:auto">${matrix}
        <div class="legend" style="margin-top:12px">${dot("ok")} trägt ${dot("warn")} auffällig ${dot("crit")} keine Antwort <span class="faint">– keine Strecke</span></div>
      </div>
    </div>
  </div>

  ${peerPanel()}`;
}

/* Worauf gemessen wird: die Gegenstelle im Transfernetz. Gibt es die
   nicht, steht dort der Endpunkt des verknüpften Peers — damit die Spalte
   sagt, woher der Zustand dieser Zeile überhaupt stammt. */
function gegenstelle(t) {
  if (t.probe) return esc(t.probe);
  if (t.peer?.endpoint) return `${esc(t.peer.endpoint)} <span class="faint">(Peer)</span>`;
  return "—";
}

/* Das Handshake-Alter des verknüpften Peers. Ohne Verknüpfung steht hier
   ein Strich — mit dem Hinweis, wo man sie herstellt, statt schweigend
   nichts. Ein hinterlegter Peer, den die Firewall nicht mehr meldet, wird
   ausdrücklich als solcher gezeigt: das ist ein anderer Zustand als „noch
   nie gemeldet" und will anders behandelt werden. */
function handshakeZelle(t) {
  if (!t.peer) return `<span class="faint" title="Kein Peer verknüpft — unter Verwaltung → Tunnel auswählen">—</span>`;
  if (!t.peer.gefunden) return `<span style="color:var(--warn)" title="${esc(t.peer.note || "")}">nicht gemeldet</span>`;
  if (t.handshake == null) return `<span class="faint" title="Diese Gegenstelle hat sich noch nie gemeldet">nie</span>`;
  const ton = t.handshake <= 180 ? "ok" : t.handshake <= 600 ? "warn" : "crit";
  return `<span style="color:var(--${ton})" title="${esc(t.peer.name || "")}${t.peer.seit ? " · " + esc(t.peer.seit) : ""}">${esc(hs(t.handshake))}</span>`;
}

/* Der verknüpfte Peer im Tunnel-Inspektor. Drei Fälle, die nicht
   miteinander verwechselt werden dürfen: keine Verknüpfung, eine
   Verknüpfung ins Leere, ein gemeldeter Peer. */
function tunnelPeerBlock(t) {
  if (!t.peer) return `<div><div class="sec-title">WireGuard-Peer</div>
    <p class="admin-hint" style="margin:0">Dieser Strecke ist keine Gegenstelle auf einer Firewall zugeordnet.
    ${PEERS.length
      ? `Unter <b>Bearbeiten</b> lässt sich eine auswählen — dann stehen hier Handshake und übertragene Menge.`
      : `Sobald bei einer Firewall ein API-Schlüssel hinterlegt ist, lässt sich hier eine auswählen.`}</p></div>`;

  const p = t.peer;
  if (!p.gefunden) return `<div><div class="sec-title">WireGuard-Peer</div>
    <div class="row" style="gap:8px;align-items:flex-start">${dot("warn")}
      <span style="font-size:13px">${esc(p.note || `„${p.name}" wird von ${p.host} nicht gemeldet.`)}</span></div>
    <p class="admin-hint" style="margin:6px 0 0">Hinterlegt ist <span class="mono">${esc(p.name || p.key || "—")}</span>
      auf <span class="mono">${esc(p.host)}</span>. Die Messung durch den Tunnel läuft davon unberührt weiter.</p></div>`;

  return `<div><div class="sec-title">WireGuard-Peer</div><dl class="kv">
    <dt>Gegenstelle</dt><dd class="mono">${esc(p.name || "—")}</dd>
    <dt>Gelesen von</dt><dd class="mono">${esc(p.host)}${p.iface ? ` <span class="faint">· ${esc(p.iface)}</span>` : ""}</dd>
    <dt>Endpunkt</dt><dd class="mono">${esc(nz(p.endpoint))}</dd>
    <dt>Erlaubte Netze</dt><dd class="mono">${esc(nz(p.allowed))}</dd>
    <dt>Letzter Handshake</dt><dd class="mono" title="${esc(p.seit || "")}">${t.handshake == null ? "nie" : esc(hs(t.handshake))}</dd>
    <dt>Übertragen</dt><dd class="mono">${t.rx ? `${esc(t.rx)} ↓ / ${esc(t.tx)} ↑` : "—"}</dd>
    ${p.keepalive ? `<dt>Keepalive</dt><dd class="mono">${esc(p.keepalive)} s</dd>` : ""}
  </dl></div>`;
}

function peerPanel() {
  const peers = PEERS.filter(p => state.site === "all" || p.site === state.site);
  const zeilen = peers.length ? peers : [EXAMPLES.peer];
  const tabelle = `<div class="panel-body panel-body--flush tablewrap">
    <table class="t"><thead><tr><th style="width:34px"></th><th>Peer</th><th>Gerät</th><th>Terminiert auf</th><th>Tunnel-IP</th><th>Endpunkt</th><th>RX / TX</th><th class="right">Handshake</th></tr></thead><tbody>
    ${zeilen.map(p => `<tr data-sev="${p.status}">
      <td class="sev">${dot(p.status)}</td>
      <td class="mono">${esc(p.name)}</td>
      <td>${esc(p.device)}</td>
      <td>${p.site ? chip("plain", siteShort(p.site)) : '<span class="faint">—</span>'}</td>
      <td class="mono faint">${esc(p.ip)}</td>
      <td class="mono faint">${esc(p.endpoint)}</td>
      <td class="mono faint">${esc(p.rx)} / ${esc(p.tx)}</td>
      <td class="right mono">${esc(hs(p.handshake))}</td>
    </tr>`).join("")}
    </tbody></table></div>`;

  if (peers.length) {
    const aktiv = peers.filter(p => p.status === "ok").length;
    const still = peers.filter(p => p.status === "idle").length;
    return `<div class="panel">
      <div class="panel-head"><h3>WireGuard-Gegenstellen</h3>
        <span class="hint">${aktiv} von ${peers.length} mit frischem Handshake${still ? ` · ${still} still` : ""}</span>
        <div class="spacer"></div><span class="hint">gelesen von der Firewall</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>Gegenstelle</th><th>Gelesen von</th>
          <th>Interface</th><th>Strecke</th><th>Erlaubte Netze</th><th>Endpunkt</th><th>RX / TX</th><th class="right">Handshake</th></tr></thead><tbody>
        ${peers.map(p => `<tr data-sev="${p.status}">
          <td class="sev">${dot(p.status)}</td>
          <td class="mono">${esc(p.name)}</td>
          <td>${chip("plain", siteShort(p.site))} <span class="mono faint" style="font-size:11px">${esc(p.von || "")}</span></td>
          <td class="mono faint">${esc(nz(p.iface))}</td>
          <td>${p.tunnel
            ? `<button class="btn btn--sm" data-action="inspect" data-kind="tunnel" data-id="${esc(p.tunnel)}" title="Dieser Peer trägt eine angelegte Strecke">${esc(p.tunnel)}</button>`
            : '<span class="faint" title="Keiner Strecke zugeordnet — meist ein Endgerät, kein Site-to-Site-Tunnel">—</span>'}</td>
          <td class="mono faint">${esc(nz(p.ip === "—" ? null : p.ip))}</td>
          <td class="mono faint">${esc(nz(p.endpoint === "—" ? null : p.endpoint))}</td>
          <td class="mono faint">${p.rx ? `${esc(p.rx)} / ${esc(p.tx)}` : "—"}</td>
          <td class="right mono" title="${esc(p.seit || "")}">${p.handshake == null
            ? '<span class="faint">nie</span>' : esc(hs(p.handshake))}</td>
        </tr>`).join("")}
        </tbody></table>
      </div>
      <div class="panel-note">Frisch heißt: Handshake jünger als drei Minuten. Ein Endgerät, das länger schweigt,
        ist meist einfach aus — deshalb gilt es als <b>ruhend</b> und nicht als gestört. Was hier steht, hat die
        Firewall gemeldet; gemessen wird die Strecke weiterhin zusätzlich durch den Tunnel.</div>
    </div>`;
  }

  return ausbaupanel("Endgeräte / Road-Warrior", "Stufe 3",
    `Einzelne Peers kennt nur die Firewall — Name, Endpunkt, letzter Handshake und übertragene Menge stehen in
     <span class="mono">wg show</span> bzw. der WireGuard-Schnittstelle von OPNsense. Ohne diesen Zugang lässt sich ein
     Endgerät nicht messen: es antwortet nicht auf Anfragen, es meldet sich nur.`, tabelle);
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
  if (!state.hosts.length) return onboarding();
  const hs = visibleHosts();
  const ag = hs.filter(h => h.type === "adguard");
  const mail = hs.filter(h => ["mailcow", "pmg"].includes(h.type));
  const ha = hs.filter(h => h.type === "hass");
  const rest = hs.filter(h => !["adguard", "mailcow", "pmg", "hass", "pve", "pbs", "truenas", "portainer", "opnsense", "pfsense"].includes(h.type));

  /* Für diese Typen gibt es noch keinen Sammler. Angezeigt wird deshalb
     das, was tatsächlich gemessen wurde: Erreichbarkeit, Antwortzeit,
     Zertifikat. Der Hinweis darunter sagt, was fehlt und woher es käme. */
  const einfach = (liste, spalte) => liste.map(h => serviceCard(h, `
    <div class="stat-row">
      ${stat("Antwort", nz(h.ms, " ms"))}
      ${stat("Zuletzt erreicht", fmtWhen(h.lastSeen) || "—")}
      ${spalte(h)}
      <div class="spacer"></div>${histCell(h, { w: 80, value: false })}
    </div>
    <div class="card-meta mono" style="font-size:10.5px">${checkList(h)}</div>`)).join("");

  return `
  <div class="panel">
    <div class="panel-head"><h3>DNS-Filter</h3><span class="hint">AdGuard Home</span>
      <div class="spacer"></div><span class="hint">geprüft wird mit einer echten Auflösung, nicht nur am Port</span></div>
    <div class="panel-body"><div class="grid g3">${ag.length
      ? einfach(ag, h => stat("Zertifikat", h.tls?.days != null ? h.tls.days + " T" : "—"))
      : '<div class="empty">Kein AdGuard in dieser Auswahl.</div>'}</div></div>
    ${ag.length ? `<div class="panel-note">Anfragen je Tag, Blockrate und Upstream-Latenz stehen unter
      <span class="mono">/control/stats</span> und brauchen einen Zugang — <b>Stufe 5</b>.</div>` : ""}
  </div>

  <div class="grid g2">
    <div class="panel">
      <div class="panel-head"><h3>Mail</h3><span class="hint">Mailcow · Proxmox Mail Gateway</span></div>
      <div class="panel-body"><div class="col">${mail.length ? mail.map(h => serviceCard(h, h.type === "pmg" ? `
        <div class="stat-row">
          ${stat("Eingang 24 h", nz(h.in24))}${stat("Spam", nz(h.spam))}
          ${stat("Viren", nz(h.virus))}${stat("Antwort", nz(h.ms, " ms"))}
          <div class="spacer"></div>${histCell(h, { w: 80, value: false })}
        </div>
        ${h.in24 == null ? `<div class="card-meta">Zahlen erst mit hinterlegtem API-Token — Verwaltung → ${esc(h.name)}</div>` : ""}` : `
        <div class="stat-row">
          ${stat("Antwort", nz(h.ms, " ms"))}
          ${stat("Zuletzt erreicht", fmtWhen(h.lastSeen) || "—")}
          ${stat("Zertifikat", h.tls?.days != null ? h.tls.days + " T" : "—")}
          <div class="spacer"></div>${histCell(h, { w: 80, value: false })}
        </div>
        <div class="card-meta mono" style="font-size:10.5px">${checkList(h)}</div>`)).join("")
        : '<div class="empty">Kein Mailsystem in dieser Auswahl.</div>'}</div></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Smart Home &amp; Übrige</h3><span class="hint">nur Erreichbarkeit</span></div>
      <div class="panel-body"><div class="col">${(ha.length || rest.length)
        ? einfach([...ha, ...rest], h => stat("Typ", TYPE_LABEL[h.type] || h.type))
        : '<div class="empty">Nichts in dieser Auswahl.</div>'}</div></div>
    </div>
  </div>

  ${certPanel()}`;
}

function certPanel() {
  const warn = thr("tls_warn_days") ?? 30, crit = thr("tls_crit_days") ?? 14;
  return `<div class="panel">
    <div class="panel-head"><h3>Zertifikate</h3><span class="hint">aus dem TLS-Handshake gelesen</span>
      <div class="spacer"></div><span class="hint">Warnung ab ${warn} Tagen · kritisch ab ${crit}</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Common Name</th><th>Aussteller</th><th>Gemessen an</th><th>Restlaufzeit</th></tr></thead><tbody>
      ${CERTS.length ? CERTS.map(c => `<tr data-sev="${c.status}">
        <td class="sev">${dot(c.status)}</td><td class="mono">${esc(c.cn)}</td>
        <td class="faint">${esc(c.issuer)}${c.selfSigned ? ' <span class="chip chip--plain">eigensigniert</span>' : ""}</td>
        <td class="mono faint">${esc(c.where)}</td>
        <td style="min-width:180px">${meter("", c.days < 0 ? 100 : Math.max(3, Math.min(100, Math.round(c.days / 90 * 100))),
          { text: c.days < 0 ? `seit ${Math.abs(c.days)} T abgelaufen` : c.days + " Tage",
            tone: c.days <= crit ? "crit" : c.days <= warn ? "warn" : "ok" })}</td>
      </tr>`).join("") : `<tr><td colspan="5"><div class="empty">Noch kein Zertifikat gelesen — es erscheint hier, sobald ein System eine <span class="mono">tls</span>-Prüfung hat und antwortet.</div></td></tr>`}
      </tbody></table>
    </div>
    <div class="panel-note">Der Leitstand liest nur ab, was der Server im Handshake vorzeigt. Erneuern kann und darf er
      nichts — jeder Zugang ist ein Konto ohne Schreibrechte.</div>
  </div>`;
}

/* ============================================================
   Ansicht: Alarm-Postfach
   ============================================================ */
/* Das Alarm-Postfach ist Stufe 4 und noch nicht angebunden: es gibt kein
   IMAP, kein Regelwerk, keinen Rohtext. Statt eines Posteingangs, der wie
   einer aussieht, steht hier die Erklärung samt genau einem Beispiel je
   Baustein — Nachricht, Regel, Kanal. */
function viewPost() {
  if (MAILS.length) return viewPostLive();
  if (state.mailTab === "rules") return postTabs() + postRegeln();
  if (state.mailTab === "cfg") return postTabs() + postWege();
  return postTabs() + postEingang();
}

function postTabs() {
  const tabs = [["inbox", "Posteingang"], ["rules", "Regeln"], ["cfg", "Benachrichtigung"]];
  return `<div class="row"><div class="seg">${tabs.map(([id, l]) =>
    `<button data-action="mailtab" data-tab="${id}" aria-pressed="${state.mailTab === id}">${esc(l)}</button>`).join("")}</div>
    <div class="spacer"></div>
    <span class="faint" style="font-size:12px">Geräte melden per E-Mail — daraus sollen Ampeln werden.</span></div>`;
}

function postEingang() {
  const m = EXAMPLES.mail;
  const beispiel = `<div class="panel-body panel-body--flush">
    <div class="mail-layout">
      <div class="mail-list">
        <div class="mail-item" data-sev="${m.sev}" aria-selected="true">
          <div class="mail-from"><span>${esc(m.from)}</span><span>${esc(m.time)}</span></div>
          <div class="mail-subj">${esc(m.subject)}</div>
          <div class="row" style="gap:6px">${chip(m.sev)}<span class="mono faint" style="font-size:10.5px">${esc(m.host)}</span></div>
        </div>
      </div>
      <div class="mail-body">
        <div>
          <h2 style="font-size:17px">${esc(m.subject)}</h2>
          <div class="mono faint" style="font-size:11.5px;margin-top:4px">${esc(m.from)} · ${esc(m.time)}</div>
        </div>
        <div>
          <div class="sec-title">Rohtext</div>
          <pre class="raw">${esc(m.raw)}</pre>
        </div>
      </div>
    </div>
  </div>`;

  return ausbaupanel("Posteingang", "Stufe 4", `Ein Postfach <span class="mono">alarm@…</span> wird per IMAP IDLE
    offen gehalten; jede eingehende Nachricht läuft gegen die Regelliste und wird zu einem Ereignis. Trifft keine
    Regel, wird die Mail <b>nicht verworfen</b>, sondern als „ohne Regel" sichtbar — samt Schaltfläche, aus genau
    dieser Nachricht eine Regel zu machen. So wächst das Regelwerk im Betrieb statt am Reißbrett.<br><br>
    Warum überhaupt Mail, wo es APIs gibt: <span class="mono">smartd</span>, ACME-Clients, vzdump-Berichte und
    Herstellergeräte melden verlässlich per SMTP und sonst gar nicht.`, beispiel);
}

function postRegeln() {
  const r = EXAMPLES.mailrule;
  const tabelle = `<div class="panel-body panel-body--flush tablewrap">
    <table class="t"><thead><tr><th style="width:34px"></th><th>Name</th><th>Bedingung</th><th>Einstufung</th><th>Wirkung</th><th class="right">Treffer</th></tr></thead><tbody>
      <tr data-sev="ok">
        <td class="sev">${dot("ok")}</td>
        <td>${esc(r.name)}</td>
        <td class="mono faint" style="white-space:normal">${esc(r.match)}</td>
        <td>${esc(r.sev)}</td>
        <td class="faint">${esc(r.target)}</td>
        <td class="right mono faint">${nz(r.hits)}</td>
      </tr>
    </tbody></table></div>`;

  return ausbaupanel("Auswerteregeln", "Stufe 4", `Eine Regel besteht aus Absender- und Betreffmuster, einer
    Zuordnung zum System und einer Einstufung. Gleiche Ursache heißt gleicher <span class="mono">fingerprint</span> —
    daraus wird eine Störung mit Zähler statt einer Flut neuer Zeilen. Diese Bündelung gibt es bereits, sie wird
    heute aus den Prüfungen gespeist; die Mailregeln hängen sich später an denselben Mechanismus.`, tabelle)
    + `<div class="panel">
    <div class="panel-head"><h3>Verarbeitungskette</h3><span class="hint">von der Mail zur Ampel</span></div>
    <div class="panel-body">
      <div class="grid g4">
        ${[["IMAP IDLE", "Das Postfach wird dauerhaft offen gehalten — eine neue Mail kommt ohne Verzögerung an."],
           ["Zuordnen", "Absender, Betreff und Rohtext werden gegen die Regeln geprüft und einem System zugeordnet."],
           ["Einstufen", "Die Regel setzt die Schwere; gleichartige Meldungen werden zu einer Störung gebündelt."],
           ["Melden", "Ampel im Lagebild, Push nach Kanalregel, Rohtext bleibt durchsuchbar."]]
          .map(([t, d], i) => `<div class="card" style="cursor:default">
            <div class="card-meta mono">Schritt ${i + 1}</div>
            <div class="card-title">${esc(t)}</div>
            <div class="muted" style="font-size:12.5px">${esc(d)}</div></div>`).join("")}
      </div>
    </div>
  </div>`;
}

function postWege() {
  const r = EXAMPLES.route;
  const tabelle = `<div class="panel-body panel-body--flush tablewrap">
    <table class="t"><thead><tr><th style="width:34px"></th><th>Kanal</th><th>Ziel</th><th>Ab Schwere</th><th>Ruhezeit</th></tr></thead><tbody>
      <tr data-sev="idle">
        <td class="sev">${dot("idle")}</td><td>${esc(r.channel)}</td>
        <td class="mono faint">${esc(r.to)}</td><td>${esc(r.sev)}</td><td class="faint">${esc(r.quiet)}</td>
      </tr>
    </tbody></table></div>`;

  return ausbaupanel("Benachrichtigungswege", "Stufe 6", `ntfy, Telegram, E-Mail und Signal je nach Schwere und
    Tageszeit — dazu ein Totmannschalter, der nach außen meldet, wenn der Leitstand selbst schweigt. Denn der
    Leitstand darf nicht die einzige Instanz sein, die weiß, dass etwas kaputt ist.<br><br>
    <b>Solange das fehlt, ist dieses Werkzeug ein Bildschirm, keine Alarmierung.</b> Wer nicht hinsieht, erfährt
    nichts — das ist der wichtigste offene Punkt.`, tabelle);
}

/* Sobald der Ingest steht, liefert der Server echte Nachrichten; dann
   gilt wieder der Posteingang statt der Erklärung. */
function viewPostLive() {
  const list = MAILS;
  const sel = byId(list, state.mail) || list[0];
  return `
  ${postTabs()}
  <div class="panel">
    <div class="panel-head"><h3>Posteingang</h3>
      <div class="spacer"></div>
      <span class="hint">${list.filter(m => !m.read).length} ungelesen · ${list.filter(m => !m.parsed).length} ohne Regel</span></div>
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
              </dl>
            </div>
          </div>
          <div>
            <div class="sec-title">Rohtext</div>
            <pre class="raw">${esc(sel.raw)}</pre>
          </div>` : '<div class="empty">Keine Nachricht ausgewählt.</div>'}
        </div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   Ansicht: Startseite (Linkpage)
   ============================================================ */
function viewLinks() {
  if (!LINKGROUPS.length) return `<div class="panel panel--hello"><div class="panel-body">
    <div class="sec-title">Startseite</div>
    <p class="muted" style="margin:0 0 12px;font-size:13px;max-width:64ch">Hier liegen die Oberflächen, die täglich gebraucht werden —
    jede Kachel trägt die Ampel des dahinterstehenden Systems. Damit ist die Startseite gleichzeitig die Ampelwand.</p>
    <button class="btn btn--primary" data-action="admin-open" data-tab="links">Verknüpfungen anlegen</button>
  </div></div>`;

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
    <div class="panel-head"><h3>${esc(g.name)}</h3><span class="hint">${g.links.length}</span></div>
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
/* Fassung ausführlich: Commit, Zweig, Zeitpunkt, Herkunft — und der Hinweis,
   falls im Dienst inzwischen ein anderer Stand läuft als in dieser Seite. */
function fassungZeile() {
  const b = state.fassung;
  if (!b || (!b.commit && !b.version))
    return `<span class="faint">unbekannt — das Abbild wurde ohne Bauparameter erzeugt</span>`;
  const teile = [];
  if (b.version) teile.push(`<span class="mono">v${esc(b.version)}</span>`);
  if (b.shortCommit) teile.push(`<span class="mono" title="${esc(b.commit || "")}">${esc(b.shortCommit)}</span>`);
  if (b.branch) teile.push(esc(b.branch));
  const zeile = teile.join(" · ");
  const zeiten = [];
  if (b.committed) zeiten.push(`festgeschrieben ${esc(fmtWhen(b.committed))}${b.source === "arbeitsbaum"
    ? '<span class="faint"> (Zeitpunkt der Referenz im Arbeitsbaum)</span>' : ""}`);
  if (b.built) zeiten.push(`${b.source === "dateistand" ? "Dateistand" : "gebaut"} ${esc(fmtWhen(b.built))}`);
  const stand = zeiten.join(" · ");
  const herkunft = b.source === "abbild" ? "aus dem Abbild"
    : b.source === "arbeitsbaum" ? "aus dem Arbeitsbaum — beim Entwickeln, kein Abbild im Spiel"
    : b.source === "dateistand" ? "Dateistand des Programms — das Abbild wurde ohne Bauparameter gebaut, "
      + "der Commit ist daher nicht bekannt"
    : "Herkunft unbekannt";
  const veraltet = state.neueFassung
    ? `<br><span style="color:var(--info)">Im Dienst läuft inzwischen ${esc(fassungText(state.neueFassung))} —
       diese Seite ist noch die alte. <button class="btn btn--sm" data-action="reload">Neu laden</button></span>`
    : "";
  return `${zeile}<br><span class="faint">${stand}${stand ? " · " : ""}${herkunft}</span>${veraltet}`;
}

function viewCfg() {
  const s = state.settings || {};
  const rt = state.runtime || {};
  const icmp = rt.icmp || {};
  const ziele = INTEGRATIONS.reduce((a, i) => a + i.targets, 0);

  const kv = rows => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const mono = v => `<span class="mono">${esc(v)}</span>`;

  return `
  <div class="panel">
    <div class="panel-head"><h3>Datenquellen</h3>
      <span class="hint">${INTEGRATIONS.length} Typen · ${ziele} Ziele</span>
      <div class="spacer"></div><span class="hint">alle Zugänge nur lesend</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Quelle</th><th>Zugang</th><th>Ziele</th><th>Intervall</th><th>Stand</th></tr></thead><tbody>
      ${INTEGRATIONS.length ? INTEGRATIONS.map(i => `<tr data-sev="${i.status}">
        <td class="sev">${dot(i.status)}</td><td>${esc(i.name)}</td>
        <td class="mono faint">${esc(i.method)}</td><td class="mono">${i.targets}</td>
        <td class="mono faint">${esc(i.every)}</td><td class="faint" style="white-space:normal">${esc(i.note)}</td>
      </tr>`).join("") : '<tr><td colspan="6"><div class="empty">Noch kein System angelegt.</div></td></tr>'}
      </tbody></table>
    </div>
    <div class="panel-note">Diese Übersicht wird aus dem Bestand abgeleitet, nicht gepflegt: sie zeigt, welcher Typ wie
      oft vorkommt, wo Zugangsdaten liegen und was bislang nur angepingt wird. Zugangsdaten setzt man unter
      <b>Verwaltung → System bearbeiten</b>.</div>
  </div>

  <div class="grid g2">
    <div class="panel">
      <div class="panel-head"><h3>Schwellwerte</h3><span class="hint">wann eine Ampel umspringt</span>
        <div class="spacer"></div><button class="btn btn--sm" data-action="admin-open" data-tab="settings">Ändern</button></div>
      <div class="panel-body">${kv([
        ["Durchlauf", s.interval != null ? `alle ${mono(s.interval + " s")}, Zeitlimit ${mono(s.timeout + " s")} je Prüfung` : "—"],
        ["System still", s.fail_threshold != null
          ? `${mono(s.fail_threshold)} Fehlschläge in Folge → kritisch (davor Warnung)` : "—"],
        ["Langsame Antwort", s.slow_ms != null ? `über ${mono(s.slow_ms + " ms")} → Warnung` : "—"],
        ["Zertifikat", s.tls_warn_days != null
          ? `unter ${mono(s.tls_warn_days + " Tagen")} Warnung · unter ${mono(s.tls_crit_days + " Tagen")} kritisch` : "—"],
        ["Verlauf", s.history != null ? `${mono(s.history)} Messpunkte je System${s.interval ? ` (${Math.round(s.history * s.interval / 60)} min)` : ""}` : "—"],
        ["Teilausfall", "antwortet ein Port nicht, während andere tragen → Warnung"],
        ["Abruf scheitert", "erreichbar, aber API-Zugang abgelehnt → Warnung statt stiller Lücke"],
        ["Standort", "sind alle überwachten Systeme eines Standorts gleichzeitig still → <b>eine</b> Meldung statt zwölf"]
      ])}</div>
      <div class="panel-note">Speicher-, Queue- und Handshake-Schwellen fehlen hier, weil es die dazugehörigen
        Messwerte noch nicht gibt. Ein Schwellwert ohne Messung wäre eine Zusage, die niemand einhält.</div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Dieser Dienst</h3><span class="hint">tatsächlicher Betriebszustand</span></div>
      <div class="panel-body">${kv([
        ["Zustand", LIVE()
          ? `${dot("ok")} verbunden${window.LEITSTAND?.lastRun ? ` · letzter Durchlauf ${esc(fmtWhen(window.LEITSTAND.lastRun))}` : ""}`
          : `${dot("crit")} kein Dienst erreichbar`],
        ["Fassung", fassungZeile()],
        ["Bestand", state.invFile ? mono(state.invFile) : "—"],
        ["Umfang", `${state.hosts.length} Systeme · ${SITES.length} Standorte · ${state.tunnels.length} Tunnel`],
        ["Läuft seit", rt.started ? esc(fmtWhen(rt.started)) : "—"],
        ["Zeitzone", rt.tz ? mono(rt.tz) : "—"],
        ["Node", rt.node ? mono(rt.node) : "—"],
        ["ICMP", icmp.working === true ? `${dot("ok")} ${esc(icmp.note)}`
          : icmp.working === false ? `${dot("warn")} ${esc(icmp.note)} — im Container fehlt meist <span class="mono">NET_RAW</span>`
          : icmp.configured === false ? `${dot("idle")} ${esc(icmp.note || "abgeschaltet")}`
          : `${dot("idle")} ${esc(icmp.note || "—")}`],
        ["Zugangsdaten", `liegen in <span class="mono">secrets.json</span> neben dem Bestand, Rechte 0600 — nach außen nur maskiert`],
        ["Schreibrechte", "keine: der Leitstand fragt ab, quittiert und schweigt — er greift nirgends ein"]
      ])}</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>Ausbaustand</h3><span class="hint">was läuft, was noch fehlt</span></div>
    <div class="panel-body"><div class="grid g2">
      <div>
        <div class="sec-title">Läuft</div>
        <ul class="muted" style="margin:0;padding-left:18px;line-height:1.9;font-size:13px">
          <li>ICMP-, TCP-, TLS-, DNS- und HTTP-Prüfung mit Verlauf</li>
          <li>Zertifikats-Restlaufzeit aller TLS-Ziele</li>
          <li>Tunnelmessung <i>durch</i> den Tunnel, ohne Zugangsdaten</li>
          <li>Proxmox VE, Backup Server und Mail Gateway über die API</li>
          <li>Störungen mit Bündelung, Quittieren, Stummschalten</li>
          <li>Standort-Bündelung statt Meldungsflut</li>
          <li>Verwaltung: Systeme, Standorte, Tunnel, Startseite, Schwellwerte</li>
        </ul>
      </div>
      <div>
        <div class="sec-title">Fehlt noch</div>
        <ul class="muted" style="margin:0;padding-left:18px;line-height:1.9;font-size:13px">
          <li><b>Push-Kanäle und Totmannschalter</b> — bis dahin ist das hier ein Bildschirm, keine Alarmierung</li>
          <li>Alarm-Postfach mit Regelwerk (smartd, vzdump, ACME, Herstellergeräte)</li>
          <li>OPNsense/pfSense: Version, Zustandstabelle, CARP, WireGuard-Handshake, HAProxy</li>
          <li>TrueNAS, AdGuard, Portainer, Mailcow, Home Assistant über die jeweilige API</li>
          <li>Wartungsfenster und Zeitreihen über mehr als eine halbe Stunde</li>
        </ul>
      </div>
    </div></div>
  </div>`;
}

/* ============================================================
   Diagnose

   Jeder Aufruf, den der Sammler macht, einzeln — mit dem, was zurückkam.
   Gedacht für den Fall „erreichbar, Rechte angeblich gesetzt, trotzdem
   keine Werte": von außen ist nicht zu erraten, an welcher Stelle es
   klemmt, also wird jede einzeln gezeigt.
   ============================================================ */
function diagnoseAnsicht(h) {
  const d = state.diagnose;
  if (!d || d.id !== h.id) return "";

  if (d.busy) return `<div><div class="sec-title">Diagnose</div>
    <div class="empty">Läuft — jeder Aufruf wird einzeln gemacht …</div></div>`;

  if (d.error) return `<div><div class="sec-title">Diagnose</div>
    <div class="row" style="gap:8px;align-items:flex-start;color:var(--crit)">${dot("crit")}
      <span style="font-size:13px">${esc(d.error)}</span></div></div>`;

  const b = d.result;
  if (!b) return "";

  const zeile = (ok, name, rechts, unten) => `
    <div style="padding:6px 0;border-bottom:1px solid var(--line)">
      <div class="row" style="gap:8px">
        ${dot(ok === null ? "idle" : ok ? "ok" : "crit")}
        <span class="mono" style="font-size:12.5px">${esc(name)}</span>
        <span class="spacer"></span>
        <span class="mono faint" style="font-size:11px">${esc(rechts || "")}</span>
      </div>
      ${unten ? `<div class="faint" style="font-size:11.5px;padding-left:20px;white-space:normal">${unten}</div>` : ""}
    </div>`;

  return `<div>
    <div class="row"><div class="sec-title" style="margin:0">Diagnose</div>
      <div class="spacer"></div>
      <button class="btn btn--sm" data-action="diagnose" data-id="${esc(h.id)}">Erneut</button>
      <button class="btn btn--sm" data-action="diagnose-text">${d.text ? "Ansicht" : "Als Text"}</button>
    </div>

    ${d.text ? `<pre class="raw" style="max-height:340px;overflow:auto">${esc(b.text || "")}</pre>` : `
      <div class="row" style="gap:8px;align-items:flex-start;margin:8px 0 12px;color:var(--${b.ok ? "ok" : "warn"})">
        ${dot(b.ok ? "ok" : "warn")}
        <span style="font-size:13px;white-space:normal"><b>${esc(b.fazit)}</b></span>
      </div>

      ${b.ziel ? `<dl class="kv">
        <dt>API</dt><dd class="mono">${esc(b.ziel)}</dd>
        <dt>Zugang</dt><dd class="mono" style="white-space:normal">${b.zugang?.vorhanden
          ? esc(b.zugang.form) : `<span class="faint">— ${esc(b.zugang?.hinweis || "keiner")}</span>`}</dd>
        ${b.zugang?.vorhanden && b.zugang.hinweis
          ? `<dt></dt><dd style="color:var(--warn)">${esc(b.zugang.hinweis)}</dd>` : ""}
      </dl>` : ""}

      <div class="sec-title" style="margin-top:10px">Netz</div>
      ${b.netz.map(n => zeile(n.uebersprungen ? null : n.ok, n.schritt,
        n.ms != null ? n.ms + " ms" : "", esc(n.detail || ""))).join("") || '<div class="empty">keine Prüfung</div>'}

      ${b.api.length ? `<div class="sec-title" style="margin-top:10px">Aufrufe des Sammlers</div>
        ${b.api.map(a => zeile(a.ok, a.pfad + (a.optional ? "  (optional)" : ""),
          a.ms != null ? a.ms + " ms" : (a.status ? "HTTP " + a.status : ""),
          `${esc(a.zweck)}<br><span style="color:var(--${a.ok ? "dim" : "crit"})">${
            esc(a.ok ? a.befund || "" : a.fehler)}</span>${
            a.antwort ? `<br><span class="mono" style="font-size:10.5px">${esc(a.antwort)}</span>` : ""}`)).join("")}` : ""}
    `}
  </div>`;
}

async function diagnose(id) {
  if (!requireLive()) return;
  state.diagnose = { id, busy: true, result: null, error: null, text: false };
  render();
  try {
    state.diagnose = { id, busy: false, result: await window.LEITSTAND.call("POST", "/api/admin/diagnose", { id }), error: null, text: false };
  } catch (e) {
    state.diagnose = { id, busy: false, result: null, error: e.message, text: false };
  }
  render();
}

/* ============================================================
   Inspector
   ============================================================ */
/* Im Fuß jedes Inspectors stehen nur Aktionen, die der Dienst wirklich
   ausführt: quittieren, stummschalten, einen Durchlauf auslösen, die
   Oberfläche des Systems öffnen. Nichts davon greift in ein überwachtes
   System ein — der Leitstand hat nirgends Schreibrechte. */
function inspectorContent(kind, id) {
  if (kind === "incident") {
    const i = byId(state.incidents, id); if (!i) return null;
    const h = byId(state.hosts, i.host);
    const mit = i.rollup ? `<dt>Mitbetroffen</dt><dd>${i.rollup} Einzelmeldung(en) hängen an dieser Störung</dd>` : "";
    return {
      kicker:`Störung ${i.id}`, title:i.title, sev:i.sev,
      body:`
        ${i.note ? `<div class="row" style="gap:8px;align-items:flex-start">${dot(i.sev)}<span style="color:var(--${i.sev});font-size:13px">${esc(i.note)}</span></div>` : ""}
        <div><div class="sec-title">Was gemessen wurde</div><pre class="raw">${esc(i.detail || "—")}</pre></div>
        <div><div class="sec-title">Eckdaten</div><dl class="kv">
          <dt>${i.kind === "site" ? "Standort" : "Gegenstand"}</dt><dd class="mono">${esc(i.host)}</dd>
          <dt>Standort</dt><dd>${esc(siteName(i.site))}</dd>
          <dt>Erkannt</dt><dd>${esc(i.first)} (${esc(ago(i.ageMin))})</dd>
          <dt>Seither gesehen</dt><dd>${nz(i.count, "×")}</dd>
          <dt>Quelle</dt><dd>${esc(SRC_LABEL[i.src] || i.src)}</dd>
          <dt>Regel</dt><dd class="mono">${esc(i.rule)}</dd>
          <dt>Status</dt><dd>${i.ack ? "quittiert" : "offen"}</dd>
          ${mit}
        </dl></div>
        ${i.affected ? `<div><div class="sec-title">Betroffen</div><div class="row row-wrap" style="gap:6px">
          ${i.affected.map(a => `<span class="chip chip--plain mono">${esc(a)}</span>`).join("")}</div></div>` : ""}
        ${h && (h.hist || []).length ? `<div><div class="sec-title">Antwortzeit ${esc(h.name)}</div>${spark(h.hist, { w:460, h:70, color:`var(--${i.sev})` })}</div>` : ""}`,
      foot:`
        <button class="btn btn--primary" data-action="ack" data-id="${esc(i.id)}">${i.ack ? "Quittierung aufheben" : "Quittieren"}</button>
        <button class="btn" data-action="silence" data-id="${esc(i.host)}" data-minutes="120">2 h stummschalten</button>
        ${h && h.url ? `<a class="btn" href="${esc(h.url)}" target="_blank" rel="noopener">${ICON.ext} System öffnen</a>` : ""}`
    };
  }

  if (kind === "host") {
    const h = byId(state.hosts, id); if (!h) return null;
    const inc = state.incidents.filter(x => x.host === h.id);
    const rows = [
      ["Typ", esc(TYPE_LABEL[h.type] || h.type)],
      h.role ? ["Rolle", esc(h.role)] : null,
      ["Standort", esc(siteName(h.site))],
      ["Adresse", `<span class="mono">${esc(nz(h.ip))}</span>`],
      h.url ? ["Oberfläche", `<a class="mono" href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.url)}</a>`] : null,
      ["Version", `<span class="mono">${esc(nz(h.version))}</span>`],
      ["Laufzeit", esc(nz(h.uptime))],
      /* Ohne die Zahl der Kerne sagt eine Last nichts über „viel" oder
         „wenig" — sie steht deshalb da, ohne bewertet zu werden. */
      h.load ? ["Last (1 / 5 / 15 min)", `<span class="mono">${esc(h.load)}</span>`] : null,
      ["Zuletzt erreicht", esc(fmtWhen(h.lastSeen) || "nie")],
      ["Überwacht", h.monitored === false ? "nein — absichtlich unüberwacht" : "ja"]
    ].filter(Boolean);

    return {
      kicker:TYPE_LABEL[h.type] || h.type, title:h.name, sev:h.status,
      body:`
        ${h.note ? `<div class="row" style="gap:8px;align-items:flex-start">${dot(h.status)}<span style="color:var(--${h.status});font-size:13px">${esc(h.note)}</span></div>` : ""}
        <div><div class="sec-title">Stammdaten</div><dl class="kv">
          ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}
        </dl></div>
        <div><div class="sec-title">Prüfungen im letzten Durchlauf</div>
          ${(h.checks || []).length ? (h.checks || []).map(c => `<div class="row" style="gap:8px;font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--line)">
            ${dot(c.skipped ? "idle" : c.ok ? "ok" : "crit")}
            <span class="mono">${esc(c.kind)}${c.port ? "/" + c.port : ""}</span>
            <span class="faint" style="min-width:0">${esc(c.detail || "")}</span>
            <span class="spacer"></span><span class="mono faint">${c.ms != null ? c.ms + " ms" : ""}</span>
          </div>`).join("") : '<div class="empty">Noch kein Durchlauf.</div>'}</div>
        ${h.tls ? `<div><div class="sec-title">Zertifikat</div><dl class="kv">
          <dt>Common Name</dt><dd class="mono">${esc(h.tls.cn || "—")}</dd>
          <dt>Aussteller</dt><dd>${esc(h.tls.issuer || "—")}${h.tls.selfSigned ? " (eigensigniert)" : ""}</dd>
          <dt>Restlaufzeit</dt><dd class="mono">${h.tls.days != null ? h.tls.days + " Tage" : "—"}</dd>
        </dl></div>` : ""}
        ${hasMetrics(h) ? `<div><div class="sec-title">Auslastung</div><div class="col" style="gap:8px">
          ${h.cpu != null ? meter("CPU", h.cpu) : ""}${h.ram != null ? meter("RAM", h.ram) : ""}${h.disk != null ? meter("Speicher", h.disk) : ""}
        </div></div>` : ""}
        ${(h.storages || h.stores || []).length ? `<div><div class="sec-title">${h.type === "pbs" ? "Datastores" : "Speicher"}</div>
          <div class="col" style="gap:8px">${(h.storages || h.stores).map(s =>
            meter(s.name, s.used, { text: s.used != null ? s.used + " %" : "—" })).join("")}</div></div>` : ""}
        ${h.collectorError ? `<div class="row" style="gap:8px;align-items:flex-start;color:var(--warn)">${dot("warn")}
          <span style="font-size:12.5px">Abruf über die API: ${esc(h.collectorError)}</span></div>` : ""}
        ${diagnoseAnsicht(h)}
        ${(h.hist || []).length ? `<div><div class="sec-title">Antwortzeit</div>${spark(h.hist, { w:460, h:70, color:`var(--${h.status === "ok" ? "accent" : h.status})` })}</div>` : ""}
        ${inc.length ? `<div><div class="sec-title">Offene Meldungen</div>${inc.map(i => `
          <div class="row" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer" data-action="inspect" data-kind="incident" data-id="${esc(i.id)}">
            ${dot(i.sev)}<span style="font-size:12.5px">${esc(i.title)}</span>
            <span class="spacer"></span><span class="mono faint" style="font-size:11px">${esc(i.id)}</span></div>`).join("")}</div>` : ""}`,
      foot:`
        ${h.url ? `<a class="btn btn--primary" href="${esc(h.url)}" target="_blank" rel="noopener">${ICON.ext} Oberfläche öffnen</a>` : ""}
        <button class="btn" data-action="diagnose" data-id="${esc(h.id)}">Diagnose</button>
        <button class="btn" data-action="check-now">Jetzt prüfen</button>
        ${inc.length ? `<button class="btn" data-action="silence" data-id="${esc(h.id)}" data-minutes="120">2 h stummschalten</button>` : ""}
        <button class="btn" data-action="admin-edit" data-kind="hosts" data-id="${esc(h.id)}">Bearbeiten</button>`
    };
  }

  if (kind === "tunnel") {
    const t = byId(state.tunnels, id); if (!t) return null;
    return {
      kicker:"Tunnel", title:`${siteName(t.a)} ↔ ${siteName(t.b)}`, sev:t.status,
      body:`
        ${t.note ? `<div class="row" style="gap:8px;align-items:flex-start">${dot(t.status)}<span style="color:var(--${t.status});font-size:13px">${esc(t.note)}</span></div>` : ""}
        <div><div class="sec-title">Strecke</div><dl class="kv">
          <dt>Interface</dt><dd class="mono">${esc(nz(t.iface))}</dd>
          <dt>Transfernetz</dt><dd class="mono">${esc(nz(t.net))}</dd>
          <dt>Gemessen auf</dt><dd class="mono">${t.probe ? esc(t.probe) : '<span class="faint">— keine Gegenstelle eingetragen</span>'}</dd>
          <dt>Latenz</dt><dd class="mono">${esc(nz(t.rtt, " ms"))}</dd>
          <dt>Zuletzt erreicht</dt><dd>${esc(fmtWhen(t.lastSeen) || "nie")}</dd>
        </dl></div>
        ${tunnelPeerBlock(t)}
        ${(t.hist || []).length ? `<div><div class="sec-title">Latenzverlauf</div>${spark(t.hist, { w:460, h:70, color:`var(--${t.status === "ok" ? "ok" : t.status})` })}</div>` : ""}
        <p class="admin-hint" style="margin:0">${t.probe
          ? `Gemessen wird durch den Tunnel auf die Gegenstelle im Transfernetz. Das braucht keinerlei Zugangsdaten
             und beantwortet die Frage, die zählt: trägt die Strecke gerade?`
          : `Für diese Strecke gibt es keine Gegenstelle im Transfernetz — der Zustand kommt allein aus dem Handshake
             des verknüpften Peers. Der sagt, wann die Strecke zuletzt stand, nicht ob gerade etwas hindurchkommt.
             Eine Adresse im Transfernetz nachzutragen ist die belastbarere Messung.`}</p>`,
      foot:`
        <button class="btn btn--primary" data-action="check-now">Jetzt prüfen</button>
        <button class="btn" data-action="admin-edit" data-kind="tunnels" data-id="${esc(t.id)}">Bearbeiten</button>`
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
          <dt>Kennung</dt><dd class="mono">${esc(s.id)}</dd>
          <dt>Ort</dt><dd>${esc(s.place || "—")}</dd>
          <dt>Anschluss</dt><dd>${esc(s.isp || "—")}</dd>
          <dt>WAN IPv4</dt><dd class="mono">${esc(s.wan || "—")}</dd>
          <dt>WAN IPv6</dt><dd class="mono">${esc(s.wan6 || "—")}</dd>
          <dt>Rolle</dt><dd>${s.primary ? "Hauptstandort" : "Außenstandort"}</dd>
        </dl></div>
        <div><div class="sec-title">Systeme (${hosts.length})</div>
          ${hosts.length ? hosts.map(h => `<div class="row" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer" data-action="inspect" data-kind="host" data-id="${esc(h.id)}">
            ${dot(h.status)}<span class="mono" style="font-size:12.5px">${esc(h.name)}</span>
            <span class="spacer"></span><span class="faint" style="font-size:11.5px">${esc(TYPE_LABEL[h.type] || h.type)}</span></div>`).join("")
            : '<div class="empty">Noch keines angelegt.</div>'}</div>
        <div><div class="sec-title">Tunnel (${tuns.length})</div>
          ${tuns.length ? tuns.map(t => `<div class="row" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer" data-action="inspect" data-kind="tunnel" data-id="${esc(t.id)}">
            ${dot(t.status)}<span style="font-size:12.5px">nach ${esc(siteName(t.a === s.id ? t.b : t.a))}</span>
            <span class="spacer"></span><span class="mono faint" style="font-size:11.5px">${esc(nz(t.rtt, " ms"))}</span></div>`).join("")
            : '<div class="empty">Keiner angelegt.</div>'}</div>`,
      foot:`<button class="btn btn--primary" data-action="site-filter" data-id="${esc(s.id)}">Auf diesen Standort filtern</button>
        <button class="btn" data-action="admin-edit" data-kind="sites" data-id="${esc(s.id)}">Bearbeiten</button>`
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
  for (const s of SITES) items.push({ kind:"Standort", label:s.name, sub:s.place || s.id, run:() => open("site", s.id) });
  for (const t of state.tunnels) items.push({ kind:"Tunnel", label:`${siteShort(t.a)} ↔ ${siteShort(t.b)}`, sub:t.iface || t.id, run:() => open("tunnel", t.id) });
  for (const i of state.incidents) items.push({ kind:"Störung", label:i.title, sub:`${i.id} · ${i.host}`, run:() => open("incident", i.id) });
  for (const g of LINKGROUPS) for (const l of g.links) items.push({ kind:"Link", label:l.n, sub:String(l.u).replace(/^https?:\/\//, ""), run:() => window.open(l.u, "_blank", "noopener") });
  items.push({ kind:"Aktion", label:"Nur Probleme anzeigen", sub:"Filter umschalten", run:() => { state.onlyProblems = !state.onlyProblems; render(); } });
  items.push({ kind:"Aktion", label:"Hell/Dunkel umschalten", sub:"Darstellung", run:toggleTheme });
  items.push({ kind:"Aktion", label:"Jetzt prüfen", sub:"Durchlauf sofort auslösen", run:checkNow });
  items.push({ kind:"Aktion", label:"Alle Warnungen quittieren", sub:"Störungen", run:ackAllWarnings });
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
   Aktionen, die der Dienst wirklich ausführt

   Jede geht über die API und wird erst angezeigt, wenn sie dort
   angekommen ist. Ein Schalter, der nur die Anzeige ändert, wäre in
   einer Überwachung eine Lüge mit Verzögerung: nach dem nächsten
   Durchlauf steht wieder das Gegenteil da.
   ============================================================ */
function requireLive() {
  if (LIVE()) return true;
  toast("Kein Dienst", "Ohne laufenden Leitstand lässt sich nichts speichern.", "crit");
  return false;
}

async function ackIncident(id) {
  const i = byId(state.incidents, id);
  if (!i || !requireLive()) return;
  const on = !i.ack;
  try {
    await window.LEITSTAND.call("POST", `/api/incidents/${encodeURIComponent(id)}/ack`, { on });
    i.ack = on;                                   /* bis der nächste Durchlauf es bestätigt */
    toast(on ? "Quittiert" : "Quittierung aufgehoben", `${i.id} — ${i.title}`, on ? "ok" : "");
  } catch (e) { toast("Nicht gespeichert", e.message, "crit"); }
  render();
}

async function ackAllWarnings() {
  if (!requireLive()) return;
  const offen = state.incidents.filter(i => i.sev === "warn" && !i.ack);
  if (!offen.length) { toast("Nichts zu tun", "Keine unquittierte Warnung offen."); return; }
  try {
    for (const i of offen) await window.LEITSTAND.call("POST", `/api/incidents/${encodeURIComponent(i.id)}/ack`, { on: true });
    offen.forEach(i => { i.ack = true; });
    toast("Quittiert", `${offen.length} Warnung(en) quittiert.`, "ok");
  } catch (e) { toast("Abgebrochen", e.message, "crit"); }
  render();
}

/* Stummschalten hängt am Gegenstand, nicht an der einzelnen Meldung:
   ein System, das gerade umgebaut wird, soll auch dann still bleiben,
   wenn sich die Ursache dabei ändert. */
async function silenceHost(id, minutes) {
  if (!requireLive()) return;
  try {
    await window.LEITSTAND.call("POST", `/api/hosts/${encodeURIComponent(id)}/silence`, { minutes });
    toast("Stummgeschaltet", `${id} meldet sich für ${minutes} Minuten nicht.`, "ok");
    state.inspector = null;
  } catch (e) { toast("Nicht stummgeschaltet", e.message, "crit"); }
  render();
}

/* Der Durchlauf dauert so lange wie das langsamste stille System. Die
   Rückmeldung kommt deshalb sofort, das Ergebnis über den Zustandsstrom —
   sonst sähe die Schaltfläche eine halbe Minute lang tot aus. */
function checkNow() {
  if (!requireLive()) return;
  toast("Prüfung läuft", "Der Durchlauf ist angestoßen — die Anzeige folgt.", "ok");
  window.LEITSTAND.call("POST", "/api/admin/check")
    .catch(e => toast("Fehlgeschlagen", e.message, "crit"));
}

/* ============================================================
   Zeichnen & Verdrahten
   ============================================================ */
const RENDERERS = { lage:viewLage, sites:viewSites, compute:viewCompute, netz:viewNetz, vpn:viewVpn,
  dienste:viewDienste, post:viewPost, links:viewLinks, cfg:viewCfg, verwaltung:viewVerwaltung };

function render() {
  const scroll = $("#scroll") ? $("#scroll").scrollTop : 0;

  /* Ein offenes Formular darf eine Aktualisierung aus dem Netz überleben:
     Eingaben in den Zustand sichern, danach Fokus und Schreibmarke zurück. */
  let focus = null;
  const merke = (attr, wert) => { focus = { sel: `[data-${attr}="${wert}"]`, pos: document.activeElement.selectionStart }; };
  const a = document.activeElement;
  if (state.form && state.form.open) {
    collectForm();
    if (a && a.dataset.field) merke("field", a.dataset.field);
    else if (a && a.dataset.cred) merke("cred", a.dataset.cred);
  } else if (state.view === "verwaltung" && state.adminTab === "links") {
    /* Dieselbe Vorsorge für die Startseiten-Tabelle: sie besteht aus
       freien Feldern, und jeder Zustandsstrom vom Server zeichnet neu. */
    collectLinks();
    if (a && a.dataset.link) merke("link", a.dataset.link);
    else if (a && a.dataset.group) merke("group", a.dataset.group);
  }
  $("#rail-nav").innerHTML = renderRail();
  $("#top").innerHTML = renderTopbar();
  /* Reihenfolge mit Absicht: „verbindet gerade" vor „nicht erreichbar" vor
     Inhalt. Die Verwaltung bleibt auch ohne Dienst erreichbar, weil sie
     dann erklärt, was zu tun ist. */
  $("#wrap").innerHTML = state.connecting
    ? `<div class="panel"><div class="empty">Verbinde mit dem Leitstand …</div></div>`
    : (!LIVE() && state.view !== "verwaltung")
      ? viewOffline()
      : (RENDERERS[state.view] || viewLage)();
  $("#overlays").innerHTML = renderInspector() + renderAdminForm() + renderPalette();
  if ($("#scroll")) $("#scroll").scrollTop = scroll;
  if (focus) {
    const el = $(focus.sel);
    if (el) { el.focus(); try { el.setSelectionRange(focus.pos, focus.pos); } catch {} }
  }
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
    case "mail": state.mail = el.dataset.id; render(); break;
    case "mailtab": state.mailTab = el.dataset.tab; render(); break;

    case "ack": ackIncident(el.dataset.id); break;
    case "silence": silenceHost(el.dataset.id, Number(el.dataset.minutes) || 120); break;
    case "check-now": checkNow(); break;
    case "diagnose": diagnose(el.dataset.id); break;
    case "diagnose-text": if (state.diagnose) { state.diagnose.text = !state.diagnose.text; render(); } break;
    /* Hart neu laden: nach einem Redeploy soll auch das JavaScript neu
       kommen, nicht nur der Zustand. */
    case "reload": location.reload(); break;
    case "dismiss-build": state.neueFassung = null; state.neuGestartet = null; render(); markSource(); break;
    case "reconnect": {
      state.connecting = true; state.offline = null; render(); markSource();
      window.LEITSTAND.retry();
      break;
    }

    /* ---- Verwaltung ---- */
    case "admin-open": go("verwaltung"); state.adminTab = el.dataset.tab || "hosts"; render(); break;
    case "admintab": state.adminTab = el.dataset.tab; render(); break;
    case "admin-new": state.inspector = null; openForm(el.dataset.kind, "new"); break;
    case "admin-edit": state.inspector = null; openForm(el.dataset.kind, "edit", el.dataset.id); break;
    case "admin-delete": adminDelete(el.dataset.kind, el.dataset.id); break;
    case "admin-reload": state.rawLinks = null; adminCall("POST", "/api/admin/reload", null, "Bestand neu eingelesen"); break;
    case "admin-check": adminCall("POST", "/api/admin/check", null, "Durchlauf ausgelöst"); break;
    case "admin-save-settings": saveSettings(); break;

    /* ---- Startseite ---- */
    case "link-newgroup": collectLinks(); state.rawLinks = [...(state.rawLinks || []), { group: "Neue Gruppe", items: [] }]; render(); break;
    case "link-delgroup": linkDeleteGroup(+el.dataset.idx); break;
    case "link-add": collectLinks(); state.rawLinks[+el.dataset.group].items.push({ name: "", url: "" }); render(); break;
    case "link-del": collectLinks(); state.rawLinks[+el.dataset.group].items.splice(+el.dataset.idx, 1); render(); break;
    case "link-move": linkMove(+el.dataset.group, +el.dataset.idx, +el.dataset.dir); break;
    case "link-move-group": linkMoveGroup(+el.dataset.idx, +el.dataset.dir); break;
    case "link-save": saveLinks(); break;
    case "link-revert": state.rawLinks = null; loadAdmin(); toast("Verworfen", "Der gespeicherte Stand ist wieder da."); break;
    case "form-close": state.form = null; render(); break;
    case "form-toggle": {
      const f = state.form; if (!f) break;
      collectForm();
      f.data[el.dataset.field] = !f.data[el.dataset.field];
      render(); break;
    }
    case "form-test": formTest(); break;
    case "form-save": formSave(); break;
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
   Start und Anbindung an den Server
   ============================================================ */
function applyLive(st) {
  SITES = st.sites || []; HOSTS = st.hosts || []; TUNNELS = st.tunnels || []; INCIDENTS = st.incidents || [];
  LINKGROUPS = st.links || []; CERTS = st.certs || []; INTEGRATIONS = st.integrations || [];
  HAPROXY = st.haproxy || []; PEERS = st.peers || []; BACKUPS = st.backups || [];
  MAILS = st.mails || []; MAILRULES = st.mailrules || []; ROUTES = st.routes || [];

  state.hosts = HOSTS;
  state.tunnels = TUNNELS;
  state.incidents = INCIDENTS;
  /* Schwellwerte kommen mit jedem Zustand mit; die Verwaltung ergänzt
     später nur noch die maskierten Zugangsdaten und den Dateipfad. */
  if (st.meta?.settings) state.settings = { ...state.settings, ...st.meta.settings };
  if (st.meta?.runtime) state.runtime = st.meta.runtime;
  merkeFassung(st.meta?.runtime?.build || null, st.meta?.runtime || null);
  state.connecting = false;
  state.offline = null;
  render();
  markSource();
}

/* Beim ersten Zustand wird der Stand gemerkt, danach nur noch verglichen.

   Zwei Dinge können sich ändern, und beide gehen die Seite an:
   der Stand (neu ausgerollt) und der Startzeitpunkt (Prozess neu gestartet).
   Der Startzeitpunkt greift auch dann, wenn das Abbild gar keine Fassung
   nennt — nach einem Redeploy ist er in jedem Fall ein anderer. */
function merkeFassung(build, runtime) {
  const gestartet = runtime?.started || null;
  if (!state.fassung && build) state.fassung = build;
  if (!state.gestartet && gestartet) { state.gestartet = gestartet; return; }

  const alt = buildId(state.fassung), neu = buildId(build);
  if (neu && alt && neu !== alt) {
    if (buildId(state.neueFassung) === neu) return;            /* schon gemeldet */
    state.neueFassung = build;
    state.neuGestartet = false;
    toast("Neue Fassung", `${fassungText(build)} ist ausgerollt — neu laden, um sie zu sehen.`, "info");
    return;
  }
  if (gestartet && state.gestartet && gestartet !== state.gestartet && !state.neueFassung && !state.neuGestartet) {
    state.neuGestartet = gestartet;
    toast("Dienst neu gestartet", `Läuft seit ${fmtWhen(gestartet)} — bei einem Redeploy lohnt Neuladen.`, "info");
  }
}

/* Der Dienst antwortet nicht. Das ist selbst eine Meldung — und zwar die
   wichtigste: solange sie steht, wird gar nichts überwacht. Deshalb wird
   sie ganzflächig angezeigt statt in einer Ecke. */
function viewOffline() {
  const grund = state.offline || "Kein Dienst erreichbar";
  return `<div class="panel panel--offline">
    <div class="panel-body">
      <div class="row" style="gap:10px;align-items:flex-start">
        ${dot("crit")}
        <div style="min-width:0">
          <div class="sec-title" style="color:var(--crit)">Kein Leitstand erreichbar</div>
          <p class="muted" style="margin:0 0 12px;font-size:13.5px;max-width:64ch">
            <span class="mono">${esc(grund)}</span> — die Oberfläche zeigt deshalb nichts an.
            Ein Bildschirm mit alten oder ausgedachten Werten wäre hier gefährlicher als ein leerer:
            man hielte ihn für eine Aussage über den Netzzustand.</p>
          <div class="sec-title">Dienst starten</div>
          <pre class="raw">cd server
npm install
npm start        # danach http://localhost:8080</pre>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px">Im Container: läuft der Stack? Zeigt der Healthcheck
          grün? Sitzt ein Reverse Proxy davor, muss auch <span class="mono">/api/stream</span> (Server-Sent Events,
          ohne Pufferung) durchgereicht werden.</p>
          <div class="row" style="gap:8px;margin-top:14px">
            <button class="btn btn--primary" data-action="reconnect">Erneut verbinden</button>
            <span class="faint" style="font-size:12.5px">Es wird ohnehin weiter versucht — die Schaltfläche
              nimmt den nächsten Versuch nur vorweg.</span>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function markSource() {
  const el = $("#datasource");
  if (!el) return;
  const L = window.LEITSTAND;
  if (L && L.live) {
    const t = L.lastRun ? new Date(L.lastRun).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
    el.innerHTML = `<span class="dot dot--ok"></span><span class="faint" style="font-size:11px">Live · alle ${esc(String(L.interval || "?"))} s · ${esc(t)}</span>`;
  } else if (state.connecting) {
    el.innerHTML = `<span class="dot dot--idle"></span><span class="faint" style="font-size:11px">verbinde …</span>`;
  } else {
    el.innerHTML = `<span class="dot dot--crit"></span><span class="faint" style="font-size:11px">kein Dienst</span>`;
  }
  const sub = $("#brand-sub");
  if (sub) sub.textContent = L && L.live
    ? `${state.hosts.length} Systeme · ${SITES.length} Standort${SITES.length === 1 ? "" : "e"}`
    : "nicht verbunden";

  const bl = $("#buildline");
  if (bl) {
    const b = state.fassung;
    bl.textContent = fassungText(b);
    bl.title = b ? fassungText(b, true) : "Der Dienst nennt keine Fassung — vermutlich ein Abbild ohne Bauparameter.";
    bl.dataset.state = (state.neueFassung || state.neuGestartet) ? "veraltet" : b ? b.source : "unbekannt";
  }
}

(() => {
  const v = location.hash.replace("#/", "");
  if (RENDERERS[v]) state.view = v;

  const L = window.LEITSTAND;
  if (L && L.pending) {
    state.connecting = true;
    render();
    markSource();
    L.onState(st => { applyLive(st); if (!state.adminLoaded) loadAdmin(); });
    L.onFail(msg => { state.connecting = false; state.offline = msg; render(); markSource(); });
    L.onStale(() => { render(); markSource(); });
  } else {
    state.offline = (L && L.error) || "Kein Dienst erreichbar";
    render();
    markSource();
  }
})();

/* ---------- Verwaltung: Daten und Aktionen ---------- */
async function loadAdmin() {
  if (!LIVE()) return;
  try {
    const inv = await window.LEITSTAND.call("GET", "/api/admin/inventory");
    state.credentials = inv.credentials || {};
    state.settings = inv.settings || state.settings;
    state.invFile = inv.file || null;
    state.rawSites = inv.sites || [];
    /* Die Startseite wird als Ganzes geschrieben; dafür braucht die
       Verwaltung den Rohbestand, nicht die aufbereitete Ansicht. Ein
       angefangener, noch nicht gespeicherter Stand darf dabei nicht
       verlorengehen — nur ein ausdrückliches „Verwerfen" holt neu. */
    if (!state.rawLinks) state.rawLinks = inv.links || [];
    state.adminLoaded = true;
    render();
  } catch (e) { console.warn("Verwaltung nicht ladbar:", e.message); }
}

function openForm(kind, mode, id) {
  let data = {};
  if (mode === "edit") {
    if (kind === "hosts") {
      const h = byId(state.hosts, id);
      data = { id: h.id, type: h.type, site: h.site, ip: h.ip || "", url: h.url || "", role: h.role || "", monitor: h.monitored !== false };
    } else if (kind === "sites") {
      const s = SITES.find(x => x.id === id);
      if (!s) return;
      const roh = (state.rawSites || []).find(x => String(x.id) === String(id)) || {};
      const oder = v => (v && v !== "—" ? v : "");
      data = {
        id: s.id, name: s.name, short: oder(s.short), place: oder(s.place),
        isp: oder(s.isp), wan: oder(s.wan), wan6: oder(s.wan6), primary: !!(s.primary ?? roh.primary)
      };
    } else {
      const t = byId(state.tunnels, id);
      if (!t) return;
      data = { id: t.id, a: t.a, b: t.b, iface: t.iface || "", net: t.net || "",
        probeIp: t.probe || "", probePort: t.probePort || "",
        /* Der hinterlegte Peer bleibt im Formular erhalten, auch wenn die
           Firewall ihn gerade nicht meldet — sonst löschte allein das
           Öffnen des Formulars eine gültige Verknüpfung. */
        peerOrig: t.peer || null,
        peerRef: t.peer ? (peerRefOf(t.peer) || "__gespeichert") : "" };
    }
  } else {
    const erster = (SITES[0] || {}).id;
    if (kind === "hosts") data = { type: "pve", site: erster, monitor: true };
    if (kind === "sites") data = { primary: !SITES.length };   /* der erste Standort ist der Hauptstandort */
    if (kind === "tunnels") data = { a: erster, b: (SITES[1] || SITES[0] || {}).id, iface: "wg0" };
  }
  state.form = { open: true, kind, mode, data, test: null, error: null, busy: false, cred: {} };
  render();
}

/* Eingaben einsammeln, bevor neu gezeichnet wird — sonst gehen sie verloren.

   Nur echte Eingabefelder: die Schalter (Überwachen, Hauptstandort) tragen
   dieselbe `data-field`-Kennung, sind aber <span> ohne `value`. Wurden sie
   mitgelesen, überschrieb `undefined` den gesetzten Wert — der Schalter ließ
   sich dann nicht umlegen, und beim Speichern ging seine Stellung verloren. */
function collectForm() {
  const f = state.form;
  if (!f) return;
  for (const el of document.querySelectorAll("input[data-field], select[data-field], textarea[data-field]"))
    f.data[el.dataset.field] = el.value;
  for (const el of document.querySelectorAll("input[data-cred], select[data-cred], textarea[data-cred]"))
    f.cred[el.dataset.cred] = el.value;
}

function formPayload() {
  const f = state.form, d = { ...f.data };
  if (f.kind === "tunnels") {
    d.probe = { ip: d.probeIp };
    if (d.probePort) d.probe.port = Number(d.probePort);
    delete d.probeIp; delete d.probePort;

    /* Ausdrücklich null, nicht weglassen: nur so löst der Dienst eine
       bestehende Verknüpfung wieder — ein fehlendes Feld ließe die alte
       stehen, weil die Änderung auf den bestehenden Eintrag gelegt wird. */
    const ref = d.peerRef;
    delete d.peerRef; delete d.peerOrig;
    if (!ref) d.peer = null;
    else if (ref === "__gespeichert") d.peer = f.data.peerOrig || null;
    else {
      const p = PEERS.find(x => x.id === ref);
      d.peer = p ? { host: p.von, iface: p.iface || undefined, name: p.name, key: p.key || undefined } : null;
    }
  }
  for (const k of Object.keys(d)) if (d[k] === "") delete d[k];
  if (f.kind === "hosts") d.monitor = f.data.monitor !== false;
  if (f.kind === "sites") d.primary = !!f.data.primary;
  return d;
}

async function formTest() {
  collectForm();
  const f = state.form;
  f.busy = true; f.error = null; render();
  try {
    const cred = {};
    for (const [k, v] of Object.entries(f.cred || {})) if (v) cred[k] = v;
    f.test = await window.LEITSTAND.call("POST", "/api/admin/test", { ...formPayload(), credentials: Object.keys(cred).length ? cred : undefined });
  } catch (e) { f.error = e.message; }
  f.busy = false; render();
}

async function formSave() {
  collectForm();
  const f = state.form;
  if (!f.data.id) { f.error = "Kennung fehlt."; render(); return; }
  if (f.kind === "tunnels" && !String(f.data.probeIp || "").trim() && !f.data.peerRef) {
    f.error = "Ohne Gegenstelle im Tunnel und ohne verknüpften Peer gäbe es nichts zu messen — eines von beidem muss sein.";
    render(); return;
  }
  if (f.kind === "sites") {
    /* Vier Stellen, Land + Stadt. Gleich hier prüfen: eine Fehlermeldung
       am Feld ist hilfreicher als eine abgelehnte Antwort vom Server. */
    const k = String(f.data.short || "").trim().toUpperCase();
    if (!KUERZEL.test(k)) {
      f.error = "Das Kürzel muss vier Stellen haben: Land + Stadt, z. B. DEKO für Deutschland/Köln.";
      render(); return;
    }
    f.data.short = k;
  }
  if (!LIVE()) { f.error = "Kein Dienst erreichbar — nichts gespeichert."; render(); return; }
  f.busy = true; f.error = null; render();
  try {
    const id = String(f.data.id);
    const path = `/api/admin/${f.kind}` + (f.mode === "edit" ? `/${encodeURIComponent(id)}` : "");
    await window.LEITSTAND.call(f.mode === "edit" ? "PUT" : "POST", path, formPayload());

    /* Hauptstandort ist eine Rolle, kein Merkmal: es kann nur einen geben,
       sonst hinge die Topologie von der Reihenfolge in der Datei ab. */
    if (f.kind === "sites" && f.data.primary)
      for (const s of SITES)
        if (s.id !== id && s.primary)
          await window.LEITSTAND.call("PUT", `/api/admin/sites/${encodeURIComponent(s.id)}`, { primary: false });

    const cred = {};
    for (const [k, v] of Object.entries(f.cred || {})) if (v) cred[k] = v;
    if (f.kind === "hosts" && Object.keys(cred).length)
      await window.LEITSTAND.call("POST", `/api/admin/credentials/${encodeURIComponent(id)}`, cred);

    await loadAdmin();
    /* Der Prüfdurchlauf wird angestoßen, aber nicht abgewartet: er dauert so
       lange wie das langsamste stille System — bei einem Dutzend davon eine
       halbe Minute. Gespeichert ist längst, und der Dienst hat den neuen
       Bestand schon gemeldet; das Ergebnis der Messung kommt nach. */
    window.LEITSTAND.call("POST", "/api/admin/check")
      .catch(e => console.warn("Durchlauf nicht ausgelöst:", e.message));
    toast("Gespeichert", `${id} — die Prüfung läuft im Hintergrund.`, "ok");
    state.form = null;
  } catch (e) { f.error = e.message; f.busy = false; }
  render();
}

/* ---------- Startseite: Bearbeiten ----------
   Die Felder stehen frei in der Tabelle, nicht in einem Formular. Vor
   jedem Neuzeichnen wird deshalb eingesammelt, was getippt wurde — sonst
   wirft ein Klick auf „+ Verknüpfung" die vorherige Zeile weg. */
function collectLinks() {
  if (!state.rawLinks) return;
  for (const el of document.querySelectorAll("[data-group]")) {
    const g = state.rawLinks[+el.dataset.group];
    if (g && el.tagName === "INPUT") g.group = el.value;
  }
  for (const el of document.querySelectorAll("[data-link]")) {
    const [gi, ii, feld] = el.dataset.link.split(".");
    const it = state.rawLinks[+gi]?.items?.[+ii];
    if (it) it[feld] = el.value;
  }
}

function linkMove(gi, ii, dir) {
  collectLinks();
  const items = state.rawLinks[gi].items;
  const ziel = ii + dir;
  if (ziel < 0 || ziel >= items.length) return;
  [items[ii], items[ziel]] = [items[ziel], items[ii]];
  render();
}

function linkMoveGroup(gi, dir) {
  collectLinks();
  const gs = state.rawLinks;
  const ziel = gi + dir;
  if (ziel < 0 || ziel >= gs.length) return;
  [gs[gi], gs[ziel]] = [gs[ziel], gs[gi]];
  render();
}

function linkDeleteGroup(gi) {
  collectLinks();
  const g = state.rawLinks[gi];
  const n = (g.items || []).length;
  if (n && !window.confirm(`Gruppe „${g.group}" mit ${n} Verknüpfung(en) entfernen?`)) return;
  state.rawLinks.splice(gi, 1);
  render();
}

async function saveLinks() {
  collectLinks();
  if (!requireLive()) return;
  /* Leere Einträge sind ein Versehen, kein Wunsch — und der Server lehnt
     sie ohnehin ab. Sie fliegen still raus, statt das Speichern zu kippen. */
  const links = (state.rawLinks || [])
    .map(g => ({
      group: (g.group || "").trim() || "Ohne Titel",
      items: (g.items || [])
        .map(it => {
          const o = {};
          if ((it.name || "").trim()) o.name = it.name.trim();
          if (it.host) o.host = it.host;
          if ((it.url || "").trim()) o.url = it.url.trim();
          if (!o.name) o.name = o.host || o.url || "";
          return o;
        })
        .filter(it => it.host || it.url)
    }))
    .filter(g => g.items.length);
  try {
    await window.LEITSTAND.call("PUT", "/api/admin/links", { links });
    state.rawLinks = null;
    await loadAdmin();
    toast("Gespeichert", "Die Startseite ist aktualisiert.", "ok");
  } catch (e) { toast("Nicht gespeichert", e.message, "crit"); }
  render();
}

async function adminDelete(kind, id) {
  if (!requireLive()) return;
  const wort = kind === "hosts" ? "System" : kind === "sites" ? "Standort" : "Tunnel";
  /* Was mit hängt, gehört in die Frage — nicht in die Fehlermeldung danach. */
  const anhang = kind === "sites"
    ? (() => {
        const h = state.hosts.filter(x => x.site === id).length;
        const t = state.tunnels.filter(x => x.a === id || x.b === id).length;
        return h ? `\n\nAchtung: ${h} System(e) hängen daran — der Dienst wird das ablehnen.`
          : t ? `\n\nDie ${t} Tunnel dorthin werden mit entfernt.` : "";
      })()
    : kind === "hosts"
      ? "\n\nVerknüpfungen auf der Startseite und hinterlegte Zugangsdaten gehen mit."
      : "";
  if (!window.confirm(`${wort} „${id}" wirklich entfernen?${anhang}\n\nEine Sicherung liegt danach als inventory.yaml.bak daneben.`)) return;
  try {
    await window.LEITSTAND.call("DELETE", `/api/admin/${kind}/${encodeURIComponent(id)}`);
    state.rawLinks = null;                        /* der Server hat die Startseite mit angepasst */
    await loadAdmin();
    toast("Entfernt", `${wort} ${id} ist raus.`, "ok");
  } catch (e) { toast("Nicht entfernt", e.message, "crit"); }
}

async function adminCall(method, path, body, msg) {
  try { await window.LEITSTAND.call(method, path, body); await loadAdmin(); toast("Erledigt", msg, "ok"); }
  catch (e) { toast("Fehlgeschlagen", e.message, "crit"); }
}

async function saveSettings() {
  const body = {};
  for (const el of document.querySelectorAll("[data-setting]")) {
    const v = el.value.trim();
    body[el.dataset.setting] = v === "true" ? true : v === "false" ? false : (isNaN(Number(v)) ? v : Number(v));
  }
  try {
    const r = await window.LEITSTAND.call("PUT", "/api/admin/settings", body);
    state.settings = r.settings;
    toast("Gespeichert", "Schwellwerte übernommen — gilt ab dem nächsten Durchlauf.", "ok");
    render();
  } catch (e) { toast("Nicht gespeichert", e.message, "crit"); }
}

window.LeitstandUI = { render, state, applyLive, go };

/* ============================================================
   Ansicht: Verwaltung
   Systeme, Standorte und Tunnel anlegen und ändern — samt
   Zugangsdaten und Verbindungstest, ohne die Datei anzufassen.
   ============================================================ */
const HOST_TYPES = [
  ["pve", "Proxmox VE", 8006, true], ["pbs", "Proxmox Backup Server", 8007, true],
  ["pmg", "Proxmox Mail Gateway", 8006, true], ["opnsense", "OPNsense", 443, true],
  ["pfsense", "pfSense", 443, false], ["truenas", "TrueNAS SCALE", 443, false],
  ["mailcow", "Mailcow", 443, false], ["adguard", "AdGuard Home", 443, false],
  ["portainer", "Portainer", 9443, false], ["hass", "Home Assistant", 8123, false],
  ["other", "Sonstiges", 443, false]
];
const typeLabel = t => (HOST_TYPES.find(x => x[0] === t) || [, t])[1];
const typeHasApi = t => !!(HOST_TYPES.find(x => x[0] === t) || [])[3];

/* Jede Bauart meldet sich anders an: Proxmox über eine Token-Kopfzeile aus
   Benutzer, Token-ID und Geheimnis — OPNsense über HTTP Basic mit einem
   Schlüsselpaar. Ein gemeinsames Formular für beides führte nur dazu, dass
   man Felder ausfüllt, die niemand liest. */
function zugangsFelder(type, cred, getippt) {
  if (type === "opnsense") return `
    <div class="admin-grid">
      ${inpc("key", "API-Schlüssel", cred, "der lange Wert aus der Schlüsseldatei", getippt)}
      ${inpc("secret", "Secret", cred, cred.secret ? "hinterlegt — leer lassen, um es zu behalten" : "der zweite Wert aus derselben Datei", getippt)}
    </div>
    <p class="admin-hint" style="margin:8px 0 0">In OPNsense unter
    <span class="mono">System → Access → Users</span> beim Benutzer einen API-Schlüssel erzeugen —
    heruntergeladen wird eine Datei mit beiden Werten. Zum Ablesen genügt ein Benutzer in einer Gruppe
    mit Leserechten; Schreibrechte braucht der Leitstand nirgends.</p>`;

  return `
    <div class="admin-grid">
      ${inpc("user", "Benutzer@Realm", cred, "leitstand@pve", getippt)}
      ${inpc("tokenId", "Token-ID", cred, "ro", getippt)}
      ${inpc("secret", "Geheimnis", cred, cred.secret ? "hinterlegt — leer lassen, um es zu behalten" : "aus der Anlage-Maske kopieren", getippt)}
    </div>
    <p class="admin-hint" style="margin:8px 0 0">Nur lesend: in Proxmox unter
    <span class="mono">Datacenter → Permissions → Add → API Token Permission</span> eintragen —
    Pfad <span class="mono">/</span>, Rolle <span class="mono">PVEAuditor</span>, Propagate an.
    Eine Berechtigung, die nur dem Benutzer gilt, greift bei „Privilege Separation“ nicht für seine Token.</p>`;
}

function viewVerwaltung() {
  if (!LIVE()) return `<div class="panel"><div class="panel-body">
    <div class="sec-title">Verwaltung</div>
    <p class="muted" style="margin:0 0 12px">Hier werden Standorte und Systeme angelegt, Zugangsdaten hinterlegt,
    Tunnel eingetragen und die Startseite gepflegt. Das schreibt in <span class="mono">inventory.yaml</span> und
    braucht deshalb den laufenden Dienst.</p>
    <pre class="raw">cd server
npm install
npm start        # danach http://localhost:8080</pre>
    <div class="row" style="margin-top:14px"><button class="btn btn--primary" data-action="reconnect">Erneut verbinden</button></div>
  </div></div>`;

  const tabs = [["hosts", "Systeme"], ["sites", "Standorte"], ["tunnels", "Tunnel"], ["links", "Startseite"], ["settings", "Schwellwerte"]];
  const tab = state.adminTab || "hosts";
  const neuWort = { hosts: "System", sites: "Standort", tunnels: "Tunnel" }[tab];
  const head = `<div class="row row-wrap">
    <div class="seg">${tabs.map(([id, l]) => `<button data-action="admintab" data-tab="${id}" aria-pressed="${tab === id}">${esc(l)}</button>`).join("")}</div>
    <div class="spacer"></div>
    <button class="btn" data-action="admin-reload" title="inventory.yaml erneut von der Platte lesen — für Änderungen von Hand">Bestand neu einlesen</button>
    <button class="btn" data-action="check-now">Jetzt prüfen</button>
    ${neuWort ? `<button class="btn btn--primary" data-action="admin-new" data-kind="${tab}">+ ${neuWort}</button>` : ""}
    ${tab === "links" ? `<button class="btn btn--primary" data-action="link-newgroup">+ Gruppe</button>` : ""}
  </div>`;

  const body = tab === "settings" ? adminSettings()
    : tab === "sites" ? adminSites()
    : tab === "tunnels" ? adminTunnels()
    : tab === "links" ? adminLinks()
    : adminHosts();

  return head + body + `<div class="panel-note" style="border:0;padding-left:2px">Alles hier landet in
    <span class="mono">${esc(state.invFile || "inventory.yaml")}</span>; vor jedem Schreiben wird eine Sicherung als
    <span class="mono">.bak</span> daneben abgelegt. Dieselbe Datei lässt sich von Hand bearbeiten.</div>`;
}

function adminHosts() {
  const rows = state.hosts.slice().sort((a, b) => String(a.site).localeCompare(String(b.site)) || a.id.localeCompare(b.id));
  return `<div class="panel">
    <div class="panel-head"><h3>Systeme</h3><span class="hint">${rows.length} angelegt</span>
      <div class="spacer"></div><span class="hint">Prüfungen werden aus Typ und Adresse abgeleitet</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        <th style="width:34px"></th><th>Kennung</th><th>Typ</th><th>Standort</th><th>Adresse</th>
        <th>Prüfungen</th><th>Zugang</th><th class="right"></th></tr></thead><tbody>
      ${rows.length ? rows.map(h => `<tr data-sev="${h.status}">
        <td class="sev">${dot(h.status)}</td>
        <td><div class="mono">${esc(h.id)}</div><div class="t-sub">${esc(h.role || "")}${h.monitored === false ? " · nicht überwacht" : ""}</div></td>
        <td>${chip("plain", typeLabel(h.type))}</td>
        <td>${chip("plain", siteShort(h.site))}</td>
        <td class="mono faint">${esc(h.ip || h.url || "—")}</td>
        <td class="mono faint" style="font-size:11px">${(h.checks || []).map(c => c.kind + (c.port ? "/" + c.port : "")).join(" · ") || "—"}</td>
        <td>${!typeHasApi(h.type) ? '<span class="faint">—</span>'
            : (state.credentials && state.credentials[h.id]) ? chip("ok", "Token") : chip("warn", "fehlt")}</td>
        <td class="right">
          <button class="btn btn--sm" data-action="admin-edit" data-kind="hosts" data-id="${esc(h.id)}">Bearbeiten</button>
          <button class="btn btn--sm" data-action="admin-delete" data-kind="hosts" data-id="${esc(h.id)}">Löschen</button>
        </td>
      </tr>`).join("") : `<tr><td colspan="8"><div class="empty">Noch kein System angelegt — oben rechts „+ System".</div></td></tr>`}
      </tbody></table>
    </div>
  </div>`;
}

function adminSites() {
  const roh = state.rawSites || [];
  const daten = SITES.map(s => ({ ...(roh.find(r => String(r.id) === String(s.id)) || {}), ...s }));
  return `<div class="panel">
    <div class="panel-head"><h3>Standorte</h3><span class="hint">${daten.length} angelegt</span>
      <div class="spacer"></div><span class="hint">der Hauptstandort steht in der Topologie in der Mitte</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Kennung</th><th>Name</th><th>Kürzel</th><th>Ort</th><th>Anschluss</th><th>Systeme</th><th>Tunnel</th><th class="right"></th></tr></thead><tbody>
      ${daten.length ? daten.map(s => {
        const hosts = state.hosts.filter(h => h.site === s.id).length;
        const tuns = state.tunnels.filter(t => t.a === s.id || t.b === s.id).length;
        return `<tr>
        <td class="sev">${s.primary ? chip("info", "Haupt") : ""}</td>
        <td class="mono">${esc(s.id)}</td><td>${esc(s.name)}</td>
        <td class="mono">${KUERZEL.test(s.short || "")
          ? esc(s.short)
          : `<span class="faint">${esc(s.short || "—")}</span> <span class="chip chip--warn" title="Vier Stellen: Land + Stadt, z. B. DEKO">anpassen</span>`}</td>
        <td class="faint">${esc(s.place || "—")}</td>
        <td class="faint">${esc(s.isp || "—")}</td>
        <td class="mono">${hosts}</td><td class="mono">${tuns}</td>
        <td class="right">
          <button class="btn btn--sm" data-action="admin-edit" data-kind="sites" data-id="${esc(s.id)}">Bearbeiten</button>
          <button class="btn btn--sm" data-action="admin-delete" data-kind="sites" data-id="${esc(s.id)}">Löschen</button>
        </td></tr>`;
      }).join("") : `<tr><td colspan="9"><div class="empty">Noch kein Standort angelegt — oben rechts „+ Standort".</div></td></tr>`}
      </tbody></table>
    </div>
    <div class="panel-note">Ein Standort lässt sich erst löschen, wenn kein System mehr an ihm hängt; die Tunnel dorthin
      gehen dabei mit. Mindestens ein Standort muss bestehen bleiben — sonst wäre der Bestand ungültig.</div>
  </div>`;
}

function adminTunnels() {
  return `<div class="panel">
    <div class="panel-head"><h3>Tunnel</h3><span class="hint">${state.tunnels.length} angelegt</span>
      <div class="spacer"></div><span class="hint">gemessen wird durch den Tunnel, der Handshake kommt vom Peer</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Kennung</th><th>Strecke</th><th>Interface</th><th>Transfernetz</th><th>Gegenstelle</th><th>Verknüpfter Peer</th><th class="right"></th></tr></thead><tbody>
      ${state.tunnels.length ? state.tunnels.map(t => `<tr data-sev="${t.status}">
        <td class="sev">${dot(t.status)}</td>
        <td class="mono">${esc(t.id)}</td>
        <td>${esc(siteName(t.a))} ↔ ${esc(siteName(t.b))}</td>
        <td class="mono faint">${esc(t.iface || "—")}</td>
        <td class="mono faint">${esc(t.net || "—")}</td>
        <td class="mono">${esc(t.probe || "—")}</td>
        <td class="mono">${!t.peer ? '<span class="faint">—</span>'
          : t.peer.gefunden
            ? `${esc(t.peer.name)} <span class="faint">· ${esc(t.peer.host)}</span>`
            : `<span style="color:var(--warn)" title="${esc(t.peer.note || "")}">${esc(t.peer.name || t.peer.key || "?")} — nicht gemeldet</span>`}</td>
        <td class="right">
          <button class="btn btn--sm" data-action="admin-edit" data-kind="tunnels" data-id="${esc(t.id)}">Bearbeiten</button>
          <button class="btn btn--sm" data-action="admin-delete" data-kind="tunnels" data-id="${esc(t.id)}">Löschen</button>
        </td></tr>`).join("")
        : `<tr><td colspan="8"><div class="empty">${SITES.length > 1
            ? 'Noch kein Tunnel angelegt — oben rechts „+ Tunnel".'
            : "Für einen Tunnel braucht es zwei Standorte."}</div></td></tr>`}
      </tbody></table>
    </div>
    <div class="panel-note">Ein Tunnel braucht mindestens eines von beidem: eine Gegenstelle im Transfernetz, auf die
      gemessen wird, oder einen verknüpften WireGuard-Peer, dessen Handshake die Firewall meldet.</div></div>`;
}

/* ---------- Startseite pflegen ----------
   Der Server nimmt die Verknüpfungen nur als Ganzes entgegen
   (PUT /api/admin/links). Deshalb wird hier die vollständige Liste
   bearbeitet und geschrieben — Gruppe anlegen, umbenennen, verschieben,
   Eintrag hinzufügen und entfernen. */
function adminLinks() {
  const groups = state.rawLinks || [];
  const hostOptionen = state.hosts.map(h => h.id);

  return `<div class="panel">
    <div class="panel-head"><h3>Startseite</h3><span class="hint">${groups.length} Gruppen · ${groups.reduce((a, g) => a + (g.items || []).length, 0)} Verknüpfungen</span>
      <div class="spacer"></div><span class="hint">mit System verknüpft = Kachel trägt dessen Ampel</span></div>
    <div class="panel-body col">
      ${groups.length ? groups.map((g, gi) => `<div class="panel" style="background:var(--panel-2)">
        <div class="panel-head" style="background:transparent">
          <input class="admin-input" style="max-width:260px" data-group="${gi}" value="${esc(g.group || "")}" placeholder="Gruppenname" aria-label="Gruppenname">
          <div class="spacer"></div>
          <button class="btn btn--sm" data-action="link-move-group" data-idx="${gi}" data-dir="-1" ${gi === 0 ? "disabled" : ""} title="nach oben">↑</button>
          <button class="btn btn--sm" data-action="link-move-group" data-idx="${gi}" data-dir="1" ${gi === groups.length - 1 ? "disabled" : ""} title="nach unten">↓</button>
          <button class="btn btn--sm" data-action="link-add" data-group="${gi}">+ Verknüpfung</button>
          <button class="btn btn--sm" data-action="link-delgroup" data-idx="${gi}">Gruppe löschen</button>
        </div>
        <div class="panel-body panel-body--flush tablewrap">
          <table class="t"><thead><tr><th style="width:34px"></th><th>Beschriftung</th><th>System</th><th>Adresse</th><th class="right"></th></tr></thead><tbody>
          ${(g.items || []).length ? g.items.map((it, ii) => {
            const h = it.host ? byId(state.hosts, it.host) : null;
            return `<tr data-sev="${h ? h.status : "idle"}">
              <td class="sev">${dot(h ? h.status : "idle")}</td>
              <td><input class="admin-input" data-link="${gi}.${ii}.name" value="${esc(it.name || "")}" placeholder="${esc(it.host || "Beschriftung")}" aria-label="Beschriftung"></td>
              <td><select class="admin-input" data-link="${gi}.${ii}.host" aria-label="System">
                <option value="">— keins (reines Lesezeichen)</option>
                ${hostOptionen.map(id => `<option value="${esc(id)}" ${it.host === id ? "selected" : ""}>${esc(id)}</option>`).join("")}
              </select></td>
              <td><input class="admin-input mono" data-link="${gi}.${ii}.url" value="${esc(it.url || "")}"
                placeholder="${esc(h && h.url ? h.url + " (vom System)" : "https://…")}" aria-label="Adresse"></td>
              <td class="right">
                <button class="btn btn--sm" data-action="link-move" data-group="${gi}" data-idx="${ii}" data-dir="-1" ${ii === 0 ? "disabled" : ""}>↑</button>
                <button class="btn btn--sm" data-action="link-move" data-group="${gi}" data-idx="${ii}" data-dir="1" ${ii === (g.items.length - 1) ? "disabled" : ""}>↓</button>
                <button class="btn btn--sm" data-action="link-del" data-group="${gi}" data-idx="${ii}">Löschen</button>
              </td></tr>`;
          }).join("") : `<tr><td colspan="5"><div class="empty">Noch nichts in dieser Gruppe.</div></td></tr>`}
          </tbody></table>
        </div>
      </div>`).join("") : '<div class="empty">Noch keine Gruppe — oben rechts „+ Gruppe".</div>'}
    </div>
    <div class="panel-head" style="border-top:1px solid var(--line);border-bottom:0">
      <span class="hint">Änderungen greifen erst mit „Speichern"</span>
      <div class="spacer"></div>
      <button class="btn" data-action="link-revert">Verwerfen</button>
      <button class="btn btn--primary" data-action="link-save">Speichern</button>
    </div>
    <div class="panel-note">Ohne Adresse übernimmt die Kachel die Oberfläche des verknüpften Systems. Eine eigene
      Adresse ist für Unterpfade nützlich — etwa <span class="mono">/admin</span> statt der Startseite des Dienstes.</div>
  </div>`;
}

function adminSettings() {
  const s = state.settings || {};
  const f = (key, label, hint) => `<label class="admin-field">
    <span class="admin-label">${esc(label)}</span>
    <input class="admin-input" data-setting="${key}" value="${esc(s[key] ?? "")}">
    <span class="admin-hint">${esc(hint)}</span></label>`;
  return `<div class="panel">
    <div class="panel-head"><h3>Schwellwerte</h3><span class="hint">wann eine Ampel umspringt</span>
      <div class="spacer"></div><button class="btn btn--primary btn--sm" data-action="admin-save-settings">Speichern</button></div>
    <div class="panel-body"><div class="admin-grid">
      ${f("interval", "Abstand der Durchläufe", "Sekunden zwischen zwei Runden")}
      ${f("timeout", "Zeitlimit je Prüfung", "Sekunden")}
      ${f("fail_threshold", "Fehlschläge bis Rot", "davor gilt Gelb")}
      ${f("slow_ms", "Grenze „langsam“", "Millisekunden bis Gelb")}
      ${f("tls_warn_days", "Zertifikat: Warnung", "Tage Restlaufzeit")}
      ${f("tls_crit_days", "Zertifikat: kritisch", "Tage Restlaufzeit")}
      ${f("history", "Verlaufspunkte", "je System vorgehalten")}
      ${f("icmp", "ICMP verwenden", "true oder false")}
    </div></div>
    <div class="panel-note">Ein geänderter Abstand greift ab dem nächsten Durchlauf. Steht ICMP auf
      <span class="mono">false</span>, wird nur noch TCP geprüft — für Weboberflächen genügt das, für reine
      Ping-Ziele nicht.</div>
  </div>`;
}

/* ---------- Formular als Schublade ---------- */
/* Was der Benutzer gerade getippt hat, hat Vorrang vor dem, was der Server
   kennt. Sonst räumt ein Neuzeichnen — etwa nach „Verbindung testen“ — das
   eingegebene Geheimnis weg, und Speichern legt stillschweigend nichts an.
   Gespeicherte Geheimnisse kommen nur maskiert zurück und werden deshalb
   nie in das Feld zurückgeschrieben. */
function inpc(key, label, cred, ph, typed) {
  const wert = typed && typed[key] != null && typed[key] !== ""
    ? typed[key]
    : (key === "secret" ? "" : (cred[key] ?? ""));
  return `<label class="admin-field">
    <span class="admin-label">${esc(label)}</span>
    <input class="admin-input" data-cred="${key}" type="${key === "secret" ? "password" : "text"}"
      value="${esc(wert)}" placeholder="${esc(ph || "")}" autocomplete="off">
  </label>`;
}

/* ---------- Tunnel: die Gegenstelle auf der Firewall ----------
   Getippt wird hier nichts. Zur Auswahl steht nur, was eine Firewall
   tatsächlich meldet — ein selbst eingetragener Peername, den es dort
   nicht gibt, ergäbe eine Strecke, die auf ewig „nicht gemeldet" sagt.

   Gespeichert wird der öffentliche Schlüssel: er übersteht eine
   Umbenennung auf der Firewall. Name und Interface stehen als lesbare
   Beschriftung daneben. */
function peerFeld(d) {
  const gruppen = new Map();
  for (const p of PEERS) {
    if (!gruppen.has(p.von)) gruppen.set(p.von, []);
    gruppen.get(p.von).push(p);
  }
  const gespeichert = d.peerOrig;
  const fehlt = !!gespeichert && d.peerRef === "__gespeichert";

  if (!PEERS.length && !fehlt) return `<div>
    <div class="sec-title">WireGuard-Peer</div>
    <p class="admin-hint" style="margin:0">Noch meldet keine Firewall WireGuard-Peers. Dafür braucht OPNsense einen
      API-Schlüssel — unter <b>Verwaltung → Systeme</b> beim Gerät hinterlegen. Danach steht die Gegenstelle hier zur
      Auswahl, und in der Tunnelzeile steht der echte Handshake.</p></div>`;

  const opts = [`<option value="">— nicht verknüpft —</option>`];
  if (fehlt) opts.push(`<option value="__gespeichert" selected>${esc(gespeichert.name || gespeichert.key || "hinterlegt")} — zurzeit nicht gemeldet</option>`);
  for (const [von, liste] of gruppen)
    opts.push(`<optgroup label="${esc(von)}">${liste.map(p => {
      /* Ein Peer trägt höchstens eine Strecke — steht er schon an einer
         anderen, gehört das dazugesagt, bevor jemand ihn doppelt vergibt. */
      const belegt = p.tunnel && p.tunnel !== d.id ? ` — schon an ${p.tunnel}` : "";
      return `<option value="${esc(p.id)}" ${d.peerRef === p.id ? "selected" : ""}>${esc(p.iface || "wg")} · ${esc(p.name)}${esc(belegt)}</option>`;
    }).join("")}</optgroup>`);

  return `<div>
    <div class="sec-title">WireGuard-Peer</div>
    <label class="admin-field">
      <span class="admin-label">Gegenstelle auf der Firewall</span>
      <select class="admin-input" data-field="peerRef">${opts.join("")}</select>
      <span class="admin-hint">Damit steht in der Tunnelzeile das echte Handshake-Alter statt eines Strichs — und
        die übertragene Menge dazu. Ohne Gegenstelle im Transfernetz wird der Zustand daraus abgeleitet.</span>
    </label></div>`;
}

/* Die Kennung des gemeldeten Peers zu einer hinterlegten Verknüpfung —
   zuerst über den Schlüssel, wie im Dienst auch. */
function peerRefOf(peer) {
  const p = PEERS.find(x => x.von === peer.host
    && ((peer.key && x.key === peer.key) || (!peer.key && x.name === peer.name)));
  return p ? p.id : null;
}

function renderAdminForm() {
  const f = state.form;
  if (!f || !f.open) return "";
  const d = f.data;
  const isHost = f.kind === "hosts", isSite = f.kind === "sites", isTun = f.kind === "tunnels";
  const title = f.mode === "new"
    ? (isHost ? "System anlegen" : isSite ? "Standort anlegen" : "Tunnel anlegen")
    : `${esc(d.id)} bearbeiten`;

  const inp = (key, label, hint, opts = {}) => `<label class="admin-field">
    <span class="admin-label">${esc(label)}${opts.req ? ' <span style="color:var(--crit)">*</span>' : ""}</span>
    <input class="admin-input${opts.gross ? " admin-input--gross" : ""}" data-field="${key}"
      value="${esc(d[key] ?? "")}" ${opts.ro ? "readonly" : ""} placeholder="${esc(opts.ph || "")}"
      ${opts.maxlength ? `maxlength="${opts.maxlength}"` : ""}>
    ${hint ? `<span class="admin-hint">${esc(hint)}</span>` : ""}</label>`;

  const sel = (key, label, options, hint) => `<label class="admin-field">
    <span class="admin-label">${esc(label)}</span>
    <select class="admin-input" data-field="${key}">
      ${options.map(([v, l]) => `<option value="${esc(v)}" ${String(d[key]) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}
    </select>
    ${hint ? `<span class="admin-hint">${esc(hint)}</span>` : ""}</label>`;

  let body = "";
  if (isHost) {
    const cred = (state.credentials || {})[d.id] || {};
    body = `
      <div class="admin-grid">
        ${inp("id", "Kennung", "eindeutig, erscheint überall", { req: true, ro: f.mode === "edit", ph: "pve-hq-01" })}
        ${sel("type", "Typ", HOST_TYPES.map(t => [t[0], t[1]]), "bestimmt Standardport und Sammler")}
        ${sel("site", "Standort", SITES.map(s => [s.id, s.name]))}
        ${inp("ip", "IP-Adresse", "für ICMP und als Rückfall", { ph: "10.10.1.11" })}
        ${inp("url", "Oberfläche", "leer lassen: wird aus IP und Typ gebildet", { ph: "https://10.10.1.11:8006" })}
        ${inp("role", "Beschreibung", "erscheint unter dem Namen", { ph: "Cluster-Node · Ryzen 9 5950X" })}
      </div>
      <label class="row" style="gap:9px;cursor:pointer">
        <span class="switch" role="switch" aria-checked="${d.monitor !== false}" data-action="form-toggle" data-field="monitor"></span>
        <span>Überwachen <span class="faint">— aus für Laborsysteme, die nicht alarmieren sollen</span></span>
      </label>

      ${typeHasApi(d.type) ? `
      <div>
        <div class="sec-title">Zugangsdaten — ${esc(typeLabel(d.type))}</div>
        ${zugangsFelder(d.type, cred, f.cred)}
      </div>` : `<p class="admin-hint" style="margin:0">Für ${esc(typeLabel(d.type))} prüft der Leitstand vorerst nur die Erreichbarkeit — ein Sammler folgt in einer späteren Stufe.</p>`}`;
  } else if (isSite) {
    const hosts = f.mode === "edit" ? state.hosts.filter(h => h.site === d.id).length : 0;
    body = `<div class="admin-grid">
      ${inp("id", "Kennung", "kurz und bleibend — Systeme hängen daran", { req: true, ro: f.mode === "edit", ph: "hq" })}
      ${inp("name", "Name", "erscheint in Listen und Meldungen", { req: true, ph: "Hauptstandort" })}
      ${inp("short", "Kürzel", "vier Stellen: Land + Stadt", { req: true, ph: "DEKO", maxlength: 4, gross: true })}
      ${inp("place", "Ort", "rein informativ", { ph: "Köln" })}
      ${inp("isp", "Anschluss", "rein informativ", { ph: "Kabel 1000/50" })}
      ${inp("wan", "WAN IPv4", "rein informativ — wird nicht geprüft", { ph: "203.0.113.17" })}
      ${inp("wan6", "WAN IPv6", "rein informativ", { ph: "2001:db8::/56" })}
    </div>
    <label class="row" style="gap:9px;cursor:pointer">
      <span class="switch" role="switch" aria-checked="${!!d.primary}" data-action="form-toggle" data-field="primary"></span>
      <span>Hauptstandort <span class="faint">— steht in der Topologie in der Mitte; alle Tunnel laufen dort zusammen</span></span>
    </label>
    ${f.mode === "edit" && hosts ? `<p class="admin-hint" style="margin:0">An diesem Standort hängen ${hosts} System(e).
      Zum Löschen müssen sie vorher umgezogen oder entfernt werden.</p>` : ""}`;
  } else if (isTun) {
    body = `<div class="admin-grid">
      ${inp("id", "Kennung", "", { req: true, ro: f.mode === "edit", ph: "wg-hq-rz" })}
      ${sel("a", "Von", SITES.map(s => [s.id, s.name]))}
      ${sel("b", "Nach", SITES.map(s => [s.id, s.name]))}
      ${inp("iface", "Interface", "wie auf der Firewall", { ph: "wg0" })}
      ${inp("net", "Transfernetz", "", { ph: "10.99.0.0/30" })}
      ${inp("probeIp", "Gegenstelle im Tunnel", "diese Adresse wird gemessen", { ph: "10.99.0.2" })}
      ${inp("probePort", "Port der Gegenstelle", "leer: nur ICMP", { ph: "22" })}
    </div>
    ${peerFeld(d)}
    <p class="admin-hint" style="margin:0">Eines von beidem muss es sein. Am besten beides: die Messung <b>durch</b> den
      Tunnel sagt, ob gerade etwas hindurchkommt; der Handshake sagt, wann die Strecke zuletzt stand.</p>`;
  }

  const t = f.test;
  return `<div class="scrim" data-action="form-close"></div>
  <aside class="inspector" role="dialog" aria-label="${esc(title)}">
    <div class="inspector-head">
      <div style="min-width:0"><div class="view-kicker">Verwaltung</div><h2 style="font-size:17px">${title}</h2></div>
      <div class="spacer"></div>
      <button class="btn btn--ghost" data-action="form-close" aria-label="Schließen">✕</button>
    </div>
    <div class="inspector-body">
      ${f.error ? `<div class="row" style="gap:8px;align-items:flex-start;color:var(--crit)">${dot("crit")}<span style="font-size:13px;white-space:pre-line">${esc(f.error)}</span></div>` : ""}
      ${body}
      ${t ? `<div>
        <div class="sec-title">Ergebnis der Prüfung</div>
        <div class="panel" style="background:var(--panel-2)"><div class="panel-body">
          <div class="row" style="gap:8px;margin-bottom:8px">${dot(t.reachable ? (t.api && t.api.ok ? "ok" : "warn") : "crit")}
            <b>${esc(t.summary)}</b></div>
          ${(t.steps || []).map(x => `<div class="row" style="gap:8px;font-size:12.5px;padding:3px 0">
            ${dot(x.ok === null ? "idle" : x.ok ? "ok" : "crit")}
            <span class="mono">${esc(x.kind)}${x.port ? "/" + x.port : ""}</span>
            <span class="faint">${esc(x.detail || "")}</span>
            <span class="spacer"></span><span class="mono faint">${x.ms != null ? x.ms + " ms" : ""}</span></div>`).join("")}
          ${t.api ? `<div class="hr" style="margin:8px 0"></div>
            <div class="row" style="gap:8px;font-size:12.5px;align-items:flex-start">
              ${dot(t.api.ok ? "ok" : t.api.soft ? "idle" : "crit")}
              <span>${esc(t.api.detail)}${t.api.hint ? `<br><span class="faint">${esc(t.api.hint)}</span>` : ""}</span>
            </div>` : ""}
        </div></div>
      </div>` : ""}
    </div>
    <div class="inspector-foot">
      <button class="btn btn--primary" data-action="form-save" ${f.busy ? "disabled" : ""}>${f.busy ? "…" : "Speichern"}</button>
      ${isHost ? `<button class="btn" data-action="form-test" ${f.busy ? "disabled" : ""}>Verbindung testen</button>` : ""}
      <button class="btn" data-action="form-close">Abbrechen</button>
    </div>
  </aside>`;
}
