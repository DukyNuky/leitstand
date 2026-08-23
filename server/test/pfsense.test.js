/* Der pfSense-Sammler, geprüft gegen ein nachgebautes API-Paket.

   pfSense CE hat keine Schnittstelle ab Werk; gelesen wird über
   pfSense-pkg-API. Das Paket zählt zwei Fassungen, die verschieden
   anmelden und unter verschiedenen Pfaden liegen — beide sind im Feld
   anzutreffen, und der Sammler muss beide finden, ohne dass jemand
   einträgt, welche läuft.

   Die Antwortfelder stammen aus den pfSense-Internas (get_interface_info,
   return_gateways_status) und sind nirgends verbindlich beschrieben.
   Deshalb gibt es hier ausdrücklich einen Fall mit *anderen* Feldnamen:
   Was der Sammler nicht deuten kann, muss zu einem Strich werden und darf
   ihn nicht umwerfen. */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { collectPfsense, testConnection, authHeader, nutzlast, alsListe } from "../src/collectors/pfsense.js";
import { vergiss } from "../src/collectors/durchsatz.js";

const KEY = "pf-1a2b3c4d5e6f";
const CRED = { key: KEY };

/* Der Umschlag, den das Paket um jede Antwort legt. */
const umschlag = data => ({ code: 200, status: "ok", response_id: "SUCCESS", message: "", data });

/* Antwortet wie ein echtes Gerät. `fassung` schaltet zwischen v2 und v1,
   `ab` verändert einzelne Antworten. */
function pfsense(ab = {}) {
  const v = ab.fassung || 2;
  let runde = 0;
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => {
      const b = JSON.stringify(obj);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
      res.end(b);
    };
    /* v2 meldet mit X-API-Key an, v1 mit einer Authorization-Zeile. */
    const ok = v === 2
      ? req.headers["x-api-key"] === KEY
      : req.headers.authorization === "id-1 token-2";
    if (!ok) return send(401, { code: 401, status: "unauthorized", message: "Authentication failed" });

    const p = new URL(req.url, "http://x").pathname;
    if (!p.startsWith(`/api/v${v}/`)) return send(404, { code: 404, status: "not found", message: "Endpoint not found" });
    const rest = p.replace(`/api/v${v}`, "");

    if (rest === "/status/system")
      return send(200, umschlag(ab.system ?? {
        uptime: "3 days, 20:56:43",
        cpu_usage: 12, mem_usage: 43, disk_usage: 61,
        load_avg: ["0.68", "0.41", "0.35"],
        temp: 47
      }));

    if (rest === "/system/version")
      return send(200, umschlag(ab.version ?? {
        version: "2.7.2", latest_version: "2.7.2", update_available: false, platform: "FreeBSD 14.0"
      }));

    /* v2 schreibt „interfaces", v1 schrieb „interface". */
    if (rest === "/status/interfaces" || rest === "/status/interface") {
      runde++;
      const zu = n => (ab.ruecksetzen && runde > 1 ? 0 : n + (runde - 1) * 1_500_000);
      const pak = n => n + (runde - 1) * 1_000;
      const fehler = n => n + (ab.fehlerWachsen ? (runde - 1) * 3 : 0);
      return send(200, umschlag(ab.interfaces ?? [
        { name: "lan", descr: "LAN", hwif: "igb0", status: "up", mtu: 1500,
          inbytes: zu(81_386_215_378), outbytes: zu(557_996_298_083),
          inpkts: pak(120_000_000), outpkts: pak(140_000_000),
          inerrs: 0, outerrs: 0, collisions: 0 },
        { name: "wan", descr: "WAN", hwif: "igb1", status: "down", mtu: 1492,
          inbytes: zu(562_774_671_970), outbytes: zu(78_304_533_217),
          inpkts: pak(400_000_000), outpkts: pak(300_000_000),
          inerrs: fehler(17), outerrs: 0, collisions: 0 },
        /* Loopback und OpenVPN sind keine Leitungen. */
        { name: "lo0", descr: "Loopback", hwif: "lo0", status: "up", inbytes: 5, outbytes: 5 },
        { name: "ovpns1", descr: "VPN", hwif: "ovpns1", status: "up", inbytes: 9, outbytes: 9 }
      ]));
    }

    if (rest === "/status/gateways" || rest === "/status/gateway")
      return send(200, umschlag(ab.gateways ?? [
        { name: "WAN_DHCP", status: "online", substatus: "none", monitorip: "1.1.1.1",
          srcip: "192.0.2.10", delay: "8.4ms", stddev: "1.1ms", loss: "0.0%" },
        { name: "LTE_BACKUP", status: "down", substatus: "none", monitorip: "8.8.8.8",
          srcip: "198.51.100.4", delay: "~", stddev: "~", loss: "100.0%" }
      ]));

    if (rest === "/firewall/states/size")
      return send(200, umschlag(ab.states ?? { current_states: 4_210, maximum_states: 98_000 }));

    if (rest === "/status/carp") {
      if (ab.carp === false) return send(404, { code: 404, status: "not found" });
      return send(200, umschlag(ab.carp ?? {
        enable: true, maintenance_mode: false,
        carp_interfaces: [{ interface: "wan", vhid: 1, status: "MASTER" }]
      }));
    }

    if (rest === "/status/wireguard/peers" || rest === "/vpn/wireguard/peers" || rest === "/vpn/wireguard/peer") {
      if (ab.wireguard === false) return send(404, { code: 404, status: "not found" });
      if (ab.wireguard === 403) return send(403, { code: 403, status: "forbidden" });
      return send(200, umschlag(ab.wireguard ?? [
        { name: "WG-Zweitstandort", publickey: "Aqujl", tun: "tun_wg0",
          endpoint: "203.0.113.9", endpointport: 51820, allowedips: ["10.99.0.2/32"],
          latest_handshake: Math.floor(Date.now() / 1000) - 45,
          transferrx: 1_157_470_889, transfertx: 4_185_660_632, persistentkeepalive: 25 },
        { name: "laptop", publickey: "Bbcd", tun: "tun_wg0", allowedips: ["10.99.0.3/32"],
          latest_handshake: 0, transferrx: 0, transfertx: 0 }
      ]));
    }

    return send(404, { code: 404, status: "not found", message: "Endpoint not found" });
  });
  return srv;
}

