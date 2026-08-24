/* Diagnose: jeden Schritt einzeln zeigen, statt am Ende „geht nicht".

   Wenn ein Knoten erreichbar ist, der Token angeblich stimmt und trotzdem
   keine Kennzahlen ankommen, liegt die Ursache immer an einer von wenigen
   Stellen — und sie ist von außen nicht zu erraten. Also wird hier jeder
   Aufruf, den der Sammler macht, einzeln ausgeführt und mit dem berichtet,
   was er zurückgab: Kennzahl, Fehlercode, Anzahl der Einträge, Knotennamen.

   Grundsätze:
   - Nichts wird geschönt. Ein Fehler steht im Klartext mit HTTP-Code.
   - Das Geheimnis verlässt den Dienst nie, auch nicht in der Diagnose.
     Gezeigt wird die *Form* der Kopfzeile, damit ein Tippfehler in der
     Token-ID auffällt, ohne den Schlüssel preiszugeben.
   - Am Ende steht ein Satz, woran es hängt — und der zeigt auf den ersten
     Schritt, der nicht durchkam, nicht auf den letzten. */

import { runCheck } from "./probe.js";
import { authHeader, baseUrl, RECHTEHINWEIS, TRENNER } from "./collectors/proxmox.js";
import { requestJson } from "./http.js";
import * as Opn from "./collectors/opnsense.js";
import * as Adg from "./collectors/adguard.js";
import * as Ptn from "./collectors/portainer.js";
import * as Pfs from "./collectors/pfsense.js";
import * as Pmg from "./collectors/pmg.js";
import * as Mcw from "./collectors/mailcow.js";

/* Sammler, die sich gleich verhalten: eine Kopfzeile zur Anmeldung, feste
   Pfade, JSON zurück. Für die gibt es einen gemeinsamen Weg (diagnoseEinfach)
   statt je einer Abschrift. */
const EINFACH = {
  adguard: {
    modul: Adg, name: "AdGuard Home",
    fehlt: "Es ist kein Zugang hinterlegt. AdGuard meldet mit Benutzer und Passwort an — dieselben, mit denen "
      + "man sich an der Oberfläche anmeldet. Einzutragen unter Verwaltung → System bearbeiten."
  },
  /* Mailcow verhält sich wie AdGuard und Portainer — eine Kopfzeile,
     feste Pfade, JSON. Der Unterschied steckt im Fehlerfall, und der
     ist hier der halbe Grund für die Diagnose: eine 401 heißt bei
     mailcow nicht unbedingt „falscher Schlüssel", sondern oft „diese
     Adresse steht nicht in „allow from“" — welche Adresse mailcow
     gesehen hat, steht im Rumpf der Antwort und landet über hintFor()
     im Bericht. */
  mailcow: {
    modul: Mcw, name: "Mailcow",
    fehlt: "Es ist kein API-Schlüssel hinterlegt. In mailcow unter Configuration → Access → API einen erzeugen — "
      + "„Read-Only Access“ genügt — und die Adresse des Leitstands in „allow from“ eintragen. "
      + "Danach unter Verwaltung → System bearbeiten hinterlegen."
  },
  portainer: {
    modul: Ptn, name: "Portainer",
    fehlt: "Es ist kein API-Token hinterlegt. In Portainer oben rechts unter „My account“ → „Access tokens“ "
      + "einen erzeugen und unter Verwaltung → System bearbeiten eintragen."
  },
  /* pfSense mit `felder: true`: die Antwortgestalt des Pakets pfSense-pkg-API
     hängt an dessen Fassung, und sie ist nirgends verbindlich beschrieben.
     Der Sammler liest deshalb nachsichtig — und wenn ein Feld trotzdem fehlt,
     steht hier, wie die Antwort dieses Geräts wirklich aussieht. Daran lässt
     er sich nachziehen, statt zu raten. */
  pfsense: {
    modul: Pfs, name: "pfSense", felder: true,
    fehlt: "Es ist kein API-Schlüssel hinterlegt. pfSense hat ab Werk keine Schnittstelle — gelesen wird über das "
      + "Fremdpaket pfSense-pkg-API, das NICHT im Paketverzeichnis von pfSense steht, sondern von Hand aus den "
      + "Veröffentlichungen des Projekts installiert wird; für neuere pfSense-Fassungen gibt es nicht immer eine "
      + "passende. Ist es vorhanden: unter System → API einen Schlüssel erzeugen und unter Verwaltung → System "
      + "bearbeiten eintragen. Ohne das Paket bleibt es bei der reinen Erreichbarkeit — das ist keine Fehleinrichtung, "
      + "sondern der Stand der Dinge bei pfSense."
  }
};

