import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeProxmox, listen, GOOD, WEAK } from "./fake-proxmox.js";
import { collectPve, collectPbs, testConnection, authHeader, baseUrl,
  laufStatus, umfang, zeitplan, auftragWort, aufgabeInWorten } from "../src/collectors/proxmox.js";

let srv, url;
before(async () => { srv = fakeProxmox(); url = await listen(srv); });
after(() => srv.close());

const cred = { user: "leitstand@pve", tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555" };
const host = id => ({ id, name: id, type: "pve", url });

test("Token-Kopfzeile wird nach Proxmox-Schema gebaut", () => {
  assert.equal(authHeader("pve", cred).Authorization, GOOD);
  assert.equal(authHeader("pve", null), null, "ohne Zugangsdaten keine Kopfzeile");
});

/* Der Backup Server trennt Token-ID und Geheimnis mit „:“, VE mit „=“.
   Das stand lange gleich für beide da — mit dem Ergebnis, dass gegen einen
   echten PBS jede Anmeldung scheiterte, während der Testserver das Zeichen
   gar nicht ansah und Grün meldete. */
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
  assert.match(r.note, /Prüfung VM 141 → nas-archive/,
    "„verify nas-archive“ sagte nicht, welche Sicherung wovon schiefging");
  assert.match(r.note, /verification failed/, "samt Wortlaut des Fehlschlags");
});

/* Ein Datastore ist nicht nur ein Prozentsatz. Was ihn beurteilbar macht,
   sind die Zeitpunkte daneben: seit wann nichts mehr hineingesichert
   wurde, wann zuletzt aufgeräumt und wann zuletzt geprüft wurde. */
test("Jeder Datastore steht mit Belegung, freiem Platz und seinen Läufen da", async () => {
  const r = await collectPbs({ id: "pbs", url }, cred);
  const main = r.stores.find(s => s.name === "main");
  const archiv = r.stores.find(s => s.name === "nas-archive");

  assert.equal(main.used, 74);
  assert.equal(main.availBytes, 1_100_000_000_000, "der freie Platz kommt von PBS, nicht aus total − used");
  assert.equal(main.totalBytes, 5_000_000_000_000);
  assert.equal(main.comment, "Tägliche Sicherung");
  assert.ok(main.lastBackup, "die Sicherung nach main wird zugeordnet");
  assert.equal(main.backupOk, true);
  assert.ok(main.lastGc, "und der Aufräumlauf auch");
  assert.equal(main.lastVerify, null, "geprüft wurde main noch nie — das ist keine Null, sondern ein Nie");

  assert.equal(archiv.wartung, "read-only");
  assert.equal(archiv.verifyOk, false, "der fehlgeschlagene Verify hängt am Archiv");
  assert.equal(archiv.lastBackup, null, "„vm/101“ ist kein Datastore und wird keinem zugeschlagen");
});

/* PBS rechnet selbst aus, wann ein Datastore voll ist. Diese Zahl ist die
   einzige, die eine Nacht vorher warnt — aber nur, wo es sie gibt. */
test("Bald voll heißt gelb, und ohne Schätzung wird nichts geschätzt", async () => {
  const r = await collectPbs({ id: "pbs", url }, cred);
  const main = r.stores.find(s => s.name === "main");
  assert.equal(main.vollInTagen, 9);
  assert.ok(main.vollAm);
  assert.equal(r.stores.find(s => s.name === "nas-archive").vollInTagen, null,
    "„estimated-full-date: 0“ heißt keine Schätzung, nicht „heute“");
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

/* ============================================================
   Sicherungsaufträge

   Was eingerichtet ist, steht in /cluster/backup; was gelaufen ist, in
   den vzdump-Aufgaben des Knotens. Beides zusammenzubringen ist der
   heikle Teil — und wo es nicht geht, muss es sich zu erkennen geben.
   ============================================================ */

test("Eingerichtete Aufträge werden mit Zeitplan, Ziel und Umfang gelesen", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  assert.equal(r.backupJobs.length, 3);

  const nacht = r.backupJobs.find(j => j.id === "backup-1a2b3c4d-5678");
  assert.equal(nacht.name, "Nacht — alles");
  assert.equal(nacht.aktiv, true);
  assert.equal(nacht.zeitplan, "02:00");
  assert.equal(nacht.ziel, "pbs-main");
  assert.equal(nacht.umfang, "alle Gäste");
  assert.ok(nacht.naechster, "der nächste Lauf steht in der Antwort neuerer Fassungen");

  /* Ältere Aufträge stehen als Wochentag plus Uhrzeit da — angezeigt wird,
     was dasteht, nicht ein daraus gebastelter Kalenderausdruck. */
  const we = r.backupJobs.find(j => j.id === "backup-9f8e7d6c-4321");
  assert.equal(we.zeitplan, "sat 05:00");
  assert.equal(we.aktiv, false, "abgeschaltet ist keine Störung, aber eine Auskunft");
  /* 102 und 103 stehen nicht auf diesem Knoten — was bekannt ist, wird
     benannt, der Rest gezählt. */
  assert.equal(we.umfang, "vm-web und 2 weitere");
});

/* Die Kennung ist kein Name: `backup-0011aabb-ccdd` stand als
   Auftragsname in der Tabelle und in der Störmeldung. Daran erkennt
   niemand, welche Sicherung gemeint ist. */
test("Ein Auftrag ohne Kommentar bekommt keine Kennung als Namen angedichtet", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  const ohne = r.backupJobs.find(j => j.id === "backup-0011aabb-ccdd");
  assert.equal(ohne.name, null, "ohne Kommentar in Proxmox gibt es keinen Namen");
  assert.equal(ohne.umfang, "vm-alt und ct-dns", "dafür sagt der Umfang, worum es geht");
  assert.equal(auftragWort(ohne), "von vm-alt und ct-dns", "und so zeigt eine Meldung darauf");
  assert.equal(auftragWort({ name: "Nacht — alles" }), "„Nacht — alles“");
});