async function an(ab) {
  const srv = pfsense(ab);
  const url = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
  vergiss();                       /* Zählerstände aus einem früheren Fall vergessen */
  return { srv, host: { id: "fw-02", name: "fw-02", type: "pfsense", url } };
}

const GRENZE = { disk_warn: 80, disk_crit: 90, ram_warn: 85, ram_crit: 95 };

/* ---------- Zugang ---------- */
test("Ein Schlüssel wird als X-API-Key gesendet — so meldet Fassung 2 an", () => {
  assert.deepEqual(authHeader({ key: KEY }), { "X-API-Key": KEY });
});

test("Fassung 1 meldet mit Client-ID und Token an", () => {
  assert.deepEqual(authHeader({ clientId: "id-1", clientToken: "token-2" }),
    { Authorization: "id-1 token-2" });
});

test("Ohne Zugangsdaten wird gar nicht erst gefragt", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectPfsense(host, null, GRENZE);
    assert.match(r.error, /Kein API-Schlüssel/);
  } finally { srv.close(); }
});

test("Falscher Schlüssel wird als abgelehnte Anmeldung erklärt, nicht verschwiegen", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectPfsense(host, { key: "falsch" }, GRENZE);
    assert.equal(r.status, "warn", "erreichbar mit unbrauchbarem Zugang gehört auf Gelb");
    assert.match(r.note, /401|abgelehnt|Authentication/i);
  } finally { srv.close(); }
});

/* ---------- Beide Fassungen des Pakets ---------- */
test("Fassung 2 wird gefunden", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.equal(r.api, "v2");
    assert.equal(r.version, "2.7.2");
  } finally { srv.close(); }
});

/* Ein Gerät mit dem alten Paket antwortet auf /api/v2/… mit 404. Der
   Sammler muss dann die ältere Schreibweise nehmen, ohne dass jemand
   einträgt, welche Fassung läuft. */
test("Läuft noch Fassung 1, wird die alte Schreibweise genommen", async () => {
  const { srv, host } = await an({ fassung: 1 });
  try {
    const r = await collectPfsense(host, { clientId: "id-1", clientToken: "token-2" }, GRENZE);
    assert.equal(r.api, "v1");
    assert.equal(r.version, "2.7.2");
    assert.ok(r.interfaces.length, "auch die Schnittstellen kommen unter dem alten Pfad");
  } finally { srv.close(); }
});

/* Bei 401 hilft ein anderer Pfad nicht — das ist eine Rechtefrage, und
   weiterzufragen erzeugt nur Rauschen und Last auf dem Gerät. */
