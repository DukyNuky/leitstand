/* Ein nachgebauter UniFi Network Controller.

   Wie die übrigen Attrappen in diesem Verzeichnis ein echter HTTP-Server,
   kein Stellvertreter der eigenen Funktionen. Nachgebaut sind genau die
   Eigenheiten, an denen der Sammler sonst erst am Gerät auffiele:

   - **Zwei Bauarten.** UniFi OS (Dream Machine, Cloud Key Gen2) meldet
     unter `/api/auth/login` an und hängt alles Weitere unter
     `/proxy/network`; die eigenständige Network Application meldet unter
     `/api/login` an und kennt kein Präfix.
   - **Und zwei Arten, das abzulehnen.** UniFi OS antwortet auf einen
     unbekannten Pfad mit 404. Die eigenständige Anwendung nicht: sie
     schützt alles unter `/api/` mit demselben Wachposten und weist einen
     Pfad, den sie nicht kennt — `/api/auth/login` etwa — mit **401 und
     `api.err.LoginRequired`** ab. Das ist derselbe Statuscode wie bei
     einem falschen Passwort, und genau darauf fiel der Sammler herein:
     er hielt die 401 für eine Auskunft über die Zugangsdaten, brach ab
     und versuchte `/api/login` nie.
   - **Zwei Anmeldungen.** Keks aus der Anmeldung oder API-Schlüssel im
     Kopf `X-API-KEY`.
   - **Zwei APIs.** Die klassische mit allen Zahlen und die
     Integration-API mit einem Ausschnitt. `nurIntegration` stellt den
     Fall nach, dass der Schlüssel nur diese trägt.
   - **Zwei Faktoren.** Ein Konto mit 2FA lehnt die Anmeldung mit einer
     Meldung ab, die nur im Rumpf steht, nicht im Statuscode. */

import http from "node:http";

export const UNIFI_USER = "leitstand";
export const UNIFI_PASS = "geheim";
export const UNIFI_KEY = "uni_9f8e7d6c5b4a";
export const SITE_ID = "f1e2d3c4b5a6";       /* Kennung der Integration-API */

function json(res, code, data, kopf = {}) {
  const b = JSON.stringify(data);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b), ...kopf });
  res.end(b);
}

const jetzt = Math.floor(Date.now() / 1000);

/* Drei Access Points, ein Switch. Genug, um „einer fehlt" von „keiner
   antwortet" zu unterscheiden. */
export function geraete(opt = {}) {
  const { zustaende = [1, 1, 1], cu = [62, 18], update = false } = opt;
  const ap = (i, state) => ({
    _id: `ap${i}`, mac: `aa:bb:cc:00:0${i}:01`, type: "uap", model: "U6LR",
    name: ["ap-wohnzimmer", "ap-buero", "ap-keller"][i] || `ap-${i}`,
    ip: `10.0.0.2${i}`, state, adopted: true,
    version: "6.6.65", upgradable: update && i === 0,
    uptime: 864000 - i * 1000, last_seen: jetzt - 20,
    "user-num_sta": 12 - i * 3, "guest-num_sta": i === 0 ? 1 : 0, num_sta: 13 - i * 3,
    satisfaction: 97 - i, general_temperature: 51 + i,
    "system-stats": { cpu: String(7.4 + i), mem: String(42.1 + i), uptime: String(864000 - i * 1000) },
    uplink: { type: "wire", uplink_device_name: "sw-keller", uplink_mac: "aa:bb:cc:00:ff:01" },
    radio_table: [
      { name: "wifi0", radio: "ng", channel: 6, ht: 20, tx_power: "low" },
      { name: "wifi1", radio: "na", channel: 44 + i * 4, ht: 80, tx_power: "high" }
    ],
    radio_table_stats: [
      { name: "wifi0", radio: "ng", channel: 6, cu_total: cu[0], cu_self_rx: 5, cu_self_tx: 9, "user-num_sta": 4, satisfaction: 88 },
      { name: "wifi1", radio: "na", channel: 44 + i * 4, cu_total: cu[1], cu_self_rx: 3, cu_self_tx: 4, "user-num_sta": 8 - i, satisfaction: 96 }
    ]
  });

  return [
    ...zustaende.map((st, i) => ap(i, st)),
    {
      _id: "sw1", mac: "aa:bb:cc:00:ff:01", type: "usw", model: "USW24POE", name: "sw-keller",
      ip: "10.0.0.10", state: opt.switchAus ? 0 : 1, adopted: true, version: "6.6.65",
      upgradable: false, uptime: 1728000, last_seen: jetzt - 15, num_sta: 0,
      "system-stats": { cpu: "3.0", mem: "31.0", uptime: "1728000" }
    }
  ];
}

/* Dasselbe, wie die Integration-API es ausgibt: benannte Zustände, keine
   Funkzahlen. */
