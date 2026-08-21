/* AdGuard Home — der Dienst, dessen Ausfall im ganzen Netz sofort weh tut.

   Bis hierhin wurde er nur angepingt: ein offener Port sagt aber nichts
   darüber, ob noch gefiltert wird. Ein AdGuard mit abgeschaltetem Schutz
   antwortet tadellos — und lässt alles durch.

   Anmeldung: HTTP Basic mit demselben Benutzer, mit dem man sich an der
   Oberfläche anmeldet. Einen eigenen Nur-Lese-Zugang kennt AdGuard nicht;
   der Leitstand ruft ausschließlich lesende Endpunkte auf.

   Was die API **nicht** hergibt: eine Zahl für Upstream-Fehler. Weder
   /control/status noch /control/stats führen sie, und das Abfragen des
   Anfrageprotokolls für eine Kennzahl wäre unverhältnismäßig. Also steht
   dort nichts — lieber eine Lücke als eine erfundene Zahl. */

import { requestJson } from "../http.js";

export function authHeader(cred) {
  if (!cred) return null;
  const user = cred.user || cred.username;
  const pass = cred.password || cred.secret;
  if (!user || !pass) return null;
  return { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") };
}

/* Anders als bei OPNsense bleibt ein Pfad in der Adresse stehen: AdGuard
   liegt oft hinter einem Reverse Proxy unter einem Unterpfad
   (https://proxy/adguard/), und ohne diesen Teil ginge jeder Aufruf ins
   Leere der Startseite. */
export function baseUrl(host) {
  if (host.url) {
    try {
      const u = new URL(host.url);
      const pfad = u.pathname.replace(/\/+$/, "");
      return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}${pfad}`;
    } catch {}
  }
  return `https://${host.ip}`;
}

export const PFADE = [
  { pfad: "/control/status", zweck: "läuft der DNS-Dienst, ist der Schutz an, welche Fassung" },
  { pfad: "/control/stats", zweck: "Anfragen, Blockanteil, mittlere Bearbeitungszeit" },
  { pfad: "/control/filtering/status", zweck: "Filterlisten und Regelzahl", optional: true },
  { pfad: "/control/dns_info", zweck: "eingetragene Upstreams", optional: true }
];

export async function api(host, cred, pfad, timeout = 8000) {
  const headers = authHeader(cred);
  if (!headers) return { ok: false, error: "Kein Zugang hinterlegt" };
  return requestJson(`${baseUrl(host)}${pfad}`, { headers, timeout });
}

/* Was aus einer geglückten Antwort für die Diagnose zählt. */
export function befund(pfad, data) {
  const d = data || {};
  if (pfad === "/control/status")
    return `AdGuard ${d.version || "?"} — DNS ${d.running ? "läuft" : "steht"}, `
      + `Schutz ${d.protection_enabled ? "an" : "AUS"}`;
  if (pfad === "/control/stats") {
    const f = fenster(d);
    const ms = bearbeitungszeit(d.avg_processing_time);
    return `${f.queries ?? "?"} Anfragen${f.label ? " / " + f.label : ""}`
      + (f.blocked != null ? `, ${f.blocked} geblockt` : "")
      + (ms != null ? `, Ø ${ms} ms` : "");
  }
  if (pfad === "/control/filtering/status") {
    const listen = [...(d.filters || []), ...(d.whitelist_filters || [])];
    const aktiv = listen.filter(f => f.enabled);
    return `${listen.length} Liste(n), ${aktiv.length} aktiv, `
      + `${aktiv.reduce((a, f) => a + (Number(f.rules_count) || 0), 0)} Regeln`;
  }
  if (pfad === "/control/dns_info") {
    const up = Array.isArray(d.upstream_dns) ? d.upstream_dns.filter(x => String(x || "").trim()) : [];
    return `${up.length} Upstream(s)${up.length ? ": " + up.slice(0, 4).join(", ") : ""}`;
  }
  return "Antwort erhalten";
}

export function hintFor(r) {
  if (r.status === 401 || r.status === 403)
    return "Benutzer oder Passwort stimmen nicht. Es sind dieselben, mit denen man sich an der AdGuard-Oberfläche "
      + "anmeldet — angelegt werden sie in AdGuardHome.yaml unter „users“ oder beim ersten Einrichten.";
  if (r.status === 404)
    return "Erreicht, aber kein AdGuard-Endpunkt. Liegt die Oberfläche hinter einem Reverse Proxy unter einem "
      + "Unterpfad, gehört dieser mit in die Adresse (z. B. https://proxy/adguard).";
  if (/abgewiesen/.test(r.error || ""))
    return "Port prüfen: die AdGuard-Oberfläche läuft je nach Einrichtung auf 80, 3000 oder hinter einem Proxy auf 443.";
  return null;
}

/* ---------- Verbindungstest ---------- */
export async function testConnection(host, cred) {
  const st = await api(host, cred, "/control/status", 6000);
  if (!st.ok) return { ok: false, detail: st.error, hint: hintFor(st) };

  const d = st.data || {};
  const teile = [`Verbunden — AdGuard Home${d.version ? " " + d.version : ""}`];
  teile.push(d.protection_enabled === false ? "Schutz ist ABGESCHALTET" : "Schutz aktiv");

  /* Der Zustand allein wäre ein zu freundlicher Test: die Statistik hängt
     an demselben Zugang, aber an einem anderen Endpunkt — und sie ist
     das, was der Sammler wirklich braucht. */
  const stats = await api(host, cred, "/control/stats", 6000);
  if (!stats.ok) {
    return {
      ok: false,
      detail: teile.join(" · ") + ` — aber die Statistik ist nicht lesbar: ${stats.error}`,
      hint: hintFor(stats), version: d.version || null
    };
  }
  const f = fenster(stats.data || {});
  teile.push(f.queries != null ? `${f.queries} Anfragen${f.label ? " / " + f.label : ""} lesbar` : "Statistik lesbar");
  return { ok: true, detail: teile.join(" · "), version: d.version || null, ms: st.ms };
}

/* ---------- Sammler ---------- */
export async function collectAdguard(host, cred) {
  const [st, stats, filt, dns] = await Promise.all([
    api(host, cred, "/control/status"),
    api(host, cred, "/control/stats"),
    api(host, cred, "/control/filtering/status"),
    api(host, cred, "/control/dns_info")
  ]);

  if (!st.ok) return {
    error: st.error, note: st.error,
    status: (st.status === 401 || st.status === 403) ? "warn" : undefined
  };

  const d = st.data || {};
  const out = {
    version: d.version || null,
    dnsRunning: d.running === undefined ? null : !!d.running,
    protection: d.protection_enabled === undefined ? null : !!d.protection_enabled,
    dnsPort: zahl(d.dns_port),
    dnsAdressen: Array.isArray(d.dns_addresses) ? d.dns_addresses.length : null
  };

  statistik(out, stats);
  filterlisten(out, filt);
  upstreams(out, dns);
  ampel(out);
  return out;
}

/* ---------- Statistik ---------- */
function statistik(out, r) {
  if (!r.ok) {
    out.dnsQueries = null; out.dnsBlocked = null; out.blockRate = null; out.avgMs = null;
    out.statsFehler = r.error;
    return;
  }
  const d = r.data || {};
  const f = fenster(d);
  out.statsFenster = f.label;
  out.dnsQueries = f.queries;
  out.dnsBlocked = f.blocked;
  /* Ein Anteil ohne Grundgesamtheit ist keine Aussage. Und ohne eine
     einzige Anfrage gibt es keinen Blockanteil — auch nicht 0 %. */
  out.blockRate = f.queries > 0 && f.blocked != null
    ? Math.round((f.blocked / f.queries) * 1000) / 10
    : null;
  out.avgMs = bearbeitungszeit(d.avg_processing_time);
}

/* Welchen Zeitraum die Statistik überhaupt abdeckt.

   AdGuard führt sie über das eingestellte Fenster — Vorgabe 24 Stunden,
   es geht aber auch 7, 30 oder 90 Tage. „Anfragen 24 h" an eine Zahl zu
   schreiben, die drei Monate umfasst, wäre schlicht falsch. Steht die
   Statistik auf Stunden, werden deshalb die letzten 24 Eimer summiert;
   sonst wird der tatsächliche Zeitraum benannt. */
export function fenster(d) {
  const summe = a => a.reduce((x, y) => x + (Number(y) || 0), 0);
  const q = Array.isArray(d.dns_queries) ? d.dns_queries : null;
  const b = Array.isArray(d.blocked_filtering) ? d.blocked_filtering : null;

  if (q?.length && d.time_units === "hours") {
    const n = Math.min(24, q.length);
    return { label: `${n} h`, queries: summe(q.slice(-n)), blocked: b ? summe(b.slice(-n)) : null };
  }
  if (q?.length) {
    const einheit = d.time_units === "days" ? "Tage" : String(d.time_units || "Eimer");
    return { label: `${q.length} ${einheit}`, queries: summe(q), blocked: b ? summe(b) : null };
  }
  /* Ohne die Reihen bleiben die Gesamtzähler — dann ohne Angabe eines
     Zeitraums, denn er ist von hier aus nicht zu erkennen. */
  return { label: null, queries: zahl(d.num_dns_queries), blocked: zahl(d.num_blocked_filtering) };
}

/* Die mittlere Bearbeitungszeit.

   AdGuard dokumentiert sie in Sekunden (0,0234 = 23,4 ms), ältere
   Fassungen lieferten hier Millisekunden. Beides sieht gleich aus, solange
   man nur eine Zahl hat — deshalb wird nur der Fall umgedeutet, der als
   Sekunde absurd wäre: ein Mittelwert über fünf Sekunden je DNS-Anfrage
   käme in keinem laufenden Netz vor, fünf Millisekunden dagegen ständig.
   Alles darunter gilt als Sekunde, wie dokumentiert. */
export function bearbeitungszeit(v) {
  const n = zahl(v);
  if (n == null || n < 0) return null;
  const ms = n > 5 ? n : n * 1000;
  return Math.round(ms * 10) / 10;
}

/* ---------- Filterlisten ---------- */
function filterlisten(out, r) {
  if (!r.ok) { out.filters = null; out.filterRules = null; return; }
  const d = r.data || {};
  const listen = [...(Array.isArray(d.filters) ? d.filters : []), ...(Array.isArray(d.whitelist_filters) ? d.whitelist_filters : [])];
  out.filtering = d.enabled === undefined ? null : !!d.enabled;
  out.filters = listen.length || null;
  out.filtersAktiv = listen.filter(f => f.enabled).length;
  const regeln = listen.filter(f => f.enabled).reduce((a, f) => a + (Number(f.rules_count) || 0), 0);
  out.filterRules = regeln || null;
  /* Wann die älteste aktive Liste zuletzt aktualisiert wurde — eine Liste,
     die seit Monaten steht, filtert von gestern. */
  const zeiten = listen.filter(f => f.enabled && f.last_updated).map(f => Date.parse(f.last_updated)).filter(Number.isFinite);
  out.filterStand = zeiten.length ? new Date(Math.min(...zeiten)).toISOString() : null;
}

/* ---------- Upstreams ---------- */
function upstreams(out, r) {
  if (!r.ok) { out.upstreams = null; return; }
  const d = r.data || {};
  const liste = Array.isArray(d.upstream_dns) ? d.upstream_dns.filter(x => String(x || "").trim() && !String(x).startsWith("#")) : [];
  out.upstreams = liste.length || null;
  out.cache = zahl(d.cache_size);
}

/* ---------- Ampel ----------
   Nur was gemessen wurde, färbt. Der Reihe nach: läuft der Dienst
   überhaupt, filtert er noch, ist er langsam geworden. */
function ampel(out) {
  if (out.dnsRunning === false) {
    out.status = "crit";
    out.note = "Der DNS-Dienst läuft nicht — die Oberfläche antwortet, aufgelöst wird nichts.";
    return;
  }
  if (out.protection === false) {
    out.status = "warn";
    out.note = "Schutz ist abgeschaltet — es wird gerade nichts gefiltert.";
    return;
  }
  if (out.filtering === false) {
    out.status = "warn";
    out.note = "Filterung ist abgeschaltet — die Listen sind geladen, greifen aber nicht.";
    return;
  }
  if (out.avgMs != null && out.avgMs > 100) {
    out.status = "warn";
    out.note = `Mittlere Bearbeitungszeit ${out.avgMs} ms — die Upstreams antworten träge.`;
    return;
  }
  if (out.statsFehler) {
    out.status = "warn";
    out.note = `Zustand lesbar, Statistik nicht: ${out.statsFehler}`;
    return;
  }
  if (out.dnsQueries != null)
    out.note = `${out.dnsQueries} Anfragen${out.statsFenster ? " / " + out.statsFenster : ""}`
      + (out.blockRate != null ? `, ${out.blockRate} % geblockt` : "");
}

const zahl = v => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