/* Welche Aufrufe der jeweilige Sammler tatsächlich braucht. Die Reihenfolge
   ist die Reihenfolge der Abhängigkeit: was oben scheitert, macht alles
   darunter sinnlos. */
const PFADE = {
  pve: [
    { pfad: "/version", zweck: "erreichbar und angemeldet" },
    { pfad: "/nodes", zweck: "Knotenliste — hier wird der eigene Knoten gesucht" },
    { pfad: "/cluster/resources", zweck: "Gäste und Speicher — daraus kommen VMs, LXC, Belegung" },
    { pfad: "/cluster/status", zweck: "Clustername und Quorum", optional: true },
    { pfad: "/cluster/backup", zweck: "eingerichtete Sicherungsaufträge", optional: true }
  ],
  pbs: [
    { pfad: "/version", zweck: "erreichbar und angemeldet" },
    { pfad: "/status/datastore-usage", zweck: "Belegung je Datastore" },
    { pfad: "/admin/datastore", zweck: "Datastores mit Kommentar und Wartungsmodus", optional: true },
    { pfad: "/nodes/localhost/tasks?limit=60&errors=1", zweck: "fehlgeschlagene Aufträge", optional: true },
    { pfad: "/nodes/localhost/tasks?limit=200", zweck: "letzte Sicherung, Aufräumen und Prüfung je Datastore", optional: true }
  ]
};

export async function diagnoseHost(host, cred, settings = {}) {
  const bericht = {
    host: { id: host.id, type: host.type, ip: host.ip || null, url: host.url || null },
    ziel: null, zugang: null, netz: [], api: [], fazit: null, ok: false
  };

  /* ---- 1. Netz: was der Prober ohnehin misst ---- */
  for (const c of host.checks || []) {
    const r = await runCheck(c, host, { ...settings, timeout: settings.timeout || 5 });
    bericht.netz.push({
      schritt: `${c.kind}${c.port ? "/" + c.port : ""}`,
      ok: r.ok, ms: r.ms ?? null, detail: r.detail || null, uebersprungen: !!r.skipped
    });
  }

  if (host.type === "opnsense") return await diagnoseOpnsense(host, cred, bericht);
  if (host.type === "pmg") return await diagnosePmg(host, cred, bericht);
  if (EINFACH[host.type]) return await diagnoseEinfach(host, cred, bericht, EINFACH[host.type]);

  const kollektor = PFADE[host.type];
  if (!kollektor) {
    bericht.fazit = `Für den Typ „${host.type}" gibt es noch keinen Sammler — geprüft wird nur die Erreichbarkeit.`;
    bericht.ok = bericht.netz.some(n => n.ok);
    return bericht;
  }

  bericht.ziel = baseUrl(host, host.type);

  /* ---- 2. Zugang: ist überhaupt einer hinterlegt, und wie sieht er aus? ---- */
  const kopf = authHeader(host.type, cred);
  bericht.zugang = zugangsForm(host.type, cred, kopf);
  if (!kopf) {
    bericht.fazit = "Es ist kein API-Token hinterlegt. Ohne Zugang bleibt es bei der reinen Erreichbarkeit — "
      + "unter Verwaltung → System bearbeiten eintragen.";
    return bericht;
  }

  /* ---- 3. Die Aufrufe des Sammlers, einer nach dem anderen ---- */
  for (const { pfad, zweck, optional } of kollektor) {
    const r = await requestJson(`${bericht.ziel}/api2/json${pfad}`, { headers: kopf, timeout: 8000 });
    const eintrag = {
      pfad, zweck, optional: !!optional,
      ok: !!r.ok, status: r.status ?? null, ms: r.ms ?? null,
      fehler: r.ok ? null : r.error || "unbekannter Fehler",
      antwort: r.ok ? null : kurzfassung(r.body),
      befund: null
    };
    if (r.ok) eintrag.befund = befundFuer(host, pfad, r.data?.data);
    bericht.api.push(eintrag);
    /* Nach einem harten Fehlschlag weiterzufragen bringt nichts — außer
       Rauschen in einem Bericht, der Klarheit schaffen soll. */
    if (!r.ok && !optional) break;
  }

  bericht.fazit = fazit(host, bericht);
  bericht.ok = !bericht.fazit.problem;
  bericht.fazit = bericht.fazit.text;
  return bericht;
}

/* ---------- OPNsense ----------
   Zwei Unterschiede zu Proxmox, und beide sind der Grund, warum das hier
   eigene Wege geht: die Anmeldung ist HTTP Basic, und die Antwortfelder
   sind nirgends dokumentiert. Deshalb wird bei erfolgreichen Aufrufen die
   *Gestalt* der Antwort mitberichtet — welche Felder es gibt und was
   ungefähr darin steht. Daraus wird anschließend der Sammler gebaut,
   gegen Tatsachen statt gegen Vermutungen. */
