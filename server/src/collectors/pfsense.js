/* pfSense — über das Paket `pfSense-pkg-API`.

   pfSense CE hat keine Schnittstelle ab Werk. Gelesen wird deshalb über
   das Fremdpaket pfSense-pkg-API, das unter /api/… eine REST-Fassung der
   pfSense-Internas anbietet. Damit fällt pfSense in dasselbe Muster wie
   alles andere hier: eine Kopfzeile zur Anmeldung, feste Pfade, JSON
   zurück — kein SSH, kein Auswerten von Textausgaben, keine erhöhten
   Rechte im Behälter.

   ────────────────────────────────────────────────────────────
   ZWEI VORBEHALTE, die hier festgehalten gehören:

   1. **Das Paket zählt zwei Fassungen**, und sie sprechen verschieden.
      v2 meldet mit `X-API-Key` an und liegt unter /api/v2/…, v1 mit einer
      `Authorization`-Zeile aus Client-ID und Token unter /api/v1/….
      Beide sind im Feld anzutreffen. Deshalb kennt jeder Eintrag unten
      beide Schreibweisen, und `ersterTreffer` probiert sie der Reihe nach
      durch — aber nur bei „gibt es nicht" (404); bei 401 hilft ein anderer
      Pfad nicht, das ist eine Rechtefrage.

   2. **Die Antwortfelder sind gegen die Fassung zu prüfen.** Sie stammen
      aus den pfSense-Internas (`get_interface_info`,
      `return_gateways_status`), die das Paket durchreicht — die Namen hier
      sind danach gewählt und nicht geraten, aber sie sind nicht
      versprochen. Gelesen wird deshalb durchweg nachsichtig: jedes Feld
      kennt mehrere mögliche Namen, und was nicht kommt, bleibt null und
      wird als Strich angezeigt. Die Diagnose zeigt zu jedem geglückten
      Aufruf die *tatsächlichen* Feldnamen — daran lässt sich der Sammler
      nachziehen, falls eine Fassung anders antwortet.
   ────────────────────────────────────────────────────────────

   Alles, was hier herauskommt, trägt dieselben Feldnamen wie bei
   OPNsense. Die Oberfläche muss beide dann nicht auseinanderhalten, und
   eine Firewall bleibt eine Firewall. */

import { requestJson } from "../http.js";
import { schwellenFuer } from "../inventory.js";
import { ausZaehlern, NICHT_PHYSISCH, zahl } from "./durchsatz.js";

/* ---------- Zugang ----------
   v2: X-API-Key. v1: Authorization mit Client-ID und Token. Und weil das
   Paket auch die lokale Benutzerdatenbank zulässt, geht ebenso Basic —
   das ist der Weg, den man ohne eigenen Schlüssel zuerst zur Hand hat. */
