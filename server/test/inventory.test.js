import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import * as Inv from "../src/inventory.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-")), "inventory.yaml");

const minimal = {
  sites: [{ id: "hq", name: "HQ" }],
  hosts: [{ id: "pve-1", type: "pve", site: "hq", ip: "10.0.0.5" }],
  tunnels: [], links: []
};

test("Prüfungen werden aus Typ und Adresse abgeleitet", () => {
  const inv = Inv.normalize(minimal);
  const kinds = inv.hosts[0].checks.map(c => `${c.kind}${c.port || ""}`);
  assert.deepEqual(kinds, ["icmp", "tcp8006", "tls8006"], "Proxmox VE bringt Port 8006 mit");
  assert.equal(inv.hosts[0].url, "https://10.0.0.5:8006");
});

test("Portainer bekommt seinen eigenen Standardport", () => {
  const inv = Inv.normalize({ ...minimal, hosts: [{ id: "p", type: "portainer", site: "hq", ip: "10.0.0.9" }] });
  assert.equal(inv.hosts[0].url, "https://10.0.0.9:9443");
});

test("Eigene Prüfungen verdrängen die abgeleiteten", () => {
  const inv = Inv.normalize({ ...minimal, hosts: [{ ...minimal.hosts[0], checks: [{ kind: "tcp", port: 22 }] }] });
  assert.equal(inv.hosts[0].checks.length, 1);
});

test("Unbekannter Standort wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({ ...minimal, hosts: [{ id: "x", type: "pve", site: "gibtsnicht", ip: "1.2.3.4" }] }),
    /Standort .gibtsnicht. ist nicht angelegt/);
});

test("Doppelte id wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({ ...minimal, hosts: [minimal.hosts[0], minimal.hosts[0]] }), /doppelt/);
});

test("System ohne Adresse wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({ ...minimal, hosts: [{ id: "leer", type: "pve", site: "hq" }] }), /weder ip noch url/);
});

test("Verknüpfung auf ein unbekanntes System wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({ ...minimal, links: [{ group: "G", items: [{ name: "X", host: "weg" }] }] }), /ist nicht angelegt/);
});

test("Tunnel ohne Gegenstelle und ohne Peer wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({ ...minimal, tunnels: [{ id: "t", a: "hq", b: "hq", probe: {} }] }),
    /weder probe\.ip noch ein verknüpfter Peer/);
});

/* ---------- Tunnel ↔ WireGuard-Peer ---------- */

test("Ein verknüpfter Peer ersetzt die Gegenstelle im Transfernetz", () => {
  const inv = Inv.normalize({
    ...minimal,
    tunnels: [{ id: "t", a: "hq", b: "hq", peer: { host: "pve-1", name: "WG-Schweiz", key: "Aqujl" } }]
  });
  assert.deepEqual(inv.tunnels[0].peer, { host: "pve-1", name: "WG-Schweiz", key: "Aqujl" });
  assert.equal(inv.tunnels[0].probe, undefined);
});

test("Ein Peer auf einem nicht angelegten System wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({
    ...minimal,
    tunnels: [{ id: "t", a: "hq", b: "hq", probe: { ip: "10.99.0.2" }, peer: { host: "gibtsnicht", name: "X" } }]
  }), /„gibtsnicht“ gelesen werden/);
});

test("Ein Peer ohne jede Kennung wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({
    ...minimal,
    tunnels: [{ id: "t", a: "hq", b: "hq", probe: { ip: "10.99.0.2" }, peer: { host: "pve-1", iface: "wg0" } }]
  }), /keine Kennung/);
});

/* Die Oberfläche schickt beim Lösen der Verknüpfung ausdrücklich null.
   Das darf nicht als `peer: null` in der Bestandsdatei landen — sonst
   stünde nach jedem Bearbeiten mehr in der Datei statt weniger. */
test("Eine gelöste Verknüpfung verschwindet aus der Datei", () => {
  const file = tmp();
  const inv = Inv.normalize({ ...minimal, tunnels: [{ id: "t", a: "hq", b: "hq", probe: { ip: "10.99.0.2" } }] });
  inv.tunnels[0].peer = null;
  const text = Inv.save(file, inv);
  assert.ok(!/peer/.test(text), "der leere Peer steht noch in der Datei:\n" + text);
  assert.equal(Inv.load(file).tunnels[0].peer, undefined);
});

