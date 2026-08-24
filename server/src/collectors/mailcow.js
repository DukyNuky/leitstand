/* Mailcow dockerized.

   Anmeldung: ein API-Schlüssel in der Kopfzeile `X-API-Key`, angelegt
   unter *Configuration → Access → API*. **Read-Only genügt** — mailcow
   sperrt damit `add`, `edit` und `delete`, und mehr braucht hier
   niemand. Der Schlüssel trägt intern die Rolle „admin"; ohne sie wären
   die Statusabfragen gar nicht lesbar.

   Der eine Fallstrick, der nicht wie einer aussieht: **mailcow prüft die
   Quell-IP**. Steht sie nicht in „allow from" des Schlüssels, kommt eine
   401 zurück — dieselbe Antwort wie bei einem falschen Schlüssel, nur
   mit einer anderen Meldung im Rumpf:

       {"type":"error","msg":"api access denied for ip 10.0.0.7"}

   Diese Zeile ist Gold wert, denn sie nennt die Adresse, die mailcow
   *tatsächlich* sieht — hinter einem Reverse Proxy ist das dessen
   Adresse und nicht die des Leitstands. Deshalb wird sie in den Hinweis
   übernommen, statt hinter „401" zu verschwinden.

   Zwei Takte wie beim Mail Gateway: Warteschlange, Container und Platz
   im Minutentakt, alles Zählende alle paar Minuten. Ein Grund mehr als
   dort: mehrere dieser Abfragen lassen mailcow einen Befehl *in* einem
   Container ausführen (`mailq` in postfix, `df` in dovecot). Das ist
   nichts, was man alle 15 Sekunden auslöst. */

import { requestJson } from "../http.js";
import { schwellenFuer } from "../inventory.js";

export const RECHTEHINWEIS =
  "In mailcow unter Configuration → Access → API einen Schlüssel erzeugen — „Read-Only Access“ genügt. "
  + "Wichtig ist das Feld „allow from“: dort gehört die Adresse hinein, mit der der Leitstand ankommt. "
  + "Hinter einem Reverse Proxy ist das dessen Adresse, nicht die des Leitstands.";

export function authHeader(cred) {
  const key = cred?.apiKey || cred?.key || cred?.token;
  return key ? { "X-API-Key": String(key) } : null;
}

/* Wie bei AdGuard bleibt ein Unterpfad in der Adresse stehen: mailcow
   liegt oft hinter einem Proxy, und ohne diesen Teil ginge jeder Aufruf
   in die Startseite. */
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

export async function api(host, cred, pfad, timeout = 8000) {
  const headers = authHeader(cred);
  if (!headers) return { ok: false, error: "Kein API-Schlüssel hinterlegt" };
  return requestJson(`${baseUrl(host)}/api/v1${pfad}`, { headers, timeout });
}

/* Die Zeile, die mailcow bei abgelehnter Quell-IP mitschickt. Sie steht
   im Rumpf einer 401 und ist die einzige Stelle, an der die Adresse
   auftaucht, die mailcow gesehen hat. */
export function ipAusAntwort(body) {
  const m = /api access denied for ip ([0-9a-fA-F.:]+)/.exec(String(body || ""));
  return m ? m[1] : null;
}

export function hintFor(r) {
  if (r.status === 401) {
    const ip = ipAusAntwort(r.body);
    return ip
      ? `mailcow hat die Anfrage von ${ip} abgewiesen — nicht der Schlüssel ist falsch, diese Adresse steht `
        + `nicht in „allow from“. Genau diese Adresse dort eintragen: hinter einem Reverse Proxy ist es dessen `
        + `Adresse und nicht die des Leitstands.`
      : RECHTEHINWEIS;
  }
  if (r.status === 403)
    return "mailcow lehnt die Anfrage als „nicht für die API bestimmt“ ab (Sec-Fetch-Dest). Das passiert, wenn ein "
      + "Proxy dazwischen Browser-Kopfzeilen ergänzt.";
  if (r.status === 404)
    return "Erreicht, aber kein mailcow-Endpunkt. Liegt die Oberfläche hinter einem Reverse Proxy unter einem "
      + "Unterpfad, gehört dieser mit in die Adresse.";
  if (/abgewiesen/.test(r.error || "")) return "Port prüfen: die mailcow-Oberfläche liegt üblicherweise auf 443.";
  return null;
}

