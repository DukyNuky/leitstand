/* Aus Bestand + Messwerten die Form bauen, die die Oberfläche erwartet.

   Diese Antwort ist die einzige Quelle der Oberfläche (ui/assets/app.js) —
   es gibt keinen Beispielbestand mehr, auf den sie zurückfallen könnte.
   Was Stufe 1 nicht wissen kann, steht deshalb ausdrücklich auf null und
   wird als Strich angezeigt — nie als Fantasiewert. */

import { TYPES, schwellenFuer } from "./inventory.js";
import { frischerPeer } from "./engine.js";
import { buildInfo } from "./version.js";

const uiStatus = s => (s === "unknown" ? "idle" : s);
const STARTED = new Date().toISOString();

export function buildState(engine, secrets, bestand = null) {
  const inv = engine.inv;
  const hosts = inv.hosts.map(h => hostView(h, engine.hosts.get(h.id), inv.settings));
  const byId = new Map(hosts.map(h => [h.id, h]));

  return {
    meta: {
      live: true,
      lastRun: engine.lastRun,
      interval: inv.settings.interval,
      counts: {
        hosts: hosts.length, sites: inv.sites.length, tunnels: inv.tunnels.length,
        monitored: hosts.filter(h => h.monitored).length
      },
      /* Die Einstellungen-Ansicht zeigt damit den tatsächlichen Stand statt
         einer abgeschriebenen Liste. Schwellwerte, die hier nicht stehen,
         gibt es nicht — sie können also auch nicht behauptet werden. */
      settings: { ...inv.settings },
      runtime: {
        started: STARTED,
        node: process.version,
        icmp: icmpState(inv, engine),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
        /* Welcher Stand hier läuft. Die Oberfläche vergleicht das bei jedem
           Zustand mit dem, was sie beim Laden bekommen hat — wird nach einem
           Redeploy neu ausgeliefert, merkt sie es und bietet Neuladen an. */
        build: buildInfo(),
        /* Woher der Bestand kommt und ob der Dienst ihn beim Start selbst
           angelegt hat. Ohne diese Angabe sieht ein frisch angelegter,
           leerer Bestand genauso aus wie ein absichtlich leerer — und die
           Frage „wo sind meine Systeme hin?" ist von der Oberfläche aus
           nicht zu beantworten. */
        bestand,
        /* Wo die Zeitreihen liegen, wie weit sie zurückreichen und was sie
           belegen. Die Einstellungen-Ansicht zeigt das, damit niemand raten
           muss, ob überhaupt geschrieben wird — und ein Schreibfehler
           (volles Volume) sichtbar wird, statt still zu bleiben. */
        verlauf: engine.verlauf ? engine.verlauf.info() : null
      },
      generated: new Date().toISOString()
    },
    sites: inv.sites.map(s => siteView(s, hosts, inv, engine)),
    hosts,
    tunnels: inv.tunnels.map(t => tunnelView(t, engine.tunnels.get(t.id))),
    incidents: incidentViews(engine),
    certs: certViews(hosts),
    links: linkViews(inv, byId, engine),
    integrations: integrationViews(inv, secrets, engine),
    peers: peerViews(inv, engine),
    backups: backupViews(hosts),
    /* Diese Bereiche kennt der Dienst noch nicht — leer statt erfunden. */
    haproxy: [], mails: [], mailrules: [], routes: []
  };
}

/* ICMP ist die Prüfung, die am ehesten still ausfällt: im Container fehlt
   `ping` oder die Fähigkeit NET_RAW. Dann wird übersprungen statt gemeldet —
   und genau das gehört sichtbar gemacht, sonst hält man TCP-Grün für
   vollständige Erreichbarkeit. */
function icmpState(inv, engine) {
  if (!inv.settings.icmp) return { configured: false, working: null, note: "in den Schwellwerten abgeschaltet" };
  const alle = [...engine.hosts.values()].flatMap(st => st.checks || []).filter(c => c.kind === "icmp");
  if (!alle.length) return { configured: true, working: null, note: "noch keine ICMP-Prüfung gelaufen" };
  const skipped = alle.filter(c => c.skipped);
  if (skipped.length === alle.length)
    return { configured: true, working: false, note: skipped[0].detail || "wird übersprungen" };
  return { configured: true, working: true, note: `${alle.length - skipped.length} von ${alle.length} Prüfungen laufen` };
}

