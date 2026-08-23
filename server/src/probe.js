/* Prüfungen ohne Zugangsdaten: erreichbar, wie schnell, wie lange noch gültig.
   Jede Prüfung liefert dasselbe Ergebnis-Objekt:
     { ok, ms, detail, extra? }
   Eine Prüfung wirft nie — ein Fehlschlag ist ein Ergebnis, kein Absturz. */

import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const fail = (detail, ms = null) => ({ ok: false, ms, detail });
const pass = (ms, detail, extra) => ({ ok: true, ms, detail, extra });

/* ---- TCP: Verbindung aufbauen, sofort wieder schließen ---- */
export function tcpCheck({ host, port, timeout = 4000 }) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const done = r => { if (settled) return; settled = true; sock.destroy(); resolve(r); };

    sock.setTimeout(timeout);
    sock.once("connect", () => done(pass(Date.now() - t0, `Port ${port} offen`)));
    sock.once("timeout", () => done(fail(`Zeitüberschreitung nach ${timeout} ms`, timeout)));
    sock.once("error", e => done(fail(errText(e), Date.now() - t0)));
    sock.connect(port, host);
  });
}

/* ---- TLS: Handshake plus Restlaufzeit des Zertifikats ---- */
export function tlsCheck({ host, port = 443, servername, timeout = 4000 }) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let settled = false;
    const sock = tls.connect({
      host, port,
      servername: servername || (net.isIP(host) ? undefined : host),
      rejectUnauthorized: false,      /* Eigensignierte Zertifikate sind im Heimnetz die Regel */
      timeout
    });
    const done = r => { if (settled) return; settled = true; sock.destroy(); resolve(r); };

    sock.once("secureConnect", () => {
      const cert = sock.getPeerCertificate();
      const ms = Date.now() - t0;
      if (!cert || !cert.valid_to) return done(pass(ms, "TLS steht, kein Zertifikat lesbar"));
      const days = Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000);
      const selfSigned = !!cert.issuer && !!cert.subject &&
        JSON.stringify(cert.issuer) === JSON.stringify(cert.subject);
      done(pass(ms, days < 0 ? `seit ${Math.abs(days)} Tagen abgelaufen` : `gültig noch ${days} Tage`, {
        days,
        cn: cert.subject?.CN || host,
        issuer: selfSigned ? "eigensigniert" : (cert.issuer?.O || cert.issuer?.CN || "unbekannt"),
        selfSigned,
        validTo: cert.valid_to
      }));
    });
    sock.once("timeout", () => done(fail(`TLS-Zeitüberschreitung nach ${timeout} ms`, timeout)));
    sock.once("error", e => done(fail(errText(e), Date.now() - t0)));
  });
}

/* ---- HTTP(S): Statuscode holen, Inhalt verwerfen ---- */
export async function httpCheck({ url, timeout = 4000, expect = null }) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "manual",
      headers: { "user-agent": "leitstand/0.1" }
    });
    const ms = Date.now() - t0;
    const good = expect ? res.status === expect : res.status < 500;
    return good
      ? pass(ms, `HTTP ${res.status}`, { status: res.status })
      : fail(`HTTP ${res.status}`, ms);
  } catch (e) {
    /* `fetch` verpackt den eigentlichen Fehler: oben steht „fetch failed",
       der Grund (ECONNREFUSED, ENOTFOUND …) hängt in `cause`. Ohne diesen
       Griff stünde an einer Kachel „fetch failed" — eine Meldung, aus der
       niemand ableiten kann, ob der Dienst aus ist oder der Name nicht
       auflöst. */
    return fail(e.name === "AbortError" ? `Zeitüberschreitung nach ${timeout} ms` : errText(e.cause || e), Date.now() - t0);
  } finally { clearTimeout(timer); }
}

