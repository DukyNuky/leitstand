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
  const sites = (doc.sites || []).map(s => ({ ...s, id: String(s.id) }));
  const hosts = (doc.hosts || []).map(h => normalizeHost(h));
  const tunnels = (doc.tunnels || []).map(t => ({ ...t, id: String(t.id) }));
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
    if (!t.probe?.ip) errs.push(`Tunnel ${t.id}: probe.ip fehlt — ohne Gegenstelle im Tunnel lässt sich nichts messen.`);
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
    tunnels: inv.tunnels,
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
