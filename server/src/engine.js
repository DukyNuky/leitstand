/* Zustandsmaschine.

   Führt Prüfungen aus, hält Verlauf, leitet Ampeln ab und bündelt
   gleichartige Meldungen zu einer Störung. Bewusst ohne Datenbank:
   der Zustand liegt im Speicher, die Störungen werden als JSON
   weggeschrieben, damit Quittierungen einen Neustart überleben. */

import fs from "node:fs";
import { runCheck } from "./probe.js";

const SEV = { ok: 0, info: 1, warn: 2, crit: 3 };
const worse = (a, b) => (SEV[a] >= SEV[b] ? a : b);

export class Engine {
  constructor(inv, opts = {}) {
    this.inv = inv;
    this.statePath = opts.statePath || null;
    this.collectors = opts.collectors || {};      /* typ -> async (host) => Zusatzdaten */
    this.verlauf = opts.verlauf || null;          /* Zeitreihen-Ablage, siehe verlauf.js */
    this.hosts = new Map();
    this.tunnels = new Map();
    this.linkChecks = new Map();                  /* url -> Ampel einer Startseiten-Kachel */
    this.incidents = new Map();                   /* fingerprint -> Störung */
    this.seq = 0;
    this.lastRun = null;
    this.running = false;
    this.laufend = null;                          /* Zusage des gerade laufenden Durchlaufs */
    this.timer = null;
    this.listeners = new Set();
    this.#seed();
    this.#loadState();
  }