export function authHeader(cred) {
  if (!cred) return null;
  const key = cred.key || cred.apiKey || cred.token;
  if (key) return { "X-API-Key": String(key) };
  if (cred.clientId && cred.clientToken)
    return { Authorization: `${cred.clientId} ${cred.clientToken}` };
  const user = cred.user || cred.username;
  const pass = cred.password || cred.secret;
  if (user && pass)
    return { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") };
  return null;
}

/* Ein Pfad in der Adresse bleibt stehen: pfSense liegt gern hinter einem
   Reverse Proxy unter einem Unterpfad. */
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
  {
    pfad: "/api/v2/status/system",
    alternativen: ["/api/v1/status/system"],
    zweck: "Laufzeit, Last, Arbeitsspeicher, Plattenbelegung"
  },
  {
    pfad: "/api/v2/system/version",
    alternativen: ["/api/v1/system/version"],
    zweck: "Fassung und ob eine neuere bereitsteht"
  },
  {
    pfad: "/api/v2/status/interfaces",
    alternativen: ["/api/v2/status/interface", "/api/v1/status/interface"],
    zweck: "Zähler je Schnittstelle — daraus Durchsatz, Pakete, Fehler und Verwürfe",
    optional: true
  },
  {
    pfad: "/api/v2/status/gateways",
    alternativen: ["/api/v2/status/gateway", "/api/v1/status/gateway"],
    zweck: "Gateways: online, Verlust, Latenz — das hat OPNsense hier nicht",
    optional: true
  },
  {
    pfad: "/api/v2/firewall/states/size",
    alternativen: ["/api/v1/firewall/states/size"],
    zweck: "Zustandstabelle: belegt von wie vielen",
    optional: true
  },
  {
    pfad: "/api/v2/status/carp",
    alternativen: ["/api/v1/status/carp"],
    zweck: "CARP: Rolle und Wartungsmodus",
    optional: true,
    fehlendOk: "CARP ist auf diesem Gerät nicht eingerichtet"
  },
  {
    pfad: "/api/v2/status/wireguard/peers",
    alternativen: ["/api/v2/vpn/wireguard/peers", "/api/v1/vpn/wireguard/peer"],
    zweck: "WireGuard: Peers und, wenn die Fassung ihn führt, der letzte Handshake",
    optional: true,
    fehlendOk: "WireGuard ist nicht eingerichtet oder diese Fassung des Pakets führt es nicht"
  }
];

export async function api(host, cred, pfad, timeout = 8000) {
  const headers = authHeader(cred);
  if (!headers) return { ok: false, error: "Kein API-Schlüssel hinterlegt" };
  return requestJson(`${baseUrl(host)}${pfad}`, { headers, timeout });
}

/* Das Paket verpackt jede Antwort in einen Umschlag:
     { code: 200, status: "ok", response_id: "SUCCESS", data: … }
   Interessant ist `data`. Ältere Fassungen schrieben stattdessen `data`
   auf oberster Ebene oder gaben die Nutzlast blank zurück — deshalb wird
   ausgepackt, was sich auspacken lässt, und sonst genommen, was da ist. */
export function nutzlast(body) {
  if (body === null || body === undefined) return null;
  if (typeof body !== "object") return body;
  if ("data" in body) return body.data;
  return body;
}

export async function ersterTreffer(host, cred, pfade, timeout = 8000) {
  let letzte = null;
  for (const p of pfade) {
    const r = await api(host, cred, p, timeout);
    if (r.ok) return { ...r, pfad: p };
    letzte = { ...r, pfad: p };
    /* Nur bei „gibt es nicht" die nächste Fassung probieren. */
    if (r.status !== 404) break;
  }
  return letzte;
}

export function hintFor(r) {
  if (r.status === 401)
    return "Die Anmeldung wird abgelehnt. In pfSense unter System → API → Keys einen Schlüssel erzeugen und hier "
      + "eintragen. Der Benutzer dahinter braucht nur Leserechte („Status“-Seiten genügen).";
  if (r.status === 403)
    return "Angemeldet, aber ohne Rechte: dem Benutzer fehlen die Privilegien für diesen Endpunkt. In pfSense unter "
      + "System → User Manager die Berechtigungen prüfen.";
  if (r.status === 404)
    return "Erreicht, aber der Endpunkt fehlt. Entweder ist das Paket pfSense-pkg-API nicht installiert, oder die "
      + "Oberfläche liegt hinter einem Reverse Proxy unter einem Unterpfad — der gehört dann mit in die Adresse.";
  if (/abgewiesen/.test(r.error || ""))
    return "Port prüfen: die pfSense-Oberfläche läuft je nach Einrichtung auf 443 oder 80.";
  return null;
}