/* Die drei Zeitpunkte beantworten drei verschiedene Fragen — und ein
   Auftrag, der heute Nacht glückte und vorgestern scheiterte, muss beides
   zeigen. */
test("Gelaufen, zuletzt erfolgreich und zuletzt fehlgeschlagen stehen nebeneinander", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  const nacht = r.backupJobs.find(j => j.id === "backup-1a2b3c4d-5678");
  assert.equal(nacht.quelle, "auftrag", "die Aufgabe trägt die Kennung des Auftrags");
  assert.equal(nacht.letzterStatus, "ok");
  assert.ok(nacht.zuletzt);
  assert.equal(nacht.zuletztOk, nacht.zuletzt, "der letzte Lauf war zugleich der letzte geglückte");
  assert.ok(nacht.zuletztFehler, "der Fehlschlag von vorgestern bleibt sichtbar");
  assert.ok(new Date(nacht.zuletztFehler) < new Date(nacht.zuletztOk));
  /* Dieser Knoten ist wegen seines vollen Speichers ohnehin rot — aber
     nicht wegen der Sicherung: der Fehlschlag ist überstanden. */
  assert.ok(!/Sicherung/.test(r.note || ""), "ein überstandener Fehlschlag ist keine Störung mehr");
});

/* Ohne Kennung in der Aufgabe lässt sich ein Lauf keinem Auftrag
   zuordnen. Dann gelten die Läufe des Knotens — und die Zeile sagt das,
   statt eine Genauigkeit zu behaupten, die Proxmox nicht hergibt. */
test("Ohne Zuordnung gelten die Läufe des Knotens, und das steht dabei", async () => {
  const r = await collectPve(host("pve-hq-01"), cred);
  const we = r.backupJobs.find(j => j.id === "backup-9f8e7d6c-4321");
  assert.equal(we.quelle, "knoten");
  assert.ok(we.zuletzt);
});

test("Ein zuletzt fehlgeschlagener Auftrag dreht die Ampel auf Rot", async () => {
  const r = await collectPve(host("pve-hq-02"), cred);
  const nacht = r.backupJobs.find(j => j.id === "backup-1a2b3c4d-5678");
  assert.equal(nacht.letzterStatus, "fehler");
  assert.ok(nacht.zuletztOk, "der geglückte Lauf von vorgestern steht daneben");
  assert.equal(r.status, "crit");
  assert.match(r.note, /Nacht — alles/);
});

test("vzdump kennt drei Ausgänge, und der mittlere ist keiner von beiden", () => {
  assert.equal(laufStatus("OK"), "ok");
  assert.equal(laufStatus("WARNINGS: 2"), "warn", "gelaufen, aber ein Gast blieb liegen");
  assert.equal(laufStatus("job errors"), "fehler");
  assert.equal(laufStatus(""), null, "ohne Angabe wird nichts behauptet");
  assert.equal(laufStatus(null), null);
});

