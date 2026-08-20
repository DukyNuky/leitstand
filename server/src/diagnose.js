/* Diagnose: jeden Schritt einzeln zeigen, statt am Ende „geht nicht".

   Wenn ein Knoten erreichbar ist, der Token angeblich stimmt und trotzdem
   keine Kennzahlen ankommen, liegt die Ursache immer an einer von wenigen
   Stellen — und sie ist von außen nicht zu erraten. Also wird hier jeder
   Aufruf, den der Sammler macht, einzeln ausgeführt und mit dem berichtet,
   was er zurückgab: Kennzahl, Fehlercode, Anzahl der Einträge, Knotennamen.

   Grundsätze:
   - Nichts wird geschönt. Ein Fehler steht im Klartext mit HTTP-Code.
   - Das Geheimnis verlässt den Dienst nie, auch nicht in der Diagnose.
     Gezeigt wird die *Form* der Kopfzeile, damit ein Tippfehler in der
     Token-ID auffällt, ohne den Schlüssel preiszugeben.
   - Am Ende steht ein Satz, woran es hängt — und der zeigt auf den ersten
     Schritt, der nicht durchkam, nicht auf den letzten. */

import { runCheck } from "./probe.js";
import { authHeader, baseUrl, RECHTEHINWEIS } from "./collectors/proxmox.js";
import { requestJson } from "./http.js";

/* Welche Aufrufe der jeweilige Sammler tatsächlich braucht. Die Reihenfolge
   ist die Reihenfolge der Abhängigkeit: was oben scheitert, macht alles
   darunter sinnlos. */
const PFADE = {
  pve: [
    { pfad: "/version", zweck: "erreichbar und angemeldet" },
    { pfad: "/nodes", zweck: "Knotenliste — hier wird der eigene Knoten gesucht" },
    { pfad: "/cluster/resources", zweck: "Gäste und Speicher — daraus kommen VMs, LXC, Belegung" },
    { pfad: "/cluster/status", zweck: "Clustername und Quorum", optional: true }
  ],
  pbs: [
    { pfad: "/version", zweck: "erreichbar und angemeldet" },
    { pfad: "/status/datastore-usage", zweck: "Belegung je Datastore" },
    { pfad: "/nodes/localhost/tasks?limit=60&errors=1", zweck: "fehlgeschlagene Aufträge", optional: true }
  ],
  pmg: [
    { pfad: "/version", zweck: "erreichbar und angemeldet" },
    { pfad: "/statistics/mail?timespan=86400", zweck: "Tagesstatistik" }
  ]
};

export async function diagnoseHost(host, cred, settings = {}) {
  const bericht = {
    host: { id: host.id, type: host.type, ip: host.ip || null, url: host.url || null },
    ziel: null, zugang: null, netz: [], api: [], fazit: null, ok: false
  };

  /* ---- 1. Netz: was der Prober ohnehin misst ---- */
  for (const c of host.checks || []) {
    const r = await runCheck(c, host, { ...settings, timeout: settings.timeout || 5 });
    bericht.netz.push({
      schritt: `${c.kind}${c.port ? "/" + c.port : ""}`,
      ok: r.ok, ms: r.ms ?? null, detail: r.detail || null, uebersprungen: !!r.skipped
    });
  }

  const kollektor = PFADE[host.type];
  if (!kollektor) {
    bericht.fazit = `Für den Typ „${host.type}" gibt es noch keinen Sammler — geprüft wird nur die Erreichbarkeit.`;
    bericht.ok = bericht.netz.some(n => n.ok);
    return bericht;
  }

  bericht.ziel = baseUrl(host, host.type);

  /* ---- 2. Zugang: ist überhaupt einer hinterlegt, und wie sieht er aus? ---- */
  const kopf = authHeader(host.type, cred);
  bericht.zugang = zugangsForm(host.type, cred, kopf);
  if (!kopf) {
    bericht.fazit = "Es ist kein API-Token hinterlegt. Ohne Zugang bleibt es bei der reinen Erreichbarkeit — "
      + "unter Verwaltung → System bearbeiten eintragen.";
    return bericht;
  }

  /* ---- 3. Die Aufrufe des Sammlers, einer nach dem anderen ---- */
  for (const { pfad, zweck, optional } of kollektor) {
    const r = await requestJson(`${bericht.ziel}/api2/json${pfad}`, { headers: kopf, timeout: 8000 });
    const eintrag = {
      pfad, zweck, optional: !!optional,
      ok: !!r.ok, status: r.status ?? null, ms: r.ms ?? null,
      fehler: r.ok ? null : r.error || "unbekannter Fehler",
      antwort: r.ok ? null : kurzfassung(r.body),
      befund: null
    };
    if (r.ok) eintrag.befund = befundFuer(host, pfad, r.data?.data);
    bericht.api.push(eintrag);
    /* Nach einem harten Fehlschlag weiterzufragen bringt nichts — außer
       Rauschen in einem Bericht, der Klarheit schaffen soll. */
    if (!r.ok && !optional) break;
  }

  bericht.fazit = fazit(host, bericht);
  bericht.ok = !bericht.fazit.problem;
  bericht.fazit = bericht.fazit.text;
  return bericht;
}

