/* Sammler für Proxmox VE, Backup Server und Mail Gateway.

   Alle drei sprechen dieselbe Token-Authentisierung:
     Authorization: PVEAPIToken=BENUTZER@REALM!TOKENID=GEHEIMNIS
   (bei PBS `PBSAPIToken=`, bei PMG `PMGAPIToken=`)

   Der Zugang ist ausschließlich lesend gedacht — Rolle PVEAuditor
   beziehungsweise DatastoreAudit. */

import { requestJson } from "../http.js";

const PREFIX = { pve: "PVEAPIToken", pbs: "PBSAPIToken", pmg: "PMGAPIToken" };
const DEFAULT_PORT = { pve: 8006, pbs: 8007, pmg: 8006 };

/* Und hier hört die Gemeinsamkeit auf: VE und Mail Gateway hängen das
   Geheimnis mit „=“ an die Token-ID, der Backup Server mit „:“. Ein falsches
   Zeichen sieht aus wie ein falsches Geheimnis — die Antwort ist 401, ohne
   ein Wort darüber, dass nur der Doppelpunkt fehlt. */
export const TRENNER = { pve: "=", pbs: ":", pmg: "=" };

/* Der häufigste Grund für „erreichbar, aber keine Kennzahlen": die Rolle
   wurde dem Benutzer gegeben, nicht dem Token. Bei aktivierter Privilege
   Separation — der Vorgabe beim Anlegen — gilt sie dann nicht. Proxmox
   sagt das nicht, es liefert einfach weniger. */
export const RECHTEHINWEIS =
  "In Proxmox unter Datacenter → Permissions → Add → API Token Permission eintragen: "
  + "Pfad /, Rolle PVEAuditor, Propagate an. Eine Berechtigung, die nur dem Benutzer "
  + "gegeben wurde, gilt bei „Privilege Separation“ nicht für seine Token.";

export function authHeader(type, cred) {
  if (!cred) return null;
  if (cred.tokenId && cred.secret) {
    const id = cred.tokenId.includes("!") ? cred.tokenId : `${cred.user || "root@pam"}!${cred.tokenId}`;
    const trenner = TRENNER[type] || "=";
    return { Authorization: `${PREFIX[type] || "PVEAPIToken"}=${id}${trenner}${cred.secret}` };
  }
  return null;
}

export function baseUrl(host, type) {
  if (host.url) {
    try {
      const u = new URL(host.url);
      const port = u.port || String(DEFAULT_PORT[type] || 8006);
      return `${u.protocol}//${u.hostname}:${port}`;
    } catch {}
  }
  return `https://${host.ip}:${DEFAULT_PORT[type] || 8006}`;
}

async function api(host, type, cred, path, timeout = 8000) {
  const headers = authHeader(type, cred);
  if (!headers) return { ok: false, error: "Kein API-Token hinterlegt" };
  return requestJson(`${baseUrl(host, type)}/api2/json${path}`, { headers, timeout });
}

/* ---------- Verbindungstest für die Admin-Oberfläche ---------- */
const TYPE_NAME = { pve: "Proxmox VE", pbs: "Backup Server", pmg: "Mail Gateway" };

export async function testConnection(host, cred, type = host.type) {
  const r = await api(host, type, cred, "/version", 6000);
  if (!r.ok) return { ok: false, detail: r.error, hint: hintFor(r) };
  const v = r.data?.data || {};
  const out = {
    ok: true,
    detail: `Verbunden — ${TYPE_NAME[type] || type} ${v.version || "?"}${v.release ? " (" + v.release + ")" : ""}`,
    version: v.version, ms: r.ms
  };

  /* `/version` darf jeder angemeldete Benutzer lesen — der Test wäre also
     grün, während der Token die Kennzahlen gar nicht sehen darf. Genau so
     landet man bei einem Knoten, der erreichbar aussieht und nichts anzeigt.
     Deshalb wird auch das geprüft, was der Sammler später wirklich braucht. */
  if (type === "pve") {
    const res = await api(host, "pve", cred, "/cluster/resources", 6000);
    const liste = res.ok ? (res.data?.data || []) : null;
    const RECHTE = "Dem Token fehlen Leserechte: Rolle PVEAuditor auf / mit Vererbung setzen. "
      + "Bei „Privilege Separation“ gilt die Rolle dem Token selbst, nicht nur dem Benutzer.";
    if (!res.ok) {
      out.ok = false;
      out.detail += ` — aber die Bestandsliste ist nicht lesbar: ${res.error}`;
      out.hint = RECHTE;
    } else if (!liste.length) {
      out.ok = false;
      out.detail += " — aber die Bestandsliste kommt leer zurück";
      out.hint = RECHTE + " Proxmox filtert diese Liste nach Rechten, statt sie abzulehnen.";
    } else {
      const gaeste = liste.filter(x => x.type === "qemu" || x.type === "lxc").length;
      const speicher = liste.filter(x => x.type === "storage").length;
      out.detail += ` · ${gaeste} Gäste und ${speicher} Speicher sichtbar`;
    }
  }
  return out;
}