/* ---- DNS: löst der Resolver noch auf? ----

   Gefragt wird über **UDP/53**, und zwar mit einer selbst gebauten
   Anfrage statt über `dns.Resolver`. Der Grund ist der Fall, um den es
   hier eigentlich geht: ein Resolver, dessen UDP-Port zu ist. Der
   Systemauflöser fällt dann still auf TCP zurück und meldet Erfolg —
   während im Netz kein einziges Gerät mehr auflöst, weil kein Gerät
   von sich aus TCP versucht. Eine Überwachung, die das nicht
   auseinanderhält, meldet Grün für einen toten DNS-Dienst.

   Umgekehrt gilt: kommt über UDP gar nichts, wird einmal TCP versucht.
   Nicht als Rückfall, sondern als Befund — antwortet er dort, ist nicht
   der Dienst weg, sondern UDP/53 blockiert, und das ist eine ganz
   andere Suche. Das steht dann in der Meldung. */

const RCODE = { 0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED" };

/* Eine Standardanfrage nach dem A-Satz eines Namens. Zwölf Byte Kopf,
   der Name in Längen-Label-Form, dann Typ und Klasse. */
export function dnsFrage(name, id) {
  const teile = String(name).replace(/\.$/, "").split(".").filter(Boolean);
  if (!teile.length) throw new Error("kein Name zum Auflösen angegeben");
  const labels = [];
  for (const t of teile) {
    const b = Buffer.from(t, "ascii");
    if (!b.length || b.length > 63) throw new Error(`„${name}“ ist kein gültiger Name`);
    labels.push(Buffer.from([b.length]), b);
  }
  labels.push(Buffer.from([0]));
  const kopf = Buffer.alloc(12);
  kopf.writeUInt16BE(id, 0);
  kopf.writeUInt16BE(0x0100, 2);            /* Anfrage, Rekursion erwünscht */
  kopf.writeUInt16BE(1, 4);                 /* genau eine Frage */
  const ende = Buffer.alloc(4);
  ende.writeUInt16BE(1, 0);                 /* QTYPE  A */
  ende.writeUInt16BE(1, 2);                 /* QCLASS IN */
  return Buffer.concat([kopf, ...labels, ende]);
}

/* Namen überspringen — auch die gestauchte Schreibweise (zwei Byte, die
   auf eine frühere Stelle zeigen), die in Antworten die Regel ist. */
function ueberspringeName(buf, p) {
  while (p < buf.length) {
    const len = buf[p];
    if (len === 0) return p + 1;
    if ((len & 0xc0) === 0xc0) return p + 2;
    p += len + 1;
  }
  return p;
}

/* Aus der Antwort wird nur gelesen, was für die Frage „antwortet er
   richtig?" zählt: Kennung, Antwortcode, Zahl der Antworten und die
   erste A-Adresse. Alles Weitere wäre ein halber Resolver. */
export function dnsAntwort(buf, id) {
  if (!buf || buf.length < 12) return { fehler: "Antwort zu kurz" };
  if (buf.readUInt16BE(0) !== id) return { fehler: "fremde Antwort — die Kennung passt nicht zur Anfrage" };
  const flags = buf.readUInt16BE(2);
  if (!(flags & 0x8000)) return { fehler: "das war keine Antwort, sondern eine Anfrage" };
  const rcode = flags & 0x0f;
  const fragen = buf.readUInt16BE(4), antworten = buf.readUInt16BE(6);
  let p = 12;
  for (let i = 0; i < fragen; i++) { p = ueberspringeName(buf, p); p += 4; }
  const adressen = [];
  for (let i = 0; i < antworten && p + 10 <= buf.length; i++) {
    p = ueberspringeName(buf, p);
    if (p + 10 > buf.length) break;
    const typ = buf.readUInt16BE(p);
    const laenge = buf.readUInt16BE(p + 8);
    p += 10;
    if (typ === 1 && laenge === 4 && p + 4 <= buf.length) adressen.push([...buf.subarray(p, p + 4)].join("."));
    p += laenge;
  }
  return { rcode, antworten, adressen, gekuerzt: !!(flags & 0x0200) };
}

/* Eine gelesene Antwort bewerten — für UDP und TCP dieselbe Regel. */
function bewerte(buf, id, { query, port, ms, proto }) {
  const a = dnsAntwort(buf, id);
  if (a.fehler) return { ...fail(`DNS: ${a.fehler}`, ms), geantwortet: true };
  if (a.rcode !== 0)
    return { ...fail(`DNS: ${RCODE[a.rcode] || "RCODE " + a.rcode} für ${query} (${proto}/${port})`, ms), geantwortet: true };
  /* NOERROR ohne einen einzigen Satz heißt: er hat geantwortet und nichts
     gefunden. Als „erreichbar" durchzuwinken wäre falsch — auflösen tut er
     dann nämlich nicht. Der häufigste Grund steht gleich dabei, weil er
     hier besonders naheliegt: der Prüfname steht auf einer Filterliste. */
  if (!a.antworten)
    return { ...fail(`antwortet, liefert aber keine Adresse für ${query} — steht der Name auf einer Filterliste?`, ms), geantwortet: true };
  return pass(ms, `${query} → ${a.adressen[0] || a.antworten + " Antworten"} (${proto}/${port})`,
    { answers: a.antworten, proto, addr: a.adressen[0] || null });
}

function dnsUeberUdp({ host, port = 53, query = "example.com", timeout = 4000 }) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const id = 1 + Math.floor(Math.random() * 65534);
    let frage;
    try { frage = dnsFrage(query, id); } catch (e) { return resolve(fail(e.message)); }

    const sock = dgram.createSocket(net.isIPv6(host) ? "udp6" : "udp4");
    let settled = false;
    const done = r => {
      if (settled) return;
      settled = true;
      clearTimeout(uhr);
      try { sock.close(); } catch {}
      resolve(r);
    };
    const uhr = setTimeout(() => done(fail(`keine Antwort über UDP/${port} nach ${timeout} ms`, timeout)), timeout);
    sock.on("error", e => done(fail(errText(e), Date.now() - t0)));
    sock.on("message", msg => done(bewerte(msg, id, { query, port, ms: Date.now() - t0, proto: "UDP" })));
    sock.send(frage, port, host, e => { if (e) done(fail(errText(e), Date.now() - t0)); });
  });
}