/* Die Form der Kopfzeile — genug, um einen Tippfehler zu sehen, zu wenig,
   um damit etwas anzufangen. */
function zugangsForm(type, cred, kopf) {
  if (!cred) return { vorhanden: false, hinweis: "kein Token hinterlegt" };
  if (!kopf) return {
    vorhanden: false,
    hinweis: cred.secret ? "Token-ID fehlt" : "Geheimnis fehlt",
    benutzer: cred.user || null, tokenId: cred.tokenId || null
  };
  const wert = kopf.Authorization;
  const bis = wert.lastIndexOf("=");
  return {
    vorhanden: true,
    form: wert.slice(0, bis + 1) + "••••••••",
    benutzer: cred.user || null,
    tokenId: cred.tokenId || null,
    hinweis: cred.tokenId && cred.tokenId.includes("!")
      ? "Token-ID enthält bereits Benutzer@Realm — der Benutzer wird dann nicht davorgesetzt"
      : null
  };
}

/* Aus einer erfolgreichen Antwort das herausziehen, was die Frage
   beantwortet — nicht die Rohdaten, sondern das Zählbare. */
function befundFuer(host, pfad, data) {
  if (pfad === "/version") {
    const v = data || {};
    return v.version ? `Version ${v.version}${v.release ? " (" + v.release + ")" : ""}` : "Antwort ohne Versionsangabe";
  }

  if (pfad === "/nodes") {
    const nodes = data || [];
    const namen = nodes.map(n => n.node);
    if (!namen.length) return "Die Knotenliste ist leer — dem Token fehlen Leserechte auf /nodes";
    const treffer = namen.find(n => String(n).toLowerCase() === String(host.id).toLowerCase()
      || String(n).toLowerCase() === String(host.name || "").toLowerCase());
    const gewaehlt = treffer || (nodes.length === 1 ? namen[0] : null);
    return `${namen.length} Knoten: ${namen.join(", ")} — `
      + (treffer ? `„${treffer}" passt zur Kennung`
        : gewaehlt ? `keiner passt zur Kennung „${host.id}", aber es gibt nur einen: „${gewaehlt}" wird genommen`
        : `KEINER passt zur Kennung „${host.id}" — die Kennung muss dem Knotennamen entsprechen`);
  }

  if (pfad === "/cluster/resources") {
    const alle = data || [];
    if (!alle.length) return "Die Liste ist leer — Proxmox filtert sie nach Rechten, das ist also ein Rechteproblem";
    const jeKnoten = zaehle(alle.map(r => r.node || "(ohne Knoten)"));
    const jeTyp = zaehle(alle.map(r => r.type));
    const kopf = `${alle.length} Einträge — Typen: ${alsListe(jeTyp)} · Knoten: ${alsListe(jeKnoten)}`;
    /* Der Knoten selbst steht hier auch drin. Kommen ausschließlich solche
       Einträge, ist die Liste inhaltlich genauso leer — nur sieht man es
       ihr nicht an. */
    const bestand = alle.filter(r => r.type !== "node");
    if (!bestand.length) return kopf + " — NUR Knoten-Einträge: keine Gäste, keine Speicher sichtbar";
    return kopf;
  }

  if (pfad === "/cluster/status") {
    const cl = (data || []).find(x => x.type === "cluster");
    return cl ? `Cluster „${cl.name}", Quorum ${cl.quorate === 1 ? "ja" : "NEIN"}` : "kein Cluster — Einzelknoten";
  }

  if (pfad === "/status/datastore-usage") {
    const st = data || [];
    return st.length ? `${st.length} Datastore(s): ${st.map(s => s.store).join(", ")}` : "keine Datastores sichtbar — Rechteproblem";
  }

  if (pfad.startsWith("/nodes/localhost/tasks")) {
    const t = data || [];
    return `${t.length} Aufgabe(n) in der Liste`;
  }

  if (pfad.startsWith("/statistics/mail")) {
    const d = data || {};
    return d.count_in != null ? `Eingang 24 h: ${d.count_in}` : "Antwort ohne Zählwerte";
  }

  return Array.isArray(data) ? `${data.length} Einträge` : "Antwort erhalten";
}