/* Road-Warrior und Site-to-Site-Gegenstellen, so wie die Firewalls sie
   melden. Ein Peer hat selbst keinen Standort — er bekommt den des
   Geräts, das ihn kennt. */
function peerViews(inv, engine) {
  /* Welche Gegenstelle trägt eine angelegte Strecke? Der Tunnelzustand hat
     die Zuordnung bereits aufgelöst — hier wird sie nur umgedreht, damit
     die Peertabelle sie anzeigen kann, statt sie ein zweites Mal (und
     womöglich anders) zu bestimmen. */
  const streckeJePeer = new Map();
  for (const t of inv.tunnels) {
    const st = engine.tunnels.get(t.id);
    /* Beide Enden, nicht nur eines: eine Strecke hat zwei, und jede
       Firewall meldet die andere Seite. Wäre hier nur das erste Ende
       eingetragen, stünde die Gegenzeile in dieser Tabelle für immer
       auf „keiner Strecke zugeordnet" — mitten in einer Strecke. */
    for (const p of [st?.peer, st?.peerB]) {
      if (p) streckeJePeer.set(`${p.host}|${p.iface || ""}|${p.key || p.name}`, t.id);
    }
  }

  const out = [];
  for (const h of inv.hosts) {
    const liste = engine.hosts.get(h.id)?.extra?.peers;
    if (!Array.isArray(liste)) continue;
    for (const p of liste) {
      out.push({
        key: p.key || null,
        tunnel: streckeJePeer.get(`${h.id}|${p.iface || ""}|${p.key || p.name}`) || null,
        id: [h.id, p.iface || "wg", p.name].join("/"),
        name: p.name,
        device: p.allowed ? "erlaubt: " + p.allowed : (p.iface || ""),
        site: h.site, von: h.id, iface: p.iface || null,
        /* Die erlaubten Netze, aufgeteilt in das, was eine Adresse im
           Tunnel ist, und das, was dahinter liegt. Damit muss niemand
           mehr abschreiben, was die Firewall ohnehin weiß. */
        allowed: p.allowed || null,
        ...netzeAus(p.allowed),
        /* Ruhend ist nicht gestört: ein Endgerät darf aus sein. Gemeldet
           wird das Handshake-Alter, bewertet wird es zurückhaltend. */
        status: p.handshake == null ? "idle"
          : p.handshake <= 180 ? "ok"
          : p.handshake <= 600 ? "warn" : "idle",
        handshake: p.handshake,
        seit: p.seit || null,
        ip: p.allowed || "—",
        endpoint: p.endpoint || "—",
        rx: bytes(p.rx), tx: bytes(p.tx)
      });
    }
  }
  return out.sort((a, b) => (a.handshake ?? 1e9) - (b.handshake ?? 1e9));
}

/* Menschenlesbar, ohne Nachkommastellen-Theater. */
function bytes(n) {
  if (n == null || !Number.isFinite(n)) return null;
  const e = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < e.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + " " + e[i];
}