  #seed() {
    for (const h of this.inv.hosts) {
      this.hosts.set(h.id, {
        id: h.id, status: h.monitor === false ? "idle" : "unknown",
        ms: null, hist: [], fails: 0, wfails: 0, lastSeen: null, lastRun: null,
        checks: [], note: null, extra: {}, tls: null
      });
    }
    for (const t of this.inv.tunnels) {
      this.tunnels.set(t.id, { id: t.id, status: "unknown", ms: null, hist: [], fails: 0, lastSeen: null, note: null });
    }
  }

  /* Bestand austauschen, ohne den Verlauf zu verlieren. */
  reload(inv) {
    this.inv = inv;
    const keepHosts = this.hosts, keepTunnels = this.tunnels;
    this.hosts = new Map(); this.tunnels = new Map();
    this.#seed();
    for (const [id, old] of keepHosts) if (this.hosts.has(id)) this.hosts.set(id, { ...this.hosts.get(id), ...old });
    for (const [id, old] of keepTunnels) if (this.tunnels.has(id)) this.tunnels.set(id, { ...this.tunnels.get(id), ...old });
    /* Störungen zu entfernten Systemen schließen */
    for (const [fp, inc] of this.incidents)
      if (inc.host && !this.hosts.has(inc.host) && !this.tunnels.has(inc.host)) this.incidents.delete(fp);
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #emit() { for (const fn of this.listeners) { try { fn(this); } catch {} } }

  /* Der Bestand hat sich geändert, ohne dass gemessen wurde. Eine
     Konfigurationsänderung ist auch ein Zustandswechsel: der neue Standort
     ist da, er ist nur noch ungeprüft. Ohne diese Meldung sähe die
     Oberfläche ihn erst nach dem nächsten Durchlauf — und der dauert bei
     vielen stillen Systemen so lange, dass es wie ein Fehler aussieht. */
  announce() { this.#emit(); }

  /* ---------- Durchlauf ---------- */
  async runOnce() {
    /* Läuft schon einer, wird der abgewartet statt ein zweiter gestartet.
       Früher wurde der Aufruf einfach verworfen — „Jetzt prüfen" tat dann
       nichts, und zwar ausgerechnet dann, wenn ein Durchlauf lange braucht,
       weil viele Systeme still sind. */
    if (this.laufend) return this.laufend;
    this.laufend = this.#durchlauf();
    this.running = true;
    try { await this.laufend; }
    finally { this.laufend = null; this.running = false; }
  }

  async #durchlauf() {
    await Promise.all([
      ...this.inv.hosts.map(h => this.#checkHost(h)),
      ...this.inv.tunnels.map(t => this.#checkTunnel(t)),
      this.#checkLinks()
    ]);
    this.#peerZuTunnel();
    this.#rollup();
    this.lastRun = new Date().toISOString();
    this.#verlaufNotieren();
    this.#saveState();
    this.#emit();
  }

  start() {
    if (this.timer) return;
    const every = (this.inv.settings.interval || 15) * 1000;
    this.runOnce();
    this.timer = setInterval(() => this.runOnce(), every);
    if (this.timer.unref) this.timer.unref();
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    /* Was im laufenden Takt schon gemessen wurde, gehört auf die Platte,
       bevor der Prozess geht — sonst fehlt nach jedem Neustart die letzte
       Minute, und die ist die interessanteste. */
    this.verlauf?.schliesse();
  }

  /* ---------- Zeitreihen ----------
     Ein Punkt je Gegenstand und Durchlauf; verdichtet und geschrieben wird
     in verlauf.js. Hier steht nur, welche Kennzahlen es wert sind, Tage zu
     überdauern: die, die auf der Detailseite gezeichnet werden. */
  #verlaufNotieren() {
    if (!this.verlauf) return;
    const jetzt = Date.now();
    const s = this.inv.settings;
    this.verlauf.einstellen({ takt: s.verlauf_takt, tage: s.verlauf_tage });
    for (const h of this.inv.hosts) {
      const st = this.hosts.get(h.id);
      if (!st || st.status === "unknown") continue;
      const x = st.extra || {};
      this.verlauf.notiere("h", h.id, {
        ms: st.ms, st: st.status,
        cpu: zahl(x.cpu), ram: zahl(x.ram), disk: zahl(x.disk),
        in: zahl(x.thrIn), out: zahl(x.thrOut)
      }, jetzt);

      /* Je Schnittstelle eine eigene Reihe. Am System steht nur der
         Durchsatz der WAN-Seite; die Frage „auf welcher Leitung war das
         heute Nacht?" beantwortet nur eine Reihe je Schnittstelle.
         Gegenstandsart „i", Kennung `system|schnittstelle` — damit passt
         es ohne Sonderfall in dieselbe Ablage. Kosten: eine Zeile je
         Schnittstelle und Takt, rund 60 Byte. */
      for (const ifc of x.interfaces || []) {
        if (!ifc?.name) continue;
        if (!Number.isFinite(ifc.in) && !Number.isFinite(ifc.out)) continue;
        this.verlauf.notiere("i", `${h.id}|${ifc.name}`, { in: zahl(ifc.in), out: zahl(ifc.out) }, jetzt);
      }
    }
    for (const t of this.inv.tunnels) {
      const st = this.tunnels.get(t.id);
      if (!st || st.status === "unknown") continue;
      this.verlauf.notiere("t", t.id, { ms: st.ms, st: st.status }, jetzt);
    }
    this.verlauf.schreibe(jetzt);
  }

  /* ---------- Kacheln der Startseite ----------
     Eine Verknüpfung ohne verknüpftes System ist heute ein reines
     Lesezeichen: grauer Punkt, keine Aussage. Ist am Eintrag `pruefen`
     gesetzt, wird die Adresse selbst abgerufen — mehr nicht, ein GET und
     der Statuscode. Das beantwortet die einzige Frage, die eine Kachel
     stellt: komme ich da hin?

     Bewusst ohne Störung und ohne Quittieren: hinter diesen Kacheln
     stehen fremde Dienste und Seiten im Internet, für die niemand nachts
     geweckt werden will. Wer eine echte Überwachung braucht, legt ein
     System an.

     Eigener Takt, weil der Durchlauf alle 15 s kommt und eine fremde
     Seite so oft abzurufen unhöflich bis auffällig wäre. */
  async #checkLinks() {
    const s = this.inv.settings;
    const takt = Math.max(15, s.link_takt || 60) * 1000;
    const jetzt = Date.now();
    const gewollt = new Set();
    const faellig = [];

    for (const g of this.inv.links || []) {
      for (const it of g.items || []) {
        if (!it.pruefen || !it.url || it.host) continue;
        gewollt.add(it.url);
        const st = this.linkChecks.get(it.url);
        if (st && jetzt - st.stand < takt) continue;
        if (!faellig.includes(it.url)) faellig.push(it.url);
      }
    }
    /* Was niemand mehr anzeigt, wird auch nicht mehr geprüft. */
    for (const url of [...this.linkChecks.keys()]) if (!gewollt.has(url)) this.linkChecks.delete(url);

    await Promise.all(faellig.map(async url => {
      const alt = this.linkChecks.get(url);
      const r = await runCheck({ kind: "http", url }, {}, s);
      const fails = r.ok ? 0 : (alt?.fails || 0) + 1;
      /* Ein einzelner Fehlschlag ist Gelb, erst die Wiederholung Rot —
         dieselbe Zurückhaltung wie bei einem System. Eine Antwort mit
         Fehlercode ist etwas anderes als keine Antwort: der Dienst steht,
         er mag den Aufruf nur nicht. */
      const status = r.ok ? "ok"
        : /^HTTP \d/.test(r.detail || "") ? "warn"
        : fails >= (s.fail_threshold || 3) ? "crit" : "warn";
      this.linkChecks.set(url, {
        status, ms: r.ms ?? null, detail: r.detail || null,
        fails, stand: Date.now(), seit: r.ok ? new Date().toISOString() : alt?.seit || null
      });
    }));
  }

  /* ---------- Ein System ---------- */
  async #checkHost(h) {
    const st = this.hosts.get(h.id);
    if (!st) return;
    if (h.monitor === false) { st.status = "idle"; st.note = "absichtlich unüberwacht"; return; }

    const s = this.inv.settings;
    const results = [];
    for (const c of h.checks) {
      const r = await runCheck(c, h, s);
      results.push({ ...c, ...r });
    }
    st.checks = results;
    st.lastRun = new Date().toISOString();

    const hard = results.filter(r => !r.skipped && r.ok !== null);
    const failed = hard.filter(r => !r.ok);
    const reach = hard.find(r => r.ok);
    st.ms = reach ? reach.ms : null;
    st.reachable = !!reach;
    if (reach) { st.lastSeen = st.lastRun; st.fails = 0; }
    else if (hard.length) st.fails++;

    /* Manche Prüfungen sind nicht eine von mehreren, sondern der Dienst
       selbst — die DNS-Auflösung eines Resolvers etwa. Fällt sie aus,
       ist das kein Teilausfall neben einem offenen Port, sondern ein
       Ausfall. Gezählt wird getrennt, damit dafür dieselbe Zurückhaltung
       gilt wie bei „gar nicht erreichbar": erst die Wiederholung ist Rot. */
    const wesentlich = failed.filter(r => r.wesentlich);
    st.wfails = wesentlich.length ? (st.wfails || 0) + 1 : 0;

    /* TLS-Restlaufzeit merken — speist die Zertifikatsliste */
    const tlsRes = results.find(r => r.kind === "tls" && r.ok && r.extra);
    st.tls = tlsRes ? { ...tlsRes.extra, port: tlsRes.port } : null;

    /* Zusatzdaten aus einem Sammler (Proxmox u. a.), falls hinterlegt */
    const collector = this.collectors[h.type];
    if (collector && reach) {
      try {
        const extra = await collector(h, this.inv.settings);
        if (extra) { st.extra = extra; if (extra.error) st.extra.error = extra.error; }
      } catch (e) { st.extra = { ...st.extra, error: e.message }; }
    }

    /* ---- Ampel ---- */
    let status = "ok", note = null;
    if (!hard.length) { status = "idle"; note = "keine auswertbare Prüfung"; }
    else if (!reach) {
      status = st.fails >= (s.fail_threshold || 3) ? "crit" : "warn";
      note = `${failed[0].kind.toUpperCase()}: ${failed[0].detail}` +
             (status === "warn" ? ` (${st.fails}. Fehlschlag)` : ` — seit ${st.fails} Durchläufen`);
    } else if (wesentlich.length) {
      const w = wesentlich[0];
      status = st.wfails >= (s.fail_threshold || 3) ? "crit" : "warn";
      note = `${w.kind.toUpperCase()}${w.port ? "/" + w.port : ""}: ${w.detail}`
        + (status === "warn" ? ` (${st.wfails}. Fehlschlag)` : ` — seit ${st.wfails} Durchläufen`);
    } else if (failed.length) {
      status = "warn";
      note = `Teilausfall: ${failed.map(f => `${f.kind}${f.port ? "/" + f.port : ""} ${f.detail}`).join(", ")}`;
    } else if (st.ms != null && st.ms > (s.slow_ms || 800)) {
      status = "warn"; note = `langsame Antwort: ${st.ms} ms`;
    }

    if (st.tls) {
      const d = st.tls.days;
      const text = d < 0 ? `Zertifikat seit ${Math.abs(d)} Tagen abgelaufen`
        : d === 0 ? "Zertifikat läuft heute ab"
        : `Zertifikat läuft in ${d} Tagen ab`;
      if (d <= (s.tls_crit_days ?? 14)) { status = worse(status, "crit"); note = note || text; }
      else if (d <= (s.tls_warn_days ?? 30)) { status = worse(status, "warn"); note = note || text; }
    }
    if (st.extra?.status && SEV[st.extra.status] > SEV[status]) { status = st.extra.status; note = st.extra.note || note; }
    /* Ein Sammler, der nicht liefert, darf nicht stillschweigend fehlen:
       erreichbar mit unbrauchbarem Zugang ist ein Konfigurationsfehler
       und gehört auf Gelb, sonst sucht man später lange nach der Ursache. */
    else if (st.extra?.error && status === "ok") { status = "warn"; note = `Abruf nicht möglich: ${st.extra.error}`; }

    st.status = status;
    st.note = note;
    if (st.ms != null) push(st.hist, st.ms, s.history || 120);

    this.#reconcile(h.id, h.site, status, note, {
      title: !reach ? `${h.name || h.id} nicht erreichbar`
        : wesentlich.length ? `${h.name || h.id}: ${wesentlich[0].kind.toUpperCase()} antwortet nicht`
        : (note || "Zustand auffällig"),
      rule: !reach ? "host.unreachable"
        : wesentlich.length ? `dienst.${wesentlich[0].kind}`
        : st.tls && st.tls.days <= (s.tls_warn_days ?? 30) ? "tls.expiry" : "host.degraded",
      detail: results.map(r => `${r.kind}${r.port ? "/" + r.port : ""}: ${r.skipped ? "übersprungen" : r.ok ? "ok" : "FEHLER"} ${r.detail || ""}`).join("\n")
    });
  }

  /* ---------- Ein Tunnel ---------- */
  async #checkTunnel(t) {
    const st = this.tunnels.get(t.id);
    if (!st) return;
    /* Ohne Gegenstelle im Transfernetz gibt es hier nichts zu messen — dann
       hängt dieser Tunnel an einem verknüpften Peer, und sein Zustand
       entsteht später aus dessen Handshake. */
    if (!t.probe?.ip) { st.checks = []; return; }
    const s = this.inv.settings;
    const target = { ip: t.probe.ip };
    const checks = t.probe.port
      ? [{ kind: "tcp", port: t.probe.port }, { kind: "icmp" }]
      : [{ kind: "icmp" }];

    const results = [];
    for (const c of checks) results.push({ ...c, ...(await runCheck(c, target, s)) });
    const hard = results.filter(r => !r.skipped && r.ok !== null);
    const reach = hard.find(r => r.ok);

    st.checks = results;
    st.ms = reach ? reach.ms : null;
    if (reach) { st.lastSeen = new Date().toISOString(); st.fails = 0; }
    else if (hard.length) st.fails++;

    let status = "ok", note = null;
    if (!hard.length) { status = "idle"; note = "keine auswertbare Prüfung"; }
    else if (!reach) {
      status = st.fails >= (s.fail_threshold || 3) ? "crit" : "warn";
      note = `Gegenstelle ${t.probe.ip} antwortet nicht — ${hard[0].detail}`;
    } else if (st.ms > (s.slow_ms || 800)) { status = "warn"; note = `hohe Latenz: ${st.ms} ms`; }

    st.status = status; st.note = note;
    if (st.ms != null) push(st.hist, st.ms, s.history || 120);

    this.#reconcile(t.id, t.b, status, note, {
      title: status === "crit" ? `Tunnel ${t.iface} trägt nicht` : "Tunnel auffällig",
      rule: "tunnel.unreachable",
      detail: `Gemessen wird durch den Tunnel auf ${t.probe.ip}${t.probe.port ? ":" + t.probe.port : ""} (${t.net}).`,
      kind: "tunnel"
    });
  }

  /* ---------- Peer je Tunnel ----------
     Läuft nach den Systemprüfungen, nicht in ihnen: der Handshake steht in
     den Daten der Firewall, und die werden im selben Durchlauf erst geholt.
     Wer ihn während der Tunnelprüfung liest, liest immer den der Vorrunde. */
  #peerZuTunnel() {
    for (const t of this.inv.tunnels) {
      const st = this.tunnels.get(t.id);
      if (!st) continue;
      st.peer = null;
      st.peerNote = null;
      if (!t.peer) continue;

      const liste = this.hosts.get(t.peer.host)?.extra?.peers;
      const treffer = findePeer(liste, t.peer);
      const bez = t.peer.name || String(t.peer.key || "").slice(0, 8);

      if (treffer) st.peer = { ...treffer, host: t.peer.host };
      else if (!Array.isArray(liste))
        st.peerNote = `${t.peer.host} meldet keine WireGuard-Peers — fehlen dort die Zugangsdaten?`;
      else
        st.peerNote = `Den Peer „${bez}“ meldet ${t.peer.host} nicht mehr — dort umbenannt oder entfernt?`;

      if (!t.probe?.ip) { this.#tunnelAusHandshake(t, st); continue; }

      /* Durch den Tunnel kommt eine Antwort, der verknüpfte Peer schweigt
         seit zehn Minuten: dann trägt eine andere Strecke als die
         verknüpfte. Das ist keine Störung, sondern ein Hinweis auf eine
         falsche Verknüpfung — es bleibt bei einer Notiz. */
      if (st.status === "ok" && st.peer?.handshake > 600)
        st.note = `trägt, aber der verknüpfte Peer „${st.peer.name}“ schweigt seit ${kurzeDauer(st.peer.handshake)} — zeigt die Verknüpfung auf den richtigen Peer?`;
      else if (st.status === "ok" && st.peerNote) st.note = st.peerNote;
    }
  }

  /* Ohne Messung durch den Tunnel ist der Handshake das einzige Zeugnis.
     Er ist schwächer als eine Antwort von der Gegenstelle: er sagt, dass
     die Strecke stand, nicht dass gerade etwas hindurchkommt. Deshalb wird
     er zurückhaltend bewertet, und in der Notiz steht, woher er stammt. */
  #tunnelAusHandshake(t, st) {
    const p = st.peer;
    st.ms = null;
    st.checks = [];
    let status, note;
    if (!p) { status = "idle"; note = st.peerNote; }
    else if (p.handshake == null) { status = "idle"; note = "Kein Handshake — diese Gegenstelle hat sich noch nie gemeldet."; }
    else if (p.handshake <= 180) {
      status = "ok"; note = null;
      st.fails = 0;
      /* Wann die Strecke zuletzt stand, weiß der Peer genauer als wir: sein
         Handshake-Alter ist eine Messung, kein Zeitpunkt unseres Durchlaufs. */
      st.lastSeen = new Date(Date.now() - p.handshake * 1000).toISOString();
    } else if (p.handshake <= 600) {
      status = "warn"; note = `Letzter Handshake vor ${kurzeDauer(p.handshake)} — laut ${p.host}.`;
      st.lastSeen = new Date(Date.now() - p.handshake * 1000).toISOString();
    } else {
      status = "crit"; note = `Seit ${kurzeDauer(p.handshake)} kein Handshake — laut ${p.host}.`;
      st.lastSeen = new Date(Date.now() - p.handshake * 1000).toISOString();
    }

    st.status = status;
    st.note = note;
    this.#reconcile(t.id, t.b, status, note, {
      title: status === "crit" ? `Tunnel ${t.iface || t.id} trägt nicht` : "Tunnel auffällig",
      rule: "tunnel.handshake",
      detail: `Bewertet wird der WireGuard-Handshake des Peers „${t.peer.name || t.peer.key}“ auf ${t.peer.host}. `
        + `Durch den Tunnel wird nicht gemessen — dafür fehlt eine Gegenstelle im Transfernetz (probe.ip).`,
      kind: "tunnel"
    });
  }

  /* ---------- Bündelung nach Standort ----------
     Fällt die Anbindung eines Standorts aus, sind dort schlagartig alle
     Systeme und alle Tunnel still. Das ist ein Vorfall, nicht zwölf:
     es entsteht eine Meldung für den Standort, die Einzelmeldungen
     bleiben erhalten, werden aber als „mitbetroffen“ unterdrückt. */
  #rollup() {
    for (const site of this.inv.sites) {
      const hosts = this.inv.hosts.filter(h => h.site === site.id && h.monitor !== false);
      const states = hosts.map(h => this.hosts.get(h.id)).filter(Boolean);
      const geprüft = states.filter(st => st.status !== "unknown" && st.status !== "idle");
      const still = geprüft.filter(st => st.reachable === false);
      const tunnels = this.inv.tunnels
        .filter(t => t.a === site.id || t.b === site.id)
        .map(t => this.tunnels.get(t.id)).filter(Boolean);

      const fp = `site:${site.id}/site.unreachable`;
      const alleStill = geprüft.length >= 2 && still.length === geprüft.length;

      if (!alleStill) {
        this.incidents.delete(fp);
        for (const inc of this.incidents.values())
          if (inc.suppressedBy === fp) { delete inc.suppressedBy; }
        continue;
      }

      const betroffen = [...still.map(st => st.id), ...tunnels.map(t => t.id)];
      const schwere = still.every(st => st.status === "crit") ? "crit" : "warn";
      const open = this.incidents.get(fp);
      const now = new Date().toISOString();
      if (open) {
        open.count++; open.last = now; open.sev = schwere; open.affected = betroffen;
        open.detail = rollupDetail(site, still, tunnels);
      } else {
        this.incidents.set(fp, {
          id: `INC-${String(++this.seq).padStart(4, "0")}`,
          fingerprint: fp, sev: schwere, host: site.id, site: site.id, kind: "site",
          title: `Standort ${site.name} nicht erreichbar`,
          detail: rollupDetail(site, still, tunnels),
          note: `${still.length} System(e) und ${tunnels.length} Tunnel gleichzeitig still — vermutlich die Anbindung, nicht die Geräte.`,
          rule: "site.unreachable", src: "poll", first: now, last: now, count: 1,
          ack: false, ackBy: null, silencedUntil: null, affected: betroffen
        });
      }
      /* Einzelmeldungen als mitbetroffen kennzeichnen */
      for (const inc of this.incidents.values())
        if (inc.fingerprint !== fp && betroffen.includes(inc.host)) inc.suppressedBy = fp;
    }
  }

  /* ---------- Störungen ---------- */
  #reconcile(subject, site, status, note, meta) {
    const fp = `${subject}/${meta.rule}`;
    const now = new Date().toISOString();

    /* Ein Gegenstand hat immer höchstens eine offene Störung: die zu seinem
       aktuellen Zustand. Wechselt die Ursache (nicht erreichbar -> nur noch
       langsam), wird die alte geschlossen statt liegengelassen. */
    for (const [key, inc] of this.incidents)
      if (inc.host === subject && key !== fp) this.incidents.delete(key);

    const open = this.incidents.get(fp);
    if (status === "ok" || status === "idle") { this.incidents.delete(fp); return; }
    if (open) {
      open.count++; open.last = now; open.detail = meta.detail;
      if (SEV[status] > SEV[open.sev]) { open.sev = status; open.escalated = now; open.ack = false; }
      open.title = meta.title; open.note = note;
      return;
    }
    this.incidents.set(fp, {
      id: `INC-${String(++this.seq).padStart(4, "0")}`,
      fingerprint: fp, sev: status, host: subject, site,
      kind: meta.kind || "host", title: meta.title, detail: meta.detail, note,
      rule: meta.rule, src: "poll", first: now, last: now, count: 1,
      ack: false, ackBy: null, silencedUntil: null
    });
  }

  ack(id, on = true, who = "gui") {
    for (const inc of this.incidents.values())
      if (inc.id === id) { inc.ack = on; inc.ackBy = on ? who : null; this.#saveState(); this.#emit(); return inc; }
    return null;
  }
  silence(subject, minutes) {
    const until = new Date(Date.now() + minutes * 60000).toISOString();
    for (const inc of this.incidents.values()) if (inc.host === subject) inc.silencedUntil = until;
    this.#saveState(); this.#emit();
    return until;
  }

  /* ---------- Fortschreibung über Neustarts ---------- */
  #saveState() {
    if (!this.statePath) return;
    try {
      fs.writeFileSync(this.statePath, JSON.stringify({
        seq: this.seq,
        incidents: [...this.incidents.entries()].map(([fp, i]) => [fp, i])
      }), { mode: 0o640 });
    } catch {}
  }
  #loadState() {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      this.seq = d.seq || 0;
      for (const [fp, i] of d.incidents || []) this.incidents.set(fp, i);
    } catch {}
  }
}

