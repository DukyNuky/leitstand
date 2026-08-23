/* Die DNS-Prüfung — die einzige, die einen Resolver an dem misst, wofür
   es ihn gibt.

   Geprüft wird gegen einen nachgebauten Nameserver auf 127.0.0.1: ein
   echtes UDP-Paket, eine echte Antwort, dieselbe Zerlegung wie im Betrieb.
   Die Fälle sind die, an denen eine naive Prüfung vorbeiläuft — ein
   Resolver mit SERVFAIL antwortet ja, ein gefilterter Name kommt mit
   NOERROR und leerer Antwort zurück, und ein zugemachter UDP-Port sieht
   über TCP aus wie ein gesunder Dienst. */

import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import { dnsCheck, dnsFrage, dnsAntwort } from "../src/probe.js";

/* ---------- Ein Nameserver, so klein wie möglich ---------- */

/* Baut die Antwort auf eine Anfrage: Kopf gespiegelt, Frage angehängt,
   dahinter so viele A-Sätze wie gewünscht. Der Name im Antwortsatz wird
   gestaucht (0xC00C zeigt auf die Frage) — genau so, wie es echte
   Nameserver tun, und genau das muss der Prüfer überspringen können. */
function antwortAuf(frage, { rcode = 0, adressen = ["93.184.216.34"] } = {}) {
  const id = frage.readUInt16BE(0);
  /* Die Frage endet nach dem Namen plus vier Byte Typ und Klasse. */
  let p = 12;
  while (p < frage.length && frage[p] !== 0) p += frage[p] + 1;
  const frageEnde = p + 1 + 4;
  const frageTeil = frage.subarray(12, frageEnde);

  const kopf = Buffer.alloc(12);
  kopf.writeUInt16BE(id, 0);
  kopf.writeUInt16BE(0x8180 | rcode, 2);      /* Antwort, Rekursion verfügbar */
  kopf.writeUInt16BE(1, 4);
  kopf.writeUInt16BE(adressen.length, 6);

  const saetze = adressen.map(a => {
    const b = Buffer.alloc(16);
    b.writeUInt16BE(0xc00c, 0);               /* gestauchter Name: zeigt auf die Frage */
    b.writeUInt16BE(1, 2);                    /* Typ A */
    b.writeUInt16BE(1, 4);                    /* Klasse IN */
    b.writeUInt32BE(300, 6);                  /* TTL */
    b.writeUInt16BE(4, 10);
    for (const [i, teil] of a.split(".").entries()) b.writeUInt8(Number(teil), 12 + i);
    return b;
  });
  return Buffer.concat([kopf, frageTeil, ...saetze]);
}

async function nameserver(opt = {}) {
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    if (opt.stumm) return;                    /* nimmt an, antwortet nie */
    const out = antwortAuf(msg, opt);
    sock.send(out, rinfo.port, rinfo.address);
  });
  await new Promise(r => sock.bind(0, "127.0.0.1", r));
  return { port: sock.address().port, zu: () => new Promise(r => { sock.close(r); }) };
}

/* Derselbe Dienst über TCP — für den Fall „UDP blockiert, TCP trägt". */
async function nameserverTcp(opt = {}, port = 0) {
  const srv = net.createServer(sock => {
    let puffer = Buffer.alloc(0);
    sock.on("data", d => {
      puffer = Buffer.concat([puffer, d]);
      if (puffer.length < 2) return;
      const n = puffer.readUInt16BE(0);
      if (puffer.length < 2 + n) return;
      const out = antwortAuf(puffer.subarray(2, 2 + n), opt);
      const laenge = Buffer.alloc(2);
      laenge.writeUInt16BE(out.length, 0);
      sock.end(Buffer.concat([laenge, out]));
    });
    sock.on("error", () => {});
  });
  await new Promise(r => srv.listen(port, "127.0.0.1", r));
  return { port: srv.address().port, zu: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }) };
}

/* ---------- Die Anfrage selbst ---------- */
test("Die Anfrage ist eine gültige DNS-Nachricht", () => {
  const f = dnsFrage("example.org", 4711);
  assert.equal(f.readUInt16BE(0), 4711, "Kennung steht vorn");
  assert.equal(f.readUInt16BE(2), 0x0100, "Standardanfrage mit erwünschter Rekursion");
  assert.equal(f.readUInt16BE(4), 1, "genau eine Frage");
  /* 7example3org0 + Typ + Klasse */
  assert.equal(f.length, 12 + 1 + 7 + 1 + 3 + 1 + 4);
  assert.equal(f.subarray(13, 20).toString(), "example");
});

test("Ein unbrauchbarer Name wird abgelehnt, statt ein kaputtes Paket zu senden", () => {
  assert.throws(() => dnsFrage("", 1));
  assert.throws(() => dnsFrage("a".repeat(64) + ".de", 1));
});