/* DNS über TCP ist dieselbe Nachricht mit zwei Byte Länge davor. */
function dnsUeberTcp({ host, port = 53, query = "example.com", timeout = 4000 }) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const id = 1 + Math.floor(Math.random() * 65534);
    let frage;
    try { frage = dnsFrage(query, id); } catch (e) { return resolve(fail(e.message)); }
    const laenge = Buffer.alloc(2);
    laenge.writeUInt16BE(frage.length, 0);

    const sock = new net.Socket();
    let settled = false, puffer = Buffer.alloc(0);
    const done = r => { if (settled) return; settled = true; sock.destroy(); resolve(r); };
    sock.setTimeout(timeout);
    sock.once("connect", () => sock.write(Buffer.concat([laenge, frage])));
    sock.on("data", d => {
      puffer = Buffer.concat([puffer, d]);
      if (puffer.length < 2) return;
      const n = puffer.readUInt16BE(0);
      if (puffer.length < 2 + n) return;
      done(bewerte(puffer.subarray(2, 2 + n), id, { query, port, ms: Date.now() - t0, proto: "TCP" }));
    });
    sock.once("timeout", () => done(fail(`keine Antwort über TCP/${port} nach ${timeout} ms`, timeout)));
    sock.once("error", e => done(fail(errText(e), Date.now() - t0)));
    sock.connect(port, host);
  });
}

export async function dnsCheck(opt) {
  const port = opt.port || 53;
  if (opt.proto === "tcp") return dnsUeberTcp({ ...opt, port });
  const udp = await dnsUeberUdp({ ...opt, port });
  /* Hat er über UDP geantwortet — und sei es mit SERVFAIL —, ist die Frage
     beantwortet. Nur wenn gar nichts kam, lohnt der zweite Versuch. */
  if (udp.ok || udp.geantwortet) return udp;
  const tcp = await dnsUeberTcp({ ...opt, port });
  return tcp.ok
    ? { ...udp, detail: `${udp.detail} — über TCP/${port} antwortet er dagegen: UDP/53 kommt nicht durch` }
    : { ...udp, detail: `${udp.detail} (auch über TCP/${port} nicht)` };
}

/* ---- ICMP: nutzt das System-ping, weil roher ICMP root bräuchte ---- */
let pingAvailable = null;
/* Ob `ping` benutzbar ist — und zwar von diesem Prozess.

   Geprüft wird mit einem echten Paket an die eigene Adresse, nicht mit
   `ping -V`: dass die Datei da ist, sagt nichts darüber, ob der Prozess
   sie benutzen darf. Genau daran hing der Fehler, der eine Strecke rot
   meldete, die man aus demselben Behälter von Hand anpingen konnte —
   von Hand nämlich als root. */
