/* HTTP-Server: Oberfläche ausliefern, Zustand liefern, Bestand pflegen.

   Endpunkte
     GET    /api/state            aktueller Zustand für die Oberfläche
     GET    /api/version          welche Fassung hier läuft (Commit, Zeitpunkt)
     GET    /api/stream           dasselbe als Server-Sent-Events
     POST   /api/incidents/:id/ack        { on: true|false }
     POST   /api/hosts/:id/silence        { minutes: 120 }
     GET    /api/admin/inventory  Bestand + maskierte Zugangsdaten
     POST   /api/admin/hosts      System anlegen
     PUT    /api/admin/hosts/:id  System ändern
     DELETE /api/admin/hosts/:id  System entfernen
     POST   /api/admin/sites | tunnels | links   (analog, mit PUT/DELETE)
     PUT    /api/admin/settings   Schwellwerte
     POST   /api/admin/credentials/:id    Zugangsdaten setzen
     DELETE /api/admin/credentials/:id
     POST   /api/admin/test       Verbindung prüfen, ohne zu speichern
     POST   /api/admin/diagnose   jeden Aufruf einzeln zeigen — { id }
     POST   /api/admin/reload     inventory.yaml neu einlesen
     POST   /api/admin/check      sofortigen Durchlauf auslösen  */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Inv from "./inventory.js";
import { Secrets } from "./secrets.js";
import { Engine } from "./engine.js";
import { buildState } from "./api.js";
import { makeCollectors, TESTERS } from "./collectors/index.js";
import { runCheck } from "./probe.js";
import { buildInfo } from "./version.js";
import { diagnoseHost, alsText } from "./diagnose.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();
const ROOT = path.resolve(here, "..");
/* Die Oberfläche liegt im Abbild neben dem Programm, im Arbeitsbaum eine
   Ebene darüber. LEITSTAND_UI schlägt beides. */
const UI = path.resolve(
  process.env.LEITSTAND_UI ||
  [path.join(ROOT, "ui"), path.resolve(ROOT, "..", "ui")].find(p => fs.existsSync(p)) ||
  path.resolve(ROOT, "..", "ui")
);

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8", ".woff2": "font/woff2" };

