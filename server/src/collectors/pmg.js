/* Proxmox Mail Gateway.

   Der Sammler steht bewusst nicht bei VE und Backup Server in
   proxmox.js, obwohl das Produkt denselben Namen trägt. Der Grund ist
   die Anmeldung:

   **PMG kennt keine API-Token.** Die Kopfzeile `PMGAPIToken=…` ist in
   der Dokumentation zwar an jedem Endpunkt als erlaubt vermerkt (das
   Schema wird aus derselben Vorlage erzeugt wie bei VE) — der
   HTTP-Dienst von PMG weist sie aber schon vor jeder Rechteprüfung ab:

       die "API tokens not implemented\n" if $api_token;
       (pmg-api, src/PMG/HTTPServer.pm)

   Angemeldet wird deshalb wie an der Oberfläche: Benutzer und Passwort
   gegen `/access/ticket`, das ausgestellte Ticket wandert danach als
   Cookie `PMGAuthCookie` an jedem Abruf mit. Es gilt zwei Stunden; wir
   holen nach 90 Minuten ein neues und bei einer 401 sofort. Ein
   Anmeldevorgang je Durchlauf wäre nicht nur unnötig, er stünde auch
   alle 15 Sekunden im Syslog des Gateways.

   Der Benutzer gehört in die Rolle **Auditor**. Sie deckt alles ab, was
   hier gelesen wird — Statistik, Warteschlange, Dienste, Quarantäne,
   Signaturen. Geschrieben wird nichts; POST gibt es hier nur für das
   Ticket selbst.

   Ein Wort zum Takt: der Durchlauf kommt alle 15 s, ein Mail Gateway
   ist aber kein Messgerät. Die Tagesstatistik ändert sich in 15 s nicht
   messbar, `qshape` startet je Abruf einen Prozess auf dem Gerät, und
   `apt/update` liest eine Liste, die einmal am Tag erneuert wird.
   Deshalb hat dieser Sammler einen eigenen Takt (siehe `pmg_takt` und
   `pmg_takt_lang` in den Einstellungen) und gibt zwischendurch die
   zuletzt gelesenen Werte zurück. Die Erreichbarkeit misst weiterhin
   der Prober in jedem Durchlauf — die Ampel „antwortet nicht" bleibt
   also unverzögert. */

import { requestJson } from "../http.js";
import { schwellenFuer } from "../inventory.js";

const DEFAULT_PORT = 8006;

/* Ein Ticket gilt zwei Stunden. Wir erneuern nach 90 Minuten — mit einer
   halben Stunde Luft, damit ein langsamer Durchlauf nicht in die
   Ablauffrist gerät. */
const TICKET_GILT = 90 * 60 * 1000;

export const RECHTEHINWEIS =
  "In PMG unter Configuration → User Management einen Benutzer im Realm „pmg“ anlegen und ihm die Rolle "
  + "Auditor geben. Der Benutzername gehört mit Realm eingetragen (leitstand@pmg) — ohne Realm hängt PMG "
  + "„@quarantine“ an und die Anmeldung schlägt fehl. API-Token gibt es bei PMG nicht: der Dienst weist sie ab, "
  + "auch wenn die API-Dokumentation sie an jedem Endpunkt ausweist.";

export function baseUrl(host) {
  if (host.url) {
    try {
      const u = new URL(host.url);
      return `${u.protocol}//${u.hostname}:${u.port || DEFAULT_PORT}`;
    } catch {}
  }
  return `https://${host.ip}:${DEFAULT_PORT}`;
}

/* ---------- Anmeldung ---------- */
const TICKETS = new Map();   /* hostId -> { ticket, rolle, benutzer, bis } */

/* Nach einer Änderung der Zugangsdaten und in Tests: das gemerkte Ticket
   ist dann eine Auskunft über einen Zustand, den es nicht mehr gibt. */
export function ticketVergessen(hostId = null) {
  if (hostId) TICKETS.delete(hostId); else TICKETS.clear();
}