/* ---------- Was die Diagnose Schritt für Schritt abfragt ---------- */
export const PFADE = [
  { pfad: "/get/status/version", zweck: "Schlüssel angenommen und Fassung lesbar" },
  { pfad: "/get/status/containers", zweck: "laufen Postfix, Dovecot, Datenbank und Filter" },
  { pfad: "/get/mailq/all", zweck: "Warteschlange — was hängt und warum" },
  { pfad: "/get/status/vmail", zweck: "Platz für die Postfächer" },
  { pfad: "/get/status/host", zweck: "Auslastung und Laufzeit des Wirts", optional: true },
  { pfad: "/get/logs/rspamd-stats", zweck: "Geprüftes, Spam und Ham seit dem Start von rspamd", optional: true },
  { pfad: "/get/domain/all", zweck: "Domänen mit Postfächern und Belegung", optional: true },
  { pfad: "/get/mailbox/reduced", zweck: "Postfächer mit Quote — welches läuft voll", optional: true },
  { pfad: "/get/fail2ban", zweck: "gesperrte Adressen", optional: true }
];

export function befund(pfad, data) {
  const d = data;
  if (pfad === "/get/status/version") return `mailcow ${d?.version || "?"}`;
  if (pfad === "/get/status/containers") {
    const liste = Object.values(d || {});
    const steht = liste.filter(c => c.state !== "running");
    return `${liste.length} Container — ${steht.length ? "nicht laufend: " + steht.map(c => c.container).join(", ") : "alle laufen"}`;
  }
  if (pfad === "/get/mailq/all") {
    const liste = Array.isArray(d) ? d : [];
    return liste.length ? `${liste.length} Mail in der Warteschlange` : "Warteschlange leer";
  }
  if (pfad === "/get/status/vmail") return `Postfachablage ${d?.used || "?"} von ${d?.total || "?"} belegt (${d?.used_percent || "?"})`;
  if (pfad === "/get/status/host")
    return `CPU ${d?.cpu?.usage ?? "?"} %, RAM ${d?.memory?.usage ?? "?"} %, ${d?.cpu?.cores ?? "?"} Kerne`;
  if (pfad === "/get/logs/rspamd-stats")
    return `${d?.scanned ?? "?"} geprüft, ${d?.spam_count ?? "?"} Spam, ${d?.ham_count ?? "?"} Ham (rspamd ${d?.version || "?"})`;
  if (pfad === "/get/domain/all") return `${(Array.isArray(d) ? d : []).length} Domäne(n)`;
  if (pfad === "/get/mailbox/reduced") return `${(Array.isArray(d) ? d : []).length} Postfach/Postfächer`;
  if (pfad === "/get/fail2ban") {
    const bans = Array.isArray(d?.active_bans) ? d.active_bans.length : 0;
    return `${bans} Adresse(n) gesperrt`;
  }
  return "Antwort erhalten";
}

/* ---------- Verbindungstest ---------- */
export async function testConnection(host, cred) {
  const ver = await api(host, cred, "/get/status/version", 6000);
  if (!ver.ok) return { ok: false, detail: ver.error, hint: hintFor(ver) };
  const fassung = ver.data?.version || null;

  /* Angenommen heißt noch nicht lesend: die Statusabfragen hängen an der
     Rolle, nicht am Schlüssel allein. Geprüft wird das, woran der
     Sammler wirklich hängt. */
  const cont = await api(host, cred, "/get/status/containers", 6000);
  if (!cont.ok) {
    return {
      ok: false, version: fassung, ms: ver.ms,
      detail: `mailcow ${fassung || "?"} antwortet — aber die Containerliste ist nicht lesbar: ${cont.error}`,
      hint: hintFor(cont)
    };
  }
  const liste = Object.values(cont.data || {});
  const steht = liste.filter(c => c.state !== "running");
  return {
    ok: true, version: fassung, ms: ver.ms,
    detail: `Verbunden — mailcow ${fassung || "?"} · ${liste.length} Container, ${liste.length - steht.length} laufen`,
    hint: steht.length ? `Nicht laufend: ${steht.map(c => c.container).join(", ")}` : null
  };
}

