/* OPNsense — Zugang, Verbindungstest und die Pfade, die der Sammler
   brauchen wird.

   Anders als Proxmox: die Anmeldung läuft über HTTP Basic, der API-Key
   steht als Benutzer, das Secret als Passwort. So dokumentiert es OPNsense
   selbst (`curl -k -u "$key":"$secret" .../api/core/firmware/status`).

   Ein Vorbehalt, der hier festgehalten gehört: die OPNsense-Dokumentation
   listet die Endpunkte, aber keine Antwortschemata — welche Felder
   zurückkommen, steht nirgends. Zudem wurden die Diagnose-Pfade zwischen
   den Fassungen umbenannt (früher systemInformation, heute
   system_information). Deshalb kennt jeder Eintrag hier mögliche
   Schreibweisen, und die Diagnose probiert sie der Reihe nach durch und
   berichtet, welche geantwortet hat. Erst danach wird der Sammler gegen
   die tatsächlichen Felder gebaut — nicht gegen Vermutungen. */

import { requestJson } from "../http.js";
import { schwellenFuer } from "../inventory.js";
import { ausZaehlern, NICHT_PHYSISCH, zahl, messwert, gatewayAmpel } from "./firewall.js";

export function authHeader(cred) {
  if (!cred) return null;
  const key = cred.key || cred.apiKey || cred.user;
  const secret = cred.secret || cred.password;
  if (!key || !secret) return null;
  return { Authorization: "Basic " + Buffer.from(`${key}:${secret}`).toString("base64") };
}

