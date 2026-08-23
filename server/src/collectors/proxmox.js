/* Sammler für Proxmox VE, Backup Server und Mail Gateway.

   Alle drei sprechen dieselbe Token-Authentisierung:
     Authorization: PVEAPIToken=BENUTZER@REALM!TOKENID=GEHEIMNIS
   (bei PBS `PBSAPIToken=`, bei PMG `PMGAPIToken=`)

   Der Zugang ist ausschließlich lesend gedacht — Rolle PVEAuditor
   beziehungsweise DatastoreAudit. */

import { requestJson } from "../http.js";
import { schwellenFuer } from "../inventory.js";

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
export async function collectPve(host, cred, settings) {
  const grenze = schwellenFuer(host, settings);
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
    uptimeSeconds: Number.isFinite(me.uptime) ? me.uptime : null,
    nodeStatus: me.status || null,
    online: me.status === "online"
  };

  /* Kernel, Paketstand und die Ausstattung des Knotens hängen unter
     /nodes/{name} — die lassen sich erst fragen, wenn der Name feststeht.
     Beide dürfen fehlschlagen, ohne den Rest mitzunehmen: sie sind
     Auskunft, nicht Messung. */
  const [statusRes, aptRes] = await Promise.all([
    api(host, "pve", cred, `/nodes/${encodeURIComponent(me.node)}/status`),
    api(host, "pve", cred, `/nodes/${encodeURIComponent(me.node)}/apt/update`)
  ]);
  knotenstatus(out, statusRes.ok ? statusRes.data?.data : null);
  pakete(out, aptRes);

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
      /* Vorlagen bleiben aus allen Zählungen heraus und werden getrennt
         geführt. Sonst ergäbe „3 VMs, 2 laufen, 1 gestoppt" eine Rechnung,
         die nicht aufgeht — und eine Anzeige, die nicht aufgeht, glaubt
         man beim nächsten Mal auch nicht mehr. */
      const echte = guests.filter(r => r.template !== 1);
      out.vms = echte.filter(r => r.type === "qemu").length;
      out.lxc = echte.filter(r => r.type === "lxc").length;
      out.running = echte.filter(r => r.status === "running").length;
      out.stopped = echte.filter(r => r.status !== "running").length;
      out.templates = guests.length - echte.length;
      /* Nicht nur zählen, sondern benennen: „14 VMs" beantwortet keine
         Frage, die man mitten in der Nacht hat. Vorlagen bleiben draußen —
         sie laufen nie und stünden für immer als „gestoppt" in der Liste. */
      out.guests = echte.map(gast).sort(sortiereGaeste);

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
  /* Die Grenzen stehen in den Einstellungen und dürfen am System
     überschrieben sein — ein Host, der bekanntermaßen bei 93 % läuft, soll
     nicht jede Nacht rot leuchten. Welche Zahl gerade galt, steht mit in
     der Notiz, damit man die Meldung ohne Nachschlagen einordnen kann. */
  out.schwellen = grenze;
  if (out.cluster && out.quorum === false) { out.status = "crit"; out.note = "Knoten hat kein Quorum"; }
  else if (fullest && fullest.used >= grenze.disk_crit) { out.status = "crit"; out.note = `Speicher ${fullest.name} zu ${fullest.used} % belegt (kritisch ab ${grenze.disk_crit} %)`; }
  else if (out.ram != null && out.ram >= grenze.ram_crit) { out.status = "crit"; out.note = `RAM-Auslastung ${out.ram} % (kritisch ab ${grenze.ram_crit} %)`; }
  else if (out.ram != null && out.ram >= grenze.ram_warn) { out.status = "warn"; out.note = `RAM-Auslastung ${out.ram} %`; }
  else if (fullest && fullest.used >= grenze.disk_warn) { out.status = "warn"; out.note = `Speicher ${fullest.name} zu ${fullest.used} % belegt`; }
  /* Ausstehende Pakete sind ein Hinweis, keine Störung — sie stehen als
     Notiz da und drehen die Ampel nicht. Dieselbe Zurückhaltung wie bei
     OPNsense: wer nachts geweckt wird, soll wissen, dass etwas kaputt ist,
     nicht dass etwas älter ist. */
  else if (!out.note && out.updates) out.note = `${out.updates} Paketaktualisierung(en) stehen aus`;
  return out;
}

/* Was nicht gelesen werden konnte, bleibt unbekannt — und wird als Strich
   angezeigt statt als Zahl, der man glaubt. */
