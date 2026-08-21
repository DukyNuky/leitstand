/* Portainer — Stacks, Container und die, die klemmen.

   Anmeldung über einen API-Token im Kopf `X-API-Key`. Angelegt wird er in
   Portainer unter dem eigenen Benutzer; der Benutzer sollte je Umgebung
   die Rolle „read-only" haben. Der Leitstand ruft ausschließlich lesende
   Endpunkte auf — der Docker-Proxy von Portainer könnte weit mehr.

   Zwei Quellen, mit Absicht in dieser Reihenfolge:

   1. `/api/endpoints` trägt zu jeder Umgebung eine **Momentaufnahme**
      (`Snapshots`), die Portainer ohnehin regelmäßig zieht: Container
      laufend/gestoppt/ungesund, Stacks, Fassung der Docker-Engine. Das
      kostet einen Aufruf für alles.
   2. Erst für die Frage „welcher Container klemmt?" wird je Umgebung die
      Containerliste geholt. Ohne sie stünde da eine Zahl ohne Namen, und
      mit einer Zahl allein sucht man weiter.

   Was hier bewusst fehlt: ein Neustartzähler. Den führt die Containerliste
   nicht; er stünde nur in einem `inspect` je Container — ein Aufruf je
   Container und Durchlauf, für eine Zahl, die auch aus dem Zustand
   „restarting" und dem Exit-Code hervorgeht. Gemeldet wird deshalb, was
   ohne Wühlen zu haben ist: wer gerade neu startet, wer ungesund ist und
   wer mit 137 (Speichergrenze) ausgestiegen ist. */

import { requestJson } from "../http.js";

/* Portainer ist bei den Umgebungen großzügig, der Leitstand nicht: mehr
   als diese Zahl Umgebungen je Durchlauf nach Containern zu fragen würde
   den Durchlauf ausbremsen, ohne mehr zu sagen. */
const MAX_UMGEBUNGEN = 6;
const MAX_PROBLEME = 12;

export function authHeader(cred) {
  if (!cred) return null;
  const token = cred.token || cred.apiKey || cred.secret;
  if (!token) return null;
  return { "X-API-Key": token };
}