test("Nach einer abgelehnten Anmeldung wird nicht die nächste Schreibweise probiert", async () => {
  let versuche = 0;
  const srv = http.createServer((req, res) => {
    versuche++;
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 401, status: "unauthorized" }));
  });
  const url = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
  try {
    await collectPfsense({ id: "x", type: "pfsense", url }, CRED, GRENZE);
    /* Sieben Belange, je genau ein Versuch — nicht je drei Schreibweisen. */
    assert.equal(versuche, 7, `es wurden ${versuche} Aufrufe gemacht`);
  } finally { srv.close(); }
});

/* ---------- Systemzustand ---------- */
test("Laufzeit, Last, Speicher und Platte werden gelesen", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.equal(r.uptimeSeconds, 3 * 86400 + 20 * 3600 + 56 * 60 + 43);
    assert.equal(r.uptime, "3 T 20 h");
    assert.equal(r.ram, 43);
    assert.equal(r.disk, 61);
    assert.equal(r.cpu, 12);
    assert.equal(r.load1, 0.68);
    assert.equal(r.tempC, 47);
  } finally { srv.close(); }
});

/* Belegungen kommen je nach Fassung als Zahl, als „43%" oder als Anteil. */
test("Belegung wird aus Zahl, Prozenttext und Anteil gleich gelesen", async () => {
  for (const [wert, erwartet] of [[43, 43], ["43%", 43], ["43 %", 43], [0.43, 43]]) {
    const { srv, host } = await an({ system: { mem_usage: wert, uptime: "1:00:00" } });
    try {
      assert.equal((await collectPfsense(host, CRED, GRENZE)).ram, erwartet, `aus ${JSON.stringify(wert)}`);
    } finally { srv.close(); }
  }
});

/* ---------- Schnittstellen ---------- */
test("Je Schnittstelle kommen Zustand, Rate, Pakete und Zähler", async () => {
  const { srv, host } = await an();
  try {
    await collectPfsense(host, CRED, GRENZE);
    await new Promise(r => setTimeout(r, 300));
    const r = await collectPfsense(host, CRED, GRENZE);

    const wan = r.interfaces.find(i => i.label === "WAN");
    assert.equal(wan.name, "igb1", "die Zeitreihe hängt am Gerät, nicht an der Beschriftung");
    assert.equal(wan.link, "down", "pfSense liefert den Verbindungszustand gleich mit");
    assert.equal(wan.mtu, 1492);
    assert.ok(wan.in > 0 && wan.out > 0);
    assert.ok(wan.inPps > 0);
    assert.equal(wan.fehler, 17);
    assert.equal(r.interfaces.find(i => i.label === "LAN").link, "up");
  } finally { srv.close(); }
});

test("Loopback und Tunnelgeräte sind keine Leitungen", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.deepEqual(r.interfaces.map(i => i.name).sort(), ["igb0", "igb1"]);
  } finally { srv.close(); }
});

/* Dieselbe Rechnung wie bei OPNsense — sie steht in durchsatz.js und gilt
   deshalb hier genauso: vor der zweiten Abfrage gibt es keinen Durchsatz. */
test("Durchsatz gibt es erst ab dem zweiten Durchlauf", async () => {
  const { srv, host } = await an();
  try {
    const erst = await collectPfsense(host, CRED, GRENZE);
    assert.equal(erst.thrIn, null, "ein einzelner Zählerstand ergibt keine Rate");
    assert.equal(erst.interfaces[0].in, null);

    await new Promise(r => setTimeout(r, 300));
    const dann = await collectPfsense(host, CRED, GRENZE);
    assert.ok(dann.thrIn > 0);
    assert.equal(dann.thrQuelle, "WAN");
  } finally { srv.close(); }
});

test("Zurückgesetzte Zähler ergeben keinen Wert statt eines falschen", async () => {
  const { srv, host } = await an({ ruecksetzen: true });
  try {
    await collectPfsense(host, CRED, GRENZE);
    await new Promise(r => setTimeout(r, 200));
    assert.equal((await collectPfsense(host, CRED, GRENZE)).thrIn, null);
  } finally { srv.close(); }
});

test("Neue Fehler stehen getrennt vom alten Stand und als Notiz am Gerät", async () => {
  const { srv, host } = await an({ fehlerWachsen: true });
  try {
    await collectPfsense(host, CRED, GRENZE);
    await new Promise(r => setTimeout(r, 200));
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.equal(r.interfaces.find(i => i.label === "WAN").fehlerNeu, 3);
  } finally { srv.close(); }
});