async function diagnoseOpnsense(host, cred, bericht) {
  bericht.ziel = Opn.baseUrl(host);
  const kopf = Opn.authHeader(cred);
  bericht.zugang = basicForm(cred, kopf);
  if (!kopf) {
    bericht.fazit = "Es ist kein API-Schlüssel hinterlegt. OPNsense meldet mit Schlüssel und Secret an — "
      + "in OPNsense unter System → Access → Users beim Benutzer erzeugen, dann hier unter "
      + "Verwaltung → System bearbeiten eintragen.";
    return bericht;
  }

  for (const { pfad, alternativen = [], zweck, optional, fehlendOk } of Opn.PFADE) {
    const r = await Opn.ersterTreffer(host, cred, [pfad, ...alternativen]);
    const eintrag = {
      pfad: r.pfad || pfad, zweck, optional: !!optional,
      ok: !!r.ok, status: r.status ?? null, ms: r.ms ?? null,
      fehler: r.ok ? null : (r.status === 404 && fehlendOk ? fehlendOk : r.error || "unbekannter Fehler"),
      antwort: r.ok ? null : kurzfassung(r.body),
      befund: null, felder: null
    };
    if (r.ok) {
      if (r.pfad !== pfad) eintrag.befund = `antwortet unter der Schreibweise ${r.pfad}`;
      /* Genau das brauchen wir für den Sammler. */
      eintrag.felder = gestalt(r.data);
    }
    bericht.api.push(eintrag);
    if (!r.ok && !optional) break;
  }

  const gescheitert = bericht.api.find(a => !a.ok && !a.optional);
  if (gescheitert) {
    bericht.fazit = gescheitert.status === 401
      ? `Die Anmeldung wird abgelehnt: ${gescheitert.pfad} (401). Schlüssel und Secret prüfen — `
        + `OPNsense legt beide zusammen in einer Datei ab, wenn man den Schlüssel erzeugt.`
      : gescheitert.status === 403
        ? `Angemeldet, aber ohne Rechte: ${gescheitert.pfad} (403). Die Gruppe des Benutzers braucht `
          + `Leserechte auf diesen Zweig — für reines Ablesen genügen die Diagnostics-Rechte.`
        : `Der Abruf bricht bei ${gescheitert.pfad} ab (${gescheitert.fehler}).`;
    return bericht;
  }

  const wg = bericht.api.find(a => a.pfad.includes("wireguard"));
  bericht.ok = true;
  bericht.fazit = "Alle nötigen Aufrufe kommen durch."
    + (wg?.ok ? " WireGuard ist lesbar — der echte Handshake ist damit in Reichweite."
      : " WireGuard antwortet nicht; das ist verschmerzbar, solange durch den Tunnel gemessen wird.")
    + " Die Feldnamen unten sind die Grundlage für den Sammler.";
  return bericht;
}

/* ---------- Proxmox Mail Gateway ----------
   Eigener Weg aus einem Grund, der es wert ist, hier zu stehen: **PMG
   kennt keine API-Token.** Die API-Dokumentation weist sie an jedem
   Endpunkt als erlaubt aus — sie wird aus derselben Vorlage erzeugt wie
   die von Proxmox VE —, der Dienst selbst weist sie aber vor jeder
   Rechteprüfung ab. Wer hier mit einer Token-Kopfzeile ankommt, bekommt
   eine 401 und keinen Hinweis darauf, dass nicht das Geheimnis falsch
   ist, sondern das ganze Verfahren.

   Deshalb steht die Anmeldung als eigener, erster Schritt im Bericht:
   sie ist der Schritt, an dem es hängt, wenn es hängt. */
