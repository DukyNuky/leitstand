import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeProxmox, listen, GOOD, WEAK } from "./fake-proxmox.js";
import { collectPve, collectPbs, collectPmg, testConnection, authHeader, baseUrl } from "../src/collectors/proxmox.js";

let srv, url;
before(async () => { srv = fakeProxmox(); url = await listen(srv); });
after(() => srv.close());

const cred = { user: "leitstand@pve", tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555" };
const host = id => ({ id, name: id, type: "pve", url });

test("Token-Kopfzeile wird nach Proxmox-Schema gebaut", () => {
  assert.equal(authHeader("pve", cred).Authorization, GOOD);
  assert.equal(authHeader("pmg", { tokenId: "leitstand@pmg!ro", secret: "x" }).Authorization,
    "PMGAPIToken=leitstand@pmg!ro=x");
  assert.equal(authHeader("pve", null), null, "ohne Zugangsdaten keine Kopfzeile");
});

/* Der Backup Server trennt Token-ID und Geheimnis mit „:“, VE und Mail
   Gateway mit „=“. Das stand lange gleich für alle drei da — mit dem
   Ergebnis, dass gegen einen echten PBS jede Anmeldung scheiterte, während
   der Testserver das Zeichen gar nicht ansah und Grün meldete. */
test("Backup Server bekommt den Doppelpunkt, nicht das Gleichheitszeichen", () => {
  assert.equal(authHeader("pbs", { tokenId: "leitstand@pbs!ro", secret: "x" }).Authorization,
    "PBSAPIToken=leitstand@pbs!ro:x");
});

test("Ein PBS-Token in VE-Schreibweise wird abgelehnt", async () => {
  const falsch = await fetch(`${url}/api2/json/version`, {
    headers: { Authorization: `PBSAPIToken=${GOOD.replace(/^PVEAPIToken=/, "")}` }
  });
  assert.equal(falsch.status, 401, "mit „=“ statt „:“ gibt es keine Auskunft");

  const richtig = await fetch(`${url}/api2/json/version`, {
    headers: { Authorization: `PBSAPIToken=${GOOD.replace(/^PVEAPIToken=/, "").replace(/=(?=[^=]*$)/, ":")}` }
  });
  assert.equal(richtig.status, 200);
});

test("Standardport je Bauart, wenn die url keinen nennt", () => {
  assert.match(baseUrl({ ip: "10.0.0.1" }, "pve"), /:8006$/);
  assert.match(baseUrl({ ip: "10.0.0.1" }, "pbs"), /:8007$/);
  assert.equal(baseUrl({ url: "https://10.0.0.1:9999" }, "pve"), "https://10.0.0.1:9999");
});

test("Verbindungstest meldet Erfolg mit Version", async () => {
  const r = await testConnection(host("pve-hq-01"), cred, "pve");
  assert.equal(r.ok, true);
  assert.match(r.detail, /Proxmox VE 8\.3\.2/);
});

test("Verbindungstest erklärt abgelehnte Zugangsdaten verständlich", async () => {
  const r = await testConnection(host("pve-hq-01"), { tokenId: "ro", secret: "falsch" }, "pve");
  assert.equal(r.ok, false);
  assert.match(r.detail, /401/);
  assert.match(r.hint, /Token-ID/);
});

test("Verbindungstest ohne Zugangsdaten schlägt sauber fehl statt zu werfen", async () => {
  const r = await testConnection(host("pve-hq-01"), null, "pve");
  assert.equal(r.ok, false);
  assert.match(r.detail, /Kein API-Token/);
});

test("PVE-Sammler ordnet den richtigen Knoten zu und rechnet Prozente", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  assert.equal(r.node, "pve-hq-01");
  assert.equal(r.cpu, 34);
  assert.equal(r.ram, 61);
  assert.equal(r.vms, 2, "zwei qemu auf diesem Knoten — die Vorlage zählt nicht mit");
  assert.equal(r.lxc, 1);
  assert.equal(r.running, 2);
  assert.equal(r.stopped, 1);
  assert.equal(r.cluster, "cl-hq");
  assert.equal(r.quorum, true);
  assert.equal(r.uptime, "41 T");
});

test("PVE-Sammler stuft vollen Speicher selbst als kritisch ein", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  assert.equal(r.status, "crit");
  assert.match(r.note, /local-lvm zu 91 % belegt/);
});