export function baseUrl(host) {
  if (host.url) {
    try {
      const u = new URL(host.url);
      const pfad = u.pathname.replace(/\/+$/, "");
      return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}${pfad}`;
    } catch {}
  }
  return `https://${host.ip}:9443`;
}

export const PFADE = [
  {
    pfad: "/api/system/status",
    alternativen: ["/api/status"],
    zweck: "erreichbar und angemeldet, Fassung von Portainer"
  },
  { pfad: "/api/endpoints", zweck: "Umgebungen samt Momentaufnahme — Container, Stacks, Zustand" },
  { pfad: "/api/stacks", zweck: "angelegte Stacks", optional: true },
  /* {umgebung} setzt die Diagnose aus der Antwort davor ein — die Kennung
     der ersten erreichbaren Umgebung. Eine feste 1 wäre geraten. */
  { pfad: "/api/endpoints/{umgebung}/docker/containers/json?all=1", zweck: "Containerliste — welcher Container klemmt", optional: true }
];

/* Was aus einer geglückten Antwort für die Diagnose zählt. */
export function befund(pfad, data) {
  if (pfad.includes("status")) return data?.Version ? `Portainer ${data.Version}` : "Antwort ohne Versionsangabe";
  if (pfad === "/api/endpoints") {
    const liste = Array.isArray(data) ? data : [];
    if (!liste.length) return "keine Umgebung sichtbar — Portainer filtert die Liste nach Rechten, das ist ein Rechteproblem";
    const namen = liste.map(e => `${e.Name || e.Id}${e.Status === 1 ? "" : " (antwortet nicht)"}`);
    const mit = liste.filter(e => schnappschuss(e)).length;
    return `${liste.length} Umgebung(en): ${namen.join(", ")} — ${mit} mit Momentaufnahme`;
  }
  if (pfad === "/api/stacks") {
    const liste = Array.isArray(data) ? data : [];
    return liste.length ? `${liste.length} Stack(s): ${liste.slice(0, 8).map(s => s.Name).join(", ")}` : "keine Stacks sichtbar";
  }
  if (pfad.includes("/docker/containers/json")) {
    const liste = Array.isArray(data) ? data : [];
    if (!liste.length) return "keine Container in dieser Umgebung";
    const lauf = liste.filter(c => c.State === "running").length;
    return `${liste.length} Container, davon ${lauf} laufend`;
  }
  return Array.isArray(data) ? `${data.length} Einträge` : "Antwort erhalten";
}

export async function api(host, cred, pfad, timeout = 8000) {
  const headers = authHeader(cred);
  if (!headers) return { ok: false, error: "Kein API-Token hinterlegt" };
  return requestJson(`${baseUrl(host)}${pfad}`, { headers, timeout });
}

/* Die Fassung steht je nach Portainer-Stand unter einem anderen Pfad:
   /api/status ist der alte, /api/system/status der heutige. */
export async function ersterTreffer(host, cred, pfade, timeout = 8000) {
  let letzte = null;
  for (const p of pfade) {
    const r = await api(host, cred, p, timeout);
    if (r.ok) return { ...r, pfad: p };
    letzte = { ...r, pfad: p };
    if (r.status !== 404) break;
  }
  return letzte;
}

export function hintFor(r) {
  if (r.status === 401)
    return "Der Token wird abgelehnt. In Portainer oben rechts unter „My account“ → „Access tokens“ einen neuen "
      + "erzeugen; er ist nur beim Anlegen zu sehen.";
  if (r.status === 403)
    return "Angemeldet, aber ohne Rechte auf diese Umgebung. Dem Benutzer je Umgebung die Rolle „read-only“ geben "
      + "(Environments → Access).";
  if (r.status === 404)
    return "Erreicht, aber kein Portainer-Endpunkt — Adresse und Port prüfen (Portainer CE: 9443 mit TLS, 9000 ohne).";
  if (/abgewiesen/.test(r.error || ""))
    return "Port prüfen: Portainer hört auf 9443 (TLS) beziehungsweise 9000 (ohne).";
  return null;
}

/* ---------- Verbindungstest ---------- */
export async function testConnection(host, cred) {
  const eps = await api(host, cred, "/api/endpoints", 6000);
  if (!eps.ok) return { ok: false, detail: eps.error, hint: hintFor(eps) };

  const liste = Array.isArray(eps.data) ? eps.data : [];
  const st = await ersterTreffer(host, cred, ["/api/system/status", "/api/status"], 6000);
  const fassung = st?.ok ? (st.data?.Version || null) : null;

  if (!liste.length) {
    return {
      ok: false,
      detail: `Verbunden — Portainer${fassung ? " " + fassung : ""}, aber es ist keine Umgebung sichtbar.`,
      hint: "Portainer filtert die Umgebungen nach Rechten, statt sie abzulehnen: dem Benutzer fehlt der Zugriff. "
        + "Unter Environments → Access dem Benutzer (oder seinem Team) die Rolle „read-only“ geben.",
      version: fassung
    };
  }

  const laufend = liste.filter(e => e.Status === 1).length;
  const container = liste.reduce((a, e) => a + (zahl(schnappschuss(e)?.RunningContainerCount) || 0), 0);
  return {
    ok: true,
    detail: `Verbunden — Portainer${fassung ? " " + fassung : ""} · ${liste.length} Umgebung(en), `
      + `${laufend} erreichbar, ${container} laufende Container sichtbar`,
    version: fassung, ms: eps.ms
  };
}

/* Die Momentaufnahme einer Docker-Umgebung. Kubernetes-Umgebungen führen
   ihre eigene unter Kubernetes.Snapshots — die zählt hier nicht mit, sonst
   stünden Äpfel in der Birnenspalte. */
export function schnappschuss(e) {
  const s = Array.isArray(e?.Snapshots) ? e.Snapshots[0] : null;
  return s || null;
}

/* ---------- Sammler ---------- */
export async function collectPortainer(host, cred) {
  const [eps, stacks, st] = await Promise.all([
    api(host, cred, "/api/endpoints"),
    api(host, cred, "/api/stacks"),
    ersterTreffer(host, cred, ["/api/system/status", "/api/status"])
  ]);

  if (!eps.ok) return {
    error: eps.error, note: eps.error,
    status: (eps.status === 401 || eps.status === 403) ? "warn" : undefined
  };

  const liste = Array.isArray(eps.data) ? eps.data : [];
  const out = {
    version: st?.ok ? (st.data?.Version || null) : null,
    endpoints: liste.length,
    endpointsDown: liste.filter(e => e.Status === 2).length,
    running: 0, stopped: 0, unhealthy: 0, containers: 0,
    umgebungen: []
  };

  /* Leer heißt bei Portainer nicht „nichts da", sondern „nichts sichtbar":
     die Liste wird nach Rechten gefiltert. Das ist ein Befund, keine Null. */
  if (!liste.length) {
    out.endpoints = 0;
    out.running = null; out.stopped = null; out.unhealthy = null; out.containers = null;
    out.status = "warn";
    out.note = "Keine Umgebung sichtbar — Portainer filtert die Liste nach Rechten. Dem Token fehlt der Zugriff.";
    return out;
  }

  for (const e of liste) {
    const s = schnappschuss(e);
    const lauf = zahl(s?.RunningContainerCount) || 0;
    const halt = zahl(s?.StoppedContainerCount) || 0;
    out.running += lauf;
    out.stopped += halt;
    out.unhealthy += zahl(s?.UnhealthyContainerCount) || 0;
    out.containers += lauf + halt;
    out.umgebungen.push({
      id: e.Id, name: e.Name || `#${e.Id}`,
      erreichbar: e.Status === 1,
      running: s ? lauf : null,
      stopped: s ? halt : null,
      unhealthy: s ? (zahl(s.UnhealthyContainerCount) || 0) : null,
      stacks: s ? (zahl(s.StackCount) ?? null) : null,
      docker: s?.DockerVersion || null,
      /* Wie alt die Momentaufnahme ist: Portainer zieht sie in eigenem
         Takt. Eine Zahl von gestern soll nicht wie eine von jetzt aussehen. */
      stand: s?.Time ? new Date(s.Time * 1000).toISOString() : null
    });
  }

  stapel(out, stacks, liste);
  await container(out, host, cred, liste);
  ampel(out);
  return out;
}

/* ---------- Stacks ---------- */
function stapel(out, r, liste) {
  if (r.ok && Array.isArray(r.data)) {
    out.stacks = r.data.length;
    /* Status 1 = aktiv, 2 = angehalten. */
    out.stacksInaktiv = r.data.filter(s => s.Status === 2).length;
    return;
  }
  /* Ohne den Stack-Endpunkt bleibt die Zahl aus der Momentaufnahme — sie
     zählt dasselbe, nur ohne die Unterscheidung aktiv/angehalten. */
  const ausSnapshot = liste.reduce((a, e) => a + (zahl(schnappschuss(e)?.StackCount) || 0), 0);
  out.stacks = ausSnapshot || null;
  out.stacksInaktiv = null;
  if (!r.ok && r.status !== 404) out.stacksFehler = r.error;
}

/* ---------- Wer klemmt? ----------
   Nur für erreichbare Docker-Umgebungen und nur bis zu einer Handvoll:
   der Durchlauf soll nicht an einer Containerliste hängen. */
async function container(out, host, cred, liste) {
  const ziele = liste.filter(e => e.Status === 1).slice(0, MAX_UMGEBUNGEN);
  out.probleme = [];
  out.restarting = 0;
  out.oom = 0;

  const antworten = await Promise.all(ziele.map(async e => ({
    e, r: await api(host, cred, `/api/endpoints/${e.Id}/docker/containers/json?all=1`)
  })));

  let gelesen = 0;
  for (const { e, r } of antworten) {
    if (!r.ok || !Array.isArray(r.data)) {
      /* Ein Agent, der gerade nicht antwortet, ist keine Fehlermeldung
         wert — die Momentaufnahme steht ja. Ein abgelehnter Zugriff schon. */
      if (r.status === 401 || r.status === 403) out.containerFehler = `${e.Name}: ${r.error}`;
      continue;
    }
    gelesen++;
    for (const c of r.data) {
      const name = (Array.isArray(c.Names) && c.Names[0] ? String(c.Names[0]) : c.Id || "?").replace(/^\//, "");
      const zustand = String(c.State || "");
      const text = String(c.Status || "");
      const exit = /Exited \((\d+)\)/.exec(text);
      let grund = null;

      if (zustand === "restarting") { out.restarting++; grund = "startet wiederholt neu"; }
      else if (exit && exit[1] === "137") { out.oom++; grund = "mit 137 beendet — Speichergrenze erreicht (OOM)"; }
      else if (/unhealthy/i.test(text)) grund = "Healthcheck meldet unhealthy";
      else if (zustand === "dead") grund = "Zustand „dead“ — Container lässt sich nicht mehr aufräumen";

      if (grund && out.probleme.length < MAX_PROBLEME)
        out.probleme.push({ name, umgebung: e.Name || `#${e.Id}`, zustand, status: text, grund });
    }
  }

  /* Nichts gelesen heißt nicht „nichts gefunden“. Ohne diese Unterscheidung
     stünde eine ruhige Null da, wo in Wahrheit niemand nachgesehen hat. */
  if (!gelesen) { out.restarting = null; out.oom = null; out.probleme = null; }
  else if (ziele.length < liste.filter(e => e.Status === 1).length)
    out.containerNote = `Container geprüft in ${ziele.length} von ${liste.length} Umgebungen`;
}

/* ---------- Ampel ---------- */
function ampel(out) {
  if (out.endpoints > 0 && out.endpointsDown === out.endpoints) {
    out.status = "crit";
    out.note = out.endpoints === 1
      ? "Die Umgebung antwortet nicht — Portainer läuft, der Docker-Host oder der Agent nicht."
      : `Keine der ${out.endpoints} Umgebungen antwortet — Portainer läuft, die Docker-Hosts nicht.`;
    return;
  }

  const gruende = [];
  if (out.endpointsDown > 0) gruende.push(`${out.endpointsDown} von ${out.endpoints} Umgebungen antworten nicht`);
  if (out.oom) gruende.push(`${out.oom} Container mit Exit 137 — Speichergrenze erreicht`);
  if (out.restarting) gruende.push(`${out.restarting} Container in der Neustartschleife`);
  if (out.unhealthy) gruende.push(`${out.unhealthy} Container unhealthy`);
  if (out.containerFehler) gruende.push(out.containerFehler);

  if (gruende.length) {
    out.status = "warn";
    out.note = gruende.join(" · ");
    return;
  }
  if (out.stacksFehler) { out.status = "warn"; out.note = `Stacks nicht lesbar: ${out.stacksFehler}`; return; }
  if (out.containers != null)
    out.note = `${out.running} von ${out.containers} Containern laufen`
      + (out.stacks ? ` · ${out.stacks} Stacks` : "");
}

const zahl = v => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