/* ---------- Sammler ---------- */
const SPEICHER = new Map();

export function speicherVergessen(hostId = null) {
  if (hostId) SPEICHER.delete(hostId); else SPEICHER.clear();
}

export async function collectMailcow(host, cred, settings = {}) {
  const jetzt = Date.now();
  const takt = (zahl(settings.mailcow_takt) ?? 60) * 1000;
  const taktLang = (zahl(settings.mailcow_takt_lang) ?? 300) * 1000;
  const s = SPEICHER.get(host.id) || {};

  s.fehler = null;
  if (!s.betrieb || jetzt - s.betrieb.stand >= takt) {
    const d = await betriebsdaten(host, cred);
    if (d?.hart) return { error: d.error, status: "warn", note: d.error };
    if (d) s.betrieb = { stand: jetzt, d };
    else s.fehler = "Container, Warteschlange und Platz sind nicht abrufbar";
  }
  if (!s.lang || jetzt - s.lang.stand >= taktLang) {
    const d = await langsameDaten(host, cred);
    if (d) s.lang = { stand: jetzt, d };
    else s.fehler = s.fehler || "Fassung, Domänen und Postfächer sind nicht abrufbar";
  }
  SPEICHER.set(host.id, s);

  if (!s.betrieb && !s.lang) return { error: s.fehler || "Kein Abruf kam durch", note: s.fehler || "Kein Abruf kam durch" };

  const out = {
    ...(s.lang?.d || {}),
    ...(s.betrieb?.d || {}),
    stand: s.betrieb ? new Date(s.betrieb.stand).toISOString() : null,
    statStand: s.lang ? new Date(s.lang.stand).toISOString() : null
  };
  if (s.fehler) out.error = s.fehler;
  return bewerte(out, host, settings);
}

async function betriebsdaten(host, cred) {
  const [contRes, queueRes, vmailRes, hostRes] = await Promise.all([
    api(host, cred, "/get/status/containers"),
    api(host, cred, "/get/mailq/all"),
    api(host, cred, "/get/status/vmail"),
    api(host, cred, "/get/status/host")
  ]);
  /* Eine abgelehnte Anmeldung ist kein „später nochmal": sie gehört
     sofort und mit Grund gemeldet, sonst sucht man sie im Verlauf. */
  if (contRes.status === 401 || contRes.status === 403)
    return { hart: true, error: `${contRes.error}${ipAusAntwort(contRes.body) ? ` — mailcow sah die Adresse ${ipAusAntwort(contRes.body)}` : ""}` };
  if (!contRes.ok && !queueRes.ok && !vmailRes.ok) return null;

  const out = {};
  container(out, contRes);
  warteschlange(out, queueRes);
  ablage(out, vmailRes);
  wirt(out, hostRes);
  return out;
}

async function langsameDaten(host, cred) {
  const [verRes, rspamdRes, domRes, mbRes, quarRes, f2bRes] = await Promise.all([
    api(host, cred, "/get/status/version"),
    api(host, cred, "/get/logs/rspamd-stats"),
    api(host, cred, "/get/domain/all"),
    api(host, cred, "/get/mailbox/reduced", 20000),
    api(host, cred, "/get/quarantine/all", 20000),
    api(host, cred, "/get/fail2ban")
  ]);
  if (!verRes.ok && !domRes.ok) return null;

  const out = { version: verRes.ok ? verRes.data?.version || null : null };
  filter(out, rspamdRes);
  domaenen(out, domRes);
  postfaecher(out, mbRes);
  quarantaene(out, quarRes);
  sperren(out, f2bRes);
  return out;
}