test("PVE-Sammler trennt die Knoten eines Clusters", async () => {
  const r = await collectPve(host("pve-hq-02"), cred);
  assert.equal(r.node, "pve-hq-02");
  assert.equal(r.cpu, 71);
  assert.equal(r.vms, 1);
  assert.equal(r.lxc, 0);
});

test("Unbekannter Knotenname führt zu einer erklärenden Meldung, nicht zum Absturz", async () => {
  const r = await collectPve(host("pve-gibtsnicht"), cred);
  assert.match(r.error, /nicht gefunden/);
  assert.match(r.note, /pve-hq-01, pve-hq-02/);
});

test("Zu schwaches Token: Fehler wird als Warnung durchgereicht", async () => {
  const r = await collectPve(host("pve-hq-01"), { tokenId: "schwach", secret: "aaaa", user: "leitstand@pve" });
  assert.equal(r.status, "warn");
  assert.match(r.note, /403/);
});

test("PBS-Sammler erkennt fehlgeschlagenen Verify-Job", async () => {
  const r = await collectPbs({ id: "pbs", url }, { tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555", user: "leitstand@pve" });
  assert.equal(r.datastores, 2);
  assert.equal(r.used, 90, "der vollste Datastore zählt");
  assert.equal(r.failed, 1);
  assert.equal(r.status, "crit");
  assert.match(r.note, /verify nas-archive/);
});

test("PMG-Sammler liest die Tagesstatistik", async () => {
  const r = await collectPmg({ id: "pmg", url }, { tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555", user: "leitstand@pve" });
  assert.equal(r.in24, 1840);
  assert.equal(r.spam, 1216);
  assert.equal(r.status, "warn", "Virenfunde sind eine Warnung");
});

/* ---------- Was nicht gelesen werden kann, ist nicht null Stück ----------
   Proxmox filtert /cluster/resources nach Rechten: ein zu schwacher Token
   bekommt 200 mit leerer Liste statt einer Ablehnung. Gezählt wurden daraus
   früher 0 VMs und 0 Container — bei grüner Ampel. Ein erfundener Messwert
   an genau der Stelle, an der man ihn für bare Münze nimmt. */
import http from "node:http";

function pveMit(resources, { status = 200 } = {}) {
  return http.createServer((req, res) => {
    const send = (code, data) => {
      const b = JSON.stringify({ data });
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
      res.end(b);
    };
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/api2/json/version") return send(200, { version: "8.3.2" });
    if (p === "/api2/json/nodes") return send(200, [
      { node: "n1", status: "online", cpu: 0.2, mem: 20e9, maxmem: 64e9, disk: 100e9, maxdisk: 500e9, uptime: 864000 }
    ]);
    if (p === "/api2/json/cluster/resources") return send(status, status === 200 ? resources : null);
    if (p === "/api2/json/cluster/status") return send(200, []);
    return send(404, null);
  });
}
const anMit = async (resources, opt) => {
  const srv = pveMit(resources, opt);
  const u = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
  return { srv, host: { id: "n1", url: u } };
};
const irgendeinToken = { user: "leitstand@pve", tokenId: "ro", secret: "x" };

test("Leere Bestandsliste zählt nicht als null Gäste", async () => {
  const { srv, host: h } = await anMit([]);
  try {
    const r = await collectPve(h, irgendeinToken);
    assert.equal(r.vms, null, "unbekannt, nicht null Stück");
    assert.equal(r.lxc, null);
    assert.equal(r.storages, null);
    assert.equal(r.status, "warn", "und die Ampel bleibt nicht grün");
    assert.match(r.note, /PVEAuditor/, "mit dem Hinweis, woran es liegt");
    assert.equal(r.cpu, 20, "was gelesen werden konnte, bleibt erhalten");
  } finally { srv.close(); }
});

test("Abgelehnte Bestandsliste zählt nicht als null Gäste", async () => {
  const { srv, host: h } = await anMit(null, { status: 403 });
  try {
    const r = await collectPve(h, irgendeinToken);
    assert.equal(r.vms, null);
    assert.equal(r.status, "warn");
    assert.match(r.note, /nicht abrufbar/);
    assert.match(r.error, /403/);
  } finally { srv.close(); }
});

test("Ein Knoten ohne Gäste, aber mit Speicher, meldet ehrlich null", async () => {
  const { srv, host: h } = await anMit([
    { type: "storage", node: "n1", storage: "local", disk: 10e9, maxdisk: 100e9 }
  ]);
  try {
    const r = await collectPve(h, irgendeinToken);
    assert.equal(r.vms, 0, "hier ist 0 ein Messwert, kein Platzhalter");
    assert.equal(r.lxc, 0);
    assert.equal(r.storages.length, 1);
    assert.notEqual(r.status, "warn");
  } finally { srv.close(); }
});

/* /version darf jeder angemeldete Benutzer lesen. Der Test war deshalb grün,
   während der Token die Kennzahlen gar nicht sehen durfte — und der Knoten
   danach leer blieb, ohne dass jemand wusste warum. */
test("Verbindungstest deckt auf, wenn nur die Version lesbar ist", async () => {
  const { srv, host: h } = await anMit([]);
  try {
    const r = await testConnection(h, irgendeinToken, "pve");
    assert.equal(r.ok, false, "das ist kein brauchbarer Zugang");
    assert.match(r.detail, /8\.3\.2/, "die Version steht trotzdem dabei");
    assert.match(r.detail, /leer/);
    assert.match(r.hint, /PVEAuditor/);
  } finally { srv.close(); }
});

test("Verbindungstest nennt bei Erfolg, was der Token sehen darf", async () => {
  const { srv, host: h } = await anMit([
    { type: "qemu", node: "n1", vmid: 100, status: "running" },
    { type: "storage", node: "n1", storage: "local", disk: 10e9, maxdisk: 100e9 }
  ]);
  try {
    const r = await testConnection(h, irgendeinToken, "pve");
    assert.equal(r.ok, true);
    assert.match(r.detail, /1 Gäste und 1 Speicher sichtbar/);
  } finally { srv.close(); }
});

/* Der Knoten selbst steht ebenfalls in /cluster/resources. Kommen nur solche
   Einträge zurück, ist die Liste inhaltlich leer — man sieht es ihr nur nicht
   an. Genau daran wurden 0 VMs gezählt, bei grüner Ampel. */
test("Nur Knoten-Einträge zählen nicht als null Gäste", async () => {
  const { srv, host: h } = await anMit([
    { type: "node", node: "n1", status: "online", id: "node/n1" },
    { type: "node", node: "n2", status: "online", id: "node/n2" }
  ]);
  try {
    const r = await collectPve(h, irgendeinToken);
    assert.equal(r.vms, null, "unbekannt, nicht null Stück");
    assert.equal(r.lxc, null);
    assert.equal(r.storages, null);
    assert.equal(r.status, "warn");
    assert.match(r.note, /Nur Knoten-Einträge/);
    assert.match(r.note, /API Token Permission/, "mit der konkreten Anweisung");
  } finally { srv.close(); }
});

test("Der Knoteneintrag verfälscht die Zählung nicht", async () => {
  const { srv, host: h } = await anMit([
    { type: "node", node: "n1", status: "online", id: "node/n1" },
    { type: "qemu", node: "n1", vmid: 100, status: "running" },
    { type: "lxc", node: "n1", vmid: 200, status: "running" },
    { type: "storage", node: "n1", storage: "local", disk: 10e9, maxdisk: 100e9 }
  ]);
  try {
    const r = await collectPve(h, irgendeinToken);
    assert.equal(r.vms, 1);
    assert.equal(r.lxc, 1);
    assert.equal(r.storages.length, 1);
    assert.notEqual(r.status, "warn");
  } finally { srv.close(); }
});

/* ============================================================
   Der Knoten im Einzelnen und seine Gäste
   ============================================================ */

test("Der Sammler benennt die Gäste, statt sie nur zu zählen", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  const namen = r.guests.map(g => g.name);
  assert.ok(namen.includes("vm-web"));
  assert.ok(namen.includes("ct-dns"));
  assert.equal(namen.includes("vm-fremd"), false, "Gäste anderer Knoten gehören nicht hierher");
  assert.equal(namen.includes("vorlage-debian"), false, "eine Vorlage läuft nie und wäre für immer „gestoppt“");
  assert.equal(r.templates, 1, "gezählt wird sie trotzdem");
});

test("Laufendes steht oben, darin das Belastete zuerst", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  assert.equal(r.guests[0].name, "ct-dns", "41 % CPU vor 12 %");
  assert.equal(r.guests.at(-1).status, "stopped");
});

/* Der Kern der Sache: Proxmox meldet für einen gestoppten Gast 0 — das ist
   die Abwesenheit einer Messung und keine. Als „0 % CPU" angezeigt sähe
   eine ausgeschaltete Maschine aus wie eine, die sich langweilt. */
test("Ein gestoppter Gast hat keine Auslastung, sondern einen Strich", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  const aus = r.guests.find(g => g.name === "vm-alt");
  assert.equal(aus.cpu, null);
  assert.equal(aus.ram, null);
  assert.equal(aus.uptime, null);
  assert.equal(aus.ramMaxMb, 4096, "was ihr zugeteilt ist, weiß der Wirt trotzdem");
});

/* Ebenso: bei einer VM kennt der Wirt die Belegung im Gast nicht und
   meldet 0. Bei einem Container ist die Zahl echt. */
test("Die Plattenbelegung einer VM bleibt leer, die eines Containers nicht", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  assert.equal(r.guests.find(g => g.name === "vm-web").disk, null);
  assert.equal(r.guests.find(g => g.name === "ct-dns").disk, 23, "2 von 8 GB");
});