/* Welchen der gemeldeten Peers meint dieser Tunnel?

   Zuerst über den öffentlichen Schlüssel — der bleibt, auch wenn der Peer
   auf der Firewall umbenannt wird. Erst wenn keiner passt (etwa weil der
   Bestand von Hand gepflegt wurde und den Schlüssel nicht kennt), über
   Name und Interface. Ein Name allein ist zweideutig genug, dass er nur
   greift, wenn er genau einmal vorkommt: lieber kein Treffer als der
   falsche — ein falscher Treffer meldete den Handshake eines fremden
   Geräts als den dieser Strecke. */
export function findePeer(liste, wunsch) {
  if (!Array.isArray(liste) || !liste.length || !wunsch) return null;
  if (wunsch.key) {
    const k = liste.find(p => p.key && p.key === wunsch.key);
    if (k) return k;
  }
  if (wunsch.name) {
    const gleichnamig = liste.filter(p => p.name === wunsch.name);
    if (wunsch.iface) {
      const genau = gleichnamig.filter(p => p.iface === wunsch.iface);
      if (genau.length === 1) return genau[0];
    }
    if (gleichnamig.length === 1) return gleichnamig[0];
  }
  return null;
}

/* Kurz und deutsch: „4 min", „2 h 10 min", „3 T". */
export function kurzeDauer(s) {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} T`;
}

function rollupDetail(site, still, tunnels) {
  const lines = [`Alle ${still.length} überwachten Systeme an diesem Standort antworten nicht.`];
  if (tunnels.length) lines.push(`Betroffene Tunnel: ${tunnels.map(t => t.id).join(", ")}.`);
  lines.push("", "Still sind:", ...still.map(st => `  ${st.id} — ${st.note || "keine Antwort"}`));
  return lines.join("\n");
}

function push(arr, v, max) { arr.push(v); while (arr.length > max) arr.shift(); }

/* Nur echte Messwerte gehen in die Zeitreihe. Ein Sammler, der nichts
   liefert, hinterlässt eine Lücke — keine Null, die sich später wie eine
   Messung liest. */
function zahl(v) { return Number.isFinite(v) ? v : null; }