/* ---------- Container ----------
   Dieselbe Frage wie beim Mail Gateway, nur eine Ebene tiefer: läuft
   noch, was Mail annimmt, prüft und ablegt? Ein gestopptes Postfix
   sieht von außen aus wie ein ruhiger Abend.

   `unbound` steht mit unter den Kerndiensten, obwohl es nach
   Namensauflösung klingt und nicht nach Mail: fällt es aus, findet
   Postfix keine Gegenstelle mehr, und ausgehende Mail bleibt liegen. */
const KERN = new Set([
  "postfix-mailcow", "dovecot-mailcow", "mysql-mailcow", "nginx-mailcow",
  "php-fpm-mailcow", "rspamd-mailcow", "redis-mailcow", "unbound-mailcow"
]);

function container(out, r) {
  if (!r.ok) { out.container = null; out.containerNote = r.error; return; }
  const roh = r.data && typeof r.data === "object" ? Object.values(r.data) : [];
  out.containerNote = null;
  out.container = roh.map(c => ({
    name: String(c.container || "—"),
    zustand: c.state || null,
    image: c.image || null,
    seit: c.started_at || null,
    kern: KERN.has(String(c.container))
  })).sort((a, b) => (b.kern - a.kern) || a.name.localeCompare(b.name, "de"));
  out.containerGesamt = out.container.length;
  out.containerLaufen = out.container.filter(c => c.zustand === "running").length;
  out.kernSteht = out.container.filter(c => c.kern && c.zustand !== "running").map(c => c.name);
  out.nebenSteht = out.container.filter(c => !c.kern && c.zustand !== "running").map(c => c.name);
}

/* ---------- Warteschlange ----------
   mailcow gibt die Warteschlange als Liste einzelner Nachrichten heraus,
   mit Ankunftszeit und Grund je Empfänger. Das ist mehr, als der Mail
   Gateway hergibt: dort steht nur eine Altersverteilung, hier steht
   dabei, **warum** es hängt — „Connection timed out", „mailbox full",
   „Host not found". Genau diese Zeile beantwortet die Frage, wegen der
   man nachsieht. */
const ALT_SEKUNDEN = 10 * 3600;

function warteschlange(out, r) {
  if (!r.ok) {
    out.warteschlange = null; out.queueNote = r.error;
    out.queueDeferred = null; out.queueAktiv = null; out.queueHold = null; out.queueAlt = null;
    return;
  }
  const liste = Array.isArray(r.data) ? r.data : [];
  const jetzt = Math.floor(Date.now() / 1000);
  const nach = new Map();
  const gruende = new Map();

  for (const m of liste) {
    const q = String(m.queue_name || "unbekannt");
    if (!nach.has(q)) nach.set(q, { anzahl: 0, aelter: 0, aeltestes: null, ziele: new Map() });
    const e = nach.get(q);
    e.anzahl++;
    const alter = Number.isFinite(Number(m.arrival_time)) ? jetzt - Number(m.arrival_time) : null;
    if (alter != null) {
      if (alter >= ALT_SEKUNDEN) e.aelter++;
      if (e.aeltestes == null || alter > e.aeltestes) e.aeltestes = alter;
    }
    for (const rcpt of m.recipients || []) {
      const text = String(rcpt);
      const dom = (/@([^\s()]+)/.exec(text) || [])[1];
      if (dom) e.ziele.set(dom, (e.ziele.get(dom) || 0) + 1);
      /* mailcow hängt den Grund in Klammern an die Adresse — er steht
         nirgends als eigenes Feld. */
      const grund = (/\(([^)]+)\)\s*$/.exec(text) || [])[1];
      if (grund) gruende.set(grund, (gruende.get(grund) || 0) + 1);
    }
  }

  const eine = q => {
    const e = nach.get(q);
    return {
      queue: q, label: QUEUE_LABEL[q] || q,
      anzahl: e ? e.anzahl : 0,
      aelter: e ? e.aelter : 0,
      aeltestes: e ? e.aeltestes : null,
      domains: e ? [...e.ziele.entries()].map(([domain, anzahl]) => ({ domain, anzahl }))
        .sort((a, b) => b.anzahl - a.anzahl).slice(0, 8) : []
    };
  };
  /* Die vier, die Postfix führt — und was sonst noch auftaucht. Eine
     leere Warteschlange ist hier gemessen und nicht unbekannt: die Liste
     kam an, sie war leer. */
  const bekannt = ["deferred", "active", "hold", "incoming"];
  const weitere = [...nach.keys()].filter(q => !bekannt.includes(q));
  out.warteschlange = [...bekannt, ...weitere].map(eine).filter(x => x.anzahl || bekannt.includes(x.queue));
  out.queueNote = null;
  out.queueGesamt = liste.length;
  out.queueDeferred = eine("deferred").anzahl;
  out.queueAktiv = eine("active").anzahl;
  out.queueHold = eine("hold").anzahl;
  out.queueAlt = eine("deferred").aelter;
  out.queueGruende = [...gruende.entries()].map(([grund, anzahl]) => ({ grund, anzahl }))
    .sort((a, b) => b.anzahl - a.anzahl).slice(0, 8);
}