async function diagnosePmg(host, cred, bericht) {
  bericht.ziel = Pmg.baseUrl(host);
  const benutzer = cred?.user || cred?.username || null;
  const passwort = cred?.password || cred?.secret || null;
  bericht.zugang = !cred ? { vorhanden: false, hinweis: "kein Zugang hinterlegt" }
    : !benutzer || !passwort ? { vorhanden: false, hinweis: "Zugang unvollständig — Benutzer oder Passwort fehlt" }
    : {
        vorhanden: true,
        form: `Ticket für ${benutzer}, danach Cookie PMGAuthCookie=••••••`,
        benutzer,
        hinweis: /@/.test(benutzer) ? null
          : "Benutzername ohne Realm — PMG hängt dann „@quarantine“ an und lehnt ab. Gemeint ist leitstand@pmg."
      };
  if (!bericht.zugang.vorhanden) {
    bericht.fazit = "Es sind kein Benutzer und kein Passwort hinterlegt. Der Mail Gateway kennt keine API-Token: "
      + "angemeldet wird wie an der Oberfläche, mit einem Konto in der Rolle Auditor. "
      + "Einzutragen unter Verwaltung → System bearbeiten.";
    return bericht;
  }

  /* Schritt 1: das Ticket. Ohne es hat jeder weitere Aufruf dieselbe
     Antwort, und die sagt nichts Neues. */
  Pmg.ticketVergessen(host.id);
  const an = await Pmg.anmelden(host, cred, 8000);
  bericht.api.push({
    pfad: "/access/ticket", zweck: "Anmeldung — PMG kennt keine API-Token, nur Ticket und Cookie",
    optional: false, ok: !!an.ok, status: an.status ?? null, ms: an.ms ?? null,
    fehler: an.ok ? null : an.error || "unbekannter Fehler", antwort: null,
    befund: an.ok ? `Ticket ausgestellt für ${an.benutzer}${an.rolle ? " · Rolle " + an.rolle : ""} (gilt zwei Stunden)` : null
  });
  if (!an.ok) {
    bericht.fazit = an.status === 401
      ? `Die Anmeldung wird abgelehnt (401). ${Pmg.RECHTEHINWEIS}`
      : `Die Anmeldung kommt nicht durch: ${an.error}. ` + (Pmg.hintFor(an) || "");
    return bericht;
  }

  /* Schritt 2 und folgende: die Aufrufe des Sammlers. Der Knotenname
     steht in keiner Adresse fest — er kommt aus der Antwort davor. */
  let knoten = null;
  for (const { pfad, zweck, optional } of Pmg.PFADE) {
    if (pfad.includes("{knoten}") && !knoten) {
      bericht.api.push({
        pfad, zweck, optional: true, ok: false, status: null, ms: null,
        fehler: "übersprungen — der Knotenname ist nicht bekannt", antwort: null, befund: null
      });
      continue;
    }
    const weg = pfad.replace("{knoten}", encodeURIComponent(String(knoten)));
    const r = await Pmg.api(host, cred, weg, 8000);
    bericht.api.push({
      pfad: weg, zweck, optional: !!optional,
      ok: !!r.ok, status: r.status ?? null, ms: r.ms ?? null,
      fehler: r.ok ? null : r.error || "unbekannter Fehler",
      antwort: r.ok ? null : kurzfassung(r.body),
      befund: r.ok ? Pmg.befund(pfad, r.data?.data) : null
    });
    if (r.ok && pfad === "/nodes") {
      const liste = r.data?.data || [];
      const gesucht = [host.name, host.id].filter(Boolean).map(x => String(x).toLowerCase());
      knoten = (liste.find(n => gesucht.includes(String(n.node).toLowerCase())) || liste[0])?.node || null;
    }
    if (!r.ok && !optional) break;
  }

  const gescheitert = bericht.api.find(a => !a.ok && !a.optional);
  if (gescheitert) {
    bericht.fazit = `Der Abruf bricht bei ${gescheitert.pfad} ab (${gescheitert.fehler}). `
      + (Pmg.hintFor(gescheitert) || "");
    return bericht;
  }
  const uebergangen = bericht.api.filter(a => !a.ok && a.optional);
  bericht.ok = true;
  bericht.fazit = "Alle nötigen Aufrufe kommen durch — der Mail Gateway liefert, was der Sammler braucht."
    + (uebergangen.length
      ? ` Ohne Antwort blieben: ${uebergangen.map(a => a.pfad).join(", ")} — dort fehlt je eine Angabe, nicht die Anbindung.`
      : "");
  return bericht;
}

/* ---------- AdGuard Home und Portainer ----------
   Beide sprechen dasselbe Muster: eine Kopfzeile zur Anmeldung, feste
   Pfade, JSON zurück. Der Ablauf ist derselbe wie oben — jeder Aufruf
   einzeln, mit dem, was zurückkam, und am Ende ein Satz zum ersten
   Schritt, der nicht durchkam.

   Ein Pfad darf {umgebung} enthalten: das ersetzt die Diagnose durch die
   Kennung der ersten erreichbaren Umgebung aus der Antwort davor
   (Portainer). Eine fest eingetragene 1 wäre geraten — und bei einer
   Portainer-Installation, in der die erste Umgebung gelöscht wurde,
   schlicht falsch. */