function hostView(h, st = {}, settings = {}) {
  const x = st.extra || {};
  return {
    id: h.id,
    /* Die Schwellwerte, nach denen für dieses System tatsächlich gemessen
       wird — die globalen, von den eigenen überschrieben. Die Oberfläche
       zeigt sie an und lässt sie bearbeiten; ohne diese Angabe stünde dort
       eine Zahl aus den Einstellungen, während der Sammler nach einer
       anderen entscheidet. */
    schwellen: schwellenFuer(h, settings),
    schwellenEigen: h.schwellen || null,
    name: h.name || h.id,
    type: h.type,
    site: h.site,
    role: h.role || TYPES[h.type]?.label || "",
    ip: h.ip || null,
    url: h.url || null,
    status: uiStatus(st.status || "unknown"),
    note: st.note || x.note || null,
    version: x.version || null,
    ms: st.ms ?? null,
    hist: (st.hist || []).slice(-24),
    lastSeen: st.lastSeen || null,
    monitored: h.monitor !== false,
    checks: (st.checks || []).map(c => ({
      kind: c.kind, port: c.port || null, ok: c.ok, ms: c.ms ?? null,
      detail: c.detail || null, skipped: !!c.skipped,
      /* Eine als wesentlich gekennzeichnete Prüfung ist nicht eine von
         mehreren, sondern der Dienst selbst — die Oberfläche hebt sie
         deshalb hervor statt sie in einer Reihe mit den übrigen zu zeigen. */
      wesentlich: !!c.wesentlich
    })),
    tls: st.tls || null,
    /* Ob dieses System sein Zertifikat bewertet bekommt — das Formular
       braucht die Stellung des Schalters, die Zertifikatsliste den Grund. */
    tlsIgnore: !!h.tls_ignore,
    /* aus einem Sammler, sonst null */
    cpu: x.cpu ?? null, ram: x.ram ?? null, disk: x.disk ?? null,
    vms: x.vms ?? null, lxc: x.lxc ?? null, running: x.running ?? null, stopped: x.stopped ?? null,
    uptime: x.uptime || null, cluster: x.cluster || null, quorum: x.quorum ?? null,
    /* Proxmox VE: Knoten im Einzelnen und seine Gäste */
    node: x.node || null, nodeStatus: x.nodeStatus || null, uptimeSeconds: x.uptimeSeconds ?? null,
    kernel: x.kernel || null, pveVersion: x.pveVersion || null,
    cores: x.cores ?? null, sockets: x.sockets ?? null, cpuModel: x.cpuModel || null,
    load1: x.load1 ?? null, rootUsed: x.rootUsed ?? null, swap: x.swap ?? null,
    updatesNote: x.updatesNote || null, updateListe: x.updateListe || null,
    guests: x.guests || null, templates: x.templates ?? null,
    /* Sicherungsaufträge des Knotens und was von ihnen gelaufen ist */
    backupJobs: x.backupJobs || null, backupLaeufe: x.backupLaeufe || null,
    backupNote: x.backupNote || null,
    storages: x.storages || null, stores: x.stores || null,
    used: x.used ?? null, failed: x.failed ?? null, lastGood: x.lastGood || null,
    in24: x.in24 ?? null, spam: x.spam ?? null, virus: x.virus ?? null,
    /* OPNsense */
    abi: x.abi || null, os: x.os || null,
    updates: x.updates ?? null, majorUpgrade: x.majorUpgrade || null,
    needsReboot: x.needsReboot ?? null, lastCheck: x.lastCheck || null,
    ramTotalMb: x.ramTotalMb ?? null, ramArcMb: x.ramArcMb ?? null,
    disks: x.disks || null, load: x.load || null,
    thrIn: x.thrIn ?? null, thrOut: x.thrOut ?? null, thrQuelle: x.thrQuelle || null,
    interfaces: x.interfaces || null,
    wgPeers: x.wgPeers ?? null, wgIfaces: x.wgIfaces ?? null, wgStill: x.wgStill ?? null,
    wgHandshakeUnbekannt: x.wgHandshakeUnbekannt ?? null, wgNote: x.wgNote || null,
    /* pfSense — Gateways, Zustandstabelle und CARP kennt OPNsense hier
       noch nicht; die Felder bleiben dort null und werden als Strich
       gezeigt statt als Null. */
    apiFassung: x.api || null,
    gateways: x.gateways || null,
    states: x.states ?? null, statesMax: x.statesMax ?? null, statesPct: x.statesPct ?? null,
    carp: x.carp || null, carpWartung: x.carpWartung ?? null,
    tempC: x.tempC ?? null,
    /* AdGuard Home */
    dnsQueries: x.dnsQueries ?? null, dnsBlocked: x.dnsBlocked ?? null, blockRate: x.blockRate ?? null,
    avgMs: x.avgMs ?? null, statsFenster: x.statsFenster || null,
    protection: x.protection ?? null, dnsRunning: x.dnsRunning ?? null, filtering: x.filtering ?? null,
    filters: x.filters ?? null, filtersAktiv: x.filtersAktiv ?? null, filterRules: x.filterRules ?? null,
    filterStand: x.filterStand || null, upstreams: x.upstreams ?? null,
    /* Portainer */
    endpoints: x.endpoints ?? null, endpointsDown: x.endpointsDown ?? null,
    stacks: x.stacks ?? null, stacksInaktiv: x.stacksInaktiv ?? null,
    containers: x.containers ?? null, unhealthy: x.unhealthy ?? null,
    restarting: x.restarting ?? null, oom: x.oom ?? null,
    umgebungen: x.umgebungen || null, probleme: x.probleme || null,
    containerNote: x.containerNote || null,
    collectorError: x.error || null
  };
}

