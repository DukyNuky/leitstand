/* Prüfungen ohne Zugangsdaten: erreichbar, wie schnell, wie lange noch gültig.
   Jede Prüfung liefert dasselbe Ergebnis-Objekt:
     { ok, ms, detail, extra? }
   Eine Prüfung wirft nie — ein Fehlschlag ist ein Ergebnis, kein Absturz. */

import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
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
    return fail(e.name === "AbortError" ? `Zeitüberschreitung nach ${timeout} ms` : errText(e), Date.now() - t0);
  } finally { clearTimeout(timer); }
}

/* ---- DNS: löst der Resolver noch auf? ---- */
export function dnsCheck({ host, port = 53, query = "example.com", timeout = 4000 }) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const r = new dns.Resolver({ timeout, tries: 1 });
    r.setServers([port === 53 ? host : `${host}:${port}`]);
    let settled = false;
    const done = x => { if (settled) return; settled = true; resolve(x); };
    const guard = setTimeout(() => { try { r.cancel(); } catch {} done(fail(`DNS-Zeitüberschreitung nach ${timeout} ms`, timeout)); }, timeout + 200);
    r.resolve4(query, (err, addr) => {
      clearTimeout(guard);
      const ms = Date.now() - t0;
      if (err) return done(fail(`DNS: ${err.code || err.message}`, ms));
      done(pass(ms, `${query} → ${addr[0]}`, { answers: addr.length }));
    });
  });
}

/* ---- ICMP: nutzt das System-ping, weil roher ICMP root bräuchte ---- */
let pingAvailable = null;
export async function hasPing() {
  if (pingAvailable !== null) return pingAvailable;
  try { await execFileP("ping", ["-V"], { timeout: 2000 }); pingAvailable = true; }
  catch { try { await execFileP("ping", ["-c", "1", "-W", "1", "127.0.0.1"], { timeout: 3000 }); pingAvailable = true; }
          catch { pingAvailable = false; } }
  return pingAvailable;
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
    return fail(/unknown host|Name or service/i.test(e.stderr || "") ? "Name nicht auflösbar" : "keine Antwort", Date.now() - t0);
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
  if (target.url) { try { return new URL(target.url).hostname; } catch {} }
  return null;
}

export async function runCheck(check, target, settings = {}) {
  const timeout = (settings.timeout ?? 4) * 1000;
  const host = targetHost(check, target);
  if (!host && check.kind !== "http") return fail("kein Prüfziel — weder ip noch url am System");
  switch (check.kind) {
    case "tcp":  return tcpCheck({ host, port: check.port, timeout });
    case "tls":  return tlsCheck({ host, port: check.port || 443, servername: check.servername, timeout });   /* SNI folgt aus host, wenn kein Name gesetzt ist */
    case "http": return httpCheck({ url: check.url, timeout, expect: check.expect });
    case "dns":  return dnsCheck({ host, port: check.port || 53, query: check.query, timeout });
    case "icmp": return settings.icmp === false
      ? { ok: null, ms: null, detail: "ICMP abgeschaltet", skipped: true }
      : icmpCheck({ host, timeout });
    default: return fail(`unbekannte Prüfung „${check.kind}“`);
  }
}