/* ---------- Gateways ---------- */
test("Gateways kommen mit Zustand, Latenz und Verlust", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    const wan = r.gateways.find(g => g.name === "WAN_DHCP");
    assert.equal(wan.status, "online");
    assert.equal(wan.rtt, 8.4, "„8.4ms“ wird zur Zahl");
    assert.equal(wan.verlust, 0);
    assert.equal(r.gateways.find(g => g.name === "LTE_BACKUP").verlust, 100);
  } finally { srv.close(); }
});

/* Ein ausgefallener Uplink ist die dringendste Aussage, die dieses Gerät
   zu machen hat — die Firewall selbst antwortet dabei tadellos. */
test("Ein ausgefallenes Gateway ist rot, nicht gelb", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.equal(r.status, "crit");
    assert.match(r.note, /LTE_BACKUP/);
  } finally { srv.close(); }
});

test("Verlust ohne Ausfall ist eine Warnung", async () => {
  const { srv, host } = await an({ gateways: [
    { name: "WAN_DHCP", status: "loss", monitorip: "1.1.1.1", delay: "12ms", loss: "6.0%" }
  ] });
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.equal(r.status, "warn");
    assert.match(r.note, /6 % Verlust/);
  } finally { srv.close(); }
});

/* ---------- Zustandstabelle ---------- */
test("Die Zustandstabelle wird gelesen und ins Verhältnis gesetzt", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.equal(r.states, 4210);
    assert.equal(r.statesMax, 98000);
    assert.equal(r.statesPct, 4);
  } finally { srv.close(); }
});

/* Läuft sie voll, bricht der Durchsatz ein, ohne dass eine Leitung
   ausfällt — von außen sieht das aus wie ein kaputtes Netz. */
test("Eine volle Zustandstabelle ist ein eigener Befund", async () => {
  const { srv, host } = await an({
    states: { current_states: 93_000, maximum_states: 98_000 },
    gateways: [{ name: "WAN_DHCP", status: "online", loss: "0.0%", delay: "8ms" }]
  });
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.equal(r.status, "crit");
    assert.match(r.note, /Zustandstabelle/);
  } finally { srv.close(); }
});

/* ---------- CARP ---------- */
test("Die CARP-Rolle wird gemeldet, dreht die Ampel aber nicht", async () => {
  const { srv, host } = await an({ gateways: [{ name: "WAN", status: "online", loss: "0.0%" }] });
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.equal(r.carp, "MASTER");
    assert.equal(r.carpWartung, false);
    assert.equal(r.status, undefined, "eine Rolle ist kein Befund");
    assert.match(r.note, /CARP MASTER/);
  } finally { srv.close(); }
});

test("Ohne CARP bleibt das Feld leer statt „nicht aktiv“ zu behaupten", async () => {
  const { srv, host } = await an({ carp: false });
  try {
    assert.equal((await collectPfsense(host, CRED, GRENZE)).carp, null);
  } finally { srv.close(); }
});

/* ---------- WireGuard ---------- */
test("Peers werden gelesen, der Handshake wird zum Alter", async () => {
  const { srv, host } = await an();
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.equal(r.wgPeers, 2);
    const wg = r.peers.find(p => p.name === "WG-Zweitstandort");
    assert.ok(wg.handshake >= 44 && wg.handshake <= 60, `Alter ${wg.handshake} s`);
    assert.equal(wg.key, "Aqujl", "der öffentliche Schlüssel überlebt eine Umbenennung");
    assert.equal(wg.endpoint, "203.0.113.9:51820");
    assert.equal(wg.allowed, "10.99.0.2/32");
    assert.equal(wg.rx, 1_157_470_889);
    assert.equal(r.wgStill, 1, "der Laptop hat sich nie gemeldet");
  } finally { srv.close(); }
});

/* Ein Peer, über den nichts bekannt ist, sieht sonst genauso aus wie
   einer, der sich nie gemeldet hat — und das ist ein Unterschied ums
   Ganze, weil daran ein Tunnelzustand hängt. */
test("Führt die Fassung keinen Handshake, wird das gesagt statt „nie gemeldet“", async () => {
  const { srv, host } = await an({
    wireguard: [{ name: "WG-Zweitstandort", publickey: "Aqujl", tun: "tun_wg0", allowedips: ["10.99.0.2/32"] }],
    gateways: [{ name: "WAN", status: "online", loss: "0.0%" }]
  });
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.equal(r.wgPeers, 1);
    assert.equal(r.peers[0].handshake, null);
    assert.equal(r.wgHandshakeUnbekannt, true);
    assert.match(r.note, /keinen Handshake/);
  } finally { srv.close(); }
});