function siteView(s, hosts, inv, engine) {
  const mine = hosts.filter(h => h.site === s.id);
  const tuns = inv.tunnels
    .filter(t => t.a === s.id || t.b === s.id)
    .map(t => engine.tunnels.get(t.id))
    .filter(Boolean);
  const reachable = mine.filter(h => h.status !== "crit" && h.monitored);
  const down = mine.length > 0 && mine.filter(h => h.monitored).length > 0 && reachable.length === 0;
  return {
    id: s.id, name: s.name, short: s.short || shortOf(s), place: s.place || "",
    isp: s.isp || "—", wan: s.wan || "—", wan6: s.wan6 || "—",
    primary: !!s.primary,
    uptimeDays: s.uptimeDays ?? null,
    down,
    hosts: mine.length,
    problems: mine.filter(h => h.status === "warn" || h.status === "crit").length,
    tunnelsOk: tuns.filter(t => t.status === "ok").length,
    tunnels: tuns.length
  };
}

/* Nur Notbehelf für Bestände aus der Zeit vor der Vierstelligkeit: aus der
   Kennung wird etwas Anzeigbares gemacht, damit Filterleiste und Topologie
   nicht leer bleiben. Gepflegt wird das Kürzel in der Verwaltung. */
function shortOf(s) {
  return String(s.id || "—").slice(0, 4).toUpperCase();
}

/* Ein Tunnel wird auf zwei Weisen beurteilt, und die Oberfläche soll
   auseinanderhalten können, welche gerade zählt:

   „probe"     — es wird durch den Tunnel auf die Gegenstelle gemessen.
                 Das beantwortet die eigentliche Frage: trägt die Strecke?
   „handshake" — es gibt keine Gegenstelle, dafür einen verknüpften Peer
                 auf einer Firewall. Der Handshake sagt, dass die Strecke
                 stand, nicht dass gerade etwas hindurchkommt.

   Ist beides da, misst der Prober und der Peer liefert zusätzlich
   Handshake und Mengen. */
function tunnelView(t, st = {}) {
  const p = st.peer || null;
  const pb = st.peerB || null;
  /* Für Handshake und Mengen zählt das frischere Ende — genau wie im
     Kern, der daraus den Zustand ableitet. Zwei Stellen, die dieselbe
     Frage verschieden beantworten, wären schlimmer als eine Zahl weniger. */
  const frisch = frischerPeer(p, pb);
  const a = peerBlock(t.peer, p, st.peerNote);
  const b = peerBlock(t.peerB, pb, st.peerBNote);
  return {
    id: t.id, a: t.a, b: t.b,
    iface: p?.iface || pb?.iface || t.iface || "wg0",
    net: t.net || "—",
    status: uiStatus(st.status || "unknown"),
    rtt: st.ms ?? null,
    loss: null,                 /* braucht mehrere Pakete — kommt mit dem Dauerprober */
    quelle: t.probe?.ip ? "probe" : "handshake",
    /* Handshake-Alter in Sekunden, sobald ein Peer verknüpft und gefunden
       ist — sonst weiterhin null, nicht null-als-Zahl. */
    handshake: frisch?.handshake ?? null,
    rx: bytes(frisch?.rx), tx: bytes(frisch?.tx),
    peer: a,
    peerB: b,
    /* Wie weit die beiden Enden auseinanderliegen. Null heißt „nichts zu
       vergleichen", nicht „einig". */
    peerAbstand: st.peerAbstand ?? null,
    /* Was die Firewalls über die Strecke selbst wissen: die Adressen im
       Transfernetz und die Netze dahinter. Beides steht in den erlaubten
       Netzen der Peers und musste bisher von Hand abgeschrieben werden. */
    ips: vereinen(a?.ips, b?.ips),
    netze: vereinen(a?.netze, b?.netze),
    mtu: t.mtu || null, keepalive: t.keepalive || null,
    probe: t.probe?.ip || null,
    /* Damit das Formular den Port beim Bearbeiten nicht verliert. */
    probePort: t.probe?.port || null,
    hist: (st.hist || []).slice(-24),
    lastSeen: st.lastSeen || null,
    note: st.note || null
  };
}