export function createServer(opts = {}) {
  /* Pfade: ausdrücklich übergeben > Umgebungsvariable > Datei im
     Arbeitsverzeichnis > Datei neben dem Programm. So lassen sich mehrere
     Bestände nebeneinander betreiben, ohne das Repository anzufassen. */
  const pick = (given, env, name) => {
    if (given) return path.resolve(given);
    if (process.env[env]) return path.resolve(process.env[env]);
    const cwd = path.resolve(process.cwd(), name);
    if (fs.existsSync(cwd)) return cwd;
    return path.join(ROOT, name);
  };
  const invFile = pick(opts.inventory, "LEITSTAND_INVENTORY", "inventory.yaml");
  /* Zugangsdaten und Störungsstand liegen immer neben dem Bestand, zu dem
     sie gehören — sie werden erst im Betrieb angelegt, eine Suche nach
     vorhandenen Dateien würde sie am falschen Ort erzeugen. */
  const beside = name => path.join(path.dirname(invFile), name);
  const secFile = opts.secrets || process.env.LEITSTAND_SECRETS || beside("secrets.json");
  const stateFile = opts.state || process.env.LEITSTAND_STATE || beside("incidents.json");

  /* Erststart: fehlt der Bestand, wird er angelegt — als Vorlage dient die im
     Abbild mitgelieferte inventory.yaml, sonst ein leeres Gerüst. */
  const angelegt = Inv.ensure(invFile, opts.seed || process.env.LEITSTAND_SEED || path.join(ROOT, "inventory.yaml"));
  if (angelegt.created) console.log(`Bestand angelegt: ${invFile}${angelegt.seeded ? " (aus Vorlage)" : " (leeres Gerüst)"}`);

  let inv = Inv.load(invFile);
  const secrets = new Secrets(secFile);
  const engine = new Engine(inv, { statePath: stateFile, collectors: makeCollectors(secrets) });

  const clients = new Set();
  engine.onChange(() => {
    const payload = `data: ${JSON.stringify(buildState(engine, secrets))}\n\n`;
    for (const res of clients) { try { res.write(payload); } catch {} }
  });

  /* Änderungen sind entweder ganz oder gar nicht wirksam: geändert wird
     eine Kopie, geprüft und geschrieben wird sie, und erst danach wird sie
     zum gültigen Bestand. Eine abgelehnte Änderung darf den laufenden
     Dienst nicht in einen halben Zustand bringen. */
  const commit = next => {
    Inv.save(invFile, next);
    inv = next;
    engine.reload(inv);
    /* Sofort melden, nicht erst nach dem nächsten Durchlauf: ein neu
       angelegter Standort soll in der Oberfläche stehen, sobald er
       gespeichert ist — ungeprüft, aber sichtbar. */
    engine.announce();
    return next;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) return await api(req, res, p, url);
      return serveStatic(res, p);
    } catch (e) {
      if (e instanceof Inv.InventoryError) return json(res, 400, { error: e.message });
      console.error("[server]", e);
      json(res, 500, { error: e.message });
    }
  });

  /* ---------- API ---------- */
  async function api(req, res, p, url) {
    const m = req.method;

    if (p === "/api/state" && m === "GET") return json(res, 200, buildState(engine, secrets));

    /* Klein und ohne Messwerte — zum Nachsehen per curl und für den
       Abgleich nach einem Redeploy, ohne den ganzen Zustand zu holen. */
    if (p === "/api/version" && m === "GET")
      return json(res, 200, { ...buildInfo(), started: startedAt, uptimeSeconds: Math.round(process.uptime()) });

    if (p === "/api/stream" && m === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(buildState(engine, secrets))}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    let mm;
    if ((mm = p.match(/^\/api\/incidents\/([^/]+)\/ack$/)) && m === "POST") {
      const body = await readJson(req);
      const inc = engine.ack(decodeURIComponent(mm[1]), body.on !== false);
      return inc ? json(res, 200, { ok: true }) : json(res, 404, { error: "Störung nicht gefunden" });
    }
    if ((mm = p.match(/^\/api\/hosts\/([^/]+)\/silence$/)) && m === "POST") {
      const body = await readJson(req);
      const until = engine.silence(decodeURIComponent(mm[1]), Number(body.minutes) || 120);
      return json(res, 200, { ok: true, until });
    }

    /* ---- Verwaltung ---- */
    if (p === "/api/admin/inventory" && m === "GET")
      return json(res, 200, { ...inv, credentials: secrets.maskedAll(), types: Inv.TYPES, file: invFile });

    if (p === "/api/admin/settings" && m === "PUT") {
      const body = await readJson(req);
      commit({ ...inv, settings: { ...inv.settings, ...body } });
      return json(res, 200, { ok: true, settings: inv.settings });
    }

    for (const key of ["hosts", "sites", "tunnels"]) {
      if (p === `/api/admin/${key}` && m === "POST") {
        const body = await readJson(req);
        if (!body.id) return json(res, 400, { error: "id fehlt" });
        if (inv[key].some(x => String(x.id) === String(body.id)))
          return json(res, 409, { error: `„${body.id}“ gibt es bereits.` });
        if (key === "sites") {
          const grund = Inv.pruefeKuerzel(body.short);
          if (grund) return json(res, 400, { error: grund });
          body.short = Inv.normalizeKuerzel(body.short);
        }
        const item = key === "hosts" ? Inv.normalizeHost(body)
          : key === "tunnels" ? Inv.normalizeTunnel(body) : body;
        commit({ ...inv, [key]: [...inv[key], item] });
        return json(res, 201, { ok: true, item: inv[key].at(-1) });
      }
      if ((mm = p.match(new RegExp(`^/api/admin/${key}/([^/]+)$`)))) {
        const id = decodeURIComponent(mm[1]);
        const i = inv[key].findIndex(x => String(x.id) === id);
        if (i < 0) return json(res, 404, { error: "nicht gefunden" });

        if (m === "PUT") {
          const body = await readJson(req);
          const merged = { ...inv[key][i], ...body, id };
          /* Nur prüfen, wenn das Kürzel überhaupt Teil der Änderung ist —
             sonst könnte man einen Standort mit altem Kürzel nicht mehr
             anfassen, ohne ihn zugleich umbenennen zu müssen. */
          if (key === "sites" && "short" in body) {
            const grund = Inv.pruefeKuerzel(body.short);
            if (grund) return json(res, 400, { error: grund });
            merged.short = Inv.normalizeKuerzel(body.short);
          }
          /* Der Tunnel wird hier mitgeräumt: löst man die Peer-Verknüpfung,
             schickt die Oberfläche `peer: null` — das gehört entfernt und
             nicht als null in die Bestandsdatei geschrieben. */
          const item = key === "hosts" ? Inv.normalizeHost(stripEmptyChecks(merged))
            : key === "tunnels" ? Inv.normalizeTunnel(merged) : merged;
          const list = inv[key].map((x, n) => (n === i ? item : x));
          commit({ ...inv, [key]: list });
          return json(res, 200, { ok: true, item: inv[key][i] });
        }

        if (m === "DELETE") {
          const next = { ...inv, [key]: inv[key].filter((_, n) => n !== i) };
          if (key === "hosts") {
            next.links = inv.links.map(g => ({ ...g, items: g.items.filter(it => it.host !== id) }));
          }
          if (key === "sites") {
            const orphan = inv.hosts.filter(h => h.site === id).map(h => h.id);
            if (orphan.length) return json(res, 409, { error: `Standort trägt noch ${orphan.length} System(e): ${orphan.join(", ")}` });
            next.tunnels = inv.tunnels.filter(t => t.a !== id && t.b !== id);
          }
          commit(next);
          if (key === "hosts") secrets.remove(id);   /* erst wenn der Bestand steht */
          return json(res, 200, { ok: true });
        }
      }
    }

    if (p === "/api/admin/links" && m === "PUT") {
      const body = await readJson(req);
      commit({ ...inv, links: body.links || [] });
      return json(res, 200, { ok: true, links: inv.links });
    }

    if ((mm = p.match(/^\/api\/admin\/credentials\/([^/]+)$/))) {
      const id = decodeURIComponent(mm[1]);
      if (m === "POST") {
        const body = await readJson(req);
        const masked = secrets.set(id, body);
        engine.reload(inv);
        return json(res, 200, { ok: true, credentials: masked });
      }
      if (m === "DELETE") { secrets.remove(id); return json(res, 200, { ok: true }); }
    }

    if (p === "/api/admin/test" && m === "POST") {
      const body = await readJson(req);
      return json(res, 200, await testTarget(body));
    }

    /* Diagnose eines bereits angelegten Systems: jeder Aufruf, den der
       Sammler macht, einzeln — samt dem, was zurückkam. Für den Fall
       „erreichbar, Rechte gesetzt, trotzdem keine Werte". */
    if (p === "/api/admin/diagnose" && m === "POST") {
      const body = await readJson(req);
      const host = inv.hosts.find(h => String(h.id) === String(body.id));
      if (!host) return json(res, 404, { error: `System „${body.id}“ ist nicht angelegt.` });
      const bericht = await diagnoseHost(host, secrets.get(host.id), inv.settings);
      /* Die Textfassung kommt mit: so lässt sich der Befund aus der
         Oberfläche heraus kopieren, ohne ihn dort nachzubauen. */
      return json(res, 200, { ...bericht, text: alsText(bericht) });
    }

    if (p === "/api/admin/reload" && m === "POST") {
      inv = Inv.load(invFile);
      engine.reload(inv);
      await engine.runOnce();
      return json(res, 200, { ok: true, hosts: inv.hosts.length });
    }

    if (p === "/api/admin/check" && m === "POST") { await engine.runOnce(); return json(res, 200, { ok: true, lastRun: engine.lastRun }); }

    json(res, 404, { error: "unbekannter Endpunkt" });
  }

  /* Verbindungstest: erst Erreichbarkeit, dann — wenn Zugangsdaten
     dabei sind — die echte API. Gespeichert wird dabei nichts. */
  async function testTarget(body) {
    const host = Inv.normalizeHost({
      id: body.id || "test", type: body.type || "other",
      site: body.site || (inv.sites[0]?.id), ip: body.ip, url: body.url
    });
    const steps = [];
    for (const c of host.checks) {
      const r = await runCheck(c, host, { ...inv.settings, timeout: 5 });
      steps.push({ kind: c.kind, port: c.port || null, ok: r.ok, detail: r.detail, ms: r.ms });
    }
    const reachable = steps.some(s => s.ok);

    let apiTest = null;
    const tester = TESTERS[host.type];
    if (tester) {
      const cred = hasCred(body.credentials) ? body.credentials : secrets.get(body.id);
      if (cred) apiTest = await tester(host, cred);
      else apiTest = { ok: false, detail: "Keine Zugangsdaten angegeben — nur Erreichbarkeit geprüft.", soft: true };
    }
    return {
      reachable, steps, api: apiTest,
      summary: !reachable ? "Nicht erreichbar" : apiTest?.ok ? apiTest.detail : reachable ? "Erreichbar" : "—"
    };
  }
  const hasCred = c => c && Object.values(c).some(v => v);

  /* ---------- Statisch ---------- */
  function serveStatic(res, p) {
    if (p === "/" || p === "") p = "/index.html";
    const file = path.join(UI, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(UI)) return json(res, 403, { error: "verboten" });
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { error: "nicht gefunden" });
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
      res.end(buf);
    });
  }

  server.engine = engine;
  server.secrets = secrets;
  server.getInventory = () => inv;
  server.settings = () => inv.settings;
  return server;
}