test("„alle“ ist eine eigene Angabe und keine Liste", () => {
  assert.equal(umfang({ all: 1 }), "alle Gäste");
  assert.equal(umfang({ all: 1, exclude: "105,106" }), "alle Gäste außer 2");
  assert.equal(umfang({ vmid: "101" }), "1 Gast");
  assert.equal(umfang({ vmid: "101,102" }), "2 Gäste");
  assert.equal(umfang({ pool: "prod" }), "Pool prod");
  assert.equal(umfang({}), null, "steht nichts da, wird nichts behauptet");
  assert.equal(zeitplan("mon,tue", "02:00"), "mon,tue 02:00");
  assert.equal(zeitplan(null, null), null);
});

/* ---------- Aus Nummern werden Namen ----------
   Der Auftrag nennt seine Gäste als Nummern, der Knoten kennt die Namen.
   Ohne Bestandsliste bleibt es bei der Anzahl: eine Zahl sagt wenig, aber
   sie lügt nicht. */
const GAESTE = [
  { vmid: 101, name: "vm-web" }, { vmid: 141, name: "vm-alt" },
  { vmid: 201, name: "ct-dns" }, { vmid: 301, name: "vm-fremd" }
];

test("Der Umfang benennt die Gäste, sobald der Knoten sie kennt", () => {
  assert.equal(umfang({ vmid: "101" }, GAESTE), "vm-web");
  assert.equal(umfang({ vmid: "101,201" }, GAESTE), "vm-web und ct-dns");
  assert.equal(umfang({ vmid: "101,141,201" }, GAESTE), "vm-web, vm-alt und ct-dns");
  assert.equal(umfang({ all: 1, exclude: "141" }, GAESTE), "alle Gäste außer vm-alt");
});

test("Ab vier Gästen wird gekürzt, und Unbekanntes wird gezählt statt geraten", () => {
  assert.equal(umfang({ vmid: "101,141,201,301" }, GAESTE), "vm-web, vm-alt und 2 weitere");
  assert.equal(umfang({ vmid: "101,999,998" }, GAESTE), "vm-web und 2 weitere");
  assert.equal(umfang({ vmid: "997,998,999" }, GAESTE), "3 Gäste", "kennt er keinen, zählt er");
});

test("Ohne Bestandsliste bleibt alles, wie es war", () => {
  assert.equal(umfang({ all: 1 }), "alle Gäste");
  assert.equal(umfang({ all: 1, exclude: "105,106" }), "alle Gäste außer 2");
  assert.equal(umfang({ vmid: "101" }), "1 Gast");
  assert.equal(umfang({ vmid: "101,102" }), "2 Gäste");
  assert.equal(umfang({ pool: "prod" }, GAESTE), "Pool prod");
  assert.equal(umfang({}, GAESTE), null, "steht nichts da, wird nichts behauptet");
});

/* ---------- PBS-Aufgaben in Worten ---------- */
test("Eine PBS-Aufgabe wird zu einem Satz, den man lesen kann", () => {
  assert.equal(aufgabeInWorten({ worker_type: "verify", worker_id: "nas-archive:vm/141/2026-08-30T22:00:00Z" }),
    "Prüfung VM 141 → nas-archive");
  assert.equal(aufgabeInWorten({ worker_type: "backup", worker_id: "main:ct/201/2026-08-31T01:00:00Z" }),
    "Sicherung CT 201 → main");
  assert.equal(aufgabeInWorten({ worker_type: "backup", worker_id: "main:host/web-01/2026-08-23T01:00:00Z" }),
    "Sicherung Host web-01 → main", "ein gesicherter Rechner ist keine VM");
  assert.equal(aufgabeInWorten({ worker_type: "garbage_collection", worker_id: "main" }),
    "Speicher freigeben main");
});

/* Der Zeitstempel bringt eigene Doppelpunkte mit. Wurde an allen getrennt,
   stand in der Meldung „Prüfung 00Z" — der Rest der Uhrzeit. */
test("Der Zeitstempel überlebt das Zerlegen der Kennung", () => {
  const w = aufgabeInWorten({ worker_type: "verify", worker_id: "main:vm/101/2026-08-31T03:15:42Z" });
  assert.equal(w, "Prüfung VM 101 → main");
  assert.ok(!/00Z|42Z/.test(w), "der zerschnittene Zeitstempel darf nicht durchschlagen");
});

test("Eine ältere Kennung ohne Datastore erfindet keinen", () => {
  assert.equal(aufgabeInWorten({ worker_type: "backup", worker_id: "vm/101" }), "Sicherung VM 101");
});

test("Eine unbekannte Bauart bleibt wörtlich stehen statt geraten zu werden", () => {
  assert.equal(aufgabeInWorten({ worker_type: "irgendwas-neues", worker_id: "main" }), "irgendwas-neues main");
});
