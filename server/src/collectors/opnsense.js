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
  const fassung = d.product_version || d.product?.product_version || d.os_version || null;
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

/* Zähler sind kumulativ. Durchsatz gibt es deshalb erst ab dem zweiten
   Durchlauf — davor steht ein Strich, keine Null.

   Der Schlüssel enthält die Adresse, nicht nur die Kennung: zeigt ein
   System plötzlich woandershin, antwortet ein anderes Gerät mit ganz
   anderen Zählerständen. Die Differenz dazwischen wäre kein Durchsatz,
   sondern eine Zufallszahl. */
const zaehlerstand = new Map();
const zaehlerSchluessel = host => host.id + "@" + baseUrl(host);

export async function collectOpnsense(host, cred, settings) {
  const grenze = schwellenFuer(host, settings);
  const [fw, sys, res, disk, ifs, uebersicht, wg, zeit] = await Promise.all([
    api(host, cred, "/api/core/firmware/status"),
    ersterTreffer(host, cred, ["/api/diagnostics/system/system_information", "/api/diagnostics/system/systemInformation"]),
    ersterTreffer(host, cred, ["/api/diagnostics/system/system_resources", "/api/diagnostics/system/systemResources"]),
    ersterTreffer(host, cred, ["/api/diagnostics/system/system_disk", "/api/diagnostics/system/systemDisk"]),
    ersterTreffer(host, cred, ["/api/diagnostics/interface/get_interface_statistics", "/api/diagnostics/interface/getInterfaceStatistics"]),
    api(host, cred, "/api/interfaces/overview/export"),
    api(host, cred, "/api/wireguard/service/show"),
    ersterTreffer(host, cred, ["/api/diagnostics/system/system_time", "/api/diagnostics/system/systemTime"])
  ]);

  /* Die Firmware-Auskunft ist der Anker: kommt die nicht, stimmt am
     Zugang etwas nicht, und alles Weitere wäre Rauschen. */
  if (!fw.ok) return { error: fw.error, note: fw.error, status: (fw.status === 401 || fw.status === 403) ? "warn" : undefined };

  const out = {};
  fassung(out, fw.data || {});
  speicher(out, res.ok ? res.data : null);
  platte(out, disk.ok ? disk.data : null);
  laufzeit(out, sys.ok ? sys.data : null, zeit.ok ? zeit.data : null);
  schnittstellen(out, host, ifs.ok ? ifs.data : null, uebersicht.ok ? uebersicht.data : null);
  wireguard(out, wg.ok ? wg.data : null, wg.status);

  out.schwellen = grenze;
  ampel(out, grenze);
  return out;
}