test("Kernel, Fassung und Ausstattung des Knotens kommen mit", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  assert.equal(r.kernel, "6.8.12-4-pve", "aus der vollen Bauzeile das eine Feld");
  assert.equal(r.pveVersion, "pve-manager/8.3.2/abc123");
  assert.equal(r.cores, 16);
  assert.equal(r.cpuModel, "AMD Ryzen 9 5950X");
  assert.equal(r.load1, 0.42);
  assert.equal(r.rootUsed, 21);
  assert.equal(r.swap, null, "ohne eingerichtete Auslagerung gibt es dazu nichts zu sagen");
});

test("Ausstehende Pakete werden gelesen und benannt", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  assert.equal(r.updates, 2);
  assert.equal(r.updateListe[0].paket, "pve-manager");
  assert.equal(r.updateListe[0].von, "8.3.1");
  assert.equal(r.updateListe[0].auf, "8.3.2");
});

/* Ein Knoten mit offenen Paketen ist nicht gestört, er ist alt. Wer davon
   geweckt wird, hat den Unterschied zwischen Wartungsliste und Alarm
   aufgegeben. */
test("Ausstehende Pakete drehen die Ampel nicht", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  /* Der Speicher steht in diesem Bestand auf 91 % — die Ampel kommt also
     von dort, nicht von den Paketen. */
  assert.match(r.note, /Speicher/);
  assert.equal(r.status, "crit");
});