test("Speichern und erneut laden ergibt denselben Bestand", () => {
  const file = tmp();
  const inv = Inv.normalize(minimal);
  Inv.save(file, inv);
  const again = Inv.load(file);
  assert.deepEqual(again.hosts.map(h => h.id), inv.hosts.map(h => h.id));
  assert.deepEqual(again.hosts[0].checks, inv.hosts[0].checks);
  assert.equal(again.settings.interval, Inv.DEFAULTS.interval);
});

test("Abgeleitete Prüfungen landen nicht in der Datei", () => {
  const file = tmp();
  Inv.save(file, Inv.normalize(minimal));
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes("checks:"), "sonst friert die Datei Standardwerte ein");
});

test("Vor dem Überschreiben wird gesichert", () => {
  const file = tmp();
  Inv.save(file, Inv.normalize(minimal));
  const zwei = Inv.normalize({ ...minimal, hosts: [...minimal.hosts, { id: "pve-2", type: "pve", site: "hq", ip: "10.0.0.6" }] });
  Inv.save(file, zwei);
  assert.ok(fs.existsSync(file + ".bak"));
  assert.equal(Inv.load(file).hosts.length, 2);
  const wieder = Inv.restore(file);
  assert.equal(wieder.hosts.length, 1, "Sicherung lässt sich zurückholen");
});

/* Ein Auszug je Tag: wer zehnmal am Tag speichert, will nicht zehn
   Dateien, sondern den Stand des Tages. Und die ältesten fallen heraus,
   sonst wächst das Volume unbemerkt. */
test("Das Archiv hält einen Stand je Tag und wirft die ältesten weg", () => {
  const file = tmp();
  Inv.save(file, Inv.normalize(minimal));

  const tag = n => new Date(Date.UTC(2026, 7, n, 12));
  Inv.archiviere(file, 3, tag(1));
  Inv.archiviere(file, 3, tag(1));                       /* derselbe Tag, kein zweiter Stand */
  assert.deepEqual(Inv.archivNamen(file), ["inventory-2026-08-01.yaml"]);

  for (const n of [2, 3, 4]) Inv.archiviere(file, 3, tag(n));
  assert.deepEqual(Inv.archivNamen(file),
    ["inventory-2026-08-04.yaml", "inventory-2026-08-03.yaml", "inventory-2026-08-02.yaml"],
    "drei behalten, jung zuerst — der erste ist raus");

  const liste = Inv.archivListe(file);
  assert.equal(liste[0].hosts, 1, "was drinsteht, steht vor der Entscheidung");
  assert.equal(liste[0].lesbar, true);
});

test("Ein unlesbarer Stand wird benannt, nicht verschwiegen", () => {
  const file = tmp();
  fs.writeFileSync(file, "sites: [\n  broken");
  const b = Inv.beschreibe(file);
  assert.equal(b.lesbar, false);
  assert.match(b.fehler, /YAML/);
  assert.equal(Inv.beschreibe(file + ".gibtsnicht"), null);
});

/* Zurückholen darf nie das Einzige sein, was noch da war: der bisherige
   Stand wird zur neuen Sicherung, damit auch der Griff daneben umkehrbar
   bleibt. */
test("Zurückholen sichert den Stand, den es ersetzt", () => {
  const file = tmp();
  Inv.save(file, Inv.normalize(minimal));
  Inv.archiviere(file, 5, new Date(Date.UTC(2026, 7, 1, 12)));

  const zwei = Inv.normalize({ ...minimal, hosts: [...minimal.hosts, { id: "pve-2", type: "pve", site: "hq", ip: "10.0.0.6" }] });
  Inv.save(file, zwei);
  assert.equal(Inv.load(file).hosts.length, 2);

  const archiv = path.join(Inv.archivVerzeichnis(file), "inventory-2026-08-01.yaml");
  const wieder = Inv.restore(file, archiv);
  assert.equal(wieder.hosts.length, 1, "der Auszug ist zurück");
  assert.equal(Inv.load(Inv.backupPath(file)).hosts.length, 2, "und der ersetzte Stand liegt als Sicherung daneben");

  assert.throws(() => Inv.restore(file, path.join(Inv.archivVerzeichnis(file), "gibt-es-nicht.yaml")),
    /Keine Sicherung/);
});

test("Kaputtes YAML nennt den Grund", () => {
  const file = tmp();
  fs.writeFileSync(file, "sites: [\n  broken");
  assert.throws(() => Inv.load(file), /YAML lässt sich nicht lesen/);
});