const QUEUE_LABEL = {
  deferred: "zurückgestellt", active: "in Zustellung",
  hold: "angehalten", incoming: "angenommen", maildrop: "eingeliefert", corrupt: "beschädigt"
};

/* ---------- Platz für die Postfächer ----------
   Läuft `/var/vmail` voll, nimmt Dovecot nichts mehr an. mailcow meldet
   die Zahlen so, wie `df -h` sie ausgibt: als Text mit Einheit. Die
   Prozentangabe kommt mit Prozentzeichen. */
function ablage(out, r) {
  if (!r.ok) { out.vmailPct = null; out.vmailNote = r.error; return; }
  const d = r.data || {};
  out.vmailNote = null;
  out.vmailPct = prozent(d.used_percent);
  out.vmailBelegt = d.used || null;
  out.vmailGesamt = d.total || null;
  out.vmailGeraet = d.disk || null;
  /* Dieselbe Kennzahl unter dem Namen, unter dem der Leitstand überall
     die Plattenbelegung führt — damit Zeitreihe und Ampel sie finden. */
  out.disk = out.vmailPct;
}

function wirt(out, r) {
  if (!r.ok) return;
  const d = r.data || {};
  out.cpu = zahl(d.cpu?.usage);
  out.cores = zahl(d.cpu?.cores);
  out.ram = zahl(d.memory?.usage);
  out.ramTotalMb = Number.isFinite(zahl(d.memory?.total)) ? Math.round(zahl(d.memory.total) / 1048576) : null;
  const lauf = zahl(d.uptime);
  out.uptimeSeconds = lauf;
  out.uptime = lauf != null ? `${Math.floor(lauf / 86400)} T` : null;
  out.arch = d.architecture || null;
}

/* ---------- Filter ----------
   rspamd zählt seit seinem eigenen Start, nicht seit Mitternacht. Diese
   Zahlen ohne ihren Zeitraum zu zeigen wäre eine stille Falschaussage —
   deshalb kommt die Laufzeit mit und steht in der Oberfläche dabei. */
function filter(out, r) {
  if (!r.ok) { out.rspamdNote = r.error; return; }
  const d = r.data || {};
  out.rspamdNote = null;
  out.rspamdVersion = d.version || null;
  out.rspamdSeit = zahl(d.uptime);
  out.geprueft = zahl(d.scanned);
  out.spam = zahl(d.spam_count);
  out.ham = zahl(d.ham_count);
  out.gelernt = zahl(d.learned);
  out.spamAnteil = out.geprueft ? Math.round((out.spam / out.geprueft) * 100) : null;
  const a = d.actions || {};
  out.aktionen = Object.entries(a)
    .map(([name, anzahl]) => ({ name, anzahl: zahl(anzahl) ?? 0 }))
    .sort((x, y) => y.anzahl - x.anzahl);
  out.abgewiesen = zahl(a.reject);
  out.greylist = zahl(a.greylist);
}