function hintFor(r) {
  if (r.status === 401) return "Token-ID vollständig angeben, z. B. leitstand@pve!ro — und das Geheimnis aus der Anlage-Maske.";
  if (r.status === 403) return "Dem Token fehlen Rechte: Rolle PVEAuditor auf / mit Vererbung setzen.";
  if (r.status === 404) return "Erreicht, aber kein Proxmox-Endpunkt — Port prüfen (VE 8006, PBS 8007).";
  if (/abgewiesen/.test(r.error || "")) return "Port stimmt vermutlich nicht: VE 8006, PBS 8007, PMG 8006.";
  return null;
}

/* ---------- Proxmox VE ---------- */
export async function collectPve(host, cred) {
  const [nodesRes, verRes, resRes, clusterRes] = await Promise.all([
    api(host, "pve", cred, "/nodes"),
    api(host, "pve", cred, "/version"),
    api(host, "pve", cred, "/cluster/resources"),
    api(host, "pve", cred, "/cluster/status")
  ]);
  if (!nodesRes.ok) return { error: nodesRes.error, status: (nodesRes.status === 401 || nodesRes.status === 403) ? "warn" : undefined, note: nodesRes.error };

  const nodes = nodesRes.data?.data || [];
  const me = pickNode(nodes, host);
  if (!me) return { error: "Knoten in der Antwort nicht gefunden", note: `Antwort enthält: ${nodes.map(n => n.node).join(", ") || "nichts"}` };

  const out = {
    node: me.node,
    version: verRes.ok ? verRes.data?.data?.version : null,
    cpu: pct(me.cpu),
    ram: me.maxmem ? pct(me.mem / me.maxmem) : null,
    disk: me.maxdisk ? pct(me.disk / me.maxdisk) : null,
    uptime: me.uptime ? days(me.uptime) : null,
    online: me.status === "online"
  };

  /* Gäste und Speicher stehen in der Bestandsliste. Sie kann fehlschlagen
     oder — was häufiger vorkommt — mit 200 und leerem Inhalt antworten:
     Proxmox filtert sie nach Rechten. In beiden Fällen ist die Antwort
     „unbekannt" und nicht „null Stück". Ein gemeldetes 0 wäre hier
     besonders tückisch, weil es wie ein gemessener Wert aussieht und die
     Ampel grün lässt. */
  let fullest = null;
  if (!resRes.ok) {
    unbekannt(out);
    out.error = resRes.error;
    out.status = "warn";
    out.note = `Bestandsliste nicht abrufbar: ${resRes.error}`;
  } else {
    const alle = resRes.data?.data || [];
    const mine = alle.filter(r => r.node === me.node);
    /* Der Knoten selbst steht ebenfalls in dieser Liste (type: node).
       Gemeint sind aber Gäste und Speicher — kommt davon nichts, darf der
       Token sie nicht sehen. Der Knoteneintrag allein ist kein Bestand:
       daraus 0 VMs zu zählen wäre wieder ein erfundener Messwert. */
    const bestand = mine.filter(r => r.type !== "node");
    if (!bestand.length) {
      unbekannt(out);
      out.status = "warn";
      out.note = (alle.length ? "Nur Knoten-Einträge sichtbar, keine Gäste und keine Speicher"
        : "Die Bestandsliste kommt leer zurück")
        + " — dem Token fehlen Leserechte. " + RECHTEHINWEIS;
    } else {
      const guests = bestand.filter(r => r.type === "qemu" || r.type === "lxc");
      out.vms = bestand.filter(r => r.type === "qemu").length;
      out.lxc = bestand.filter(r => r.type === "lxc").length;
      out.running = guests.filter(r => r.status === "running").length;
      out.stopped = guests.filter(r => r.status !== "running" && r.template !== 1).length;

      const storages = bestand.filter(r => r.type === "storage" && r.maxdisk);
      out.storages = storages.map(s => ({ name: s.storage, used: pct(s.disk / s.maxdisk) }));
      fullest = out.storages.slice().sort((a, b) => (b.used ?? 0) - (a.used ?? 0))[0] || null;
    }
  }

  if (clusterRes.ok) {
    const cl = (clusterRes.data?.data || []).find(x => x.type === "cluster");
    if (cl) { out.cluster = cl.name; out.quorum = cl.quorate === 1; }
  }

  /* Ein echter Befund sticht den Hinweis auf fehlende Rechte — kein Quorum
     oder ein volles Laufwerk ist das dringendere Problem. */
  if (out.cluster && out.quorum === false) { out.status = "crit"; out.note = "Knoten hat kein Quorum"; }
  else if (fullest && fullest.used >= 90) { out.status = "crit"; out.note = `Speicher ${fullest.name} zu ${fullest.used} % belegt`; }
  else if (out.ram != null && out.ram >= 85) { out.status = "warn"; out.note = `RAM-Auslastung ${out.ram} %`; }
  else if (fullest && fullest.used >= 80) { out.status = "warn"; out.note = `Speicher ${fullest.name} zu ${fullest.used} % belegt`; }
  return out;
}