function integrationGeraete(liste) {
  const NAME = { 0: "OFFLINE", 1: "ONLINE", 2: "PENDING_ADOPTION", 4: "UPDATING", 11: "ISOLATED" };
  return liste.map(d => ({
    id: d._id, name: d.name, model: d.model, type: d.type,
    macAddress: d.mac, ipAddress: d.ip,
    state: NAME[d.state] || "UNKNOWN",
    firmwareVersion: d.version, firmwareUpdatable: !!d.upgradable
  }));
}

export function fakeUnifi(opt = {}) {
  const {
    unifios = true,               /* UniFi OS mit Präfix /proxy/network */
    nurIntegration = false,       /* der Schlüssel trägt nur die Integration-API */
    zweiFaktoren = false,
    version = "9.0.114",
    sites = [{ name: "default", desc: "Zuhause" }],
    geraeteliste = null,
    health = null
  } = opt;

  const liste = geraeteliste || geraete(opt);
  /* Wonach der Test hinterher fragen kann: was tatsächlich abgerufen
     wurde. Damit lässt sich beweisen, dass die Clientliste ungelesen
     bleibt. */
  const gesehen = [];

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    gesehen.push(u.pathname);
    const keks = req.headers.cookie || "";
    const key = req.headers["x-api-key"] || "";

    /* ---- Anmeldung ---- */
    const loginPfad = unifios ? "/api/auth/login" : "/api/login";
    if (req.method === "POST" && u.pathname === loginPfad) {
      let roh = "";
      req.on("data", c => { roh += c; });
      req.on("end", () => {
        let b = {};
        try { b = JSON.parse(roh || "{}"); } catch {}
        if (zweiFaktoren)
          return json(res, 499, { code: "Ubic2faTokenRequired", message: "2fa required" });
        if (b.username !== UNIFI_USER || b.password !== UNIFI_PASS)
          return json(res, unifios ? 401 : 400, { meta: { rc: "error", msg: "api.err.Invalid" } });
        const name = unifios ? "TOKEN" : "unifises";
        return json(res, 200, { meta: { rc: "ok" }, data: [] },
          { "set-cookie": [`${name}=abc123; Path=/; HttpOnly`, "csrf_token=xyz; Path=/"] });
      });
      return;
    }
    /* Siehe oben: 404 nur bei UniFi OS. Die eigenständige Anwendung
       schickt ihren Wachposten vor, nicht ihr Wegverzeichnis. */
    if (req.method === "POST")
      return unifios
        ? json(res, 404, { message: "not found" })
        : json(res, 401, { meta: { rc: "error", msg: "api.err.LoginRequired" } });

    /* ---- Präfix ---- */
    let pfad = u.pathname;
    if (unifios) {
      if (!pfad.startsWith("/proxy/network")) return json(res, 404, { message: "not found" });
      pfad = pfad.slice("/proxy/network".length);
    } else if (pfad.startsWith("/proxy/network")) {
      return json(res, 404, { message: "not found" });
    }

    /* ---- Anmeldung geprüft ---- */
    const angemeldet = /(?:TOKEN|unifises)=/.test(keks);
    const mitKey = key === UNIFI_KEY;
    const integration = pfad.startsWith("/integration/");
    if (!angemeldet && !mitKey) return json(res, 401, { meta: { rc: "error", msg: "api.err.LoginRequired" } });
    /* Der Fall, für den es die Rückfallebene gibt: der Schlüssel gilt nur
       für die Integration-API, die klassische weist ihn ab. */
    if (nurIntegration && mitKey && !angemeldet && !integration)
      return json(res, 401, { meta: { rc: "error", msg: "api.err.LoginRequired" } });

    /* ---- Integration-API ---- */
    if (pfad === "/integration/v1/sites")
      return json(res, 200, { offset: 0, limit: 25, count: 1, totalCount: 1,
        data: sites.map(s => ({ id: SITE_ID, internalReference: s.name, name: s.desc })) });
    if (pfad === `/integration/v1/sites/${SITE_ID}/devices`)
      return json(res, 200, { offset: 0, limit: 25, count: liste.length, totalCount: liste.length,
        data: integrationGeraete(liste) });

    /* ---- Klassische API ---- */
    if (pfad === "/api/self/sites")
      return json(res, 200, { meta: { rc: "ok" }, data: sites });
    if (pfad === "/api/s/default/stat/device")
      return json(res, 200, { meta: { rc: "ok" }, data: liste });
    if (pfad === "/api/s/default/stat/health")
      return json(res, 200, { meta: { rc: "ok" }, data: health || [
        { subsystem: "wlan", status: "ok", num_user: 23, num_guest: 2, num_ap: 3,
          num_disconnected: 0, "rx_bytes-r": 1234567, "tx_bytes-r": 2345678 },
        { subsystem: "wan", status: "ok" },
        { subsystem: "lan", status: "ok" }
      ] });
    if (pfad === "/api/s/default/stat/sysinfo")
      return json(res, 200, { meta: { rc: "ok" }, data: [{ version, hostname: "unifi", update_available: false }] });

    return json(res, 404, { meta: { rc: "error", msg: "api.err.NoSiteContext" } });
  });

  server.gesehen = gesehen;
  return server;
}