function unbekannt(out) {
  out.vms = null; out.lxc = null; out.running = null; out.stopped = null; out.storages = null;
  out.guests = null; out.templates = null;
}

/* ---------- Ein Gast ----------

   Zwei Stellen, an denen Proxmox eine Null liefert, die keine Messung ist:

   1. Ein gestoppter Gast steht mit cpu 0 und mem 0 in der Bestandsliste.
      Als „0 % CPU" angezeigt sähe eine ausgeschaltete Maschine aus wie
      eine, die sich langweilt. Deshalb: läuft sie nicht, gibt es hier
      keine Auslastung, sondern einen Strich.

   2. Bei virtuellen Maschinen kennt der Wirt die Belegung *im* Gast nicht —
      `disk` ist dort 0, solange kein Gastagent Auskunft gibt. Bei
      Containern ist die Zahl echt. Eine 0 wird deshalb als „weiß ich
      nicht" gelesen und nicht als „leer". */
function gast(g) {
  const laeuft = g.status === "running";
  return {
    vmid: g.vmid ?? null,
    name: g.name || (g.vmid != null ? String(g.vmid) : "—"),
    typ: g.type,                                  /* qemu = VM, lxc = Container */
    status: g.status || null,
    node: g.node || null,
    lock: g.lock || null,
    tags: g.tags || null,
    cores: zahl(g.maxcpu),
    cpu: laeuft ? pct(g.cpu) : null,
    ram: laeuft && g.maxmem ? pct(g.mem / g.maxmem) : null,
    ramMb: laeuft && Number.isFinite(g.mem) ? Math.round(g.mem / 1048576) : null,
    ramMaxMb: Number.isFinite(g.maxmem) ? Math.round(g.maxmem / 1048576) : null,
    disk: laeuft && g.maxdisk && g.disk ? pct(g.disk / g.maxdisk) : null,
    diskMaxGb: Number.isFinite(g.maxdisk) && g.maxdisk ? Math.round(g.maxdisk / 1073741824) : null,
    uptime: laeuft && Number.isFinite(g.uptime) ? g.uptime : null
  };
}

/* Laufendes zuerst, darin das Belastete oben — wonach man sucht, steht
   dann ohne Blättern da. Gestopptes danach, alphabetisch. */
function sortiereGaeste(a, b) {
  const laufA = a.status === "running", laufB = b.status === "running";
  if (laufA !== laufB) return laufA ? -1 : 1;
  if (laufA && (a.cpu ?? -1) !== (b.cpu ?? -1)) return (b.cpu ?? -1) - (a.cpu ?? -1);
  return String(a.name).localeCompare(String(b.name), "de");
}

/* ---------- Knotenauskunft ----------
   Aus /nodes/{name}/status: was auf dem Blech läuft und womit. Der
   Kernelstring ist die volle Bauzeile („Linux 6.8.12-4-pve #1 SMP …") —
   davon ist genau ein Feld interessant. */
function knotenstatus(out, d) {
  if (!d) return;
  out.kernel = kurzKernel(d.kversion);
  /* „pve-manager/8.3.2/abc" — die Fassung steht schon in out.version,
     hier bleibt die vollständige Zeile für die Detailseite. */
  out.pveVersion = d.pveversion || null;
  out.cores = zahl(d.cpuinfo?.cpus);
  out.sockets = zahl(d.cpuinfo?.sockets);
  out.cpuModel = d.cpuinfo?.model || null;
  const last = Array.isArray(d.loadavg) ? Number(d.loadavg[0]) : NaN;
  out.load1 = Number.isFinite(last) ? last : null;
  out.rootUsed = d.rootfs?.total ? pct(d.rootfs.used / d.rootfs.total) : null;
  /* Auslagerung ohne Vorrat ist 0 von 0 — dann gibt es dazu nichts zu sagen. */
  out.swap = d.swap?.total ? pct(d.swap.used / d.swap.total) : null;
}

function kurzKernel(v) {
  if (!v) return null;
  const m = /(\d+\.\d+[\w.+-]*)/.exec(String(v));
  return m ? m[1] : String(v);
}

/* ---------- Ausstehende Pakete ----------
   /nodes/{name}/apt/update listet, was `apt list --upgradable` zeigen
   würde. Wichtig: es steht dort nur, was der letzte Listenabgleich auf
   dem Knoten hergab — eine leere Liste heißt „nichts bekannt", nicht
   „garantiert aktuell". Das steht so auch in der Oberfläche.

   Bewusst nicht gezählt: welche davon Sicherheitsaktualisierungen sind.
   Die Einträge tragen dafür kein verlässliches Feld, und eine geratene
   Zahl wäre schlimmer als keine. */