test("Die Antwort wird gelesen, auch wenn der Name gestaucht ist", () => {
  const f = dnsFrage("example.org", 99);
  const a = dnsAntwort(antwortAuf(f, { adressen: ["10.1.2.3", "10.1.2.4"] }), 99);
  assert.equal(a.rcode, 0);
  assert.equal(a.antworten, 2);
  assert.deepEqual(a.adressen, ["10.1.2.3", "10.1.2.4"]);
});

test("Eine Antwort mit fremder Kennung wird nicht angenommen", () => {
  const f = dnsFrage("example.org", 99);
  const a = dnsAntwort(antwortAuf(f, {}), 12345);
  assert.match(a.fehler, /Kennung/);
});

/* ---------- Die Prüfung im Ganzen ---------- */
test("Ein antwortender Resolver ist grün — samt aufgelöster Adresse", async () => {
  const ns = await nameserver({ adressen: ["93.184.216.34"] });
  try {
    const r = await dnsCheck({ host: "127.0.0.1", port: ns.port, query: "example.org", timeout: 2000 });
    assert.equal(r.ok, true);
    assert.match(r.detail, /example\.org → 93\.184\.216\.34/);
    assert.match(r.detail, /UDP/, "über welches Protokoll gefragt wurde, gehört in den Befund");
    assert.equal(r.extra.proto, "UDP");
    assert.ok(r.ms >= 0);
  } finally { await ns.zu(); }
});

test("SERVFAIL ist kein Erfolg — er antwortet, löst aber nicht auf", async () => {
  const ns = await nameserver({ rcode: 2, adressen: [] });
  try {
    const r = await dnsCheck({ host: "127.0.0.1", port: ns.port, query: "example.org", timeout: 2000 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /SERVFAIL/);
  } finally { await ns.zu(); }
});

test("NXDOMAIN wird benannt und nicht als Netzfehler ausgegeben", async () => {
  const ns = await nameserver({ rcode: 3, adressen: [] });
  try {
    const r = await dnsCheck({ host: "127.0.0.1", port: ns.port, query: "example.org", timeout: 2000 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /NXDOMAIN/);
  } finally { await ns.zu(); }
});

test("NOERROR ohne einen einzigen Satz gilt nicht als aufgelöst", async () => {
  /* Genau das liefert ein Filter, der den Prüfnamen blockt. Als grün
     durchzuwinken hieße: „er antwortet" mit „er löst auf" zu verwechseln. */
  const ns = await nameserver({ rcode: 0, adressen: [] });
  try {
    const r = await dnsCheck({ host: "127.0.0.1", port: ns.port, query: "example.org", timeout: 2000 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /keine Adresse/);
    assert.match(r.detail, /Filterliste/, "der wahrscheinlichste Grund gehört dazu");
  } finally { await ns.zu(); }
});

test("Schweigt er über UDP, wird das nach dem Zeitlimit gemeldet", async () => {
  const ns = await nameserver({ stumm: true });
  try {
    const r = await dnsCheck({ host: "127.0.0.1", port: ns.port, query: "example.org", timeout: 400 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /keine Antwort über UDP/);
  } finally { await ns.zu(); }
});

test("Antwortet er über TCP, aber nicht über UDP, steht genau das im Befund", async () => {
  /* Der eigentliche Grund für die eigene Prüfung: der Systemauflöser
     fiele hier still auf TCP zurück und meldete Erfolg — während im Netz
     kein Gerät mehr auflöst. */
  /* UDP und TCP haben getrennte Portnummernräume: der stumme UDP-Dienst
     gibt die Nummer vor, der TCP-Dienst wird auf dieselbe gelegt. Genau
     die Lage, die auf einem Gerät entsteht, dessen Firewall UDP/53
     verwirft und TCP/53 durchlässt. */
  const udp = await nameserver({ stumm: true });
  const tcp = await nameserverTcp({ adressen: ["10.0.0.9"] }, udp.port);
  try {
    const r = await dnsCheck({ host: "127.0.0.1", port: udp.port, query: "example.org", timeout: 400 });
    assert.equal(r.ok, false, "über TCP zu antworten macht einen Resolver nicht gesund");
    assert.match(r.detail, /UDP\/53 kommt nicht durch/);
  } finally { await udp.zu(); await tcp.zu(); }
});

test("Schweigt er auf beiden Wegen, steht auch das da", async () => {
  const udp = await nameserver({ stumm: true });
  try {
    const r = await dnsCheck({ host: "127.0.0.1", port: udp.port, query: "example.org", timeout: 400 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /auch über TCP/);
  } finally { await udp.zu(); }
});

test("Ausdrücklich über TCP gefragt wird auch über TCP gemessen", async () => {
  const tcp = await nameserverTcp({ adressen: ["10.0.0.9"] });
  try {
    const r = await dnsCheck({ host: "127.0.0.1", port: tcp.port, query: "example.org", proto: "tcp", timeout: 2000 });
    assert.equal(r.ok, true);
    assert.match(r.detail, /TCP/);
    assert.equal(r.extra.proto, "TCP");
  } finally { await tcp.zu(); }
});