/* Ein Satz, woran es hängt — und zwar am ersten Schritt, der nicht durchkam. */
function fazit(host, b) {
  const gescheitert = b.api.find(a => !a.ok && !a.optional);
  if (gescheitert) {
    const wo = `${gescheitert.pfad} (${gescheitert.fehler})`;
    if (gescheitert.status === 401)
      return { problem: true, text: `Die Anmeldung wird abgelehnt: ${wo}. Token-ID und Geheimnis prüfen — `
        + `die Token-ID lautet vollständig Benutzer@Realm!Name, das Geheimnis gibt es nur beim Anlegen zu sehen.` };
    if (gescheitert.status === 403)
      return { problem: true, text: `Angemeldet, aber ohne Leserechte: ${wo}. Rolle PVEAuditor auf / mit Vererbung setzen — `
        + `bei „Privilege Separation“ dem Token selbst, nicht nur dem Benutzer.` };
    if (gescheitert.status === 404)
      return { problem: true, text: `Erreicht, aber der Endpunkt fehlt: ${wo}. Meist der falsche Port — `
        + `Proxmox VE 8006, Backup Server 8007, Mail Gateway 8006.` };
    return { problem: true, text: `Der Abruf bricht bei ${wo} ab.` };
  }

  /* Ein abgelehnter Aufruf, der als „optional" gilt, ist trotzdem ein
     Befund: er sagt, welches Recht fehlt. Als Nebensache abzutun, was die
     Ursache benennt, wäre der Sinn der Diagnose verfehlt. */
  const rechtefehler = b.api.find(a => !a.ok && a.status === 403);
  const res = b.api.find(a => a.pfad === "/cluster/resources");
  const nurKnoten = res?.ok && /NUR Knoten-Einträge/.test(res.befund || "");
  const leer = res?.ok && /Liste ist leer/.test(res.befund || "");

  if (nurKnoten || leer) {
    const was = leer ? "die Bestandsliste kommt leer zurück"
      : "es kommen nur Knoten-Einträge zurück — keine Gäste, keine Speicher";
    const dazu = rechtefehler
      ? ` Passend dazu wird ${rechtefehler.pfad} abgelehnt${
          /Sys\.Audit/.test(rechtefehler.antwort || "") ? " (Sys.Audit auf / fehlt)" : ""}.`
      : "";
    return { problem: true, text: `Der Token darf die Knoten sehen, aber ${was}.${dazu} `
      + `Proxmox filtert diese Liste nach Rechten, statt sie abzulehnen — die Rolle greift also nicht auf „/“. ${RECHTEHINWEIS}` };
  }

  if (rechtefehler)
    return { problem: true, text: `Die Kennzahlen kommen an, aber ${rechtefehler.pfad} wird abgelehnt`
      + `${/Sys\.Audit/.test(rechtefehler.antwort || "") ? " (Sys.Audit auf / fehlt)" : ""}. `
      + `Clustername und Quorum bleiben deshalb leer. ${RECHTEHINWEIS}` };

  const nodes = b.api.find(a => a.pfad === "/nodes");
  if (nodes?.ok && /KEINER passt/.test(nodes.befund || ""))
    return { problem: true, text: `Die Kennung „${host.id}" kommt in der Knotenliste nicht vor. `
      + `Sie muss dem Knotennamen im Cluster entsprechen — unter Verwaltung umbenennen oder das System neu anlegen.` };

  if (res?.ok) {
    const eigen = new RegExp(`\\b${host.id}\\b`, "i").test(res.befund || "");
    if (!eigen && !/keiner passt/i.test(nodes?.befund || ""))
      return { problem: true, text: `Es kommen Einträge zurück, aber keiner für „${host.id}". `
        + `Vermutlich gehören sie zu einem anderen Knoten des Clusters.` };
  }

  if (!b.netz.some(n => n.ok))
    return { problem: true, text: "Keine der Netzprüfungen kam durch — das System ist gar nicht erreichbar." };

  return { problem: false, text: "Alle Aufrufe kommen durch. Der Sammler bekommt, was er braucht." };
}

const zaehle = liste => liste.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
const alsListe = m => [...m.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
const kurzfassung = t => (t ? String(t).replace(/\s+/g, " ").slice(0, 200) : null);

/* ---------- Für die Ausgabe im Terminal ---------- */
export function alsText(b) {
  const z = [];
  const ja = ok => (ok === null ? "· " : ok ? "OK" : "!!");
  z.push(`System   ${b.host.id}  (${b.host.type})`);
  if (b.host.ip) z.push(`Adresse  ${b.host.ip}`);
  if (b.ziel) z.push(`API      ${b.ziel}`);
  if (b.zugang) {
    z.push(`Zugang   ${b.zugang.vorhanden ? b.zugang.form : "— " + b.zugang.hinweis}`);
    if (b.zugang.vorhanden && b.zugang.hinweis) z.push(`         Hinweis: ${b.zugang.hinweis}`);
  }
  z.push("");
  z.push("Netz");
  for (const n of b.netz)
    z.push(`  ${n.uebersprungen ? "· " : ja(n.ok)}  ${n.schritt.padEnd(10)} ${n.ms != null ? String(n.ms).padStart(5) + " ms" : "      "}  ${n.detail || ""}`);
  if (b.api.length) {
    z.push("");
    z.push("API");
    for (const a of b.api) {
      z.push(`  ${ja(a.ok)}  ${a.pfad}${a.optional ? "  (optional)" : ""}`);
      z.push(`      ${a.zweck}`);
      if (a.ok) z.push(`      -> ${a.befund}${a.ms != null ? `  [${a.ms} ms]` : ""}`);
      else {
        z.push(`      -> ${a.fehler}`);
        if (a.antwort) z.push(`      -> Antwort: ${a.antwort}`);
      }
    }
  }
  z.push("");
  z.push(b.ok ? "Ergebnis: in Ordnung." : "Woran es hängt:");
  z.push(`  ${b.fazit}`);
  return z.join("\n");
}