/* Was nicht gelesen werden konnte, bleibt unbekannt — und wird als Strich
   angezeigt statt als Zahl, der man glaubt. */
function unbekannt(out) {
  out.vms = null; out.lxc = null; out.running = null; out.stopped = null; out.storages = null;
}

function pickNode(nodes, host) {
  if (nodes.length === 1) return nodes[0];
  const wanted = [host.name, host.id].filter(Boolean).map(s => String(s).toLowerCase());
  return nodes.find(n => wanted.includes(String(n.node).toLowerCase())) || null;
}

/* ---------- Proxmox Backup Server ---------- */
export async function collectPbs(host, cred) {
  const [useRes, taskRes, verRes] = await Promise.all([
    api(host, "pbs", cred, "/status/datastore-usage"),
    api(host, "pbs", cred, "/nodes/localhost/tasks?limit=60&errors=1"),
    api(host, "pbs", cred, "/version")
  ]);
  if (!useRes.ok) return { error: useRes.error, note: useRes.error };

  const stores = (useRes.data?.data || []).map(d => ({
    name: d.store,
    used: d.total ? pct(d.used / d.total) : null
  }));
  const out = { version: verRes.ok ? verRes.data?.data?.version : null, datastores: stores.length, stores };
  const fullest = stores.filter(s => s.used != null).sort((a, b) => b.used - a.used)[0];
  out.used = fullest ? fullest.used : null;

  const tasks = taskRes.ok ? (taskRes.data?.data || []) : [];
  const failed = tasks.filter(t => t.status && t.status !== "OK" && t.endtime && (Date.now() / 1000 - t.endtime) < 86400);
  out.failed = failed.length;
  if (failed.length) {
    const f = failed[0];
    out.status = "crit";
    out.note = `${failed.length} fehlgeschlagene Aufgabe(n) in 24 h — zuletzt ${f.worker_type || "Job"} ${f.worker_id || ""}`.trim();
  } else if (fullest && fullest.used >= 85) { out.status = "warn"; out.note = `Datastore ${fullest.name} zu ${fullest.used} % belegt`; }
  const ok = tasks.find(t => t.status === "OK" && t.endtime);
  out.lastGood = ok ? new Date(ok.endtime * 1000).toISOString() : null;
  return out;
}

/* ---------- Proxmox Mail Gateway ---------- */
export async function collectPmg(host, cred) {
  const [statRes, verRes] = await Promise.all([
    api(host, "pmg", cred, "/statistics/mail?timespan=86400"),
    api(host, "pmg", cred, "/version")
  ]);
  if (!statRes.ok) return { error: statRes.error, note: statRes.error };
  const d = statRes.data?.data || {};
  const out = {
    version: verRes.ok ? verRes.data?.data?.version : null,
    in24: d.count_in ?? null, out24: d.count_out ?? null,
    spam: d.spamin ?? null, virus: d.viruscount_in ?? null
  };
  if (out.virus > 0) { out.status = "warn"; out.note = `${out.virus} Virenfund(e) in 24 h`; }
  return out;
}

const pct = f => (Number.isFinite(f) ? Math.round(f * 100) : null);
const days = s => `${Math.floor(s / 86400)} T`;

/* ---------- Registrierung für den Kern ---------- */
export function makeCollectors(secrets) {
  const wrap = fn => async host => {
    const cred = secrets.get(host.id);
    if (!cred) return null;                       /* ohne Token bleibt es bei der reinen Erreichbarkeit */
    return fn(host, cred);
  };
  return { pve: wrap(collectPve), pbs: wrap(collectPbs), pmg: wrap(collectPmg) };
}

export const TESTERS = {
  pve: (h, c) => testConnection(h, c, "pve"),
  pbs: (h, c) => testConnection(h, c, "pbs"),
  pmg: (h, c) => testConnection(h, c, "pmg")
};