export async function hasPing() {
  if (pingAvailable !== null) return pingAvailable;
  try {
    await execFileP("ping", ["-n", "-c", "1", "-W", "1", "127.0.0.1"], { timeout: 3000 });
    pingAvailable = true;
  } catch (e) {
    if (icmpGrund(`${e.stderr || ""} ${e.stdout || ""} ${e.message || ""}`) === "recht") pingAvailable = false;
    else {
      /* Loopback-ICMP kann auch aus anderen Gründen scheitern. Dann
         entscheidet, ob es das Programm überhaupt gibt. */
      try { await execFileP("ping", ["-V"], { timeout: 2000 }); pingAvailable = true; }
      catch { pingAvailable = false; }
    }
  }
  return pingAvailable;
}

/* Warum `ping` nicht konnte, ist keine Nebensache.

   Drei Ausgänge, die nichts miteinander zu tun haben, und lange sahen
   zwei davon gleich aus:

   1. Das Ziel schweigt — eine Auskunft über das Netz. Exit 1.
   2. Der Name ist nicht auflösbar — eine Auskunft über den Eintrag.
   3. `ping` darf nicht. Der Dienst läuft unprivilegiert (USER node im
      Abbild); fehlt dem Behälter NET_RAW oder erlaubt der Wirt
      unprivilegierte ICMP-Sockets nicht, scheitert der Aufruf mit
      „Operation not permitted" — **ohne ein einziges Paket zu senden.**

   Der dritte Fall als „keine Antwort" gemeldet ist eine Falschaussage
   über das Ziel: eine Strecke steht rot da, die man aus demselben
   Behälter von Hand anpingen kann (als root nämlich, und der darf).
   Er zählt deshalb als übersprungen, wie ein fehlendes `ping` auch — und
   sagt in der Oberfläche, woran es liegt.

   Gemerkt wird es außerdem: ein Rechteproblem geht nicht vorbei, und
   ohne diese Notiz liefe der Prober bei jedem System aufs Neue in
   denselben Fehler. */
export function icmpGrund(text) {
  const t = String(text || "");
  if (/unknown host|name or service|not known|cannot resolve/i.test(t)) return "name";
  if (/operation not permitted|permission denied|must be root|lacking privilege|socket: address family/i.test(t)) return "recht";
  return null;
}

export async function icmpCheck({ host, timeout = 4000 }) {
  if (!(await hasPing())) return { ok: null, ms: null, detail: "ping nicht verfügbar — übersprungen", skipped: true };
  const t0 = Date.now();
  try {
    const secs = Math.max(1, Math.round(timeout / 1000));
    const { stdout } = await execFileP("ping", ["-n", "-c", "1", "-W", String(secs), host], { timeout: timeout + 1000 });
    const m = stdout.match(/time[=<]\s*([\d.]+)\s*ms/i);
    return pass(m ? Math.round(parseFloat(m[1])) : Date.now() - t0, "antwortet");
  } catch (e) {
    const grund = icmpGrund(`${e.stderr || ""} ${e.stdout || ""} ${e.message || ""}`);
    if (grund === "name") return fail("Name nicht auflösbar", Date.now() - t0);
    if (grund === "recht") {
      pingAvailable = false;
      return { ok: null, ms: null, skipped: true,
        detail: "ICMP nicht erlaubt — der Dienst läuft unprivilegiert. Dem Behälter fehlt NET_RAW "
          + "(in docker-compose.yml: cap_add: [NET_RAW]). Gesendet wurde kein einziges Paket." };
    }
    return fail("keine Antwort", Date.now() - t0);
  }
}

function errText(e) {
  switch (e.code) {
    case "ECONNREFUSED": return "Verbindung abgewiesen";
    case "EHOSTUNREACH": return "Host nicht erreichbar";
    case "ENETUNREACH":  return "Netz nicht erreichbar";
    case "ETIMEDOUT":    return "Zeitüberschreitung";
    case "ENOTFOUND":    return "Name nicht auflösbar";
    case "ECONNRESET":   return "Verbindung zurückgesetzt";
    case "EACCES":       return "Zugriff verweigert";
    default: return e.code || e.message || "unbekannter Fehler";
  }
}