async function diagnoseEinfach(host, cred, bericht, { modul, name, fehlt, felder = false }) {
  bericht.ziel = modul.baseUrl(host);
  const kopf = modul.authHeader(cred);
  bericht.zugang = kopfForm(cred, kopf);
  if (!kopf) { bericht.fazit = fehlt; return bericht; }

  let umgebung = null;
  for (const { pfad, alternativen = [], zweck, optional } of modul.PFADE) {
    if (pfad.includes("{umgebung}") && umgebung == null) {
      bericht.api.push({
        pfad, zweck, optional: true, ok: false, status: null, ms: null,
        fehler: "übersprungen — es ist keine erreichbare Umgebung bekannt", antwort: null, befund: null
      });
      continue;
    }
    const wege = [pfad, ...alternativen].map(p => p.replace("{umgebung}", String(umgebung)));
    const r = modul.ersterTreffer
      ? await modul.ersterTreffer(host, cred, wege, 8000)
      : { ...(await modul.api(host, cred, wege[0], 8000)), pfad: wege[0] };

    const eintrag = {
      pfad: r.pfad || wege[0], zweck, optional: !!optional,
      ok: !!r.ok, status: r.status ?? null, ms: r.ms ?? null,
      fehler: r.ok ? null : r.error || "unbekannter Fehler",
      antwort: r.ok ? null : kurzfassung(r.body),
      befund: r.ok ? modul.befund(r.pfad || wege[0], r.data) : null,
      /* Nur wo die Antwortgestalt unsicher ist — sonst bläht es den
         Bericht auf, ohne eine Frage zu beantworten. */
      felder: r.ok && felder ? gestalt(r.data) : null
    };
    /* Verglichen wird mit dem eingesetzten Pfad, nicht mit der Vorlage:
       sonst stünde bei jedem {umgebung} ein „antwortet unter …", das nur
       die eigene Ersetzung zurückliest. */
    if (r.ok && r.pfad && r.pfad !== wege[0]) eintrag.befund = `${eintrag.befund} (antwortet unter ${r.pfad})`;
    bericht.api.push(eintrag);

    /* Aus der Umgebungsliste die erste erreichbare merken. */
    if (r.ok && pfad === "/api/endpoints" && Array.isArray(r.data))
      umgebung = (r.data.find(e => e.Status === 1) || r.data[0])?.Id ?? null;

    if (!r.ok && !optional) break;
  }

  const gescheitert = bericht.api.find(a => !a.ok && !a.optional);
  if (gescheitert) {
    const wo = `${gescheitert.pfad} (${gescheitert.fehler})`;
    bericht.fazit = gescheitert.status === 401 || gescheitert.status === 403
      ? `Die Anmeldung wird abgelehnt: ${wo}. ${modul.hintFor(gescheitert) || ""}`.trim()
      : gescheitert.status === 404
        ? `Erreicht, aber der Endpunkt fehlt: ${wo}. ${modul.hintFor(gescheitert) || ""}`.trim()
        : `Der Abruf bricht bei ${wo} ab.`;
    return bericht;
  }

  /* Eine leere Liste ist bei Portainer kein Erfolg: sie wird nach Rechten
     gefiltert, statt abgelehnt zu werden — genau wie bei Proxmox. */
  const leer = bericht.api.find(a => a.ok && /nach Rechten/.test(a.befund || ""));
  if (leer) {
    bericht.fazit = `Angemeldet, aber ${leer.befund}. ${modul.hintFor({ status: 403 }) || ""}`.trim();
    return bericht;
  }

  const abgelehnt = bericht.api.find(a => !a.ok && (a.status === 401 || a.status === 403));
  bericht.ok = !abgelehnt;
  bericht.fazit = abgelehnt
    ? `Die Kennzahlen kommen an, aber ${abgelehnt.pfad} wird abgelehnt (${abgelehnt.status}). `
      + `${modul.hintFor(abgelehnt) || ""}`.trim()
    : `Alle nötigen Aufrufe kommen durch — ${name} liefert, was der Sammler braucht.`;
  return bericht;
}

/* Die Form der Anmeldung, ohne das Geheimnis: genug, um einen Tippfehler
   zu sehen, zu wenig, um damit etwas anzufangen. Basic ist nur Base64 —
   die Kopfzeile selbst darf hier nirgends auftauchen. */
function kopfForm(cred, kopf) {
  if (!cred) return { vorhanden: false, hinweis: "kein Zugang hinterlegt" };
  if (!kopf) return { vorhanden: false, hinweis: "Zugang unvollständig — Benutzer, Passwort oder Token fehlt" };
  if (kopf["X-API-Key"]) {
    const t = String(kopf["X-API-Key"]);
    return { vorhanden: true, form: `X-API-Key: ${t.slice(0, 4)}…•••••• (${t.length} Zeichen)`, hinweis: null };
  }
  const benutzer = cred.user || cred.username || null;
  return {
    vorhanden: true,
    form: `Basic ${benutzer ? String(benutzer) : "?"}:••••••••`,
    benutzer,
    hinweis: null
  };
}