function pakete(out, r) {
  if (!r.ok) {
    out.updates = null;
    out.updatesNote = r.status === 403
      ? "Paketstand nicht lesbar — dem Token fehlt Sys.Audit auf diesem Knoten"
      : r.error;
    return;
  }
  const liste = Array.isArray(r.data?.data) ? r.data.data : [];
  out.updates = liste.length;
  out.updatesNote = null;
  out.updateListe = liste.slice(0, 20).map(p => ({
    paket: p.Package || "—",
    von: p.OldVersion || null,
    auf: p.Version || null,
    titel: p.Title || null
  }));
}

function pickNode(nodes, host) {
  if (nodes.length === 1) return nodes[0];
  const wanted = [host.name, host.id].filter(Boolean).map(s => String(s).toLowerCase());
  return nodes.find(n => wanted.includes(String(n.node).toLowerCase())) || null;
}

/* ---------- Proxmox Backup Server ---------- */
export async function collectPbs(host, cred, settings) {
  const grenze = schwellenFuer(host, settings);
  /* Zwei Aufgabenlisten, weil sie zwei verschiedene Fragen beantworten:
     die gefilterte findet Fehler auch dann, wenn hundert geglückte
     Sicherungen davorstehen; die ungefilterte sagt, wann ein Datastore
     zuletzt gesichert, aufgeräumt und geprüft wurde. Eine Liste allein
     könnte immer nur das eine. */
  const [useRes, fehlRes, alleRes, verRes, dsRes] = await Promise.all([
    api(host, "pbs", cred, "/status/datastore-usage"),
    api(host, "pbs", cred, "/nodes/localhost/tasks?limit=60&errors=1"),
    api(host, "pbs", cred, "/nodes/localhost/tasks?limit=200"),
    api(host, "pbs", cred, "/version"),
    api(host, "pbs", cred, "/admin/datastore")
  ]);
  if (!useRes.ok) return { error: useRes.error, note: useRes.error };

  /* Was der Betreiber am Datastore hinterlegt hat: Kommentar und, wenn
     gesetzt, der Wartungsmodus. Fehlt das Recht dafür, fehlt eben die
     Beschriftung — die Belegung steht davon unberührt. */
  const beschriftung = new Map();
  for (const d of (dsRes.ok ? dsRes.data?.data || [] : [])) {
    if (!d?.store) continue;
    beschriftung.set(d.store, {
      comment: d.comment || null,
      wartung: wartungsText(d.maintenance ?? d["maintenance-mode"])
    });
  }

  const alle = alleRes.ok ? (alleRes.data?.data || []) : [];
  const namen = new Set((useRes.data?.data || []).map(d => d.store).filter(Boolean));

  const stores = (useRes.data?.data || []).map(d => {
    const b = beschriftung.get(d.store) || {};
    const letzte = letzteAufgaben(alle, d.store, namen);
    return {
      name: d.store,
      used: d.total ? pct(d.used / d.total) : null,
      usedBytes: zahl(d.used), totalBytes: zahl(d.total),
      /* PBS meldet den freien Platz selbst; ihn aus total − used zu
         rechnen wäre bei ZFS mit Reservierungen schlicht falsch. */
      availBytes: zahl(d.avail),
      /* Wann der Datastore voll ist, schätzt PBS aus seinem eigenen
         Verlauf. Ohne diese Angabe bleibt es bei null: eine Hochrechnung
         über zwei Messpunkte wäre geraten, nicht gewusst. */
      vollAm: vollDatum(d),
      vollInTagen: vollTage(d),
      comment: b.comment || null,
      wartung: b.wartung || null,
      ...letzte
    };
  });

  const out = {
    version: verRes.ok ? verRes.data?.data?.version : null,
    datastores: stores.length, stores, schwellen: grenze
  };
  const fullest = stores.filter(s => s.used != null).sort((a, b) => b.used - a.used)[0];
  out.used = fullest ? fullest.used : null;

  const tasks = fehlRes.ok ? (fehlRes.data?.data || []) : [];
  const failed = tasks.filter(t => t.status && t.status !== "OK" && t.endtime && (Date.now() / 1000 - t.endtime) < 86400);
  out.failed = failed.length;

  /* Bald voll ist etwas anderes als voll: die Zahl kommt von PBS, und sie
     ist die einzige, die eine Nacht im Voraus warnt statt am Morgen
     danach zu melden. Rot wird davon nichts — dafür ist die Belegung da. */
  const knapp = stores.filter(s => s.vollInTagen != null && s.vollInTagen <= 14)
    .sort((a, b) => a.vollInTagen - b.vollInTagen)[0];

  if (failed.length) {
    const f = failed[0];
    out.status = "crit";
    out.note = `${failed.length} fehlgeschlagene Aufgabe(n) in 24 h — zuletzt ${f.worker_type || "Job"} ${f.worker_id || ""}`.trim();
  } else if (fullest && fullest.used >= grenze.disk_crit) { out.status = "crit"; out.note = `Datastore ${fullest.name} zu ${fullest.used} % belegt (kritisch ab ${grenze.disk_crit} %)`; }
  else if (fullest && fullest.used >= grenze.disk_warn) { out.status = "warn"; out.note = `Datastore ${fullest.name} zu ${fullest.used} % belegt`; }
  else if (knapp) {
    out.status = "warn";
    out.note = knapp.vollInTagen <= 0
      ? `Datastore ${knapp.name} ist nach eigener Schätzung von PBS voll`
      : `Datastore ${knapp.name} ist in ${knapp.vollInTagen} Tag(en) voll — geschätzt von PBS selbst`;
  }

  const ok = tasks.find(t => t.status === "OK" && t.endtime);
  out.lastGood = ok ? new Date(ok.endtime * 1000).toISOString() : null;
  /* Der letzte Erfolg steht in der gefilterten Liste nur zufällig — die
     ungefilterte kennt ihn immer. */
  if (!out.lastGood) {
    const jung = alle.filter(t => t.status === "OK" && t.endtime).sort((a, b) => b.endtime - a.endtime)[0];
    out.lastGood = jung ? new Date(jung.endtime * 1000).toISOString() : null;
  }
  return out;
}

