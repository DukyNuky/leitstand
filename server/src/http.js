/* Kleiner HTTPS-Helfer.

   Nötig, weil im Heimnetz fast jedes Gerät ein eigensigniertes Zertifikat
   trägt und fetch() dafür keinen einfachen Schalter kennt. */

import https from "node:https";
import http from "node:http";

export function requestJson(url, { method = "GET", headers = {}, body = null, timeout = 8000, insecure = true } = {}) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, error: `ungültige Adresse: ${url}` }); }
    const mod = u.protocol === "https:" ? https : http;
    const t0 = Date.now();
    const req = mod.request(u, {
      method,
      headers: { accept: "application/json", "user-agent": "leitstand/0.1", ...headers },
      rejectUnauthorized: u.protocol === "https:" ? !insecure : undefined,
      timeout
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const ms = Date.now() - t0;
        if (res.statusCode >= 400) return resolve({ ok: false, status: res.statusCode, ms, error: httpError(res.statusCode), body: text.slice(0, 400) });
        try { resolve({ ok: true, status: res.statusCode, ms, data: text ? JSON.parse(text) : null }); }
        catch { resolve({ ok: false, status: res.statusCode, ms, error: "Antwort ist kein JSON", body: text.slice(0, 200) }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: `Zeitüberschreitung nach ${timeout} ms` }); });
    req.on("error", e => resolve({ ok: false, error: netError(e) }));
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function httpError(code) {
  if (code === 401) return "Zugangsdaten abgelehnt (401)";
  if (code === 403) return "Zugriff verweigert — Rechte des Tokens prüfen (403)";
  if (code === 404) return "Endpunkt nicht gefunden (404) — Version prüfen";
  if (code >= 500) return `Gerät meldet Fehler (${code})`;
  return `HTTP ${code}`;
}
function netError(e) {
  switch (e.code) {
    case "ECONNREFUSED": return "Verbindung abgewiesen — läuft die Oberfläche auf diesem Port?";
    case "EHOSTUNREACH": return "Host nicht erreichbar";
    case "ENOTFOUND":    return "Name nicht auflösbar";
    case "ETIMEDOUT":    return "Zeitüberschreitung";
    case "CERT_HAS_EXPIRED": return "Zertifikat abgelaufen";
    default: return e.code || e.message;
  }
}