/* Die Gestalt einer Antwort: welche Felder, welcher Art, ungefähr welcher
   Inhalt. Lange Werte werden gekürzt — es geht um den Bauplan, nicht um
   die Daten. */
function gestalt(data, tiefe = 0) {
  if (data === null || data === undefined) return "null";

  if (Array.isArray(data)) {
    if (!data.length) return "[] (leer)";
    const erste = gestalt(data[0], tiefe + 1);
    /* Listen sind oft gemischt — bei WireGuard etwa eine Zeile je
       Schnittstelle und eine je Peer, und nur letztere trägt den
       Handshake. Die erste Zeile allein verschwiege genau das. */
    const schluessel = o => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).join(",") : "");
    const andere = data.find(x => schluessel(x) && schluessel(x) !== schluessel(data[0]));
    return `[${data.length}×] ${erste}${andere ? ` — daneben: ${gestalt(andere, tiefe + 1)}` : ""}`;
  }

  if (typeof data === "object") {
    const paare = Object.entries(data).slice(0, tiefe ? 12 : 20);
    const rest = Object.keys(data).length - paare.length;
    const inhalt = paare
      .map(([k, v]) => `${k}: ${GEHEIM_FELD.test(k) ? "«verborgen»" : tiefe >= 3 ? typeof v : gestalt(v, tiefe + 1)}`)
      .join(", ");
    return `{ ${inhalt}${rest > 0 ? `, … +${rest} weitere` : ""} }`;
  }

  if (typeof data === "string") return data.length > 40 ? JSON.stringify(data.slice(0, 40) + "…") : JSON.stringify(data);
  return String(data);
}

/* Der Bericht wird herumgereicht. Feldnamen sind harmlos, Inhalte nicht
   immer — ein privater Schlüssel hat darin nichts zu suchen, auch nicht
   versehentlich. */
const GEHEIM_FELD = /private|secret|password|passwd|psk|preshared|token|apikey/i;

function basicForm(cred, kopf) {
  if (!cred) return { vorhanden: false, hinweis: "kein API-Schlüssel hinterlegt" };
  const key = cred.key || cred.apiKey || cred.user;
  if (!kopf) return { vorhanden: false, hinweis: key ? "Secret fehlt" : "Schlüssel fehlt", benutzer: key || null };
  return {
    vorhanden: true,
    /* Basic-Auth ist nur Base64 — die Kopfzeile selbst darf nirgends
       auftauchen, sonst stünde das Secht lesbar im Bericht. */
    form: `Basic ${String(key).slice(0, 8)}…:••••••••`,
    benutzer: key,
    hinweis: null
  };
}

/* Die Form der Kopfzeile — genug, um einen Tippfehler zu sehen, zu wenig,
   um damit etwas anzufangen. */
function zugangsForm(type, cred, kopf) {
  if (!cred) return { vorhanden: false, hinweis: "kein Token hinterlegt" };
  if (!kopf) return {
    vorhanden: false,
    hinweis: cred.secret ? "Token-ID fehlt" : "Geheimnis fehlt",
    benutzer: cred.user || null, tokenId: cred.tokenId || null
  };
  /* Abgeschnitten wird am Trennzeichen des jeweiligen Produkts — beim
     Backup Server am Doppelpunkt. Am „=" zu schneiden hieße dort, die
     Token-ID mit zu verdecken; gerade sie soll man hier prüfen können. */
  const wert = kopf.Authorization;
  const bis = wert.lastIndexOf(TRENNER[type] || "=");
  return {
    vorhanden: true,
    form: wert.slice(0, bis + 1) + "••••••••",
    benutzer: cred.user || null,
    tokenId: cred.tokenId || null,
    hinweis: cred.tokenId && cred.tokenId.includes("!")
      ? "Token-ID enthält bereits Benutzer@Realm — der Benutzer wird dann nicht davorgesetzt"
      : null
  };
}

/* Aus einer erfolgreichen Antwort das herausziehen, was die Frage
   beantwortet — nicht die Rohdaten, sondern das Zählbare. */