/* ---- Einstiegspunkt: eine Prüfung nach Bauart ausführen ---- */
/* Wonach die Prüfung fragt: ausdrücklich am Check, sonst die Adresse des
   Systems, sonst der Hostname aus seiner Oberflächen-URL. Ohne den letzten
   Schritt liefen Prüfungen für Systeme, die nur über eine URL definiert
   sind, ins Leere — und meldeten den lokalen Rechner. */
export function targetHost(check, target = {}) {
  if (check.ip || check.host) return check.ip || check.host;
  if (target.ip || target.host) return target.ip || target.host;
  if (target.url) { const n = urlHost(target.url); if (n) return n; }
  return null;
}

/* Für Port- und TLS-Prüfungen gibt es bis zu zwei Ziele: die IP des Systems
   und den Namen aus seiner Oberflächen-Adresse. Meistens ist das dasselbe.
   Nicht dasselbe ist es, wenn die Oberfläche hinter einem Reverse Proxy
   liegt — dann steht auf dem System selbst kein Port 443 offen, obwohl die
   Seite im Browser einwandfrei kommt, und der Leitstand meldete dafür einen
   Teilausfall. Umgekehrt löst ein interner Name nicht überall auf, deshalb
   wird nicht einfach der Name genommen.

   Also beides, und es genügt, wenn eines trägt. Die IP kommt zuerst: an
   allem, was heute schon trägt, ändert sich damit nichts, der Name ist der
   zweite Versuch. Nennt die Prüfung selbst ein Ziel, gilt nur dieses. */
export function targetHosts(check, target = {}) {
  const liste = [];
  const nimm = v => { if (v && !liste.includes(v)) liste.push(v); };
  nimm(targetHost(check, target));
  if (!check.ip && !check.host && target.url) nimm(urlHost(target.url));
  return liste;
}

function urlHost(url) {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, ""); } catch { return null; }
}

/* Der Reihe nach versuchen, bis eines antwortet. Wer geantwortet hat, steht
   im Ergebnis — sonst stünde da „Port 443 offen“, ohne zu sagen, wo. */
async function ersterTreffer(ziele, pruefe) {
  let erst = null;
  for (const [i, host] of ziele.entries()) {
    const r = await pruefe(host);
    if (r.ok) return i === 0 ? r : { ...r, ziel: host, detail: `${r.detail} (über ${host})` };
    if (i === 0) erst = r;
  }
  const weitere = ziele.slice(1);
  return weitere.length
    ? { ...erst, detail: `${erst.detail} — auch ${weitere.join(", ")} antwortet nicht` }
    : erst;
}

export async function runCheck(check, target, settings = {}) {
  const timeout = (settings.timeout ?? 4) * 1000;
  const ziele = targetHosts(check, target);
  const host = ziele[0] || null;
  if (!host && check.kind !== "http") return fail("kein Prüfziel — weder ip noch url am System");
  switch (check.kind) {
    case "tcp":  return ersterTreffer(ziele, h => tcpCheck({ host: h, port: check.port, timeout }));
    /* SNI folgt aus dem Ziel, wenn kein Name gesetzt ist — hinter einem
       Reverse Proxy ist genau das nötig, damit er das richtige Zertifikat
       zeigt statt irgendeines. */
    case "tls":  return ersterTreffer(ziele, h => tlsCheck({ host: h, port: check.port || 443, servername: check.servername, timeout }));
    case "http": return httpCheck({ url: check.url, timeout, expect: check.expect });
    /* DNS und ICMP fragen das System selbst, nicht seine Oberflächen-Adresse:
       ein Resolver antwortet auf seiner IP, nicht auf dem Namen, unter dem
       ein Proxy seine Weboberfläche ausliefert. */
    case "dns":  return dnsCheck({ host, port: check.port || 53, query: check.query, proto: check.proto, timeout });
    case "icmp": return settings.icmp === false
      ? { ok: null, ms: null, detail: "ICMP abgeschaltet", skipped: true }
      : icmpCheck({ host, timeout });
    default: return fail(`unbekannte Prüfung „${check.kind}“`);
  }
}
