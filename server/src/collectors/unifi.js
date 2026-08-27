/* UniFi Network Controller — die Schicht, über die ein offener Port nichts sagt.

   Ein Access Point antwortet auf Ping, solange er Strom hat. Ob er
   überhaupt noch beim Controller angemeldet ist, ob er seinen Uplink
   verloren hat und nur noch für sich sendet, ob der Funkkanal so belegt
   ist, dass nichts mehr durchgeht — davon sieht ein ICMP nichts. Genau
   dafür steht dieser Sammler.

   ## Zwei Wege hinein

   Der Controller hat zwei Schnittstellen, und welche zur Verfügung steht,
   hängt an Fassung und Gerät:

   1. **Die klassische API.** Dieselbe, die die Weboberfläche selbst
      benutzt: `/api/s/<site>/stat/device` und Verwandte. Sie ist nirgends
      verbindlich beschrieben, läuft aber seit Jahren unverändert und ist
      die **einzige**, die Kanalbelegung je Funkmodul liefert. Angemeldet
      wird mit Benutzer und Passwort; die Sitzung kommt als Keks zurück.
   2. **Die offizielle Integration-API** (Network 9.0 und neuer):
      `/integration/v1/sites/<id>/devices`, angemeldet mit einem
      API-Schlüssel im Kopf `X-API-KEY`. Beschrieben und stabil, aber
      knapper: Zustand, Modell, Fassung — kein Funk.

   Mit einem Schlüssel wird **zuerst die klassische API versucht**: auf
   UniFi OS trägt der Schlüssel auch sie, und dann gibt es die vollen
   Zahlen. Erst wenn sie ihn abweist, geht es auf die Integration-API
   zurück. Was tatsächlich benutzt wurde, steht als `quelle` an den Daten
   und in der Diagnose — sonst ließe sich eine fehlende Kanalbelegung
   nicht von einer stillen Fehlfunktion unterscheiden.

   ## Zwei Präfixe, zwei Anschlüsse, zwei Anmeldepfade

   UniFi OS (Dream Machine, Cloud Key Gen2, UNVR) hört auf 443, hängt die
   Netzanwendung unter `/proxy/network` und meldet unter
   `/api/auth/login` an; eine selbst betriebene Network Application hört
   auf 8443, kennt kein Präfix und meldet unter `/api/login` an. Drei
   Weichen, und keine davon ist von außen zu sehen.

   Deshalb wird geprobt statt geraten: fehlt in der Adresse der Anschluss,
   werden 443 und 8443 versucht, und auf jedem beide Anmeldepfade. Was
   getragen hat, merkt sich die Sitzung und benutzt es von da an.

   Entscheidend ist dabei, **wie eine Absage gelesen wird**. Die
   eigenständige Anwendung schützt alles unter `/api/` mit demselben
   Filter: einen Pfad, den sie nicht kennt — und `/api/auth/login` von
   UniFi OS kennt sie nicht — weist sie mit 401 und
   `api.err.LoginRequired` ab. Das ist derselbe Statuscode wie bei einem
   falschen Passwort. Wer ihn für eine Auskunft über die Zugangsdaten
   hält, versucht `/api/login` nie und meldet jemandem, sein Passwort sei
   falsch, während es stimmt. Was zählt, steht im Rumpf, nicht im Code.

   ## Was hier bewusst nicht gelesen wird

   Die **Clientliste**. `/stat/sta` nennt jedes Gerät im WLAN mit MAC,
   Hostname und Signalstärke. Für die Frage „ist das WLAN gesund?" genügt
   die Anzahl, und die steht ohnehin an jedem AP. Eine Überwachung ist
   kein Anwesenheitsprotokoll: gezählt wird, nicht aufgeschrieben. */

import { requestJson } from "../http.js";

/* UniFi OS zuerst — es ist der häufigere Fall und antwortet auf 443. */
const PRAEFIXE = ["/proxy/network", ""];

/* 443 ist UniFi OS, 8443 die eigenständige Network Application. Steht in
   der Adresse kein Anschluss, gelten beide der Reihe nach. */
const PORTS = [443, 8443];

/* Eine Sitzung gilt beim Controller deutlich länger; wir erneuern nach
   einer halben Stunde. Ein Anmeldevorgang je Durchlauf stünde alle 15 s
   im Protokoll des Controllers und wäre dort nicht von einem Angriff zu
   unterscheiden. */
const SITZUNG_GILT = 30 * 60 * 1000;