/* ---------- Domänen und Postfächer ---------- */
function domaenen(out, r) {
  if (!r.ok) { out.domains = null; out.domainNote = r.error; return; }
  const liste = Array.isArray(r.data) ? r.data : [];
  out.domainNote = null;
  out.domains = liste.map(d => ({
    domain: String(d.domain_name || d.domain || "—"),
    aktiv: d.active_int != null ? !!d.active_int : d.active != null ? !!Number(d.active) : null,
    postfaecher: zahl(d.mboxes_in_domain),
    postfaecherMax: zahl(d.max_num_mboxes_for_domain),
    belegt: zahl(d.bytes_total),
    nachrichten: zahl(d.msgs_total),
    quote: zahl(d.max_quota_for_domain),
    backupmx: d.backupmx_int != null ? !!d.backupmx_int : null
  })).sort((a, b) => (b.belegt ?? 0) - (a.belegt ?? 0));
  out.domainsGesamt = out.domains.length;
  out.postfaecher = summe(out.domains.map(d => d.postfaecher));
  out.belegt = summe(out.domains.map(d => d.belegt));
  out.nachrichten = summe(out.domains.map(d => d.nachrichten));
}

/* Ein volles Postfach nimmt keine Mail mehr an — und niemand merkt es,
   weil der Dienst tadellos läuft. Gezeigt werden die vollsten; bewertet
   wird an der Grenze aus den Einstellungen. */
function postfaecher(out, r) {
  if (!r.ok) { out.mailboxen = null; out.mailboxNote = r.error; return; }
  const liste = Array.isArray(r.data) ? r.data : [];
  out.mailboxNote = null;
  out.mailboxenGesamt = liste.length;
  const mit = liste.map(m => ({
    name: String(m.username || "—"),
    domain: m.domain || null,
    aktiv: m.active_int != null ? !!m.active_int : null,
    quote: zahl(m.quota),
    belegt: zahl(m.quota_used),
    /* mailcow schreibt „- " statt einer Zahl, wenn keine Quote gesetzt
       ist. Das ist keine Null, sondern „unbegrenzt". */
    prozent: zahl(m.percent_in_use),
    nachrichten: zahl(m.messages),
    letzterImap: zeitpunkt(m.last_imap_login),
    letzterSmtp: zeitpunkt(m.last_smtp_login)
  }));
  out.mailboxen = mit.filter(m => m.prozent != null).sort((a, b) => b.prozent - a.prozent).slice(0, 12);
  out.mailboxenOhneQuote = mit.filter(m => m.prozent == null).length;
  out.mailboxVollste = out.mailboxen[0] || null;
}

function quarantaene(out, r) {
  if (!r.ok) { out.quarantaene = null; out.quarNote = r.error; return; }
  const liste = Array.isArray(r.data) ? r.data : [];
  out.quarNote = null;
  /* Gezählt, nicht gelesen: Betreff, Absender und Empfänger bleiben auf
     dem Mailserver. Eine Überwachung braucht die Zahl, nicht den Inhalt
     fremder Post — und was hier nicht ankommt, kann auch nicht in einer
     Zeitreihe oder einer Meldung landen. */
  out.quarantaene = liste.length;
  out.quarantaeneViren = liste.filter(q => Number(q.virus_flag) > 0).length;
  const neuste = liste.map(q => zahl(q.created)).filter(t => t != null).sort((a, b) => b - a)[0];
  out.quarantaeneNeuste = neuste ? new Date(neuste * 1000).toISOString() : null;
}

function sperren(out, r) {
  if (!r.ok) { out.gesperrt = null; return; }
  const d = r.data || {};
  out.gesperrt = Array.isArray(d.active_bans) ? d.active_bans.length : 0;
  out.gesperrtDauerhaft = Array.isArray(d.perm_bans) ? d.perm_bans.length : 0;
}

/* ---------- Ampel ----------
   Dieselbe Rangfolge wie beim Mail Gateway, weil es dieselben Fragen
   sind: läuft der Dienst, hängt Mail, ist Platz da. Die Grenzen für die
   Warteschlange sind bewusst dieselben Einstellungen — „Mail hängt" ist
   keine Eigenschaft des Herstellers. */