/* Was aus einer geglückten Antwort für die Diagnose zählt. */
export function befund(pfad, data) {
  const d = nutzlast(data);
  if (/system\/version/.test(pfad)) {
    const v = fassungAus(d);
    return `pfSense ${v.version || "?"}${v.neuer ? ` — ${v.neuer} steht bereit` : ""}`;
  }
  if (/status\/system/.test(pfad)) {
    const s = systemAus(d);
    return [s.uptime ? `Laufzeit ${s.uptime}` : null,
      s.ram != null ? `RAM ${s.ram} %` : null,
      s.disk != null ? `Platte ${s.disk} %` : null,
      s.load ? `Last ${s.load}` : null].filter(Boolean).join(", ") || "Antwort erhalten";
  }
  if (/interface/.test(pfad)) {
    const liste = alsListe(d);
    return `${liste.length} Schnittstelle(n)`;
  }
  if (/gateway/.test(pfad)) {
    const g = gatewaysAus(d);
    return `${g.length} Gateway(s)${g.length ? ": " + g.map(x => `${x.name} ${x.status}`).join(", ") : ""}`;
  }
  if (/states\/size/.test(pfad)) {
    const s = zustandstabelleAus(d);
    return s.states != null ? `${s.states} von ${s.statesMax ?? "?"} Einträgen belegt` : "Antwort erhalten";
  }
  if (/carp/.test(pfad)) {
    const c = carpAus(d);
    return c.carp ? `CARP ${c.carp}${c.carpWartung ? " (Wartungsmodus)" : ""}` : "CARP nicht aktiv";
  }
  if (/wireguard/.test(pfad)) {
    const p = peersAus(d);
    return `${p.peers?.length ?? 0} Peer(s)`
      + (p.handshakeUnbekannt ? " — diese Fassung meldet keinen Handshake" : "");
  }
  return "Antwort erhalten";
}

/* ---------- Verbindungstest ---------- */
export async function testConnection(host, cred) {
  const sys = await ersterTreffer(host, cred, ["/api/v2/status/system", "/api/v1/status/system"], 6000);
  if (!sys.ok) return { ok: false, detail: sys.error, hint: hintFor(sys) };

  const fassung = await ersterTreffer(host, cred, ["/api/v2/system/version", "/api/v1/system/version"], 6000);
  const v = fassung.ok ? fassungAus(nutzlast(fassung.data)) : {};
  const teile = [`Verbunden — pfSense${v.version ? " " + v.version : ""}`];
  teile.push(sys.pfad.startsWith("/api/v2") ? "API-Paket v2" : "API-Paket v1");

  /* Wie bei Proxmox' /version: der Zustand allein wäre ein zu freundlicher
     Test. Gebraucht werden die Schnittstellenzähler — daran hängt alles,
     wofür man diese Anbindung baut. */
  const ifs = await ersterTreffer(host, cred,
    ["/api/v2/status/interfaces", "/api/v2/status/interface", "/api/v1/status/interface"], 6000);
  if (!ifs.ok) {
    return {
      ok: false,
      detail: teile.join(" · ") + ` — aber die Schnittstellen sind nicht lesbar: ${ifs.error}`,
      hint: hintFor(ifs), version: v.version || null
    };
  }
  teile.push(`${alsListe(nutzlast(ifs.data)).length} Schnittstelle(n) lesbar`);
  return { ok: true, detail: teile.join(" · "), version: v.version || null, ms: sys.ms };
}

/* ============================================================
   Sammler
   ============================================================ */

const zaehlerSchluessel = host => host.id + "@" + baseUrl(host);

