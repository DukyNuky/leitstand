/* Die TeamSpeak-Prüfung — die zweite, die über UDP fragt, und die erste,
   bei der ein offener Port gar nichts hieße.

   Geprüft wird gegen einen nachgebauten Server auf 127.0.0.1: ein echtes
   Init1-Paket hin, eine echte Antwort zurück, dieselbe Zerlegung wie im
   Betrieb. Die Fälle sind die, an denen eine naive UDP-Prüfung vorbeiläuft
   — ein Dienst, der annimmt und schweigt, ein Reflektor, der unser eigenes
   Paket zurückwirft, und ein Port, an dem nichts zuhört. */

import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { ts3Check, ts3Init1, ts3Antwort, runCheck } from "../src/probe.js";

/* ---------- Ein TeamSpeak-Server, so klein wie möglich ---------- */

/* Die Antwort auf Schritt 0: kürzerer Kopf als die Frage (ohne Client-Id),
   Schritt 1, 16 Byte Serverzufall, dahinter der Zufall des Clients in
   umgekehrter Reihenfolge — genau so antwortet ein echter Server. */
function antwortAuf(frage, { schritt = 0x01, kennung = "TS3INIT1", echo = true } = {}) {
  const a0 = frage.subarray(22, 26);
  const p = Buffer.alloc(32);
  p.write(kennung, 0, "ascii");
  p.writeUInt16BE(0x65, 8);
  p.writeUInt8(0x88, 10);
  p.writeUInt8(schritt, 11);
  for (let i = 12; i < 28; i++) p[i] = i;                 /* A1, hier beliebig */
  Buffer.from(echo ? [...a0].reverse() : [0, 0, 0, 0]).copy(p, 28);
  return p;
}

async function tsServer(opt = {}) {
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    if (opt.stumm) return;                                /* nimmt an, antwortet nie */
    sock.send(opt.spiegel ? msg : antwortAuf(msg, opt), rinfo.port, rinfo.address);
  });
  await new Promise(r => sock.bind(0, "127.0.0.1", r));
  return { port: sock.address().port, zu: () => new Promise(r => { sock.close(r); }) };
}

/* Ein Port, an dem sicher nichts zuhört: einen belegen, die Nummer
   merken, wieder freigeben. */
async function freierPort() {
  const s = await tsServer();
  const port = s.port;
  await s.zu();
  return port;
}

/* ---------- Das Paket selbst ---------- */
test("Das Init1-Paket ist das, was ein Client als erstes schickt", () => {
  const { paket, a0 } = ts3Init1();
  assert.equal(paket.length, 34);
  assert.equal(paket.subarray(0, 8).toString("ascii"), "TS3INIT1");
  assert.equal(paket.readUInt16BE(8), 0x65, "Paket-Id 101");
  assert.equal(paket.readUInt16BE(10), 0, "Client-Id ist null");
  assert.equal(paket[12], 0x88, "Typ 8 (Init1), unverschlüsselt");
  assert.equal(paket[17], 0x00, "Schritt 0");
  assert.deepEqual([...paket.subarray(22, 26)], [...a0], "der Zufall steht im Paket");
});

/* ---------- Die Antwort ---------- */
test("Die Antwort des Servers gilt — samt zurückgespiegeltem Zufall", () => {
  const { paket, a0 } = ts3Init1();
  const a = ts3Antwort(antwortAuf(paket), a0);
  assert.equal(a.fehler, undefined);
  assert.equal(a.echo, true);
});

test("Unser eigenes Paket zurück ist keine Antwort", () => {
  /* Der Fall, an dem die Kennung allein scheitert: ein Reflektor wirft
     „TS3INIT1" zurück, weil wir es selbst geschickt haben. An Stelle 11
     steht dann die Client-Id, nicht Schritt 1. */
  const { paket, a0 } = ts3Init1();
  const a = ts3Antwort(paket, a0);
  assert.match(a.fehler, /Schritt|zurückgespiegelt/);
});

test("Fremde Pakete werden nicht für einen Handschlag gehalten", () => {
  const { a0 } = ts3Init1();
  assert.match(ts3Antwort(Buffer.from("irgendwas anderes hier"), a0).fehler, /kein TeamSpeak/);
  assert.match(ts3Antwort(Buffer.from([1, 2, 3]), a0).fehler, /zu kurz/);
});

/* ---------- Die Prüfung im Ganzen ---------- */
test("Ein antwortender TeamSpeak-Server ist grün — mit Port und Protokoll im Befund", async () => {
  const s = await tsServer();
  try {
    const r = await ts3Check({ host: "127.0.0.1", port: s.port, timeout: 2000 });
    assert.equal(r.ok, true);
    assert.match(r.detail, new RegExp(`UDP/${s.port}`), "wo geantwortet wurde, gehört in den Befund");
    assert.equal(r.extra.proto, "UDP");
    assert.equal(r.extra.echo, true);
    assert.ok(r.ms >= 0);
  } finally { await s.zu(); }
});

test("Ein Dienst, der annimmt und schweigt, ist nicht grün", async () => {
  /* Der Grund, warum diese Prüfung überhaupt einen Handschlag führt:
     ein Portklopfen sähe hier keinen Unterschied zu einem laufenden
     Server. */
  const s = await tsServer({ stumm: true });
  try {
    const r = await ts3Check({ host: "127.0.0.1", port: s.port, timeout: 300 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /keine Antwort/);
    assert.equal(r.ms, 300);
  } finally { await s.zu(); }
});

test("Ein Reflektor macht aus unserem Paket keinen Server", async () => {
  const s = await tsServer({ spiegel: true });
  try {
    const r = await ts3Check({ host: "127.0.0.1", port: s.port, timeout: 2000 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /Antwort über UDP/);
  } finally { await s.zu(); }
});

test("Eine Antwort mit fremder Kennung zählt nicht", async () => {
  const s = await tsServer({ kennung: "NICHTTS3" });
  try {
    const r = await ts3Check({ host: "127.0.0.1", port: s.port, timeout: 2000 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /kein TeamSpeak-Handschlag/);
  } finally { await s.zu(); }
});

test("Hört nichts zu, wird das gesagt — und nicht als Zeitüberschreitung", async () => {
  /* Der Rechner selbst antwortet mit „Port unreachable". Das ist eine
     andere Auskunft als Schweigen: der Rechner läuft, der Dienst nicht.
     Ohne verbundenen Socket bekäme der Prozess dieses ICMP nie zu sehen. */
  const r = await ts3Check({ host: "127.0.0.1", port: await freierPort(), timeout: 2000 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /hört nichts zu|Port unreachable/);
});

/* ---------- Über den Einstiegspunkt ---------- */
test("Ohne Portangabe wird der Werksport 9987 gefragt", async () => {
  const r = await runCheck({ kind: "ts3" }, { ip: "127.0.0.1" }, { timeout: 0.3 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /9987/);
});

test("Die Prüfung fragt das System selbst, nicht den Namen aus seiner Oberfläche", async () => {
  /* Ein Reverse Proxy liefert keine Sprachverbindung aus. Steht am
     System eine IP, wird die gefragt — auch wenn die Oberfläche unter
     einem ganz anderen Namen erreichbar ist. */
  const s = await tsServer();
  try {
    const r = await runCheck({ kind: "ts3", port: s.port },
      { ip: "127.0.0.1", url: "https://ts.example.org" }, { timeout: 2 });
    assert.equal(r.ok, true);
  } finally { await s.zu(); }
});