test("Der mitgelieferte Beispielbestand ist gültig", () => {
  const inv = Inv.load(new URL("../inventory.yaml", import.meta.url).pathname);
  assert.ok(inv.sites.length >= 1, "mindestens ein Standort");
  assert.ok(inv.tunnels.every(t => t.probe?.ip), "jeder Tunnel hat eine Gegenstelle");
  assert.ok(inv.hosts.every(h => h.ip || h.url), "jedes System hat etwas zu prüfen");
});

/* Der Bestand ist eine Vorlage: er soll jeden Systemtyp einmal zeigen,
   damit man beim Anpassen sieht, wie ein Eintrag aussieht — und nicht mehr
   als einmal, damit niemand fremde Beispielgeräte überwacht. */
test("Der Beispielbestand zeigt jeden Typ genau einmal", () => {
  const inv = Inv.load(new URL("../inventory.yaml", import.meta.url).pathname);
  const proTyp = new Map();
  for (const h of inv.hosts) proTyp.set(h.type, (proTyp.get(h.type) || 0) + 1);

  for (const typ of Object.keys(Inv.TYPES)) {
    if (typ === "other") continue;                 /* „Sonstiges" kommt mehrfach vor: Leitstand und Labor */
    assert.equal(proTyp.get(typ), 1, `Typ ${typ} sollte genau ein Beispiel haben`);
  }
  assert.ok(inv.hosts.some(h => h.monitor === false), "ein Beispiel für ein unüberwachtes System");
  assert.ok(inv.hosts.some(h => (h.checks || []).some(c => c.kind === "dns")), "ein Beispiel für eigene Prüfungen");
});

/* Die Selbstprüfung ist das einzige Beispiel, das wirklich antwortet.
   Sie muss auf den eigenen Dienst zeigen, sonst ist sie eine Attrappe. */
test("Der Beispielbestand prüft den Leitstand selbst", () => {
  const inv = Inv.load(new URL("../inventory.yaml", import.meta.url).pathname);
  const selbst = inv.hosts.find(h => h.id === "leitstand");
  assert.ok(selbst, "ein System namens leitstand");
  assert.match(selbst.url, /127\.0\.0\.1:8080/);
  assert.equal(selbst.monitor, true);
});

test("Prüfziel wird notfalls aus der Oberflächen-URL gezogen", async () => {
  const { targetHost } = await import("../src/probe.js");
  assert.equal(targetHost({ kind: "tcp", port: 443 }, { url: "https://pve.example.de:8006" }), "pve.example.de");
  assert.equal(targetHost({ kind: "tcp", port: 443 }, { ip: "10.0.0.1", url: "https://name.example.de" }), "10.0.0.1", "die IP hat Vorrang");
  assert.equal(targetHost({ kind: "tcp", port: 25, ip: "10.0.0.9" }, { ip: "10.0.0.1" }), "10.0.0.9", "die Prüfung selbst hat den Vorrang");
  assert.equal(targetHost({ kind: "icmp" }, {}), null);
});

/* Die Oberfläche liegt hinter einem Reverse Proxy: auf dem System selbst
   steht kein Port 443 offen, unter seinem Namen kommt die Seite trotzdem.
   Wer nur die IP prüft, meldet dafür einen Teilausfall — für etwas, das im
   Browser einwandfrei läuft. Also beides versuchen. */
test("Port- und TLS-Prüfung versuchen IP und Namen aus der Adresse", async () => {
  const { targetHosts, runCheck } = await import("../src/probe.js");

  assert.deepEqual(
    targetHosts({ kind: "tcp", port: 443 }, { ip: "10.0.0.1", url: "https://name.example.de" }),
    ["10.0.0.1", "name.example.de"], "die IP zuerst, der Name als zweiter Versuch");
  assert.deepEqual(
    targetHosts({ kind: "tcp", port: 8006 }, { ip: "10.0.0.1", url: "https://10.0.0.1:8006" }),
    ["10.0.0.1"], "sind beide dasselbe, bleibt es bei einem Versuch");
  assert.deepEqual(
    targetHosts({ kind: "tcp", port: 25, ip: "10.0.0.9" }, { ip: "10.0.0.1", url: "https://name.example.de" }),
    ["10.0.0.9"], "nennt die Prüfung selbst ein Ziel, gilt nur dieses");

  const srv = net.createServer(c => c.end());
  const port = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  try {
    const ueberNamen = await runCheck({ kind: "tcp", port },
      { ip: "127.0.0.2", url: `http://127.0.0.1:${port}` }, { timeout: 2 });
    assert.equal(ueberNamen.ok, true, "die Adresse trägt, auch wenn die IP den Port nicht anbietet");
    assert.match(ueberNamen.detail, /127\.0\.0\.1/, "im Ergebnis steht, wer geantwortet hat");

    /* Antwortet keines von beiden, wird auch keines verschwiegen. */
    const gar = await runCheck({ kind: "tcp", port },
      { ip: "127.0.0.2", url: `http://127.0.0.3:${port}` }, { timeout: 2 });
    assert.equal(gar.ok, false);
    assert.match(gar.detail, /auch 127\.0\.0\.3/);
  } finally { await new Promise(x => srv.close(x)); }
});

