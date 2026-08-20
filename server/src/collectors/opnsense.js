/* OPNsense — Zugang, Verbindungstest und die Pfade, die der Sammler
   brauchen wird.

   Anders als Proxmox: die Anmeldung läuft über HTTP Basic, der API-Key
   steht als Benutzer, das Secret als Passwort. So dokumentiert es OPNsense
   selbst (`curl -k -u "$key":"$secret" .../api/core/firmware/status`).

   Ein Vorbehalt, der hier festgehalten gehört: die OPNsense-Dokumentation
   listet die Endpunkte, aber keine Antwortschemata — welche Felder
   zurückkommen, steht nirgends. Zudem wurden die Diagnose-Pfade zwischen
   den Fassungen umbenannt (früher systemInformation, heute
   system_information). Deshalb kennt jeder Eintrag hier mögliche
   Schreibweisen, und die Diagnose probiert sie der Reihe nach durch und
   berichtet, welche geantwortet hat. Erst danach wird der Sammler gegen
   die tatsächlichen Felder gebaut — nicht gegen Vermutungen. */

import { requestJson } from "../http.js";

export function authHeader(cred) {
  if (!cred) return null;
  const key = cred.key || cred.apiKey || cred.user;
  const secret = cred.secret || cred.password;
  if (!key || !secret) return null;
  return { Authorization: "Basic " + Buffer.from(`${key}:${secret}`).toString("base64") };
}

export function baseUrl(host) {
  if (host.url) {
    try {
      const u = new URL(host.url);
      return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`;
    } catch {}
  }
  return `https://${host.ip}`;
}

/* Was der Sammler später lesen soll — in der Reihenfolge der Wichtigkeit.
   `alternativen` fängt die Umbenennungen zwischen den OPNsense-Fassungen. */
export const PFADE = [
  { pfad: "/api/core/firmware/status", zweck: "Fassung und offene Aktualisierungen" },
  {
    pfad: "/api/diagnostics/system/system_information",
    alternativen: ["/api/diagnostics/system/systemInformation"],
    zweck: "Name, Fassung, Laufzeit"
  },
  {
    pfad: "/api/diagnostics/system/system_resources",
    alternativen: ["/api/diagnostics/system/systemResources"],
    zweck: "Arbeitsspeicher und Last"
  },
  {
    pfad: "/api/diagnostics/system/system_disk",
    alternativen: ["/api/diagnostics/system/systemDisk"],
    zweck: "Plattenbelegung",
    optional: true
  },
  {
    pfad: "/api/diagnostics/interface/get_interface_statistics",
    alternativen: ["/api/diagnostics/interface/getInterfaceStatistics"],
    zweck: "Durchsatz je Schnittstelle",
    optional: true
  },
  {
    pfad: "/api/wireguard/service/show",
    zweck: "WireGuard: Peers, letzter Handshake, übertragene Menge",
    optional: true,
    fehlendOk: "WireGuard ist auf diesem Gerät nicht eingerichtet oder das Plugin fehlt"
  }
];

export async function api(host, cred, pfad, timeout = 8000) {
  const headers = authHeader(cred);
  if (!headers) return { ok: false, error: "Kein API-Key hinterlegt" };
  return requestJson(`${baseUrl(host)}${pfad}`, { headers, timeout });
}

/* Verbindungstest für die Verwaltung: erreichbar, angemeldet — und was
   der Schlüssel tatsächlich lesen darf. Nur /api/core/firmware/status zu
   fragen, wäre dieselbe Falle wie bei Proxmox' /version. */
export async function testConnection(host, cred) {
  const fw = await api(host, cred, "/api/core/firmware/status", 6000);
  if (!fw.ok) return { ok: false, detail: fw.error, hint: hintFor(fw) };

  const d = fw.data || {};
  const fassung = d.product_version || d.product?.product_version || d.os_version || null;
  const teile = [`Verbunden — OPNsense${fassung ? " " + fassung : ""}`];

  /* Der Diagnose-Zweig hängt an anderen Rechten als der Firmware-Zweig. */
  const sys = await ersterTreffer(host, cred,
    ["/api/diagnostics/system/system_information", "/api/diagnostics/system/systemInformation"]);
  if (!sys.ok) {
    return {
      ok: false,
      detail: teile[0] + ` — aber die Systemauskunft ist nicht lesbar: ${sys.error}`,
      hint: "Dem Schlüssel fehlen Rechte für den Diagnose-Zweig. In OPNsense unter "
        + "System → Access → Users die Gruppe des Benutzers prüfen; für reines Ablesen genügt "
        + "eine Gruppe mit den Diagnostics-Rechten.",
      version: fassung
    };
  }
  teile.push("Systemauskunft lesbar");

  const wg = await api(host, cred, "/api/wireguard/service/show", 6000);
  teile.push(wg.ok ? "WireGuard lesbar" : "WireGuard nicht lesbar (Plugin fehlt oder keine Rechte)");

  return { ok: true, detail: teile.join(" · "), version: fassung, ms: fw.ms };
}

export async function ersterTreffer(host, cred, pfade) {
  let letzte = null;
  for (const p of pfade) {
    const r = await api(host, cred, p, 6000);
    if (r.ok) return { ...r, pfad: p };
    letzte = { ...r, pfad: p };
    /* Nur bei „gibt es nicht" die nächste Schreibweise probieren — bei 401
       oder 403 hilft ein anderer Pfad nicht, das ist eine Rechtefrage. */
    if (r.status !== 404) break;
  }
  return letzte;
}

function hintFor(r) {
  if (r.status === 401) return "Schlüssel oder Secret stimmen nicht. In OPNsense unter System → Access → Users "
    + "beim Benutzer einen API-Schlüssel erzeugen — die heruntergeladene Datei enthält beide Werte.";
  if (r.status === 403) return "Angemeldet, aber ohne Rechte: die Gruppe des Benutzers braucht Leserechte "
    + "auf den entsprechenden Zweig.";
  if (r.status === 404) return "Erreicht, aber kein OPNsense-Endpunkt — Adresse und Port prüfen.";
  return null;
}