function bewerte(out, host, settings) {
  const grenze = schwellenFuer(host, settings);
  const qWarn = zahl(settings.mail_queue_warn) ?? 25;
  const qCrit = zahl(settings.mail_queue_crit) ?? 100;
  const mbVoll = zahl(settings.mailbox_voll_warn) ?? 95;
  out.schwellen = grenze;
  out.queueGrenzen = { warn: qWarn, crit: qCrit };

  const kern = out.kernSteht || [];
  const neben = out.nebenSteht || [];
  const vollstes = (out.mailboxen || []).find(m => m.prozent != null && m.prozent >= mbVoll);

  if (kern.length) {
    out.status = "crit";
    out.note = `${kern.join(", ")} ${kern.length > 1 ? "laufen" : "läuft"} nicht — Mail wird nicht angenommen oder nicht zugestellt`;
  } else if (out.vmailPct != null && out.vmailPct >= grenze.disk_crit) {
    out.status = "crit";
    out.note = `Postfachablage zu ${out.vmailPct} % belegt (kritisch ab ${grenze.disk_crit} %) — ist sie voll, nimmt Dovecot nichts mehr an`;
  } else if (out.queueDeferred != null && out.queueDeferred >= qCrit) {
    out.status = "crit";
    out.note = `${out.queueDeferred} Mail zurückgestellt (kritisch ab ${qCrit})`
      + (out.queueAlt ? `, davon ${out.queueAlt} seit über zehn Stunden` : "");
  } else if (out.ram != null && out.ram >= grenze.ram_crit) {
    out.status = "crit";
    out.note = `Arbeitsspeicher ${out.ram} % belegt (kritisch ab ${grenze.ram_crit} %)`;
  } else if (neben.length) {
    /* Nicht rot: clamd, solr oder sogo können abgeschaltet sein, ohne
       dass Mail stehen bleibt. Namentlich genannt wird trotzdem — ein
       stiller Ausfall ist keiner, den man selbst gewählt hat. */
    out.status = "warn";
    out.note = `${neben.join(", ")} ${neben.length > 1 ? "laufen" : "läuft"} nicht`;
  } else if (out.queueDeferred != null && out.queueDeferred >= qWarn) {
    out.status = "warn";
    out.note = `${out.queueDeferred} Mail zurückgestellt`
      + (out.queueAlt ? `, davon ${out.queueAlt} seit über zehn Stunden` : "");
  } else if (out.queueAlt > 0) {
    out.status = "warn";
    out.note = `${out.queueAlt} Mail liegt seit über zehn Stunden in der Warteschlange`
      + (out.queueGruende?.length ? ` — ${out.queueGruende[0].grund}` : "");
  } else if (out.vmailPct != null && out.vmailPct >= grenze.disk_warn) {
    out.status = "warn";
    out.note = `Postfachablage zu ${out.vmailPct} % belegt`;
  } else if (out.ram != null && out.ram >= grenze.ram_warn) {
    out.status = "warn";
    out.note = `Arbeitsspeicher ${out.ram} % belegt`;
  } else if (vollstes) {
    out.status = "warn";
    out.note = `Postfach ${vollstes.name} ist zu ${vollstes.prozent} % voll — ein volles Postfach weist Mail ab`;
  } else if (out.queueHold > 0) {
    out.note = `${out.queueHold} Mail ist angehalten (hold) und wartet auf eine Entscheidung`;
  } else if (out.quarantaene) {
    out.note = `${out.quarantaene} Nachricht(en) in Quarantäne`;
  }
  return out;
}

/* ---------- Kleinkram ---------- */
const zahl = v => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/* „28%" wie df es schreibt — und „28" wie es eine andere Fassung
   vielleicht schreibt. */
const prozent = v => {
  const n = Number(String(v ?? "").replace("%", "").trim());
  return Number.isFinite(n) ? Math.round(n) : null;
};
const summe = liste => {
  const echte = liste.filter(v => v != null);
  return echte.length ? echte.reduce((a, b) => a + b, 0) : null;
};
/* mailcow schreibt 0, wenn es keine Anmeldung gab oder wenn das Anzeigen
   letzter Anmeldungen abgeschaltet ist. Beides ist „unbekannt" und nicht
   „1970". */
const zeitpunkt = v => {
  const n = zahl(v);
  return n && n > 0 ? new Date(n * 1000).toISOString() : null;
};