export const RECHTEHINWEIS =
  "Im Controller unter Settings → Admins & Users einen Admin mit der Rolle „Viewer“ anlegen (nur lesen) und "
  + "hier Benutzer und Passwort hinterlegen — das ist der Weg, der auf jeder Fassung funktioniert. Wichtig: das "
  + "Konto muss ein lokales sein („Local Access Only“). Ein Ubiquiti-Konto aus der Cloud meldet sich nicht ohne "
  + "zweiten Faktor an, und dann kommt kein Dienst hinein. "
  + "Bietet der Controller unter Settings → Control Plane → Integrations einen API-Schlüssel an (Network 9 und "
  + "neuer, längst nicht auf jeder Installation), ist der die ruhigere Wahl: er kommt ohne Zwei-Faktor-Anmeldung "
  + "aus und erbt die Rolle des Kontos — er ist genau dann nur lesend, wenn das Konto es ist.";

/* Die Adresse, unter der der Controller erreicht wurde — und solange das
   offen ist, die erste, die in Frage kommt. */
export function baseUrl(host) {
  return SITZUNGEN.get(host?.id)?.basis || basen(host)[0];
}

/* Alle Adressen, die in Frage kommen. Steht in der Adresse ein Anschluss,
   gilt genau der: wer 8443 hinschreibt, meint 8443. Fehlt er, werden 443
   und 8443 nacheinander versucht — sonst ist ein „Verbindung abgewiesen"
   auf 443 das Ende, obwohl der Controller nebenan antwortet. */
export function basen(host) {
  if (host?.url) {
    try {
      const u = new URL(host.url);
      if (u.port) return [`${u.protocol}//${u.hostname}:${u.port}`];
      if (u.protocol !== "https:") return [`${u.protocol}//${u.hostname}`];
      return PORTS.map(p => `https://${u.hostname}:${p}`);
    } catch {}
  }
  return PORTS.map(p => `https://${host?.ip}:${p}`);
}

export function authHeader(cred) {
  const k = schluessel(cred);
  return k ? { "X-API-KEY": k } : null;
}

const schluessel = cred => cred?.apiKey || cred?.key || cred?.token || null;
const benutzerVon = cred => cred?.user || cred?.username || null;
const passwortVon = cred => cred?.password || cred?.secret || null;

/* ---------- Sitzung ----------
   Je System eines: welches Präfix trägt, welche API antwortet, und —
   beim Weg über die Anmeldung — der Keks samt Ablauf. */
const SITZUNGEN = new Map();

export function sitzungVergessen(hostId = null) {
  if (hostId) SITZUNGEN.delete(hostId); else SITZUNGEN.clear();
}

function sitzung(host) {
  let s = SITZUNGEN.get(host.id);
  if (!s) { s = { basis: null, praefix: null, keks: null, bis: 0, integration: false, site: null }; SITZUNGEN.set(host.id, s); }
  return s;
}

/* ---------- Anmeldung mit Benutzer und Passwort ----------

   Versucht wird jede Adresse mit beiden Anmeldepfaden — und aufgehört
   wird erst, wenn eine Absage tatsächlich etwas über die Zugangsdaten
   sagt. Eine Ablehnung wird gemerkt, aber nicht sofort gemeldet: der
   andere Pfad kann derselben Anlage noch gehören. Erst wenn keiner
   trägt, ist die Ablehnung die Antwort. */