export async function collectPfsense(host, cred, settings) {
  const grenze = schwellenFuer(host, settings);
  const [sys, ver, ifs, gws, states, carp, wg] = await Promise.all([
    ersterTreffer(host, cred, ["/api/v2/status/system", "/api/v1/status/system"]),
    ersterTreffer(host, cred, ["/api/v2/system/version", "/api/v1/system/version"]),
    ersterTreffer(host, cred, ["/api/v2/status/interfaces", "/api/v2/status/interface", "/api/v1/status/interface"]),
    ersterTreffer(host, cred, ["/api/v2/status/gateways", "/api/v2/status/gateway", "/api/v1/status/gateway"]),
    ersterTreffer(host, cred, ["/api/v2/firewall/states/size", "/api/v1/firewall/states/size"]),
    ersterTreffer(host, cred, ["/api/v2/status/carp", "/api/v1/status/carp"]),
    ersterTreffer(host, cred, ["/api/v2/status/wireguard/peers", "/api/v2/vpn/wireguard/peers", "/api/v1/vpn/wireguard/peer"])
  ]);

  /* Der Systemzustand ist der Anker: kommt der nicht, stimmt am Zugang
     etwas nicht, und alles Weitere wäre Rauschen. */
  if (!sys.ok) return {
    error: sys.error, note: sys.error,
    status: (sys.status === 401 || sys.status === 403) ? "warn" : undefined
  };

  const out = { api: sys.pfad.startsWith("/api/v2") ? "v2" : "v1" };
  Object.assign(out, systemAus(nutzlast(sys.data)));
  if (ver.ok) Object.assign(out, fassungAus(nutzlast(ver.data)));
  schnittstellen(out, host, ifs.ok ? nutzlast(ifs.data) : null);
  if (gws.ok) out.gateways = gatewaysAus(nutzlast(gws.data));
  else out.gateways = null;
  if (states.ok) Object.assign(out, zustandstabelleAus(nutzlast(states.data)));
  else { out.states = null; out.statesMax = null; out.statesPct = null; }
  /* Nicht abgefragt und „nicht eingerichtet" sind beide *unbekannt* — und
     unbekannt ist ausdrücklich null, damit die Oberfläche einen Strich
     zeigt statt gar nichts. */
  Object.assign(out, carp.ok ? carpAus(nutzlast(carp.data)) : { carp: null, carpWartung: null });
  wireguard(out, wg);

  out.schwellen = grenze;
  ampel(out, grenze);
  return out;
}

/* ---------- Systemzustand ----------
   pfSense meldet Belegungen teils als Zahl, teils als Zeichenkette mit
   Prozentzeichen („43%"), teils als Bruchteil. `prozent` nimmt alles drei
   und gibt im Zweifel null zurück — lieber ein Strich als eine Zahl, die
   um den Faktor hundert danebenliegt. */
function systemAus(d) {
  if (!d || typeof d !== "object") return {};
  const out = {};
  out.cpu = prozent(nimm(d, "cpu_usage", "cpu", "cpu_load"));
  out.ram = prozent(nimm(d, "mem_usage", "memory_usage", "mem", "memory"));
  out.disk = prozent(nimm(d, "disk_usage", "disk", "filesystem_usage"));
  out.tempC = zahl(nimm(d, "temp", "temperature", "cpu_temp"));

  const sek = zahl(nimm(d, "uptime_seconds", "uptimesec", "uptime_sec"));
  const roh = nimm(d, "uptime", "uptime_frmt");
  out.uptimeSeconds = sek ?? sekunden(roh);
  out.uptimeText = roh == null ? null : String(roh);
  out.uptime = out.uptimeSeconds != null ? dauer(out.uptimeSeconds) : out.uptimeText;

  const last = nimm(d, "load_avg", "loadavg", "cpu_load_avg");
  out.load = last == null ? null
    : Array.isArray(last) ? last.join(", ")
    : String(last).trim() || null;
  const erste = out.load ? Number(String(out.load).split(/[,\s]+/)[0]) : NaN;
  out.load1 = Number.isFinite(erste) ? erste : null;
  return out;
}

/* ---------- Fassung ---------- */
function fassungAus(d) {
  if (!d || typeof d !== "object") return {};
  const out = {};
  out.version = nimm(d, "version", "installed_version", "base_version", "current_version") || null;
  if (out.version) out.version = String(out.version).replace(/^v/, "");
  out.os = nimm(d, "platform", "kernel", "os_version") || null;
  const neuer = nimm(d, "latest_version", "new_version", "available_version");
  const flagge = nimm(d, "update_available", "updates_available", "new_version_available");
  /* „Es gibt eine neuere" ist eine Zahl von Aktualisierungen nur in dem
     Sinne, dass es genau eine gibt: pfSense aktualisiert als Ganzes, nicht
     paketweise wie OPNsense. Also 1 oder 0 — und keine erfundene Liste. */
  const steht = flagge === true || flagge === "true" || flagge === 1 || flagge === "1"
    || (neuer && out.version && String(neuer).replace(/^v/, "") !== out.version);
  out.updates = steht ? 1 : (flagge === undefined && !neuer ? null : 0);
  out.majorUpgrade = steht && neuer ? String(neuer).replace(/^v/, "") : null;
  return out;
}