/* Ein Ende der Strecke: was hinterlegt ist, ergänzt um das, was die
   Firewall gerade meldet. Ohne Hinterlegung gibt es kein Ende — dann
   steht hier null und nicht ein Objekt voller Striche. */
function peerBlock(ref, p, note) {
  if (!ref) return null;
  const allowed = p?.allowed || null;
  const { ips, netze } = netzeAus(allowed);
  return {
    host: ref.host,
    name: p?.name || ref.name || null,
    key: p?.key || ref.key || null,
    iface: p?.iface || ref.iface || null,
    endpoint: p?.endpoint || null,
    allowed,
    ips, netze,
    handshake: p?.handshake ?? null,
    rx: bytes(p?.rx), tx: bytes(p?.tx),
    seit: p?.seit || null,
    keepalive: p?.keepalive || null,
    gefunden: !!p,
    note: note || null
  };
}

/* Was eine Firewall als „allowed-ips" meldet, ist zweierlei in einer
   Zeile: die Adresse des anderen Endes im Transfernetz — eine /32
   beziehungsweise /128 — und die Netze, die dahinter geroutet werden.
   Getrennt ausgewiesen, weil man das eine anpingt und das andere nicht.

   Ohne Präfix gilt die Angabe als einzelne Adresse: so schreibt es
   niemand, aber wenn doch, ist sie eher ein Host als ein Netz. */
export function netzeAus(allowed) {
  const ips = [], netze = [];
  for (const teil of String(allowed || "").split(/[,\s]+/)) {
    const t = teil.trim();
    if (!t) continue;
    const [adr, praefix] = t.split("/");
    if (!adr) continue;
    const p = Number(praefix);
    const voll = adr.includes(":") ? 128 : 32;
    if (praefix === undefined || p === voll) ips.push(adr);
    else if (Number.isFinite(p)) netze.push(t);
  }
  return { ips, netze };
}

const vereinen = (...listen) => [...new Set(listen.flat().filter(Boolean))];

function incidentViews(engine) {
  const now = Date.now();
  const alle = [...engine.incidents.values()];
  const mitbetroffen = new Map();
  for (const i of alle) if (i.suppressedBy) mitbetroffen.set(i.suppressedBy, (mitbetroffen.get(i.suppressedBy) || 0) + 1);

  return alle
    .filter(i => !i.suppressedBy)                       /* Folgemeldungen hängen an der Standortmeldung */
    .filter(i => !i.silencedUntil || new Date(i.silencedUntil) < now)
    .map(i => ({
      id: i.id, sev: i.sev, host: i.host, site: i.site, title: i.title,
      detail: i.detail, note: i.note, rule: i.rule, src: i.src,
      first: fmtTime(i.first), ageMin: Math.round((now - new Date(i.first)) / 60000),
      count: i.count, ack: !!i.ack, kind: i.kind,
      affected: i.affected || null,
      rollup: mitbetroffen.get(i.fingerprint) || 0
    }))
    .sort((a, b) => sevRank(a.sev) - sevRank(b.sev) || a.ageMin - b.ageMin);
}
const sevRank = s => ({ crit: 0, warn: 1, info: 2 }[s] ?? 3);

/* Ein nicht bewertetes Zertifikat verschwindet nicht aus der Liste — es
   verliert nur seine Ampel. Wer wissen will, was da abgelaufen ist,
   findet es weiter; wer auf Farben schaut, wird nicht davon abgelenkt. */
function certViews(hosts) {
  return hosts
    .filter(h => h.tls && h.tls.days != null)
    .map(h => ({
      cn: h.tls.cn || h.name,
      issuer: h.tls.issuer || "unbekannt",
      days: h.tls.days,
      where: `${h.name}${h.tls.port ? ":" + h.tls.port : ""}`,
      selfSigned: !!h.tls.selfSigned,
      bewertet: h.tls.bewertet !== false,
      status: h.tls.bewertet === false ? "idle"
        : h.tls.days <= 14 ? "crit" : h.tls.days <= 30 ? "warn" : "ok"
    }))
    .sort((a, b) => a.days - b.days);
}

/* Sicherungsaufträge über alle Knoten hinweg — eine Tabelle statt einer
   je System, weil die Frage „ist heute Nacht gesichert worden?" nicht am
   einzelnen Knoten hängt.

   Die Ampel der Zeile ist die des letzten Laufs, nicht die des Systems:
   ein Knoten kann tadellos laufen und trotzdem seit drei Tagen nichts
   gesichert haben. Ein abgeschalteter Auftrag bleibt grau — er ist keine
   Störung, sondern eine Entscheidung. */