export function baseUrl(host) {
  if (host.url) {
    try {
      const u = new URL(host.url);
      return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`;
    } catch {}
  }
  return `https://${host.ip}`;
}

/* Was der Sammler später lesen soll — in der Reihenfolge der Wichtigkeit.
   `alternativen` fängt die Umbenennungen zwischen den OPNsense-Fassungen. */
export const PFADE = [
  { pfad: "/api/core/firmware/status", zweck: "Fassung und offene Aktualisierungen" },
  { pfad: "/api/core/firmware/info", zweck: "Fassung, auch wenn nichts ansteht", optional: true },
  {
    pfad: "/api/diagnostics/system/system_information",
    alternativen: ["/api/diagnostics/system/systemInformation"],
    zweck: "Name, Fassung, Laufzeit"
  },
  {
    pfad: "/api/diagnostics/system/system_resources",
    alternativen: ["/api/diagnostics/system/systemResources"],
    zweck: "Arbeitsspeicher und Last"
  },
  {
    pfad: "/api/diagnostics/system/system_time",
    alternativen: ["/api/diagnostics/system/systemTime"],
    zweck: "Laufzeit und Last — in system_information stehen sie nicht",
    optional: true
  },
  {
    pfad: "/api/diagnostics/system/system_disk",
    alternativen: ["/api/diagnostics/system/systemDisk"],
    zweck: "Plattenbelegung",
    optional: true
  },
  {
    pfad: "/api/diagnostics/interface/get_interface_statistics",
    alternativen: ["/api/diagnostics/interface/getInterfaceStatistics"],
    zweck: "Zähler je Schnittstelle — daraus Durchsatz, Pakete, Fehler und Verwürfe",
    optional: true
  },
  {
    pfad: "/api/interfaces/overview/export",
    zweck: "Schnittstellen: Beschreibung, Verbindungszustand, MTU — die Zähler sagen nichts über einen toten Link",
    optional: true,
    fehlendOk: "Diese Fassung kennt den Endpunkt nicht — dann fehlen Beschreibung und Verbindungszustand, "
      + "die Zähler und der Durchsatz kommen trotzdem"
  },
  {
    pfad: "/api/routes/gateway/status",
    zweck: "Gateways: Zustand, Latenz, Verlust — was die Firewall über die Leitung dahinter weiß",
    optional: true,
    fehlendOk: "Diese Fassung kennt den Endpunkt nicht — dann bleibt der Gateway-Zustand unbekannt"
  },
  {
    pfad: "/api/diagnostics/firewall/pf_statistics/state",
    alternativen: ["/api/diagnostics/firewall/pf_statistics", "/api/diagnostics/firewall/pfStatistics"],
    zweck: "Zustandstabelle: belegt von wie vielen",
    optional: true,
    fehlendOk: "Diese Fassung führt die Zustandstabelle unter einem anderen Pfad — die Feldnamen unten helfen weiter"
  },
  {
    pfad: "/api/diagnostics/interface/get_vip_status",
    alternativen: ["/api/diagnostics/interface/getVipStatus"],
    zweck: "CARP: Rolle je virtueller Adresse",
    optional: true,
    fehlendOk: "CARP ist auf diesem Gerät nicht eingerichtet"
  },
  {
    pfad: "/api/wireguard/service/show",
    zweck: "WireGuard: Peers, letzter Handshake, übertragene Menge",
    optional: true,
    fehlendOk: "WireGuard ist auf diesem Gerät nicht eingerichtet oder das Plugin fehlt"
  }
];

export async function api(host, cred, pfad, timeout = 8000) {
  const headers = authHeader(cred);
  if (!headers) return { ok: false, error: "Kein API-Key hinterlegt" };
  return requestJson(`${baseUrl(host)}${pfad}`, { headers, timeout });
}

/* Verbindungstest für die Verwaltung: erreichbar, angemeldet — und was
   der Schlüssel tatsächlich lesen darf. Nur /api/core/firmware/status zu
   fragen, wäre dieselbe Falle wie bei Proxmox' /version. */
export async function testConnection(host, cred) {
  const fw = await api(host, cred, "/api/core/firmware/status", 6000);
  if (!fw.ok) return { ok: false, detail: fw.error, hint: hintFor(fw) };

  const d = fw.data || {};
  let fassung = d.product_version || d.product?.product_version || null;
  const teile = [`Verbunden — OPNsense${fassung ? " " + fassung : ""}`];

  /* Der Diagnose-Zweig hängt an anderen Rechten als der Firmware-Zweig. */
  const sys = await ersterTreffer(host, cred,
    ["/api/diagnostics/system/system_information", "/api/diagnostics/system/systemInformation"]);
  if (!sys.ok) {
    return {
      ok: false,
      detail: teile[0] + ` — aber die Systemauskunft ist nicht lesbar: ${sys.error}`,
      hint: "Dem Schlüssel fehlen Rechte für den Diagnose-Zweig. In OPNsense unter "
        + "System → Access → Users die Gruppe des Benutzers prüfen; für reines Ablesen genügt "
        + "eine Gruppe mit den Diagnostics-Rechten.",
      version: fassung
    };
  }
  teile.push("Systemauskunft lesbar");
  /* Steht auf einem gepflegten Gerät keine Fassung in der Firmware-
     Auskunft, steht sie hier — in der Liste, die auch die Oberfläche zeigt. */
  if (!fassung) {
    fassung = ausVersionsliste(sys.data, /^OPNsense/);
    if (fassung) teile[0] = `Verbunden — OPNsense ${fassung}`;
  }

  const wg = await api(host, cred, "/api/wireguard/service/show", 6000);
  teile.push(wg.ok ? "WireGuard lesbar" : "WireGuard nicht lesbar (Plugin fehlt oder keine Rechte)");

  return { ok: true, detail: teile.join(" · "), version: fassung, ms: fw.ms };
}

export async function ersterTreffer(host, cred, pfade) {
  let letzte = null;
  for (const p of pfade) {
    const r = await api(host, cred, p, 6000);
    if (r.ok) return { ...r, pfad: p };
    letzte = { ...r, pfad: p };
    /* Nur bei „gibt es nicht" die nächste Schreibweise probieren — bei 401
       oder 403 hilft ein anderer Pfad nicht, das ist eine Rechtefrage. */
    if (r.status !== 404) break;
  }
  return letzte;
}

function hintFor(r) {
  if (r.status === 401) return "Schlüssel oder Secret stimmen nicht. In OPNsense unter System → Access → Users "
    + "beim Benutzer einen API-Schlüssel erzeugen — die heruntergeladene Datei enthält beide Werte.";
  if (r.status === 403) return "Angemeldet, aber ohne Rechte: die Gruppe des Benutzers braucht Leserechte "
    + "auf den entsprechenden Zweig.";
  if (r.status === 404) return "Erreicht, aber kein OPNsense-Endpunkt — Adresse und Port prüfen.";
  return null;
}

/* ============================================================
   Sammler

   Gebaut gegen die Felder einer echten OPNsense 26.1 — abgelesen aus
   einem Diagnosebericht, nicht aus der Dokumentation, die keine
   Antwortschemata nennt. Wo die Gestalt zwischen Fassungen schwanken
   kann, wird nachsichtig gelesen und im Zweifel null gemeldet.

   Auffälligkeiten, die hier Arbeit machen:
   - memory.total kommt als Zeichenkette, memory.used als Zahl.
   - Die WireGuard-Felder tragen Bindestriche, nicht Unterstriche, und
     nur die Peer-Zeilen führen einen Handshake — die Zeile je
     Schnittstelle hat dort null stehen.
   - Die Schnittstellenstatistik ist nach Klartextnamen verschlüsselt
     („[LAN] (vtnet0) / bc:24:…"); die echten Zähler stehen in den
     Zeilen mit network „<Link#N>", die IP-Zeilen sind Teilmengen.
   ============================================================ */

/* Aus den Zählerständen wird der Durchsatz gerechnet — dieselbe Rechnung
   wie bei pfSense und deshalb in firewall.js, nicht hier. */
const zaehlerSchluessel = host => host.id + "@" + baseUrl(host);

export async function collectOpnsense(host, cred, settings) {
  const grenze = schwellenFuer(host, settings);
  const [fw, info, sys, res, disk, ifs, uebersicht, wg, zeit, gws, states, vips] = await Promise.all([
    api(host, cred, "/api/core/firmware/status"),
    api(host, cred, "/api/core/firmware/info"),
    ersterTreffer(host, cred, ["/api/diagnostics/system/system_information", "/api/diagnostics/system/systemInformation"]),
    ersterTreffer(host, cred, ["/api/diagnostics/system/system_resources", "/api/diagnostics/system/systemResources"]),
    ersterTreffer(host, cred, ["/api/diagnostics/system/system_disk", "/api/diagnostics/system/systemDisk"]),
    ersterTreffer(host, cred, ["/api/diagnostics/interface/get_interface_statistics", "/api/diagnostics/interface/getInterfaceStatistics"]),
    api(host, cred, "/api/interfaces/overview/export"),
    api(host, cred, "/api/wireguard/service/show"),
    ersterTreffer(host, cred, ["/api/diagnostics/system/system_time", "/api/diagnostics/system/systemTime"]),
    api(host, cred, "/api/routes/gateway/status"),
    ersterTreffer(host, cred, ["/api/diagnostics/firewall/pf_statistics/state",
      "/api/diagnostics/firewall/pf_statistics", "/api/diagnostics/firewall/pfStatistics"]),
    ersterTreffer(host, cred, ["/api/diagnostics/interface/get_vip_status", "/api/diagnostics/interface/getVipStatus"])
  ]);

  /* Die Firmware-Auskunft ist der Anker: kommt die nicht, stimmt am
     Zugang etwas nicht, und alles Weitere wäre Rauschen. */
  if (!fw.ok) return { error: fw.error, note: fw.error, status: (fw.status === 401 || fw.status === 403) ? "warn" : undefined };

  const out = {};
  fassung(out, fw.data || {}, info.ok ? info.data : null, sys.ok ? sys.data : null);
  speicher(out, res.ok ? res.data : null);
  platte(out, disk.ok ? disk.data : null);
  laufzeit(out, sys.ok ? sys.data : null, zeit.ok ? zeit.data : null);
  schnittstellen(out, host, ifs.ok ? ifs.data : null, uebersicht.ok ? uebersicht.data : null);
  wireguard(out, wg.ok ? wg.data : null, wg.status);
  gateways(out, gws);
  zustandstabelle(out, states);
  carp(out, vips);

  out.schwellen = grenze;
  ampel(out, grenze);
  return out;
}

/* ---------- Fassung und Aktualisierungen ----------

   Die Fassung steht an drei Stellen, und keine trägt sie zuverlässig:

   `/api/core/firmware/status` nennt `product_version` nur, wenn zur
   Antwort auch etwas über Aktualisierungen zu sagen ist. Auf einem
   Gerät, das gerade auf dem letzten Stand ist, fehlt das Feld schlicht —
   und dann stand in der Übersicht bei den gepflegten Geräten ein Strich
   und bei den vernachlässigten eine Zahl. Genau verkehrt herum.

   `/api/core/firmware/info` trägt sie immer, aber je nach Fassung flach
   oder unter `product`. `/api/diagnostics/system/system_information`
   schließlich führt sie als Zeile in einer Liste („OPNsense 24.7.5_1-
   amd64"). Gefragt wird der Reihe nach; die erste Antwort gilt. */
function fassung(out, d, info, sys) {
  const p = info?.product || {};
  out.version = d.product_version || p.product_version || info?.product_version || ausVersionsliste(sys, /^OPNsense/) || null;
  out.abi = d.product_abi || p.product_abi || info?.product_abi || null;
  out.os = d.os_version || ausVersionsliste(sys, /^FreeBSD/) || null;
  /* Alles Boolesche kommt hier als "0"/"1". */
  out.needsReboot = d.needs_reboot === "1" || d.needs_reboot === 1;
  out.lastCheck = d.last_check || null;

  const listen = ["new_packages", "upgrade_packages", "reinstall_packages"];
  const offen = listen.reduce((a, k) => a + (Array.isArray(d[k]) ? d[k].length : 0), 0);
  out.updates = offen;
  /* Ein Sprung auf eine neue Hauptfassung ist etwas anderes als ein paar
     Paketaktualisierungen — und wird deshalb getrennt geführt. */
  out.majorUpgrade = d.upgrade_major_version || null;
  out.upgradeSets = Array.isArray(d.upgrade_sets) ? d.upgrade_sets.length : null;
}

/* Aus „OPNsense 24.7.5_1-amd64" wird „24.7.5_1-amd64", aus
   „FreeBSD 14.1-RELEASE-p3" der Rest dahinter. Steht dort nur ein Wort,
   gibt es nichts abzuschneiden — dann ist das Wort die Auskunft. */
function ausVersionsliste(sys, muster) {
  const liste = Array.isArray(sys?.versions) ? sys.versions : null;
  if (!liste) return null;
  const zeile = liste.map(String).find(z => muster.test(z.trim()));
  if (!zeile) return null;
  const rest = zeile.trim().replace(/^\S+\s+/, "").trim();
  return rest || zeile.trim();
}

/* ---------- Arbeitsspeicher ---------- */
function speicher(out, d) {
  const m = d?.memory;
  if (!m) { out.ram = null; return; }
  const total = zahl(m.total), used = zahl(m.used);
  out.ram = total > 0 && used != null ? Math.round((used / total) * 100) : null;
  out.ramTotalMb = total > 0 ? Math.round(total / 1048576) : null;
  /* Der ZFS-Cache zählt als belegt, ist aber jederzeit abzugeben. Ohne
     diesen Zusatz sieht eine gesunde Firewall knapp am Anschlag aus. */
  const arc = zahl(m.arc);
  out.ramArcMb = arc > 0 ? Math.round(arc / 1048576) : null;
}

/* ---------- Platte ---------- */
function platte(out, d) {
  const devices = Array.isArray(d?.devices) ? d.devices : null;
  if (!devices?.length) { out.disk = null; out.disks = null; return; }
  /* Bei ZFS teilen sich viele Datensätze denselben Vorrat — der Wert für
     „/" ist der aussagekräftige, alles andere wäre dieselbe Zahl mehrfach. */
  const wurzel = devices.find(x => x.mountpoint === "/") || devices[0];
  out.disk = zahl(wurzel.used_pct) ?? null;
  out.disks = devices
    .filter(x => x.mountpoint && zahl(x.used_pct) != null)
    .slice(0, 12)
    .map(x => ({ name: x.mountpoint, used: zahl(x.used_pct), device: x.device || null }));
}

/* ---------- Laufzeit und Last ----------
   In system_information steht beides nicht — das war eine Vermutung, die
   sich am Gerät nicht bestätigt hat. system_time liefert es:

     uptime:  "3 days, 20:56:43"      loadavg: "0.68, 0.41, 0.35"

   Die Laufzeit kommt englisch und wird übersetzt; passt das Muster nicht,
   bleibt der Text stehen, wie er kam. Erfunden wird nichts.

   Die Last bleibt eine Anzeige ohne Ampel: ohne die Zahl der Kerne sagt
   0,68 nichts darüber, ob das Gerät kämpft oder sich langweilt. */
function laufzeit(out, sys, zeit) {
  out.name = sys?.name || null;
  const roh = zeit?.uptime ?? zeit?.uptime_frmt ?? null;
  out.uptimeText = roh == null ? null : String(roh);
  out.uptimeSeconds = sekunden(out.uptimeText);
  out.uptime = out.uptimeSeconds != null ? dauer(out.uptimeSeconds) : out.uptimeText;
  out.boot = zeit?.boottime || null;

  const last = zeit?.loadavg ?? sys?.loadavg ?? null;
  out.load = last == null ? null : String(last).trim() || null;
  const erste = out.load ? Number(String(out.load).split(/[,\s]+/)[0]) : NaN;
  out.load1 = Number.isFinite(erste) ? erste : null;
}

/* „3 days, 20:56:43" ebenso wie „1 day, 4:05" oder „20:56:43". */
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

/* ---------- Schnittstellen ----------

   Was OPNsense hier liefert, sind **Zählerstände** — Bytes und Pakete seit
   dem letzten Neustart, wie `netstat -ib`. Eine Bandbreite steht nirgends
   und lässt sich nur aus der Differenz zweier Abfragen errechnen. Daraus
   folgen zwei Dinge, die hier Arbeit machen:

   - Vor dem zweiten Durchlauf gibt es keinen Durchsatz. Dort steht dann
     ein Strich, keine Null — eine Null läse sich wie „nichts los".
   - Läuft der Zähler zurück, hat das Gerät neu gestartet (oder es
     antwortet ein anderes). Aus so einer Differenz einen Durchsatz zu
     rechnen ergäbe eine große Zufallszahl, also gibt es auch dann nichts.

   Ebenfalls aus den Zählern: Fehler, Verwürfe und Kollisionen. Die sind
   kumulativ und über Monate gewachsen — interessant ist, was **seit dem
   letzten Durchlauf** dazugekommen ist. Beides wird geführt: der Stand
   und der Zuwachs.

   Was die Zähler dagegen nicht sagen: ob die Leitung überhaupt steht. Eine
   Schnittstelle mit totem Link zählt einfach nicht weiter, und das sieht
   aus wie Ruhe. Deshalb wird — wenn die Fassung den Endpunkt kennt — die
   Schnittstellenübersicht dazugelesen. Fehlt sie, bleiben Zustand und
   Beschreibung null; die Zähler kommen trotzdem. */
function schnittstellen(out, host, d, uebersichtRoh) {
  const stat = d?.statistics;
  if (!stat || typeof stat !== "object") {
    out.thrIn = null; out.thrOut = null; out.interfaces = null; return;
  }

  const physisch = [];
  for (const [schluessel, w] of Object.entries(stat)) {
    /* Nur die Zeilen auf Verbindungsebene tragen die Gesamtzähler; die
       Zeilen je IP-Netz sind Teilmengen davon. */
    if (!w || !String(w.network || "").startsWith("<Link#")) continue;
    const name = w.name || schluessel;
    if (NICHT_PHYSISCH.test(name)) continue;
    const label = (String(schluessel).match(/^\[([^\]]+)\]/) || [, name])[1];
    physisch.push({
      name, label,
      rx: zahl(w["received-bytes"]), tx: zahl(w["sent-bytes"]),
      rxPakete: zahl(w["received-packets"]), txPakete: zahl(w["sent-packets"]),
      fehler: (zahl(w["received-errors"]) || 0) + (zahl(w["send-errors"]) || 0),
      verworfen: zahl(w["dropped-packets"]) || 0,
      kollisionen: zahl(w["collisions"]) || 0
    });
  }

  /* Rechnen tut firewall.js — für pfSense gilt dieselbe Rechnung, und
     zweimal wäre sie zweimal falsch. */
  Object.assign(out, ausZaehlern(zaehlerSchluessel(host), physisch, schnittstellenUebersicht(uebersichtRoh)));
}

/* Die Schnittstellenübersicht ist zwischen den Fassungen unterschiedlich
   verpackt — mal eine Liste, mal `rows`, mal eine Abbildung nach Kennung.
   Gelesen wird deshalb nachsichtig, und jedes Feld darf fehlen. Was nicht
   kommt, bleibt null; erfunden wird nichts. */
export function schnittstellenUebersicht(d) {
  const map = new Map();
  const liste = Array.isArray(d) ? d
    : Array.isArray(d?.rows) ? d.rows
    : (d && typeof d === "object") ? Object.values(d) : null;
  if (!Array.isArray(liste)) return map;
  for (const e of liste) {
    if (!e || typeof e !== "object") continue;
    const geraet = e.device || e.if || e.name;
    if (!geraet) continue;
    const zustand = e.status ?? e.link ?? null;
    map.set(String(geraet), {
      link: zustand == null ? null : String(zustand).toLowerCase(),
      beschreibung: e.description || e.descr || null,
      mtu: zahl(e.mtu)
    });
  }
  return map;
}

/* ---------- WireGuard ---------- */
function wireguard(out, d, status) {
  const rows = Array.isArray(d?.rows) ? d.rows : null;
  if (!rows) {
    out.wgPeers = null;
    out.peers = null;
    /* 404 heißt: Plugin nicht eingerichtet. Das ist kein Fehler. */
    if (status && status !== 404) out.wgFehler = `WireGuard nicht lesbar (${status})`;
    return;
  }

  const peers = rows.filter(r => r.type === "peer");
  out.wgIfaces = rows.filter(r => r.type === "interface").length;
  out.wgPeers = peers.length;
  out.peers = peers.map(p => {
    const alter = zahl(p["latest-handshake-age"]);
    return {
      name: p.name || p["public-key"]?.slice(0, 8) || "—",
      /* Der öffentliche Schlüssel ist die einzige Kennung, die eine
         Umbenennung auf der Firewall übersteht — daran hängt später die
         Verknüpfung mit einem Tunnel. Er ist kein Geheimnis: das ganze
         Verfahren beruht darauf, dass er weitergegeben wird. */
      key: p["public-key"] || null,
      iface: p.if || null,
      endpoint: p.endpoint || null,
      allowed: p["allowed-ips"] || null,
      handshake: alter,                           /* Sekunden, null = nie */
      seit: p["latest-handshake-epoch"] || null,
      rx: zahl(p["transfer-rx"]),
      tx: zahl(p["transfer-tx"]),
      keepalive: p["persistent-keepalive"] || null
    };
  });
  out.wgStill = out.peers.filter(p => p.handshake == null || p.handshake > 600).length;
}

/* ---------- Gateways ----------
   `/api/routes/gateway/status` ist die Auskunft, die man von außen nie
   bekommt: die Firewall misst gegen ihre Monitor-Adresse und weiß damit
   etwas über die Leitung *hinter* sich. Ein Uplink kann tot sein, während
   die Firewall selbst tadellos antwortet.

   Eine Eigenheit, die hier zählt: OPNsense schreibt `none`, wenn ein
   Gateway steht und nicht überwacht wird. Das ist kein Fehlen einer
   Auskunft, sondern die Auskunft „nichts zu beanstanden" — als unbekannt
   gelesen stünde die halbe Tabelle grau da. */
function gateways(out, r) {
  if (!r?.ok) {
    out.gateways = null;
    if (r?.status && r.status !== 404) out.gwFehler = `Gateway-Zustand nicht lesbar (${r.status})`;
    return;
  }
  const rows = Array.isArray(r.data?.items) ? r.data.items
    : Array.isArray(r.data?.rows) ? r.data.rows
    : Array.isArray(r.data) ? r.data : null;
  if (!rows) { out.gateways = null; return; }

  out.gateways = rows.map(g => ({
    name: g.name || g.gateway || "—",
    /* `status_translated` ist der Text für Menschen („Online"), `status`
       das Kürzel für die Bewertung. Bewertet wird das Kürzel. */
    status: String(g.status ?? "").toLowerCase() || "unbekannt",
    substatus: g.status_translated || null,
    monitor: g.monitor || g.address || null,
    quelle: g.address || null,
    rtt: messwert(g.delay),
    stddev: messwert(g.stddev),
    verlust: messwert(g.loss)
  }));
}

/* ---------- Zustandstabelle ----------
   Läuft sie voll, bricht der Durchsatz ein, ohne dass eine Leitung
   ausfällt — von außen sieht das aus wie ein kaputtes Netz, und es steht
   nirgends sonst.

   Die Gestalt schwankt zwischen den Fassungen: mal liegt die Zahl flach
   im Antwortobjekt, mal in einem Unterobjekt. Gesucht wird deshalb nach
   Namen, egal wie tief — und was sich nicht finden lässt, bleibt null. */
function zustandstabelle(out, r) {
  if (!r?.ok) { out.states = null; out.statesMax = null; out.statesPct = null; return; }
  const jetzt = suche(r.data, ["current_entries", "current entries", "current", "entries", "states"]);
  const max = suche(r.data, ["limit", "max_entries", "maximum", "state_limit", "states_limit"]);
  out.states = jetzt;
  out.statesMax = max;
  out.statesPct = jetzt != null && max > 0 ? Math.round((jetzt / max) * 100) : null;
}

/* Einen Zahlenwert unter einem von mehreren Namen finden, gleich wie tief
   er liegt. Drei Ebenen genügen — was tiefer steckt, ist keine Kennzahl
   mehr, sondern eine Zufälligkeit der Verpackung. */
function suche(d, namen, tiefe = 0) {
  if (!d || typeof d !== "object" || tiefe > 3) return null;
  for (const n of namen) {
    const v = zahl(d[n]);
    if (v != null) return v;
  }
  for (const v of Object.values(d)) {
    if (v && typeof v === "object") {
      const treffer = suche(v, namen, tiefe + 1);
      if (treffer != null) return treffer;
    }
  }
  return null;
}

/* ---------- CARP ----------
   Gelesen wird der Zustand der virtuellen Adressen. MASTER sticht: läuft
   auch nur eine Adresse als MASTER, trägt dieses Gerät gerade. */
function carp(out, r) {
  if (!r?.ok) { out.carp = null; out.carpWartung = null; return; }
  const rows = Array.isArray(r.data?.rows) ? r.data.rows
    : Array.isArray(r.data) ? r.data : null;
  if (!rows?.length) { out.carp = null; out.carpWartung = null; return; }

  const carpZeilen = rows.filter(x => String(x.mode || "carp").toLowerCase().includes("carp"));
  if (!carpZeilen.length) { out.carp = null; out.carpWartung = null; return; }
  const rollen = carpZeilen.map(x => String(x.status || x.status_txt || "").toUpperCase()).filter(Boolean);
  out.carp = rollen.find(x => x === "MASTER") || rollen[0] || null;
  /* Im Wartungsmodus meldet OPNsense die Adressen als „DISABLED“ oder
     „MAINTENANCE“ — beides heißt: dieses Gerät trägt absichtlich nicht. */
  out.carpWartung = rollen.some(x => /MAINT|DISABLED/.test(x));
}

/* ---------- Ampel ----------
   Nur was wirklich gemessen wurde, darf die Farbe bestimmen. Ein
   ausstehender Neustart oder eine neue Hauptfassung sind Hinweise, keine
   Störungen — sie stehen als Notiz da, ohne die Ampel zu drehen. */
function ampel(out, grenze) {
  if (out.disk != null && out.disk >= grenze.disk_crit) { out.status = "crit"; out.note = `Platte zu ${out.disk} % belegt (kritisch ab ${grenze.disk_crit} %)`; return; }

  /* Ein ausgefallenes Gateway ist die dringendste Aussage, die dieses
     Gerät zu machen hat — und die einzige, die von außen niemand sieht:
     die Firewall selbst antwortet dabei tadellos. Dieselbe Bewertung wie
     bei pfSense, sie steht in firewall.js. */
  const tot = (out.gateways || []).filter(g => gatewayAmpel(g) === "crit");
  if (tot.length) {
    out.status = "crit";
    out.note = `Gateway ${tot.map(g => g.name).join(", ")} ist ausgefallen`;
    return;
  }
  if (out.ram != null && out.ram >= grenze.ram_warn) {
    /* Der ZFS-Cache zählt in dieser Zahl als belegt, ist aber jederzeit
       abzugeben — deshalb steht er dabei, statt die Ampel allein zu drehen. */
    out.status = out.ram >= grenze.ram_crit ? "crit" : "warn";
    out.note = `Arbeitsspeicher ${out.ram} % belegt` + (out.ramArcMb ? ` (davon ${out.ramArcMb} MB ZFS-Cache)` : "");
    return;
  }
  if (out.disk != null && out.disk >= grenze.disk_warn) { out.status = "warn"; out.note = `Platte zu ${out.disk} % belegt`; return; }

  /* Läuft die Zustandstabelle voll, bricht der Durchsatz ein, ohne dass
     eine Leitung ausfällt. Von außen sieht das aus wie ein kaputtes Netz. */
  if (out.statesPct != null && out.statesPct >= 90) {
    out.status = "crit"; out.note = `Zustandstabelle zu ${out.statesPct} % belegt (${out.states} von ${out.statesMax})`; return;
  }
  if (out.statesPct != null && out.statesPct >= 80) {
    out.status = "warn"; out.note = `Zustandstabelle zu ${out.statesPct} % belegt`; return;
  }

  const schwach = (out.gateways || []).filter(g => gatewayAmpel(g) === "warn");
  if (schwach.length) {
    out.status = "warn";
    out.note = schwach.map(g => `${g.name}: ${g.status}${g.verlust != null ? `, ${g.verlust} % Verlust` : ""}`).join(" · ");
    return;
  }
  if (out.wgFehler) { out.status = "warn"; out.note = out.wgFehler; return; }
  if (out.gwFehler) { out.status = "warn"; out.note = out.gwFehler; return; }

  const hinweise = [];
  if (out.needsReboot) hinweise.push("Neustart steht aus");
  if (out.updates) hinweise.push(`${out.updates} Aktualisierung(en)`);
  if (out.majorUpgrade) hinweise.push(`Fassung ${out.majorUpgrade} verfügbar`);
  /* Eine CARP-Rolle ist ein Zustand, keine Störung — außer sie steht auf
     Wartung, und dann will man wissen, dass sie es noch tut. */
  if (out.carp) hinweise.push(`CARP ${out.carp}${out.carpWartung ? ", Wartungsmodus" : ""}`);
  if (out.ifNote) hinweise.push(out.ifNote);
  if (hinweise.length) out.note = hinweise.join(" · ");
}

