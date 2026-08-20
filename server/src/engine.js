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
    this.hosts = new Map();
    this.tunnels = new Map();
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
        ms: null, hist: [], fails: 0, lastSeen: null, lastRun: null,
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
      ...this.inv.tunnels.map(t => this.#checkTunnel(t))
    ]);
    this.#rollup();
    this.lastRun = new Date().toISOString();
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
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

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

    /* TLS-Restlaufzeit merken — speist die Zertifikatsliste */
    const tlsRes = results.find(r => r.kind === "tls" && r.ok && r.extra);
    st.tls = tlsRes ? { ...tlsRes.extra, port: tlsRes.port } : null;

    /* Zusatzdaten aus einem Sammler (Proxmox u. a.), falls hinterlegt */
    const collector = this.collectors[h.type];
    if (collector && reach) {
      try {
        const extra = await collector(h);
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
      title: !reach ? `${h.name || h.id} nicht erreichbar` : (note || "Zustand auffällig"),
      rule: !reach ? "host.unreachable" : st.tls && st.tls.days <= (s.tls_warn_days ?? 30) ? "tls.expiry" : "host.degraded",
      detail: results.map(r => `${r.kind}${r.port ? "/" + r.port : ""}: ${r.skipped ? "übersprungen" : r.ok ? "ok" : "FEHLER"} ${r.detail || ""}`).join("\n")
    });
  }

  /* ---------- Ein Tunnel ---------- */
  async #checkTunnel(t) {
    const st = this.tunnels.get(t.id);
    if (!st) return;
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

function rollupDetail(site, still, tunnels) {
  const lines = [`Alle ${still.length} überwachten Systeme an diesem Standort antworten nicht.`];
  if (tunnels.length) lines.push(`Betroffene Tunnel: ${tunnels.map(t => t.id).join(", ")}.`);
  lines.push("", "Still sind:", ...still.map(st => `  ${st.id} — ${st.note || "keine Antwort"}`));
  return lines.join("\n");
}

function push(arr, v, max) { arr.push(v); while (arr.length > max) arr.shift(); }