export async function anmelden(host, cred, timeout = 8000) {
  const benutzer = benutzerVon(cred), passwort = passwortVon(cred);
  if (!benutzer || !passwort) return { ok: false, error: "Kein Benutzer und Passwort hinterlegt" };

  const wege = [
    { pfad: "/api/auth/login", praefix: "/proxy/network" },   /* UniFi OS */
    { pfad: "/api/login", praefix: "" }                        /* eigenständige Anwendung */
  ];

  let abgelehnt = null, letzte = null;
  for (const basis of basen(host)) {
    for (const w of wege) {
      const r = await requestJson(`${basis}${w.pfad}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { username: benutzer, password: passwort, rememberMe: false, remember: false },
        timeout
      });
      letzte = r;

      if (r.ok) {
        const keks = keksAus(r.headers);
        if (!keks) return { ok: false, error: "Anmeldung angenommen, aber keine Sitzung ausgestellt", ms: r.ms };
        const sit = sitzung(host);
        sit.keks = keks; sit.bis = Date.now() + SITZUNG_GILT;
        sit.basis = basis; sit.praefix = w.praefix; sit.integration = false;
        return { ok: true, basis, praefix: w.praefix, benutzer, ms: r.ms };
      }

      const art = einordnen(r);
      /* Ein zweiter Faktor lässt keinen Dienst herein — daran ändert
         weder ein anderer Pfad noch ein anderer Anschluss etwas. */
      if (art === "2fa")
        return { ok: false, status: r.status, ms: r.ms,
          error: "Das Konto verlangt eine Zwei-Faktor-Anmeldung — so kommt kein Dienst hinein." };
      /* Kein Name, keine Antwort, Zeit abgelaufen: das ist eine Auskunft
         über das Netz, nicht über den Pfad. Weitersuchen kostet nur die
         Zeit, die schon verstrichen ist. */
      if (art === "netz") return { ok: false, ms: r.ms, error: r.error };
      /* Hier hört niemand — der nächste Anschluss ist dran. */
      if (art === "port") break;
      if (art === "daten") abgelehnt = r;
      /* „weg": diesen Pfad gibt es hier nicht, der nächste ist dran. */
    }
  }

  if (abgelehnt)
    return { ok: false, status: abgelehnt.status, ms: abgelehnt.ms, error: "Zugangsdaten abgelehnt" };
  return { ok: false, status: letzte?.status, ms: letzte?.ms, error: letzte?.error || "Anmeldung nicht möglich" };
}

/* ---------- Was eine Absage bedeutet ----------

   Der Statuscode allein genügt hier nicht. Dieselbe 401 heißt bei UniFi
   OS „Passwort falsch" und bei der eigenständigen Anwendung „diesen Pfad
   kenne ich nicht, melde dich erst an" — und im zweiten Fall wäre es
   grob falsch, jemandem sein Passwort vorzuwerfen. Unterscheidbar sind
   die beiden nur am Rumpf:

   - `api.err.LoginRequired` / `api.err.NoSiteContext` — der Wachposten
     der klassischen Anwendung vor einem Pfad, den sie nicht kennt.
   - `api.err.Invalid`, `AUTHENTICATION_FAILED` — die Zugangsdaten.
   - eine HTML-Seite: die Weboberfläche, also erst recht kein Endpunkt. */
const KEIN_WEG = /LoginRequired|NoSiteContext|api\.err\.Unknown|not found|<html/i;
const FALSCHE_DATEN = /api\.err\.Invalid|api\.err\.LoginError|AUTHENTICATION_FAILED|invalid.{0,2}credential/i;

export function einordnen(r) {
  const rumpf = String(r?.body || "");
  if (/2fa|Ubic2fa/i.test(rumpf)) return "2fa";
  if (FALSCHE_DATEN.test(rumpf)) return "daten";
  if (KEIN_WEG.test(rumpf) || r?.status === 404) return "weg";
  if (r?.status === 401 || r?.status === 400 || r?.status === 403) return "daten";
  if (!r?.status) return /abgewiesen/.test(r?.error || "") ? "port" : "netz";
  return "weg";
}

/* Aus `set-cookie` wird das, was wieder hinausgeht. UniFi OS stellt
   `TOKEN` aus, die klassische Anwendung `unifises` und `csrf_token` —
   welches davon kommt, ist egal: zurück geht, was ausgestellt wurde. */
export function keksAus(headers) {
  const roh = headers?.["set-cookie"];
  const liste = Array.isArray(roh) ? roh : roh ? [roh] : [];
  const paare = liste
    .map(z => String(z).split(";")[0].trim())
    .filter(z => /^[^=]+=.+/.test(z));
  return paare.length ? paare.join("; ") : null;
}

/* ---------- Ein Abruf ----------

   `pfad` ist der Pfad ohne Präfix, also `/api/s/default/stat/device` oder
   `/integration/v1/sites`. Ist das Präfix noch unbekannt, werden beide
   der Reihe nach versucht; das erste, das antwortet, gilt von da an. */
export async function ruf(host, cred, pfad, timeout = 8000) {
  const s = sitzung(host);
  const kopf = await kopfzeilen(host, cred, timeout);
  if (!kopf.ok) return kopf;

  /* Steht beides fest, ist es genau ein Versuch. Steht es noch nicht
     fest, sind es die Kombinationen aus Anschluss und Präfix — einmal,
     danach nie wieder. */
  const ziele = [];
  for (const b of (s.basis != null ? [s.basis] : basen(host)))
    for (const p of (s.praefix != null ? [s.praefix] : PRAEFIXE)) ziele.push([b, p]);

  let letzte = null;

  for (const [b, p] of ziele) {
    let r = await requestJson(`${b}${p}${pfad}`, { headers: kopf.headers, timeout });

    /* Eine abgelaufene Sitzung ist kein Fehler, sondern der Anlass, sich
       neu anzumelden — einmal, nicht in einer Schleife. Die neue
       Anmeldung weiß danach selbst, welcher Anschluss und welches Präfix
       tragen; die Wiederholung folgt ihr. */
    if (r.status === 401 && kopf.art === "login") {
      s.keks = null;
      const neu = await anmelden(host, cred, timeout);
      if (neu.ok) {
        r = await requestJson(`${s.basis}${s.praefix}${pfad}`, { headers: { Cookie: s.keks }, timeout });
        if (r.ok) return { ...r, pfad: `${s.praefix}${pfad}` };
      }
    }

    if (r.ok) { s.basis = b; s.praefix = p; return { ...r, pfad: `${p}${pfad}` }; }
    letzte = { ...r, pfad: `${p}${pfad}` };
    /* Weiter geht es nur, solange die Antwort „hier nicht" heißt: ein
       fehlender Endpunkt, eine Weboberfläche statt JSON, ein Anschluss,
       an dem niemand horcht. Eine abgelehnte Anmeldung stünde nebenan
       genauso — die ist das Ende. */
    if (!naechstesZiel(r)) break;
  }
  return letzte || { ok: false, error: "kein Weg zum Controller" };
}

const naechstesZiel = r =>
  r.status === 404 || r.status === 502
  || /kein JSON/.test(r.error || "")
  || (!r.status && /abgewiesen/.test(r.error || ""));

async function kopfzeilen(host, cred, timeout) {
  const k = schluessel(cred);
  if (k) return { ok: true, art: "key", headers: { "X-API-KEY": k } };

  const s = sitzung(host);
  if (s.keks && s.bis > Date.now()) return { ok: true, art: "login", headers: { Cookie: s.keks } };

  const an = await anmelden(host, cred, timeout);
  if (!an.ok) return { ok: false, status: an.status, error: an.error };
  return { ok: true, art: "login", headers: { Cookie: sitzung(host).keks } };
}

/* ---------- Welche Site? ----------

   Ein Controller kann mehrere Sites führen. Gelesen wird die, die in den
   Zugangsdaten steht (`site`), sonst die erste, die der Zugang sehen
   darf — bei den allermeisten Anlagen ist das `default`. Die Liste sagt
   nebenbei, ob der Zugang überhaupt etwas sehen darf. */
export async function siteWaehlen(host, cred, timeout = 8000) {
  const s = sitzung(host);
  const gewuenscht = cred?.site || null;

  const klassisch = await ruf(host, cred, "/api/self/sites", timeout);
  if (klassisch.ok) {
    const liste = Array.isArray(klassisch.data?.data) ? klassisch.data.data : [];
    if (!liste.length) return { ok: false, error: "Der Zugang sieht keine einzige Site", ms: klassisch.ms };
    const treffer = gewuenscht
      ? liste.find(x => x.name === gewuenscht || x.desc === gewuenscht)
      : null;
    const gewaehlt = treffer || liste[0];
    s.site = gewaehlt.name;
    s.integration = false;
    return { ok: true, api: "klassisch", site: gewaehlt.name, name: gewaehlt.desc || gewaehlt.name, sites: liste.length, ms: klassisch.ms };
  }

  /* Die klassische API antwortet nicht — mit einem Schlüssel bleibt die
     Integration-API. Ohne Schlüssel gibt es keinen zweiten Weg. */
  if (!schluessel(cred)) return { ok: false, status: klassisch.status, error: klassisch.error, ms: klassisch.ms };

  const neu = await ruf(host, cred, "/integration/v1/sites", timeout);
  if (!neu.ok) return { ok: false, status: neu.status, error: neu.error, ms: neu.ms };
  const liste = Array.isArray(neu.data?.data) ? neu.data.data : [];
  if (!liste.length) return { ok: false, error: "Der Schlüssel sieht keine einzige Site", ms: neu.ms };
  const treffer = gewuenscht ? liste.find(x => x.id === gewuenscht || x.name === gewuenscht) : null;
  const gewaehlt = treffer || liste[0];
  s.site = gewaehlt.id;
  s.integration = true;
  return { ok: true, api: "integration", site: gewaehlt.id, name: gewaehlt.name || gewaehlt.id, sites: liste.length, ms: neu.ms };
}

/* ---------- Was die Diagnose Schritt für Schritt abfragt ---------- */
export const ABFRAGEN = [
  { pfad: "/api/self/sites", zweck: "welche Sites der Zugang sehen darf" },
  { pfad: "/api/s/{site}/stat/device", zweck: "alle verwalteten Geräte: Zustand, Funk, Uplink, Fassung" },
  { pfad: "/api/s/{site}/stat/health", zweck: "Teilsysteme und Clientzahlen des Controllers", optional: true },
  { pfad: "/api/s/{site}/stat/sysinfo", zweck: "Fassung des Controllers", optional: true }
];

export const ABFRAGEN_INTEGRATION = [
  { pfad: "/integration/v1/sites", zweck: "welche Sites der Schlüssel sehen darf" },
  { pfad: "/integration/v1/sites/{site}/devices", zweck: "verwaltete Geräte — ohne Funkzahlen, die kennt diese API nicht" }
];

export function befund(pfad, data) {
  const d = data?.data ?? data;
  if (pfad.endsWith("/self/sites") || pfad.endsWith("/integration/v1/sites")) {
    const l = Array.isArray(d) ? d : [];
    return l.length ? `${l.length} Site(s): ${l.map(x => x.desc || x.name || x.id).join(", ")}` : "keine Site sichtbar";
  }
  if (pfad.includes("stat/device") || pfad.endsWith("/devices")) {
    const l = Array.isArray(d) ? d : [];
    if (!l.length) return "keine Geräte in dieser Site";
    const g = l.map(geraet);
    const on = g.filter(x => x.zustand === "online").length;
    const aps = g.filter(x => x.art === "ap").length;
    return `${l.length} Geräte, ${on} online, davon ${aps} Access Point(s)`;
  }
  if (pfad.includes("stat/health")) {
    const l = Array.isArray(d) ? d : [];
    return l.length ? l.map(x => `${x.subsystem}: ${x.status}`).join(" · ") : "keine Teilsysteme gemeldet";
  }
  if (pfad.includes("sysinfo")) {
    const i = Array.isArray(d) ? d[0] : d;
    return i?.version ? `Controller ${i.version}` : "Antwort ohne Versionsangabe";
  }
  return Array.isArray(d) ? `${d.length} Einträge` : "Antwort erhalten";
}

export function hintFor(r) {
  if (/Zwei-Faktor/.test(r?.error || ""))
    return "Für die Überwachung ein eigenes lokales Konto ohne zweiten Faktor anlegen. " + RECHTEHINWEIS;
  if (r?.status === 401 || r?.status === 400)
    return "Die Zugangsdaten werden abgelehnt — beide Anmeldepfade wurden versucht, der von UniFi OS und der "
      + "der eigenständigen Network Application. Es liegt also am Konto, nicht am Weg. " + RECHTEHINWEIS;
  if (r?.status === 403)
    return "Angemeldet, aber ohne Recht auf diese Site — dem Konto unter Settings → Admins & Users Zugriff auf "
      + "die Site geben (Rolle „Viewer“ genügt).";
  if (r?.status === 404)
    return "Erreicht, aber kein UniFi-Endpunkt. Läuft dort wirklich der Controller — und nicht ein anderer "
      + "Dienst auf demselben Anschluss?";
  if (/abgewiesen/.test(r?.error || ""))
    return "Auf 443 und 8443 horcht niemand. UniFi OS (Dream Machine, Cloud Key Gen2) hört auf 443, die selbst "
      + "betriebene Network Application auf 8443 — beide wurden versucht. Steht in der Adresse ein anderer "
      + "Anschluss, gilt nur der.";
  return null;
}

/* ---------- Verbindungstest ---------- */
export async function testConnection(host, cred) {
  sitzungVergessen(host.id);
  const s = await siteWaehlen(host, cred, 6000);
  if (!s.ok) return { ok: false, detail: s.error, hint: hintFor(s) };

  const g = await geraeteHolen(host, cred, s, 6000);
  if (!g.ok) return { ok: false, detail: g.error, hint: hintFor(g) };

  const aps = g.liste.filter(x => x.art === "ap");
  const online = g.liste.filter(x => x.zustand === "online").length;
  return {
    ok: true,
    detail: `Verbunden — Site „${s.name}“ · ${g.liste.length} Geräte, ${online} online, ${aps.length} Access Point(s)`
      + (s.api === "integration" ? " · über die Integration-API (ohne Funkzahlen)" : ""),
    version: g.version || null,
    ms: s.ms
  };
}

/* ---------- Geräte holen ---------- */
async function geraeteHolen(host, cred, s, timeout = 8000) {
  if (s.api === "integration") {
    const r = await ruf(host, cred, `/integration/v1/sites/${encodeURIComponent(s.site)}/devices`, timeout);
    if (!r.ok) return { ok: false, status: r.status, error: r.error };
    const liste = (Array.isArray(r.data?.data) ? r.data.data : []).map(geraetIntegration);
    return { ok: true, liste, quelle: "integration", version: null, ms: r.ms };
  }
  const r = await ruf(host, cred, `/api/s/${encodeURIComponent(s.site)}/stat/device`, timeout);
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  const liste = (Array.isArray(r.data?.data) ? r.data.data : []).map(geraet);
  return { ok: true, liste, quelle: "klassisch", ms: r.ms };
}

/* ---------- Zustände ----------

   Die klassische API zählt Zustände als Zahlen, die Integration-API
   benennt sie. Beide landen auf denselben wenigen Begriffen — sonst
   hinge die Ampel daran, über welchen Weg gelesen wurde. */
const ZUSTAND_ZAHL = {
  0: ["offline", "getrennt — meldet sich nicht mehr beim Controller"],
  1: ["online", "verbunden"],
  2: ["wartet", "wartet auf Adoption"],
  3: ["offline", "getrennt"],
  4: ["aktualisiert", "lädt gerade eine neue Fassung"],
  5: ["wartet", "richtet sich ein"],
  6: ["offline", "antwortet nicht mehr — Herzschlag ausgeblieben"],
  7: ["wartet", "wird gerade adoptiert"],
  9: ["fehler", "Adoption fehlgeschlagen"],
  11: ["isoliert", "isoliert — hat den Uplink verloren und funkt für sich allein"]
};

const ZUSTAND_NAME = {
  ONLINE: ["online", "verbunden"],
  OFFLINE: ["offline", "getrennt — meldet sich nicht mehr beim Controller"],
  PENDING_ADOPTION: ["wartet", "wartet auf Adoption"],
  ADOPTING: ["wartet", "wird gerade adoptiert"],
  GETTING_READY: ["wartet", "richtet sich ein"],
  UPDATING: ["aktualisiert", "lädt gerade eine neue Fassung"],
  DELETING: ["wartet", "wird entfernt"],
  CONNECTION_INTERRUPTED: ["offline", "Verbindung unterbrochen"],
  ISOLATED: ["isoliert", "isoliert — hat den Uplink verloren und funkt für sich allein"]
};

/* Aus dem Typkürzel des Controllers wird eine Art, die auch jemand
   versteht, der keine UniFi-Kürzel im Kopf hat. */
function artAus(typ, modell = "") {
  const t = String(typ || "").toLowerCase();
  if (t === "uap") return "ap";
  if (t === "usw") return "switch";
  if (t === "ugw" || t === "udm" || t === "uxg") return "gateway";
  if (/^u[a-z]*ap/i.test(modell)) return "ap";
  return "sonstiges";
}

/* ---------- Ein Gerät, klassische API ---------- */
export function geraet(d) {
  const [zustand, zustandText] = ZUSTAND_ZAHL[Number(d?.state)] || ["unbekannt", `Zustand ${d?.state ?? "?"}`];
  const funk = funkmodule(d);
  const sys = d?.["system-stats"] || d?.sys_stats || {};
  return {
    id: d?._id || d?.mac || null,
    name: d?.name || d?.hostname || d?.mac || "ohne Namen",
    art: artAus(d?.type, d?.model),
    modell: d?.model || null,
    mac: d?.mac || null,
    ip: d?.ip || null,
    zustand, zustandText,
    adoptiert: d?.adopted === undefined ? null : !!d.adopted,
    fassung: d?.version || null,
    update: d?.upgradable === undefined ? null : !!d.upgradable,
    laufzeit: zahl(d?.uptime),
    gesehen: d?.last_seen ? new Date(d.last_seen * 1000).toISOString() : null,
    clients: zahl(d?.["user-num_sta"]) ?? zahl(d?.num_sta),
    clientsGast: zahl(d?.["guest-num_sta"]),
    cpu: zahl(sys.cpu), ram: zahl(sys.mem),
    tempC: zahl(d?.general_temperature),
    /* UniFis eigene Bewertung des Erlebnisses (0–100). Sie ist eine
       Auskunft des Herstellers, keine Messung des Leitstands — sie steht
       deshalb da, bekommt aber keine Ampel. */
    zufriedenheit: zahl(d?.satisfaction),
    uplink: d?.uplink?.uplink_device_name || d?.uplink?.uplink_mac || null,
    uplinkFunk: d?.uplink?.type ? d.uplink.type !== "wire" : null,
    funk,
    /* Die höchste Kanalbelegung über alle Funkmodule — die Zahl, an der
       ein „das WLAN ist so langsam" hängt. */
    kanalLast: funk.length ? hoechste(funk.map(f => f.last)) : null
  };
}

/* ---------- Ein Gerät, Integration-API ----------
   Weniger Felder, und was fehlt, bleibt null. Eine 0 stünde hier für
   „gemessen und nichts gefunden" — das wäre gelogen. */
export function geraetIntegration(d) {
  const [zustand, zustandText] = ZUSTAND_NAME[String(d?.state || "").toUpperCase()] || ["unbekannt", `Zustand ${d?.state ?? "?"}`];
  return {
    id: d?.id || d?.macAddress || null,
    name: d?.name || d?.macAddress || "ohne Namen",
    art: artAus(d?.type, d?.model),
    modell: d?.model || null,
    mac: d?.macAddress || null,
    ip: d?.ipAddress || null,
    zustand, zustandText,
    adoptiert: null,
    fassung: d?.firmwareVersion || null,
    update: d?.firmwareUpdatable === undefined ? null : !!d.firmwareUpdatable,
    laufzeit: null, gesehen: null,
    clients: null, clientsGast: null,
    cpu: null, ram: null, tempC: null, zufriedenheit: null,
    uplink: null, uplinkFunk: null,
    funk: [], kanalLast: null
  };
}

/* ---------- Funkmodule ----------
   `cu_total` ist die Belegung des Kanals in Prozent — eigener Verkehr und
   fremder zusammen. Genau das ist die Zahl, die erklärt, warum ein WLAN
   „langsam" ist, obwohl alles grün aussieht. */
const BAND = { ng: "2,4 GHz", na: "5 GHz", "6e": "6 GHz", ax: "6 GHz" };

export function funkmodule(d) {
  const stats = Array.isArray(d?.radio_table_stats) ? d.radio_table_stats : [];
  const tabelle = Array.isArray(d?.radio_table) ? d.radio_table : [];
  return stats.map(r => {
    const cfg = tabelle.find(x => x.name === r.name) || {};
    return {
      name: r.name || cfg.name || "?",
      band: BAND[String(r.radio || cfg.radio || "").toLowerCase()] || (r.radio || null),
      kanal: zahl(r.channel) ?? zahl(cfg.channel),
      /* Sendeleistung und Kanalbreite sagen, ob jemand von Hand
         eingegriffen hat — der häufigste Grund für ein AP, das anders
         funkt als seine Nachbarn. */
      breite: zahl(cfg.ht),
      leistung: zahl(r.tx_power) ?? zahl(cfg.tx_power),
      clients: zahl(r["user-num_sta"]) ?? zahl(r.num_sta),
      last: zahl(r.cu_total),
      lastSelbst: summe(zahl(r.cu_self_rx), zahl(r.cu_self_tx)),
      zufriedenheit: zahl(r.satisfaction)
    };
  });
}

/* ---------- Sammler ---------- */
export async function collectUnifi(host, cred, settings = {}) {
  const s = await siteWaehlen(host, cred);
  if (!s.ok) return {
    error: s.error, note: s.error,
    status: (s.status === 401 || s.status === 403 || s.status === 400) ? "warn" : undefined
  };

  const g = await geraeteHolen(host, cred, s);
  if (!g.ok) return {
    error: g.error, note: g.error,
    status: (g.status === 401 || g.status === 403) ? "warn" : undefined
  };

  const out = {
    site: s.name, siteId: s.site, sites: s.sites ?? null,
    quelle: g.quelle,
    version: null,
    geraete: g.liste,
    geraeteGesamt: g.liste.length
  };

  /* Zwei Zusatzabrufe, beide nicht wesentlich: die Fassung des
     Controllers und seine eigene Sicht auf die Teilsysteme. Fehlen sie,
     fehlt je eine Angabe — nicht die Anbindung. */
  if (s.api !== "integration") {
    const [info, health] = await Promise.all([
      ruf(host, cred, `/api/s/${encodeURIComponent(s.site)}/stat/sysinfo`),
      ruf(host, cred, `/api/s/${encodeURIComponent(s.site)}/stat/health`)
    ]);
    if (info.ok) {
      const i = Array.isArray(info.data?.data) ? info.data.data[0] : info.data?.data;
      out.version = i?.version || null;
      out.controllerUpdate = i?.update_available === undefined ? null : !!i.update_available;
    }
    if (health.ok) gesundheit(out, health.data?.data);
  }

  zaehlen(out);
  ampel(out, settings);
  return out;
}

/* Die Teilsysteme, wie der Controller selbst sie sieht. Übernommen wird
   nur, was der Leitstand nicht ohnehin selbst zählt: die Clientzahlen und
   der Zustand des WLAN-Teilsystems. Für „Internet" und „LAN" gibt es hier
   bessere Quellen — die Firewall. */
function gesundheit(out, liste) {
  if (!Array.isArray(liste)) return;
  const wlan = liste.find(x => x.subsystem === "wlan");
  if (!wlan) return;
  out.wlanStatus = wlan.status || null;
  out.clients = zahl(wlan.num_user);
  out.clientsGast = zahl(wlan.num_guest);
  out.apGemeldet = zahl(wlan.num_ap);
  out.durchsatzRx = zahl(wlan["rx_bytes-r"]);
  out.durchsatzTx = zahl(wlan["tx_bytes-r"]);
}

/* ---------- Zählen ---------- */
function zaehlen(out) {
  const g = out.geraete || [];
  const aps = g.filter(x => x.art === "ap");
  out.aps = aps.length;
  out.apsOnline = aps.filter(x => x.zustand === "online").length;
  out.apsOffline = aps.filter(x => x.zustand === "offline").length;
  out.apsIsoliert = aps.filter(x => x.zustand === "isoliert").length;
  out.apsWartend = aps.filter(x => x.zustand === "wartet").length;
  out.switche = g.filter(x => x.art === "switch").length;
  out.gateways = g.filter(x => x.art === "gateway").length;
  out.updates = g.some(x => x.update != null) ? g.filter(x => x.update).length : null;

  /* Clients: aus der Gesundheit, sonst aus den Geräten summiert. Kennt
     kein Gerät eine Zahl (Integration-API), bleibt es bei null. */
  if (out.clients == null) {
    const mit = aps.filter(x => x.clients != null);
    out.clients = mit.length ? mit.reduce((a, x) => a + x.clients, 0) : null;
  }
  const lasten = aps.map(x => x.kanalLast).filter(x => x != null);
  out.kanalLast = lasten.length ? Math.max(...lasten) : null;
  /* Je Band die höchste Belegung — 2,4 GHz ist fast überall voll, und
     das darf die Zahl für 5 GHz nicht verdecken. */
  out.kanalLastBand = baender(aps);
}

function baender(aps) {
  const nach = new Map();
  for (const ap of aps)
    for (const f of ap.funk || []) {
      if (!f.band || f.last == null) continue;
      const alt = nach.get(f.band);
      if (!alt || f.last > alt.last) nach.set(f.band, { band: f.band, last: f.last, ap: ap.name, kanal: f.kanal });
    }
  return nach.size ? [...nach.values()].sort((a, b) => b.last - a.last) : null;
}

/* ---------- Ampel ----------

   Rot ist dem Fall vorbehalten, dass gar kein Access Point mehr steht:
   dann gibt es kein WLAN mehr, und das ist eine Störung. Ein einzelner
   ausgefallener AP ist gelb **mit Namen** — ein Raum ohne WLAN ist
   ärgerlich, aber es ist kein Anlass, um drei Uhr nachts aufzustehen,
   und eine Ampel, die dafür rot wird, wird irgendwann weggeklickt.

   Eine anstehende Firmware bekommt bewusst gar keine Farbe. Sie steht
   immer irgendwo an; eine Ampel dafür leuchtet nach zwei Wochen ständig
   und ist damit abtrainiert. Sie steht als Notiz da. */
function ampel(out, settings = {}) {
  const grenze = zahl(settings.wlan_kanal_warn) ?? 80;
  const g = out.geraete || [];

  if (out.aps > 0 && out.apsOnline === 0) {
    out.status = "crit";
    out.note = out.aps === 1
      ? `Der einzige Access Point ist ${nurText(g.find(x => x.art === "ap"))} — es gibt gerade kein WLAN.`
      : `Keiner der ${out.aps} Access Points ist verbunden — es gibt gerade kein WLAN.`;
    return;
  }

  const gruende = [];
  const nenne = art => g.filter(x => x.art === "ap" && x.zustand === art).map(x => x.name).join(", ");
  if (out.apsOffline) gruende.push(`${out.apsOffline} von ${out.aps} Access Points getrennt: ${nenne("offline")}`);
  if (out.apsIsoliert) gruende.push(`isoliert (Uplink verloren): ${nenne("isoliert")}`);

  const switcheAus = g.filter(x => x.art === "switch" && x.zustand === "offline");
  if (switcheAus.length) gruende.push(`${switcheAus.length} Switch(es) getrennt: ${switcheAus.map(x => x.name).join(", ")}`);

  const voll = (out.kanalLastBand || []).filter(b => b.last >= grenze);
  if (voll.length)
    gruende.push(voll.map(b => `${b.band} zu ${b.last} % belegt (${b.ap}, Kanal ${b.kanal ?? "?"})`).join(", "));

  if (gruende.length) { out.status = "warn"; out.note = gruende.join(" · "); return; }

  const notizen = [];
  if (out.apsWartend) notizen.push(`${out.apsWartend} wartet auf Adoption`);
  if (out.updates) notizen.push(`${out.updates} Gerät(e) mit neuer Fassung`);
  if (out.quelle === "integration")
    notizen.push("über die Integration-API gelesen — Kanalbelegung und Clientzahlen kennt sie nicht");

  out.note = `${out.apsOnline} von ${out.aps} Access Points verbunden`
    + (out.clients != null ? ` · ${out.clients} Clients` : "")
    + (out.kanalLast != null ? ` · Kanal bis ${out.kanalLast} % belegt` : "")
    + (notizen.length ? ` · ${notizen.join(" · ")}` : "");
}

const nurText = ap => (ap ? ap.zustandText : "nicht verbunden");

const zahl = v => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
};
const summe = (a, b) => (a == null && b == null ? null : (a || 0) + (b || 0));
const hoechste = liste => {
  const l = liste.filter(x => x != null);
  return l.length ? Math.max(...l) : null;
};