/* ============================================================
   Schwellwerte je System
   ============================================================ */

/* local-lvm liegt im Testbestand bei 91 %. Mit den Vorgabewerten ist das
   rot — genau die Lage, aus der die Anforderung kam. */
test("Mit den Vorgabewerten ist ein Speicher bei 91 % rot", async () => {
  const r = await collectPve(host("pve-hq-01"), cred, { disk_warn: 80, disk_crit: 90, ram_warn: 85, ram_crit: 95 });
  assert.equal(r.status, "crit");
  assert.match(r.note, /local-lvm/);
  assert.match(r.note, /kritisch ab 90 %/, "die geltende Grenze steht in der Meldung");
});

test("Ein eigener Wert am System hebt genau diese Ampel — und nur sie", async () => {
  const h = { ...host("pve-hq-01"), schwellen: { disk_warn: 93, disk_crit: 97 } };
  const r = await collectPve(h, cred, { disk_warn: 80, disk_crit: 90, ram_warn: 85, ram_crit: 95 });
  assert.equal(r.status, undefined, "91 % liegt unter 93 — kein Befund mehr");
  assert.equal(r.schwellen.disk_crit, 97);
  assert.equal(r.schwellen.ram_warn, 85, "was nicht gesetzt ist, bleibt beim globalen Wert");
});

test("Auch der Datastore des Backup Servers folgt den eigenen Grenzen", async () => {
  const pbs = { id: "pbs-01", name: "pbs-01", type: "pbs", url };
  /* nas-archive liegt bei 90 %. */
  const streng = await collectPbs(pbs, cred, { disk_warn: 80, disk_crit: 90, ram_warn: 85, ram_crit: 95 });
  const locker = await collectPbs({ ...pbs, schwellen: { disk_warn: 95, disk_crit: 98 } }, cred,
    { disk_warn: 80, disk_crit: 90, ram_warn: 85, ram_crit: 95 });
  /* Der Testserver meldet zugleich einen fehlgeschlagenen Verify — der
     sticht die Belegung und bleibt in beiden Fällen stehen. */
  assert.equal(streng.status, "crit");
  assert.equal(locker.status, "crit");
  assert.equal(locker.schwellen.disk_warn, 95);
});