/* ---------- Fassung und Aktualisierungen ---------- */
function fassung(out, d) {
  out.version = d.product_version || null;
  out.abi = d.product_abi || null;
  out.os = d.os_version || null;
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

  const zusatz = schnittstellenUebersicht(uebersichtRoh);
  const physisch = [];
  for (const [schluessel, w] of Object.entries(stat)) {
    /* Nur die Zeilen auf Verbindungsebene tragen die Gesamtzähler; die
       Zeilen je IP-Netz sind Teilmengen davon. */
    if (!w || !String(w.network || "").startsWith("<Link#")) continue;
    const name = w.name || schluessel;
    if (/^(lo|enc|pflog|pfsync|ipfw)/.test(name)) continue;
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
  if (!physisch.length) { out.thrIn = null; out.thrOut = null; out.interfaces = null; return; }

  const jetzt = Date.now();
  const schluessel = zaehlerSchluessel(host);
  const vorher = zaehlerstand.get(schluessel);
  zaehlerstand.set(schluessel, {
    t: jetzt,
    je: Object.fromEntries(physisch.map(p => [p.name, {
      rx: p.rx, tx: p.tx, rxPakete: p.rxPakete, txPakete: p.txPakete,
      fehler: p.fehler, verworfen: p.verworfen
    }]))
  });

  const sekunden = vorher ? (jetzt - vorher.t) / 1000 : 0;
  /* Zuwachs eines Zählers seit der letzten Abfrage — null, solange es
     keine letzte gibt, und null nach einem Zählerrücksetzer. */
  const zuwachs = (name, feld, wert) => {
    const alt = vorher?.je?.[name]?.[feld];
    if (alt == null || wert == null || sekunden <= 0) return null;
    const delta = wert - alt;
    return delta < 0 ? null : delta;
  };
  const mbit = (name, feld, wert) => {
    const delta = zuwachs(name, feld, wert);
    return delta == null ? null : Math.round((delta * 8) / sekunden / 1000) / 1000;
  };
  const proSekunde = (name, feld, wert) => {
    const delta = zuwachs(name, feld, wert);
    return delta == null ? null : Math.round(delta / sekunden);
  };

  out.interfaces = physisch.map(p => {
    const z = zusatz.get(p.name) || {};
    return {
      name: p.name,
      label: p.label,
      beschreibung: z.beschreibung || null,
      link: z.link || null,                        /* "up" / "down" / null = unbekannt */
      mtu: z.mtu ?? null,
      in: mbit(p.name, "rx", p.rx),                /* Mbit/s herein */
      out: mbit(p.name, "tx", p.tx),               /* Mbit/s hinaus */
      inPps: proSekunde(p.name, "rxPakete", p.rxPakete),
      outPps: proSekunde(p.name, "txPakete", p.txPakete),
      rxBytes: p.rx, txBytes: p.tx,
      fehler: p.fehler,
      fehlerNeu: zuwachs(p.name, "fehler", p.fehler),
      verworfen: p.verworfen,
      verworfenNeu: zuwachs(p.name, "verworfen", p.verworfen),
      kollisionen: p.kollisionen
    };
  });

  /* Gibt es eine ausdrücklich als WAN beschriebene Schnittstelle, zählt
     die — sonst die Summe über alles Physische. */
  const wan = out.interfaces.find(i => /^wan/i.test(i.label));
  const summe = f => {
    const bekannt = out.interfaces.map(i => i[f]).filter(v => v != null);
    return bekannt.length ? Math.round(bekannt.reduce((a, b) => a + b, 0) * 1000) / 1000 : null;
  };
  out.thrIn = wan ? wan.in : summe("in");
  out.thrOut = wan ? wan.out : summe("out");
  out.thrQuelle = wan ? wan.label : "alle Schnittstellen";

  /* Zuwachs an Fehlern oder Verwürfen ist eine Notiz, keine Ampel: ein
     einzelnes verworfenes Paket auf einer ausgelasteten Leitung ist
     normal, und eine Schwelle dafür wäre geraten. Sichtbar gehört es
     trotzdem — an einer schlechten Leitung wächst diese Zahl stetig. */
  const auffaellig = out.interfaces.filter(i => (i.fehlerNeu || 0) + (i.verworfenNeu || 0) > 0);
  out.ifNote = auffaellig.length
    ? auffaellig.map(i => `${i.label}: ${(i.fehlerNeu || 0)} Fehler, ${(i.verworfenNeu || 0)} verworfen`).join(" · ")
    : null;
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

/* ---------- Ampel ----------
   Nur was wirklich gemessen wurde, darf die Farbe bestimmen. Ein
   ausstehender Neustart oder eine neue Hauptfassung sind Hinweise, keine
   Störungen — sie stehen als Notiz da, ohne die Ampel zu drehen. */
function ampel(out, grenze) {
  if (out.disk != null && out.disk >= grenze.disk_crit) { out.status = "crit"; out.note = `Platte zu ${out.disk} % belegt (kritisch ab ${grenze.disk_crit} %)`; return; }
  if (out.ram != null && out.ram >= grenze.ram_warn) {
    /* Der ZFS-Cache zählt in dieser Zahl als belegt, ist aber jederzeit
       abzugeben — deshalb steht er dabei, statt die Ampel allein zu drehen. */
    out.status = out.ram >= grenze.ram_crit ? "crit" : "warn";
    out.note = `Arbeitsspeicher ${out.ram} % belegt` + (out.ramArcMb ? ` (davon ${out.ramArcMb} MB ZFS-Cache)` : "");
    return;
  }
  if (out.disk != null && out.disk >= grenze.disk_warn) { out.status = "warn"; out.note = `Platte zu ${out.disk} % belegt`; return; }
  if (out.wgFehler) { out.status = "warn"; out.note = out.wgFehler; return; }

  const hinweise = [];
  if (out.needsReboot) hinweise.push("Neustart steht aus");
  if (out.updates) hinweise.push(`${out.updates} Aktualisierung(en)`);
  if (out.majorUpgrade) hinweise.push(`Fassung ${out.majorUpgrade} verfügbar`);
  if (out.ifNote) hinweise.push(out.ifNote);
  if (hinweise.length) out.note = hinweise.join(" · ");
}

const zahl = v => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