test("Fehlender Bestand wird beim ersten Start angelegt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-neu-"));
  const file = path.join(dir, "unterordner", "inventory.yaml");
  const r = Inv.ensure(file);
  assert.equal(r.created, true);
  assert.equal(r.seeded, false, "ohne Vorlage das leere Gerüst");
  const inv = Inv.load(file);
  assert.equal(inv.hosts.length, 0);
  assert.equal(inv.sites.length, 1, "ein Standort, sonst wäre der Bestand ungültig");
});

test("Vorhandener Bestand wird beim Start nicht angefasst", () => {
  const file = tmp();
  Inv.save(file, Inv.normalize(minimal));
  const vorher = fs.readFileSync(file, "utf8");
  const r = Inv.ensure(file);
  assert.equal(r.created, false);
  assert.equal(fs.readFileSync(file, "utf8"), vorher);
});

test("Mitgelieferte Vorlage wird als Startbestand übernommen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-seed-"));
  const file = path.join(dir, "inventory.yaml");
  const vorlage = new URL("../inventory.yaml", import.meta.url).pathname;
  const r = Inv.ensure(file, vorlage);
  assert.equal(r.seeded, true);
  const inv = Inv.load(file);
  assert.ok(inv.hosts.length > 1, "die Beispiele kommen mit");
  assert.ok(inv.hosts.some(h => h.id === "leitstand"), "samt Selbstprüfung");
});

test("Unbrauchbare Vorlage kippt den Start nicht", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-kaputt-"));
  const kaputt = path.join(dir, "vorlage.yaml");
  fs.writeFileSync(kaputt, "sites: [\n  broken");
  const file = path.join(dir, "inventory.yaml");
  const r = Inv.ensure(file, kaputt);
  assert.equal(r.created, true);
  assert.equal(r.seeded, false, "auf das Gerüst zurückgefallen");
  assert.doesNotThrow(() => Inv.load(file));
});

/* ---------- Standortkürzel ----------
   Vier Stellen, Land + Stadt. Feste Breite, weil das Kürzel in der
   Filterleiste, in der Topologie und in jeder Tabellenzeile steht. */
test("Das Kürzel wird auf vier Stellen geprüft", () => {
  for (const gut of ["DEKO", "ATWI", "CHZH", "DEK2"])
    assert.equal(Inv.pruefeKuerzel(gut), null, `${gut} sollte durchgehen`);

  assert.match(Inv.pruefeKuerzel("HQ"), /zwei|2 Stellen/i);
  assert.match(Inv.pruefeKuerzel("DEKOL"), /5 Stellen/);
  assert.match(Inv.pruefeKuerzel("DE-K"), /Unerlaubtes/);
  assert.match(Inv.pruefeKuerzel("1DEK"), /erste Stelle/);
  assert.match(Inv.pruefeKuerzel(""), /fehlt/);
  assert.match(Inv.pruefeKuerzel(null), /fehlt/);
});

test("Kleinschreibung wird angenommen und großgeschrieben", () => {
  assert.equal(Inv.pruefeKuerzel("deko"), null);
  assert.equal(Inv.normalizeKuerzel(" deko "), "DEKO");
});

/* Ein bestehender Bestand mit älteren Kürzeln muss weiter starten —
   sonst nähme eine Formalie die ganze Überwachung mit. */
test("Ein alter Bestand mit kurzem Kürzel lädt weiterhin", () => {
  const file = tmp();
  fs.writeFileSync(file, `
settings: { icmp: false }
sites: [ { id: hq, name: Alt, short: HQ } ]
hosts: []
tunnels: []
links: []
`);
  assert.doesNotThrow(() => Inv.load(file));
  assert.equal(Inv.load(file).sites[0].short, "HQ", "unverändert übernommen");
});

test("Der mitgelieferte Beispielbestand hält sich an die Vierstelligkeit", () => {
  const inv = Inv.load(new URL("../inventory.yaml", import.meta.url).pathname);
  for (const s of inv.sites)
    assert.equal(Inv.pruefeKuerzel(s.short), null, `Standort ${s.id}: ${s.short}`);
});