function befundFuer(host, pfad, data) {
  if (pfad === "/version") {
    const v = data || {};
    return v.version ? `Version ${v.version}${v.release ? " (" + v.release + ")" : ""}` : "Antwort ohne Versionsangabe";
  }

  if (pfad === "/nodes") {
    const nodes = data || [];
    const namen = nodes.map(n => n.node);
    if (!namen.length) return "Die Knotenliste ist leer — dem Token fehlen Leserechte auf /nodes";
    const treffer = namen.find(n => String(n).toLowerCase() === String(host.id).toLowerCase()
      || String(n).toLowerCase() === String(host.name || "").toLowerCase());
    const gewaehlt = treffer || (nodes.length === 1 ? namen[0] : null);
    return `${namen.length} Knoten: ${namen.join(", ")} — `
      + (treffer ? `„${treffer}" passt zur Kennung`
        : gewaehlt ? `keiner passt zur Kennung „${host.id}", aber es gibt nur einen: „${gewaehlt}" wird genommen`
        : `KEINER passt zur Kennung „${host.id}" — die Kennung muss dem Knotennamen entsprechen`);
  }

  if (pfad === "/cluster/resources") {
    const alle = data || [];
    if (!alle.length) return "Die Liste ist leer — Proxmox filtert sie nach Rechten, das ist also ein Rechteproblem";
    const jeKnoten = zaehle(alle.map(r => r.node || "(ohne Knoten)"));
    const jeTyp = zaehle(alle.map(r => r.type));
    const kopf = `${alle.length} Einträge — Typen: ${alsListe(jeTyp)} · Knoten: ${alsListe(jeKnoten)}`;
    /* Der Knoten selbst steht hier auch drin. Kommen ausschließlich solche
       Einträge, ist die Liste inhaltlich genauso leer — nur sieht man es
       ihr nicht an. */
    const bestand = alle.filter(r => r.type !== "node");
    if (!bestand.length) return kopf + " — NUR Knoten-Einträge: keine Gäste, keine Speicher sichtbar";
    return kopf;
  }

  if (pfad === "/cluster/status") {
    const cl = (data || []).find(x => x.type === "cluster");
    return cl ? `Cluster „${cl.name}", Quorum ${cl.quorate === 1 ? "ja" : "NEIN"}` : "kein Cluster — Einzelknoten";
  }

  if (pfad === "/status/datastore-usage") {
    const st = data || [];
    return st.length ? `${st.length} Datastore(s): ${st.map(s => s.store).join(", ")}` : "keine Datastores sichtbar — Rechteproblem";
  }

  if (pfad.startsWith("/nodes/localhost/tasks")) {
    const t = data || [];
    return `${t.length} Aufgabe(n) in der Liste`;
  }

  if (pfad.startsWith("/statistics/mail")) {
    const d = data || {};
    return d.count_in != null ? `Eingang 24 h: ${d.count_in}` : "Antwort ohne Zählwerte";
  }

  return Array.isArray(data) ? `${data.length} Einträge` : "Antwort erhalten";
}