/* ---------- Schnittstellen ----------
   Die Zähler stammen aus `get_interface_info` und heißen dort inbytes,
   outbytes, inpkts, outpkts, inerrs, outerrs, collisions. Das Paket
   reicht sie durch; ältere Fassungen schrieben sie in CamelCase. Beides
   wird genommen.

   Ein Unterschied zu OPNsense, der hier Arbeit spart: pfSense liefert den
   Verbindungszustand gleich mit — es braucht keinen zweiten Aufruf. */
function schnittstellen(out, host, d) {
  const liste = alsListe(d);
  if (!liste.length) {
    Object.assign(out, { interfaces: null, thrIn: null, thrOut: null, thrQuelle: null, ifNote: null });
    return;
  }

  const physisch = [];
  for (const [schluessel, w] of liste) {
    if (!w || typeof w !== "object") continue;
    /* Das Gerät (vtnet0, igb1) ist der stabile Name — die Beschriftung
       (WAN, LAN) kann umbenannt werden, und daran hängt die Zeitreihe. */
    const name = nimm(w, "hwif", "if", "device", "realif") || schluessel;
    if (!name || NICHT_PHYSISCH.test(String(name))) continue;
    const label = nimm(w, "descr", "description", "name") || schluessel || name;
    const fehler = (zahl(nimm(w, "inerrs", "inErrors", "in_errors")) || 0)
      + (zahl(nimm(w, "outerrs", "outErrors", "out_errors")) || 0);
    physisch.push({
      name: String(name),
      label: String(label),
      beschreibung: nimm(w, "descr", "description") || null,
      /* „up"/„down" — manche Fassungen schreiben stattdessen einen
         Wahrheitswert. Was sich nicht deuten lässt, bleibt unbekannt. */
      link: verbindung(nimm(w, "status", "linkstate", "link", "is_up")),
      mtu: zahl(nimm(w, "mtu")),
      rx: zahl(nimm(w, "inbytes", "inBytes", "in_bytes")),
      tx: zahl(nimm(w, "outbytes", "outBytes", "out_bytes")),
      rxPakete: zahl(nimm(w, "inpkts", "inPkts", "in_packets")),
      txPakete: zahl(nimm(w, "outpkts", "outPkts", "out_packets")),
      fehler,
      verworfen: zahl(nimm(w, "dropped", "indrops", "in_drops")) || 0,
      kollisionen: zahl(nimm(w, "collisions")) || 0
    });
  }
  Object.assign(out, ausZaehlern(zaehlerSchluessel(host), physisch));
}

function verbindung(v) {
  if (v === true) return "up";
  if (v === false) return "down";
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (/^(up|active|online)/.test(s)) return "up";
  if (/^(down|no carrier|inactive|offline)/.test(s)) return "down";
  return null;
}

/* ---------- Gateways ----------
   Das kann OPNsense hier noch nicht, und es ist die Angabe, die einen
   ausgefallenen Uplink am schnellsten verrät: „online" mit 0,4 % Verlust
   ist etwas anderes als „down".

   Verlust und Latenz kommen als Zeichenketten mit Einheit („1.2ms",
   "0.0%"), teils als „~" wenn nichts gemessen wurde. */