/* no-store, nicht bloß no-cache: eine Antwort ohne Angabe darf der Browser
   nach eigenem Gutdünken aufheben, und ein aufgehobener Zustand ist in
   einer Überwachung das Schlimmste, was passieren kann — er sieht aus wie
   eine Messung von jetzt. */
function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(b),
    "cache-control": "no-store"
  });
  res.end(b);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => { size += c.length; if (size > 1e6) { req.destroy(); reject(new Error("Anfrage zu groß")); } chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("Anfrage ist kein gültiges JSON")); } });
    req.on("error", reject);
  });
}
function stripEmptyChecks(h) { if (Array.isArray(h.checks) && !h.checks.length) delete h.checks; return h; }

/* ---------- Start ---------- */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  const s = server.settings();
  server.listen(Number(process.env.PORT) || s.listen, process.env.BIND || s.bind, () => {
    const a = server.address();
    console.log(`Leitstand hört auf http://${a.address === "0.0.0.0" ? "localhost" : a.address}:${a.port}`);
    console.log(`Oberfläche: ${UI}`);
    console.log(`Bestand: ${server.getInventory().hosts.length} Systeme, Durchlauf alle ${s.interval} s`);
    server.engine.start();
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.engine.stop(); server.close(() => process.exit(0)); });
}
