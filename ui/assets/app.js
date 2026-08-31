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
  truenas:"TrueNAS", mailcow:"Mailcow", adguard:"AdGuard Home", hass:"Home Assistant", portainer:"Portainer",
  unifi:"UniFi Controller"
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
  virt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><path d="M14 17h7M17.5 13.5v7"/></svg>',
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
  /* Ganz oben, weil sie die Frage beantwortet, mit der man das Werkzeug
     überhaupt aufmacht — und weil sie auf einem Telefon die einzige ist,
     die man im Gehen lesen kann. */
  { id:"kurz",    label:"Kurzlage",     icon:"lage",    group:"Übersicht" },
  { id:"lage",    label:"Lagebild",     icon:"lage",    group:"Übersicht" },
  { id:"sites",   label:"Standorte",    icon:"sites",   group:"Übersicht" },
  /* „Compute" hieß früher alles, was Rechenlast trägt — Proxmox, Speicher
     und Container in einer Ansicht. Die Virtualisierung hat daraus eine
     eigene bekommen: Knoten im Einzelnen, ihr Softwarestand und jeder
     Gast mit seiner Auslastung. Was bleibt, ist Speicher und Sicherung —
     und das steht jetzt auch so dran. */
  { id:"virt",    label:"Virtualisierung", icon:"virt", group:"Infrastruktur" },
  { id:"compute", label:"Speicher & Sicherung", icon:"compute", group:"Infrastruktur" },
  { id:"netz",    label:"Netz & Proxy", icon:"netz",    group:"Infrastruktur" },
  { id:"vpn",     label:"VPN-Tunnel",   icon:"vpn",     group:"Infrastruktur" },
  { id:"dienste", label:"Dienste",      icon:"dienste", group:"Infrastruktur" },
  /* Mail hat eine eigene Ansicht bekommen, weil ein Mail Gateway mehr
     meldet als eine Kachel trägt: Durchsatz, Warteschlange, Quarantäne,
     Signaturen und die Dienste, die im Hintergrund filtern. Vor allem
     aber, weil die Fragen andere sind — „hängt Mail?" beantwortet keine
     Ampel neben einem DNS-Filter. */
  { id:"mail",    label:"Mail",         icon:"post",    group:"Infrastruktur" },
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
  detail: null,               /* offene Detailseite: { id, tage, daten, busy, error } */
  adminTab: "hosts",
  form: null,
  credentials: {},
  settings: null,
  runtime: null,
  invFile: null,
  staende: null,
  staendeLaeuft: false,
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
  tunnels: [],
  /* Sortierung je Tabelle: { spalte, richtung }. Leer heißt „so, wie die
     Ansicht sie ordnet" — und das ist meist nach Dringlichkeit. */
  sort: {}
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
  /* Antwortende Systeme, nicht grüne: ein rotes System kann tadellos
     antworten und trotzdem einen Befund haben. Die Zahl der Befunde steht
     links daneben unter „Kritisch" und „Warnungen". */
  const stumm = überwacht.filter(h => h.reachable === false).length;
  const hostsUp = überwacht.length - stumm;
  const tunOk = state.tunnels.filter(t => t.status === "ok").length;
  const bkOk = BACKUPS.filter(b => b.status === "ok").length;
  /* Nur die bewerteten zählen. Ein eigensigniertes Zertifikat, das keine
     Ampel bekommt, darf auch keine Zahl in der Kopfleiste erzeugen —
     sonst bliebe die Meldung stehen, nur woanders. */
  const certWarn = CERTS.filter(c => c.bewertet !== false && c.days <= (thr("tls_warn_days") ?? 30)).length;
  /* Was es noch nicht gibt, wird als Strich gezeigt — nicht als „0 von 0",
     das wie ein Messwert aussieht. */
  const cells = [
    { k:"Kritisch", v:critCount(), tone: critCount() ? "crit" : "ok", go:"lage", pulse: critCount() > 0 },
    { k:"Warnungen", v:warnCount(), tone: warnCount() ? "warn" : "ok", go:"lage" },
    { k:"Systeme", v: überwacht.length ? `${hostsUp}/${überwacht.length}` : "—",
      tone: !überwacht.length ? "idle" : stumm ? "warn" : "ok", go:"sites",
      titel: "Systeme, die auf die Prüfung antworten — ein rotes System kann darunter sein" },
    { k:"Tunnel", v: state.tunnels.length ? `${tunOk}/${state.tunnels.length}` : "—",
      tone: !state.tunnels.length ? "idle" : tunOk === state.tunnels.length ? "ok" : "warn", go:"vpn" },
    { k:"Backups 24 h", v: BACKUPS.length ? `${bkOk}/${BACKUPS.length}` : "—", tone: !BACKUPS.length ? "idle" : bkOk === BACKUPS.length ? "ok" : "warn", go:"compute" },
    { k:"Zert. knapp", v: CERTS.length ? certWarn : "—", tone: !CERTS.length ? "idle" : certWarn ? "warn" : "ok", go:"dienste" },
    { k:"Alarm-Mails", v: "—", tone:"idle", go:"post" }
  ];
  return `<div class="alarmstrip">${cells.map(c => `
    <button class="alarmcell" data-tone="${c.tone}" data-action="view" data-view="${c.go}"${c.titel ? ` title="${esc(c.titel)}"` : ""}>
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
  /* Die Detailseite steht in keiner Leiste — ihr Titel ist der Gegenstand
     selbst. Ohne diesen Ausweg fiele die Kopfzeile über ein `undefined`. */
  const detail = state.view === "system" && state.detail
    ? { group: "System", label: (byId(state.hosts, state.detail.id) || {}).name || state.detail.id }
    : null;
  const v = detail || VIEWS.find(x => x.id === state.view) || VIEWS[0];
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
      ${state.view === "kurz" ? "" : `
      <button class="btn" data-action="toggle-problems" aria-pressed="${state.onlyProblems}">
        ${dot(state.onlyProblems ? "warn" : "idle")} Nur Probleme
      </button>
      <div class="search">${ICON.search}<input id="q" placeholder="Host, IP, Dienst…" value="${esc(state.q)}" aria-label="Suchen"></div>
      <button class="btn" data-action="palette">⌘K</button>`}
      <button class="btn" data-action="theme" title="Hell/Dunkel umschalten">◐</button>
      <span class="mono faint" style="font-size:11px" title="Zeitpunkt des letzten Durchlaufs im Dienst — nicht die Uhr dieses Browsers">${esc(letzterLauf())}</span>
    </div>
    ${state.view === "kurz" ? "" : renderAlarmstrip()}
  </div>`;
}

/* ============================================================
   Ansicht: Kurzlage

   Eine Antwort auf eine einzige Frage, groß genug, um sie im Vorbeigehen
   auf einem Telefon zu lesen: passt alles?

   Grün ist hier eine Behauptung, und sie muss verdient sein. „Alles in
   Ordnung" ist deshalb nicht dasselbe wie „nichts leuchtet rot": ein
   Zustandsstrom, der hängt, ein Bestand ohne ein einziges überwachtes
   System, ein Sammler ohne Zugangsdaten — jedes davon ergäbe eine Anzeige
   ohne rote Zeile, und sie wäre gelogen. Der Befund kennt deshalb den
   Zustand „unklar", und unter der Fläche steht, was in ihr nicht
   enthalten ist. Wer sich morgens auf ein grünes Feld verlässt, muss
   wissen, worüber es schweigt.

   Eine quittierte Störung macht die Fläche nicht grün. „Quittiert" heißt,
   dass jemand hinsieht — nicht, dass es behoben ist. */
function viewKurz() {
  const b = kurzBefund();
  const offen = state.incidents.filter(i => inSite(i) && i.sev !== "info");

  return `<div class="kurz">
    <div class="kurz-karte" data-tone="${b.ton}">
      <div class="kurz-wort">${esc(b.wort)}</div>
      <div class="kurz-satz">${esc(b.satz)}</div>
    </div>

    ${offen.length ? `<div class="panel">
      <div class="panel-head"><h3>Was ansteht</h3><span class="hint">${offen.length} offen</span></div>
      <div class="panel-body panel-body--flush">
        ${offen.map(i => `<button class="kurz-zeile" data-sev="${i.sev}"
          ${i.host ? `data-action="system" data-id="${esc(i.host)}"` : `data-action="view" data-view="lage"`}>
          ${dot(i.sev)}
          <span style="min-width:0">
            <span class="kurz-titel">${esc(i.title)}</span>
            <span class="kurz-sub">${esc(i.host || siteName(i.site) || "—")}${
              i.ageMin != null ? " · seit " + esc(ago(i.ageMin)).replace(/^vor /, "") : ""}${
              i.ack ? " · quittiert" : ""}</span>
          </span></button>`).join("")}
      </div>
    </div>` : ""}

    <div class="kurz-kacheln">${kurzKacheln().map(k => `
      <button class="kurz-kachel" data-tone="${k.ton}" data-action="view" data-view="${k.go}">
        <span class="kurz-kachel-k">${esc(k.k)}</span>
        <b>${esc(k.v)}</b>
        <span class="kurz-kachel-s">${esc(k.s)}</span>
      </button>`).join("")}</div>

    <div class="panel">
      <div class="panel-head"><h3>Worüber das Feld schweigt</h3><span class="hint">damit Grün etwas wert ist</span></div>
      <div class="panel-body col" style="gap:8px">
        ${kurzLuecken().map(l => `<div class="row" style="gap:9px;align-items:flex-start">
          ${dot(l.ton)}<span style="font-size:13.5px">${l.text}</span></div>`).join("")}
      </div>
    </div>
  </div>`;
}

/* Der Befund selbst — eine reine Funktion des Zustands, damit sich genau
   das prüfen lässt, worauf sich jemand morgens verlässt. Die Reihenfolge
   ist die Aussage: erst kann ich es überhaupt wissen, dann weiß ich es. */
function kurzBefund() {
  const L = window.LEITSTAND || {};
  const ueberwacht = state.hosts.filter(h => h.monitored !== false);
  const offen = state.incidents.filter(i => inSite(i) && i.sev !== "info");
  const crit = offen.filter(i => i.sev === "crit");
  const warn = offen.filter(i => i.sev === "warn");
  const quittiert = offen.filter(i => i.ack).length;

  if (state.connecting) return { ton: "idle", wort: "Verbinde …", satz: "Der Stand wird gerade geholt." };
  if (!LIVE()) return { ton: "idle", wort: "Kein Stand",
    satz: state.offline ? `Der Dienst antwortet nicht: ${state.offline}` : "Der Dienst antwortet nicht — hier stünde sonst der letzte Durchlauf." };
  if (L.stale) return { ton: "warn", wort: "Stand unklar",
    satz: `Die Verbindung hängt. Die Werte sind vom ${fmtWhen(L.lastRun) || "letzten Durchlauf"} und werden nicht mehr aufgefrischt.` };
  if (!ueberwacht.length) return { ton: "idle", wort: "Nichts überwacht",
    satz: state.hosts.length
      ? "Jedes angelegte System ist von der Überwachung ausgenommen."
      : "Es ist noch kein System angelegt." };

  const nachsatz = quittiert ? ` ${quittiert} davon quittiert.` : "";
  if (crit.length) return { ton: "crit",
    wort: crit.length === 1 ? "Eine Störung" : `${crit.length} Störungen`,
    satz: `${crit[0].title}.${nachsatz}` };
  if (warn.length) return { ton: "warn",
    wort: warn.length === 1 ? "Eine Warnung" : `${warn.length} Warnungen`,
    satz: `${warn[0].title}.${nachsatz}` };

  const tun = state.tunnels.filter(t => inSite({ site: t.a }) || inSite({ site: t.b }));
  return { ton: "ok", wort: "Passt alles",
    satz: `${ueberwacht.length} ${ueberwacht.length === 1 ? "System" : "Systeme"}`
      + (tun.length ? `, ${tun.length} ${tun.length === 1 ? "Tunnel" : "Tunnel"}` : "")
      + ` — geprüft ${letzterLauf()}.` };
}

/* Vier Zahlen, mehr nicht. Was hier steht, muss man nicht lesen, um zu
   wissen, ob etwas anliegt — dafür ist die Fläche darüber da. */
function kurzKacheln() {
  const ueberwacht = state.hosts.filter(h => h.monitored !== false && inSite(h));
  /* „antworten" steht als Beschriftung darunter, also muss auch das
     gezählt werden. Grün ist etwas anderes: ein Knoten mit fehlgeschlagener
     Sicherung antwortet tadellos und steht trotzdem auf Rot — als
     „antwortet nicht" gezählt, führte er hier von der Störung weg. */
  const hostsOk = ueberwacht.filter(h => h.reachable !== false).length;
  const tun = state.tunnels.filter(t => state.site === "all" || t.a === state.site || t.b === state.site);
  const tunOk = tun.filter(t => t.status === "ok").length;
  const bk = BACKUPS.filter(x => x.aktiv);
  const bkOk = bk.filter(x => x.status === "ok").length;
  const certWarn = CERTS.filter(c => c.bewertet !== false && c.days <= (thr("tls_warn_days") ?? 30)).length;

  return [
    { k: "Systeme", v: ueberwacht.length ? `${hostsOk}/${ueberwacht.length}` : "—", s: "antworten",
      ton: !ueberwacht.length ? "idle" : hostsOk === ueberwacht.length ? "ok" : "warn", go: "sites" },
    { k: "Tunnel", v: tun.length ? `${tunOk}/${tun.length}` : "—", s: tun.length ? "tragen" : "keiner angelegt",
      ton: !tun.length ? "idle" : tunOk === tun.length ? "ok" : "warn", go: "vpn" },
    { k: "Sicherungen", v: bk.length ? `${bkOk}/${bk.length}` : "—", s: bk.length ? "zuletzt geglückt" : "kein Auftrag gelesen",
      ton: !bk.length ? "idle" : bkOk === bk.length ? "ok" : "warn", go: "compute" },
    { k: "Zertifikate", v: CERTS.length ? String(certWarn) : "—", s: CERTS.length ? "laufen bald ab" : "keines gelesen",
      ton: !CERTS.length ? "idle" : certWarn ? "warn" : "ok", go: "dienste" }
  ];
}

/* Was die grüne Fläche nicht enthält. Ohne diesen Absatz wäre sie eine
   Behauptung über Dinge, die gar nicht gemessen werden — und das ist der
   Fehler, an dem Überwachungen still scheitern. */
function kurzLuecken() {
  const out = [];
  const ohneZugang = INTEGRATIONS.filter(i => i.unterstuetzt).reduce((a, i) => a + Math.max(0, (i.targets || 0) - (i.mitZugang || 0)), 0);
  const ohneSammler = INTEGRATIONS.filter(i => !i.unterstuetzt).reduce((a, i) => a + (i.targets || 0), 0);
  const aus = state.hosts.filter(h => h.monitored === false).length;
  const icmp = state.runtime?.icmp;

  if (ohneZugang) out.push({ ton: "warn", text: `<b>${ohneZugang}</b> System(e) ohne hinterlegte Zugangsdaten — dort wird
    nur die Erreichbarkeit geprüft, nicht, was drinnen los ist.` });
  if (ohneSammler) out.push({ ton: "idle", text: `<b>${ohneSammler}</b> System(e) eines Typs, für den es noch keinen
    Sammler gibt — auch dort zählt nur die Erreichbarkeit.` });
  if (aus) out.push({ ton: "idle", text: `<b>${aus}</b> System(e) sind von der Überwachung ausgenommen und tauchen in
    keiner Zahl auf.` });
  if (icmp && icmp.configured && icmp.working === false)
    out.push({ ton: "warn", text: `ICMP wird übersprungen (${esc(icmp.note || "")}) — geprüft wird nur, was einen
      offenen Port hat.` });
  if (icmp && !icmp.configured)
    out.push({ ton: "idle", text: `ICMP ist abgeschaltet — reine Ping-Ziele werden nicht geprüft.` });

  if (!out.length) out.push({ ton: "ok", text: `Nichts. Jedes angelegte System wird geprüft, und für jeden Typ mit
    Sammler sind Zugangsdaten hinterlegt.` });
  return out;
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

/* Ein leerer Bestand ist zweideutig: entweder ist wirklich noch nichts
   angelegt — oder der Dienst liest eine andere Ablage als beim letzten Mal.
   Nach einem Redeploy mit anderem Volume sieht beides gleich aus, und die
   Frage „wo sind meine Systeme hin?" wäre von der Oberfläche aus nicht zu
   beantworten. Deshalb steht hier, aus welcher Datei gelesen wird und ob
   der Dienst sie beim Start selbst angelegt hat. */
function bestandHinweis() {
  const b = state.runtime && state.runtime.bestand;
  if (!b) return "";
  const datei = `<span class="mono">${esc(b.datei)}</span>`;
  if (!b.angelegt)
    return `<p class="muted" style="margin:0 0 12px;font-size:12.5px">Gelesen wird ${datei}.</p>`;
  return `<div class="row" style="gap:8px;align-items:flex-start;margin:0 0 14px">${dot("warn")}
    <p class="muted" style="margin:0;font-size:12.5px;max-width:64ch">Diese Bestandsdatei hat der Dienst beim Start
      <b>selbst angelegt</b>${b.vorlage ? " (aus der mitgelieferten Vorlage)" : " (leeres Gerüst)"}: ${datei}.
      War dort vorher etwas eingetragen, liest er heute eine andere Ablage — im Container hängt dann ein anderes
      Volume auf <span class="mono">/data</span>, und der alte Bestand liegt noch im alten.${
        b.sicherung ? ` Daneben liegt <span class="mono">inventory.yaml.bak</span>, der Stand vor der letzten Änderung.` : ""}</p></div>`;
}

function firstStepsBanner() {
  return `<div class="panel panel--hello">
    <div class="panel-body row row-wrap" style="gap:14px">
      <div style="min-width:220px;flex:1">
        <div class="sec-title">Noch kein System angelegt</div>
        <p class="muted" style="margin:0 0 10px;font-size:13px">Der Dienst läuft und prüft — er weiß nur noch nicht, was.
        Systeme, Standorte, Tunnel und die Startseite werden unter <b>Verwaltung</b> gepflegt.</p>
        ${bestandHinweis()}
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
      ${bestandHinweis()}
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
  /* Erreichbarkeit ist eine Messung, keine Ampel.

     Hier stand einmal `status === "crit"`, und damit galt jedes rote System
     als stumm. Zwei Proxmox-Knoten, deren nächtlicher Sicherungsauftrag
     fehlgeschlagen war, standen dann unter „ohne Antwort" — obwohl sie
     einwandfrei antworteten. Die Kennzahl behauptete einen Netzausfall, wo
     eine Sicherung schiefgegangen war. Gezählt wird deshalb, was der Prober
     gemessen hat: `reachable`. */
  const geprüft = hosts.filter(h => h.reachable != null);
  const still = geprüft.filter(h => h.reachable === false).length;
  const befund = hosts.filter(h => h.reachable === true && isProblem(h.status)).length;
  const tunOk = state.tunnels.filter(t => t.status === "ok").length;
  const kpis = [
    { l:"Erreichbarkeit", v: geprüft.length ? pct(geprüft.length - still, geprüft.length) : "—",
      s: !hosts.length ? "kein überwachtes System"
        : !geprüft.length ? "noch nicht geprüft"
        : still ? `${still} von ${geprüft.length} ohne Antwort`
        : befund ? `alle ${geprüft.length} antworten · ${befund} mit Befund`
        : `alle ${geprüft.length} antworten`,
      t: !geprüft.length ? "idle" : still ? "warn" : "ok", go:"sites" },
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

/* ---------- Die Adressen nach außen ----------
   Getippt und gelesen nebeneinander. Wo beides dasteht und
   auseinanderläuft, wird es gesagt: ein Eintrag, den seit dem Anlegen
   niemand angefasst hat, sieht sonst genauso aus wie einer, der stimmt. */
function wanZeile(s) {
  const getippt = s.wan && s.wan !== "—" ? s.wan : null;
  const gelesen = s.wanIst || null;
  if (!gelesen) return getippt ? `<span class="mono">${esc(getippt)}</span>
    <span class="faint">— eingetragen, nicht gelesen</span>` : '<span class="faint">—</span>';
  const abweichung = getippt && getippt !== gelesen;
  return `<span class="mono">${esc(gelesen)}</span>${s.wanPrivat
      ? ' <span class="chip chip--warn" title="Eine private Adresse ist nicht die, unter der dieser Standort im Internet zu finden ist">privat</span>' : ""}
    ${s.wanAliase ? `<span class="chip chip--plain">+${s.wanAliase} Alias(e)</span>` : ""}
    <div class="faint" style="font-size:11.5px">gelesen von ${esc(s.wanQuelle)}${s.wanIface ? ` · ${esc(s.wanIface)}` : ""}${
      abweichung ? ` · <span style="color:var(--warn)">eingetragen steht ${esc(getippt)}</span>` : ""}</div>`;
}

/* Für die Kachel: nur die Adresse, aber die richtige. */
function wanKurz(s) {
  const gelesen = s.wanIst || null;
  const getippt = s.wan && s.wan !== "—" ? s.wan : null;
  if (!gelesen) return getippt ? esc(getippt) : "—";
  const abweichung = getippt && getippt !== gelesen;
  return `<span title="${esc(abweichung ? `eingetragen: ${getippt} — gelesen von ${s.wanQuelle}` : `gelesen von ${s.wanQuelle}`)}">${esc(gelesen)}${
    abweichung ? ' <span style="color:var(--warn)">≠</span>' : ""}</span>`;
}

/* `down` setzt der Server, wenn kein überwachtes System des Standorts mehr
   antwortet — dieselbe Bedingung, aus der die Standort-Bündelung entsteht. */
function siteCard(s) {
  const hosts = state.hosts.filter(h => h.site === s.id);
  const bad = hosts.filter(h => isProblem(h.status)).length;
  const tuns = state.tunnels.filter(t => t.a === s.id || t.b === s.id);
  const st = s.down ? "crit" : bad ? "warn" : hosts.length ? "ok" : "idle";
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
      <div class="stat"><span class="stat-k">WAN</span><span class="stat-v">${wanKurz(s)}</span></div>
      <div class="stat"><span class="stat-k">Systeme</span><span class="stat-v">${hosts.length}${bad ? ` <span style="color:var(--warn)">▲${bad}</span>` : ""}</span></div>
      <div class="stat"><span class="stat-k">Tunnel</span><span class="stat-v">${tuns.length ? `${tuns.filter(t => t.status === "ok").length}/${tuns.length}` : "—"}</span></div>
      <div class="stat"><span class="stat-k">Meldungen</span><span class="stat-v">${state.incidents.filter(i => i.site === s.id).length || "—"}</span></div>
    </div>
  </div>`;
}

/* ============================================================
   Ansicht: Standorte
   ============================================================ */

/* Die Karte sieht meist wie ein Stern aus, ist aber keiner: in der Mitte
   steht der Hauptstandort, ringsum die übrigen — und ein Tunnel zwischen
   zwei Nebenstandorten wird genauso gezeichnet. Wer eine solche Strecke
   legt, tut das gerade, damit der Verkehr nicht über die Mitte läuft; eine
   Karte, die sie verschweigt, zeigt ein Netz, das es so nicht gibt.

   Diese Direktstrecken werden nach außen gebogen. Gerade gezogen liefen
   sie quer durch die Nabe und sähen aus wie zwei Sternstrecken — also
   genau wie das, was sie nicht sind. */
function topoSvg() {
  /* Mitte ist der als primär markierte Standort; ist keiner markiert, der
     erste. Ohne Standort gibt es nichts zu zeichnen. */
  const hub = SITES.find(s => s.primary) || SITES[0];
  if (!hub) return '<div class="empty">Kein Standort angelegt.</div>';

  const W = 760, H = 260, cx = W / 2, cy = H / 2;
  const spokes = SITES.filter(s => s.id !== hub.id);
  const pos = new Map([[hub.id, { x: cx, y: cy }]]);
  spokes.forEach((s, i) => {
    const a = (-90 + (360 / spokes.length) * i) * Math.PI / 180;
    pos.set(s.id, { x: cx + Math.cos(a) * 250, y: cy + Math.sin(a) * 95 });
  });

  /* Eine Linie je Standortpaar, Richtung egal. Liegen mehrere Tunnel
     zwischen denselben Standorten, trägt die Linie den schlechtesten
     Zustand: eine tote zweite Strecke darf nicht hinter einer lebenden
     verschwinden. Wie viele es sind, steht am Zeiger. */
  const paar = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const strecken = new Map();
  for (const t of state.tunnels) {
    if (t.a === t.b || !pos.has(t.a) || !pos.has(t.b)) continue;
    const k = paar(t.a, t.b);
    const bisher = strecken.get(k);
    if (!bisher) strecken.set(k, { a: t.a, b: t.b, t, anzahl: 1 });
    else {
      bisher.anzahl++;
      if (SEV_ORDER[t.status] < SEV_ORDER[bisher.t.status]) bisher.t = t;
    }
  }
  /* Ein Nebenstandort ohne Tunnel zur Mitte behält seine Linie, grau:
     dass dort nichts liegt, ist die Aussage. */
  for (const s of spokes)
    if (!strecken.has(paar(hub.id, s.id)))
      strecken.set(paar(hub.id, s.id), { a: hub.id, b: s.id, t: null, anzahl: 0 });

  const farbe = t => !t || t.status === "idle" ? "var(--idle)"
    : t.status === "ok" ? "var(--ok)" : t.status === "warn" ? "var(--warn)" : "var(--crit)";
  const strich = t => t && t.status === "crit" ? "6 5" : t && t.status === "warn" ? "3 3" : "0";
  const text = t => !t ? "" : t.status === "crit" ? "keine Antwort" : t.rtt != null ? t.rtt + " ms" : "";

  const lines = [...strecken.values()].map(({ a, b, t, anzahl }) => {
    const p = pos.get(a), q = pos.get(b);
    const direkt = a !== hub.id && b !== hub.id;   /* Nebenstandort ↔ Nebenstandort */
    let d, lx, ly;
    if (!direkt) {
      d = `M${p.x.toFixed(1)} ${p.y.toFixed(1)} L${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
      lx = (p.x + q.x) / 2; ly = (p.y + q.y) / 2 - 6;
    } else {
      /* Senkrecht zur Sehne nach außen ausholen, und zwar um so weiter,
         je näher die Sehne an der Nabe vorbeiliefe. */
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const laenge = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      let nx = -(q.y - p.y) / laenge, ny = (q.x - p.x) / laenge;
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
      const bauch = 2 * Math.max(30, 86 - Math.hypot(mx - cx, my - cy));
      const kx = mx + nx * bauch, ky = my + ny * bauch;
      d = `M${p.x.toFixed(1)} ${p.y.toFixed(1)} Q${kx.toFixed(1)} ${ky.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
      lx = (mx + kx) / 2; ly = (my + ky) / 2 - 6;
    }
    const titel = `${siteName(a)} ↔ ${siteName(b)}`
      + (t ? ` · ${t.iface || t.id}` : " · kein Tunnel angelegt")
      + (anzahl > 1 ? ` · ${anzahl} Strecken` : "")
      + (t && t.rtt != null ? ` · ${t.rtt} ms` : "");
    return `<path d="${d}" fill="none" stroke="${farbe(t)}" stroke-width="1.8" stroke-dasharray="${strich(t)}" opacity=".85"><title>${esc(titel)}</title></path>
      <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="var(--faint)" font-size="10" font-family="IBM Plex Mono, monospace" text-anchor="middle">${esc(text(t))}</text>`;
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
  const direkte = [...strecken.values()].filter(x => x.t && x.a !== hub.id && x.b !== hub.id).length;
  return `<svg class="topo" viewBox="0 0 ${W} ${H}" role="img" aria-label="Netztopologie: ${esc(hub.name)} als Zentrum, weitere Standorte per Tunnel verbunden${direkte ? `, dazu ${direkte} Direktstrecke${direkte > 1 ? "n" : ""} zwischen Nebenstandorten` : ""}">
    ${lines}${spokes.map(s => node(pos.get(s.id).x, pos.get(s.id).y, s)).join("")}${node(cx, cy, hub, true)}
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
        <span class="mono faint" style="font-size:11.5px">${esc(s.isp)} · WAN ${wanKurz(s)} · IPv6 ${esc(s.wan6Ist || s.wan6)}</span>
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

/* ============================================================
   Ansicht: Virtualisierung

   Zwei Fragen, in dieser Reihenfolge: Wie geht es den Wirten — und was
   läuft darauf? Der erste Teil ist eine Kachel je Knoten mit Zustand,
   Softwarestand und ausstehenden Paketen; der zweite eine Tabelle über
   alle Gäste aller Knoten, weil man einen Gast selten auf dem Knoten
   sucht, auf dem man ihn vermutet.
   ============================================================ */
function viewVirt() {
  if (!state.hosts.length) return onboarding();
  const hs = visibleHosts();
  const pve = hs.filter(h => h.type === "pve");
  const cont = hs.filter(h => h.type === "portainer");
  const contProbleme = cont.flatMap(h => (h.probleme || []).map(p => ({ ...p, host: h.name })));

  const vms = sumKnown(pve, "vms"), lxc = sumKnown(pve, "lxc");
  const laufend = sumKnown(pve, "running"), gestoppt = sumKnown(pve, "stopped");
  const offen = sumKnown(pve, "updates");

  return `
  <div class="panel">
    <div class="panel-head"><h3>Proxmox-Knoten</h3>
      <span class="hint">${pve.length} Knoten · ${nz(vms)} VMs · ${nz(lxc)} Container</span>
      <div class="spacer"></div>
      ${offen ? `<span class="chip chip--info">${offen} Paketaktualisierung(en) offen</span>` : ""}</div>
    <div class="panel-body"><div class="grid g2">${pve.length
      ? pve.map(knotenKarte).join("")
      : '<div class="empty">Kein Proxmox-VE-Knoten in dieser Auswahl.</div>'}</div></div>
    ${pve.some(h => h.updatesNote) ? `<div class="panel-note">${esc(pve.find(h => h.updatesNote).updatesNote)}.
      Der Paketstand hängt an <span class="mono">Sys.Audit</span> auf dem Knoten — ohne dieses Recht bleibt die Zahl leer,
      statt eine Null zu behaupten.</div>` : ""}
  </div>

  ${gaestePanel(pve, laufend, gestoppt)}

  <div class="panel">
    <div class="panel-head"><h3>Container-Plattformen</h3><span class="hint">Portainer</span>
      ${contProbleme.length ? `<div class="spacer"></div><span class="chip chip--warn">${contProbleme.length} auffällige Container</span>` : ""}</div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>System</th><th>Standort</th><th>Umgebungen</th><th>Stacks</th><th>Container</th><th>Auffällig</th><th>Antwortzeit</th></tr></thead><tbody>
      ${cont.length ? portainerRows(cont)
        : '<tr><td colspan="8"><div class="empty">Kein Portainer in dieser Auswahl.</div></td></tr>'}
      </tbody></table>
    </div>
    ${contProbleme.length ? `<div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th>Container</th><th>Umgebung</th><th>Zustand</th><th>Befund</th></tr></thead><tbody>
      ${contProbleme.map(p => `<tr data-sev="warn">
        <td class="mono">${esc(p.name)}</td>
        <td class="faint">${esc(p.umgebung)}</td>
        <td class="mono faint">${esc(p.status || p.zustand)}</td>
        <td>${esc(p.grund)}</td></tr>`).join("")}
      </tbody></table></div>` : ""}
    ${cont.some(h => h.containers == null && h.endpoints == null) ? `<div class="panel-note">Stacks, Container und
      ungesunde Dienste liest der Leitstand über die Portainer-API — dafür fehlt hier noch ein API-Token
      (<b>Verwaltung → System bearbeiten</b>).</div>` : ""}
    ${cont.some(h => h.containerNote) ? `<div class="panel-note">${esc(cont.find(h => h.containerNote).containerNote)}.</div>` : ""}
  </div>`;
}

/* Ein Knoten ausführlich: Zustand, worauf er läuft, was ansteht.

   Ausstehende Pakete stehen als Hinweis da und drehen die Ampel nicht —
   ein Knoten mit vierzig offenen Paketen ist nicht gestört, er ist alt.
   Wer davon geweckt werden will, hat den Unterschied zwischen einer
   Wartungsliste und einem Alarm aufgegeben. */
function knotenKarte(h) {
  const s = h.schwellen || {};
  return `<div class="card" data-action="inspect" data-kind="host" data-id="${esc(h.id)}">
    <div class="card-head">
      <span style="padding-top:4px">${dot(h.status)}</span>
      <div>
        <div class="card-title mono">${esc(h.name)}</div>
        <div class="card-meta">${esc(h.cluster ? `Cluster ${h.cluster}` : h.quorum == null ? h.role : "standalone")}${
          h.quorum === false ? ' · <span style="color:var(--crit)">kein Quorum</span>' : ""}</div>
      </div>
      <div class="spacer"></div>
      <div class="right">
        <div class="card-meta">${h.nodeStatus ? esc(h.nodeStatus) : "—"}</div>
        <div class="card-meta mono">${h.version ? "PVE " + esc(h.version) : "—"}</div>
      </div>
    </div>

    ${hasMetrics(h) ? `<div class="col" style="gap:7px">
      ${meter("CPU", h.cpu, { warn: 80, crit: 95 })}
      ${meter("RAM", h.ram, { warn: s.ram_warn, crit: s.ram_crit })}
      ${meter("Speicher (Wurzel)", h.disk, { warn: s.disk_warn, crit: s.disk_crit })}
    </div>` : `<div class="row" style="gap:8px;font-size:12px;color:var(--faint)">
      ${dot("idle")}<span>${h.collectorError ? esc(h.collectorError) : "Kennzahlen erst mit hinterlegtem API-Token"} — Verwaltung → ${esc(h.name)}</span></div>`}

    <div class="stat-row">
      ${stat("Gäste", h.running == null ? "—" : `${h.running} von ${(h.running || 0) + (h.stopped || 0)} laufen`)}
      ${stat("VMs / LXC", `${nz(h.vms)} / ${nz(h.lxc)}`)}
      ${stat("Kerne", nz(h.cores))}
      ${stat("Laufzeit", nz(h.uptime))}
      <div class="spacer"></div>${histCell(h, { value: false })}
    </div>

    <div class="row row-wrap" style="gap:6px">
      ${h.kernel ? `<span class="chip chip--plain mono" title="Kernel">${esc(h.kernel)}</span>` : ""}
      ${h.updates == null ? `<span class="chip chip--plain">Paketstand unbekannt</span>`
        : h.updates ? `<span class="chip chip--info">${h.updates} Update(s) offen</span>`
        : `<span class="chip chip--ok">Pakete aktuell</span>`}
      ${h.load1 != null ? `<span class="chip chip--plain mono" title="Last (1 min)">Last ${esc(String(h.load1))}</span>` : ""}
      ${h.templates ? `<span class="chip chip--plain">${h.templates} Vorlage(n)</span>` : ""}
      ${h.schwellenEigen ? `<span class="chip chip--plain" title="Für dieses System eigene Schwellwerte">eigene Schwellen</span>` : ""}
    </div>
    ${h.note ? `<div class="row" style="gap:7px;font-size:12px;color:var(--${h.status})">${dot(h.status)}<span>${esc(h.note)}</span></div>` : ""}
  </div>`;
}

/* Alle Gäste aller Knoten in einer Tabelle. Laufendes zuerst, darin das
   Belastete oben — die Reihenfolge kommt schon aus dem Sammler.

   Ein gestoppter Gast hat keine Auslastung, sondern einen Strich: die
   Null, die Proxmox dort meldet, ist keine Messung. */
function gaestePanel(pve, laufend, gestoppt) {
  const q = state.q.toLowerCase().trim();
  const alle = pve.flatMap(h => (h.guests || []).map(g => ({ ...g, wirt: h.name, wirtId: h.id })));
  const gaeste = q
    ? alle.filter(g => `${g.name} ${g.vmid} ${g.wirt} ${g.tags || ""}`.toLowerCase().includes(q))
    : alle;
  const ohneListe = pve.filter(h => h.guests == null);

  return `<div class="panel">
    <div class="panel-head"><h3>Gäste</h3>
      <span class="hint">${gaeste.length} angezeigt${laufend != null ? ` · ${laufend} laufen, ${nz(gestoppt)} gestoppt` : ""}</span>
      <div class="spacer"></div><span class="hint">Auslastung aus der Bestandsliste des Clusters</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        <th style="width:34px"></th><th>Gast</th><th>Art</th><th>Knoten</th>
        <th>CPU</th><th>RAM</th><th>Platte</th><th>Kerne</th><th class="right">Laufzeit</th>
      </tr></thead><tbody>
      ${gaeste.length ? gaeste.map(gastZeile).join("")
        : `<tr><td colspan="9"><div class="empty">${ohneListe.length
            ? "Kein Knoten meldet Gäste — fehlt das API-Token oder die Leseberechtigung?"
            : "Kein Gast in dieser Auswahl."}</div></td></tr>`}
      </tbody></table>
    </div>
    <div class="panel-note">Bei virtuellen Maschinen kennt der Wirt die Belegung <em>im</em> Gast nicht — die Spalte
      Platte bleibt dort leer, solange kein Gastagent Auskunft gibt. Bei Containern ist die Zahl echt. Was gestoppt ist,
      hat keine Auslastung: dort steht ein Strich und keine Null.</div>
  </div>`;
}

function gastZeile(g) {
  const laeuft = g.status === "running";
  const ampel = laeuft ? "ok" : g.status === "paused" ? "warn" : "idle";
  return `<tr data-sev="${ampel}" data-action="inspect" data-kind="host" data-id="${esc(g.wirtId)}">
    <td class="sev">${dot(ampel)}</td>
    <td>
      <div class="mono">${esc(g.name)}</div>
      <div class="t-sub">${esc(String(g.vmid ?? "—"))}${g.tags ? " · " + esc(String(g.tags)) : ""}${
        g.lock ? ` · <span style="color:var(--warn)">gesperrt: ${esc(String(g.lock))}</span>` : ""}</div>
    </td>
    <td>${chip("plain", g.typ === "lxc" ? "LXC" : "VM")}</td>
    <td class="mono faint">${esc(g.wirt)}</td>
    <td style="min-width:110px">${g.cpu != null ? meter("", g.cpu, { text: g.cpu + " %", warn: 80, crit: 95 }) : `<span class="faint">${esc(g.status || "—")}</span>`}</td>
    <td style="min-width:110px">${g.ram != null ? meter("", g.ram, { text: g.ram + " %" }) : '<span class="faint">—</span>'}</td>
    <td style="min-width:110px">${g.disk != null ? meter("", g.disk, { text: g.disk + " %" }) : '<span class="faint">—</span>'}</td>
    <td class="mono faint">${nz(g.cores)}</td>
    <td class="right mono faint">${g.uptime != null ? esc(kurzLaufzeit(g.uptime)) : "—"}</td>
  </tr>`;
}

/* „3 T", „5 h", „12 min" — in einer Tabellenzeile ist mehr nur Lärm. */
function kurzLaufzeit(sek) {
  if (!Number.isFinite(sek)) return "—";
  if (sek >= 86400) return `${Math.floor(sek / 86400)} T`;
  if (sek >= 3600) return `${Math.floor(sek / 3600)} h`;
  return `${Math.floor(sek / 60)} min`;
}

/* ============================================================
   Ansicht: Speicher & Sicherung
   ============================================================ */
function viewCompute() {
  if (!state.hosts.length) return onboarding();
  const hs = visibleHosts();
  const store = hs.filter(h => ["truenas", "pbs"].includes(h.type));
  return `
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
      <div class="panel-head"><h3>Belegung im Einzelnen</h3><span class="hint">Datastores und Speicher</span>
        <div class="spacer"></div><span class="hint">Schwellwerte je System, siehe Verwaltung</span></div>
      <div class="panel-body col" style="gap:14px">
        ${(() => { const ohnePbs = store.filter(h => h.type !== "pbs"); return ohnePbs.length ? ohnePbs.map(h => {
          const liste = h.stores || h.storages || [];
          const s = h.schwellen || {};
          return `<div>
            <div class="row" style="gap:8px;margin-bottom:4px">
              ${dot(h.status)}<span class="sec-title" style="margin:0">${esc(h.name)}</span>
              <div class="spacer"></div>
              <span class="faint" style="font-size:11.5px">gelb ab ${nz(s.disk_warn, " %")} · rot ab ${nz(s.disk_crit, " %")}${
                h.schwellenEigen ? " (eigene Werte)" : ""}</span>
            </div>
            ${liste.length ? liste.map(x => meter(x.name, x.used, {
              text: x.used != null ? x.used + " %" : "—", warn: s.disk_warn, crit: s.disk_crit
            })).join("") : '<div class="faint" style="font-size:12.5px">Noch keine Belegung gelesen.</div>'}
          </div>`;
        }).join("") : store.length
          ? '<div class="empty">Alles Datastores — sie stehen unten in eigener Tabelle, mit Aufräumen und Prüfung.</div>'
          : '<div class="empty">Kein Speichersystem in dieser Auswahl.</div>'; })()}
      </div>
    </div>
  </div>

  ${datastorePanel(hs.filter(h => h.type === "pbs"))}
  ${backupPanel()}`;
}

/* ---------- Datastores des Backup Servers ----------

   Die Belegung allein sagt zu wenig. Ein Datastore, in den seit einer
   Woche nichts mehr gesichert wurde, ist unauffällig voll; einer, der nie
   aufgeräumt wurde, wächst, obwohl längst gelöschte Sicherungen darin
   liegen; und einer, der nie geprüft wurde, trägt vielleicht nichts
   Brauchbares. Deshalb stehen hier vier Zeitpunkte neben dem Balken —
   und wo einer fehlt, steht „nie", nicht ein Datum von heute. */
function datastorePanel(pbs) {
  const zeilen = pbs.flatMap(h => (h.stores || []).map(s => ({ ...s, wirt: h, schwellen: h.schwellen || {} })));
  if (!pbs.length) return "";

  return `<div class="panel">
    <div class="panel-head"><h3>Datastores</h3><span class="hint">Proxmox Backup Server</span>
      <div class="spacer"></div><span class="hint">${zeilen.length} Datastore(s) auf ${pbs.length} Server(n)</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Datastore</th><th>Server</th>
        <th style="min-width:170px">Belegung</th><th>Frei</th><th>Gesamt</th><th>Voll ca.</th>
        <th>Letzte Sicherung</th><th>Aufgeräumt</th><th>Geprüft</th></tr></thead><tbody>
      ${zeilen.length ? zeilen.map(s => `<tr data-sev="${storeTon(s)}">
        <td class="sev">${dot(storeTon(s))}</td>
        <td><div class="mono">${esc(s.name)}</div>${s.comment ? `<div class="t-sub">${esc(s.comment)}</div>` : ""}</td>
        <td class="faint">${esc(s.wirt.name)}</td>
        <td>${meter("", s.used, { text: s.used != null ? s.used + " %" : "—",
          warn: s.schwellen.disk_warn, crit: s.schwellen.disk_crit })}</td>
        <td class="mono faint">${esc(menge(s.availBytes))}</td>
        <td class="mono faint">${esc(menge(s.totalBytes))}</td>
        <td class="mono">${vollZelle(s)}</td>
        <td class="mono faint">${aufgabenZelle(s.lastBackup, s.backupOk)}</td>
        <td class="mono faint">${aufgabenZelle(s.lastGc, s.gcOk)}</td>
        <td class="mono faint">${aufgabenZelle(s.lastVerify, s.verifyOk)}</td>
      </tr>`).join("") : `<tr><td colspan="10"><div class="empty">Noch keine Belegung gelesen — ohne API-Token
        bleibt es bei der Erreichbarkeit.</div></td></tr>`}
      </tbody></table>
    </div>
    <div class="panel-note">Die Grenzen für Gelb und Rot stehen je Server unter <b>Verwaltung → System bearbeiten →
      Schwellwerte</b>. <b>Voll ca.</b> schätzt PBS selbst aus seinem Verlauf — steht dort ein Strich, hat PBS keine
      Schätzung, und der Leitstand rechnet sich keine aus. <b>Aufgeräumt</b> ist der letzte Garbage-Collection-Lauf:
      ohne ihn geben gelöschte Sicherungen ihren Platz nicht frei. <b>Geprüft</b> ist der letzte Verify-Lauf — er ist
      das Einzige, was eine Sicherung von einer Datei unterscheidet, die man noch nie gelesen hat.
      ${zeilen.some(s => s.wartung) ? "<br>Ein Datastore in Wartung nimmt nichts an; das ist eine Einstellung, keine Störung." : ""}</div>
  </div>`;
}

function storeTon(s) {
  if (s.used == null) return "idle";
  const w = s.schwellen.disk_warn ?? 80, c = s.schwellen.disk_crit ?? 90;
  return s.used >= c ? "crit" : s.used >= w ? "warn" : "ok";
}

/* Wann er voll ist — mit der Zahl, die PBS selbst nennt. Ohne die bleibt
   es beim Strich: zwei Messpunkte hochzurechnen wäre geraten. */
function vollZelle(s) {
  if (s.vollInTagen == null) return '<span class="faint">—</span>';
  const ton = s.vollInTagen <= 14 ? "warn" : "ok";
  return `<span style="color:var(--${ton})" title="${esc(s.vollAm || "")}">${
    s.vollInTagen <= 0 ? "jetzt" : `in ${s.vollInTagen} T`}</span>`;
}

/* Ein Zeitpunkt und ob es glückte. „nie" ist eine Auskunft und wird als
   solche gezeigt — nicht als Strich, der wie „nicht gelesen" aussieht. */
function aufgabenZelle(wann, ok) {
  if (!wann) return '<span class="faint" title="In den letzten Aufgaben kommt kein solcher Lauf vor">nie</span>';
  const text = esc(fmtWhen(wann) || "—");
  return ok === false ? `<span style="color:var(--crit)" title="Der letzte Lauf ist fehlgeschlagen">${text} ✕</span>` : text;
}

/* ---------- Sicherungsaufträge ----------

   Was eingerichtet ist und was davon gelaufen ist — nebeneinander, weil
   das eine eine Absicht ist und nur das andere eine Tatsache. Die drei
   Zeitpunkte stehen getrennt: „zuletzt gelaufen" beantwortet nicht, ob es
   geklappt hat, und „zuletzt erfolgreich" nicht, ob seither etwas
   schiefging. Ein Auftrag, der heute Nacht fehlschlug und vorgestern
   glückte, ist etwas anderes als einer, der nie lief. */
function backupPanel() {
  const zeilen = BACKUPS.filter(b => state.site === "all"
    || (state.hosts.find(h => h.id === b.host) || {}).site === state.site);

  const tabelle = `<div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Auftrag</th><th>Knoten</th><th>Zeitplan</th>
        <th>Ziel</th><th>Letzter Lauf</th><th>Zuletzt erfolgreich</th><th>Zuletzt fehlgeschlagen</th></tr></thead><tbody>
      ${zeilen.length ? zeilen.map(b => `<tr data-sev="${b.status}">
        <td class="sev">${dot(b.status)}</td>
        <td><div>${b.name ? esc(b.name) : `<span class="faint">ohne Bezeichnung</span>`}${
          b.aktiv ? "" : ' <span class="chip chip--plain">abgeschaltet</span>'}</div>
          <div class="t-sub">${esc(b.umfang || "Umfang unbekannt")}${b.modus ? " · " + esc(b.modus) : ""}${
          b.name ? "" : ` · <span class="mono">${esc(b.id || "—")}</span>`}</div></td>
        <td class="faint">${esc(b.node || b.hostName)}</td>
        <td><div class="mono">${esc(b.zeitplan || "—")}</div>${
          b.naechster ? `<div class="t-sub">nächster: ${esc(fmtWhen(b.naechster) || "—")}</div>` : ""}</td>
        <td class="mono faint">${esc(b.ziel || "—")}</td>
        <td class="mono">${laufZelle(b)}</td>
        <td class="mono faint">${esc(fmtWhen(b.zuletztOk) || "nie")}</td>
        <td class="mono">${b.zuletztFehler
          ? `<span style="color:var(--warn)">${esc(fmtWhen(b.zuletztFehler))}</span>`
          : '<span class="faint">nie</span>'}</td>
      </tr>`).join("") : `<tr><td colspan="8"><div class="empty">Kein Sicherungsauftrag für diese Auswahl.</div></td></tr>`}
      </tbody></table></div>`;

  const geraten = zeilen.some(b => b.quelle === "knoten" && b.zuletzt);
  return `<div class="panel">
    <div class="panel-head"><h3>Sicherungsaufträge</h3><span class="hint">eingerichtet in Proxmox VE</span>
      <div class="spacer"></div><span class="hint">${zeilen.filter(b => b.aktiv).length} von ${zeilen.length} aktiv</span></div>
    ${tabelle}
    <div class="panel-note">Bewertet wird der <b>letzte</b> Lauf: ist danach einer geglückt, ist die Sache erledigt.
      Ein Auftrag, der noch nie lief, bleibt grau — er kann heute erst angelegt worden sein.
      ${geraten ? `<br>Wo <b>„vom Knoten"</b> steht, ließ sich der Lauf keinem einzelnen Auftrag zuordnen: Proxmox
        schreibt die Auftragskennung erst ab neueren Fassungen in die Aufgabe. Dann gelten die Zeitpunkte aller
        <span class="mono">vzdump</span>-Läufe dieses Knotens — bei einem einzigen Auftrag ist das dasselbe, bei
        mehreren eine Näherung, und sie gibt sich als solche zu erkennen.` : ""}
      <br>Ein Auftrag ohne Knotenbindung läuft auf jedem Knoten für dessen eigene Gäste — er steht deshalb bei jedem.
      ${zeilen.some(b => !b.name) ? `<br>Wo <b>„ohne Bezeichnung"</b> steht, hat der Auftrag in Proxmox keinen Kommentar.
        Die Kennung darunter ist keine Bezeichnung — wer den Auftrag wiedererkennen will, trägt in Proxmox unter
        <span class="mono">Datacenter → Backup</span> einen Kommentar ein; der steht dann hier.` : ""}</div>
  </div>`;
}

/* Der letzte Lauf mit seinem Ausgang. „Gelaufen" und „geglückt" sind
   zweierlei, und in dieser Spalte steht beides zusammen. */
function laufZelle(b) {
  if (!b.zuletzt) return '<span class="faint">noch nie gelaufen</span>';
  const ton = b.letzterStatus === "fehler" ? "crit" : b.letzterStatus === "warn" ? "warn" : "ok";
  const wort = b.letzterStatus === "fehler" ? "fehlgeschlagen"
    : b.letzterStatus === "warn" ? "mit Warnungen" : "erfolgreich";
  return `<div><span style="color:var(--${ton})">${esc(fmtWhen(b.zuletzt))}</span></div>
    <div class="t-sub">${wort}${b.quelle === "knoten" ? ' <span class="faint">· vom Knoten</span>' : ""}</div>`;
}

/* ============================================================
   Ansicht: Netz & Proxy
   ============================================================ */
function viewNetz() {
  if (!state.hosts.length) return onboarding();
  const fws = visibleHosts().filter(h => FIREWALL.has(h.type));
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
        <th>Speicher</th><th>Platte</th><th>Zustandstabelle</th><th>Durchsatz</th><th>WG-Peers</th>
        <th>Zertifikat</th><th class="right">Antwortzeit</th></tr></thead><tbody>
      ${fws.length ? fws.map(f => `<tr data-sev="${f.status}" data-action="inspect" data-kind="host" data-id="${f.id}">
        <td class="sev">${dot(f.status)}</td>
        <td><div class="mono">${esc(f.name)}</div><div class="t-sub">${esc(f.role)}${
          f.carp ? ` · <span style="color:var(--${f.carpWartung ? "warn" : "faint"})">CARP ${esc(f.carp)}</span>` : ""}</div></td>
        <td>${chip("plain", siteShort(f.site))}</td>
        <td class="mono">${fassungsZelle(f)}</td>
        <td style="min-width:120px">${f.ram != null ? meter("", f.ram, { text: f.ram + " %", warn: f.schwellen?.ram_warn, crit: f.schwellen?.ram_crit }) : '<span class="faint">—</span>'}</td>
        <td style="min-width:120px">${f.disk != null ? meter("", f.disk, { text: f.disk + " %", warn: f.schwellen?.disk_warn, crit: f.schwellen?.disk_crit }) : '<span class="faint">—</span>'}</td>
        <td style="min-width:110px">${f.statesPct != null
          ? meter("", f.statesPct, { text: `${f.states} / ${f.statesMax}`, warn: 80, crit: 90 })
          : '<span class="faint">—</span>'}</td>
        <td class="mono faint">${durchsatzZelle(f)}</td>
        <td class="mono">${wgZelle(f)}</td>
        <td>${certCell(f)}</td>
        <td class="right">${histCell(f)}</td>
      </tr>`).join("") : '<tr><td colspan="11"><div class="empty">Keine Firewall in dieser Auswahl.</div></td></tr>'}
      </tbody></table>
    </div>
    <div class="panel-note">${mitApi
      ? `Zustandstabelle, CARP-Rolle und Gateways liefern beide Bauarten. Was eine Fassung nicht kennt, bleibt leer,
         statt eine Null zu zeigen — ein Endpunkt, den es nicht gibt, ist keine Messung von null.`
      : `Für Kennzahlen braucht es einen API-Zugang: bei OPNsense unter
         <span class="mono">System → Access → Users</span> einen Schlüssel erzeugen, bei pfSense zuerst das Paket
         <span class="mono">pfSense-pkg-API</span> installieren. Beides dann unter <b>Verwaltung</b> hinterlegen.
         Ohne bleibt es bei Erreichbarkeit, Antwortzeit und Zertifikat.`}</div>
  </div>`;

  return firewalls + gatewayPanel(fws) + wlanPanel(visibleHosts()) + schnittstellenPanel(fws) + haproxyPanel();
}

/* ---------- WLAN ----------

   Die Zeile je Gerät, nicht je Controller: die Frage ist nie „läuft der
   Controller?", sondern „welcher Access Point ist weg?". Switches und
   Gateways stehen mit dabei, weil ein getrennter Switch der Grund für
   zwei stille APs ist.

   Die Ampel der Zeile ist die des Geräts, nicht die des Systems: ein
   einzelner ausgefallener AP macht den Controller gelb (siehe Sammler) —
   das Gerät selbst ist rot. Beides ist wahr, und beides steht da, wo es
   hingehört. */
const WLAN_SEV = { online:"ok", offline:"crit", isoliert:"warn", wartet:"idle", aktualisiert:"info", fehler:"warn", unbekannt:"idle" };
const WLAN_ART = { ap:"Access Point", switch:"Switch", gateway:"Gateway", sonstiges:"sonstiges" };

function wlanPanel(hs) {
  const ctrl = hs.filter(h => h.type === "unifi");
  if (!ctrl.length) return "";

  const zeilen = ctrl.flatMap(c => (c.wlanGeraete || []).map(g => ({ ...g, ctrl: c.name, ctrlId: c.id, site: c.site })));
  const aps = zeilen.filter(g => g.art === "ap");
  const clients = ctrl.reduce((a, c) => a + (c.clients ?? 0), 0);
  const gelesen = ctrl.some(c => c.wlanGeraete);
  const ohneZugang = ctrl.filter(c => !c.wlanGeraete);
  const nurIntegration = ctrl.filter(c => c.wlanQuelle === "integration");
  const grenze = thr("wlan_kanal_warn") ?? 80;

  const funkZelle = g => (g.funk || []).length
    ? g.funk.map(f => `<div class="mono" style="font-size:11.5px">${esc(f.band || "?")} · K${esc(String(f.kanal ?? "?"))}${
        f.last != null ? ` · <span style="color:var(--${f.last >= grenze ? "warn" : "faint"})">${f.last} %</span>` : ""}</div>`).join("")
    : '<span class="faint">—</span>';

  return `<div class="panel">
    <div class="panel-head"><h3>WLAN</h3>
      <span class="hint">${aps.length} Access Point(s)${clients ? " · " + clients + " Clients" : ""}</span>
      <div class="spacer"></div>
      <span class="hint">vom Controller gemeldet — ein AP mit Strom antwortet auch dann, wenn er nichts mehr tut</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        <th style="width:34px"></th><th>Gerät</th><th>Art</th><th>Standort</th><th>Zustand</th>
        <th class="right">Clients</th><th>Funk</th><th>Uplink</th><th>Fassung</th><th class="right">Laufzeit</th>
      </tr></thead><tbody>
      ${zeilen.length ? zeilen.map(g => `<tr data-sev="${WLAN_SEV[g.zustand] || "idle"}" data-action="inspect" data-kind="host" data-id="${esc(g.ctrlId)}">
        <td class="sev">${dot(WLAN_SEV[g.zustand] || "idle")}</td>
        <td><div class="mono">${esc(g.name)}</div><div class="t-sub">${esc([g.modell, g.ip].filter(Boolean).join(" · ") || g.ctrl)}</div></td>
        <td class="faint">${esc(WLAN_ART[g.art] || g.art)}</td>
        <td>${chip("plain", siteShort(g.site))}</td>
        <td>${g.zustand === "online" ? '<span class="mono faint">verbunden</span>' : chip(WLAN_SEV[g.zustand] || "idle", g.zustandText)}</td>
        <td class="right mono">${nz(g.clients)}${g.clientsGast ? ` <span class="faint">+${g.clientsGast}</span>` : ""}</td>
        <td>${funkZelle(g)}</td>
        <td class="mono faint">${g.uplink ? esc(g.uplink) + (g.uplinkFunk ? " (Funk)" : "") : "—"}</td>
        <td class="mono faint">${esc(nz(g.fassung))}${g.update ? ' <span class="chip chip--info">neu</span>' : ""}</td>
        <td class="right mono faint">${esc(laufzeitKurz(g.laufzeit))}</td>
      </tr>`).join("") : `<tr><td colspan="10"><div class="empty">${gelesen
        ? "Der Controller führt keine Geräte in dieser Site."
        : "Noch nichts gelesen — dem Controller fehlen die Zugangsdaten."}</div></td></tr>`}
      </tbody></table>
    </div>
    ${ohneZugang.length ? `<div class="panel-note">Zustand, Funk und Clientzahlen kommen aus dem Controller und
      brauchen einen Zugang — ${ohneZugang.map(c => `<b>Verwaltung → ${esc(c.name)}</b>`).join(", ")}.
      Ohne ihn bleibt es bei Erreichbarkeit, Antwortzeit und Zertifikat des Controllers selbst.</div>` : ""}
    ${nurIntegration.length ? `<div class="panel-note">${nurIntegration.map(c => esc(c.name)).join(", ")} wird über die
      <b>Integration-API</b> gelesen: Zustand, Modell und Fassung. Kanalbelegung und Clientzahlen kennt sie nicht —
      dafür braucht es zusätzlich Benutzer und Passwort eines Viewer-Kontos.</div>` : ""}
  </div>`;
}

/* Laufzeit, wie man sie im Vorbeigehen liest. Ab einem Tag zählen Tage:
   dass ein AP seit 37 Tagen läuft, ist die Auskunft — nicht die Stunden. */
function laufzeitKurz(sek) {
  if (sek == null || !Number.isFinite(sek)) return "—";
  const tage = Math.floor(sek / 86400);
  return tage >= 1 ? `${tage} T` : `${Math.floor(sek / 3600)} h`;
}

/* Die Gateways aller Firewalls, die welche melden.

   Ein ausgefallener Uplink ist der Fall, bei dem die Firewall selbst
   tadellos antwortet und trotzdem nichts mehr geht. Von außen ist das
   nicht zu sehen — die Firewall sagt es einem, wenn man sie fragt. */
function gatewayPanel(fws) {
  const mit = fws.filter(f => (f.gateways || []).length);
  if (!mit.length) return "";
  const zeilen = mit.flatMap(f => f.gateways.map(g => ({ ...g, fw: f.name, fwId: f.id })));
  const ampelVon = g => /down|offline/.test(g.status) ? "crit"
    : /loss|delay|warn/.test(g.status) || (g.verlust ?? 0) >= 2 ? "warn"
    : /online|up|none/.test(g.status) ? "ok" : "idle";
  const kaputt = zeilen.filter(g => ampelVon(g) !== "ok").length;

  return `<div class="panel">
    <div class="panel-head"><h3>Gateways</h3>
      <span class="hint">${zeilen.length} auf ${mit.length} Gerät(en)</span>
      <div class="spacer"></div>
      ${kaputt ? `<span class="chip chip--warn">${kaputt} auffällig</span>` : ""}
      <span class="hint">von der Firewall gemessen, nicht von hier</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        <th style="width:34px"></th><th>Gateway</th><th>Gerät</th><th>Zustand</th><th>Überwacht</th>
        <th class="right">Latenz</th><th class="right">Verlust</th>
      </tr></thead><tbody>
      ${zeilen.map(g => `<tr data-sev="${ampelVon(g)}" data-action="inspect" data-kind="host" data-id="${esc(g.fwId)}">
        <td class="sev">${dot(ampelVon(g))}</td>
        <td><div class="mono">${esc(g.name)}</div>${g.quelle ? `<div class="t-sub mono">von ${esc(g.quelle)}</div>` : ""}</td>
        <td class="mono faint">${esc(g.fw)}</td>
        <td>${chip(ampelVon(g), g.status)}</td>
        <td class="mono faint">${esc(nz(g.monitor))}</td>
        <td class="right mono">${nz(g.rtt, " ms")}</td>
        <td class="right mono" style="${(g.verlust ?? 0) >= 2 ? "color:var(--warn)" : ""}">${nz(g.verlust, " %")}</td>
      </tr>`).join("")}
      </tbody></table>
    </div>
    <div class="panel-note">Diese Zahlen misst die Firewall selbst gegen ihre Monitor-Adresse — sie sagen etwas über
      die Leitung <em>hinter</em> der Firewall, was der Leitstand von innen nie sehen könnte. Ein Gateway ohne
      Überwachung meldet OPNsense als <span class="mono">none</span>; das heißt „steht, wird nicht gemessen" und ist
      kein Befund. Wo <span class="mono">~</span> stünde, wurde nichts gemessen — dort bleibt ein Strich, keine Null.</div>
  </div>`;
}

/* Alle Schnittstellen aller Firewalls in einer Tabelle.

   Die Zahl in der Firewall-Zeile darüber ist die WAN-Seite (oder die
   Summe) — die beantwortet „wie viel geht gerade durch das Haus?". Diese
   Tabelle beantwortet die nächste Frage: durch welche Leitung. Ohne sie
   sieht man an einer vollen Uplink-Anzeige nicht, ob der Verkehr aus dem
   LAN, aus dem Gastnetz oder aus dem Tunnel kommt.

   Vor dem zweiten Durchlauf steht hier ein Strich: Durchsatz ist eine
   Differenz zweier Zählerstände, und einen ersten gibt es noch nicht. */
function schnittstellenPanel(fws) {
  const mit = fws.filter(f => (f.interfaces || []).length);
  if (!mit.length) {
    const ohne = fws.some(f => f.version);       /* API antwortet, Zähler fehlen trotzdem */
    return `<div class="panel">
      <div class="panel-head"><h3>Schnittstellen</h3><span class="hint">Durchsatz je Leitung</span></div>
      <div class="panel-body"><div class="empty">${ohne
        ? "Noch keine Zählerstände gelesen — Durchsatz entsteht erst aus der Differenz zweier Durchläufe."
        : "Ohne API-Schlüssel liest der Leitstand keine Schnittstellenzähler."}</div></div>
    </div>`;
  }

  const zeilen = mit.flatMap(f => f.interfaces.map(i => ({ ...i, fw: f.name, fwId: f.id, site: f.site })));
  const auffaellig = zeilen.filter(i => (i.fehlerNeu || 0) + (i.verworfenNeu || 0) > 0).length;

  return `<div class="panel">
    <div class="panel-head"><h3>Schnittstellen</h3>
      <span class="hint">${zeilen.length} Leitungen auf ${mit.length} Gerät(en)</span>
      <div class="spacer"></div>
      ${auffaellig ? `<span class="chip chip--warn">${auffaellig} mit neuen Fehlern</span>` : ""}
      <span class="hint">Durchsatz aus der Differenz zweier Durchläufe</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        <th style="width:34px"></th><th>Leitung</th><th>Gerät</th><th>Verbindung</th>
        <th class="right">↓ herein</th><th class="right">↑ hinaus</th>
        <th class="right">Pakete/s</th><th class="right">Übertragen</th><th>Fehler · verworfen</th>
      </tr></thead><tbody>
      ${zeilen.map(ifZeile).join("")}
      </tbody></table>
    </div>
    <div class="panel-note">Fehler und Verwürfe sind Zählerstände seit dem letzten Neustart des Geräts; in Klammern
      steht, was seit dem letzten Durchlauf dazugekommen ist — nur das ist eine Nachricht. Eine Ampel machen sie nicht:
      ein einzelnes verworfenes Paket auf einer ausgelasteten Leitung ist normal, und eine Schwelle dafür wäre geraten.
      Der Verlauf je Leitung steht auf der Seite des Geräts.</div>
  </div>`;
}

function ifZeile(i) {
  const neu = (i.fehlerNeu || 0) + (i.verworfenNeu || 0);
  /* Der Verbindungszustand kommt aus der Schnittstellenübersicht. Kennt
     die Fassung den Endpunkt nicht, ist er unbekannt — und unbekannt wird
     als Strich gezeigt, nicht als „up". */
  const link = i.link == null ? '<span class="faint">—</span>'
    : i.link === "up" ? chip("ok", "up")
    : chip("warn", String(i.link));
  return `<tr data-sev="${neu ? "warn" : "ok"}" data-action="inspect" data-kind="host" data-id="${esc(i.fwId)}">
    <td class="sev">${dot(i.link === "down" ? "warn" : "ok")}</td>
    <td>
      <div class="mono">${esc(i.label)}</div>
      <div class="t-sub mono">${esc(i.name)}${i.beschreibung && i.beschreibung !== i.label ? " · " + esc(i.beschreibung) : ""}${
        i.mtu ? ` · MTU ${esc(String(i.mtu))}` : ""}</div>
    </td>
    <td class="mono faint">${esc(i.fw)}</td>
    <td>${link}</td>
    <td class="right mono">${mbit(i.in)}</td>
    <td class="right mono">${mbit(i.out)}</td>
    <td class="right mono faint">${i.inPps == null && i.outPps == null ? "—" : `${nz(i.inPps)} / ${nz(i.outPps)}`}</td>
    <td class="right mono faint">${menge(i.rxBytes)} / ${menge(i.txBytes)}</td>
    <td class="mono ${neu ? "" : "faint"}" style="${neu ? "color:var(--warn)" : ""}">
      ${nz(i.fehler)} · ${nz(i.verworfen)}${neu ? ` <b>(+${neu})</b>` : ""}</td>
  </tr>`;
}

/* Mbit/s lesbar: unter 1 mit zwei Nachkommastellen, darüber mit einer.
   Null ist hier ein Messwert („gerade nichts los") und wird als 0 gezeigt;
   unbekannt bleibt ein Strich. */
function mbit(v) {
  if (v == null || !Number.isFinite(v)) return '<span class="faint">—</span>';
  return v < 1 ? v.toFixed(2) : v.toFixed(1);
}

function menge(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const e = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, v = n;
  while (v >= 1024 && i < e.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${e[i]}`;
}

/* Beide Firewall-Typen werden gleich behandelt, wo sie dasselbe liefern.
   Der Sammler sorgt dafür, dass die Feldnamen übereinstimmen — eine
   Firewall bleibt eine Firewall, gleich von wem sie ist. */
const FIREWALL = new Set(["opnsense", "pfsense"]);

/* Gateways — von beiden Firewall-Typen.

   Es ist die Angabe, die einen ausgefallenen Uplink am schnellsten
   verrät, und sie sagt mehr als „erreichbar": „online mit 0,4 % Verlust"
   ist etwas anderes als „down", und beides sieht von außen gleich aus,
   solange die Firewall selbst antwortet. */
/* ---------- Die Anschlüsse nach außen ----------
   Welche Schnittstelle nach draußen geht, entscheidet ihr Gateway und
   nicht ihr Name — und was dort an Adressen hängt, gehört vollständig
   hin: eine zweite öffentliche Adresse auf derselben Leitung (IP-Alias)
   ist von außen genauso echt wie die erste. Wer einen Dienst darauf
   veröffentlicht hat und hier nur die erste sieht, sucht im Zweifel am
   falschen Ende. */
function uplinkTabelle(h) {
  const liste = h.uplinks;
  if (!liste || !liste.length) return "";
  const adr = a => `<span class="mono">${esc(a.ip)}${a.praefix != null ? "/" + a.praefix : ""}</span>${
    a.privat ? ' <span class="chip chip--warn">privat</span>' : ""}${
    a.vhid ? ` <span class="chip chip--plain">CARP ${esc(a.vhid)}${a.carp ? " · " + esc(a.carp) : ""}</span>` : ""}`;
  return `<div class="panel-body panel-body--flush tablewrap">
    <table class="t"><thead><tr>
      <th style="width:34px"></th><th>Anschluss</th><th>Art</th><th>Adresse</th><th>Weitere Adressen</th><th>Gateway</th>
    </tr></thead><tbody>
    ${liste.map(u => {
      const ampel = u.zustand == null ? "idle" : u.zustand === "up" ? "ok" : "crit";
      return `<tr data-sev="${ampel}">
        <td class="sev">${dot(ampel)}</td>
        <td><div class="mono">${esc(u.beschreibung || u.name)}</div>
          <div class="t-sub">${esc(u.name)}${u.geraet && u.geraet !== u.name ? " · " + esc(u.geraet) : ""}</div></td>
        <td class="faint">${esc(u.art || "—")}</td>
        <td>${u.ipv4 ? adr(u.ipv4) : '<span class="faint">—</span>'}
          ${u.ipv6 ? `<div style="margin-top:3px">${adr(u.ipv6)}</div>` : ""}</td>
        <td>${(u.aliase || []).length
          ? u.aliase.map(a => `<div>${adr(a)}</div>`).join("")
          : '<span class="faint">—</span>'}</td>
        <td class="mono faint">${esc((u.gateways || []).join(", ") || "—")}</td>
      </tr>`;
    }).join("")}
    </tbody></table>
  </div>
  <div class="panel-note">Als Anschluss nach außen gilt, woran ein <b>Gateway</b> hängt — nicht, was „WAN" heißt.
    Ein zweiter Anschluss trägt selten diesen Namen, und ein ungewöhnlich benannter wäre sonst unsichtbar.
    <b>IP-Aliase</b> stehen als weitere Adressen dabei: für alles, was von außen kommt, sind sie genauso echt wie
    die erste. Eine mit <b>CARP</b> gekennzeichnete gehört diesem Gerät nur, solange es MASTER ist.
    ${liste.some(u => u.ipv4?.privat) ? `<br>Eine als <b>privat</b> gekennzeichnete Adresse ist die Wahrheit über
      die Schnittstelle und <em>nicht</em> die Adresse, unter der dieser Standort im Internet zu finden ist —
      davor hängt ein Modem oder Router, der die eigentliche trägt.` : ""}</div>`;
}

function gatewayTabelle(h) {
  const gws = h.gateways || [];
  if (!gws.length) return "";
  const ampelVon = g => /down|offline/.test(g.status) ? "crit"
    : /loss|delay|warn/.test(g.status) || (g.verlust ?? 0) >= 2 ? "warn"
    : /online|up|none/.test(g.status) ? "ok" : "idle";
  return `<div class="panel-body panel-body--flush tablewrap">
    <table class="t"><thead><tr>
      <th style="width:34px"></th><th>Gateway</th><th>Zustand</th><th>Überwacht</th>
      <th class="right">Latenz</th><th class="right">Schwankung</th><th class="right">Verlust</th>
    </tr></thead><tbody>
    ${gws.map(g => `<tr data-sev="${ampelVon(g)}">
      <td class="sev">${dot(ampelVon(g))}</td>
      <td><div class="mono">${esc(g.name)}</div>${g.quelle ? `<div class="t-sub mono">von ${esc(g.quelle)}</div>` : ""}</td>
      <td>${chip(ampelVon(g), g.status)}${g.substatus && g.substatus !== "none" ? ` <span class="faint">${esc(g.substatus)}</span>` : ""}</td>
      <td class="mono faint">${esc(nz(g.monitor))}</td>
      <td class="right mono">${nz(g.rtt, " ms")}</td>
      <td class="right mono faint">${nz(g.stddev, " ms")}</td>
      <td class="right mono" style="${(g.verlust ?? 0) >= 2 ? "color:var(--warn)" : ""}">${nz(g.verlust, " %")}</td>
    </tr>`).join("")}
    </tbody></table></div>`;
}

/* Kurzfassung der tatsächlich gelaufenen Prüfungen — was übersprungen
   wurde, wird durchgestrichen, damit ICMP-losigkeit auffällt. */
function checkList(h) {
  const cs = h.checks || [];
  if (!cs.length) return "—";
  return cs.map(c => {
    const name = esc(c.kind + (c.port ? "/" + c.port : "")) + (c.wesentlich ? "*" : "");
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
  /* pfSense aktualisiert als Ganzes, OPNsense paketweise — „1 Updates"
     wäre bei ersterem schlicht falsches Deutsch und bei zweiterem eine
     Untertreibung. */
  if (f.updates === 1) marken.push(chip("info", "1 Update"));
  else if (f.updates) marken.push(chip("info", f.updates + " Updates"));
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
   sagt, woher der Zustand dieser Zeile überhaupt stammt. Ist auch der
   nicht bekannt, stehen die Adressen da, die die Firewalls als erlaubte
   Netze melden: gelesen, nicht gemessen, und als solche gekennzeichnet.

   Darunter die beiden Enden. Eine Strecke hat zwei; steht dort nur eines,
   ist die andere Firewall nicht verknüpft — und ihre Zeile in der
   Gegenstellenliste behauptet dann, zu keiner Strecke zu gehören. */
function gegenstelle(t) {
  const ziel = t.probe ? esc(t.probe)
    : t.peer?.endpoint ? `${esc(t.peer.endpoint)} <span class="faint">(Peer)</span>`
    : (t.ips || []).length ? `${esc(t.ips.join(" ↔ "))} <span class="faint">(gelesen)</span>`
    : "—";
  const enden = [t.peer, t.peerB].filter(Boolean);
  if (!enden.length) return ziel;
  const namen = enden.map(p => `${p.gefunden ? "" : "⚠ "}${esc(p.host)}`).join(" ↔ ");
  return `<div>${ziel}</div><div class="t-sub">${namen}${
    enden.length === 1 ? ' <span class="faint" title="Die zweite Firewall meldet dieselbe Strecke — unter Verwaltung → Tunnel auswählen">· nur ein Ende</span>' : ""}</div>`;
}

/* Das Handshake-Alter des verknüpften Peers. Ohne Verknüpfung steht hier
   ein Strich — mit dem Hinweis, wo man sie herstellt, statt schweigend
   nichts. Ein hinterlegter Peer, den die Firewall nicht mehr meldet, wird
   ausdrücklich als solcher gezeigt: das ist ein anderer Zustand als „noch
   nie gemeldet" und will anders behandelt werden. */
function handshakeZelle(t) {
  const enden = [t.peer, t.peerB].filter(Boolean);
  if (!enden.length) return `<span class="faint" title="Kein Peer verknüpft — unter Verwaltung → Tunnel auswählen">—</span>`;
  /* Meldet eines der beiden Enden, zählt dessen Auskunft. „Nicht
     gemeldet" steht hier nur, wenn keines mehr etwas sagt — sonst stünde
     eine tragende Strecke wegen einer schiefen Verknüpfung auf Gelb. */
  const gemeldet = enden.filter(p => p.gefunden);
  if (!gemeldet.length)
    return `<span style="color:var(--warn)" title="${esc(enden[0].note || "")}">nicht gemeldet</span>`;
  if (t.handshake == null) return `<span class="faint" title="Diese Gegenstelle hat sich noch nie gemeldet">nie</span>`;
  const p = gemeldet.find(x => x.handshake === t.handshake) || gemeldet[0];
  const ton = t.handshake <= 180 ? "ok" : t.handshake <= 600 ? "warn" : "crit";
  return `<span style="color:var(--${ton})" title="${esc(p.name || "")}${p.seit ? " · " + esc(p.seit) : ""}${
    gemeldet.length < enden.length ? " · das andere Ende meldet ihn nicht" : ""}">${esc(hs(t.handshake))}</span>`;
}

/* Welche Prüfung was gesagt hat — dieselbe Auskunft, die ein System
   längst gibt. „Antwortet nicht" ohne diese Zeile lässt offen, ob das
   Ziel schweigt oder ob gar nicht gefragt wurde: eine übersprungene
   ICMP-Prüfung ist keine Aussage über die Strecke, sieht aber genauso
   rot aus, wenn sie die einzige war. */
function tunnelPruefungen(t) {
  const cs = t.checks || [];
  if (!cs.length) return t.probe
    ? `<div><div class="sec-title">Prüfungen</div>
        <p class="admin-hint" style="margin:0">Noch kein Durchlauf.</p></div>`
    : "";
  const uebersprungen = cs.filter(c => c.skipped);
  return `<div><div class="sec-title">Prüfungen</div>
    <div class="col" style="gap:6px">
      ${cs.map(c => `<div class="row" style="gap:8px;align-items:flex-start">
        ${c.skipped ? dot("idle") : dot(c.ok ? "ok" : "crit")}
        <span class="mono" style="font-size:12px;min-width:64px">${esc(c.kind + (c.port ? "/" + c.port : ""))}</span>
        <span style="font-size:13px;min-width:0">${esc(c.detail || (c.ok ? "antwortet" : "keine Antwort"))}</span>
        <span class="spacer"></span><span class="mono faint" style="font-size:11px">${c.ms != null ? c.ms + " ms" : ""}</span>
      </div>`).join("")}
    </div>
    ${uebersprungen.length === cs.length ? `<p class="admin-hint" style="margin:6px 0 0">Keine dieser Prüfungen ist
      gelaufen — über diese Strecke ist damit nichts gemessen, und die Ampel steht auf Grau, nicht auf Grün.</p>` : ""}
  </div>`;
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

  const enden = [t.peer, t.peerB].filter(Boolean);
  return `<div><div class="sec-title">WireGuard-Peer${enden.length > 1 ? "s — beide Enden" : ""}</div>
    ${enden.map(p => peerEnde(p)).join("")}
    ${enden.length === 1 ? `<p class="admin-hint" style="margin:8px 0 0">Nur ein Ende ist verknüpft. Die zweite
      Firewall meldet dieselbe Strecke als eigenen Peer — wird sie unter <b>Bearbeiten</b> dazugewählt, stimmt die
      Zuordnung in beide Richtungen, und die beiden Angaben lassen sich gegeneinander halten.</p>` : ""}
    ${t.peerAbstand > 600 ? `<div class="row" style="gap:8px;align-items:flex-start;margin-top:8px">${dot("warn")}
      <span style="font-size:13px">Die Enden widersprechen sich: ihre Handshakes liegen ${esc(hs(t.peerAbstand))}
      auseinander. Dieselbe Strecke wäre sich einig — vermutlich zeigt eine der Verknüpfungen auf einen anderen
      Tunnel.</span></div>` : ""}
    ${streckenBlock(t)}</div>`;
}

/* Ein Ende: hinterlegt und gemeldet, hinterlegt und verschwunden, oder
   gemeldet und vollständig. Die drei dürfen nicht gleich aussehen. */
function peerEnde(p) {
  if (!p.gefunden) return `<div style="margin-bottom:10px">
    <div class="row" style="gap:8px;align-items:flex-start">${dot("warn")}
      <span style="font-size:13px">${esc(p.note || `„${p.name}" wird von ${p.host} nicht gemeldet.`)}</span></div>
    <p class="admin-hint" style="margin:6px 0 0">Hinterlegt ist <span class="mono">${esc(p.name || p.key || "—")}</span>
      auf <span class="mono">${esc(p.host)}</span>. Die Messung durch den Tunnel läuft davon unberührt weiter.</p></div>`;

  return `<dl class="kv" style="margin-bottom:10px">
    <dt>Gegenstelle</dt><dd class="mono">${esc(p.name || "—")}</dd>
    <dt>Gelesen von</dt><dd class="mono">${esc(p.host)}${p.iface ? ` <span class="faint">· ${esc(p.iface)}</span>` : ""}</dd>
    <dt>Endpunkt</dt><dd class="mono">${esc(nz(p.endpoint))}</dd>
    <dt>Erlaubte Netze</dt><dd class="mono">${esc(nz(p.allowed))}</dd>
    <dt>Letzter Handshake</dt><dd class="mono" title="${esc(p.seit || "")}">${p.handshake == null ? "nie" : esc(hs(p.handshake))}</dd>
    <dt>Übertragen</dt><dd class="mono">${p.rx ? `${esc(p.rx)} ↓ / ${esc(p.tx)} ↑` : "—"}</dd>
    ${p.keepalive ? `<dt>Keepalive</dt><dd class="mono">${esc(p.keepalive)} s</dd>` : ""}
  </dl>`;
}

/* Was die Firewalls über die Strecke selbst wissen — abgelesen aus den
   erlaubten Netzen der Peers, nicht aus dem Bestand. Genau die Angaben,
   die man sonst von Hand abschreibt: die Adressen im Transfernetz und
   die Netze, die dahinter erreichbar sind. */
function streckenBlock(t) {
  const ips = t.ips || [], netze = t.netze || [];
  if (!ips.length && !netze.length) return "";
  return `<div style="margin-top:8px">
    <div class="sec-title">Von den Firewalls gelesen</div><dl class="kv">
      ${ips.length ? `<dt>Adressen im Tunnel</dt><dd class="mono">${esc(ips.join(" · "))}</dd>` : ""}
      ${netze.length ? `<dt>Netze dahinter</dt><dd class="mono">${esc(netze.join(" · "))}</dd>` : ""}
    </dl>
    <p class="admin-hint" style="margin:4px 0 0">Steht in den erlaubten Netzen der Peers. Eine dieser Adressen
      gehört als <b>Gegenstelle im Tunnel</b> eingetragen — dann wird durch die Strecke gemessen statt nur der
      Handshake gelesen; unter <b>Bearbeiten</b> steht sie zur Übernahme bereit.</p></div>`;
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
            : '<span class="faint" title="Keiner Strecke zugeordnet — meist ein Endgerät. Bei einem Site-to-Site-Tunnel fehlt dagegen die Verknüpfung: unter Verwaltung → Tunnel als zweites Ende auswählen">—</span>'}</td>
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

/* Eine AdGuard-Kachel sagt zuerst, ob überhaupt gefiltert wird — ein
   abgeschalteter Schutz ist die Angabe, die ein offener Port nicht kennt.
   Ohne hinterlegten Zugang bleibt es bei dem, was gemessen wurde. */
/* Die DNS-Prüfung dieses Systems — die einzige, die den Dienst selbst
   misst und nicht seine Oberfläche. */
function dnsPruefung(h) {
  return (h.checks || []).find(c => c.kind === "dns") || null;
}

/* Antwortet er, und wie schnell? Ein offener Port sagt das nicht: gefragt
   wird über UDP/53 mit einer echten Auflösung. Bleibt die Antwort aus,
   steht hier der Befund im Klartext — er ist die wichtigste Zeile auf
   dieser Kachel. */
function dnsZelle(h) {
  const c = dnsPruefung(h);
  if (!c) return stat("DNS UDP/53", "—");
  if (c.skipped) return stat("DNS UDP/53", "übersprungen");
  return `<div class="stat"><span class="stat-k">DNS UDP/53</span>
    <span class="stat-v" style="color:var(--${c.ok ? "ok" : "crit"})" title="${esc(c.detail || "")}">
      ${c.ok ? esc(nz(c.ms, " ms")) : "keine Antwort"}</span></div>`;
}

function adguardCard(h) {
  const kennzahlen = h.dnsQueries != null || h.protection != null;
  const c = dnsPruefung(h);
  /* Auch ohne Zugangsdaten ist diese Zeile die Aussage der Kachel: der
     Rest hängt an einem Passwort, die Auflösung nicht. */
  const dnsZeile = c && !c.ok && !c.skipped
    ? `<div class="row" style="gap:7px;font-size:12px;color:var(--crit)">${dot("crit")}
        <span>Löst nicht auf: ${esc(c.detail || "keine Antwort über UDP/53")}</span></div>`
    : "";

  if (!kennzahlen) return serviceCard(h, `
    <div class="stat-row">
      ${dnsZelle(h)}
      ${stat("Antwort", nz(h.ms, " ms"))}
      ${stat("Zuletzt erreicht", fmtWhen(h.lastSeen) || "—")}
      <div class="spacer"></div>${histCell(h, { w: 80, value: false })}
    </div>
    ${dnsZeile}
    <div class="row" style="gap:8px;font-size:12px;color:var(--faint)">
      ${dot("idle")}<span>${h.collectorError ? esc(h.collectorError) : "Kennzahlen erst mit hinterlegtem Zugang"} — Verwaltung → ${esc(h.name)}</span></div>`);

  const schutz = h.protection === false ? `<span class="chip chip--warn">Schutz aus</span>`
    : h.protection === true ? `<span class="chip chip--ok">Schutz an</span>` : "";
  const filter = h.filtering === false ? `<span class="chip chip--warn">Filterung aus</span>` : "";
  const dns = h.dnsRunning === false ? `<span class="chip chip--crit">DNS steht</span>` : "";
  return serviceCard(h, `
    <div class="stat-row">
      ${stat(`Anfragen${h.statsFenster ? " / " + h.statsFenster : ""}`, nz(h.dnsQueries))}
      ${stat("Geblockt", h.blockRate != null ? h.blockRate + " %" : "—")}
      ${stat("Ø Bearbeitung", nz(h.avgMs, " ms"))}
      ${dnsZelle(h)}
      <div class="spacer"></div>${histCell(h, { w: 80, value: false })}
    </div>
    <div class="row row-wrap" style="gap:6px">
      ${dns}${schutz}${filter}
      ${h.filterRules ? `<span class="chip chip--plain">${esc(h.filtersAktiv ?? "?")} Listen · ${esc(String(h.filterRules))} Regeln</span>` : ""}
      ${h.upstreams ? `<span class="chip chip--plain">${esc(String(h.upstreams))} Upstream(s)</span>` : ""}
      ${h.version ? `<span class="chip chip--plain mono">${esc(h.version)}</span>` : ""}
    </div>
    ${dnsZeile}
    ${h.protection === false ? `<div class="row" style="gap:7px;font-size:12px;color:var(--warn)">${dot("warn")}
      <span>Schutz ist abgeschaltet — es wird gerade nichts gefiltert.</span></div>` : ""}
    ${h.filtering === false ? `<div class="row" style="gap:7px;font-size:12px;color:var(--warn)">${dot("warn")}
      <span>Filterung ist abgeschaltet — die Listen sind geladen, greifen aber nicht.</span></div>` : ""}`);
}

/* Eine Zeile je Portainer, und die zählt, was zählt: wie viele Umgebungen
   antworten und wie viele Container klemmen. */
function portainerRows(hosts) {
  return hosts.map(h => {
    const auffaellig = (h.unhealthy || 0) + (h.restarting || 0) + (h.oom || 0);
    const kennt = h.containers != null || h.endpoints != null;
    return `<tr data-sev="${h.status}" data-action="inspect" data-kind="host" data-id="${h.id}">
      <td class="sev">${dot(h.status)}</td>
      <td><div class="mono">${esc(h.name)}</div><div class="t-sub">${esc(h.version ? "Portainer " + h.version : h.role)}</div></td>
      <td>${chip("plain", siteShort(h.site))}</td>
      <td class="mono">${h.endpoints == null ? '<span class="faint">—</span>'
        : `${h.endpoints - (h.endpointsDown || 0)}/${h.endpoints}${h.endpointsDown ? ` <span style="color:var(--warn)">↓${h.endpointsDown}</span>` : ""}`}</td>
      <td class="mono">${nz(h.stacks)}</td>
      <td class="mono">${h.containers == null ? '<span class="faint">—</span>'
        : `${h.running}/${h.containers}`}</td>
      <td>${!kennt ? '<span class="faint">—</span>'
        : h.restarting == null && h.unhealthy == null ? '<span class="faint">nicht gelesen</span>'
        : auffaellig ? `<span class="chip chip--warn">${auffaellig}</span>` : '<span class="mono faint">0</span>'}</td>
      <td>${histCell(h)}</td>
    </tr>`;
  }).join("");
}

function viewDienste() {
  if (!state.hosts.length) return onboarding();
  const hs = visibleHosts();
  const ag = hs.filter(h => h.type === "adguard");
  const ha = hs.filter(h => h.type === "hass");
  const rest = hs.filter(h => !["adguard", "mailcow", "pmg", "hass", "pve", "pbs", "truenas", "portainer", "opnsense", "pfsense", "unifi"].includes(h.type));

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

  const ohneZugang = ag.filter(h => h.dnsQueries == null && h.protection == null);
  return `
  <div class="panel">
    <div class="panel-head"><h3>DNS-Filter</h3><span class="hint">AdGuard Home</span>
      <div class="spacer"></div><span class="hint">geprüft wird mit einer echten Auflösung, nicht nur am Port</span></div>
    <div class="panel-body"><div class="grid g3">${ag.length
      ? ag.map(adguardCard).join("")
      : '<div class="empty">Kein AdGuard in dieser Auswahl.</div>'}</div></div>
    ${ohneZugang.length ? `<div class="panel-note">Anfragen, Blockanteil und Bearbeitungszeit stehen unter
      <span class="mono">/control/stats</span> und brauchen Benutzer und Passwort —
      ${ohneZugang.map(h => `<b>Verwaltung → ${esc(h.name)}</b>`).join(", ")}.</div>` : ""}
  </div>

  <div class="panel">
    <div class="panel-head"><h3>Smart Home &amp; Übrige</h3><span class="hint">nur Erreichbarkeit</span></div>
    <div class="panel-body"><div class="col">${(ha.length || rest.length)
      ? einfach([...ha, ...rest], h => stat("Typ", TYPE_LABEL[h.type] || h.type))
      : '<div class="empty">Nichts in dieser Auswahl.</div>'}</div></div>
    ${hs.some(h => h.type === "pmg" || h.type === "mailcow")
      ? `<div class="panel-note">Die Mailsysteme stehen in einer eigenen Ansicht:
         <b><a href="#/mail">Mail</a></b> — mit Durchsatz, Warteschlange, Quarantäne, Postfächern und Signaturstand.</div>` : ""}
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
        <td style="min-width:180px">${c.bewertet === false
          ? `<span class="faint" title="Wird gemessen, aber nicht bewertet — siehe Hinweis unter der Tabelle">${
              c.days < 0 ? `seit ${Math.abs(c.days)} T abgelaufen` : c.days + " Tage"} · nicht bewertet</span>`
          : meter("", c.days < 0 ? 100 : Math.max(3, Math.min(100, Math.round(c.days / 90 * 100))),
          { text: c.days < 0 ? `seit ${Math.abs(c.days)} T abgelaufen` : c.days + " Tage",
            tone: c.days <= crit ? "crit" : c.days <= warn ? "warn" : "ok" })}</td>
      </tr>`).join("") : `<tr><td colspan="5"><div class="empty">Noch kein Zertifikat gelesen — es erscheint hier, sobald ein System eine <span class="mono">tls</span>-Prüfung hat und antwortet.</div></td></tr>`}
      </tbody></table>
    </div>
    <div class="panel-note">Der Leitstand liest nur ab, was der Server im Handshake vorzeigt. Erneuern kann und darf er
      nichts — jeder Zugang ist ein Konto ohne Schreibrechte.
      ${CERTS.some(c => c.bewertet === false) ? `<br><b>Nicht bewertet</b> heißt: gemessen und hier aufgeführt, aber
        ohne Ampel. Das betrifft eigensignierte Zertifikate — sie bezeugen keine Herkunft, und ihr Ablauf ändert für
        den Betrieb nichts: wer sie gestern angenommen hat, nimmt sie heute an. Umstellbar unter
        <b>Verwaltung → Schwellwerte</b> (<span class="mono">tls_selfsigned_ignore</span>), einzelne Systeme beim
        Bearbeiten.` : ""}</div>
  </div>`;
}

/* ============================================================
   Ansicht: Mail
   ============================================================ */
/* Was ein Mail Gateway von außen zeigt, ist ein offener Port auf 25 — und
   der sagt nichts. Ein Gateway, dessen Filterdienst steht, nimmt Mail
   weiter an und stellt sie ungeprüft zu. Eines, dessen Warteschlange
   volläuft, nimmt an und liefert nicht. Beides sieht von außen aus wie
   Betrieb, und beides steht hier.

   Die Zahlen kommen aus einem eigenen Takt (Einstellungen: pmg_takt,
   pmg_takt_lang), nicht aus jedem Durchlauf: die Tagesstatistik ändert
   sich in 15 Sekunden nicht, und die Warteschlange abzufragen startet je
   Abruf einen Prozess auf dem Gerät. Wie alt der Stand ist, steht dabei. */
function viewMail() {
  if (!state.hosts.length) return onboarding();
  const hs = visibleHosts();
  const pmg = hs.filter(h => h.type === "pmg");
  const cow = hs.filter(h => h.type === "mailcow");
  const ohneZugang = pmg.filter(h => h.in24 == null && h.queueDeferred == null);

  if (!pmg.length && !cow.length) return `<div class="panel">
    <div class="panel-head"><h3>Mail</h3></div>
    <div class="panel-body"><div class="empty">Kein Mailsystem in dieser Auswahl.</div></div>
    <div class="panel-note">Angebunden sind der <b>Proxmox Mail Gateway</b> (Durchsatz, Warteschlange, Quarantäne,
      Signaturstand, filternde Dienste) und <b>Mailcow</b> (Container, Warteschlange mit Grund, Postfächer und ihre
      Quote, Platz der Ablage, rspamd). Anlegen unter <b>Verwaltung → System hinzufügen</b>, Typ
      <span class="mono">pmg</span> oder <span class="mono">mailcow</span>.</div>
  </div>`;

  return `
  ${pmg.length ? `<div class="panel">
    <div class="panel-head"><h3>Mail Gateway</h3>
      <span class="hint">${pmg.length} Gerät${pmg.length === 1 ? "" : "e"}</span>
      <div class="spacer"></div>
      <span class="hint">gelesen mit einem Konto in der Rolle Auditor — geschrieben wird nichts</span></div>
    <div class="panel-body"><div class="grid g2">${pmg.map(gatewayKarte).join("")}</div></div>
    ${ohneZugang.length ? `<div class="panel-note">Ohne hinterlegten Zugang bleibt es bei Erreichbarkeit und
      Antwortzeit. <b>Der Mail Gateway kennt keine API-Token</b> — auch wenn seine API-Dokumentation sie an jedem
      Endpunkt ausweist, weist der Dienst sie ab. Angemeldet wird mit Benutzer und Passwort eines Kontos in der
      Rolle <span class="mono">Auditor</span> (mit Realm: <span class="mono">leitstand@pmg</span>), einzutragen unter
      ${ohneZugang.map(h => `<b>Verwaltung → ${esc(h.name)}</b>`).join(", ")}.</div>` : ""}
  </div>` : ""}

  ${cow.length ? `<div class="panel">
    <div class="panel-head"><h3>Mailcow</h3>
      <span class="hint">${cow.length} System${cow.length === 1 ? "" : "e"}</span>
      <div class="spacer"></div>
      <span class="hint">gelesen mit einem Schlüssel „Read-Only“ — geschrieben wird nichts</span></div>
    <div class="panel-body"><div class="grid g2">${cow.map(mailcowKarte).join("")}</div></div>
    ${cow.some(h => h.containerGesamt == null && h.queueDeferred == null) ? `<div class="panel-note">Ohne
      hinterlegten Schlüssel bleibt es bei Erreichbarkeit, Antwortzeit und Zertifikat. In mailcow unter
      <span class="mono">Configuration → Access → API</span> einen erzeugen — <b>Read-Only genügt</b> — und
      <b>die Adresse des Leitstands in „allow from“ eintragen</b>: fehlt sie, antwortet mailcow mit derselben 401
      wie bei einem falschen Schlüssel.</div>` : ""}
  </div>` : ""}

  ${verkehrPanel(pmg)}
  ${filterPanel(cow)}
  ${queuePanel(pmg, cow)}

  <div class="grid g2">
    ${quarantaenePanel(pmg, cow)}
    ${signaturPanel(pmg)}
  </div>

  ${domainPanel(pmg)}
  ${postfachPanel(cow)}
  ${dienstePanel(pmg)}
  ${containerPanel(cow)}`;
}

/* Ein Gerät: Ampel, worauf es läuft, was gerade durchgeht und was hängt. */
function gatewayKarte(h) {
  const s = h.schwellen || {};
  const q = h.queueGrenzen || {};
  const kennt = h.in24 != null || h.queueDeferred != null;
  return `<div class="card" data-action="inspect" data-kind="host" data-id="${esc(h.id)}">
    <div class="card-head">
      <span style="padding-top:4px">${dot(h.status)}</span>
      <div>
        <div class="card-title mono">${esc(h.name)}</div>
        <div class="card-meta">${esc(siteName(h.site))}${h.node ? ` · Knoten ${esc(h.node)}` : ""}</div>
      </div>
      <div class="spacer"></div>
      <div class="right">
        <div class="card-meta mono">${h.version ? "PMG " + esc(h.version) : "—"}</div>
        <div class="card-meta">${nz(h.uptime)} Laufzeit</div>
      </div>
    </div>

    ${h.cpu != null || h.ram != null || h.disk != null ? `<div class="col" style="gap:7px">
      ${meter("CPU", h.cpu, { warn: 80, crit: 95 })}
      ${meter("RAM", h.ram, { warn: s.ram_warn, crit: s.ram_crit })}
      ${meter("Wurzeldateisystem", h.disk, { warn: s.disk_warn, crit: s.disk_crit,
        text: h.disk != null ? `${h.disk} %${h.diskFreiGb != null ? ` · ${h.diskFreiGb} GB frei` : ""}` : "—" })}
    </div>` : `<div class="row" style="gap:8px;font-size:12px;color:var(--faint)">
      ${dot("idle")}<span>${h.collectorError ? esc(h.collectorError) : "Kennzahlen erst mit hinterlegtem Zugang"} — Verwaltung → ${esc(h.name)}</span></div>`}

    <div class="stat-row">
      ${stat("Eingang 24 h", nz(h.in24))}
      ${stat("Ausgang 24 h", nz(h.out24))}
      ${queueZelle(h, q)}
      ${stat("Antwort", nz(h.ms, " ms"))}
      <div class="spacer"></div>${histCell(h, { value: false })}
    </div>

    <div class="row row-wrap" style="gap:6px">
      ${!kennt ? "" : h.diensteSteht?.length
        ? `<span class="chip chip--crit">${esc(h.diensteSteht.join(", "))} steht</span>`
        : h.dienste ? `<span class="chip chip--ok">Filter, Postfix und Scanner laufen</span>` : ""}
      ${h.signaturAlter == null ? "" : h.signaturAlter >= 24
        ? `<span class="chip chip--warn">Signaturen ${h.signaturAlter} h alt</span>`
        : `<span class="chip chip--plain">Signaturen ${h.signaturAlter} h alt</span>`}
      ${h.insync === false ? `<span class="chip chip--warn">nicht abgeglichen</span>` : ""}
      ${h.updates == null ? "" : h.updates
        ? `<span class="chip chip--info">${h.updates} Update(s) offen</span>`
        : `<span class="chip chip--ok">Pakete aktuell</span>`}
      ${h.kernel ? `<span class="chip chip--plain mono" title="Kernel">${esc(h.kernel)}</span>` : ""}
    </div>
    ${h.note ? `<div class="row" style="gap:7px;font-size:12px;color:var(--${h.status})">${dot(h.status)}<span>${esc(h.note)}</span></div>` : ""}
  </div>`;
}

/* Zurückgestellte Mail ist die eine Zahl, die man auf der Karte sehen
   will — mit ihrer Grenze daneben, damit man sie ohne Nachschlagen
   einordnen kann. */
function queueZelle(h, q) {
  if (h.queueDeferred == null) return stat("Warteschlange", "—");
  const ton = q.crit != null && h.queueDeferred >= q.crit ? "crit"
    : (q.warn != null && h.queueDeferred >= q.warn) || h.queueAlt > 0 ? "warn" : "ok";
  return `<div class="stat"><span class="stat-k">Zurückgestellt</span>
    <span class="stat-v" style="color:var(--${ton})">${h.queueDeferred}${h.queueAlt ? ` · ${h.queueAlt} alt` : ""}</span></div>`;
}

/* ---------- Verkehr ----------
   Zwei Reihen, weil es zwei verschiedene Dinge sind: was angenommen und
   gefiltert wurde, und was es gar nicht erst über die Türschwelle
   geschafft hat. Beides in einer Summe zu zeigen ergäbe eine Spamquote,
   die niemand nachrechnen kann. */
function verkehrPanel(pmg) {
  const mit = pmg.filter(h => h.in24 != null);
  if (!mit.length) return "";
  return `<div class="panel">
    <div class="panel-head"><h3>Verkehr</h3><span class="hint">letzte 24 Stunden</span>
      <div class="spacer"></div>
      <span class="hint">${mit[0].statStand ? "Stand " + esc(fmtWhen(mit[0].statStand)) : ""}</span></div>
    <div class="panel-body col" style="gap:16px">${mit.map(h => `
      <div class="col" style="gap:8px">
        ${pmg.length > 1 ? `<div class="sec-title">${esc(h.name)}</div>` : ""}
        <div class="stat-row">
          ${stat("Eingehend", nz(h.in24))}
          ${stat("Ausgehend", nz(h.out24))}
          ${stat("Spam", h.spam == null ? "—" : `${h.spam}${h.spamAnteil != null ? ` · ${h.spamAnteil} %` : ""}`)}
          ${stat("Viren eingehend", nz(h.virus))}
          ${stat("Viren ausgehend", nz(h.virusAus))}
          ${stat("Ø Bearbeitung", nz(h.avgMs, " ms"))}
        </div>
        <div class="stat-row">
          ${stat("Abgewiesen", nz(h.abgewiesen))}
          ${stat("davon RBL", nz(h.rbl))}
          ${stat("Pregreet", nz(h.pregreet))}
          ${stat("Greylist", nz(h.greylist))}
          ${stat("SPF", nz(h.spf))}
          ${stat("Menge ein / aus", h.bytesEin == null ? "—" : `${menge(h.bytesEin)} / ${menge(h.bytesAus)}`)}
        </div>
      </div>`).join("")}
    </div>
    <div class="panel-note"><b>Ein eingehender Virenfund ist keine Störung</b>, sondern der Zweck des Geräts — die
      Zahl steht hier, aber sie färbt keine Ampel. Eine Ampel, die bei jedem abgewehrten Anhang leuchtet, hat man
      nach zwei Wochen abtrainiert, und mit ihr die Ampel für alles andere. <b>Ausgehende Virenfunde sind rot</b>:
      sie heißen, dass ein Gerät im eigenen Netz Schadsoftware verschickt.
      <br>„Abgewiesen" zählt, was postscreen und die Regeln vor der Annahme abgelehnt haben (RBL, Pregreet, SPF,
      Greylisting). Diese Mail ist nie eingegangen und steckt deshalb <em>nicht</em> in „Eingehend" — die Spamquote
      bezieht sich auf das, was tatsächlich angenommen wurde.</div>
  </div>`;
}

/* ---------- Warteschlange ----------
   Die Frage, für die man nachts aufsteht: hängt Mail? Und seit wann.

   Eine Tabelle für beide Systeme, weil es dieselbe Frage ist. Postfix
   führt hier wie dort dieselben Warteschlangen; nur die Herkunft der
   Zahlen unterscheidet sich — der Mail Gateway liefert eine
   Altersverteilung, Mailcow die einzelnen Nachrichten mit Ankunftszeit
   **und Grund**. Deshalb steht der Grund als eigene Zeile darunter und
   nicht in der Tabelle: er gibt es nur auf einer Seite. */
function queuePanel(pmg, cow = []) {
  const mit = [...pmg, ...cow].filter(h => h.warteschlange);
  if (!mit.length) return "";
  const zeilen = mit.flatMap(h => (h.warteschlange || []).map(q => ({ ...q, wirt: h.name, wirtId: h.id, grenzen: h.queueGrenzen || {} })));
  const q0 = mit[0].queueGrenzen || {};
  const gruende = cow.flatMap(h => (h.queueGruende || []).map(g => ({ ...g, wirt: h.name })));
  return `<div class="panel">
    <div class="panel-head"><h3>Warteschlange</h3><span class="hint">was angenommen, aber noch nicht zugestellt ist</span>
      <div class="spacer"></div>
      <span class="hint">zurückgestellt: gelb ab ${nz(q0.warn)}, rot ab ${nz(q0.crit)}</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        <th style="width:34px"></th>${mit.length > 1 ? "<th>System</th>" : ""}
        <th>Warteschlange</th><th>Mail</th><th>davon über 10 h</th><th>Ältestes</th><th>Wohin</th>
      </tr></thead><tbody>
      ${zeilen.map(z => {
        const ampel = z.queue !== "deferred" ? (z.anzahl ? "info" : "ok")
          : z.anzahl == null ? "idle"
          : z.anzahl >= (z.grenzen.crit ?? 1e9) ? "crit"
          : z.anzahl >= (z.grenzen.warn ?? 1e9) || z.aelter > 0 ? "warn" : "ok";
        return `<tr data-sev="${ampel}" data-action="inspect" data-kind="host" data-id="${esc(z.wirtId)}">
          <td class="sev">${dot(ampel)}</td>
          ${mit.length > 1 ? `<td class="mono faint">${esc(z.wirt)}</td>` : ""}
          <td><div class="mono">${esc(z.queue)}</div><div class="t-sub">${esc(z.label)}</div></td>
          <td class="mono">${z.anzahl == null ? `<span class="faint">${esc(z.note || "—")}</span>` : z.anzahl}</td>
          <td class="mono">${z.aelter == null ? '<span class="faint">—</span>'
            : z.aelter ? `<span style="color:var(--warn)">${z.aelter}</span>` : "0"}</td>
          <td class="mono faint">${z.aeltestes ? esc(dauerKurz(z.aeltestes)) : "—"}</td>
          <td class="faint">${(z.domains || []).length
            ? esc(z.domains.slice(0, 3).map(d => `${d.domain} (${d.anzahl})`).join(", "))
            : "—"}</td>
        </tr>`;
      }).join("")}
      </tbody></table>
    </div>
    ${gruende.length ? `<div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>${cow.length > 1 ? "<th>System</th>" : ""}<th>Warum es liegt</th><th class="right">Mail</th></tr></thead><tbody>
      ${gruende.map(g => `<tr data-sev="warn">
        ${cow.length > 1 ? `<td class="mono faint">${esc(g.wirt)}</td>` : ""}
        <td>${esc(g.grund)}</td><td class="right mono">${g.anzahl}</td></tr>`).join("")}
      </tbody></table></div>` : ""}
    <div class="panel-note">Zwanzig Mail in der Zustellung sind Betrieb — zwanzig Mail, die seit gestern liegen,
      sind ein Empfänger, der nicht mehr antwortet. Deshalb steht das Alter neben der Menge und schlägt auch dann
      an, wenn die Menge unter der Grenze bleibt. <b>hold</b> ist keine Störung, sondern eine Entscheidung: dort
      liegt, was eine Regel angehalten hat und worüber jemand entscheiden muss.
      <br>Eine leere Warteschlange ist gemessen und nicht unbekannt — im Unterschied zu einem Abruf, der nicht
      durchkam; der steht als Grund in der Spalte „Mail".
      ${gruende.length ? `<br>Den <b>Grund</b> liefert nur Mailcow: Postfix schreibt ihn je Empfänger in die
        Warteschlange (<span class="mono">Connection timed out</span>, <span class="mono">mailbox full</span>, …).
        Der Mail Gateway gibt an dieser Stelle nur Zahlen heraus, keine Begründung.` : ""}</div>
  </div>`;
}

/* ---------- Quarantäne ----------
   Beide Systeme halten Post zurück, und beide zählen anders: der Mail
   Gateway trennt Spam und Viren und kennt den belegten Platz, Mailcow
   führt eine Liste und weiß, welche davon einen Virenfund trägt.
   Gemeinsam ist die einzige Zahl, die hierher gehört — wie viel liegt
   da. **Gelesen wird nichts davon**: Betreff, Absender und Empfänger
   bleiben auf dem Mailserver. */
function quarantaenePanel(pmg, cow = []) {
  const mitPmg = pmg.filter(h => h.quarSpam != null || h.quarVirus != null);
  const mitCow = cow.filter(h => h.quarantaene != null);
  if (!mitPmg.length && !mitCow.length) return "";
  const mehrere = mitPmg.length + mitCow.length > 1;
  const zelle = h => (mehrere ? `<td class="mono faint">${esc(h.name)}</td>` : "");
  return `<div class="panel">
    <div class="panel-head"><h3>Quarantäne</h3><span class="hint">was einbehalten wurde</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        ${mehrere ? "<th>System</th>" : ""}<th>Art</th><th>Mail</th><th>Platz</th><th>Ø Spam-Wert</th>
      </tr></thead><tbody>
      ${mitPmg.flatMap(h => [
        `<tr data-sev="info">${zelle(h)}
          <td>Spam</td><td class="mono">${nz(h.quarSpam)}</td>
          <td class="mono faint">${nz(h.quarSpamMb, " MB")}</td>
          <td class="mono faint">${nz(h.quarSpamSchnitt)}</td></tr>`,
        `<tr data-sev="info">${zelle(h)}
          <td>Viren</td><td class="mono">${nz(h.quarVirus)}</td>
          <td class="mono faint">${nz(h.quarVirusMb, " MB")}</td>
          <td class="faint">—</td></tr>`
      ]).join("")}
      ${mitCow.map(h => `<tr data-sev="info">${zelle(h)}
          <td>Zurückgehalten${h.quarantaeneViren ? ` <span class="chip chip--plain">${h.quarantaeneViren} mit Virenfund</span>` : ""}</td>
          <td class="mono">${h.quarantaene}</td>
          <td class="faint">—</td>
          <td class="faint">${h.quarantaeneNeuste ? `neuste ${esc(fmtWhen(h.quarantaeneNeuste))}` : "—"}</td></tr>`).join("")}
      </tbody></table>
    </div>
    <div class="panel-note">Der Leitstand liest nur den Umfang, nicht die Nachrichten. Freigeben, löschen und
      durchsuchen bleibt der Oberfläche des jeweiligen Systems vorbehalten — jeder Zugang hier ist ein Konto ohne
      Schreibrechte. Betreffzeilen, Absender und Empfänger verlassen den Sammler nicht: was hier nicht ankommt,
      kann auch in keiner Zeitreihe und in keiner Meldung landen.
      ${mitCow.length ? `<br>Für Mailcow gibt es keinen Endpunkt, der nur zählt — die Liste wird abgerufen und
        davon die Zahl behalten. Das ist der teuerste Aufruf dieser Anbindung und läuft deshalb im langsamen
        Takt.` : ""}</div>
  </div>`;
}

/* ---------- Signaturen ----------
   Der stillste aller Ausfälle. */
function signaturPanel(pmg) {
  const mit = pmg.filter(h => h.signaturen?.length);
  if (!mit.length) return "";
  return `<div class="panel">
    <div class="panel-head"><h3>Virensignaturen</h3><span class="hint">ClamAV-Datenbanken</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        ${mit.length > 1 ? "<th>Gateway</th>" : ""}<th>Datenbank</th><th>Fassung</th><th>Signaturen</th><th>Stand</th>
      </tr></thead><tbody>
      ${mit.flatMap(h => h.signaturen.map(x => {
        const alt = x.name === "daily" && x.alterStunden != null && x.alterStunden >= 24;
        return `<tr data-sev="${alt ? "warn" : "ok"}">
          ${mit.length > 1 ? `<td class="mono faint">${esc(h.name)}</td>` : ""}
          <td class="mono">${esc(x.name)}</td>
          <td class="mono faint">${nz(x.version)}</td>
          <td class="mono">${x.anzahl == null ? "—" : x.anzahl.toLocaleString("de-DE")}</td>
          <td>${x.stand ? `${esc(fmtWhen(x.stand))}${x.alterStunden != null
            ? ` <span class="${alt ? "" : "faint"}" ${alt ? 'style="color:var(--warn)"' : ""}>(${esc(alterKurz(x.alterStunden))})</span>` : ""}`
            : '<span class="faint">—</span>'}</td>
        </tr>`;
      })).join("")}
      </tbody></table>
    </div>
    <div class="panel-note">Bewertet wird <span class="mono">daily</span>: sie kommt mehrmals täglich neu, und wenn
      sie stehen bleibt, kommt freshclam nicht mehr durch — der Scanner läuft dann weiter und prüft gegen den Stand
      von vorgestern, ohne dass jemand etwas merkt. <span class="mono">main</span> ist von Haus aus Monate alt; das
      ist kein Mangel und wird nicht bewertet.</div>
  </div>`;
}

function alterKurz(std) {
  if (std == null || !Number.isFinite(std)) return "—";
  if (std < 72) return `${std} h`;
  const t = Math.round(std / 24);
  return t < 60 ? `${t} T` : `${Math.round(t / 30.4)} Monate`;
}

/* ---------- Domänen und Virenfunde ---------- */
function domainPanel(pmg) {
  const domains = pmg.flatMap(h => (h.domains || []).map(d => ({ ...d, wirt: h.name })));
  const viren = pmg.flatMap(h => (h.viren || []).map(v => ({ ...v, wirt: h.name })));
  if (!domains.length && !viren.length) return "";
  const mehrere = pmg.filter(h => h.domains || h.viren).length > 1;
  return `<div class="grid g2">
    ${domains.length ? `<div class="panel">
      <div class="panel-head"><h3>Domänen</h3><span class="hint">Verkehr der letzten 24 Stunden</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr>
          ${mehrere ? "<th>Gateway</th>" : ""}<th>Domäne</th><th>ein</th><th>aus</th><th>Spam</th><th>Viren</th><th class="right">Menge</th>
        </tr></thead><tbody>
        ${domains.map(d => `<tr data-sev="${d.virus ? "info" : "ok"}">
          ${mehrere ? `<td class="mono faint">${esc(d.wirt)}</td>` : ""}
          <td class="mono">${esc(d.domain)}</td>
          <td class="mono">${nz(d.ein)}</td>
          <td class="mono">${nz(d.aus)}</td>
          <td class="mono faint">${nz(d.spam)}</td>
          <td class="mono faint">${nz(d.virus)}</td>
          <td class="right mono faint">${d.bytesEin == null ? "—" : menge(d.bytesEin + (d.bytesAus || 0))}</td>
        </tr>`).join("")}
        </tbody></table>
      </div>
    </div>` : ""}

    ${viren.length ? `<div class="panel">
      <div class="panel-head"><h3>Virenfunde</h3><span class="hint">letzte 24 Stunden</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr>
          ${mehrere ? "<th>Gateway</th>" : ""}<th>Name</th><th class="right">Funde</th>
        </tr></thead><tbody>
        ${viren.map(v => `<tr data-sev="info">
          ${mehrere ? `<td class="mono faint">${esc(v.wirt)}</td>` : ""}
          <td class="mono">${esc(v.name)}</td>
          <td class="right mono">${v.anzahl}</td>
        </tr>`).join("")}
        </tbody></table>
      </div>
      <div class="panel-note">Abgewehrt, nicht zugestellt — diese Liste ist ein Nachweis, keine Meldung.</div>
    </div>` : ""}
  </div>`;
}

/* ---------- Dienste ----------
   Der Unterschied zwischen „läuft nicht" und „ist fertig": ein Zeitgeber
   steht die meiste Zeit auf „exited" und ist völlig in Ordnung. Wer
   darauf eine Ampel setzt, meldet jede Nacht einen Ausfall. */
function dienstePanel(pmg) {
  const mit = pmg.filter(h => h.dienste?.length);
  const ohne = pmg.filter(h => !h.dienste?.length && h.diensteNote);
  if (!mit.length) {
    /* Keine Liste ist etwas anderes als eine Liste ohne Auffälligkeiten.
       Wer das verschweigt, zeigt ein Gateway, dessen Dienste angeblich
       alle laufen — dabei hat niemand nachgesehen. */
    return ohne.length ? `<div class="panel">
      <div class="panel-head"><h3>Dienste</h3><span class="hint">nicht gelesen</span></div>
      <div class="panel-body"><div class="empty">${ohne.map(h => `${esc(h.name)}: ${esc(h.diensteNote)}`).join(" · ")}</div></div>
      <div class="panel-note">Ohne diese Liste ist unbekannt, ob Postfix, der Filter und der Scanner laufen —
        das ist keine Entwarnung. Die Rolle <span class="mono">Auditor</span> darf sie lesen.</div>
    </div>` : "";
  }
  return `<div class="panel">
    <div class="panel-head"><h3>Dienste</h3><span class="hint">was auf dem Gateway filtert und zustellt</span>
      <div class="spacer"></div>
      ${mit.some(h => h.diensteSteht?.length)
        ? `<span class="chip chip--crit">${mit.flatMap(h => h.diensteSteht || []).length} Kerndienst(e) stehen</span>`
        : `<span class="chip chip--ok">alle Kerndienste laufen</span>`}</div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        <th style="width:34px"></th>${mit.length > 1 ? "<th>Gateway</th>" : ""}
        <th>Dienst</th><th>Aufgabe</th><th>Zustand</th>
      </tr></thead><tbody>
      ${mit.flatMap(h => h.dienste.map(d => {
        const ampel = d.kern ? (d.zustand === "running" ? "ok" : "crit")
          : d.aktiv === "failed" ? "warn" : "idle";
        return `<tr data-sev="${ampel}">
          <td class="sev">${dot(ampel)}</td>
          ${mit.length > 1 ? `<td class="mono faint">${esc(h.name)}</td>` : ""}
          <td class="mono">${esc(d.name)}${d.kern ? ' <span class="chip chip--plain">Kern</span>' : ""}</td>
          <td class="faint">${esc(d.beschreibung || "—")}</td>
          <td class="mono ${ampel === "ok" ? "" : "faint"}">${esc(d.zustand || "—")}${
            d.aktiv && d.aktiv !== "active" ? ` <span class="faint">· ${esc(d.aktiv)}</span>` : ""}</td>
        </tr>`;
      })).join("")}
      </tbody></table>
    </div>
    <div class="panel-note">Rot sind nur die <b>Kerndienste</b>: Postfix, der Filter, die Datenbank, der Scanner
      und die beiden API-Dienste. Steht einer davon, wird Mail entweder nicht angenommen oder ungeprüft
      zugestellt — von außen sieht beides aus wie Betrieb. Zeitgeber und Wartungsläufe stehen mit
      <span class="mono">exited</span> da und sind dabei in Ordnung; sie fallen erst auf, wenn systemd sie als
      <span class="mono">failed</span> führt.</div>
  </div>`;
}

/* ---------- Mailcow ---------- */
/* Ein Mailcow: Ampel, worauf es läuft, was hängt und wie viel Platz
   noch da ist. Die Ablage der Postfächer ist hier die Zahl, die zählt —
   läuft sie voll, nimmt Dovecot nichts mehr an, und der Dienst
   antwortet dabei tadellos weiter. */
function mailcowKarte(h) {
  const s = h.schwellen || {};
  const q = h.queueGrenzen || {};
  const kennt = h.containerGesamt != null || h.queueDeferred != null;
  return `<div class="card" data-action="inspect" data-kind="host" data-id="${esc(h.id)}">
    <div class="card-head">
      <span style="padding-top:4px">${dot(h.status)}</span>
      <div>
        <div class="card-title mono">${esc(h.name)}</div>
        <div class="card-meta">${esc(siteName(h.site))}${h.domainsGesamt != null
          ? ` · ${h.domainsGesamt} Domäne(n), ${nz(h.postfaecher)} Postfächer` : ""}</div>
      </div>
      <div class="spacer"></div>
      <div class="right">
        <div class="card-meta mono">${h.version ? "mailcow " + esc(h.version) : "—"}</div>
        <div class="card-meta">${nz(h.uptime)} Laufzeit</div>
      </div>
    </div>

    ${kennt ? `<div class="col" style="gap:7px">
      ${meter("CPU", h.cpu, { warn: 80, crit: 95 })}
      ${meter("RAM", h.ram, { warn: s.ram_warn, crit: s.ram_crit })}
      ${meter("Postfachablage", h.vmailPct, { warn: s.disk_warn, crit: s.disk_crit,
        text: h.vmailPct != null ? `${h.vmailPct} %${h.vmailBelegt ? ` · ${esc(h.vmailBelegt)} von ${esc(h.vmailGesamt || "?")}` : ""}` : "—" })}
    </div>` : `<div class="row" style="gap:8px;font-size:12px;color:var(--faint)">
      ${dot("idle")}<span>${h.collectorError ? esc(h.collectorError) : "Kennzahlen erst mit hinterlegtem API-Schlüssel"} — Verwaltung → ${esc(h.name)}</span></div>`}

    <div class="stat-row">
      ${stat("Nachrichten", h.nachrichten != null ? h.nachrichten.toLocaleString("de-DE") : "—")}
      ${queueZelle(h, q)}
      ${stat("Quarantäne", nz(h.quarantaene))}
      ${stat("Antwort", nz(h.ms, " ms"))}
      <div class="spacer"></div>${histCell(h, { value: false })}
    </div>

    <div class="row row-wrap" style="gap:6px">
      ${h.containerGesamt == null ? "" : h.kernSteht?.length
        ? `<span class="chip chip--crit">${esc(h.kernSteht.join(", "))} steht</span>`
        : h.nebenSteht?.length
          ? `<span class="chip chip--warn">${esc(h.nebenSteht.join(", "))} steht</span>`
          : `<span class="chip chip--ok">${h.containerLaufen} von ${h.containerGesamt} Containern laufen</span>`}
      ${h.rspamdVersion ? `<span class="chip chip--plain mono" title="rspamd">rspamd ${esc(h.rspamdVersion)}</span>` : ""}
      ${h.gesperrt ? `<span class="chip chip--info">${h.gesperrt} Adresse(n) gesperrt</span>` : ""}
      ${h.mailboxVollste?.prozent != null && h.mailboxVollste.prozent >= 90
        ? `<span class="chip chip--warn">${esc(h.mailboxVollste.name)} zu ${h.mailboxVollste.prozent} % voll</span>` : ""}
    </div>
    ${h.note ? `<div class="row" style="gap:7px;font-size:12px;color:var(--${h.status})">${dot(h.status)}<span>${esc(h.note)}</span></div>` : ""}
  </div>`;
}

/* ---------- Filter ----------
   Die Zahlen von rspamd zählen seit dessen eigenem Start, nicht seit
   Mitternacht. Sie ohne diesen Zeitraum zu zeigen wäre eine stille
   Falschaussage — nach einem Neustart des Containers stünde dort eine
   beruhigende Null. Deshalb steht die Laufzeit in der Kopfzeile. */
function filterPanel(cow) {
  const mit = cow.filter(h => h.geprueft != null);
  if (!mit.length) return "";
  return `<div class="panel">
    <div class="panel-head"><h3>Filter</h3><span class="hint">rspamd</span>
      <div class="spacer"></div>
      <span class="hint">gezählt seit dem Start von rspamd${mit[0].rspamdSeit
        ? ` — das sind ${esc(dauerKurz(mit[0].rspamdSeit))}` : ""}</span></div>
    <div class="panel-body col" style="gap:16px">${mit.map(h => `
      <div class="col" style="gap:8px">
        ${mit.length > 1 ? `<div class="sec-title">${esc(h.name)}</div>` : ""}
        <div class="stat-row">
          ${stat("Geprüft", h.geprueft.toLocaleString("de-DE"))}
          ${stat("Spam", h.spam == null ? "—" : `${h.spam.toLocaleString("de-DE")}${h.spamAnteil != null ? ` · ${h.spamAnteil} %` : ""}`)}
          ${stat("Ham", h.ham != null ? h.ham.toLocaleString("de-DE") : "—")}
          ${stat("Abgewiesen", h.abgewiesen != null ? h.abgewiesen.toLocaleString("de-DE") : "—")}
          ${stat("Greylist", h.greylist != null ? h.greylist.toLocaleString("de-DE") : "—")}
          ${stat("Gelernt", h.gelernt != null ? h.gelernt.toLocaleString("de-DE") : "—")}
        </div>
        ${(h.aktionen || []).length ? `<div class="row row-wrap" style="gap:6px">
          ${h.aktionen.map(a => `<span class="chip chip--plain">${esc(a.name)}: ${a.anzahl.toLocaleString("de-DE")}</span>`).join("")}
        </div>` : ""}
      </div>`).join("")}
    </div>
    <div class="panel-note">Diese Zähler laufen seit dem Start von rspamd und werden bei einem Neustart des
      Containers zurückgesetzt — eine plötzlich kleine Zahl heißt deshalb nicht „ruhiger Tag", sondern
      „neu gestartet". Der Zeitraum steht oben; ohne ihn wäre die Spamquote eine Behauptung.</div>
  </div>`;
}

/* ---------- Domänen und Postfächer ---------- */
function postfachPanel(cow) {
  const mehrere = cow.filter(h => h.domains || h.mailboxen).length > 1;
  const domains = cow.flatMap(h => (h.domains || []).map(d => ({ ...d, wirt: h.name })));
  const boxen = cow.flatMap(h => (h.mailboxen || []).map(m => ({ ...m, wirt: h.name, grenze: 95 })));
  if (!domains.length && !boxen.length) return "";
  const ohneQuote = cow.reduce((a, h) => a + (h.mailboxenOhneQuote || 0), 0);

  return `<div class="grid g2">
    ${domains.length ? `<div class="panel">
      <div class="panel-head"><h3>Domänen</h3><span class="hint">Postfächer und Belegung</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr>
          ${mehrere ? "<th>System</th>" : ""}<th>Domäne</th><th>Postfächer</th><th>Nachrichten</th><th class="right">Belegt</th>
        </tr></thead><tbody>
        ${domains.map(d => `<tr data-sev="${d.aktiv === false ? "idle" : "ok"}">
          ${mehrere ? `<td class="mono faint">${esc(d.wirt)}</td>` : ""}
          <td class="mono">${esc(d.domain)}${d.backupmx ? ' <span class="chip chip--plain">Relay</span>' : ""}${
            d.aktiv === false ? ' <span class="chip chip--plain">inaktiv</span>' : ""}</td>
          <td class="mono">${d.postfaecher == null ? "—" : `${d.postfaecher}${d.postfaecherMax ? ` von ${d.postfaecherMax}` : ""}`}</td>
          <td class="mono faint">${d.nachrichten != null ? d.nachrichten.toLocaleString("de-DE") : "—"}</td>
          <td class="right mono">${d.belegt != null ? menge(d.belegt) : "—"}${d.quote
            ? ` <span class="faint">von ${menge(d.quote)}</span>` : ""}</td>
        </tr>`).join("")}
        </tbody></table>
      </div>
    </div>` : ""}

    ${boxen.length ? `<div class="panel">
      <div class="panel-head"><h3>Postfächer</h3><span class="hint">die vollsten zuerst</span></div>
      <div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr>
          ${mehrere ? "<th>System</th>" : ""}<th>Postfach</th><th>Belegung</th><th>Nachrichten</th><th>Zuletzt abgeholt</th>
        </tr></thead><tbody>
        ${boxen.map(m => `<tr data-sev="${m.prozent >= m.grenze ? "warn" : "ok"}">
          ${mehrere ? `<td class="mono faint">${esc(m.wirt)}</td>` : ""}
          <td class="mono">${esc(m.name)}</td>
          <td style="min-width:130px">${meter("", m.prozent, { text: `${m.prozent} %`, warn: 85, crit: m.grenze })}</td>
          <td class="mono faint">${m.nachrichten != null ? m.nachrichten.toLocaleString("de-DE") : "—"}</td>
          <td class="faint">${m.letzterImap ? esc(fmtWhen(m.letzterImap)) : "—"}</td>
        </tr>`).join("")}
        </tbody></table>
      </div>
      <div class="panel-note">Ein volles Postfach weist Mail ab, während der Dienst tadellos läuft — gemeldet wird
        das von niemandem sonst. Warnung ab ${esc(String(state.settings?.mailbox_voll_warn ?? 95))} %.
        ${ohneQuote ? `<br>${ohneQuote} Postfach/Postfächer haben keine Quote und stehen deshalb nicht in dieser
          Liste: dort gibt es keine Belegung in Prozent, sondern nur den belegten Platz — „0 %" wäre eine
          erfundene Zahl.` : ""}</div>
    </div>` : ""}
  </div>`;
}

/* ---------- Container ---------- */
function containerPanel(cow) {
  const mit = cow.filter(h => h.containerListe?.length);
  const ohne = cow.filter(h => !h.containerListe?.length && h.containerNote);
  if (!mit.length) {
    return ohne.length ? `<div class="panel">
      <div class="panel-head"><h3>Container</h3><span class="hint">nicht gelesen</span></div>
      <div class="panel-body"><div class="empty">${ohne.map(h => `${esc(h.name)}: ${esc(h.containerNote)}`).join(" · ")}</div></div>
      <div class="panel-note">Ohne diese Liste ist unbekannt, ob Postfix, Dovecot und die Datenbank laufen — das ist
        keine Entwarnung.</div>
    </div>` : "";
  }
  return `<div class="panel">
    <div class="panel-head"><h3>Container</h3><span class="hint">was Mail annimmt, prüft und ablegt</span>
      <div class="spacer"></div>
      ${mit.some(h => h.kernSteht?.length)
        ? `<span class="chip chip--crit">${mit.flatMap(h => h.kernSteht || []).length} Kern-Container stehen</span>`
        : `<span class="chip chip--ok">alle Kern-Container laufen</span>`}</div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr>
        <th style="width:34px"></th>${mit.length > 1 ? "<th>System</th>" : ""}
        <th>Container</th><th>Abbild</th><th>Zustand</th><th class="right">Läuft seit</th>
      </tr></thead><tbody>
      ${mit.flatMap(h => h.containerListe.map(c => {
        const ampel = c.zustand === "running" ? "ok" : c.kern ? "crit" : "warn";
        return `<tr data-sev="${ampel}">
          <td class="sev">${dot(ampel)}</td>
          ${mit.length > 1 ? `<td class="mono faint">${esc(h.name)}</td>` : ""}
          <td class="mono">${esc(c.name)}${c.kern ? ' <span class="chip chip--plain">Kern</span>' : ""}</td>
          <td class="mono faint">${esc(c.image || "—")}</td>
          <td class="mono ${ampel === "ok" ? "" : "faint"}">${esc(c.zustand || "—")}</td>
          <td class="right faint">${c.seit && c.zustand === "running" ? esc(fmtWhen(c.seit)) : "—"}</td>
        </tr>`;
      })).join("")}
      </tbody></table>
    </div>
    <div class="panel-note">Rot sind die <b>Kern-Container</b>: Postfix, Dovecot, die Datenbank, nginx, PHP-FPM,
      rspamd, Redis — und <span class="mono">unbound</span>, das nach Namensauflösung klingt und keine ist: fällt es
      aus, findet Postfix keine Gegenstelle mehr und ausgehende Mail bleibt liegen. Alles andere darf abgeschaltet
      sein (ClamAV, Solr, SOGo) und wird deshalb nur gelb — <b>aber mit Namen</b>: ein stiller Ausfall ist keiner,
      den man selbst gewählt hat.</div>
  </div>`;
}

function dauerKurz(sek) {
  if (sek == null || !Number.isFinite(sek)) return "—";
  if (sek >= 86400) return `${Math.floor(sek / 86400)} T ${Math.floor((sek % 86400) / 3600)} h`;
  if (sek >= 3600) return `${Math.floor(sek / 3600)} h`;
  return `${Math.floor(sek / 60)} min`;
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
      if (state.onlyProblems && !isProblem(kachelAmpel(l, h))) return false;
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
        const st = kachelAmpel(l, h);
        return `<a class="link" href="${esc(l.u)}" target="_blank" rel="noopener" title="${esc(kachelTitel(l, h))}">
          <span class="link-mark" style="${isProblem(st) ? `border-color:var(--${st});color:var(--${st})` : ""}">${esc(l.n.slice(0, 2).toUpperCase())}</span>
          <span class="link-body"><span class="link-name">${esc(l.n)}</span><span class="link-url">${esc(l.u.replace(/^https?:\/\//, ""))}</span></span>
          <span style="margin-left:auto">${dot(st)}</span>
        </a>`;
      }).join("")}
    </div></div>
  </div>`).join("")}`;
}

/* Woher die Ampel einer Kachel kommt — in dieser Reihenfolge:

   1. das verknüpfte System. Es wird vollständig überwacht, seine Ampel ist
      die belastbarere Aussage.
   2. der eigene Abruf der Adresse, wenn in der Verwaltung „prüfen" gesetzt
      ist. Ein GET, ein Statuscode, mehr nicht.
   3. gar nichts: ein Lesezeichen bleibt grau. Grün wäre hier eine
      Behauptung über etwas, das nie jemand geprüft hat.

   Solange die erste Prüfung noch aussteht (`st` ist null), bleibt es
   ebenfalls grau — „noch nicht geprüft" ist nicht „in Ordnung". */
function kachelAmpel(l, h) {
  if (h) return h.status;
  if (l.p && l.st) return l.st;
  return "idle";
}

function kachelTitel(l, h) {
  if (h) return `${l.u}\n${h.name}: ${SEV_LABEL[h.status] || h.status}${h.note ? " — " + h.note : ""}`;
  if (!l.p) return `${l.u}\nLesezeichen — nicht geprüft`;
  if (!l.st) return `${l.u}\nwird geprüft, noch kein Ergebnis`;
  return `${l.u}\n${l.detail || SEV_LABEL[l.st] || l.st}${l.ms != null ? ` · ${l.ms} ms` : ""}${l.stand ? ` · geprüft ${fmtWhen(l.stand)}` : ""}`;
}

/* ============================================================
   Ansicht: ein System im Einzelnen

   Die Sparkline in der Tabelle zeigt die letzte halbe Stunde. Die Frage,
   die nach einer Störung kommt, lautet aber „war das gestern Nacht auch
   schon so?" — und dafür gibt es diese Seite: derselbe Gegenstand, aber
   über Tage, aus der Ablage auf der Platte (server/src/verlauf.js).

   Gezeichnet wird nur, was gemessen wurde. Eine Lücke im Verlauf — Dienst
   war aus, System noch nicht angelegt — bleibt eine Lücke; die Linie wird
   unterbrochen, statt über sie hinwegzulaufen. Eine durchgezogene Linie
   über eine Nacht ohne Messwerte wäre genau die Sorte Behauptung, die eine
   Überwachung nicht machen darf.
   ============================================================ */

const ZEITRAEUME = [
  { tage: 1, label: "24 h" },
  { tage: 7, label: "7 Tage" },
  { tage: 30, label: "30 Tage" }
];

const REIHENFARBE = { ms: "var(--accent)", cpu: "var(--accent)", ram: "var(--warn)", disk: "var(--ok)", in: "var(--accent)", out: "var(--warn)" };

/* Eine runde Obergrenze, damit die Achse nicht bei 1237 ms endet. */
function obergrenze(max) {
  if (!(max > 0)) return 1;
  const stufe = Math.pow(10, Math.floor(Math.log10(max)));
  for (const f of [1, 1.5, 2, 2.5, 5, 10]) if (max <= stufe * f) return stufe * f;
  return stufe * 10;
}

function achsenBeschriftung(ts, spanne) {
  const d = new Date(ts * 1000);
  if (spanne <= 3 * 86400) return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

/* Aus Punkten werden Streckenzüge — unterbrochen, wo länger nichts
   gemessen wurde. Als „länger" gilt das Dreifache des üblichen Abstands:
   ein ausgelassener Takt ist noch dieselbe Linie, eine ausgefallene Nacht
   nicht mehr. */
function abschnitte(punkte, key, luecke) {
  const out = [];
  let lauf = [];
  let vorher = null;
  for (const p of punkte) {
    const v = p[key];
    if (!Number.isFinite(v)) { if (lauf.length) out.push(lauf); lauf = []; vorher = null; continue; }
    if (vorher != null && p.t - vorher > luecke) { if (lauf.length) out.push(lauf); lauf = []; }
    lauf.push(p);
    vorher = p.t;
  }
  if (lauf.length) out.push(lauf);
  return out;
}

/* Ein Diagramm über die Zeit: Fläche zwischen Kleinst- und Größtwert,
   darüber die Linie der Mittelwerte, links die Achse, unten die Zeit. */
function zeitDiagramm(punkte, reihe, opts = {}) {
  const key = reihe.key;
  const werte = punkte.map(p => p[key]).filter(Number.isFinite);
  if (!werte.length) return "";

  const w = 900, hoehe = opts.h || 150, links = 46, rechts = 12, oben = 12, unten = 24;
  const t0 = punkte[0].t, t1 = punkte[punkte.length - 1].t;
  const spanne = Math.max(1, t1 - t0);
  const prozent = reihe.einheit === "%";
  const hoch = prozent ? 100 : obergrenze(Math.max(...punkte.map(p => (Number.isFinite(p.max) ? p.max : p[key])).filter(Number.isFinite)));

  const x = t => links + ((t - t0) / spanne) * (w - links - rechts);
  const y = v => hoehe - unten - (Math.max(0, Math.min(hoch, v)) / hoch) * (hoehe - oben - unten);
  const farbe = opts.color || REIHENFARBE[key] || "var(--accent)";
  const id = "vd" + Math.random().toString(36).slice(2, 8);

  /* Üblicher Abstand: der kleinste, der tatsächlich vorkommt — der Takt
     kann sich über die Zeit geändert haben. */
  let abstand = Infinity;
  for (let i = 1; i < punkte.length; i++) abstand = Math.min(abstand, punkte[i].t - punkte[i - 1].t);
  const luecke = Math.max(60, (Number.isFinite(abstand) ? abstand : 60) * 3);

  const teile = abschnitte(punkte, key, luecke);
  const linien = teile.map(seg => {
    const pts = seg.map(p => `${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
    /* Ein einzelner Punkt zwischen zwei Lücken bekommt einen Tupfer,
       sonst wäre er unsichtbar. */
    return seg.length === 1
      ? `<circle cx="${x(seg[0].t).toFixed(1)}" cy="${y(seg[0][key]).toFixed(1)}" r="1.6" fill="${farbe}"/>`
      : `<polyline points="${pts}" fill="none" stroke="${farbe}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join("");

  /* Spannweite innerhalb eines Taktes — nur bei der Antwortzeit, dort ist
     sie der eigentliche Befund: ein Mittelwert von 40 ms aus 8 und 300 ms
     sieht harmlos aus und ist es nicht. */
  const band = key === "ms" && punkte.some(p => Number.isFinite(p.min) && Number.isFinite(p.max))
    ? teile.map(seg => {
        const oben2 = seg.map(p => `${x(p.t).toFixed(1)},${y(Number.isFinite(p.max) ? p.max : p[key]).toFixed(1)}`);
        const unten2 = [...seg].reverse().map(p => `${x(p.t).toFixed(1)},${y(Number.isFinite(p.min) ? p.min : p[key]).toFixed(1)}`);
        return seg.length > 1 ? `<polygon points="${[...oben2, ...unten2].join(" ")}" fill="${farbe}" fill-opacity=".16"/>` : "";
      }).join("")
    : "";

  const gitter = [0, 0.5, 1].map(f => {
    const v = hoch * f, yy = y(v);
    return `<line x1="${links}" x2="${w - rechts}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
      <text x="${links - 6}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" class="vd-tick">${esc(String(Math.round(v * 10) / 10))}</text>`;
  }).join("");

  const marken = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const ts = t0 + spanne * f;
    return `<text x="${x(ts).toFixed(1)}" y="${hoehe - 7}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}" class="vd-tick">${esc(achsenBeschriftung(ts, spanne))}</text>`;
  }).join("");

  const letzte = [...punkte].reverse().find(p => Number.isFinite(p[key]));
  return `<svg class="vd" viewBox="0 0 ${w} ${hoehe}" role="img" aria-label="${esc(reihe.label)}">
    <defs><clipPath id="${id}"><rect x="${links}" y="${oben}" width="${w - links - rechts}" height="${hoehe - oben - unten}"/></clipPath></defs>
    ${gitter}
    <g clip-path="url(#${id})">${band}${linien}</g>
    ${letzte ? `<circle cx="${x(letzte.t).toFixed(1)}" cy="${y(letzte[key]).toFixed(1)}" r="2.4" fill="${farbe}"/>` : ""}
    ${marken}
  </svg>`;
}

/* Das Ampelband unter den Diagrammen: was der Leitstand zu jedem Zeitpunkt
   von diesem System hielt. Gleiche Zustände werden zu einem Balken
   zusammengefasst — 900 Rechtecke wären dieselbe Aussage in teuer. */
function ampelBand(punkte) {
  const mit = punkte.filter(p => p.st);
  if (!mit.length) return "";
  const w = 900, h = 10;
  const t0 = punkte[0].t, t1 = punkte[punkte.length - 1].t;
  const spanne = Math.max(1, t1 - t0);
  const x = t => ((t - t0) / spanne) * w;

  const stuecke = [];
  for (const p of punkte) {
    const letzter = stuecke[stuecke.length - 1];
    if (letzter && letzter.st === (p.st || null)) { letzter.bis = p.t; continue; }
    stuecke.push({ st: p.st || null, von: p.t, bis: p.t });
  }
  return `<svg class="vd-band" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    ${stuecke.map(s => {
      const breite = Math.max(1, x(s.bis) - x(s.von));
      const farbe = s.st === "crit" ? "var(--crit)" : s.st === "warn" ? "var(--warn)" : s.st === "ok" ? "var(--ok)" : "var(--line)";
      return `<rect x="${x(s.von).toFixed(1)}" y="0" width="${breite.toFixed(1)}" height="${h}" fill="${farbe}" fill-opacity="${s.st === "ok" ? ".55" : ".9"}"/>`;
    }).join("")}
  </svg>`;
}

/* Kennzahlen einer Reihe, damit unter dem Bild auch Zahlen stehen. */
function reiheKennzahlen(punkte, reihe) {
  const werte = punkte.map(p => p[reihe.key]).filter(Number.isFinite);
  if (!werte.length) return "";
  const min = Math.min(...punkte.map(p => (Number.isFinite(p.min) && reihe.key === "ms" ? p.min : p[reihe.key])).filter(Number.isFinite));
  const max = Math.max(...punkte.map(p => (Number.isFinite(p.max) && reihe.key === "ms" ? p.max : p[reihe.key])).filter(Number.isFinite));
  const schnitt = werte.reduce((a, b) => a + b, 0) / werte.length;
  const rund = v => (reihe.einheit === "ms" ? Math.round(v) : Math.round(v * 10) / 10);
  return `<span class="mono faint" style="font-size:11.5px">Ø ${rund(schnitt)} · min ${rund(min)} · max ${rund(max)} ${esc(reihe.einheit)}</span>`;
}

function viewSystem() {
  const d = state.detail;
  if (!d) return `<div class="panel"><div class="empty">Kein System gewählt.</div></div>`;
  const h = byId(state.hosts, d.id);
  const t = h ? null : byId(state.tunnels, d.id);
  const g = h || t;

  if (!g) return `<div class="panel"><div class="panel-body">
    <div class="sec-title">Nicht im Bestand</div>
    <p class="muted" style="margin:0 0 12px;font-size:13.5px">„<span class="mono">${esc(d.id)}</span>" steht nicht (mehr) im Bestand.
      Aufgezeichnete Messwerte bleiben auf der Platte, angezeigt werden sie hier aber nur zu einem angelegten Gegenstand.</p>
    <button class="btn btn--primary" data-action="view" data-view="sites">Zu den Systemen</button></div></div>`;

  const titel = h ? h.name : `${siteName(t.a)} ↔ ${siteName(t.b)}`;
  const kicker = h ? (TYPE_LABEL[h.type] || h.type) : "Tunnel";
  const inc = state.incidents.filter(x => x.host === g.id);

  return `
  <div class="panel">
    <div class="panel-head">
      <button class="btn btn--ghost btn--sm" data-action="zurueck" title="Zurück">←</button>
      ${dot(g.status)}
      <h3>${esc(titel)}</h3>
      <span class="hint">${esc(kicker)} · ${esc(siteName(g.site || g.a))}</span>
      <div class="spacer"></div>
      ${h && h.url ? `<a class="btn btn--sm" href="${esc(h.url)}" target="_blank" rel="noopener">${ICON.ext} Oberfläche</a>` : ""}
      ${h ? `<button class="btn btn--sm" data-action="diagnose" data-id="${esc(h.id)}">Diagnose</button>` : ""}
      <button class="btn btn--sm" data-action="check-now">Jetzt prüfen</button>
      ${inc.length ? `<button class="btn btn--sm" data-action="silence" data-id="${esc(g.id)}" data-minutes="120">2 h stumm</button>` : ""}
      <button class="btn btn--sm" data-action="admin-edit" data-kind="${h ? "hosts" : "tunnels"}" data-id="${esc(g.id)}">Bearbeiten</button>
    </div>
    ${g.note ? `<div class="panel-body" style="padding-bottom:0"><div class="row" style="gap:8px;align-items:flex-start">
      ${dot(g.status)}<span style="color:var(--${g.status});font-size:13px">${esc(g.note)}</span></div></div>` : ""}
  </div>

  ${verlaufPanel(d, g)}

  ${h ? ifVerlaufPanel(d, h) : ""}

  <div class="grid g2">
    <div class="panel">
      <div class="panel-head"><h3>Stammdaten</h3></div>
      <div class="panel-body">${h ? hostStammdaten(h) : tunnelStammdaten(t)}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Letzter Durchlauf</h3><span class="hint">${esc(fmtWhen(g.lastSeen) ? "zuletzt erreicht " + fmtWhen(g.lastSeen) : "nie erreicht")}</span></div>
      <div class="panel-body col" style="gap:12px">
        ${pruefungenBlock(g)}
        ${h && h.tls ? zertifikatBlock(h) : ""}
        ${h && h.collectorError ? `<div class="row" style="gap:8px;align-items:flex-start;color:var(--warn)">${dot("warn")}
          <span style="font-size:12.5px">Abruf über die API: ${esc(h.collectorError)}</span></div>` : ""}
        ${t ? tunnelPeerBlock(t) : ""}
      </div>
    </div>
  </div>

  ${h && (hasMetrics(h) || (h.storages || h.stores || []).length) ? `<div class="panel">
    <div class="panel-head"><h3>Auslastung jetzt</h3><span class="hint">Momentaufnahme aus dem letzten Abruf</span></div>
    <div class="panel-body col" style="gap:10px">
      ${auslastungBlock(h)}${speicherBlock(h)}
    </div></div>` : ""}

  ${h ? kennzahlenPanel(h) : ""}

  ${inc.length ? `<div class="panel">
    <div class="panel-head"><h3>Offene Meldungen</h3><span class="hint">${inc.length}</span></div>
    <div class="panel-body col" style="gap:0">${inc.map(i => `
      <div class="row" style="gap:8px;padding:8px 0;border-bottom:1px solid var(--line);cursor:pointer" data-action="inspect" data-kind="incident" data-id="${esc(i.id)}">
        ${dot(i.sev)}<span style="font-size:13px">${esc(i.title)}</span>
        <span class="spacer"></span><span class="mono faint" style="font-size:11.5px">${esc(i.id)} · ${esc(ago(i.ageMin))}</span></div>`).join("")}
    </div></div>` : ""}

  ${h ? `<div class="panel"><div class="panel-body">${diagnoseAnsicht(h) || `<div class="empty">Für den Fall „erreichbar, Zugang gesetzt, trotzdem keine Werte“ zeigt die
    <b>Diagnose</b> oben jeden einzelnen Aufruf mit Antwort.</div>`}</div></div>` : ""}`;
}

/* Der Verlauf selbst — samt allem, was schiefgehen kann: noch nichts
   aufgezeichnet, Abruf gescheitert, Ablage abgeschaltet. Jeder dieser
   Fälle sagt, was er bedeutet; ein leeres Feld täte das nicht. */
function verlaufPanel(d, g) {
  const kopf = `<div class="panel-head">
    <h3>Verlauf</h3>
    <span class="hint">${d.daten ? `${d.daten.gemessen} Messpunkte${d.daten.gezeigt < d.daten.gemessen ? ` · verdichtet auf ${d.daten.gezeigt}` : ""}` : ""}</span>
    <div class="spacer"></div>
    ${ZEITRAEUME.map(z => `<button class="btn btn--sm" data-action="verlauf-tage" data-tage="${z.tage}"
      aria-current="${d.tage === z.tage}">${esc(z.label)}</button>`).join("")}
    <button class="btn btn--sm" data-action="verlauf-neu" title="Neu laden">↻</button>
  </div>`;

  if (d.busy && !d.daten) return `<div class="panel">${kopf}<div class="panel-body"><div class="empty">Verlauf wird geholt …</div></div></div>`;
  if (d.error) return `<div class="panel">${kopf}<div class="panel-body">
    <div class="row" style="gap:8px;align-items:flex-start">${dot("crit")}
      <span style="font-size:13px">Verlauf nicht abrufbar: <span class="mono">${esc(d.error)}</span></span></div></div></div>`;

  const daten = d.daten;
  const punkte = daten?.punkte || [];
  if (!punkte.length) return `<div class="panel">${kopf}<div class="panel-body">
    <div class="empty">Für diesen Zeitraum liegt noch nichts auf der Platte.</div>
    <p class="muted" style="margin:10px 0 0;font-size:12.5px;max-width:70ch">Aufgezeichnet wird ab dem ersten Durchlauf,
      ein Punkt je ${esc(String(daten?.takt || state.settings?.verlauf_takt || 60))} Sekunden. Der erste Punkt steht also frühestens
      nach Ablauf dieses Taktes in der Ablage — davor ist hier nichts, und das ist kein Fehler.</p>
    ${(g.hist || []).length ? `<div style="margin-top:14px">
      <div class="sec-title">Solange: die letzten Durchläufe aus dem Arbeitsspeicher</div>
      ${spark(g.hist, { w: 620, h: 80, color: `var(--${g.status === "ok" ? "accent" : g.status})` })}
      <div class="faint" style="font-size:11.5px">Antwortzeit in ms — diese Reihe ist nach einem Neustart weg.</div>
    </div>` : ""}</div></div>`;

  const reihen = (daten.reihen || []).filter(r => punkte.some(p => Number.isFinite(p[r.key])));
  return `<div class="panel">${kopf}
    <div class="panel-body col" style="gap:18px">
      ${reihen.map(r => `<div>
        <div class="row" style="gap:8px;margin-bottom:2px">
          <span class="sec-title" style="margin:0">${esc(r.label)}</span>
          <span class="faint" style="font-size:11.5px">${esc(r.einheit)}</span>
          <div class="spacer"></div>${reiheKennzahlen(punkte, r)}
        </div>
        ${zeitDiagramm(punkte, r)}
      </div>`).join("")}
      <div>
        <div class="row" style="gap:8px;margin-bottom:4px">
          <span class="sec-title" style="margin:0">Ampel</span>
          <div class="spacer"></div>
          <span class="legend">${dot("ok")} in Ordnung ${dot("warn")} auffällig ${dot("crit")} gestört ${dot("idle")} ruhend</span>
        </div>
        ${ampelBand(punkte)}
      </div>
    </div>
    <div class="panel-note">Von ${esc(fmtWhen(daten.von) || "—")} bis ${esc(fmtWhen(daten.bis) || "—")}.
      Innerhalb eines Taktes werden Mittel-, Kleinst- und Größtwert festgehalten; die getönte Fläche bei der Antwortzeit
      ist diese Spannweite. Wo nichts gemessen wurde, ist die Linie unterbrochen — dort lief der Dienst nicht.</div>
  </div>`;
}

/* Der Verlauf einer einzelnen Schnittstelle.

   Am System steht nur der Durchsatz der WAN-Seite; hier lässt sich jede
   Leitung einzeln über die Zeit ansehen. Geholt wird sie erst auf Klick —
   je Schnittstelle eine eigene Reihe zu laden, nur weil die Seite offen
   ist, wäre Verkehr für nichts.

   Die Reihe liegt unter derselben Kennung, unter der sie geschrieben
   wurde: `system|schnittstelle`. */
function ifVerlaufPanel(d, h) {
  const ifs = h.interfaces || [];
  if (!ifs.length) return "";

  const knoepfe = ifs.map(i => `<button class="btn btn--sm" data-action="if-verlauf" data-if="${esc(i.name)}"
    aria-current="${d.iface === i.name}" title="${esc(i.name)}">${esc(i.label)}</button>`).join("");

  const kopf = `<div class="panel-head">
    <h3>Durchsatz je Schnittstelle</h3>
    <span class="hint">${d.iface ? esc(d.iface) : "eine Leitung wählen"}</span>
    <div class="spacer"></div>${knoepfe}</div>`;

  if (!d.iface) return `<div class="panel">${kopf}
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th>Leitung</th><th>Verbindung</th><th class="right">↓ herein</th><th class="right">↑ hinaus</th>
        <th class="right">Pakete/s</th><th class="right">Übertragen</th><th>Fehler · verworfen</th></tr></thead><tbody>
      ${ifs.map(i => `<tr data-sev="ok">
        <td><div class="mono">${esc(i.label)}</div><div class="t-sub mono">${esc(i.name)}${
          i.beschreibung && i.beschreibung !== i.label ? " · " + esc(i.beschreibung) : ""}</div></td>
        <td>${i.link == null ? '<span class="faint">—</span>' : i.link === "up" ? chip("ok", "up") : chip("warn", String(i.link))}</td>
        <td class="right mono">${mbit(i.in)}</td>
        <td class="right mono">${mbit(i.out)}</td>
        <td class="right mono faint">${i.inPps == null && i.outPps == null ? "—" : `${nz(i.inPps)} / ${nz(i.outPps)}`}</td>
        <td class="right mono faint">${menge(i.rxBytes)} / ${menge(i.txBytes)}</td>
        <td class="mono faint">${nz(i.fehler)} · ${nz(i.verworfen)}</td>
      </tr>`).join("")}
      </tbody></table></div>
    <div class="panel-note">Die Momentaufnahme steht in der Tabelle, der Verlauf über Tage hinter den Schaltflächen
      oben rechts. Aufgezeichnet wird je Leitung eine eigene Reihe, im selben Takt wie alles andere.</div>
  </div>`;

  if (d.ifBusy && !d.ifDaten) return `<div class="panel">${kopf}<div class="panel-body"><div class="empty">Verlauf wird geholt …</div></div></div>`;
  if (d.ifError) return `<div class="panel">${kopf}<div class="panel-body">
    <div class="row" style="gap:8px;align-items:flex-start">${dot("crit")}
      <span style="font-size:13px">Verlauf nicht abrufbar: <span class="mono">${esc(d.ifError)}</span></span></div></div></div>`;

  const punkte = d.ifDaten?.punkte || [];
  if (!punkte.length) return `<div class="panel">${kopf}<div class="panel-body">
    <div class="empty">Für diese Leitung liegt in diesem Zeitraum noch nichts auf der Platte.</div>
    <p class="muted" style="margin:10px 0 0;font-size:12.5px;max-width:70ch">Aufgezeichnet wird ab dem zweiten
      Durchlauf — vorher gibt es keinen Durchsatz, weil er die Differenz zweier Zählerstände ist.</p></div></div>`;

  const reihen = (d.ifDaten.reihen || []).filter(r => punkte.some(p => Number.isFinite(p[r.key])));
  return `<div class="panel">${kopf}
    <div class="panel-body col" style="gap:18px">
      ${reihen.map(r => `<div>
        <div class="row" style="gap:8px;margin-bottom:2px">
          <span class="sec-title" style="margin:0">${esc(r.label)}</span>
          <span class="faint" style="font-size:11.5px">${esc(r.einheit)}</span>
          <div class="spacer"></div>${reiheKennzahlen(punkte, r)}
        </div>
        ${zeitDiagramm(punkte, r)}
      </div>`).join("")}
    </div>
    <div class="panel-note">Von ${esc(fmtWhen(d.ifDaten.von) || "—")} bis ${esc(fmtWhen(d.ifDaten.bis) || "—")},
      derselbe Zeitraum wie oben. Wo nichts gemessen wurde, ist die Linie unterbrochen.</div>
  </div>`;
}

/* ---- Bausteine, die Detailseite und Inspector gemeinsam nutzen ---- */
function hostStammdaten(h) {
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
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

function tunnelStammdaten(t) {
  return `<dl class="kv">
    <dt>Interface</dt><dd class="mono">${esc(nz(t.iface))}</dd>
    <dt>Transfernetz</dt><dd class="mono">${esc(nz(t.net))}</dd>
    <dt>Gemessen auf</dt><dd class="mono">${t.probe ? esc(t.probe) : '<span class="faint">— keine Gegenstelle eingetragen</span>'}</dd>
    <dt>Latenz</dt><dd class="mono">${esc(nz(t.rtt, " ms"))}</dd>
    <dt>Zuletzt erreicht</dt><dd>${esc(fmtWhen(t.lastSeen) || "nie")}</dd>
  </dl>`;
}

function pruefungenBlock(g) {
  const checks = g.checks || [];
  return `<div><div class="sec-title">Prüfungen im letzten Durchlauf</div>
    ${checks.length ? checks.map(c => `<div class="row" style="gap:8px;font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--line)">
      ${dot(c.skipped ? "idle" : c.ok ? "ok" : "crit")}
      <span class="mono">${esc(c.kind)}${c.port ? "/" + c.port : ""}</span>
      ${c.wesentlich ? `<span class="chip chip--plain" title="Diese Prüfung ist der Dienst selbst — ihr Ausfall gilt als Störung, nicht als Teilausfall">wesentlich</span>` : ""}
      <span class="faint" style="min-width:0">${esc(c.detail || "")}</span>
      <span class="spacer"></span><span class="mono faint">${c.ms != null ? c.ms + " ms" : ""}</span>
    </div>`).join("") : '<div class="empty">Noch kein Durchlauf.</div>'}</div>`;
}

function zertifikatBlock(h) {
  return `<div><div class="sec-title">Zertifikat</div><dl class="kv">
    <dt>Common Name</dt><dd class="mono">${esc(h.tls.cn || "—")}</dd>
    <dt>Aussteller</dt><dd>${esc(h.tls.issuer || "—")}${h.tls.selfSigned ? " (eigensigniert)" : ""}</dd>
    <dt>Restlaufzeit</dt><dd class="mono">${h.tls.days != null ? h.tls.days + " Tage" : "—"}</dd>
    <dt>Bewertung</dt><dd>${h.tls.bewertet === false
      ? `<span class="faint">keine — ${h.tlsIgnore ? "für dieses System abgeschaltet" : "eigensigniert"}</span>`
      : "geht in die Ampel ein"}</dd>
  </dl></div>`;
}

/* Die Balken der Auslastung folgen den Schwellwerten, die für dieses
   System gelten — sonst zeigte ein Balken Rot, während die Ampel Grün
   ist, weil am System eine andere Grenze hinterlegt wurde. */
function auslastungBlock(h) {
  if (!hasMetrics(h)) return "";
  const s = h.schwellen || {};
  return `${h.cpu != null ? meter("CPU", h.cpu, { warn: 80, crit: 95 }) : ""}`
    + `${h.ram != null ? meter("RAM", h.ram, { warn: s.ram_warn, crit: s.ram_crit }) : ""}`
    + `${h.disk != null ? meter("Speicher", h.disk, { warn: s.disk_warn, crit: s.disk_crit }) : ""}`;
}

/* Welche Grenzen für dieses System gelten — und ob sie eigene sind.

   Diese Zeile steht bewusst neben den Kennzahlen und nicht nur in den
   Einstellungen: wer eine gelbe Ampel sieht, will an derselben Stelle
   ablesen können, ab wann sie gelb wird. */
function schwellenZeile(h) {
  const s = h.schwellen;
  if (!s) return "—";
  const eigen = h.schwellenEigen || {};
  const teil = (k, label) => `${label} ${s[k]} %${eigen[k] != null ? ' <span class="chip chip--plain">eigen</span>' : ""}`;
  return `Speicher: ${teil("disk_warn", "gelb ab")}, ${teil("disk_crit", "rot ab")}<br>`
    + `RAM: ${teil("ram_warn", "gelb ab")}, ${teil("ram_crit", "rot ab")}`
    + (h.schwellenEigen ? "" : `<br><span class="faint">aus den Einstellungen — je System änderbar unter Verwaltung</span>`);
}

/* Was ein Sammler über die reine Auslastung hinaus liefert. Steht hier
   nichts, gibt es für diesen Typ noch keinen Sammler — oder es ist kein
   Zugang hinterlegt, und dann sagt die Kachel das ohnehin. */
function kennzahlenPanel(h) {
  const kv = rows => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const ja = (v, an, aus) => (v == null ? "—" : v ? an : `<span style="color:var(--warn)">${aus}</span>`);

  if (h.type === "pve" && (h.guests || h.updates != null || h.kernel)) {
    const g = h.guests || [];
    const upd = h.updateListe || [];
    return `<div class="panel">
      <div class="panel-head"><h3>Knoten im Einzelnen</h3><span class="hint">aus /nodes/${esc(h.node || "…")}/status und /apt/update</span></div>
      <div class="panel-body">${kv([
        ["Knoten", h.node ? `<span class="mono">${esc(h.node)}</span>${h.nodeStatus ? ` · ${esc(h.nodeStatus)}` : ""}` : "—"],
        ["Cluster", h.cluster ? `${esc(h.cluster)}${h.quorum === false ? ' · <span style="color:var(--crit)">kein Quorum</span>' : h.quorum ? " · Quorum steht" : ""}` : "standalone"],
        ["Fassung", h.pveVersion ? `<span class="mono">${esc(h.pveVersion)}</span>` : (h.version ? `<span class="mono">${esc(h.version)}</span>` : "—")],
        ["Kernel", h.kernel ? `<span class="mono">${esc(h.kernel)}</span>` : "—"],
        ["Prozessor", h.cpuModel ? `${esc(h.cpuModel)}${h.cores ? ` · ${h.cores} Kerne${h.sockets ? ` auf ${h.sockets} Sockel` : ""}` : ""}` : nz(h.cores, " Kerne")],
        ["Last (1 min)", nz(h.load1)],
        ["Wurzeldateisystem", h.rootUsed != null ? `${h.rootUsed} %` : "—"],
        ["Auslagerung", h.swap != null ? `${h.swap} %` : "— (keine eingerichtet)"],
        ["Laufzeit", nz(h.uptime)],
        ["Ausstehende Pakete", h.updates == null
          ? `<span class="faint">${esc(h.updatesNote || "nicht gelesen")}</span>`
          : h.updates ? `<span class="mono">${h.updates}</span>` : "keine bekannt"],
        ["Gäste", h.running == null ? "—" : `${h.running} laufen, ${h.stopped} gestoppt${h.templates ? `, ${h.templates} Vorlagen` : ""}`],
        ["Schwellwerte", schwellenZeile(h)]
      ])}</div>

      ${upd.length ? `<div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th>Paket</th><th>installiert</th><th>verfügbar</th><th>Was es ist</th></tr></thead><tbody>
        ${upd.map(p => `<tr data-sev="info">
          <td class="mono">${esc(p.paket)}</td>
          <td class="mono faint">${esc(nz(p.von))}</td>
          <td class="mono">${esc(nz(p.auf))}</td>
          <td class="faint">${esc(p.titel || "—")}</td></tr>`).join("")}
        </tbody></table></div>
        <div class="panel-note">Gezeigt werden die ersten ${upd.length} Einträge. Was hier steht, ist der Stand des
          letzten Listenabgleichs <em>auf dem Knoten</em> — eine leere Liste heißt „nichts bekannt", nicht
          „garantiert aktuell". Aktualisiert wird hier nichts: jeder Zugang ist ein Konto ohne Schreibrechte.</div>` : ""}

      ${g.length ? `<div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>Gast</th><th>Art</th><th>CPU</th><th>RAM</th><th>Platte</th><th class="right">Laufzeit</th></tr></thead><tbody>
        ${g.map(x => `<tr data-sev="${x.status === "running" ? "ok" : "idle"}">
          <td class="sev">${dot(x.status === "running" ? "ok" : "idle")}</td>
          <td><div class="mono">${esc(x.name)}</div><div class="t-sub">${esc(String(x.vmid ?? "—"))}${x.tags ? " · " + esc(String(x.tags)) : ""}</div></td>
          <td>${chip("plain", x.typ === "lxc" ? "LXC" : "VM")}</td>
          <td style="min-width:100px">${x.cpu != null ? meter("", x.cpu, { text: x.cpu + " %", warn: 80, crit: 95 }) : `<span class="faint">${esc(x.status || "—")}</span>`}</td>
          <td style="min-width:100px">${x.ram != null ? meter("", x.ram, { text: x.ram + " %" }) : '<span class="faint">—</span>'}</td>
          <td style="min-width:100px">${x.disk != null ? meter("", x.disk, { text: x.disk + " %" }) : '<span class="faint">—</span>'}</td>
          <td class="right mono faint">${x.uptime != null ? esc(kurzLaufzeit(x.uptime)) : "—"}</td>
        </tr>`).join("")}
        </tbody></table></div>` : ""}
    </div>`;
  }

  if (FIREWALL.has(h.type) && (h.interfaces || h.disk != null || h.ram != null)) {
    const pf = h.type === "pfsense";
    return `<div class="panel">
      <div class="panel-head"><h3>Gerät im Einzelnen</h3>
        <span class="hint">${pf ? `über das Paket pfSense-pkg-API${h.apiFassung ? " " + esc(h.apiFassung) : ""}`
          : "aus dem Diagnose-Zweig der OPNsense-API"}</span></div>
      <div class="panel-body">${kv([
        ["Fassung", h.version ? `<span class="mono">${esc(h.version)}</span>${h.abi ? ` · ABI ${esc(h.abi)}` : ""}` : "—"],
        ["Betriebssystem", h.os ? `<span class="mono">${esc(h.os)}</span>` : "—"],
        ["Laufzeit", nz(h.uptime)],
        ["Last", h.load ? `<span class="mono">${esc(h.load)}</span>` : "—"],
        ["Arbeitsspeicher", h.ram != null ? `${h.ram} %${h.ramTotalMb ? ` von ${h.ramTotalMb} MB` : ""}${h.ramArcMb ? ` · ${h.ramArcMb} MB ZFS-Cache` : ""}` : "—"],
        h.tempC != null ? ["Temperatur", `${h.tempC} °C`] : null,
        ["Aktualisierungen", h.updates == null ? "—"
          : h.updates ? `${h.updates === 1 && pf ? "eine steht bereit" : h.updates + " offen"}${h.majorUpgrade ? ` · Fassung ${esc(h.majorUpgrade)}` : ""}`
          : "keine offen"],
        h.needsReboot == null ? null : ["Neustart nötig", ja(!h.needsReboot, "nein", "ja")],
        /* Nur wenn die Firewall sie auch gemeldet hat: eine Zeile „CARP: —"
           an einem Gerät ohne CARP wäre eine Behauptung über etwas, wonach
           gar nicht gefragt wurde. */
        h.statesPct != null ? ["Zustandstabelle", `${h.states} von ${h.statesMax} belegt (${h.statesPct} %)`] : null,
        h.carp ? ["CARP", `${esc(h.carp)}${h.carpWartung ? " · Wartungsmodus" : ""}`] : null,
        /* Was die Firewall selbst über ihre Außenseite sagt — die Zahl,
           die am Standort bisher nur getippt dastand. */
        h.wan ? ["Nach außen", `<span class="mono">${esc(h.wan)}${h.wanPraefix != null ? "/" + h.wanPraefix : ""}</span>`
          + (h.wanPrivat ? ' <span class="chip chip--warn">privat</span>' : "")
          + (h.wanIface ? ` <span class="faint">über ${esc(h.wanIface)}</span>` : "")
          + (h.wanAliase ? ` · ${h.wanAliase} weitere Adresse(n)` : "")
          + (h.wan6 ? `<br><span class="mono">${esc(h.wan6)}</span>` : "")] : null,
        ["WireGuard", h.wgPeers == null ? "—"
          : `${h.wgPeers} Peer(s) auf ${nz(h.wgIfaces)} Schnittstelle(n)${h.wgStill ? `, ${h.wgStill} still` : ""}`
            + (h.wgHandshakeUnbekannt ? ' <span style="color:var(--warn)">— ohne Handshake-Alter</span>' : "")],
        ["Schwellwerte", schwellenZeile(h)]
      ])}</div>
      ${uplinkTabelle(h)}
      ${gatewayTabelle(h)}
      ${h.wgNote ? `<div class="panel-note">${esc(h.wgNote)}</div>` : ""}
      <div class="panel-note">Durchsatz, Pakete und Fehler je Leitung stehen weiter oben unter
        <b>Durchsatz je Schnittstelle</b> — samt Verlauf über Tage.</div>
    </div>`;
  }

  /* Der Mail Gateway auf der Detailseite: dieselben Zahlen wie in der
     Ansicht „Mail", aber alle an einem Ort und ohne Auswahl. */
  if (h.type === "pmg" && (h.in24 != null || h.queueDeferred != null || h.dienste)) {
    const w = h.warteschlange || [];
    return `<div class="panel">
      <div class="panel-head"><h3>Gateway im Einzelnen</h3>
        <span class="hint">aus /statistics/mail, /postfix/qshape und dem Knotenzustand</span></div>
      <div class="panel-body">${kv([
        ["Knoten", h.node ? `<span class="mono">${esc(h.node)}</span>` : "—"],
        ["Fassung", h.pmgVersion ? `<span class="mono">${esc(h.pmgVersion)}</span>`
          : h.version ? `<span class="mono">${esc(h.version)}</span>` : "—"],
        ["Kernel", h.kernel ? `<span class="mono">${esc(h.kernel)}</span>` : "—"],
        ["Prozessor", h.cpuModel ? `${esc(h.cpuModel)}${h.cores ? ` · ${h.cores} Kerne` : ""}` : nz(h.cores, " Kerne")],
        ["Last (1 min)", nz(h.load1)],
        ["Wurzeldateisystem", h.disk != null ? `${h.disk} %${h.diskFreiGb != null ? ` · ${h.diskFreiGb} GB frei` : ""}` : "—"],
        ["Auslagerung", h.swap != null ? `${h.swap} %` : "— (keine eingerichtet)"],
        ["Laufzeit", nz(h.uptime)],
        ["Abgleich im Verbund", h.insync == null ? "—"
          : h.insync ? "abgeglichen" : '<span style="color:var(--warn)">seit über drei Minuten nicht abgeglichen</span>'],
        ["Eingang / Ausgang 24 h", h.in24 == null ? "—" : `${h.in24} / ${nz(h.out24)}`],
        ["Spam", h.spam == null ? "—" : `${h.spam}${h.spamAnteil != null ? ` (${h.spamAnteil} % des Eingangs)` : ""}`],
        ["Viren", h.virus == null ? "—"
          : `${h.virus} eingehend${h.virusAus ? ` · <span style="color:var(--crit)">${h.virusAus} ausgehend</span>` : ", 0 ausgehend"}`],
        ["Vor der Annahme abgewiesen", h.abgewiesen == null ? "—"
          : `${h.abgewiesen} — RBL ${nz(h.rbl)}, Pregreet ${nz(h.pregreet)}, SPF ${nz(h.spf)}, Greylist ${nz(h.greylist)}`],
        ["Ø Bearbeitung", nz(h.avgMs, " ms")],
        ["Warteschlange", h.queueDeferred == null ? "—"
          : w.map(q => `${q.queue} ${q.anzahl == null ? "—" : q.anzahl}`).join(" · ")
            + (h.queueAlt ? ` · <span style="color:var(--warn)">${h.queueAlt} seit über zehn Stunden</span>` : "")],
        ["Quarantäne", h.quarSpam == null ? "—"
          : `${h.quarSpam} Spam (${nz(h.quarSpamMb, " MB")}) · ${nz(h.quarVirus)} Viren`],
        ["Virensignaturen", h.signaturStand
          ? `${esc(fmtWhen(h.signaturStand))}${h.signaturAlter != null ? ` · ${h.signaturAlter} h alt` : ""}`
          : `<span class="faint">${esc(h.signaturNote || "nicht gelesen")}</span>`],
        ["Ausstehende Pakete", h.updates == null
          ? `<span class="faint">${esc(h.updatesNote || "nicht gelesen")}</span>`
          : h.updates ? `<span class="mono">${h.updates}</span>` : "keine bekannt"],
        ["Stand der Statistik", h.statStand ? esc(fmtWhen(h.statStand)) : "—"],
        ["Schwellwerte", schwellenZeile(h)]
      ])}</div>

      ${(h.dienste || []).length ? `<div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>Dienst</th><th>Aufgabe</th><th>Zustand</th></tr></thead><tbody>
        ${h.dienste.map(d => {
          const ampel = d.kern ? (d.zustand === "running" ? "ok" : "crit") : d.aktiv === "failed" ? "warn" : "idle";
          return `<tr data-sev="${ampel}">
            <td class="sev">${dot(ampel)}</td>
            <td class="mono">${esc(d.name)}${d.kern ? ' <span class="chip chip--plain">Kern</span>' : ""}</td>
            <td class="faint">${esc(d.beschreibung || "—")}</td>
            <td class="mono faint">${esc(d.zustand || "—")}</td></tr>`;
        }).join("")}
        </tbody></table></div>` : ""}

      <div class="panel-note">Die Zahlen kommen in einem eigenen Takt statt in jedem Durchlauf: die Tagesstatistik
        ändert sich in 15 Sekunden nicht messbar, und die Warteschlange abzufragen startet je Abruf einen Prozess
        auf dem Gerät. Wie alt der Stand ist, steht oben. Die Erreichbarkeit misst der Prober weiterhin in jedem
        Durchlauf.
        <br>Ein <b>eingehender</b> Virenfund färbt keine Ampel — er ist der Zweck des Geräts. Ein
        <b>ausgehender</b> ist rot: dann verschickt ein Gerät im eigenen Netz Schadsoftware.</div>
    </div>`;
  }

  /* Mailcow auf der Detailseite. */
  if (h.type === "mailcow" && (h.containerGesamt != null || h.queueDeferred != null)) {
    const w = h.warteschlange || [];
    return `<div class="panel">
      <div class="panel-head"><h3>Mailcow im Einzelnen</h3>
        <span class="hint">aus /get/status/*, /get/mailq/all und /get/domain/all</span></div>
      <div class="panel-body">${kv([
        ["Fassung", h.version ? `<span class="mono">${esc(h.version)}</span>` : "—"],
        ["rspamd", h.rspamdVersion ? `<span class="mono">${esc(h.rspamdVersion)}</span>${h.rspamdSeit
          ? ` · läuft seit ${esc(dauerKurz(h.rspamdSeit))}` : ""}` : "—"],
        ["Container", h.containerGesamt == null ? "—"
          : `${h.containerLaufen} von ${h.containerGesamt} laufen${h.kernSteht?.length
            ? ` · <span style="color:var(--crit)">${esc(h.kernSteht.join(", "))}</span>` : ""}${h.nebenSteht?.length
            ? ` · <span style="color:var(--warn)">${esc(h.nebenSteht.join(", "))}</span>` : ""}`],
        ["Wirt", h.cpu == null ? "—" : `CPU ${h.cpu} %, RAM ${h.ram} %${h.cores ? ` · ${h.cores} Kerne` : ""}${
          h.arch ? ` · ${esc(h.arch)}` : ""}`],
        ["Laufzeit", nz(h.uptime)],
        ["Postfachablage", h.vmailPct == null ? "—"
          : `${h.vmailPct} %${h.vmailBelegt ? ` · ${esc(h.vmailBelegt)} von ${esc(h.vmailGesamt || "?")}` : ""}${
            h.vmailGeraet ? ` <span class="faint mono">${esc(h.vmailGeraet)}</span>` : ""}`],
        ["Domänen", h.domainsGesamt == null ? "—" : `${h.domainsGesamt} mit ${nz(h.postfaecher)} Postfächern`],
        ["Nachrichten", h.nachrichten != null ? `${h.nachrichten.toLocaleString("de-DE")}${h.belegt != null
          ? ` · ${menge(h.belegt)}` : ""}` : "—"],
        ["Vollstes Postfach", h.mailboxVollste
          ? `<span class="mono">${esc(h.mailboxVollste.name)}</span> — ${h.mailboxVollste.prozent} %` : "—"],
        ["Warteschlange", h.queueDeferred == null ? "—"
          : w.map(q => `${q.queue} ${q.anzahl}`).join(" · ")
            + (h.queueAlt ? ` · <span style="color:var(--warn)">${h.queueAlt} seit über zehn Stunden</span>` : "")],
        ["Warum es liegt", (h.queueGruende || []).length
          ? h.queueGruende.slice(0, 3).map(g => `${esc(g.grund)} (${g.anzahl})`).join("<br>") : "—"],
        ["Filter seit rspamd-Start", h.geprueft == null ? "—"
          : `${h.geprueft.toLocaleString("de-DE")} geprüft, ${nz(h.spam)} Spam${h.spamAnteil != null ? ` (${h.spamAnteil} %)` : ""}`],
        ["Quarantäne", h.quarantaene == null ? "—"
          : `${h.quarantaene}${h.quarantaeneViren ? ` · ${h.quarantaeneViren} mit Virenfund` : ""}`],
        ["Gesperrte Adressen", h.gesperrt == null ? "—"
          : `${h.gesperrt}${h.gesperrtDauerhaft ? ` · ${h.gesperrtDauerhaft} dauerhaft` : ""}`],
        ["Stand der Zahlen", h.statStand ? esc(fmtWhen(h.statStand)) : "—"],
        ["Schwellwerte", schwellenZeile(h)]
      ])}</div>

      ${(h.containerListe || []).length ? `<div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>Container</th><th>Abbild</th><th>Zustand</th></tr></thead><tbody>
        ${h.containerListe.map(c => {
          const ampel = c.zustand === "running" ? "ok" : c.kern ? "crit" : "warn";
          return `<tr data-sev="${ampel}">
            <td class="sev">${dot(ampel)}</td>
            <td class="mono">${esc(c.name)}${c.kern ? ' <span class="chip chip--plain">Kern</span>' : ""}</td>
            <td class="mono faint">${esc(c.image || "—")}</td>
            <td class="mono faint">${esc(c.zustand || "—")}</td></tr>`;
        }).join("")}
        </tbody></table></div>` : ""}

      <div class="panel-note">Die Zahlen kommen in einem eigenen Takt statt in jedem Durchlauf: mehrere dieser
        Abfragen lassen mailcow einen Befehl <em>in</em> einem Container ausführen — <span class="mono">mailq</span>
        in Postfix, <span class="mono">df</span> in Dovecot. Wie alt der Stand ist, steht oben.
        <br>Die Filterzahlen zählen seit dem Start von rspamd und beginnen nach dessen Neustart wieder bei null;
        deshalb steht die Laufzeit dabei.</div>
    </div>`;
  }

  if (h.type === "adguard" && (h.dnsQueries != null || h.protection != null)) {
    const c = dnsPruefung(h);
    return `<div class="panel">
      <div class="panel-head"><h3>DNS-Filter</h3><span class="hint">aus /control/status und /control/stats</span></div>
      <div class="panel-body">${kv([
        ["Auflösung über UDP/53", !c ? "— keine DNS-Prüfung angelegt"
          : c.skipped ? "übersprungen"
          : `<span style="color:var(--${c.ok ? "ok" : "crit"})">${esc(c.detail || (c.ok ? "antwortet" : "keine Antwort"))}</span>${c.ms != null ? ` <span class="mono faint">${c.ms} ms</span>` : ""}`],
        ["Anfragen", h.dnsQueries != null ? `<span class="mono">${esc(String(h.dnsQueries))}</span>${h.statsFenster ? ` / ${esc(h.statsFenster)}` : ""}` : "—"],
        ["Geblockt", h.dnsBlocked != null ? `<span class="mono">${esc(String(h.dnsBlocked))}</span>${h.blockRate != null ? ` (${h.blockRate} %)` : ""}` : "—"],
        ["Ø Bearbeitung", h.avgMs != null ? `<span class="mono">${h.avgMs} ms</span>` : "—"],
        ["DNS-Dienst", ja(h.dnsRunning, "läuft", "steht")],
        ["Schutz", ja(h.protection, "an", "abgeschaltet")],
        ["Filterung", ja(h.filtering, "an", "abgeschaltet")],
        ["Filterlisten", h.filters != null ? `${h.filtersAktiv ?? "?"} von ${h.filters} aktiv${h.filterRules ? ` · ${h.filterRules} Regeln` : ""}` : "—"],
        ["Älteste Liste", h.filterStand ? esc(fmtWhen(h.filterStand)) : "—"],
        ["Upstreams", nz(h.upstreams)]
      ])}</div>
      <div class="panel-note">Eine Zahl für Upstream-Fehler führt die AdGuard-API nicht — weder im Zustand noch in
        der Statistik. Sie steht deshalb nirgends, statt geschätzt zu werden.</div>
    </div>`;
  }

  if (h.type === "portainer" && (h.endpoints != null || h.containers != null)) {
    const umg = h.umgebungen || [];
    const probleme = h.probleme || [];
    return `<div class="panel">
      <div class="panel-head"><h3>Container</h3><span class="hint">aus der Momentaufnahme von Portainer</span></div>
      <div class="panel-body">${kv([
        ["Umgebungen", h.endpoints != null ? `${h.endpoints - (h.endpointsDown || 0)} von ${h.endpoints} erreichbar` : "—"],
        ["Stacks", h.stacks != null ? `${h.stacks}${h.stacksInaktiv ? ` · ${h.stacksInaktiv} angehalten` : ""}` : "—"],
        ["Container", h.containers != null ? `${h.running} laufend, ${h.stopped} gestoppt` : "—"],
        ["Unhealthy", nz(h.unhealthy)],
        ["Neustartschleife", h.restarting == null ? "— nicht gelesen" : String(h.restarting)],
        ["Exit 137 (OOM)", h.oom == null ? "— nicht gelesen" : String(h.oom)]
      ])}</div>
      ${umg.length ? `<div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>Umgebung</th><th>Docker</th><th>Container</th><th>Unhealthy</th><th>Stand</th></tr></thead><tbody>
        ${umg.map(u => `<tr data-sev="${u.erreichbar ? "ok" : "warn"}">
          <td class="sev">${dot(u.erreichbar ? "ok" : "warn")}</td>
          <td class="mono">${esc(u.name)}</td>
          <td class="mono faint">${esc(nz(u.docker))}</td>
          <td class="mono">${u.running == null ? "—" : `${u.running} / ${u.running + u.stopped}`}</td>
          <td class="mono">${nz(u.unhealthy)}</td>
          <td class="faint">${esc(fmtWhen(u.stand) || "—")}</td></tr>`).join("")}
        </tbody></table></div>` : ""}
      ${probleme.length ? `<div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th>Container</th><th>Umgebung</th><th>Zustand</th><th>Befund</th></tr></thead><tbody>
        ${probleme.map(p => `<tr data-sev="warn">
          <td class="mono">${esc(p.name)}</td><td class="faint">${esc(p.umgebung)}</td>
          <td class="mono faint">${esc(p.status || p.zustand)}</td><td>${esc(p.grund)}</td></tr>`).join("")}
        </tbody></table></div>` : ""}
      <div class="panel-note">Die Zahlen stammen aus der Momentaufnahme, die Portainer in eigenem Takt zieht —
        die Spalte „Stand" sagt, wie alt sie ist. Einen Neustartzähler führt die Containerliste nicht; gemeldet
        wird, wer gerade neu startet, wer unhealthy ist und wer mit 137 an der Speichergrenze ausgestiegen ist.</div>
    </div>`;
  }
  if (h.type === "unifi" && (h.wlanGeraete || h.aps != null)) {
    const g = h.wlanGeraete || [];
    const grenze = thr("wlan_kanal_warn") ?? 80;
    return `<div class="panel">
      <div class="panel-head"><h3>WLAN</h3><span class="hint">Site ${esc(nz(h.wlanSite))} · ${
        h.wlanQuelle === "integration" ? "Integration-API" : "klassische API"}</span></div>
      <div class="panel-body">${kv([
        ["Access Points", h.aps != null ? `${h.apsOnline} von ${h.aps} verbunden` : "—"],
        ["Getrennt", h.apsOffline ? `<span style="color:var(--warn)">${h.apsOffline}</span>` : nz(h.apsOffline)],
        ["Isoliert", h.apsIsoliert ? `<span style="color:var(--warn)">${h.apsIsoliert}</span> — Uplink verloren, funkt weiter` : nz(h.apsIsoliert)],
        ["Wartet auf Adoption", nz(h.apsWartend)],
        ["Weitere Geräte", h.wlanGesamt != null ? `${h.switche ?? 0} Switch(es) · ${h.wlanGateways ?? 0} Gateway(s)` : "—"],
        ["Clients", h.clients != null ? `${h.clients}${h.clientsGast ? ` · davon ${h.clientsGast} im Gastnetz` : ""}` : "— kennt diese API nicht"],
        ["Kanalbelegung", h.kanalLastBand
          ? h.kanalLastBand.map(b => `<span class="mono">${esc(b.band)}</span> bis <span style="color:var(--${b.last >= grenze ? "warn" : "text"})">${b.last} %</span> (${esc(b.ap)}, Kanal ${b.kanal ?? "?"})`).join("<br>")
          : "— nur über die klassische API"],
        ["Neue Fassung verfügbar", h.wlanUpdates == null ? "—" : `${h.wlanUpdates} Gerät(e)`],
        ["Controller", [h.version ? "Network " + esc(h.version) : null, h.controllerUpdate ? "Aktualisierung steht an" : null].filter(Boolean).join(" · ") || "—"],
        ["Teilsystem WLAN", h.wlanStatus ? esc(h.wlanStatus) : "—"]
      ])}</div>
      ${g.length ? `<div class="panel-body panel-body--flush tablewrap">
        <table class="t"><thead><tr><th style="width:34px"></th><th>Gerät</th><th>Art</th><th>Zustand</th>
          <th class="right">Clients</th><th>Funk</th><th class="right">Zuletzt gesehen</th></tr></thead><tbody>
        ${g.map(d => `<tr data-sev="${WLAN_SEV[d.zustand] || "idle"}">
          <td class="sev">${dot(WLAN_SEV[d.zustand] || "idle")}</td>
          <td><div class="mono">${esc(d.name)}</div><div class="t-sub">${esc([d.modell, d.ip].filter(Boolean).join(" · "))}</div></td>
          <td class="faint">${esc(WLAN_ART[d.art] || d.art)}</td>
          <td class="faint">${esc(d.zustandText)}</td>
          <td class="right mono">${nz(d.clients)}</td>
          <td class="mono faint" style="font-size:11.5px">${(d.funk || []).map(f =>
            `${esc(f.band || "?")} K${f.kanal ?? "?"}${f.last != null ? " " + f.last + " %" : ""}`).join("<br>") || "—"}</td>
          <td class="right faint">${esc(fmtWhen(d.gesehen) || "—")}</td></tr>`).join("")}
        </tbody></table></div>` : ""}
      <div class="panel-note">Ein Access Point mit Strom antwortet auf Ping, auch wenn er sich beim Controller
        abgemeldet hat — deshalb steht hier sein <b>gemeldeter</b> Zustand und nicht seine Erreichbarkeit.
        „Isoliert" heißt: er funkt weiter, hat aber keinen Uplink mehr; seine Clients sind verbunden und kommen
        nirgendwohin. Die <b>Kanalbelegung</b> zählt eigenen und fremden Funkverkehr zusammen und ist die Zahl,
        die ein langsames WLAN erklärt, während jede Ampel grün steht — gelb ab ${grenze} %.
        <br><b>Die Clientliste wird nicht gelesen</b>, nur gezählt: eine Überwachung ist kein
        Anwesenheitsprotokoll.</div>
    </div>`;
  }
  return "";
}

function speicherBlock(h) {
  const liste = h.storages || h.stores || [];
  if (!liste.length) return "";
  const s = h.schwellen || {};
  return `<div class="sec-title" style="margin-top:6px">${h.type === "pbs" ? "Datastores" : "Speicher"}
      <span class="faint" style="font-weight:400">— gelb ab ${nz(s.disk_warn, " %")}, rot ab ${nz(s.disk_crit, " %")}${
        h.schwellenEigen ? " (für dieses System gesetzt)" : ""}</span></div>
    ${liste.map(x => meter(x.name, x.used, {
      text: x.used != null ? x.used + " %" : "—", warn: s.disk_warn, crit: s.disk_crit
    })).join("")}`;
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

/* Welche Systeme von den globalen Grenzen abweichen — mit Namen. Eine
   Abweichung, die niemand mehr findet, ist eine stillgelegte Überwachung;
   sie gehört an eine Stelle, an der man ohne Suchen darüber stolpert. */
function eigeneSchwellen() {
  const mit = state.hosts.filter(h => h.schwellenEigen);
  if (!mit.length) return "keine — überall gelten die Werte oben";
  return mit.map(h => {
    const e = h.schwellenEigen;
    const teile = Object.entries(e).map(([k, v]) => `${k.replace("disk", "Speicher").replace("ram", "RAM").replace("_warn", " gelb").replace("_crit", " rot")} ${v} %`);
    return `<b>${esc(h.name)}</b>: ${esc(teile.join(", "))}`;
  }).join("<br>");
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
        ["Belegung", s.disk_warn != null
          ? `Speicher ab ${mono(s.disk_warn + " %")} Warnung, ab ${mono(s.disk_crit + " %")} kritisch · RAM ab ${mono(s.ram_warn + " %")} / ${mono(s.ram_crit + " %")}`
          : "—"],
        ["Eigene Grenzen", eigeneSchwellen()],
        ["Zertifikat", s.tls_warn_days != null
          ? `unter ${mono(s.tls_warn_days + " Tagen")} Warnung · unter ${mono(s.tls_crit_days + " Tagen")} kritisch` : "—"],
        ["Verlauf im Speicher", s.history != null ? `${mono(s.history)} Messpunkte je System${s.interval ? ` (${Math.round(s.history * s.interval / 60)} min)` : ""}` : "—"],
        ["Zeitreihe auf Platte", s.verlauf_takt != null
          ? `ein Punkt alle ${mono(s.verlauf_takt + " s")}, aufbewahrt ${mono(s.verlauf_tage + " Tage")}` : "—"],
        ["Kacheln der Startseite", s.link_takt != null
          ? `mit „abrufen": alle ${mono(s.link_takt + " s")} ein GET — Ampel, keine Störung` : "—"],
        ["Postfach voll", s.mailbox_voll_warn != null
          ? `ab ${mono(s.mailbox_voll_warn + " %")} Belegung eines einzelnen Postfachs → Warnung mit Namen` : "—"],
        ["Mail-Warteschlange", s.mail_queue_warn != null
          ? `ab ${mono(s.mail_queue_warn)} zurückgestellten Mail Warnung, ab ${mono(s.mail_queue_crit)} kritisch · `
            + "was über zehn Stunden liegt, fällt auch darunter auf" : "—"],
        ["Teilausfall", "antwortet ein Port nicht, während andere tragen → Warnung"],
        ["Abruf scheitert", "erreichbar, aber API-Zugang abgelehnt → Warnung statt stiller Lücke"],
        ["Standort", "sind alle überwachten Systeme eines Standorts gleichzeitig still → <b>eine</b> Meldung statt zwölf"]
      ])}</div>
      <div class="panel-note">Handshake-Schwellen fehlen hier, weil es die dazugehörigen Messwerte noch nicht gibt.
        Ein Schwellwert ohne Messung wäre eine Zusage, die niemand einhält. Die Mail-Warteschlange steht dagegen
        jetzt dabei: seit der Mail Gateway angebunden ist, wird sie auch gemessen.</div>
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
        ["Zeitreihen", rt.verlauf
          ? `${rt.verlauf.fehler ? dot("crit") : dot("ok")} ${rt.verlauf.vorhanden} Tagesdatei(en)${
              rt.verlauf.seit ? ` seit ${esc(rt.verlauf.seit)}` : ""} · ${
              rt.verlauf.bytes != null ? mono((rt.verlauf.bytes / 1048576).toFixed(1) + " MB") : "—"} in ${mono(rt.verlauf.verzeichnis)}${
              rt.verlauf.fehler ? `<br><span style="color:var(--crit)">nicht schreibbar: ${esc(rt.verlauf.fehler)}</span>` : ""}`
          : `${dot("idle")} keine Ablage — dieser Dienst schreibt keine Zeitreihen`],
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
        ${h ? `<button class="btn" data-action="system" data-id="${esc(i.host)}">Verlauf</button>` : ""}
        <button class="btn" data-action="silence" data-id="${esc(i.host)}" data-minutes="120">2 h stummschalten</button>
        ${h && h.url ? `<a class="btn" href="${esc(h.url)}" target="_blank" rel="noopener">${ICON.ext} System öffnen</a>` : ""}`
    };
  }

  /* „host" gibt es hier nicht mehr: ein System hat seit dem Verlauf über
     Tage eine eigene Seite (viewSystem). Zwei Darstellungen desselben
     Gegenstands nebeneinander zu pflegen, hieße, dass eine davon bald
     etwas anderes zeigt als die andere. `open("host", …)` führt deshalb
     auf die Seite. */

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
        ${tunnelPruefungen(t)}
        ${tunnelPeerBlock(t)}
        ${(t.hist || []).length ? `<div><div class="sec-title">Latenzverlauf</div>${spark(t.hist, { w:460, h:70, color:`var(--${t.status === "ok" ? "ok" : t.status})` })}</div>` : ""}
        <p class="admin-hint" style="margin:0">${t.probe
          ? `Gemessen wird durch den Tunnel auf die Gegenstelle im Transfernetz. Das braucht keinerlei Zugangsdaten
             und beantwortet die Frage, die zählt: trägt die Strecke gerade?`
          : `Für diese Strecke gibt es keine Gegenstelle im Transfernetz — der Zustand kommt allein aus dem Handshake
             des verknüpften Peers. Der sagt, wann die Strecke zuletzt stand, nicht ob gerade etwas hindurchkommt.
             Eine Adresse im Transfernetz nachzutragen ist die belastbarere Messung.`}</p>`,
      foot:`
        <button class="btn btn--primary" data-action="system" data-id="${esc(t.id)}">Verlauf über Tage</button>
        <button class="btn" data-action="check-now">Jetzt prüfen</button>
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
          <dt>WAN IPv4</dt><dd>${wanZeile(s)}</dd>
          <dt>WAN IPv6</dt><dd class="mono">${esc(s.wan6Ist || s.wan6 || "—")}${
            s.wan6Ist && s.wan6 && s.wan6 !== "—" && s.wan6 !== s.wan6Ist
              ? ` <span class="faint" style="color:var(--warn)">eingetragen steht ${esc(s.wan6)}</span>` : ""}</dd>
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
const RENDERERS = { kurz:viewKurz, lage:viewLage, sites:viewSites, virt:viewVirt, compute:viewCompute, netz:viewNetz, vpn:viewVpn,
  dienste:viewDienste, mail:viewMail, post:viewPost, links:viewLinks, cfg:viewCfg, verwaltung:viewVerwaltung,
  /* Keine Schaltfläche in der Leiste: diese Seite gehört immer zu einem
     bestimmten Gegenstand und wird über #/system/<kennung> erreicht. */
  system:viewSystem };

function render() {
  const scroll = $("#scroll") ? $("#scroll").scrollTop : 0;
  /* Die Schublade hat einen eigenen Bildlauf — ein langes Systemformular
     passt nicht auf einen Schirm. Ohne das hier stünde man nach jedem
     Strich wieder oben. */
  const lauf = $(".inspector-body") ? $(".inspector-body").scrollTop : 0;

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
  if ($(".inspector-body")) $(".inspector-body").scrollTop = lauf;
  if (focus) {
    const el = $(focus.sel);
    if (el) { el.focus(); try { el.setSelectionRange(focus.pos, focus.pos); } catch {} }
  }
  sortierungAnwenden();
  const pq = $("#pq");
  if (pq) { pq.focus(); pq.setSelectionRange(pq.value.length, pq.value.length); }
  /* Ein vollständiger Strich holt nach, was aufgeschoben war. */
  aufschubSeit = 0;
  aufgeschoben = false;
}

/* Nur die Schublade nachziehen.

   Ein Klick im Formular ändert das Formular — nicht die Seite darunter.
   Trotzdem hat bisher jeder Klick alles neu gezeichnet: Leiste, Kopf,
   Inhalt und die Schublade selbst. Das war das Flackern beim Wählen eines
   Typs, und nebenbei sprang der Bildlauf im Formular nach oben.

   Nachgezogen werden deshalb nur Rumpf und Fuß. Der Rahmen der Schublade
   bleibt stehen, mit ihm die Einblendbewegung. Ist gar kein Formular mehr
   offen — gerade gespeichert —, zeichnet diese Funktion die ganze Seite:
   dann ist die Seite darunter wieder das Thema, und sie ist inzwischen
   mehrere Zustände alt. */
function zeichneFormular() {
  const f = state.form;
  const rumpf = $(".inspector-body"), fuss = $(".inspector-foot");
  if (!f || !f.open || !rumpf || !fuss) { render(); return; }

  collectForm();
  const a = document.activeElement;
  const sel = a && a.dataset.field ? `[data-field="${a.dataset.field}"]`
    : a && a.dataset.cred ? `[data-cred="${a.dataset.cred}"]` : null;
  const pos = a ? a.selectionStart : null;
  const lauf = rumpf.scrollTop;

  rumpf.innerHTML = formRumpf(f);
  fuss.innerHTML = formFuss(f);
  rumpf.scrollTop = lauf;

  if (sel) {
    const el = rumpf.querySelector(sel);
    if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
  }
}

/* ---------- Spalten sortieren ----------

   Sortiert wird, was dasteht — nicht, was dahinter liegt. Das klingt nach
   einer Abkürzung und ist eine Entscheidung: die Ansichten sind reine
   Funktionen von Zustand nach HTML, und jede Tabelle bräuchte sonst eine
   eigene Liste von Vergleichsfunktionen, die zu dem passt, was sie gerade
   anzeigt. Zwanzig solcher Listen wären zwanzig Gelegenheiten, dass die
   Spalte anders sortiert, als sie beschriftet ist.

   Was in einer Zelle steht, ist deshalb der Wert — und der Vergleich
   versteht die Schreibweisen, die in diesem Werkzeug vorkommen: Mengen mit
   Einheit („1.1 GB"), Zeiten („12 ms", „3 T"), Prozente, Zeitpunkte
   („14:15", „23.08. 14:15"). Eine Zelle ohne Text ist die Ampel; dann
   gilt der Zustand der Zeile, nach Dringlichkeit geordnet.

   Ein Strich bleibt hinten, in beiden Richtungen. Er ist keine Null, und
   eine Spalte, die mit lauter Unbekanntem anfängt, hätte niemandem
   geholfen. */
const SEV_RANG = { crit: 0, warn: 1, info: 2, ok: 3, idle: 4, unknown: 5 };

const EINHEIT = {
  "%": 1,
  b: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776, pb: 1125899906842624,
  ms: 1, s: 1000, min: 60000, h: 3600000, t: 86400000
};

/* Eine Zahl am Anfang, höchstens hinter einem kurzen Wörtchen („in 9 T",
   „vor 3 min"). Ein Name wie „pve-hq-01" fällt hier bewusst durch: dort
   steht die Ziffer nicht für eine Menge. */
const ZAHL = /^(?:[a-zäöüß~]{1,5}\s+)?([-+]?\d+(?:[.,]\d+)?)\s*([%a-zA-Z]*)/i;

/* „14:15" ist von heute, „23.08. 14:15" von einem früheren Tag. Ohne
   Jahr — für eine Tabelle, die Stunden und Tage vergleicht, genügt das,
   und mehr steht in der Zelle auch nicht. */
const HEUTE = 12_000_000;
function zeitWert(t) {
  let m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) return HEUTE + Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{1,2})\.(\d{1,2})\.\s*(\d{1,2}):(\d{2})$/.exec(t);
  if (m) return Number(m[2]) * 100000 + Number(m[1]) * 1000 + Number(m[3]) * 60 + Number(m[4]);
  return null;
}

function sortWert(text, sev) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return sev ? { n: SEV_RANG[sev] ?? 9 } : { leer: true };
  if (/^[—–-]$/.test(t)) return { leer: true };
  const z = zeitWert(t);
  if (z != null) return { n: z };
  const m = ZAHL.exec(t);
  if (m) return { n: Number(m[1].replace(",", ".")) * (EINHEIT[m[2].toLowerCase()] ?? 1) };
  return { s: t.toLowerCase() };
}

/* Zahlen vor Text: mischt eine Spalte beides, ist die Zahl die Auskunft
   und das Wort der Ersatz dafür („nie", „nicht gemeldet"). */
function sortPaar(a, b) {
  if (a.n != null && b.n != null) return a.n - b.n;
  if (a.n != null) return -1;
  if (b.n != null) return 1;
  return String(a.s).localeCompare(String(b.s), "de");
}

/* Gibt die neue Reihenfolge als Liste von Indizes zurück — die Zeilen
   selbst rührt erst die Anzeige an. Gleiche Werte behalten die
   Reihenfolge der Ansicht. */
function sortReihenfolge(zellen, richtung) {
  return zellen
    .map((z, i) => ({ w: sortWert(z.text, z.sev), i }))
    .sort((a, b) => {
      if (a.w.leer && b.w.leer) return a.i - b.i;
      if (a.w.leer) return 1;
      if (b.w.leer) return -1;
      return sortPaar(a.w, b.w) * richtung || a.i - b.i;
    })
    .map(x => x.i);
}

/* Auf, ab, gar nicht. Die dritte Runde stellt die Ordnung der Ansicht
   wieder her — und die ist meist die nach Dringlichkeit, also die
   einzige, die von selbst das Wichtige nach oben bringt. */
function sortKlick(id, spalte) {
  const st = state.sort[id];
  if (!st || st.spalte !== spalte) state.sort[id] = { spalte, richtung: 1 };
  else if (st.richtung > 0) state.sort[id] = { spalte, richtung: -1 };
  else delete state.sort[id];
  return state.sort[id] || null;
}

/* Eine Tabelle wiedererkennen, ohne dass jede Ansicht ihr einen Namen
   geben muss: Ansicht und Spaltenüberschriften. Ändert sich die Tabelle,
   fällt ihre Sortierung weg — das ist richtig so, sie meinte etwas
   anderes. */
function tabellenId(kopf) {
  return [state.view, state.adminTab || "", ...kopf].join("|");
}

/* Die einzige Stelle, die den Baum anfasst: Kopfzellen anklickbar machen
   und die Zeilen in die gemerkte Reihenfolge bringen. Läuft nach jedem
   Zeichnen, weil jedes Zeichnen die Tabelle neu aufbaut. */
function sortierungAnwenden() {
  const wrap = $("#wrap");
  if (!wrap || typeof wrap.querySelectorAll !== "function") return;
  for (const tab of wrap.querySelectorAll("table.t")) {
    const kopf = tab.querySelector("thead tr");
    const body = tab.querySelector("tbody");
    if (!kopf || !body) continue;
    const spalten = [...kopf.children];
    /* Nur echte Datenzeilen: die Zeile „nichts angelegt" ist eine einzige
       Zelle über die ganze Breite und gehört nirgendwohin sortiert. */
    const zeilen = [...body.children].filter(tr => tr.children.length === spalten.length);
    if (zeilen.length < 2) continue;

    const id = tabellenId(spalten.map(th => th.textContent.trim()));
    const st = state.sort[id];
    spalten.forEach((th, i) => {
      /* Die erste Spalte trägt die Ampel und hat deshalb keine
         Überschrift — sie ist trotzdem die nützlichste zum Sortieren.
         Eine andere Spalte ohne Überschrift trägt Knöpfe; die nach ihrer
         Beschriftung zu ordnen, ergäbe nichts. */
      if (i > 0 && !th.textContent.trim()) return;
      th.dataset.action = "sort";
      th.dataset.tab = id;
      th.dataset.spalte = String(i);
      if (i === 0 && !th.textContent.trim()) th.title = "nach Ampel sortieren";
      if (st && st.spalte === i) {
        th.setAttribute("aria-sort", st.richtung > 0 ? "ascending" : "descending");
        th.innerHTML += `<span class="th-pfeil">${st.richtung > 0 ? "▲" : "▼"}</span>`;
      }
    });
    if (!st) continue;

    const zellen = zeilen.map(tr => ({
      text: tr.children[st.spalte]?.dataset?.sort ?? tr.children[st.spalte]?.textContent ?? "",
      sev: tr.dataset?.sev || null
    }));
    for (const i of sortReihenfolge(zellen, st.richtung)) body.appendChild(zeilen[i]);
  }
}

/* ---------- Neuzeichnen aus dem Netz: nicht mitten in eine Eingabe ----------

   Alle 15 Sekunden kommt ein neuer Zustand und die Seite wird neu
   gezeichnet. Getippte Eingaben überleben das — `render` sichert sie und
   setzt Fokus und Schreibmarke zurück. Ein aufgeklapptes Auswahlmenü
   überlebt es nicht: es hängt am Knoten des <select>, und mit dem ist es
   weg. Wer eine Gegenstelle aus einer langen Liste sucht, wird also alle
   15 Sekunden herausgeworfen — und zwar aus dem einen Formular, in dem
   Sorgfalt am nötigsten ist.

   Zurücksetzen lässt sich ein offenes Menü nicht; ein Browser öffnet es
   nur auf eine echte Geste hin. Aufgeschoben wird deshalb das Bild, nicht
   die Daten: die stehen bereits im Zustand, und der nächste Strich holt
   sie ein.

   Das allein reichte nicht. Ein Menü zu schonen, hilft wenig, wenn der
   nächste Zustand direkt danach zuschlägt: kaum war ein Typ gewählt,
   zeichnete alles neu — die Schublade sprang in ihre Einblendbewegung
   zurück, der Bildlauf nach oben. Wer ein Gerät anlegt, ist aber mehrere
   Minuten in diesem Formular. Deshalb zwei Regeln statt einer:

     · Solange ein Formular offen ist, zeichnet der Zustandsstrom die
       Seite darunter **gar nicht** (`formularOffen`). Sie liegt hinter
       einem Schleier; dort liest niemand Ampeln ab.
     · Was der Benutzer im Formular selbst auslöst, zieht nur die
       Schublade nach (`zeichneFormular`) — nicht Leiste, Kopf und
       Inhalt.

   Die Obergrenze gilt damit noch für den Fall ohne Formular: jemand
   klappt ein Menü in einer Tabelle auf und geht weg. Eine Überwachung,
   die stehenbleibt und dabei aktuell aussieht, wäre das schlechtere
   Übel. */
const AUFSCHUB_MAX = 120000;
let aufschubSeit = 0, aufgeschoben = false;

function waehltGerade() {
  const a = document.activeElement;
  return !!a && String(a.tagName || "").toLowerCase() === "select";
}

/* Ein offenes Formular ist eine Arbeit, keine Anzeige. Solange es steht,
   zeichnet der Zustandsstrom die Seite darunter gar nicht mehr — auch
   nicht nach zwei Minuten, denn hier gilt der Einwand von oben nicht: die
   Seite liegt hinter einem abgedunkelten Schleier, niemand liest dort
   Ampeln ab. Was weiterläuft, ist die Fußzeile der Leiste (`markSource`,
   außerhalb des Neuzeichnens): sie sagt weiter „Live · alle 15 s · 14:03",
   und bleibt der Dienst weg, steht sie sofort auf Rot. Die Daten kommen
   ohnehin an — nur ihr Bild wartet, bis das Formular zu ist. */
function formularOffen() {
  return !!(state.form && state.form.open);
}

function renderLive(jetzt = false) {
  if (!jetzt && formularOffen()) { aufgeschoben = true; return; }
  if (!jetzt && waehltGerade()) {
    if (!aufschubSeit) aufschubSeit = Date.now();
    if (Date.now() - aufschubSeit < AUFSCHUB_MAX) { aufgeschoben = true; return; }
  }
  render();
}

/* Ein gewählter Wert schließt das Menü — dann darf sofort nachgezogen
   werden, ohne auf den Fokuswechsel zu warten.

   Eine Auswahl im Formular zieht ohnehin ein Neuzeichnen nach sich: unter
   ihr steht, was von ihr abhängt — die Zugangsfelder zum gewählten Typ,
   die Adressen aus dem gewählten Peer. Ohne das stünde dort bis zum
   nächsten Zustand aus dem Netz die Antwort auf die vorige Frage. */
document.addEventListener("change", ev => {
  if (formularOffen()) { if (ev.target?.dataset?.field) zeichneFormular(); return; }
  if (aufgeschoben) renderLive(true);
});
/* `focusout` statt `blur`: nur das steigt auf und ist von hier zu hören.
   Der Umweg über die Ereigniswarteschlange, damit erst der Fokus steht
   und dann gezeichnet wird. */
document.addEventListener("focusout", () => { if (aufgeschoben && !formularOffen()) setTimeout(() => renderLive(true), 0); });

/* Die Adresszeile trägt die Ansicht — und bei der Detailseite auch den
   Gegenstand. Damit ist ein einzelnes System verlinkbar und der Zurück-
   Knopf des Browsers tut das, was er soll. */
function go(view, arg) {
  state.view = view;
  state.inspector = null;
  state.paletteOpen = false;
  location.hash = "#/" + view + (arg ? "/" + encodeURIComponent(arg) : "");
  render();
}
function open(kind, id) {
  /* Ein System hat eine eigene Seite, keine Schublade. */
  if (kind === "host") return openSystem(id);
  state.inspector = { kind, id };
  state.paletteOpen = false;
  render();
}

/* ---------- Detailseite ---------- */
function openSystem(id) {
  const tage = state.detail?.tage || 1;
  state.detail = { id, tage, daten: null, busy: true, error: null, geladen: 0,
    /* Die gewählte Schnittstelle gehört zu diesem System — beim Wechsel
       auf ein anderes fängt sie von vorn an, sonst zeigte die Seite den
       Verlauf einer Leitung, die es dort gar nicht gibt. */
    iface: null, ifDaten: null, ifBusy: false, ifError: null };
  state.diagnose = null;
  go("system", id);
  ladeVerlauf();
}

/* Der Verlauf einer einzelnen Schnittstelle — eigener Abruf unter der
   Kennung `system|schnittstelle`, mit demselben Zeitraum wie oben. */
async function ladeIfVerlauf() {
  const d = state.detail;
  if (!d || !d.iface) return;
  if (!LIVE()) { d.ifError = "kein Dienst erreichbar"; d.ifBusy = false; render(); return; }
  const angefragt = `${d.id}|${d.iface}/${d.tage}`;
  d.ifBusy = true;
  render();
  try {
    const daten = await window.LEITSTAND.call("GET", `/api/verlauf/${encodeURIComponent(d.id + "|" + d.iface)}?tage=${d.tage}`);
    if (!state.detail || `${state.detail.id}|${state.detail.iface}/${state.detail.tage}` !== angefragt) return;
    state.detail.ifDaten = daten;
    state.detail.ifError = null;
  } catch (e) {
    if (!state.detail || `${state.detail.id}|${state.detail.iface}/${state.detail.tage}` !== angefragt) return;
    state.detail.ifError = e.message;
  } finally {
    if (state.detail && `${state.detail.id}|${state.detail.iface}/${state.detail.tage}` === angefragt) {
      state.detail.ifBusy = false;
      render();
    }
  }
}

/* Der Verlauf kommt aus einem eigenen Abruf, nicht aus dem Zustandsstrom:
   er ist groß, ändert sich langsam und geht nur diese eine Seite an. */
async function ladeVerlauf() {
  const d = state.detail;
  if (!d) return;
  if (!LIVE()) { d.error = "kein Dienst erreichbar"; d.busy = false; render(); return; }
  const angefragt = `${d.id}/${d.tage}`;
  d.busy = true;
  render();
  try {
    const daten = await window.LEITSTAND.call("GET", `/api/verlauf/${encodeURIComponent(d.id)}?tage=${d.tage}`);
    /* Zwischenzeitlich weitergeklickt? Dann gehört diese Antwort nicht
       mehr auf den Schirm. */
    if (!state.detail || `${state.detail.id}/${state.detail.tage}` !== angefragt) return;
    state.detail.daten = daten;
    state.detail.error = null;
  } catch (e) {
    if (!state.detail || `${state.detail.id}/${state.detail.tage}` !== angefragt) return;
    state.detail.error = e.message;
  } finally {
    if (state.detail && `${state.detail.id}/${state.detail.tage}` === angefragt) {
      state.detail.busy = false;
      state.detail.geladen = Date.now();
    }
    render();
  }
}

/* Zurück, ohne die Seite zu verlassen: der Browser weiß, woher man kam.
   Gibt es keinen Verlauf (direkt aufgerufener Link), führt der Weg auf
   die Systemliste statt ins Leere. */
function zurueck() {
  if (window.history && window.history.length > 1) window.history.back();
  else go("sites");
}
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
    case "system": ev.preventDefault(); openSystem(el.dataset.id); break;
    case "zurueck": ev.preventDefault(); zurueck(); break;
    case "verlauf-tage": if (state.detail) {
      state.detail.tage = Number(el.dataset.tage) || 1;
      state.detail.daten = null; state.detail.ifDaten = null;
      ladeVerlauf();
      /* Der Zeitraum gilt für beide Diagramme — sonst stünden zwei
         Zeitachsen untereinander, die verschiedene Tage zeigen. */
      if (state.detail.iface) ladeIfVerlauf();
    } break;
    case "verlauf-neu": if (state.detail) { ladeVerlauf(); if (state.detail.iface) ladeIfVerlauf(); } break;
    case "if-verlauf": if (state.detail) {
      const gewaehlt = el.dataset.if;
      /* Noch einmal auf dieselbe Leitung klappt sie wieder zu — dann steht
         die Übersicht über alle wieder da. */
      state.detail.iface = state.detail.iface === gewaehlt ? null : gewaehlt;
      state.detail.ifDaten = null; state.detail.ifError = null;
      if (state.detail.iface) ladeIfVerlauf(); else render();
    } break;
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
    case "admintab":
      state.adminTab = el.dataset.tab;
      if (state.adminTab === "staende") ladeStaende();
      render(); break;
    case "admin-new": state.inspector = null; openForm(el.dataset.kind, "new"); break;
    case "admin-edit": state.inspector = null; openForm(el.dataset.kind, "edit", el.dataset.id); break;
    case "admin-delete": adminDelete(el.dataset.kind, el.dataset.id); break;
    case "admin-reload": state.rawLinks = null; adminCall("POST", "/api/admin/reload", null, "Bestand neu eingelesen"); break;
    case "admin-restore": adminRestore(el.dataset.quelle); break;
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
      zeichneFormular(); break;
    }
    /* Auf, ab, gar nicht. Die dritte Runde stellt die Ordnung der Ansicht
       wieder her — und die ist meist die nach Dringlichkeit, also die
       einzige, die von selbst das Wichtige nach oben bringt. */
    case "sort": sortKlick(el.dataset.tab, Number(el.dataset.spalte)); render(); break;
    /* Eine Prüfung an- oder abwählen. Wie beim Schalter: erst einsammeln,
       was in den Feldern steht, sonst geht es beim Neuzeichnen verloren. */
    case "form-check": {
      const f = state.form; if (!f) break;
      collectForm();
      const liste = new Set(f.data.pruef || []);
      if (liste.has(el.dataset.id)) liste.delete(el.dataset.id); else liste.add(el.dataset.id);
      f.data.pruef = [...liste];
      zeichneFormular(); break;
    }
    case "form-set": {
      const f = state.form; if (!f) break;
      collectForm();
      f.data[el.dataset.field] = el.dataset.value;
      zeichneFormular(); break;
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

/* #/compute  oder  #/system/pve-01 */
/* Schmal genug, dass eine Tabelle mit acht Spalten keine Freude mehr
   macht. Kein Browser? Dann nicht schmal — im Zweifel die reichere
   Ansicht, sie verschweigt nichts. */
function schmalerSchirm() {
  try { return !!window.matchMedia && window.matchMedia("(max-width: 700px)").matches; }
  catch { return false; }
}

function ausAdresse() {
  const roh = String(location.hash || "").replace(/^#\/?/, "");
  const [view, ...rest] = roh.split("/");
  return { view, arg: rest.length ? decodeURIComponent(rest.join("/")) : null };
}

window.addEventListener("hashchange", () => {
  const { view, arg } = ausAdresse();
  if (!RENDERERS[view]) return;
  if (view === "system") {
    if (!arg) return;
    /* Zurück auf dieselbe Seite ist kein neuer Abruf. */
    if (state.detail?.id === arg && state.view === "system") return;
    state.view = "system";
    state.detail = { id: arg, tage: state.detail?.tage || 1, daten: null, busy: true, error: null, geladen: 0 };
    ladeVerlauf();
    return;
  }
  if (view !== state.view) { state.view = view; render(); }
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
  renderLive();
  markSource();

  /* Der Verlauf hängt nicht am Zustandsstrom — er wird beim Öffnen der
     Seite geholt und danach im Minutentakt aufgefrischt. Öfter hätte
     keinen Sinn: schneller als der Takt der Ablage entstehen keine neuen
     Punkte. */
  const d = state.detail;
  if (state.view === "system" && d && !d.busy && (!d.daten || Date.now() - d.geladen > 60000)) ladeVerlauf();
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
  const { view, arg } = ausAdresse();
  if (RENDERERS[view]) state.view = view;
  /* Ohne Ansicht in der Adresse entscheidet der Schirm: auf einem Telefon
     ist die Kurzlage die einzige Seite, die man im Gehen lesen kann; auf
     einem Schirm bleibt es beim Lagebild. Nur die Vorauswahl hängt daran —
     erreichbar sind beide von überall, und ein Lesezeichen mit Ansicht
     sticht diese Regel. */
  else if (schmalerSchirm()) state.view = "kurz";
  /* Eine Detailseite ist verlinkbar: geladen wird sie erst, wenn der
     Dienst antwortet — vorher gäbe es nichts zu zeigen. */
  if (view === "system" && arg) state.detail = { id: arg, tage: 1, daten: null, busy: true, error: null, geladen: 0 };

  const L = window.LEITSTAND;
  if (!L) { state.offline = "Kein Dienst erreichbar"; render(); markSource(); return; }

  /* Angemeldet wird immer — auch dann, wenn der erste Zustand längst da ist.

     Hier stand einmal `if (L.pending)`: nur wer früh genug dran war, bekam
     die Anmeldung. Auf dem Telefon lädt diese Datei über dieselbe langsame
     Strecke wie die Antwort des Dienstes, und war die Antwort zuerst da,
     meldete sich niemand mehr an. Die Seite behauptete dann, es gäbe keinen
     Dienst — und blieb dabei, weil auch „Erneut verbinden" nur einen
     Zustand holte, den keiner mehr entgegennahm. Am Schreibtisch fiel das
     nie auf: dort liegt app.js im Zwischenspeicher und ist vorher da.

     Der Zustandsstrom reicht einer späten Anmeldung jetzt nach, was sie
     verpasst hat; hier wird nur noch die Anzeige darauf eingestellt. */
  state.connecting = !!L.pending;
  L.onState(st => { applyLive(st); if (!state.adminLoaded) loadAdmin(); });
  L.onFail(msg => { state.connecting = false; state.offline = msg; renderLive(); markSource(); });
  L.onStale(() => { renderLive(); markSource(); });
  render();
  markSource();
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
    /* Die Ansicht führt Prüfungen als *Ergebnisse* — Art, Port, Ampel. Was
       davon in der Datei steht (eigener servername, eigene Abfrage), sieht
       man ihr nicht an. Fürs Formular deshalb der Rohbestand. */
    state.rawHosts = inv.hosts || [];
    /* Die Startseite wird als Ganzes geschrieben; dafür braucht die
       Verwaltung den Rohbestand, nicht die aufbereitete Ansicht. Ein
       angefangener, noch nicht gespeicherter Stand darf dabei nicht
       verlorengehen — nur ein ausdrückliches „Verwerfen" holt neu. */
    if (!state.rawLinks) state.rawLinks = inv.links || [];
    state.adminLoaded = true;
    /* Steht ein Formular offen, gilt dasselbe wie für den Zustandsstrom:
       nur die Schublade, die Seite darunter wartet. */
    if (formularOffen()) zeichneFormular(); else render();
  } catch (e) { console.warn("Verwaltung nicht ladbar:", e.message); }
}

function openForm(kind, mode, id) {
  let data = {};
  if (mode === "edit") {
    if (kind === "hosts") {
      const h = byId(state.hosts, id);
      const eigen = h.schwellenEigen || {};
      const roh = (state.rawHosts || []).find(x => String(x.id) === String(id)) || {};
      const pruef = pruefAusChecks(roh.checks);
      data = { id: h.id, type: h.type, site: h.site, ip: h.ip || "", url: h.url || "", role: h.role || "", monitor: h.monitored !== false,
        tls_ignore: !!h.tlsIgnore,
        /* Nur die selbst gesetzten kommen ins Formular. Stünden die
           geltenden drin, schriebe jedes Speichern die globalen Werte als
           eigene fest — und eine spätere Änderung an den Einstellungen
           erreichte dieses System nie mehr. */
        s_disk_warn: eigen.disk_warn ?? "", s_disk_crit: eigen.disk_crit ?? "",
        s_ram_warn: eigen.ram_warn ?? "", s_ram_crit: eigen.ram_crit ?? "",
        /* Angehakt wird, was gerade wirklich geprüft wird — abgeleitet wie
           eigen. Der Schalter daneben sagt, welches von beidem es ist. */
        checksEigen: !!roh.checksEigen,
        pruef: pruef.ids, pruefExtra: pruef.extra, pruefPorts: "", pruefRest: pruef.rest };
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
      /* `t.iface` ist der geltende Name — bei einer Verknüpfung der von
         der Firewall gelesene. Ins Formular gehört nur, was von Hand
         gesetzt wurde: sonst schriebe das nächste Speichern den gelesenen
         Namen als eigene Angabe fest. */
      const eigenesIface = t.peer ? "" : (t.iface || "");
      data = { id: t.id, a: t.a, b: t.b, iface: eigenesIface, net: t.net || "",
        /* Steht der Name unter dem, was die Firewalls melden, ist er
           auswählbar — sonst wurde er getippt und bleibt es. */
        ifaceWahl: !eigenesIface ? ""
          : PEERS.some(p => p.iface === eigenesIface) ? eigenesIface : "__frei",
        probeIp: t.probe || "", probePort: t.probePort || "",
        /* Der hinterlegte Peer bleibt im Formular erhalten, auch wenn die
           Firewall ihn gerade nicht meldet — sonst löschte allein das
           Öffnen des Formulars eine gültige Verknüpfung. */
        peerOrig: t.peer || null,
        peerRef: t.peer ? (peerRefOf(t.peer) || "__gespeichert") : "",
        peerBOrig: t.peerB || null,
        peerBRef: t.peerB ? (peerRefOf(t.peerB) || "__gespeichert") : "" };
    }
  } else {
    const erster = (SITES[0] || {}).id;
    if (kind === "hosts") data = { type: "pve", site: erster, monitor: true, pruef: ["icmp:"], pruefExtra: [], pruefRest: [] };
    if (kind === "sites") data = { primary: !SITES.length };   /* der erste Standort ist der Hauptstandort */
    /* Kein vorgetragenes „wg0" mehr: das Interface kommt entweder vom
       verknüpften Peer oder aus dem, was die Firewalls melden. Ein
       Vorschlag im Feld wäre eine Behauptung über ein Gerät, das der
       Leitstand noch gar nicht kennt. */
    if (kind === "tunnels") data = { a: erster, b: (SITES[1] || SITES[0] || {}).id, ifaceWahl: "" };
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
    d.probe = { ip: String(d.probeIp ?? "").trim() };
    if (d.probePort) d.probe.port = Number(d.probePort);
    delete d.probeIp; delete d.probePort;

    /* Ausdrücklich null, nicht weglassen: nur so löst der Dienst eine
       bestehende Verknüpfung wieder — ein fehlendes Feld ließe die alte
       stehen, weil die Änderung auf den bestehenden Eintrag gelegt wird. */
    const aus = (ref, orig) => {
      if (!ref) return null;
      if (ref === "__gespeichert") return orig || null;
      const p = PEERS.find(x => x.id === ref);
      return p ? { host: p.von, iface: p.iface || undefined, name: p.name, key: p.key || undefined } : null;
    };
    const a = aus(d.peerRef, f.data.peerOrig);
    const b = aus(d.peerBRef, f.data.peerBOrig);
    delete d.peerRef; delete d.peerBRef; delete d.peerOrig; delete d.peerBOrig;
    d.peer = a;
    d.peerB = b;

    /* Das Interface hat drei Herkünfte, und nur eine davon gehört in die
       Bestandsdatei: die selbst eingetragene. Meldet ein verknüpfter Peer
       einen Namen, wird die eigene Angabe ausdrücklich gelöscht — sie
       stünde sonst als zweite Quelle daneben und veraltete still, sobald
       jemand am Gerät etwas verschiebt. */
    const herkunft = ifaceHerkunft(f.data);
    const wahl = f.data.ifaceWahl;
    delete d.ifaceWahl;
    if (herkunft === "peer") d.iface = null;
    else if (herkunft === "auswahl") d.iface = wahl || null;
    else d.iface = d.iface || null;
  }
  if (f.kind === "hosts") {
    /* Die vier Felder wandern in ein `schwellen`-Objekt. Ausdrücklich
       `null`, wenn keines gefüllt ist — nur so löst der Dienst eine früher
       gesetzte Abweichung wieder, statt die alte stehen zu lassen. */
    const s = {};
    for (const k of ["disk_warn", "disk_crit", "ram_warn", "ram_crit"]) {
      const roh = String(d["s_" + k] ?? "").trim();
      delete d["s_" + k];
      if (!roh) continue;
      const n = Number(roh.replace(",", ".").replace("%", "").trim());
      if (Number.isFinite(n)) s[k] = Math.round(n);
    }
    d.schwellen = Object.keys(s).length ? s : null;

    /* Die Prüfliste geht **immer** mit — leer heißt „wieder ableiten".
       Ein Weglassen ließe eine früher eigene Liste stehen, und der
       Schalter im Formular hätte dann etwas anderes behauptet. */
    d.checks = d.checksEigen ? pruefZuChecks(d, portListe(d.pruefPorts)) : [];
    delete d.pruef; delete d.pruefExtra; delete d.pruefPorts; delete d.pruefRest; delete d.checksEigen;
  }
  for (const k of Object.keys(d)) if (d[k] === "") delete d[k];
  if (f.kind === "hosts") d.monitor = f.data.monitor !== false;
  /* Ausdrücklich false statt weglassen: nur so nimmt ein Speichern die
     Ausnahme wieder zurück, statt die alte stehen zu lassen. */
  if (f.kind === "hosts") d.tls_ignore = !!f.data.tls_ignore;
  if (f.kind === "sites") d.primary = !!f.data.primary;
  return d;
}

async function formTest() {
  collectForm();
  const f = state.form;
  f.busy = true; f.error = null; zeichneFormular();
  try {
    const cred = {};
    for (const [k, v] of Object.entries(f.cred || {})) if (v) cred[k] = v;
    f.test = await window.LEITSTAND.call("POST", "/api/admin/test", { ...formPayload(), credentials: Object.keys(cred).length ? cred : undefined });
  } catch (e) { f.error = e.message; }
  f.busy = false; zeichneFormular();
}

async function formSave() {
  collectForm();
  const f = state.form;
  if (!f.data.id) { f.error = "Kennung fehlt."; zeichneFormular(); return; }
  if (f.kind === "hosts" && f.data.checksEigen
      && !(f.data.pruef || []).length && !portListe(f.data.pruefPorts).length && !(f.data.pruefRest || []).length) {
    f.error = "Es ist keine Prüfung angehakt. Ein System ohne Prüfung wäre keine Überwachung, sondern ein Eintrag "
      + "in einer Liste — mindestens eine anhaken, oder den Schalter „Prüfungen selbst festlegen“ ausschalten.";
    zeichneFormular(); return;
  }
  if (f.kind === "tunnels" && !String(f.data.probeIp || "").trim() && !f.data.peerRef && !f.data.peerBRef) {
    f.error = "Ohne Gegenstelle im Tunnel und ohne verknüpften Peer gäbe es nichts zu messen — eines von beidem muss sein.";
    zeichneFormular(); return;
  }
  if (f.kind === "sites") {
    /* Vier Stellen, Land + Stadt. Gleich hier prüfen: eine Fehlermeldung
       am Feld ist hilfreicher als eine abgelehnte Antwort vom Server. */
    const k = String(f.data.short || "").trim().toUpperCase();
    if (!KUERZEL.test(k)) {
      f.error = "Das Kürzel muss vier Stellen haben: Land + Stadt, z. B. DEKO für Deutschland/Köln.";
      zeichneFormular(); return;
    }
    f.data.short = k;
  }
  if (!LIVE()) { f.error = "Kein Dienst erreichbar — nichts gespeichert."; zeichneFormular(); return; }
  f.busy = true; f.error = null; zeichneFormular();
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
  zeichneFormular();
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
    if (it) it[feld] = el.type === "checkbox" ? el.checked : el.value;
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
          /* Geprüft wird nur eine eigene Adresse ohne verknüpftes System —
             sonst hätte die Kachel zwei Ampeln und niemand wüsste, welche
             gerade gilt. */
          if (it.pruefen && o.url && !o.host) o.pruefen = true;
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

async function ladeStaende() {
  if (!LIVE()) return;
  try { state.staende = await window.LEITSTAND.call("GET", "/api/admin/staende"); }
  catch (e) { toast("Frühere Stände nicht ladbar", e.message, "crit"); }
  finally { state.staendeLaeuft = false; render(); }
}

/* Zurückholen ist der einzige Knopf hier, der einen bestehenden Bestand
   überschreibt. Also nennt die Rückfrage, was danach dasteht — und was
   gerade dasteht. Eine Rückfrage ohne Zahlen ist nur eine Verzögerung. */
async function adminRestore(quelle) {
  if (!requireLive()) return;
  const d = state.staende || {};
  const q = quelle === ".bak" ? d.sicherung : (d.archiv || []).find(a => a.name === quelle);
  if (!q) return;
  const jetzt = d.datei;
  const frage = `Stand vom ${fmtWhen(q.zeit)} zurückholen?

`
    + `Danach: ${q.hosts} Systeme, ${q.sites} Standorte, ${q.tunnels} Tunnel
`
    + `Jetzt:  ${jetzt && jetzt.lesbar ? `${jetzt.hosts} Systeme, ${jetzt.sites} Standorte, ${jetzt.tunnels} Tunnel` : "unlesbar"}

`
    + `Der jetzige Stand wird dabei als inventory.yaml.bak gesichert.`;
  if (!window.confirm(frage)) return;
  try {
    const r = await window.LEITSTAND.call("POST", "/api/admin/restore", { quelle });
    state.rawLinks = null;
    await loadAdmin();
    await ladeStaende();
    toast("Zurückgeholt", `${r.hosts} Systeme, ${r.sites} Standorte, ${r.tunnels} Tunnel aus ${r.quelle}.`, "ok");
  } catch (e) { toast("Nicht zurückgeholt", e.message, "crit"); }
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

window.LeitstandUI = { render, state, applyLive, go, openSystem };

/* ============================================================
   Ansicht: Verwaltung
   Systeme, Standorte und Tunnel anlegen und ändern — samt
   Zugangsdaten und Verbindungstest, ohne die Datei anzufassen.
   ============================================================ */
const HOST_TYPES = [
  ["pve", "Proxmox VE", 8006, true], ["pbs", "Proxmox Backup Server", 8007, true],
  ["pmg", "Proxmox Mail Gateway", 8006, true], ["opnsense", "OPNsense", 443, true],
  ["pfsense", "pfSense", 443, true], ["truenas", "TrueNAS SCALE", 443, false],
  ["mailcow", "Mailcow", 443, true], ["adguard", "AdGuard Home", 443, true],
  ["portainer", "Portainer", 9443, true], ["unifi", "UniFi Controller", 443, true],
  ["hass", "Home Assistant", 8123, false],
  ["other", "Sonstiges", 443, false]
];
const typeLabel = t => (HOST_TYPES.find(x => x[0] === t) || [, t])[1];
const typeHasApi = t => !!(HOST_TYPES.find(x => x[0] === t) || [])[3];

/* Jede Bauart meldet sich anders an: Proxmox über eine Token-Kopfzeile aus
   Benutzer, Token-ID und Geheimnis — OPNsense über HTTP Basic mit einem
   Schlüsselpaar. Ein gemeinsames Formular für beides führte nur dazu, dass
   man Felder ausfüllt, die niemand liest. */
function zugangsFelder(type, cred, getippt) {
  /* AdGuard kennt keinen eigenen Nur-Lese-Zugang: es sind dieselben Daten,
     mit denen man sich an der Oberfläche anmeldet. Der Leitstand ruft
     ausschließlich lesende Endpunkte auf. */
  if (type === "adguard") return `
    <div class="admin-grid">
      ${inpc("user", "Benutzer", cred, "wie an der AdGuard-Oberfläche", getippt)}
      ${inpc("password", "Passwort", cred, cred.password ? "hinterlegt — leer lassen, um es zu behalten" : "dasselbe wie an der Oberfläche", getippt)}
    </div>
    <p class="admin-hint" style="margin:8px 0 0">Gelesen werden <span class="mono">/control/status</span>,
    <span class="mono">/control/stats</span> und die Filterlisten — Anfragen, Blockanteil, mittlere Bearbeitungszeit
    und vor allem, <b>ob der Schutz überhaupt an ist</b>. Liegt die Oberfläche hinter einem Reverse Proxy unter einem
    Unterpfad, gehört dieser mit in die Adresse (<span class="mono">https://proxy/adguard</span>).</p>`;

  /* Der Mail Gateway sieht aus wie Proxmox und meldet sich an wie eine
     Weboberfläche: **er kennt keine API-Token.** Die API-Dokumentation
     weist sie an jedem Endpunkt aus — der Dienst weist sie ab, noch vor
     jeder Rechteprüfung. Wer hier drei Felder für Token-ID und Geheimnis
     vorfände, würde sie ausfüllen und bekäme eine 401 ohne Hinweis
     darauf, dass nicht das Geheimnis falsch ist, sondern das Verfahren. */
  if (type === "pmg") return `
    <div class="admin-grid">
      ${inpc("user", "Benutzer@Realm", cred, "leitstand@pmg", getippt)}
      ${inpc("password", "Passwort", cred, cred.password ? "hinterlegt — leer lassen, um es zu behalten" : "wie an der Oberfläche des Gateways", getippt)}
    </div>
    <p class="admin-hint" style="margin:8px 0 0"><b>Der Mail Gateway kennt keine API-Token</b> — anders als Proxmox VE
    und der Backup Server. Angemeldet wird mit Benutzer und Passwort gegen <span class="mono">/access/ticket</span>;
    das Ticket gilt zwei Stunden und wird erneuert, ohne dass sich jemand darum kümmern muss.<br><br>
    Anzulegen unter <span class="mono">Configuration → User Management</span>, Realm <span class="mono">pmg</span>,
    Rolle <span class="mono">Auditor</span>. Sie deckt alles ab, was gelesen wird: Statistik, Warteschlange,
    Dienste, Quarantänegröße und Signaturstand — <b>geschrieben wird nichts</b>. Der Benutzername gehört
    <b>mit Realm</b> hierher: ohne ihn hängt PMG <span class="mono">@quarantine</span> an und lehnt ab.</p>`;

  /* Mailcow: ein Schlüssel — und eine Adressliste, an der die meisten
     zuerst scheitern. Beides gehört ins Formular, sonst sucht man den
     Fehler beim Schlüssel. */
  if (type === "mailcow") return `
    <div class="admin-grid">
      ${inpc("apiKey", "API-Schlüssel", cred, cred.apiKey ? "hinterlegt — leer lassen, um ihn zu behalten" : "aus Configuration → Access → API", getippt)}
    </div>
    <p class="admin-hint" style="margin:8px 0 0">In mailcow unter
    <span class="mono">Configuration → Access → API</span> erzeugen — <b>„Read-Only Access“ genügt</b>, damit sind
    Anlegen, Ändern und Löschen serverseitig gesperrt.<br><br>
    <b>Wichtiger als der Schlüssel ist das Feld „allow from“:</b> mailcow prüft die Quell-IP und antwortet sonst
    mit derselben <span class="mono">401</span> wie bei einem falschen Schlüssel. Hinter einem Reverse Proxy ist das
    dessen Adresse und nicht die des Leitstands — welche mailcow tatsächlich gesehen hat, steht in der
    <b>Diagnose</b>.<br><br>
    Gelesen werden Container, Warteschlange (samt Grund, warum eine Mail liegt), Platz der Postfachablage,
    Domänen, Postfächer mit ihrer Quote, rspamd-Zahlen und der Umfang der Quarantäne — <b>nicht deren Inhalt</b>:
    Betreff, Absender und Empfänger bleiben auf dem Mailserver.</p>`;

  /* UniFi kennt zwei Wege hinein, und sie sind nicht gleichwertig: der
     Schlüssel ist bequemer und übersteht eine Zwei-Faktor-Anmeldung, die
     klassische API mit Benutzer und Passwort liefert mehr Zahlen. Beide
     stehen deshalb hier, mit dem Unterschied dabei — sonst füllt man eins
     aus und wundert sich, dass die Kanalbelegung fehlt. */
  if (type === "unifi") return `
    <div class="admin-grid">
      ${inpc("apiKey", "API-Schlüssel", cred, cred.apiKey ? "hinterlegt — leer lassen, um ihn zu behalten" : "Network 9+: Control Plane → Integrations", getippt)}
      ${inpc("user", "Benutzer", cred, "Konto mit der Rolle Viewer", getippt)}
      ${inpc("password", "Passwort", cred, cred.password ? "hinterlegt — leer lassen, um es zu behalten" : "wie an der Oberfläche des Controllers", getippt)}
      ${inpc("site", "Site", cred, "leer: die erste, die der Zugang sieht", getippt)}
    </div>
    <p class="admin-hint" style="margin:8px 0 0"><b>Eines von beidem genügt, beides ist besser.</b>
    Der <b>Schlüssel</b> ist der ruhigere Weg — er kommt ohne Zwei-Faktor-Anmeldung aus und erbt die Rolle seines
    Kontos. <b>Benutzer und Passwort</b> öffnen die klassische API, und nur die kennt
    <b>Kanalbelegung, Sendeleistung und Clientzahlen je Funkmodul</b>; die offizielle Integration-API liefert
    Zustand, Modell und Fassung, sonst nichts. Liegt beides vor, wird der Schlüssel zuerst versucht und bei
    Ablehnung auf die Anmeldung zurückgefallen.<br><br>
    Anzulegen unter <span class="mono">Settings → Admins &amp; Users</span> mit der Rolle
    <span class="mono">Viewer</span> — <b>nur lesen</b>. Der Port gehört mit in die Adresse: UniFi OS (Dream
    Machine, Cloud Key Gen2) antwortet auf <span class="mono">443</span>, eine selbst betriebene Network
    Application auf <span class="mono">8443</span>.<br><br>
    Gelesen werden Geräte, Zustand, Uplink, Funkmodule und die Teilsysteme des Controllers.
    <b>Die Clientliste wird nicht gelesen</b> — nur ihre Anzahl: eine Überwachung ist kein
    Anwesenheitsprotokoll.</p>`;

  if (type === "portainer") return `
    <div class="admin-grid">
      ${inpc("token", "API-Token", cred, cred.token ? "hinterlegt — leer lassen, um ihn zu behalten" : "aus „My account“ → „Access tokens“", getippt)}
    </div>
    <p class="admin-hint" style="margin:8px 0 0">In Portainer oben rechts unter
    <span class="mono">My account → Access tokens</span> erzeugen; er ist nur beim Anlegen zu sehen. Dem Benutzer je
    Umgebung die Rolle <span class="mono">read-only</span> geben (<span class="mono">Environments → Access</span>) —
    ohne sie liefert Portainer eine <b>leere</b> Liste statt einer Fehlermeldung, und der Leitstand sähe null Container,
    wo Dutzende laufen.</p>`;

  /* pfSense hat ab Werk keine Schnittstelle — gelesen wird über das Paket
     pfSense-pkg-API. Dessen Fassung 2 meldet mit einem Schlüssel an,
     Fassung 1 mit Client-ID und Token; beide sind im Feld anzutreffen,
     deshalb stehen beide Wege hier. Ausgefüllt wird nur einer. */
  if (type === "pfsense") return `
    <div class="admin-grid">
      ${inpc("key", "API-Schlüssel", cred, cred.key ? "hinterlegt — leer lassen, um ihn zu behalten" : "Paket v2: System → API → Keys", getippt)}
      ${inpc("clientId", "Client-ID", cred, "nur bei Paket v1", getippt)}
      ${inpc("clientToken", "Client-Token", cred, cred.clientToken ? "hinterlegt" : "nur bei Paket v1", getippt)}
    </div>
    <p class="admin-hint" style="margin:8px 0 0"><b>Zuerst prüfen, ob es das Paket für diese pfSense überhaupt
    gibt.</b> <span class="mono">pfSense-pkg-API</span> ist ein Fremdprojekt und steht <b>nicht</b> im
    Paketverzeichnis von pfSense — es wird von Hand aus den Veröffentlichungen des Projekts installiert, und für
    neuere pfSense-Fassungen gibt es nicht immer eine passende. Ohne das Paket bleibt es bei Erreichbarkeit,
    Antwortzeit und Zertifikat; diese Felder hier sind dann gegenstandslos.<br><br>
    Ist es vorhanden: unter <span class="mono">System → API</span> einen Schlüssel erzeugen, der Benutzer dahinter
    braucht nur Leserechte. Gelesen werden Systemzustand, Schnittstellenzähler, Gateways, Zustandstabelle, CARP und
    WireGuard — <b>geschrieben wird nichts</b>. Welche Fassung des Pakets läuft, findet der Leitstand selbst heraus;
    die Diagnose zeigt zu jedem Aufruf die tatsächlichen Feldnamen.</p>`;

  if (type === "opnsense") return `
    <div class="admin-grid">
      ${inpc("key", "API-Schlüssel", cred, cred.key ? "hinterlegt — leer lassen, um ihn zu behalten" : "der lange Wert aus der Schlüsseldatei", getippt)}
      ${inpc("secret", "Secret", cred, cred.secret ? "hinterlegt — leer lassen, um es zu behalten" : "der zweite Wert aus derselben Datei", getippt)}
    </div>
    <p class="admin-hint" style="margin:8px 0 0">In OPNsense unter
    <span class="mono">System → Access → Users</span> beim Benutzer einen API-Schlüssel erzeugen —
    heruntergeladen wird eine Datei mit beiden Werten. Zum Ablesen genügt ein Benutzer in einer Gruppe
    mit Leserechten; Schreibrechte braucht der Leitstand nirgends.</p>`;

  /* Der Backup Server hat eine eigene Rechteverwaltung: PVEAuditor gibt es
     dort nicht, und die Rolle muss auf der Token-ID stehen — PBS schneidet
     die Rechte des Tokens mit denen des Benutzers. */
  const hinweis = type === "pbs" ? `Nur lesend: im Backup Server unter
    <span class="mono">Configuration → Access Control → Permissions</span> eintragen —
    Pfad <span class="mono">/</span>, Rolle <span class="mono">Audit</span>, Propagate an,
    und zwar auf die <b>Token-ID</b>, nicht nur auf den Benutzer.
    <span class="mono">DatastoreAudit</span> allein reicht nicht: die Belegung käme an,
    die fehlgeschlagenen Aufträge blieben unsichtbar.` : `Nur lesend: in Proxmox unter
    <span class="mono">Datacenter → Permissions → Add → API Token Permission</span> eintragen —
    Pfad <span class="mono">/</span>, Rolle <span class="mono">PVEAuditor</span>, Propagate an.
    Eine Berechtigung, die nur dem Benutzer gilt, greift bei „Privilege Separation“ nicht für seine Token.`;

  return `
    <div class="admin-grid">
      ${inpc("user", "Benutzer@Realm", cred, type === "pbs" ? "leitstand@pbs" : "leitstand@pve", getippt)}
      ${inpc("tokenId", "Token-ID", cred, "ro", getippt)}
      ${inpc("secret", "Geheimnis", cred, cred.secret ? "hinterlegt — leer lassen, um es zu behalten" : "aus der Anlage-Maske kopieren", getippt)}
    </div>
    <p class="admin-hint" style="margin:8px 0 0">${hinweis}</p>`;
}

/* ============================================================
   Was an einem System geprüft wird
   ============================================================ */
/* Ohne eigene Angabe leitet der Dienst die Prüfungen aus IP und Adresse
   ab: ICMP, der Port der Oberfläche, bei https das Zertifikat. Für
   Proxmox oder eine Firewall ist das genau richtig — für ein „sonstiges"
   System ist es geraten. Ein Switch, der nur SSH und ICMP kann, steht
   sonst dauerhaft auf Gelb, weil jemand einmal 443 angenommen hat.

   Deshalb hier eine Liste zum Anhaken. **Eine Zeile ist genau eine
   Prüfung** — auch das Zertifikat, das sonst als unsichtbarer Anhang von
   „HTTPS" mitliefe. Nur so kommt beim Speichern wieder heraus, was
   vorher dastand: eine Liste, die beim Anzeigen etwas hinzuerfindet,
   schreibt es beim nächsten Speichern in die Datei.

   Der Port ist Teil der Kennung (`tcp:443`), damit Anzeige und Datei
   dasselbe meinen und keine Übersetzungstabelle dazwischenliegt. */
const PRUEFDIENSTE = [
  { id: "icmp:",     label: "ICMP · Ping",        hint: "antwortet das Gerät überhaupt" },
  { id: "tcp:80",    label: "HTTP · 80" },
  { id: "tcp:443",   label: "HTTPS · 443" },
  { id: "tls:443",   label: "Zertifikat · 443",   hint: "Restlaufzeit aus dem Handshake" },
  { id: "tcp:22",    label: "SSH · 22" },
  { id: "dns:53",    label: "DNS · 53",           hint: "echte Auflösung über UDP, kein Portklopfen" },
  { id: "ts3:9987",  label: "TeamSpeak · 9987",   hint: "UDP-Handschlag mit dem Server, kein Portklopfen" },
  { id: "tcp:25",    label: "SMTP · 25" },
  { id: "tcp:587",   label: "Submission · 587" },
  { id: "tcp:465",   label: "SMTPS · 465" },
  { id: "tcp:143",   label: "IMAP · 143" },
  { id: "tcp:993",   label: "IMAPS · 993" },
  { id: "tcp:995",   label: "POP3S · 995" },
  { id: "tcp:3389",  label: "RDP · 3389" },
  { id: "tcp:445",   label: "SMB · 445" },
  { id: "tcp:139",   label: "NetBIOS · 139" },
  { id: "tcp:21",    label: "FTP · 21" },
  { id: "tcp:631",   label: "IPP · 631",          hint: "Drucker" },
  { id: "tcp:8006",  label: "Proxmox · 8006" },
  { id: "tcp:9090",  label: "Cockpit · 9090" },
  { id: "tcp:3306",  label: "MySQL · 3306" },
  { id: "tcp:5432",  label: "PostgreSQL · 5432" },
  { id: "tcp:1883",  label: "MQTT · 1883" }
];
const PRUEF_IDS = new Set(PRUEFDIENSTE.map(d => d.id));

/* Eine Prüfung, die nichts weiter trägt als Art und Port, lässt sich
   ankreuzen — steht sie nicht in der Liste oben, bekommt sie ihre eigene
   Zeile dazu. Alles andere — ein Zertifikat mit eigenem `servername`,
   eine DNS-Prüfung mit eigener Abfrage, eine als *wesentlich*
   gekennzeichnete — sagt mehr, als ein Kästchen tragen kann. Die wird
   unangetastet weitergereicht und daneben angezeigt, statt beim
   Speichern zu verschwinden. */
function schlicht(c) {
  return Object.keys(c || {}).every(k => k === "kind" || k === "port");
}
function checkId(c) { return `${c.kind}:${c.port ?? ""}`; }

const ART_LABEL = { tcp: "TCP", tls: "Zertifikat", dns: "DNS", icmp: "ICMP", http: "HTTP", ts3: "TeamSpeak" };
function pruefLabel(id) {
  const d = PRUEFDIENSTE.find(x => x.id === id);
  if (d) return d.label;
  const [kind, port] = id.split(":");
  return `${ART_LABEL[kind] || kind}${port ? " · " + port : ""}`;
}

function pruefAusChecks(checks) {
  const ids = [], extra = [], rest = [];
  for (const c of checks || []) {
    if (!schlicht(c) || !c.kind) { rest.push(c); continue; }
    const id = checkId(c);
    if (ids.includes(id)) continue;
    ids.push(id);
    if (!PRUEF_IDS.has(id)) extra.push(id);
  }
  return { ids, extra, rest };
}

/* Die Zeilen, die das Formular zeigt: die feste Liste und dazu, was
   dieses System sonst noch prüft. */
function pruefZeilen(d) {
  return [...PRUEFDIENSTE, ...(d.pruefExtra || []).filter(id => !PRUEF_IDS.has(id))
    .map(id => ({ id, label: pruefLabel(id), eigen: true }))];
}

/* Zurück in eine Prüfliste — in der Reihenfolge der Zeilen, damit
   dieselbe Auswahl immer dieselbe Datei ergibt. */
function pruefZuChecks(d, ports) {
  const gewaehlt = new Set(d.pruef || []);
  const out = [];
  for (const z of pruefZeilen(d)) {
    if (!gewaehlt.has(z.id)) continue;
    const [kind, port] = z.id.split(":");
    out.push(port ? { kind, port: Number(port) } : { kind });
  }
  const schon = new Set(out.map(checkId));
  for (const c of ports || []) if (!schon.has(checkId(c))) { out.push(c); schon.add(checkId(c)); }
  return [...out, ...(d.pruefRest || [])];
}

/* „8006, 9090, ts3:19987" → drei Prüfungen. Eine nackte Zahl ist ein
   TCP-Port — das ist der Normalfall und bleibt es. Steht ein Verfahren
   davor, gilt dieses: nötig für alles, was nicht auf seinem Werksport
   läuft und wo ein offener Port die falsche Frage wäre. Ein TeamSpeak
   auf 19987 lässt sich sonst nur in der Bestandsdatei eintragen, obwohl
   die Prüfung dafür da ist.

   Was keine Portnummer ist oder ein unbekanntes Verfahren nennt, fällt
   weg — gemeldet wird das beim Speichern, nicht hier beim Tippen. */
const WEITERE_ARTEN = new Set(["tcp", "ts3", "dns", "tls"]);
function portListe(text) {
  const out = [];
  for (const roh of String(text ?? "").split(/[,;\s]+/)) {
    const stueck = roh.trim();
    if (!stueck) continue;
    const [a, b] = stueck.includes(":") ? stueck.split(":") : ["tcp", stueck];
    const kind = a.trim().toLowerCase(), port = Number(String(b).trim());
    if (!WEITERE_ARTEN.has(kind)) continue;
    if (!(Number.isInteger(port) && port > 0 && port < 65536)) continue;
    out.push({ kind, port });
  }
  return out;
}

function pruefFelder(d) {
  const eigen = !!d.checksEigen;
  const ids = new Set(d.pruef || []);
  const rest = d.pruefRest || [];
  return `<div>
    <label class="row" style="gap:9px;cursor:pointer">
      <span class="switch" role="switch" aria-checked="${eigen}" data-action="form-toggle" data-field="checksEigen"></span>
      <span>Prüfungen selbst festlegen
        <span class="faint">— sonst abgeleitet aus IP und Oberfläche: ICMP, deren Port, bei https das Zertifikat</span></span>
    </label>
    ${eigen ? `
    <div class="row row-wrap" style="gap:6px;margin:10px 0 0">
      ${pruefZeilen(d).map(x => `<button class="btn btn--sm" type="button" data-action="form-check" data-id="${esc(x.id)}"
        aria-current="${ids.has(x.id)}" ${x.hint ? `title="${esc(x.hint)}"` : ""}>${ids.has(x.id) ? "✓ " : ""}${esc(x.label)}</button>`).join("")}
    </div>
    <div class="admin-grid" style="margin-top:10px">
      <label class="admin-field">
        <span class="admin-label">Weitere Prüfungen</span>
        <input class="admin-input" data-field="pruefPorts" value="${esc(d.pruefPorts ?? "")}" placeholder="8123, 32400, ts3:19987">
        <span class="admin-hint">durch Komma getrennt — für alles, was oben nicht steht. Eine nackte Zahl ist ein
          TCP-Port; ein Verfahren davor gilt stattdessen: <span class="mono">ts3:19987</span> für einen TeamSpeak
          auf einem eigenen Port</span>
      </label>
    </div>
    ${rest.length ? `<p class="admin-hint" style="margin:8px 0 0">Unverändert übernommen aus der Bestandsdatei:
      ${rest.map(c => `<span class="chip chip--plain mono">${esc(checkId(c))}${
        c.servername ? " · " + esc(c.servername) : ""}${c.query ? " · " + esc(c.query) : ""}${
        c.wesentlich ? " · wesentlich" : ""}</span>`).join(" ")}
      — diese Prüfungen tragen mehr als Art und Port und lassen sich hier nicht ankreuzen. Sie bleiben,
      wie sie sind.</p>` : ""}
    <p class="admin-hint" style="margin:8px 0 0">Angehakt wird, was <b>überwacht</b> werden soll: jede Prüfung ist
      eine eigene Ampel, und antwortet eine von mehreren nicht, gilt das als Teilausfall. Ein Gerät, das nur SSH
      kann, bekommt hier ICMP und SSH — und hört auf, wegen eines nie vorhandenen Ports gelb zu leuchten.</p>`
    : ""}
  </div>`;
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

  const tabs = [["hosts", "Systeme"], ["sites", "Standorte"], ["tunnels", "Tunnel"], ["links", "Startseite"],
    ["settings", "Schwellwerte"], ["staende", "Sicherung"]];
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
    : tab === "staende" ? adminStaende()
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
            : (state.credentials && state.credentials[h.id]) ? chip("ok", "hinterlegt") : chip("warn", "fehlt")}</td>
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

/* Beide Enden untereinander. Fehlt das zweite, steht das ausdrücklich da:
   es ist der häufigste Grund, warum eine Gegenstelle in der Peerliste
   keiner Strecke zugeordnet ist. */
function peerZelle(t) {
  const enden = [t.peer, t.peerB].filter(Boolean);
  if (!enden.length) return '<span class="faint">—</span>';
  const zeilen = enden.map(p => p.gefunden
    ? `${esc(p.name)} <span class="faint">· ${esc(p.host)}</span>`
    : `<span style="color:var(--warn)" title="${esc(p.note || "")}">${esc(p.name || p.key || "?")} — nicht gemeldet</span>`);
  if (enden.length === 1) zeilen.push('<span class="faint">zweites Ende nicht verknüpft</span>');
  return zeilen.map(z => `<div>${z}</div>`).join("");
}

function adminTunnels() {
  return `<div class="panel">
    <div class="panel-head"><h3>Tunnel</h3><span class="hint">${state.tunnels.length} angelegt</span>
      <div class="spacer"></div><span class="hint">gemessen wird durch den Tunnel, der Handshake kommt vom Peer</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th style="width:34px"></th><th>Kennung</th><th>Strecke</th><th>Interface</th><th>Transfernetz</th><th>Gegenstelle</th><th>Verknüpfte Peers</th><th class="right"></th></tr></thead><tbody>
      ${state.tunnels.length ? state.tunnels.map(t => `<tr data-sev="${t.status}">
        <td class="sev">${dot(t.status)}</td>
        <td class="mono">${esc(t.id)}</td>
        <td>${esc(siteName(t.a))} ↔ ${esc(siteName(t.b))}</td>
        <td class="mono faint">${esc(t.iface || "—")}</td>
        <td class="mono faint">${esc(t.net || "—")}</td>
        <td class="mono">${esc(t.probe || "—")}</td>
        <td class="mono">${peerZelle(t)}</td>
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
          <table class="t"><thead><tr><th style="width:34px"></th><th>Beschriftung</th><th>System</th><th>Adresse</th><th style="width:110px">Ampel</th><th class="right"></th></tr></thead><tbody>
          ${(g.items || []).length ? g.items.map((it, ii) => {
            const h = it.host ? byId(state.hosts, it.host) : null;
            const gemeldet = LINKGROUPS[gi]?.links?.[ii];
            const ampel = kachelAmpel(gemeldet && gemeldet.u === it.url ? gemeldet : { p: !!it.pruefen, st: null }, h);
            return `<tr data-sev="${ampel}">
              <td class="sev">${dot(ampel)}</td>
              <td><input class="admin-input" data-link="${gi}.${ii}.name" value="${esc(it.name || "")}" placeholder="${esc(it.host || "Beschriftung")}" aria-label="Beschriftung"></td>
              <td><select class="admin-input" data-link="${gi}.${ii}.host" aria-label="System">
                <option value="">— keins (reines Lesezeichen)</option>
                ${hostOptionen.map(id => `<option value="${esc(id)}" ${it.host === id ? "selected" : ""}>${esc(id)}</option>`).join("")}
              </select></td>
              <td><input class="admin-input mono" data-link="${gi}.${ii}.url" value="${esc(it.url || "")}"
                placeholder="${esc(h && h.url ? h.url + " (vom System)" : "https://…")}" aria-label="Adresse"></td>
              <td><label class="admin-check" title="${esc(h
                ? "Die Ampel kommt vom verknüpften System — es wird ohnehin vollständig überwacht."
                : "Die Adresse alle " + (state.settings?.link_takt ?? 60) + " s abrufen und die Kachel danach färben. Erzeugt keine Störung und keine Meldung.")}">
                <input type="checkbox" data-link="${gi}.${ii}.pruefen" ${it.pruefen && !h ? "checked" : ""} ${h ? "disabled" : ""}>
                <span>${h ? "vom System" : "abrufen"}</span></label></td>
              <td class="right">
                <button class="btn btn--sm" data-action="link-move" data-group="${gi}" data-idx="${ii}" data-dir="-1" ${ii === 0 ? "disabled" : ""}>↑</button>
                <button class="btn btn--sm" data-action="link-move" data-group="${gi}" data-idx="${ii}" data-dir="1" ${ii === (g.items.length - 1) ? "disabled" : ""}>↓</button>
                <button class="btn btn--sm" data-action="link-del" data-group="${gi}" data-idx="${ii}">Löschen</button>
              </td></tr>`;
          }).join("") : `<tr><td colspan="6"><div class="empty">Noch nichts in dieser Gruppe.</div></td></tr>`}
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
      Adresse ist für Unterpfade nützlich — etwa <span class="mono">/admin</span> statt der Startseite des Dienstes.
      <br><b>Ampel:</b> Ist ein System verknüpft, trägt die Kachel dessen Zustand. Ohne System bleibt sie grau —
      es sei denn, <b>abrufen</b> ist gesetzt: dann holt der Leitstand die Adresse selbst, alle
      <span class="mono">${esc(String(state.settings?.link_takt ?? 60))} s</span>, und färbt die Kachel nach dem Statuscode.
      Das ist ausdrücklich <i>keine</i> Überwachung: es entsteht keine Störung, nichts wird quittiert, niemand wird
      geweckt. Wer das braucht, legt das Ziel als System an.</div>
  </div>`;
}

/* ---------- Frühere Stände ----------

   Eine Sicherung, die man nicht ansehen kann, bevor man sie einsetzt, ist
   ein Sprung ins Dunkle: man erfährt erst hinterher, was man sich geholt
   hat. Deshalb steht zu jedem Stand, wie viel darin steht — und die
   Rückfrage nennt beide Zahlen, die jetzige und die künftige. */
function adminStaende() {
  const d = state.staende;
  /* Geholt wird erst, wenn jemand hersieht — und von wo auch immer er
     hergekommen ist. Die Kennung verhindert, dass jedes Neuzeichnen einen
     weiteren Abruf lostritt. */
  if (!d) {
    if (!state.staendeLaeuft) { state.staendeLaeuft = true; ladeStaende(); }
    return `<div class="panel"><div class="panel-body"><div class="empty">Frühere Stände werden geholt …</div></div></div>`;
  }

  const zahl = x => x && x.lesbar
    ? `${x.hosts} Systeme · ${x.sites} Standorte · ${x.tunnels} Tunnel`
    : `<span style="color:var(--crit)">nicht lesbar${x && x.fehler ? ": " + esc(x.fehler) : ""}</span>`;

  const zeile = (x, titel, quelle, hinweis) => `<tr>
    <td><div>${esc(titel)}</div><div class="t-sub mono">${esc(x.name)}</div></td>
    <td class="mono">${esc(fmtWhen(x.zeit) || "—")}</td>
    <td>${zahl(x)}</td>
    <td class="faint" style="font-size:12px">${hinweis}</td>
    <td class="right">${x.lesbar
      ? `<button class="btn btn--sm" data-action="admin-restore" data-quelle="${esc(quelle)}">Zurückholen</button>`
      : ""}</td>
  </tr>`;

  const jetzt = d.datei;
  const rows = [
    d.sicherung ? zeile(d.sicherung, "Sicherung", ".bak", "Stand unmittelbar vor der letzten Änderung") : "",
    ...(d.archiv || []).map(a => zeile(a, "Auszug", a.name, "Stand am Ende dieses Tages"))
  ].filter(Boolean).join("");

  return `<div class="panel">
    <div class="panel-head"><h3>Jetziger Bestand</h3>
      <div class="spacer"></div>
      <span class="mono faint" style="font-size:11.5px">${esc((jetzt && jetzt.datei) || "—")}</span></div>
    <div class="panel-body">
      <div class="stat-row">
        ${stat("Systeme", jetzt && jetzt.lesbar ? jetzt.hosts : "—")}
        ${stat("Standorte", jetzt && jetzt.lesbar ? jetzt.sites : "—")}
        ${stat("Tunnel", jetzt && jetzt.lesbar ? jetzt.tunnels : "—")}
        ${stat("Zuletzt geschrieben", (jetzt && fmtWhen(jetzt.zeit)) || "—")}
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>Frühere Stände</h3><span class="hint">${(d.archiv || []).length} Auszüge, ${d.behalten ?? "—"} werden behalten</span></div>
    <div class="panel-body panel-body--flush tablewrap">
      <table class="t"><thead><tr><th>Stand</th><th>Vom</th><th>Inhalt</th><th>Wofür</th><th class="right"></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5"><div class="empty">Noch kein früherer Stand — der erste entsteht bei der nächsten Änderung.</div></td></tr>`}</tbody></table>
    </div>
    <div class="panel-note">Zurückholen schreibt den gewählten Stand in
      <span class="mono">${esc((jetzt && jetzt.datei) || "inventory.yaml")}</span> und legt den bisherigen zugleich als
      <span class="mono">.bak</span> ab — der Griff daneben lässt sich also genauso zurücknehmen wie der Fehler,
      wegen dem man ihn gemacht hat. Zugangsdaten bleiben unberührt; sie stehen in
      <span class="mono">secrets.json</span> und gehören nicht zum Bestand.
      ${d.verzeichnis ? `Die Auszüge liegen in <span class="mono">${esc(d.verzeichnis)}</span>.` : ""}</div>
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
      ${f("tls_selfsigned_ignore", "Eigensignierte übergehen", "true: keine Ampel (Vorgabe) · false: wie jedes andere")}
      ${f("disk_warn", "Speicher: Warnung", "Belegung in % — je System änderbar")}
      ${f("disk_crit", "Speicher: kritisch", "Belegung in % — je System änderbar")}
      ${f("ram_warn", "RAM: Warnung", "Belegung in %")}
      ${f("ram_crit", "RAM: kritisch", "Belegung in %")}
      ${f("history", "Verlaufspunkte", "je System im Speicher, für die Sparkline")}
      ${f("icmp", "ICMP verwenden", "true oder false")}
      ${f("verlauf_takt", "Zeitreihe: Takt", "Sekunden je Punkt auf der Platte")}
      ${f("verlauf_tage", "Zeitreihe: Aufbewahrung", "Tage, danach fällt der älteste heraus")}
      ${f("link_takt", "Startseite: Prüftakt", "Sekunden zwischen zwei Abrufen einer Kachel")}
      ${f("mail_queue_warn", "Mail-Warteschlange: Warnung", "zurückgestellte Mail bis Gelb")}
      ${f("mail_queue_crit", "Mail-Warteschlange: kritisch", "zurückgestellte Mail bis Rot")}
      ${f("pmg_takt", "Mail Gateway: Betriebstakt", "Sekunden — Auslastung, Warteschlange, Dienste")}
      ${f("pmg_takt_lang", "Mail Gateway: Statistiktakt", "Sekunden — Tagesstatistik, Quarantäne, Signaturen")}
      ${f("mailcow_takt", "Mailcow: Betriebstakt", "Sekunden — Container, Warteschlange, Platz")}
      ${f("mailcow_takt_lang", "Mailcow: Statistiktakt", "Sekunden — Domänen, Postfächer, Quarantäne")}
      ${f("mailbox_voll_warn", "Postfach voll: Warnung", "Belegung eines einzelnen Postfachs in %")}
      ${f("wlan_kanal_warn", "WLAN: Kanalbelegung", "% je Funkband bis Gelb")}
    </div></div>
    <div class="panel-note">Die Belegungsgrenzen gelten für Proxmox-Speicher, PBS-Datastores und die Platte einer
      Firewall. Einzelne Systeme dürfen abweichen — beim Bearbeiten eines Systems unter <b>Schwellwerte</b>. Das ist
      der Weg für einen Host, der bekanntermaßen und gewollt voll läuft: ihn einzeln hochsetzen, statt die Grenze für
      alle aufzuweichen.
      <br><b>Eigensignierte übergehen</b> bezieht sich nur auf Zertifikate, die sich selbst ausgestellt haben. Ihr
      Ablauf ist kein Vorfall: geprüft hat sie nie jemand, und wer sie gestern angenommen hat, nimmt sie heute an.
      Sie stehen weiter in der Zertifikatsliste, dort als „nicht bewertet". Zertifikate einer echten Ausgabestelle
      sind davon nie betroffen. Soll ein einzelnes System gar kein Zertifikat bewertet bekommen, steht der Schalter
      beim <b>Bearbeiten des Systems</b>.
      <br>Ein geänderter Abstand greift ab dem nächsten Durchlauf. Steht ICMP auf
      <span class="mono">false</span>, wird nur noch TCP geprüft — für Weboberflächen genügt das, für reine
      Ping-Ziele nicht.
      <br>Takt und Aufbewahrung der Zeitreihe bestimmen, wie viel Platz das Volume braucht: rund 100 Byte je Punkt,
      Gegenstand und Takt. Eine Minute über 30 Tage sind etwa 4 MB je System.
      <br>Die <b>Mail-Warteschlange</b> zählt zurückgestellte Nachrichten auf dem Proxmox Mail Gateway. Unabhängig
      von diesen Grenzen fällt auf, was <b>seit über zehn Stunden</b> liegt: zwanzig Mail in der Zustellung sind
      Betrieb, zwanzig Mail von gestern sind ein Empfänger, der nicht mehr antwortet.
      <br>Die beiden <b>Takte des Mail Gateways</b> sind kein Sparzwang, sondern Rücksicht: die Tagesstatistik
      ändert sich in 15 Sekunden nicht messbar, und die Warteschlange abzufragen startet je Abruf einen Prozess auf
      dem Gerät. Bei <b>Mailcow</b> dasselbe, dort noch deutlicher: mehrere Abfragen lassen mailcow einen Befehl
      <em>in</em> einem Container ausführen. Die Erreichbarkeit misst der Prober weiterhin in jedem Durchlauf.
      <br><b>Postfach voll</b> gilt je Postfach, nicht je Platte: ein volles Postfach weist Mail ab, während der
      Dienst tadellos läuft — und gemeldet wird das von niemandem sonst. Postfächer ohne gesetzte Quote bleiben
      außen vor; dort gibt es keine Belegung in Prozent.
      <br>Die <b>Kanalbelegung</b> zählt eigenen und fremden Funkverkehr zusammen. Sie steht bewusst hoch: 2,4 GHz
      liegt in bewohnter Gegend tagsüber bei 40 bis 60 %, und eine Ampel, die das täglich zeigt, ist nach zwei
      Wochen abtrainiert. Jenseits von 80 % geht spürbar nichts mehr durch.${verlaufNote()}</div>
  </div>`;
}

/* Was tatsächlich auf der Platte liegt — gezählt vom Dienst, nicht
   geschätzt von hier. Ein Schreibfehler (volles Volume) steht ausdrücklich
   da: eine Zeitreihe, die still nicht mehr wächst, merkt sonst niemand. */
function verlaufNote() {
  const v = state.runtime?.verlauf;
  if (!v) return "";
  const mb = v.bytes != null ? (v.bytes / 1048576).toFixed(v.bytes > 10485760 ? 0 : 1) + " MB" : "—";
  return `<br><b>Ablage:</b> <span class="mono">${esc(v.verzeichnis)}</span> — ${v.vorhanden} Tagesdatei(en)${
    v.seit ? `, älteste vom ${esc(v.seit)}` : ""}, ${esc(mb)}.${
    v.fehler ? ` <span style="color:var(--crit)">Zuletzt nicht schreibbar: ${esc(v.fehler)}</span>` : ""}`;
}

/* ---------- Formular als Schublade ---------- */
/* Was der Benutzer gerade getippt hat, hat Vorrang vor dem, was der Server
   kennt. Sonst räumt ein Neuzeichnen — etwa nach „Verbindung testen“ — das
   eingegebene Geheimnis weg, und Speichern legt stillschweigend nichts an.
   Gespeicherte Geheimnisse kommen nur maskiert zurück und werden deshalb
   nie in das Feld zurückgeschrieben. */
/* Welche Zugangsfelder Geheimnisse sind — dieselbe Liste wie im Dienst
   (server/src/secrets.js). Sie kommen nur maskiert zurück; stünde die
   Maske im Feld, schriebe ein Speichern die Punkte als neues Geheimnis
   zurück. Also bleibt das Feld leer, und leer heißt „unverändert". */
/* Dieselbe Liste wie in secrets.js: diese Felder werden nie vorbelegt,
   sondern als leeres Passwortfeld gezeigt. Leer lassen heißt „behalten" —
   der Dienst überschreibt nichts mit einer leeren Eingabe. */
const GEHEIMFELDER = new Set(["secret", "password", "token", "apiKey", "key", "clientToken"]);

function inpc(key, label, cred, ph, typed) {
  const geheim = GEHEIMFELDER.has(key);
  const wert = typed && typed[key] != null && typed[key] !== ""
    ? typed[key]
    : (geheim ? "" : (cred[key] ?? ""));
  return `<label class="admin-field">
    <span class="admin-label">${esc(label)}</span>
    <input class="admin-input" data-cred="${key}" type="${geheim ? "password" : "text"}"
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
  const gespeichert = d.peerOrig, gespeichertB = d.peerBOrig;
  const fehlt = !!gespeichert && d.peerRef === "__gespeichert";
  const fehltB = !!gespeichertB && d.peerBRef === "__gespeichert";

  if (!PEERS.length && !fehlt && !fehltB) return `<div>
    <div class="sec-title">WireGuard-Peer</div>
    <p class="admin-hint" style="margin:0">Noch meldet keine Firewall WireGuard-Peers. Dafür braucht OPNsense einen
      API-Schlüssel — unter <b>Verwaltung → Systeme</b> beim Gerät hinterlegen. Danach steht die Gegenstelle hier zur
      Auswahl, und in der Tunnelzeile steht der echte Handshake.</p></div>`;

  return `<div>
    <div class="sec-title">WireGuard-Peers — beide Enden</div>
    <label class="admin-field">
      <span class="admin-label">Gegenstelle auf der Firewall</span>
      <select class="admin-input" data-field="peerRef">${peerOptionen(d, "peerRef", gespeichert, fehlt)}</select>
      <span class="admin-hint">Damit steht in der Tunnelzeile das echte Handshake-Alter statt eines Strichs — und
        die übertragene Menge dazu. Ohne Gegenstelle im Transfernetz wird der Zustand daraus abgeleitet.</span>
    </label>
    <label class="admin-field">
      <span class="admin-label">Gegenstelle am anderen Ende</span>
      <select class="admin-input" data-field="peerBRef">${peerOptionen(d, "peerBRef", gespeichertB, fehltB)}</select>
      <span class="admin-hint">Eine Strecke hat zwei Enden, und jede Firewall kennt nur das jeweils andere: dasselbe
        Kabel, zweimal beschrieben. Ist auch die zweite Firewall benannt, gehört sie in der Gegenstellenliste
        sichtbar zu dieser Strecke — sonst steht sie dort als „keiner Strecke zugeordnet“ mitten in einer. Und die
        beiden Angaben lassen sich gegeneinander halten: dieselbe Strecke ist sich über ihren Handshake einig.</span>
    </label></div>`;
}

/* Die Auswahlliste eines Endes. Der hinterlegte, zurzeit nicht gemeldete
   Peer steht mit dabei — sonst löschte allein das Öffnen des Formulars
   eine gültige Verknüpfung. */
function peerOptionen(d, feld, gespeichert, fehlt) {
  const gruppen = new Map();
  for (const p of PEERS) {
    if (!gruppen.has(p.von)) gruppen.set(p.von, []);
    gruppen.get(p.von).push(p);
  }
  /* Was am anderen Ende schon steht, ist hier keine Wahl mehr: zweimal
     derselbe Peer wären nicht zwei Enden, sondern zweimal eines. */
  const anderes = feld === "peerRef" ? d.peerBRef : d.peerRef;
  const opts = [`<option value="">— nicht verknüpft —</option>`];
  if (fehlt) opts.push(`<option value="__gespeichert" selected>${esc(gespeichert.name || gespeichert.key || "hinterlegt")} — zurzeit nicht gemeldet</option>`);
  for (const [von, liste] of gruppen) {
    const zeilen = liste.filter(p => p.id !== anderes);
    if (!zeilen.length) continue;
    opts.push(`<optgroup label="${esc(von)}">${zeilen.map(p => {
      /* Ein Peer trägt höchstens eine Strecke — steht er schon an einer
         anderen, gehört das dazugesagt, bevor jemand ihn doppelt vergibt. */
      const belegt = p.tunnel && p.tunnel !== d.id ? ` — schon an ${p.tunnel}` : "";
      return `<option value="${esc(p.id)}" ${d[feld] === p.id ? "selected" : ""}>${esc(p.iface || "wg")} · ${esc(p.name)}${esc(belegt)}</option>`;
    }).join("")}</optgroup>`);
  }
  return opts.join("");
}

/* Was die verknüpften Firewalls über die Strecke wissen, zur Übernahme.

   Transfernetz und Gegenstelle stehen in den erlaubten Netzen der Peers —
   bislang musste man sie von dort abschreiben. Angeboten wird, was
   gelesen wurde; eingetragen wird nur, was man anklickt. Ein stilles
   Vorbelegen wäre schlechter: es sähe aus wie eine Eingabe und wäre eine
   Vermutung darüber, welches Ende von hier aus erreichbar ist. */
function gelesenFeld(d) {
  const gewaehlt = [d.peerRef, d.peerBRef].map(r => PEERS.find(p => p.id === r)).filter(Boolean);
  const ips = [...new Set(gewaehlt.flatMap(p => p.ips || []))];
  const netze = [...new Set(gewaehlt.flatMap(p => p.netze || []))];
  if (!ips.length && !netze.length) return "";

  const knopf = (feld, wert, titel) => `<button type="button" class="btn btn--sm" data-action="form-set"
    data-field="${esc(feld)}" data-value="${esc(wert)}" title="${esc(titel)}">${esc(wert)}</button>`;

  return `<div>
    <div class="sec-title">Von den Firewalls gelesen</div>
    ${ips.length ? `<div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:6px">
      <span class="faint" style="font-size:12.5px;min-width:150px">Adressen im Tunnel</span>
      ${ips.map(ip => knopf("probeIp", ip, `als Gegenstelle im Tunnel eintragen — diese Adresse wird dann gemessen`)).join("")}
    </div>` : ""}
    ${netze.length ? `<div class="row" style="gap:6px;flex-wrap:wrap">
      <span class="faint" style="font-size:12.5px;min-width:150px">Netze dahinter</span>
      ${netze.map(n => knopf("net", n, "als Transfernetz eintragen")).join("")}
    </div>` : ""}
    <p class="admin-hint" style="margin:6px 0 0">Steht in den erlaubten Netzen der gewählten Peers. Anklicken trägt
      es oben ein — gemessen wird die Adresse, die von hier aus durch den Tunnel erreichbar ist, also die des
      <b>anderen</b> Standorts.</p></div>`;
}

/* ---------- Tunnel: das Interface ----------

   Früher stand hier ein leeres Textfeld. Seit ein Tunnel seine Enden
   benennt, ist die Frage in den meisten Fällen überflüssig: die Firewall
   meldet, auf welchem Interface der Peer liegt, und genau das steht
   danach in der Tunnelzeile. Zwei Quellen für dieselbe Angabe wären eine
   zu viel — die getippte veraltet still, sobald jemand am Gerät etwas
   verschiebt.

   Bleibt der Fall, in dem der Leitstand es nicht wissen kann: das andere
   Ende gehört jemand anderem, es gibt keinen Zugang, kein Peer zu
   verknüpfen. Dann ist es wieder eine Eingabe — aber als Auswahl über
   das, was die erreichbaren Firewalls melden, statt als leeres Feld.
   Steht der gesuchte Name nicht dabei, führt „andere" zurück zum Tippen.

   Drei Zustände, und jeder sagt, woher seine Angabe kommt. */
/* Die verknüpften Peers dieses Formulars, so wie die Firewalls sie
   melden — und die Interfaces daraus. Beides brauchen Anzeige und
   Speichern, und beide müssen dasselbe sehen. */
function gewaehltePeers(d) {
  return [d.peerRef, d.peerBRef].map(r => PEERS.find(p => p.id === r)).filter(Boolean);
}
function gelesenesIface(d) {
  return [...new Set(gewaehltePeers(d).map(p => p.iface).filter(Boolean))];
}

/* Welche der drei Herkünfte gerade gilt. Anzeige und Speichern fragen
   dieselbe Stelle — sonst zeigte das Formular eine Auswahl und schriebe
   das Textfeld zurück, und niemand sähe, welche der beiden gewann. */
function ifaceHerkunft(d) {
  if (gelesenesIface(d).length) return "peer";
  const bekannt = [...new Set(PEERS.map(p => p.iface).filter(Boolean))];
  return bekannt.length && d.ifaceWahl !== "__frei" ? "auswahl" : "frei";
}

function ifaceFeld(inp, d) {
  const gewaehlt = gewaehltePeers(d);
  const gelesen = gelesenesIface(d);
  const herkunft = ifaceHerkunft(d);

  /* 1. Ein verknüpfter Peer meldet es — dann gibt es nichts zu fragen. */
  if (herkunft === "peer") return `<label class="admin-field">
    <span class="admin-label">Interface</span>
    <div class="admin-input" style="color:var(--dim);background:var(--panel-3)">${esc(gelesen.join(" · "))}</div>
    <span class="admin-hint">Von ${esc([...new Set(gewaehlt.map(p => p.von))].join(" und "))} gelesen — dort liegt
      der verknüpfte Peer. Eine getippte Angabe wäre eine zweite Quelle, die still veraltet.</span></label>`;

  const bekannt = [...new Set(PEERS.map(p => p.iface).filter(Boolean))].sort();
  const melder = [...new Set(PEERS.filter(p => p.iface).map(p => p.von))];

  /* 3. Nichts gemeldet oder ausdrücklich selbst eingetragen. */
  if (herkunft === "frei")
    return inp("iface", "Interface", bekannt.length
      ? "selbst eingetragen — keine Firewall meldet diesen Namen"
      : "wie auf der Firewall; sobald ein Peer verknüpft ist, kommt es von dort", { ph: "wg0" });

  /* 2. Zur Auswahl steht, was die erreichbaren Firewalls melden. */
  const opts = [`<option value="">— ohne Angabe —</option>`];
  for (const i of bekannt) opts.push(`<option value="${esc(i)}" ${d.ifaceWahl === i ? "selected" : ""}>${esc(i)}</option>`);
  opts.push(`<option value="__frei">— andere, selbst eintragen —</option>`);
  return `<label class="admin-field">
    <span class="admin-label">Interface</span>
    <select class="admin-input" data-field="ifaceWahl">${opts.join("")}</select>
    <span class="admin-hint">Gemeldet von ${esc(melder.join(", "))}. Für eine Strecke, deren anderes Ende dem
      Leitstand nicht offensteht — ist ein Peer verknüpft, kommt der Name von dort.</span></label>`;
}

/* Die Kennung des gemeldeten Peers zu einer hinterlegten Verknüpfung —
   zuerst über den Schlüssel, wie im Dienst auch. */
function peerRefOf(peer) {
  const p = PEERS.find(x => x.von === peer.host
    && ((peer.key && x.key === peer.key) || (!peer.key && x.name === peer.name)));
  return p ? p.id : null;
}

/* Eigene Schwellwerte je System.

   Der Anlass ist ein alltäglicher: ein Host läuft seit Jahren bei 93 %
   Belegung, weil mehr Platte nicht drin ist. Mit der globalen Grenze
   leuchtet er jede Nacht rot — und eine Ampel, die immer rot ist, hat man
   nach zwei Wochen abtrainiert. Wer die Lage kennt, soll sie hier
   festhalten können, statt die Überwachung insgesamt stumpfer zu machen.

   Leer heißt: es gilt der Wert aus den Einstellungen. Deshalb steht der
   auch als Platzhalter im Feld — man sieht, wogegen man entscheidet. */
function schwellenFelder(inp, d) {
  const g = (state.settings || {});
  const ph = k => String(g[k] ?? "");
  const eigen = ["s_disk_warn", "s_disk_crit", "s_ram_warn", "s_ram_crit"].some(k => String(d[k] ?? "") !== "");
  return `<div>
    <div class="sec-title">Schwellwerte${eigen ? ' <span class="chip chip--plain">eigene gesetzt</span>' : ""}</div>
    <p class="admin-hint" style="margin:0 0 8px">Leer lassen heißt: es gilt der Wert aus den Einstellungen (im Feld
      als Platzhalter). Eintragen lohnt für Systeme, deren Belegung bekannt und gewollt hoch ist — eine Ampel, die
      jede Nacht rot leuchtet, wird nicht mehr gelesen.</p>
    <div class="admin-grid">
      ${inp("s_disk_warn", "Speicher gelb ab %", "Belegung, ab der gewarnt wird", { ph: ph("disk_warn") })}
      ${inp("s_disk_crit", "Speicher rot ab %", "ab hier gilt es als Störung", { ph: ph("disk_crit") })}
      ${inp("s_ram_warn", "RAM gelb ab %", "", { ph: ph("ram_warn") })}
      ${inp("s_ram_crit", "RAM rot ab %", "", { ph: ph("ram_crit") })}
    </div>
  </div>`;
}

/* Kopf, Rumpf und Fuß getrennt — damit ein Klick im Formular nicht die
   ganze Schublade neu aufbauen muss. Sie hat eine Einblendbewegung, einen
   eigenen Bildlauf und den Fokus in einem Feld; wird ihr Knoten ersetzt,
   fängt die Bewegung von vorn an, der Bildlauf springt nach oben und ein
   aufgeklapptes Menü ist weg. Nachgezogen wird deshalb nur, was sich
   überhaupt ändern kann: Rumpf und Fuß (siehe `zeichneFormular`). */
function formTitel(f) {
  return f.mode === "new"
    ? (f.kind === "hosts" ? "System anlegen" : f.kind === "sites" ? "Standort anlegen" : "Tunnel anlegen")
    : `${esc(f.data.id)} bearbeiten`;
}

function renderAdminForm() {
  const f = state.form;
  if (!f || !f.open) return "";
  const title = formTitel(f);
  return `<div class="scrim" data-action="form-close"></div>
  <aside class="inspector" role="dialog" aria-label="${esc(title)}">
    <div class="inspector-head">
      <div style="min-width:0"><div class="view-kicker">Verwaltung</div><h2 style="font-size:17px">${title}</h2></div>
      <div class="spacer"></div>
      <button class="btn btn--ghost" data-action="form-close" aria-label="Schließen">✕</button>
    </div>
    <div class="inspector-body">${formRumpf(f)}</div>
    <div class="inspector-foot">${formFuss(f)}</div>
  </aside>`;
}

/* Der Fuß ändert sich nur, während etwas läuft. */
function formFuss(f) {
  return `<button class="btn btn--primary" data-action="form-save" ${f.busy ? "disabled" : ""}>${f.busy ? "…" : "Speichern"}</button>
      ${f.kind === "hosts" ? `<button class="btn" data-action="form-test" ${f.busy ? "disabled" : ""}>Verbindung testen</button>` : ""}
      <button class="btn" data-action="form-close">Abbrechen</button>`;
}

function formRumpf(f) {
  const d = f.data;
  const isHost = f.kind === "hosts", isSite = f.kind === "sites", isTun = f.kind === "tunnels";

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
      <label class="row" style="gap:9px;cursor:pointer">
        <span class="switch" role="switch" aria-checked="${!!d.tls_ignore}" data-action="form-toggle" data-field="tls_ignore"></span>
        <span>Zertifikat nicht bewerten <span class="faint">— gemessen und angezeigt wird es weiter, nur ohne Ampel</span></span>
      </label>

      ${pruefFelder(d)}

      ${schwellenFelder(inp, d)}

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
      ${inp("wan", "WAN IPv4", "wird mit dem verglichen, was die Firewall meldet", { ph: "203.0.113.17" })}
      ${inp("wan6", "WAN IPv6", "leer lassen, wenn die Firewall sie meldet", { ph: "2001:db8::/56" })}
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
      ${ifaceFeld(inp, d)}
      ${inp("net", "Transfernetz", "", { ph: "10.99.0.0/30" })}
      ${inp("probeIp", "Gegenstelle im Tunnel", "diese Adresse wird gemessen", { ph: "10.99.0.2" })}
      ${inp("probePort", "Port der Gegenstelle", "leer: nur ICMP", { ph: "22" })}
    </div>
    ${gelesenFeld(d)}
    ${peerFeld(d)}
    <p class="admin-hint" style="margin:0">Eines von beidem muss es sein. Am besten beides: die Messung <b>durch</b> den
      Tunnel sagt, ob gerade etwas hindurchkommt; der Handshake sagt, wann die Strecke zuletzt stand.</p>`;
  }

  const t = f.test;
  return `${f.error ? `<div class="row" style="gap:8px;align-items:flex-start;color:var(--crit)">${dot("crit")}<span style="font-size:13px;white-space:pre-line">${esc(f.error)}</span></div>` : ""}
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
      </div>` : ""}`;
}