function gatewaysAus(d) {
  const liste = alsListe(d).filter(([schluessel, g]) => nimm(g, "name", "gwname") || schluessel);
  if (!liste.length) return null;
  return liste.map(([schluessel, g]) => ({
    name: String(nimm(g, "name", "gwname") || schluessel),
    status: String(nimm(g, "status", "state") || "unbekannt").toLowerCase(),
    substatus: nimm(g, "substatus") || null,
    monitor: nimm(g, "monitorip", "monitor_ip", "monitor") || null,
    quelle: nimm(g, "srcip", "source_ip") || null,
    rtt: messwert(nimm(g, "delay", "rtt")),
    stddev: messwert(nimm(g, "stddev")),
    verlust: messwert(nimm(g, "loss", "packet_loss"))
  }));
}

/* „1.2ms", „0.0%", „~" — die Zahl davor, sonst null. */
function messwert(v) {
  if (v == null) return null;
  const m = /-?\d+(\.\d+)?/.exec(String(v));
  return m ? Number(m[0]) : null;
}

/* ---------- Zustandstabelle ----------
   Läuft sie voll, bricht der Durchsatz ein, ohne dass eine Leitung
   ausfällt — von außen sieht das aus wie ein kaputtes Netz. */
function zustandstabelleAus(d) {
  if (!d || typeof d !== "object") return {};
  const jetzt = zahl(nimm(d, "current_states", "states", "current"));
  const max = zahl(nimm(d, "maximum_states", "max_states", "maximum", "default_maximum_states"));
  return {
    states: jetzt,
    statesMax: max,
    statesPct: jetzt != null && max > 0 ? Math.round((jetzt / max) * 100) : null
  };
}

/* ---------- CARP ---------- */
function carpAus(d) {
  if (!d || typeof d !== "object") return { carp: null, carpWartung: null };
  const an = nimm(d, "enable", "enabled", "carp_enabled");
  if (an === false || an === "false" || an === 0) return { carp: null, carpWartung: null };
  const wartung = nimm(d, "maintenance_mode", "maintenancemode");
  /* Die Rolle steht an den Schnittstellen, nicht am Verbund: MASTER, wenn
     eine es ist. Führt die Fassung sie nicht, bleibt es bei „aktiv". */
  const ifs = alsListe(nimm(d, "carp_interfaces", "interfaces", "carp"));
  const rollen = ifs.map(([, x]) => String(nimm(x, "status", "state", "carp_status") || "").toUpperCase())
    .filter(Boolean);
  return {
    carp: rollen.find(r => r === "MASTER") || rollen[0] || (an ? "aktiv" : null),
    carpWartung: wartung === true || wartung === "true" || wartung === 1
  };
}

/* ---------- WireGuard ----------
   Ob das Paket den Handshake überhaupt führt, hängt an seiner Fassung.
   Führt es ihn nicht, werden die Peers trotzdem gemeldet — aber ohne
   Handshake, und das wird ausdrücklich gesagt. Sonst sähe ein Peer, über
   den nichts bekannt ist, genauso aus wie einer, der sich nie gemeldet
   hat, und das ist ein Unterschied ums Ganze. */
function wireguard(out, r) {
  if (!r?.ok) {
    out.peers = null; out.wgPeers = null; out.wgIfaces = null; out.wgStill = null;
    if (r?.status && r.status !== 404) out.wgFehler = `WireGuard nicht lesbar (${r.status})`;
    return;
  }
  const p = peersAus(nutzlast(r.data));
  out.peers = p.peers;
  out.wgPeers = p.peers ? p.peers.length : null;
  out.wgIfaces = p.ifaces;
  out.wgStill = p.peers ? p.peers.filter(x => x.handshake == null || x.handshake > 600).length : null;
  out.wgHandshakeUnbekannt = p.handshakeUnbekannt;
  if (p.handshakeUnbekannt)
    out.wgNote = "Diese Fassung des API-Pakets meldet keinen Handshake — die Peers stehen da, ihr Alter nicht.";
}