/* PBS hängt den Datastore vor die Kennung der Aufgabe:
     backup   → „main:host/web-01/2026-08-23T01:00:00Z"
     verify   → „main" oder „main:snapshot"
     gc       → „main"
   Alles vor dem ersten Doppelpunkt ist der Datastore — aber nur, wenn es
   auch einer ist. Sonst hieße ein Sicherungslauf namens „vm/101" ein
   Datastore, und die Zeile stünde beim falschen. */
export function storeAus(workerId, namen) {
  const s = String(workerId || "").split(":")[0].trim();
  if (!s) return null;
  if (namen && !namen.has(s)) return null;
  return s;
}

const ART = [
  ["lastBackup", "backupOk", t => /^backup$/.test(t)],
  ["lastGc", "gcOk", t => /garbage/.test(t)],
  ["lastVerify", "verifyOk", t => /^verif/.test(t)],
  ["lastPrune", "pruneOk", t => /^prune$/.test(t)]
];

/* Wann an diesem Datastore zuletzt gesichert, aufgeräumt und geprüft
   wurde — und ob es glückte. Läuft eine Art noch nie, bleibt sie null:
   „noch nie aufgeräumt" ist eine Auskunft, „vor 0 Tagen" wäre eine
   Falschmeldung. */
export function letzteAufgaben(tasks, store, namen) {
  const out = {};
  for (const [feld, okFeld] of ART) { out[feld] = null; out[okFeld] = null; }
  const meine = (tasks || [])
    .filter(t => t?.endtime && storeAus(t.worker_id ?? t.id, namen) === store)
    .sort((a, b) => b.endtime - a.endtime);
  for (const [feld, okFeld, passt] of ART) {
    const t = meine.find(x => passt(String(x.worker_type ?? x.type ?? "")));
    if (!t) continue;
    out[feld] = new Date(t.endtime * 1000).toISOString();
    out[okFeld] = t.status === "OK";
  }
  return out;
}

/* PBS schätzt selbst, wann ein Datastore voll ist — als Zeitstempel in
   Sekunden, und 0 heißt „keine Schätzung möglich". */
function vollDatum(d) {
  const ts = zahl(d?.["estimated-full-date"] ?? d?.estimated_full_date);
  return ts > 0 ? new Date(ts * 1000).toISOString() : null;
}
function vollTage(d) {
  const ts = zahl(d?.["estimated-full-date"] ?? d?.estimated_full_date);
  if (!(ts > 0)) return null;
  return Math.max(0, Math.round((ts * 1000 - Date.now()) / 86400000));
}

/* Der Wartungsmodus kommt je nach Fassung als Text oder als Objekt. */
function wartungsText(m) {
  if (!m) return null;
  if (typeof m === "string") return m;
  if (typeof m === "object") return m.type || m.mode || null;
  return null;
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
const zahl = v => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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
