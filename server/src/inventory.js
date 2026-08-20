/* Bestand laden, prüfen und zurückschreiben.

   Die YAML-Datei bleibt die Wahrheit — die Admin-Oberfläche schreibt
   in dieselbe Datei, die man auch von Hand bearbeiten kann. Vor jedem
   Schreiben wird eine Sicherung abgelegt, damit ein Fehlgriff in der
   Oberfläche nichts kostet. */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const DEFAULTS = {
  interval: 15, timeout: 4, history: 120, fail_threshold: 3,
  slow_ms: 800, tls_warn_days: 30, tls_crit_days: 14,
  icmp: true, listen: 8080, bind: "0.0.0.0"
};

/* Welche Prüfungen ein Systemtyp von Haus aus bekommt, wenn nichts
   ausdrücklich konfiguriert ist. Der Standardport steht am Typ, damit
   „Proxmox hinzufügen“ in der Oberfläche mit zwei Feldern auskommt. */
export const TYPES = {
  pve:       { label: "Proxmox VE",           port: 8006, api: "proxmox" },
  pbs:       { label: "Proxmox Backup Server",port: 8007, api: "proxmox" },
  pmg:       { label: "Proxmox Mail Gateway", port: 8006, api: "proxmox" },
  opnsense:  { label: "OPNsense",             port: 443,  api: "opnsense" },
  pfsense:   { label: "pfSense",              port: 443,  api: null },
  truenas:   { label: "TrueNAS SCALE",        port: 443,  api: null },
  mailcow:   { label: "Mailcow",              port: 443,  api: null },
  adguard:   { label: "AdGuard Home",         port: 443,  api: null },
  portainer: { label: "Portainer",            port: 9443, api: null },
  hass:      { label: "Home Assistant",       port: 8123, api: null },
  other:     { label: "Sonstiges",            port: 443,  api: null }
};

export class InventoryError extends Error {}

/* ---------- Standortkürzel ----------
   Vier Stellen, Land und Stadt: DEKO für Deutschland/Köln, ATWI für
   Österreich/Wien. Feste Breite, weil das Kürzel in der Filterleiste, in
   der Topologie und in jeder Tabellenzeile steht — unterschiedlich lange
   Kürzel lassen diese Spalten springen.

   Geprüft wird beim Schreiben, nicht beim Lesen: ein bestehender Bestand
   mit älteren Kürzeln muss weiter starten. Sonst nähme eine Formalie die
   ganze Überwachung mit. */
export const KUERZEL_MUSTER = /^[A-Z][A-Z0-9]{3}$/;

export function normalizeKuerzel(s) {
  return String(s ?? "").trim().toUpperCase();
}

/* Gibt den Grund zurück, warum es nicht taugt — oder null, wenn es passt. */
export function pruefeKuerzel(short) {
  const k = normalizeKuerzel(short);
  if (!k) return "Kürzel fehlt — vier Stellen, Land und Stadt (z. B. DEKO für Deutschland/Köln).";
  if (k.length !== 4) return `„${k}" hat ${k.length} Stellen — es müssen genau vier sein (Land + Stadt, z. B. DEKO).`;
  if (!KUERZEL_MUSTER.test(k)) return `„${k}" enthält Unerlaubtes — nur Buchstaben und Ziffern, die erste Stelle ein Buchstabe.`;
  return null;
}

/* ---------- Lesen ---------- */
export function load(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") throw new InventoryError(`Bestandsdatei nicht gefunden: ${file}`);
    throw e;
  }
  let doc;
  try { doc = YAML.parse(raw) || {}; }
  catch (e) { throw new InventoryError(`YAML lässt sich nicht lesen: ${e.message}`); }
  return normalize(doc);
}

export function normalize(doc) {
  const settings = { ...DEFAULTS, ...(doc.settings || {}) };
  const sites = (doc.sites || []).map(s => ({
    ...s, id: String(s.id),
    ...(s.short ? { short: normalizeKuerzel(s.short) } : {})
  }));
  const hosts = (doc.hosts || []).map(h => normalizeHost(h));
  const tunnels = (doc.tunnels || []).map(t => normalizeTunnel(t));
  const links = (doc.links || []).map(g => ({
    group: g.group,
    items: (g.items || []).map(i => ({ ...i }))
  }));
  validate({ settings, sites, hosts, tunnels, links });
  return { settings, sites, hosts, tunnels, links };
}