test("Fehlendes WireGuard ist kein Fehler, ein gesperrtes schon", async () => {
  const ohne = await an({ wireguard: false, gateways: [{ name: "WAN", status: "online", loss: "0.0%" }] });
  try {
    const r = await collectPfsense(ohne.host, CRED, GRENZE);
    assert.equal(r.wgPeers, null);
    assert.equal(r.wgFehler, undefined, "nicht eingerichtet ist kein Befund");
  } finally { ohne.srv.close(); }

  const gesperrt = await an({ wireguard: 403, gateways: [{ name: "WAN", status: "online", loss: "0.0%" }] });
  try {
    const r = await collectPfsense(gesperrt.host, CRED, GRENZE);
    assert.equal(r.status, "warn");
    assert.match(r.note, /403/);
  } finally { gesperrt.srv.close(); }
});

/* ---------- Unerwartete Antworten ----------
   Die Feldnamen sind aus den pfSense-Internas abgeleitet, nicht
   versprochen. Antwortet eine Fassung anders, muss ein Strich
   herauskommen — und kein Absturz und keine erfundene Zahl. */
test("Unbekannte Feldnamen ergeben Striche, keinen Absturz", async () => {
  const { srv, host } = await an({
    system: { voellig: "anders", ganz: 1 },
    version: { irgendwas: true },
    interfaces: [{ voellig: "anders" }],
    gateways: [{ nichts: "dazu" }],
    states: { keine: "ahnung" },
    carp: { unbekannt: 1 },
    wireguard: [{ fremd: "feld" }]
  });
  try {
    const r = await collectPfsense(host, CRED, GRENZE);
    assert.equal(r.ram, null);
    assert.equal(r.disk, null);
    assert.equal(r.uptime, null);
    assert.equal(r.version, null);
    assert.equal(r.interfaces, null, "eine Zeile ohne Gerätenamen ist keine Leitung");
    assert.equal(r.states, null);
  } finally { srv.close(); }
});

test("Ein Umschlag ohne data wird trotzdem ausgepackt", () => {
  assert.deepEqual(nutzlast({ code: 200, data: { a: 1 } }), { a: 1 });
  assert.deepEqual(nutzlast({ a: 1 }), { a: 1 }, "ältere Fassungen antworten blank");
  assert.equal(nutzlast(null), null);
});

test("Listen und Abbildungen werden gleich gelesen", () => {
  assert.equal(alsListe([{ name: "wan" }]).length, 1);
  assert.equal(alsListe({ wan: { status: "up" } }).length, 1);
  assert.deepEqual(alsListe("unsinn"), []);
});

/* ---------- Schwellwerte ---------- */
test("Die Platte folgt den eigenen Grenzen des Systems", async () => {
  const { srv, host } = await an({
    system: { disk_usage: 84, uptime: "1:00:00" },
    gateways: [{ name: "WAN", status: "online", loss: "0.0%" }]
  });
  try {
    assert.equal((await collectPfsense(host, CRED, GRENZE)).status, "warn");
    const locker = await collectPfsense({ ...host, schwellen: { disk_warn: 90, disk_crit: 95 } }, CRED, GRENZE);
    assert.equal(locker.status, undefined, "84 % liegt unter 90");
    assert.equal(locker.schwellen.disk_warn, 90);
  } finally { srv.close(); }
});

/* ---------- Verbindungstest ---------- */
test("Der Verbindungstest prüft auch die Schnittstellen, nicht nur die Anmeldung", async () => {
  const { srv, host } = await an();
  try {
    const r = await testConnection(host, CRED);
    assert.equal(r.ok, true);
    assert.match(r.detail, /pfSense 2\.7\.2/);
    assert.match(r.detail, /API-Paket v2/);
    assert.match(r.detail, /Schnittstelle\(n\) lesbar/);
  } finally { srv.close(); }
});

test("Ein falscher Schlüssel wird im Test erklärt", async () => {
  const { srv, host } = await an();
  try {
    const r = await testConnection(host, { key: "falsch" });
    assert.equal(r.ok, false);
    assert.match(r.hint, /System → API/);
  } finally { srv.close(); }
});

test("Fehlt das Paket ganz, sagt der Test das statt „Zugang falsch“", async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html>pfSense</html>");
  });
  const url = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
  try {
    const r = await testConnection({ id: "x", type: "pfsense", url }, CRED);
    assert.equal(r.ok, false);
    assert.match(r.hint, /pfSense-pkg-API/);
  } finally { srv.close(); }
});