function backupViews(hosts) {
  const out = [];
  for (const h of hosts) {
    for (const j of h.backupJobs || []) {
      out.push({
        host: h.id, hostName: h.name, node: h.node || null,
        id: j.id, name: j.name, aktiv: j.aktiv,
        zeitplan: j.zeitplan, ziel: j.ziel, modus: j.modus, umfang: j.umfang,
        naechster: j.naechster,
        zuletzt: j.zuletzt, letzterStatus: j.letzterStatus,
        zuletztOk: j.zuletztOk, zuletztFehler: j.zuletztFehler,
        laeufe: j.laeufe ?? null,
        quelle: j.quelle,
        status: !j.aktiv ? "idle"
          : j.letzterStatus === "fehler" ? "crit"
          : j.letzterStatus === "warn" ? "warn"
          : j.letzterStatus === "ok" ? "ok" : "idle"
      });
    }
  }
  return out;
}

function linkViews(inv, byId, engine) {
  return inv.links.map(g => ({
    name: g.group,
    links: g.items.map(i => {
      const h = i.host ? byId.get(i.host) : null;
      const url = i.url || (h ? h.url : "#");
      /* Die Ampel der Kachel kommt vom verknüpften System, wenn es eines
         gibt — das ist die belastbarere Aussage. Sonst, und nur wenn
         ausdrücklich gewünscht, aus dem Abruf der Adresse selbst. Ist
         beides nicht der Fall, bleibt die Kachel grau: ein Lesezeichen
         behauptet nichts. */
      const pruefung = !h && i.pruefen ? engine?.linkChecks.get(url) : null;
      return {
        n: i.name || (h ? h.name : i.url), u: url, h: i.host || null,
        p: !!i.pruefen && !h,
        st: pruefung ? pruefung.status : null,
        ms: pruefung ? pruefung.ms : null,
        detail: pruefung ? pruefung.detail : null,
        stand: pruefung ? new Date(pruefung.stand).toISOString() : null
      };
    })
  }));
}

/* Die Ansicht „Einstellungen → Datenquellen“ spiegelt den echten Stand:
   welcher Typ ist wie oft vorhanden, wo liegen Zugangsdaten, was wird
   bislang nur angepingt. */
function integrationViews(inv, secrets, engine) {
  const byType = new Map();
  for (const h of inv.hosts) {
    const e = byType.get(h.type) || { type: h.type, targets: 0, withCred: 0, errors: 0 };
    e.targets++;
    if (secrets?.has(h.id)) e.withCred++;
    const st = engine.hosts.get(h.id);
    if (st?.extra?.error) e.errors++;
    byType.set(h.type, e);
  }
  return [...byType.values()].map(e => {
    const t = TYPES[e.type] || { label: e.type, api: null };
    const supported = !!t.api;
    return {
      name: t.label,
      type: e.type,
      method: !supported ? "nur Erreichbarkeit (Prüfung ohne Zugang)"
        : e.withCred ? (t.zugang || "API-Token") : `${t.zugang || "API-Token"} — noch nicht hinterlegt`,
      targets: e.targets,
      /* Wie viele davon einen Zugang haben und ob es für den Typ
         überhaupt einen Sammler gibt — die Kurzlage rechnet daraus aus,
         worüber ihre grüne Fläche schweigt. Als Zahl, nicht als Satz:
         einen Satz müsste sie zerlegen, und das ginge einmal schief. */
      mitZugang: e.withCred,
      unterstuetzt: supported,
      every: `${inv.settings.interval} s`,
      status: e.errors ? "warn" : (supported && !e.withCred) ? "idle" : "ok",
      note: e.errors ? `${e.errors} System(e) melden einen Fehler beim Abruf`
        : supported
          ? (e.withCred ? `${e.withCred} von ${e.targets} mit Zugangsdaten` : "In der Verwaltung Zugangsdaten hinterlegen")
          : "Sammler folgt in einer späteren Stufe"
    };
  }).sort((a, b) => b.targets - a.targets);
}

function fmtTime(iso) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const t = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return today ? t : `${d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })} ${t}`;
}