export function normalizeHost(h) {
  const host = { ...h, id: String(h.id) };
  host.name = host.name || host.id;
  host.type = host.type || "other";
  host.monitor = host.monitor !== false;
  if (!host.url && host.ip) {
    const port = TYPES[host.type]?.port ?? 443;
    host.url = `https://${host.ip}${port === 443 ? "" : ":" + port}`;
  }
  host.checks = (host.checks && host.checks.length) ? host.checks : defaultChecks(host);
  return host;
}

/* ---------- Tunnel ----------
   Ein Tunnel darf einen WireGuard-Peer benennen, den eine Firewall meldet:

     peer: { host: fw-01, iface: wg0, name: WG-Schweiz, key: Aqujl… }

   Der öffentliche Schlüssel ist die belastbare Kennung — er bleibt, wenn
   der Peer auf der Firewall umbenannt wird. Name und Interface stehen
   trotzdem dabei: als lesbare Beschriftung und als Rückfall für Bestände,
   die von Hand gepflegt wurden und den Schlüssel nicht kennen.

   Ein leerer Peer wird entfernt statt als null geführt — sonst stünde nach
   jedem Lösen der Verknüpfung ein `peer: null` in der Datei. Ein Peer mit
   Inhalt bleibt dagegen stehen, auch wenn er unvollständig ist: über den
   soll sich die Prüfung beschweren, statt ihn stillschweigend fallen zu
   lassen. Wer von Hand etwas Halbes einträgt, hat eine Meldung verdient
   und keine Verknüpfung, die einfach nicht da ist. */
export function normalizeTunnel(t) {
  const o = { ...t, id: String(t.id) };
  const p = o.peer;
  const leer = !p || typeof p !== "object" || Array.isArray(p)
    || !["host", "iface", "name", "key"].some(k => p[k]);
  if (leer) delete o.peer;
  else {
    o.peer = {};
    for (const k of ["host", "iface", "name", "key"]) if (p[k]) o.peer[k] = String(p[k]);
  }
  if (o.probe && !o.probe.ip) delete o.probe;
  return o;
}

/* Aus url und ip die naheliegenden Prüfungen ableiten. */
export function defaultChecks(host) {
  const checks = [];
  if (host.ip) checks.push({ kind: "icmp" });
  if (host.url) {
    let u;
    try { u = new URL(host.url); } catch { u = null; }
    if (u) {
      const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
      checks.push({ kind: "tcp", port });
      if (u.protocol === "https:") checks.push({ kind: "tls", port });
    }
  }
  if (!checks.length) checks.push({ kind: "icmp" });
  return checks;
}

/* ---------- Prüfen ---------- */
export function validate(inv) {
  const errs = [];
  const siteIds = new Set(inv.sites.map(s => s.id));
  const hostIds = new Set();

  if (!inv.sites.length) errs.push("Mindestens ein Standort muss angelegt sein.");
  for (const s of inv.sites) {
    if (!s.id) errs.push("Ein Standort hat keine id.");
    if (!s.name) errs.push(`Standort ${s.id}: name fehlt.`);
  }
  for (const h of inv.hosts) {
    if (!h.id) { errs.push("Ein System hat keine id."); continue; }
    if (hostIds.has(h.id)) errs.push(`System ${h.id}: id ist doppelt vergeben.`);
    hostIds.add(h.id);
    if (!siteIds.has(h.site)) errs.push(`System ${h.id}: Standort „${h.site}“ ist nicht angelegt.`);
    if (!h.ip && !h.url) errs.push(`System ${h.id}: weder ip noch url — nichts zu prüfen.`);
    if (h.url) { try { new URL(h.url); } catch { errs.push(`System ${h.id}: url „${h.url}“ ist keine gültige Adresse.`); } }
    for (const c of h.checks || []) {
      if (!["tcp", "tls", "http", "dns", "icmp"].includes(c.kind)) errs.push(`System ${h.id}: unbekannte Prüfung „${c.kind}“.`);
      if (["tcp", "tls"].includes(c.kind) && !(c.port > 0 && c.port < 65536)) errs.push(`System ${h.id}: Prüfung ${c.kind} braucht einen gültigen Port.`);
    }
  }
  for (const t of inv.tunnels) {
    if (!siteIds.has(t.a) || !siteIds.has(t.b)) errs.push(`Tunnel ${t.id}: Standort a oder b ist nicht angelegt.`);
    if (t.peer) {
      if (!t.peer.host) errs.push(`Tunnel ${t.id}: Beim Peer fehlt das System, das ihn meldet (peer.host).`);
      else if (!hostIds.has(t.peer.host)) errs.push(`Tunnel ${t.id}: Der Peer soll von „${t.peer.host}“ gelesen werden — dieses System ist nicht angelegt.`);
      if (!t.peer.key && !t.peer.name) errs.push(`Tunnel ${t.id}: Der Peer hat keine Kennung — es braucht den öffentlichen Schlüssel oder wenigstens den Namen.`);
    }
    /* Eines von beidem muss es sein: entweder wird durch den Tunnel
       gemessen, oder die Firewall meldet den Handshake. Ohne beides gäbe
       es zu dieser Strecke schlicht nichts zu sagen. */
    if (!t.probe?.ip && !t.peer)
      errs.push(`Tunnel ${t.id}: weder probe.ip noch ein verknüpfter Peer — so ließe sich nichts messen.`);
  }
  for (const g of inv.links) for (const i of g.items) {
    if (i.host && !hostIds.has(i.host)) errs.push(`Verknüpfung „${i.name}“: System „${i.host}“ ist nicht angelegt.`);
    if (!i.host && !i.url) errs.push(`Verknüpfung „${i.name}“: weder host noch url.`);
  }
  if (errs.length) throw new InventoryError(errs.join("\n"));
  return true;
}