function peersAus(d) {
  const liste = alsListe(d);
  if (!liste.length) return { peers: null, ifaces: null, handshakeUnbekannt: false };

  const ifaces = new Set();
  let irgendeinHandshake = false;
  const peers = liste.map(([schluessel, w]) => {
    const iface = nimm(w, "tun", "interface", "if", "wg_interface") || null;
    if (iface) ifaces.add(String(iface));
    /* Mal als Alter in Sekunden, mal als Zeitpunkt. Beides wird zu einem
       Alter — das ist die Zahl, die eine Aussage trägt. */
    const alter = zahl(nimm(w, "latest_handshake_age", "handshake_age", "latest-handshake-age"));
    const zeitpunkt = nimm(w, "latest_handshake", "last_handshake", "latest_handshake_epoch");
    const ausZeit = alter == null ? handshakeAlter(zeitpunkt) : null;
    if (alter != null || ausZeit != null) irgendeinHandshake = true;
    return {
      name: nimm(w, "name", "descr", "description")
        || String(nimm(w, "publickey", "public_key") || schluessel || "—").slice(0, 8),
      key: nimm(w, "publickey", "public_key", "pubkey") || null,
      iface: iface ? String(iface) : null,
      endpoint: endpunkt(w),
      allowed: alsText(nimm(w, "allowedips", "allowed_ips", "tunneladdress")),
      handshake: alter ?? ausZeit,
      seit: zeitpunkt ? String(zeitpunkt) : null,
      rx: zahl(nimm(w, "transferrx", "transfer_rx", "rx", "bytes_received")),
      tx: zahl(nimm(w, "transfertx", "transfer_tx", "tx", "bytes_sent")),
      keepalive: nimm(w, "persistentkeepalive", "persistent_keepalive", "keepalive") || null
    };
  });
  return { peers, ifaces: ifaces.size || null, handshakeUnbekannt: !irgendeinHandshake };
}

function endpunkt(w) {
  const e = nimm(w, "endpoint", "endpointaddress", "endpoint_address");
  if (!e) return null;
  const port = nimm(w, "endpointport", "endpoint_port");
  return port && !String(e).includes(":") ? `${e}:${port}` : String(e);
}

/* Ein Zeitpunkt wird zum Alter. Sekunden seit 1970 ebenso wie ein Datum;
   was sich nicht deuten lässt, ergibt null statt einer Zahl. */
function handshakeAlter(v) {
  if (v == null || v === "" || v === 0 || v === "0") return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e8) return Math.max(0, Math.round(Date.now() / 1000 - n));
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
}

/* ---------- Ampel ----------
   Nur Gemessenes färbt. Ein ausstehendes Update und eine CARP-Rolle sind
   Hinweise, keine Störungen — sie stehen als Notiz da, ohne die Ampel zu
   drehen. Dieselbe Zurückhaltung wie bei OPNsense. */
