/* Zeitreihen: was aufgezeichnet wird, muss einen Neustart überleben —
   und es muss dasselbe sein, was gemessen wurde.

   Geprüft wird gegen echte Dateien in einem Wegwerfverzeichnis, nicht
   gegen eine Attrappe der Ablage: die Fehler, die hier weh tun, sind
   Dateinamen über Mitternacht, eine abgeschnittene letzte Zeile und ein
   Aufräumen, das zu viel wegwirft. Keinen davon fände ein Test, der die
   Ablage nachbaut. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Verlauf, verdichte, belegteReihen, tagVon } from "../src/verlauf.js";
import { createServer } from "../src/server.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-verlauf-"));

/* Ein fester Zeitpunkt, damit die Rechnung nachvollziehbar bleibt.
   Mittags — damit kein Test an einer Zeitzone scheitert, die den Tag
   verschiebt. */
const T0 = new Date("2026-08-21T12:00:05").getTime();

test("Was in einem Takt gemessen wurde, steht als eine Zeile da — mit Spannweite", () => {
  const dir = tmp();
  const v = new Verlauf(dir, { takt: 60 });

  v.notiere("h", "pve", { ms: 10, cpu: 4, st: "ok" }, T0);
  v.notiere("h", "pve", { ms: 50, cpu: 8, st: "warn" }, T0 + 15000);
  v.notiere("h", "pve", { ms: 30, cpu: 6, st: "ok" }, T0 + 30000);
  assert.equal(v.schreibe(T0 + 30000), 0, "der laufende Takt bleibt offen");

  v.schreibe(T0 + 70000);
  const p = v.reihe("pve", { tage: 1, jetzt: T0 });
  assert.equal(p.length, 1);
  assert.equal(p[0].ms, 30, "Mittelwert");
  assert.equal(p[0].min, 10);
  assert.equal(p[0].max, 50, "der Ausreißer verschwindet nicht im Mittel");
  assert.equal(p[0].n, 3);
  assert.equal(p[0].cpu, 6);
  assert.equal(p[0].st, "warn", "die schlechteste Ampel des Taktes gewinnt");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Ein Neustart verliert nichts", () => {
  const dir = tmp();
  const a = new Verlauf(dir, { takt: 60 });
  a.notiere("h", "pve", { ms: 12, st: "ok" }, T0);
  a.schliesse();                                   /* wie beim Herunterfahren */

  const b = new Verlauf(dir, { takt: 60 });
  const p = b.reihe("pve", { tage: 1, jetzt: T0 });
  assert.equal(p.length, 1);
  assert.equal(p[0].ms, 12);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Was ein System nicht liefert, steht auch nicht in der Zeile", () => {
  const dir = tmp();
  const v = new Verlauf(dir, { takt: 60 });
  v.notiere("h", "ping-only", { ms: 3, cpu: null, ram: undefined, st: "ok" }, T0);
  v.schliesse();

  const p = v.reihe("ping-only", { tage: 1, jetzt: T0 });
  assert.equal("cpu" in p[0], false, "eine Null wäre eine Messung, die niemand gemacht hat");
  assert.equal("ram" in p[0], false);
  assert.deepEqual(belegteReihen(p).map(r => r.key), ["ms"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Systeme und Tunnel kommen sich nicht ins Gehege", () => {
  const dir = tmp();
  const v = new Verlauf(dir, { takt: 60 });
  v.notiere("h", "gleich", { ms: 10, st: "ok" }, T0);
  v.notiere("t", "gleich", { ms: 99, st: "ok" }, T0);
  v.schliesse();

  assert.equal(v.reihe("gleich", { tage: 1, art: "h", jetzt: T0 })[0].ms, 10);
  assert.equal(v.reihe("gleich", { tage: 1, art: "t", jetzt: T0 })[0].ms, 99);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Eine abgeschnittene Zeile verwirft nicht den ganzen Tag", () => {
  const dir = tmp();
  const v = new Verlauf(dir, { takt: 60 });
  v.notiere("h", "pve", { ms: 10, st: "ok" }, T0);
  v.schliesse();

  /* So sieht es aus, wenn der Strom mitten im Schreiben ausfällt. */
  const datei = path.join(dir, `${tagVon(T0)}.jsonl`);
  fs.appendFileSync(datei, '{"t":123,"k":"h","id":"pve","ms":9');
  v.notiere("h", "pve", { ms: 20, st: "ok" }, T0 + 120000);
  v.schliesse();

  const p = v.reihe("pve", { tage: 1, jetzt: T0 });
  assert.equal(p.length, 2, "die heilen Zeilen bleiben lesbar");
  assert.deepEqual(p.map(x => x.ms), [10, 20]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Alte Tage fallen heraus, der Rest bleibt", () => {
  const dir = tmp();
  const v = new Verlauf(dir, { takt: 60, tage: 90 });
  v.notiere("h", "pve", { ms: 1, st: "ok" }, T0 - 40 * 86400000);
  v.notiere("h", "pve", { ms: 2, st: "ok" }, T0);
  v.schliesse();
  assert.equal(fs.readdirSync(dir).filter(n => n.endsWith(".jsonl")).length, 2);

  v.einstellen({ tage: 30 });
  v.aufraeumen(T0);
  const bleibt = fs.readdirSync(dir).filter(n => n.endsWith(".jsonl"));
  assert.deepEqual(bleibt, [`${tagVon(T0)}.jsonl`], "nur der zu alte Tag geht");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Die Ablage sagt selbst, was sie hat — und wenn sie nicht schreiben kann", () => {
  const dir = tmp();
  const v = new Verlauf(path.join(dir, "verlauf"), { takt: 60 });
  assert.equal(v.info().vorhanden, 0, "vor dem ersten Punkt gibt es nichts");

  v.notiere("h", "pve", { ms: 5, st: "ok" }, T0);
  v.schliesse();
  const i = v.info();
  assert.equal(i.vorhanden, 1);
  assert.equal(i.seit, tagVon(T0));
  assert.ok(i.bytes > 0);
  assert.equal(i.fehler, null);
  assert.ok(fs.existsSync(path.join(dir, "verlauf", "LIESMICH.md")), "das Format steht neben den Dateien");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Verdichten behält die Ausreißer", () => {
  const punkte = [];
  for (let i = 0; i < 1000; i++) punkte.push({ t: 1000 + i * 60, k: "h", id: "x", ms: 10, min: 10, max: 10, st: "ok" });
  punkte[500] = { t: punkte[500].t, k: "h", id: "x", ms: 900, min: 800, max: 1200, st: "crit" };

  const wenig = verdichte(punkte, 100);
  assert.ok(wenig.length <= 100 && wenig.length > 50);
  assert.equal(Math.max(...wenig.map(p => p.max)), 1200, "der Ausschlag überlebt das Verdichten");
  assert.ok(wenig.some(p => p.st === "crit"), "und die rote Ampel auch");
  assert.equal(verdichte(punkte, 5000).length, 1000, "wenig Punkte werden nicht angefasst");
});

/* ---------- Der Weg durch den Dienst ---------- */

const BESTAND = `
settings: { interval: 3600, timeout: 1, icmp: false, verlauf_takt: 60, verlauf_tage: 7 }
sites: [ { id: hq, name: HQ, primary: true } ]
hosts:
  - { id: still, type: other, site: hq, ip: 127.0.0.1, checks: [{ kind: tcp, port: 9 }] }
tunnels: []
links: []
`;

test("Der Dienst schreibt Messwerte und gibt sie über /api/verlauf zurück", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "inventory.yaml"), BESTAND);
  const srv = createServer({
    inventory: path.join(dir, "inventory.yaml"),
    secrets: path.join(dir, "secrets.json"),
    state: path.join(dir, "incidents.json")
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await srv.engine.runOnce();
    await srv.engine.runOnce();
    /* Der laufende Takt wird erst mit seinem Ende geschrieben — im Test
       wird er von Hand geschlossen, statt eine Minute zu warten. */
    srv.verlauf.schliesse();

    const r = await fetch(`${base}/api/verlauf/still?tage=1`);
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.id, "still");
    assert.equal(b.art, "host");
    assert.equal(b.punkte.length, 1, "zwei Durchläufe im selben Takt sind ein Punkt");
    assert.equal(b.punkte[0].st, "warn", "das stille System steht auch in der Reihe als auffällig");
    assert.ok(b.von && b.bis);
    assert.ok(b.ablage.verzeichnis.endsWith("verlauf"));

    const weg = await fetch(`${base}/api/verlauf/gibtsnicht`);
    assert.equal(weg.status, 404, "zu einem nicht angelegten System wird nichts erfunden");
  } finally {
    srv.engine.stop();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