/* ---------- Schreiben ---------- */
const HEADER = `# ============================================================
#  Leitstand — Bestand
#
#  Diese Datei wird von der Admin-Oberfläche gepflegt und lässt sich
#  ebenso von Hand bearbeiten. Nach einer Änderung von Hand genügt
#  ein Neuladen im Werkzeug (Verwaltung → Bestand neu einlesen).
#
#  Vor jedem Schreibvorgang wird inventory.yaml.bak angelegt.
# ============================================================

`;

export function save(file, inv) {
  validate(inv);
  const out = {
    settings: inv.settings,
    sites: inv.sites,
    hosts: inv.hosts.map(stripDerived),
    tunnels: inv.tunnels.map(normalizeTunnel),
    links: inv.links
  };
  const text = HEADER + YAML.stringify(out, { lineWidth: 0, defaultStringType: "PLAIN", singleQuote: false });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, { mode: 0o640 });
  fs.renameSync(tmp, file);                       /* atomar ersetzen */
  return text;
}

/* Abgeleitete Prüfungen nicht mitschreiben — sonst friert die Datei
   Standardwerte ein, die sich später am Typ ändern sollen. */
function stripDerived(h) {
  const copy = { ...h };
  const derived = JSON.stringify(defaultChecks({ ...h, checks: null }));
  if (JSON.stringify(h.checks) === derived) delete copy.checks;
  if (copy.monitor === true) delete copy.monitor;
  if (copy.name === copy.id) delete copy.name;
  return copy;
}

export function backupPath(file) { return file + ".bak"; }
export function restore(file) {
  const bak = backupPath(file);
  if (!fs.existsSync(bak)) throw new InventoryError("Keine Sicherung vorhanden.");
  fs.copyFileSync(bak, file);
  return load(file);
}

export function resolvePath(p) { return path.resolve(process.cwd(), p); }

/* Ein frisch angelegtes Volume ist leer. Statt mit „Datei nicht gefunden“
   abzubrechen, legt der Dienst einen Startbestand an — entweder die im Abbild
   mitgelieferte Vorlage oder, wenn es die nicht gibt, das kleinstmögliche
   gültige Gerüst. Alles Weitere kommt aus der Verwaltung. */
export const STARTER = `# Leitstand — Bestand
#
# Diese Datei wurde beim ersten Start angelegt. Systeme, Standorte und Tunnel
# lassen sich in der Oberfläche unter „Verwaltung“ pflegen; von Hand geht es
# ebenso. Nach einer Änderung von Hand: Verwaltung -> Bestand neu einlesen.

settings:
  interval: 15
  timeout: 4
  fail_threshold: 3
  slow_ms: 800
  tls_warn_days: 30
  tls_crit_days: 14
  icmp: true

sites:
  - { id: hq, name: Zuhause, place: "", primary: true }

hosts: []
tunnels: []
links: []
`;

export function ensure(file, seedFrom = null) {
  if (fs.existsSync(file)) return { created: false, file };
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let text = STARTER;
  if (seedFrom && fs.existsSync(seedFrom)) {
    try {
      const vorlage = fs.readFileSync(seedFrom, "utf8");
      normalize(YAML.parse(vorlage) || {});      /* nur übernehmen, wenn sie trägt */
      text = vorlage;
    } catch { /* Vorlage unbrauchbar — dann eben das Gerüst */ }
  }
  fs.writeFileSync(file, text, { mode: 0o640 });
  return { created: true, file, seeded: text !== STARTER };
}