function ampel(out, grenze) {
  if (out.disk != null && out.disk >= grenze.disk_crit) {
    out.status = "crit"; out.note = `Platte zu ${out.disk} % belegt (kritisch ab ${grenze.disk_crit} %)`; return;
  }
  /* Ein Gateway, das down ist, ist ein ausgefallener Uplink — das ist die
     dringendste Aussage, die dieses Gerät zu machen hat. */
  const tot = (out.gateways || []).filter(g => /down|offline/.test(g.status));
  if (tot.length) {
    out.status = "crit";
    out.note = `Gateway ${tot.map(g => g.name).join(", ")} ist ausgefallen`;
    return;
  }
  if (out.ram != null && out.ram >= grenze.ram_warn) {
    out.status = out.ram >= grenze.ram_crit ? "crit" : "warn";
    out.note = `Arbeitsspeicher ${out.ram} % belegt`;
    return;
  }
  if (out.disk != null && out.disk >= grenze.disk_warn) {
    out.status = "warn"; out.note = `Platte zu ${out.disk} % belegt`; return;
  }
  /* Läuft die Zustandstabelle voll, bricht der Durchsatz ein, ohne dass
     eine Leitung ausfällt. Von außen sieht das aus wie ein kaputtes Netz —
     und es steht nirgends sonst. */
  if (out.statesPct != null && out.statesPct >= 90) {
    out.status = "crit"; out.note = `Zustandstabelle zu ${out.statesPct} % belegt (${out.states} von ${out.statesMax})`; return;
  }
  if (out.statesPct != null && out.statesPct >= 80) {
    out.status = "warn"; out.note = `Zustandstabelle zu ${out.statesPct} % belegt`; return;
  }
  const schwach = (out.gateways || []).filter(g => /loss|delay|warn/.test(g.status) || (g.verlust ?? 0) >= 2);
  if (schwach.length) {
    out.status = "warn";
    out.note = schwach.map(g => `${g.name}: ${g.status}${g.verlust != null ? `, ${g.verlust} % Verlust` : ""}`).join(" · ");
    return;
  }
  if (out.wgFehler) { out.status = "warn"; out.note = out.wgFehler; return; }

  const hinweise = [];
  if (out.updates) hinweise.push(out.majorUpgrade ? `Fassung ${out.majorUpgrade} steht bereit` : "Aktualisierung steht bereit");
  if (out.carp) hinweise.push(`CARP ${out.carp}${out.carpWartung ? ", Wartungsmodus" : ""}`);
  if (out.ifNote) hinweise.push(out.ifNote);
  if (out.wgNote) hinweise.push(out.wgNote);
  if (hinweise.length) out.note = hinweise.join(" · ");
}

/* ---------- Kleinkram ----------
   Antworten kommen mal als Liste, mal als Abbildung nach Kennung. Beides
   wird zu Paaren [kennung, wert], damit der Rest nicht zweimal
   geschrieben werden muss. */
export function alsListe(d) {
  /* Bei einer Liste ist die Kennung das, was der Eintrag selbst mitbringt —
     **nicht** seine Position. Der Index wäre ein erfundener Name, und an
     Gerätenamen hängen hier Zeitreihen: aus einer Antwort, die der Sammler
     nicht deuten kann, entstünde sonst eine Reihe namens „fw-02|0", die
     morgen ein anderes Gerät meint. Lieber kein Name als der falsche. */
  if (Array.isArray(d)) return d.map(x => [x?.name ?? x?.if ?? null, x]);
  if (d && typeof d === "object") return Object.entries(d).filter(([, v]) => v && typeof v === "object");
  return [];
}

function nimm(o, ...namen) {
  if (!o || typeof o !== "object") return undefined;
  for (const n of namen) if (o[n] !== undefined && o[n] !== null && o[n] !== "") return o[n];
  return undefined;
}

function alsText(v) {
  if (v == null) return null;
  return Array.isArray(v) ? v.join(", ") : String(v);
}

/* Belegung als Prozent — aus „43%", 43 oder 0.43. Ein Bruchteil unter 1
   wird als Anteil gelesen; alles darüber als Prozent. Ein Gerät mit
   0,5 % Belegung wird dabei als halb voll gelesen — das ist der Preis,
   und er ist der kleinere: eine Firewall unter 1 % Plattenbelegung gibt
   es nicht, eine mit 43 % ständig. */
function prozent(v) {
  if (v == null) return null;
  const n = Number(String(v).replace("%", "").trim());
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  if (n > 100) return null;
  return n <= 1 && n > 0 ? Math.round(n * 100) : Math.round(n);
}

/* „3 days, 20:56:43" ebenso wie „20:56:43" — wie bei OPNsense. */
function sekunden(text) {
  if (!text) return null;
  const m = /^(?:(\d+)\s*(?:days?|Tage?|T)[,\s]+)?(\d+):(\d{2})(?::(\d{2}))?/.exec(String(text).trim());
  if (!m) return null;
  return (+(m[1] || 0)) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60 + (+(m[4] || 0));
}

function dauer(s) {
  const t = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), min = Math.floor((s % 3600) / 60);
  if (t) return `${t} T ${h} h`;
  if (h) return `${h} h ${min} min`;
  return `${min} min`;
}