export async function anmelden(host, cred, timeout = 8000) {
  const benutzer = cred?.user || cred?.username;
  const passwort = cred?.password || cred?.secret;
  if (!benutzer || !passwort) return { ok: false, error: "Kein Benutzer und Passwort hinterlegt" };

  const r = await requestJson(`${baseUrl(host)}/api2/json/access/ticket`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(benutzer)}&password=${encodeURIComponent(passwort)}`,
    timeout
  });
  if (!r.ok) return { ok: false, status: r.status, error: r.error, ms: r.ms };
  const d = r.data?.data || {};
  if (!d.ticket) return { ok: false, error: "Antwort ohne Ticket" };
  const eintrag = { ticket: d.ticket, rolle: d.role || null, benutzer: d.username || benutzer, bis: Date.now() + TICKET_GILT };
  TICKETS.set(host.id, eintrag);
  return { ok: true, ...eintrag, ms: r.ms };
}

async function ticketFuer(host, cred, timeout) {
  const alt = TICKETS.get(host.id);
  if (alt && alt.bis > Date.now()) return { ok: true, ...alt };
  return anmelden(host, cred, timeout);
}

/* Ein lesender Abruf. Läuft das Ticket zwischen zwei Durchläufen ab —
   etwa weil PMG neu gestartet wurde und seinen Schlüssel gewechselt hat —,
   kommt eine 401. Die ist hier kein Fehler, sondern der Anlass, sich neu
   anzumelden; einmal, nicht in einer Schleife. */
export async function api(host, cred, pfad, timeout = 8000) {
  const t = await ticketFuer(host, cred, timeout);
  if (!t.ok) return { ok: false, status: t.status, error: t.error };

  const hole = ticket => requestJson(`${baseUrl(host)}/api2/json${pfad}`, {
    headers: { Cookie: `PMGAuthCookie=${ticket}` }, timeout
  });

  let r = await hole(t.ticket);
  if (r.status === 401) {
    TICKETS.delete(host.id);
    const neu = await anmelden(host, cred, timeout);
    if (!neu.ok) return { ok: false, status: neu.status, error: neu.error };
    r = await hole(neu.ticket);
  }
  return r;
}

const daten = r => (r?.ok ? r.data?.data ?? null : null);

/* ---------- Was die Diagnose Schritt für Schritt abfragt ---------- */
export const PFADE = [
  { pfad: "/version", zweck: "angemeldet und Fassung lesbar" },
  { pfad: "/nodes", zweck: "Knotenliste — daraus kommt der Name für die Knotenpfade" },
  { pfad: "/statistics/mail", zweck: "Ein- und Ausgang, Spam, Viren, Abweisungen der letzten 24 h" },
  { pfad: "/nodes/{knoten}/status", zweck: "Auslastung, Laufzeit, Fassung, Abgleich im Verbund" },
  { pfad: "/nodes/{knoten}/postfix/qshape?queue=deferred", zweck: "liegen gebliebene Mail und ihr Alter" },
  { pfad: "/nodes/{knoten}/services", zweck: "laufen Postfix, Filter, Datenbank und Virenscanner", optional: true },
  { pfad: "/nodes/{knoten}/clamav/database", zweck: "Stand der Virensignaturen", optional: true },
  { pfad: "/quarantine/spamstatus", zweck: "Umfang der Spam-Quarantäne", optional: true },
  { pfad: "/statistics/domains", zweck: "Verkehr je Domäne", optional: true }
];

export function befund(pfad, data) {
  const d = data?.data ?? data;
  if (pfad === "/version") return `Mail Gateway ${d?.version || "?"}${d?.release ? " (" + d.release + ")" : ""}`;
  if (pfad === "/nodes") return `${(d || []).length} Knoten: ${(d || []).map(n => n.node).join(", ") || "keiner"}`;
  if (pfad.startsWith("/statistics/mail"))
    return `${zahl(d?.count_in) ?? "?"} eingehend, ${zahl(d?.count_out) ?? "?"} ausgehend, `
      + `${zahl(d?.spamcount_in) ?? "?"} Spam, ${zahl(d?.viruscount_in) ?? "?"} Viren`;
  if (pfad.includes("/status"))
    return `Laufzeit ${d?.uptime ? tage(d.uptime) : "?"}, ${d?.pmgversion || "Fassung unbekannt"}`
      + (d?.insync === 0 ? ", Datenbank NICHT abgeglichen" : "");
  if (pfad.includes("qshape")) {
    const g = gesamtzeile(d);
    return g ? `${g.total} Mail in der Warteschlange` : "Warteschlange leer";
  }
  if (pfad.includes("/services")) {
    const liste = d || [];
    const steht = liste.filter(s => KERN.has(s.service) && s.state !== "running");
    return `${liste.length} Dienste — ${steht.length ? "steht: " + steht.map(s => s.service).join(", ") : "alle Kerndienste laufen"}`;
  }
  if (pfad.includes("clamav"))
    return (d || []).map(x => `${x.name || x.type}: ${x.nsigs} Signaturen von ${x.build_time}`).join(" · ") || "keine Datenbank gefunden";
  if (pfad.includes("spamstatus")) return `${zahl(d?.count) ?? "?"} Mail in Quarantäne (${zahl(d?.mbytes) ?? "?"} MB)`;
  if (pfad === "/statistics/domains") return `${(d || []).length} Domäne(n) mit Verkehr`;
  return "Antwort erhalten";
}

export function hintFor(r) {
  if (r.status === 401) return RECHTEHINWEIS;
  if (r.status === 403) return "Angemeldet, aber ohne Recht auf diesen Zweig — die Rolle Auditor deckt alles ab, was gelesen wird.";
  if (r.status === 404) return "Erreicht, aber kein PMG-Endpunkt — Port prüfen (Mail Gateway 8006).";
  if (/abgewiesen/.test(r.error || "")) return "Port stimmt vermutlich nicht: die Oberfläche des Mail Gateways liegt auf 8006.";
  return null;
}

/* ---------- Verbindungstest für die Verwaltung ---------- */
export async function testConnection(host, cred) {
  const an = await anmelden(host, cred, 6000);
  if (!an.ok) return { ok: false, detail: an.error, hint: hintFor(an) };

  const ver = await api(host, cred, "/version", 6000);
  const fassung = daten(ver)?.version || null;

  /* Angemeldet heißt noch nicht lesend: die Rolle „Quarantine User" darf
     sich anmelden und sieht von den Kennzahlen nichts. Geprüft wird
     deshalb der Aufruf, an dem der Sammler wirklich hängt. */
  const stat = await api(host, cred, `/statistics/mail?starttime=${vor24h()}`, 6000);
  if (!stat.ok) {
    return {
      ok: false, version: fassung, ms: an.ms,
      detail: `Angemeldet als ${an.benutzer}${an.rolle ? " (Rolle " + an.rolle + ")" : ""} — `
        + `aber die Statistik ist nicht lesbar: ${stat.error}`,
      hint: hintFor(stat)
    };
  }
  const d = daten(stat) || {};
  return {
    ok: true, version: fassung, ms: an.ms,
    detail: `Verbunden — Mail Gateway ${fassung || "?"} · angemeldet als ${an.benutzer}`
      + `${an.rolle ? " mit Rolle " + an.rolle : ""} · ${zahl(d.count_in) ?? 0} eingehende Mail in 24 h`,
    hint: an.rolle && an.rolle !== "audit" && an.rolle !== "admin" && an.rolle !== "root"
      ? `Die Rolle „${an.rolle}“ reicht heute, ist aber mehr als nötig oder zu wenig auf Dauer — vorgesehen ist Auditor.`
      : null
  };
}

/* ---------- Sammler ----------
   Zwei Takte, ein Ergebnis: was sich im Minutentakt ändert (Auslastung,
   Warteschlange, Dienste) und was sich im Stundentakt ändert (Statistik,
   Quarantäne, Signaturen, Paketstand). Dazwischen wird das zuletzt
   Gelesene weitergereicht — mit `stand`, damit die Oberfläche sagen kann,
   wie alt es ist. */
const SPEICHER = new Map();   /* hostId -> { knoten, betrieb, lang } */

export function speicherVergessen(hostId = null) {
  if (hostId) SPEICHER.delete(hostId); else SPEICHER.clear();
}

export async function collectPmg(host, cred, settings = {}) {
  const jetzt = Date.now();
  const takt = (zahl(settings.pmg_takt) ?? 60) * 1000;
  const taktLang = (zahl(settings.pmg_takt_lang) ?? 300) * 1000;
  const s = SPEICHER.get(host.id) || {};

  /* Der Knotenname steht am Anfang jeder Knotenadresse. Er ändert sich
     nicht, solange das Gerät dasselbe ist — einmal holen genügt. */
  if (!s.knoten) {
    const r = await api(host, cred, "/nodes");
    if (!r.ok) return { error: r.error, status: r.status === 401 || r.status === 403 ? "warn" : undefined, note: r.error };
    const liste = daten(r) || [];
    s.knoten = knotenAus(liste, host);
    if (!s.knoten) return { error: "Knoten in der Antwort nicht gefunden", note: `Antwort enthält: ${liste.map(n => n.node).join(", ") || "nichts"}` };
  }

  /* Ein gescheiterter Abruf lässt die zuletzt gelesenen Werte stehen —
     aber nicht stillschweigend. Sonst zeigte die Oberfläche stundenlang
     eine leere Warteschlange, weil niemand mehr nachsehen darf. Der
     Fehler kommt mit, der Kern macht daraus eine gelbe Ampel, und wie
     alt der Stand ist, steht daneben. */
  s.fehler = null;
  if (!s.betrieb || jetzt - s.betrieb.stand >= takt) {
    const d = await betriebsdaten(host, cred, s.knoten);
    if (d) s.betrieb = { stand: jetzt, d };
    else s.fehler = "Auslastung, Warteschlange und Dienste sind nicht abrufbar";
  }
  if (!s.lang || jetzt - s.lang.stand >= taktLang) {
    const d = await langsameDaten(host, cred, s.knoten);
    if (d) s.lang = { stand: jetzt, d };
    else s.fehler = s.fehler || "Die Statistik ist nicht abrufbar";
  }
  SPEICHER.set(host.id, s);

  if (!s.betrieb && !s.lang) return { error: s.fehler || "Kein Abruf kam durch", note: s.fehler || "Kein Abruf kam durch" };

  const out = {
    node: s.knoten,
    ...(s.lang?.d || {}),
    ...(s.betrieb?.d || {}),
    stand: s.betrieb ? new Date(s.betrieb.stand).toISOString() : null,
    statStand: s.lang ? new Date(s.lang.stand).toISOString() : null
  };
  if (s.fehler) out.error = s.fehler;
  return bewerte(out, host, settings);
}

/* ---------- Was jede Minute neu gelesen wird ---------- */
async function betriebsdaten(host, cred, knoten) {
  const n = encodeURIComponent(knoten);
  const [statusRes, dienstRes, deferredRes, activeRes, holdRes] = await Promise.all([
    api(host, cred, `/nodes/${n}/status`),
    api(host, cred, `/nodes/${n}/services`),
    api(host, cred, `/nodes/${n}/postfix/qshape?queue=deferred`),
    api(host, cred, `/nodes/${n}/postfix/qshape?queue=active`),
    api(host, cred, `/nodes/${n}/postfix/qshape?queue=hold`)
  ]);
  if (!statusRes.ok && !dienstRes.ok && !deferredRes.ok) return null;

  const out = {};
  knotenstatus(out, daten(statusRes));
  if (!statusRes.ok) out.statusNote = statusRes.error;
  dienste(out, dienstRes);
  warteschlange(out, { deferred: deferredRes, active: activeRes, hold: holdRes });
  return out;
}

/* ---------- Was alle paar Minuten genügt ---------- */
async function langsameDaten(host, cred, knoten) {
  const n = encodeURIComponent(knoten);
  const seit = vor24h();
  const [mailRes, verRes, virusRes, domRes, spamQRes, virusQRes, avRes, aptRes] = await Promise.all([
    api(host, cred, `/statistics/mail?starttime=${seit}`),
    api(host, cred, "/version"),
    api(host, cred, `/statistics/virus?starttime=${seit}`),
    api(host, cred, `/statistics/domains?starttime=${seit}`),
    api(host, cred, "/quarantine/spamstatus"),
    api(host, cred, "/quarantine/virusstatus"),
    api(host, cred, `/nodes/${n}/clamav/database`),
    api(host, cred, `/nodes/${n}/apt/update`)
  ]);
  if (!mailRes.ok && !verRes.ok) return null;

  const out = { version: daten(verRes)?.version || null };
  verkehr(out, mailRes);
  out.viren = (daten(virusRes) || [])
    .map(v => ({ name: String(v.name || "—"), anzahl: zahl(v.count) ?? 0 }))
    .sort((a, b) => b.anzahl - a.anzahl).slice(0, 10);
  out.domains = (daten(domRes) || []).map(d => ({
    domain: String(d.domain || "—"),
    ein: zahl(d.count_in), aus: zahl(d.count_out),
    spam: zahl(d.spamcount_in), virus: zahl(d.viruscount_in),
    bytesEin: zahl(d.bytes_in), bytesAus: zahl(d.bytes_out)
  })).sort((a, b) => ((b.ein ?? 0) + (b.aus ?? 0)) - ((a.ein ?? 0) + (a.aus ?? 0))).slice(0, 12);
  quarantaene(out, spamQRes, virusQRes);
  signaturen(out, avRes);
  pakete(out, aptRes);
  return out;
}

/* ---------- Knoten ---------- */
function knotenAus(liste, host) {
  if (!Array.isArray(liste) || !liste.length) return null;
  if (liste.length === 1) return liste[0].node;
  const gesucht = [host.name, host.id].filter(Boolean).map(x => String(x).toLowerCase());
  const treffer = liste.find(n => gesucht.includes(String(n.node).toLowerCase()));
  /* Ohne Treffer der erste: PMG stellt den eigenen Knoten an den Anfang. */
  return treffer ? treffer.node : liste[0].node;
}

function knotenstatus(out, d) {
  if (!d) return;
  out.cpu = pct(d.cpu);
  out.ram = d.memory?.total ? pct(d.memory.used / d.memory.total) : null;
  /* Ein Mail Gateway hat genau eine Platte, die zählt: die Wurzel. Läuft
     sie voll, nimmt Postfix keine Mail mehr an. */
  out.disk = d.rootfs?.total ? pct(d.rootfs.used / d.rootfs.total) : null;
  out.diskFreiGb = Number.isFinite(d.rootfs?.avail) ? Math.round(d.rootfs.avail / 1073741824) : null;
  out.swap = d.swap?.total ? pct(d.swap.used / d.swap.total) : null;
  out.uptime = Number.isFinite(d.uptime) ? tage(d.uptime) : null;
  out.uptimeSeconds = zahl(d.uptime);
  const last = Array.isArray(d.loadavg) ? Number(d.loadavg[0]) : NaN;
  out.load1 = Number.isFinite(last) ? last : null;
  out.cores = zahl(d.cpuinfo?.cpus);
  out.sockets = zahl(d.cpuinfo?.sockets);
  out.cpuModel = d.cpuinfo?.model || null;
  out.kernel = kurzKernel(d.kversion || d["current-kernel"]?.release);
  out.pmgVersion = d.pmgversion || null;
  /* PMG meldet 1/0. Im Verbund heißt eine 0: die Regeldatenbank dieses
     Knotens ist seit über drei Minuten nicht mehr abgeglichen — er
     filtert dann nach einem anderen Regelwerk als seine Nachbarn. Ohne
     Verbund steht dort immer 1. */
  out.insync = d.insync === undefined ? null : !!d.insync;
}

/* ---------- Dienste ----------
   Ein Mail Gateway, dessen Filterdienst steht, nimmt Mail weiter an und
   stellt sie ungeprüft zu — von außen sieht das aus wie Betrieb. Genau
   deshalb steht diese Prüfung hier und nicht bei den Nebensächlichkeiten.

   `pmgtunnel` und `pmgmirror` laufen nur im Verbund; sie fehlen auf einem
   einzelnen Gerät oder stehen dort, ohne dass etwas kaputt wäre. */
const KERN = new Set(["postfix", "pmg-smtp-filter", "pmgproxy", "pmgdaemon", "pmgpolicy", "postgres", "clamav-daemon"]);
const NEBEN = new Set(["clamav-freshclam", "rsyslog", "ssh", "chrony", "systemd-timesyncd"]);

function dienste(out, r) {
  if (!r.ok) { out.dienste = null; out.diensteNote = r.error; return; }
  const liste = daten(r) || [];
  out.dienste = liste.map(x => ({
    name: String(x.service || x.name || "—"),
    beschreibung: x.desc || null,
    zustand: x.state || null,
    aktiv: x["active-state"] || null,
    kern: KERN.has(x.service)
  })).sort((a, b) => (b.kern - a.kern) || a.name.localeCompare(b.name, "de"));
  out.diensteNote = null;
  out.diensteSteht = out.dienste.filter(d => d.kern && d.zustand !== "running").map(d => d.name);
  out.diensteAuffaellig = out.dienste
    .filter(d => !d.kern && NEBEN.has(d.name) && d.aktiv === "failed").map(d => d.name);
}

/* ---------- Warteschlange ----------
   `qshape` liefert je Domäne eine Zeile mit der Gesamtzahl und der
   Verteilung nach Alter — 5, 10, 20 … 1280 Minuten und darüber. Die
   erste Zeile heißt TOTAL und ist die Summe.

   Die Zahl allein sagt wenig: zwanzig Mail in der Zustellung sind
   Betrieb, zwanzig Mail seit einem Tag sind ein liegen gebliebener
   Empfänger. Deshalb wird beides geführt. */
const ALTER = ["5m", "10m", "20m", "40m", "80m", "160m", "320m", "640m", "1280m", "1280m+"];

export function gesamtzeile(zeilen) {
  if (!Array.isArray(zeilen)) return null;
  return zeilen.find(z => String(z?.domain || "").toUpperCase() === "TOTAL") || null;
}

function eineQueue(r) {
  if (!r?.ok) return { anzahl: null, note: r?.error || "nicht gelesen", domains: [], verteilung: null, aelter: null };
  const zeilen = daten(r) || [];
  const g = gesamtzeile(zeilen);
  /* Leere Warteschlange: qshape gibt dann gar keine TOTAL-Zeile aus.
     Null ist hier eine Messung und keine Lücke. */
  if (!g) return { anzahl: 0, note: null, domains: [], verteilung: null, aelter: 0 };
  const verteilung = ALTER.map(k => ({ bis: k, anzahl: zahl(g[k]) ?? 0 }));
  return {
    anzahl: zahl(g.total) ?? 0,
    note: null,
    verteilung,
    /* Alles ab 640 Minuten: über zehn Stunden unterwegs. Was so lange
       liegt, geht nicht von selbst weg. */
    aelter: (zahl(g["640m"]) ?? 0) + (zahl(g["1280m"]) ?? 0) + (zahl(g["1280m+"]) ?? 0),
    domains: zeilen.filter(z => z !== g)
      .map(z => ({ domain: String(z.domain || "—"), anzahl: zahl(z.total) ?? 0 }))
      .sort((a, b) => b.anzahl - a.anzahl).slice(0, 8)
  };
}

function warteschlange(out, res) {
  const d = eineQueue(res.deferred), a = eineQueue(res.active), h = eineQueue(res.hold);
  out.queueDeferred = d.anzahl;
  out.queueAktiv = a.anzahl;
  out.queueHold = h.anzahl;
  out.queueAlt = d.aelter;
  out.queueNote = d.note;
  out.warteschlange = [
    { queue: "deferred", label: "zurückgestellt", ...d },
    { queue: "active", label: "in Zustellung", ...a },
    { queue: "hold", label: "angehalten", ...h }
  ];
}

/* ---------- Mailverkehr ---------- */
function verkehr(out, r) {
  if (!r.ok) { out.verkehrNote = r.error; return; }
  const d = daten(r) || {};
  out.verkehrNote = null;
  out.in24 = zahl(d.count_in);
  out.out24 = zahl(d.count_out);
  out.spam = zahl(d.spamcount_in);
  out.spamAus = zahl(d.spamcount_out);
  out.virus = zahl(d.viruscount_in);
  out.virusAus = zahl(d.viruscount_out);
  out.bytesEin = zahl(d.bytes_in);
  out.bytesAus = zahl(d.bytes_out);
  out.greylist = zahl(d.glcount);
  out.rbl = zahl(d.rbl_rejects);
  out.pregreet = zahl(d.pregreet_rejects);
  out.spf = zahl(d.spfcount);
  out.bouncesEin = zahl(d.bounces_in);
  out.bouncesAus = zahl(d.bounces_out);
  out.junkEin = zahl(d.junk_in);
  /* PMG rechnet in Sekunden; in Millisekunden liest es sich wie jede
     andere Bearbeitungszeit im Leitstand. */
  out.avgMs = Number.isFinite(Number(d.avptime)) ? Math.round(Number(d.avptime) * 1000) : null;
  /* Anteil am tatsächlich angenommenen Eingang. Was postscreen schon an
     der Tür abgewiesen hat, ist nie eingegangen und steht getrennt. */
  out.spamAnteil = out.in24 ? pct(out.spam / out.in24) : null;
  out.abgewiesen = summe([out.rbl, out.pregreet, out.spf, out.greylist]);
}

/* ---------- Quarantäne ---------- */
function quarantaene(out, spamRes, virusRes) {
  const s = daten(spamRes), v = daten(virusRes);
  out.quarSpam = zahl(s?.count);
  out.quarSpamMb = zahl(s?.mbytes) != null ? Math.round(zahl(s.mbytes)) : null;
  out.quarSpamSchnitt = zahl(s?.avgspam) != null ? Math.round(zahl(s.avgspam) * 10) / 10 : null;
  out.quarVirus = zahl(v?.count);
  out.quarVirusMb = zahl(v?.mbytes) != null ? Math.round(zahl(v.mbytes)) : null;
  out.quarNote = spamRes.ok ? null : spamRes.error;
}

/* ---------- Virensignaturen ----------
   Der stillste aller Ausfälle: freshclam kommt nicht mehr durch, ClamAV
   läuft weiter und meldet nichts. Der Scanner arbeitet dann mit dem
   Stand von vorgestern, und niemand merkt es — bis es zählt.

   Der Zeitstempel kommt als „16 Mar 2026 23-17 +0000“; die Stunde ist
   mit einem Strich vom Minutenwert getrennt, das ist keine Fassung von
   ISO 8601, sondern das Format der ClamAV-Kopfzeile. */
const MONATE = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function bauzeit(s) {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2})-(\d{2})\s*([+-]\d{4})?$/.exec(String(s || "").trim());
  if (!m) return null;
  const monat = MONATE[m[2].toLowerCase()];
  if (monat === undefined) return null;
  let ms = Date.UTC(Number(m[3]), monat, Number(m[1]), Number(m[4]), Number(m[5]));
  if (m[6]) {
    const vz = m[6][0] === "-" ? 1 : -1;
    ms += vz * ((Number(m[6].slice(1, 3)) * 60 + Number(m[6].slice(3, 5))) * 60000);
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function signaturen(out, r) {
  if (!r.ok) { out.signaturen = null; out.signaturNote = r.error; return; }
  const liste = daten(r) || [];
  out.signaturNote = null;
  out.signaturen = liste.map(x => {
    const stand = bauzeit(x.build_time);
    return {
      name: String(x.name || x.type || "—"),
      version: x.version ?? null,
      anzahl: zahl(x.nsigs),
      stand,
      alterStunden: stand ? Math.max(0, Math.round((Date.now() - Date.parse(stand)) / 3600000)) : null
    };
  });
  /* Bewertet wird „daily": „main" ist von Haus aus Monate alt, das ist
     kein Mangel. Fehlt „daily", nimmt die Bewertung die jüngste Datei —
     alles andere wäre eine Aussage über eine Datei, die es nicht gibt. */
  const tag = out.signaturen.find(x => x.name === "daily")
    || out.signaturen.filter(x => x.alterStunden != null).sort((a, b) => a.alterStunden - b.alterStunden)[0];
  out.signaturAlter = tag?.alterStunden ?? null;
  out.signaturStand = tag?.stand ?? null;
}

/* ---------- Ausstehende Pakete ----------
   Wie beim Proxmox-Knoten: eine Auskunft, keine Störung. Fehlt das
   Recht, bleibt die Zahl leer statt auf null zu fallen. */
function pakete(out, r) {
  if (!r.ok) { out.updates = null; out.updatesNote = r.error; return; }
  const liste = daten(r) || [];
  out.updates = liste.length;
  out.updatesNote = null;
  out.updateListe = liste.slice(0, 20).map(p => ({
    paket: p.Package || "—", von: p.OldVersion || null, auf: p.Version || null, titel: p.Title || null
  }));
}

/* ---------- Ampel ----------
   Zwei Entscheidungen stehen hinter dieser Reihenfolge:

   1. **Ein eingehender Virenfund ist keine Störung.** Er ist der
      Normalbetrieb eines Mail Gateways — dafür steht es da. Eine Ampel,
      die bei jedem abgewehrten Anhang gelb wird, ist nach zwei Wochen
      abtrainiert, und mit ihr die Ampel für alles andere. Die Zahl steht
      groß auf der Karte, aber sie leuchtet nicht.

   2. **Ein ausgehender Virenfund ist rot.** Er heißt: hier im Haus
      verschickt jemand Schadsoftware. Das ist kein Mailproblem, das ist
      ein befallenes Gerät, und es ist die einzige Zahl dieser
      Statistik, für die man nachts geweckt werden will. */
function bewerte(out, host, settings) {
  const grenze = schwellenFuer(host, settings);
  const qWarn = zahl(settings.mail_queue_warn) ?? 25;
  const qCrit = zahl(settings.mail_queue_crit) ?? 100;
  out.schwellen = grenze;
  out.queueGrenzen = { warn: qWarn, crit: qCrit };

  const steht = out.diensteSteht || [];
  if (steht.length) {
    out.status = "crit";
    out.note = `${steht.join(", ")} ${steht.length > 1 ? "stehen" : "steht"} — Mail wird nicht${steht.includes("pmg-smtp-filter") || steht.includes("clamav-daemon") ? " geprüft" : " angenommen oder zugestellt"}`;
  } else if (out.virusAus > 0) {
    out.status = "crit";
    out.note = `${out.virusAus} ausgehende(r) Virenfund(e) in 24 h — hier verschickt ein Gerät im eigenen Netz Schadsoftware`;
  } else if (out.queueDeferred != null && out.queueDeferred >= qCrit) {
    out.status = "crit";
    out.note = `${out.queueDeferred} Mail zurückgestellt (kritisch ab ${qCrit})`
      + (out.queueAlt ? `, davon ${out.queueAlt} seit über zehn Stunden` : "");
  } else if (out.disk != null && out.disk >= grenze.disk_crit) {
    out.status = "crit";
    out.note = `Wurzeldateisystem zu ${out.disk} % belegt (kritisch ab ${grenze.disk_crit} %) — ein volles Gateway nimmt keine Mail mehr an`;
  } else if (out.ram != null && out.ram >= grenze.ram_crit) {
    out.status = "crit";
    out.note = `Arbeitsspeicher ${out.ram} % belegt (kritisch ab ${grenze.ram_crit} %)`;
  } else if (out.insync === false) {
    out.status = "warn";
    out.note = "Regeldatenbank ist im Verbund nicht abgeglichen — dieser Knoten filtert nach einem anderen Regelwerk als seine Nachbarn";
  } else if (out.queueDeferred != null && out.queueDeferred >= qWarn) {
    out.status = "warn";
    out.note = `${out.queueDeferred} Mail zurückgestellt`
      + (out.queueAlt ? `, davon ${out.queueAlt} seit über zehn Stunden` : "");
  } else if (out.queueAlt > 0) {
    out.status = "warn";
    out.note = `${out.queueAlt} Mail liegt seit über zehn Stunden in der Warteschlange`;
  } else if (out.disk != null && out.disk >= grenze.disk_warn) {
    out.status = "warn"; out.note = `Wurzeldateisystem zu ${out.disk} % belegt`;
  } else if (out.ram != null && out.ram >= grenze.ram_warn) {
    out.status = "warn"; out.note = `Arbeitsspeicher ${out.ram} % belegt`;
  } else if (out.signaturAlter != null && out.signaturAlter >= 24) {
    /* Nicht rot: der Scanner läuft, er ist nur nicht mehr auf dem
       neuesten Stand. Rot wäre er erst, wenn er gar nicht liefe — und
       das steht oben. */
    out.status = "warn";
    out.note = `Virensignaturen sind ${out.signaturAlter} Stunden alt — läuft freshclam noch?`;
  } else if ((out.diensteAuffaellig || []).length) {
    out.status = "warn";
    out.note = `${out.diensteAuffaellig.join(", ")} meldet sich als fehlgeschlagen`;
  } else if (out.queueHold > 0) {
    /* Angehaltene Mail ist keine Störung — sie ist eine Entscheidung.
       Aber eine, die jemand getroffen und dann vergessen hat, wenn sie
       Wochen alt wird. Deshalb als Notiz, ohne Ampel. */
    out.note = `${out.queueHold} Mail ist angehalten (hold) und wartet auf eine Entscheidung`;
  } else if (out.virus > 0) {
    out.note = `${out.virus} eingehende(r) Virenfund(e) in 24 h — abgewehrt`;
  } else if (out.updates) {
    out.note = `${out.updates} Paketaktualisierung(en) stehen aus`;
  }
  return out;
}

/* ---------- Kleinkram ---------- */
const zahl = v => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pct = f => (Number.isFinite(Number(f)) ? Math.round(Number(f) * 100) : null);
const tage = s => `${Math.floor(s / 86400)} T`;
const summe = liste => {
  const echte = liste.filter(v => v != null);
  return echte.length ? echte.reduce((a, b) => a + b, 0) : null;
};
const vor24h = () => Math.floor(Date.now() / 1000) - 86400;
function kurzKernel(v) {
  if (!v) return null;
  const m = /(\d+\.\d+[\w.+-]*)/.exec(String(v));
  return m ? m[1] : String(v);
}