/* Ein Satz, woran es hängt — und zwar am ersten Schritt, der nicht durchkam. */
function fazit(host, b) {
  const gescheitert = b.api.find(a => !a.ok && !a.optional);
  if (gescheitert) {
    const wo = `${gescheitert.pfad} (${gescheitert.fehler})`;
    if (gescheitert.status === 401)
      return { problem: true, text: `Die Anmeldung wird abgelehnt: ${wo}. Token-ID und Geheimnis prüfen — `
        + `die Token-ID lautet vollständig Benutzer@Realm!Name, das Geheimnis gibt es nur beim Anlegen zu sehen.` };
    if (gescheitert.status === 403)
      return { problem: true, text: host.type === "pbs"
        ? `Angemeldet, aber ohne Leserechte: ${wo}. Rolle Audit auf / mit Propagate setzen — `
          + `auf die Token-ID, nicht nur auf den Benutzer. DatastoreAudit allein deckt die Aufgabenliste nicht ab.`
        : `Angemeldet, aber ohne Leserechte: ${wo}. Rolle PVEAuditor auf / mit Vererbung setzen — `
          + `bei „Privilege Separation“ dem Token selbst, nicht nur dem Benutzer.` };
    if (gescheitert.status === 404)
      return { problem: true, text: `Erreicht, aber der Endpunkt fehlt: ${wo}. Meist der falsche Port — `
        + `Proxmox VE 8006, Backup Server 8007, Mail Gateway 8006.` };
    return { problem: true, text: `Der Abruf bricht bei ${wo} ab.` };
  }

  /* Ein abgelehnter Aufruf, der als „optional" gilt, ist trotzdem ein
     Befund: er sagt, welches Recht fehlt. Als Nebensache abzutun, was die
     Ursache benennt, wäre der Sinn der Diagnose verfehlt. */
  const rechtefehler = b.api.find(a => !a.ok && a.status === 403);
  const res = b.api.find(a => a.pfad === "/cluster/resources");
  const nurKnoten = res?.ok && /NUR Knoten-Einträge/.test(res.befund || "");
  const leer = res?.ok && /Liste ist leer/.test(res.befund || "");

  if (nurKnoten || leer) {
    const was = leer ? "die Bestandsliste kommt leer zurück"
      : "es kommen nur Knoten-Einträge zurück — keine Gäste, keine Speicher";
    const dazu = rechtefehler
      ? ` Passend dazu wird ${rechtefehler.pfad} abgelehnt${
          /Sys\.Audit/.test(rechtefehler.antwort || "") ? " (Sys.Audit auf / fehlt)" : ""}.`
      : "";
    return { problem: true, text: `Der Token darf die Knoten sehen, aber ${was}.${dazu} `
      + `Proxmox filtert diese Liste nach Rechten, statt sie abzulehnen — die Rolle greift also nicht auf „/“. ${RECHTEHINWEIS}` };
  }

  if (rechtefehler)
    return { problem: true, text: `Die Kennzahlen kommen an, aber ${rechtefehler.pfad} wird abgelehnt`
      + `${/Sys\.Audit/.test(rechtefehler.antwort || "") ? " (Sys.Audit auf / fehlt)" : ""}. `
      + `Clustername und Quorum bleiben deshalb leer. ${RECHTEHINWEIS}` };

  const nodes = b.api.find(a => a.pfad === "/nodes");
  if (nodes?.ok && /KEINER passt/.test(nodes.befund || ""))
    return { problem: true, text: `Die Kennung „${host.id}" kommt in der Knotenliste nicht vor. `
      + `Sie muss dem Knotennamen im Cluster entsprechen — unter Verwaltung umbenennen oder das System neu anlegen.` };

  if (res?.ok) {
    const eigen = new RegExp(`\\b${host.id}\\b`, "i").test(res.befund || "");
    if (!eigen && !/keiner passt/i.test(nodes?.befund || ""))
      return { problem: true, text: `Es kommen Einträge zurück, aber keiner für „${host.id}". `
        + `Vermutlich gehören sie zu einem anderen Knoten des Clusters.` };
  }

  if (!b.netz.some(n => n.ok))
    return { problem: true, text: "Keine der Netzprüfungen kam durch — das System ist gar nicht erreichbar." };

  return { problem: false, text: "Alle Aufrufe kommen durch. Der Sammler bekommt, was er braucht." };
}

const zaehle = liste => liste.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
const alsListe = m => [...m.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
const kurzfassung = t => (t ? String(t).replace(/\s+/g, " ").slice(0, 200) : null);

/* ---------- Für die Ausgabe im Terminal ---------- */
export function alsText(b) {
  const z = [];
  const ja = ok => (ok === null ? "· " : ok ? "OK" : "!!");
  z.push(`System   ${b.host.id}  (${b.host.type})`);
  if (b.host.ip) z.push(`Adresse  ${b.host.ip}`);
  if (b.ziel) z.push(`API      ${b.ziel}`);
  if (b.zugang) {
    z.push(`Zugang   ${b.zugang.vorhanden ? b.zugang.form : "— " + b.zugang.hinweis}`);
    if (b.zugang.vorhanden && b.zugang.hinweis) z.push(`         Hinweis: ${b.zugang.hinweis}`);
  }
  z.push("");
  z.push("Netz");
  for (const n of b.netz)
    z.push(`  ${n.uebersprungen ? "· " : ja(n.ok)}  ${n.schritt.padEnd(10)} ${n.ms != null ? String(n.ms).padStart(5) + " ms" : "      "}  ${n.detail || ""}`);
  if (b.api.length) {
    z.push("");
    z.push("API");
    for (const a of b.api) {
      z.push(`  ${ja(a.ok)}  ${a.pfad}${a.optional ? "  (optional)" : ""}`);
      z.push(`      ${a.zweck}`);
      if (a.ok) {
        if (a.befund) z.push(`      -> ${a.befund}${a.ms != null ? `  [${a.ms} ms]` : ""}`);
        else if (a.ms != null) z.push(`      -> geantwortet  [${a.ms} ms]`);
        if (a.felder) z.push(`      -> Felder: ${a.felder}`);
      }
      else {
        z.push(`      -> ${a.fehler}`);
        if (a.antwort) z.push(`      -> Antwort: ${a.antwort}`);
      }
    }
  }
  z.push("");
  z.push(b.ok ? "Ergebnis: in Ordnung." : "Woran es hängt:");
  z.push(`  ${b.fazit}`);
  return z.join("\n");
}
