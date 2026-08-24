import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createServer } from "../src/server.js";
import { fakeProxmox, listen as listenFake } from "./fake-proxmox.js";

let dir, srv, base, fake, fakeUrl, openSrv, openPort;

const START = `
settings: { interval: 3600, timeout: 1, icmp: false, fail_threshold: 2 }
sites:
  - { id: hq, name: HQ Zuhause, place: Köln, primary: true }
  - { id: rz, name: RZ, place: Falkenstein }
hosts:
  - { id: alt, type: other, site: hq, ip: 127.0.0.1, checks: [{ kind: tcp, port: 9 }] }
tunnels: []
links:
  - group: Test
    items: [{ name: Alt, host: alt }]
`;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-srv-"));
  fs.writeFileSync(path.join(dir, "inventory.yaml"), START);
  fake = fakeProxmox(); fakeUrl = await listenFake(fake);
  await new Promise(r => { openSrv = net.createServer(c => c.end()); openSrv.listen(0, "127.0.0.1", () => { openPort = openSrv.address().port; r(); }); });

  srv = createServer({
    inventory: path.join(dir, "inventory.yaml"),
    secrets: path.join(dir, "secrets.json"),
    state: path.join(dir, "incidents.json")
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => { srv.engine.stop(); srv.close(); fake.close(); openSrv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (m, p, body) => {
  const res = await fetch(base + p, {
    method: m,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
};

test("Zustand kommt in der Form, die die Oberfläche erwartet", async () => {
  const { body } = await call("GET", "/api/state");
  assert.equal(body.meta.live, true);
  for (const k of ["sites", "hosts", "tunnels", "incidents", "certs", "links", "integrations"])
    assert.ok(Array.isArray(body[k]), `${k} fehlt`);
  assert.equal(body.hosts[0].id, "alt");
  assert.equal(body.sites[0].short, "HQ", "Kürzel wird abgeleitet");
});

/* Ein leerer Bestand ist zweideutig: entweder ist wirklich noch nichts
   angelegt, oder der Dienst liest eine andere Ablage als beim letzten Start
   — nach einem Redeploy mit anderem Volume etwa. Von außen sieht beides
   gleich aus; nur der Dienst kennt den Unterschied, also sagt er ihn. */
test("Der Zustand nennt die Bestandsdatei und ob der Dienst sie selbst angelegt hat", async () => {
  const { body } = await call("GET", "/api/state");
  assert.equal(body.meta.runtime.bestand.datei, path.join(dir, "inventory.yaml"));
  assert.equal(body.meta.runtime.bestand.angelegt, false, "diese Datei lag schon da");

  const leer = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-leer-"));
  const zweiter = createServer({
    inventory: path.join(leer, "inventory.yaml"),
    secrets: path.join(leer, "secrets.json"),
    state: path.join(leer, "incidents.json"),
    seed: path.join(leer, "gibt-es-nicht.yaml")
  });
  try {
    await new Promise(r => zweiter.listen(0, "127.0.0.1", r));
    const st = await (await fetch(`http://127.0.0.1:${zweiter.address().port}/api/state`)).json();
    assert.equal(st.hosts.length, 0);
    assert.equal(st.meta.runtime.bestand.angelegt, true, "der Dienst hat die Datei eben erst angelegt");
    assert.equal(st.meta.runtime.bestand.vorlage, false, "ohne Vorlage bleibt das leere Gerüst");
    assert.equal(st.meta.runtime.bestand.datei, path.join(leer, "inventory.yaml"));
  } finally {
    zweiter.engine.stop(); zweiter.close();
    fs.rmSync(leer, { recursive: true, force: true });
  }
});

/* Zurückholen ist der einzige Weg hier, der einen bestehenden Bestand
   überschreibt — und der einzige, den man im Ernstfall braucht. Er läuft
   deshalb gegen einen eigenen Dienst: dieser Test darf den Bestand der
   anderen nicht unter den Füßen wegziehen. */
test("Frühere Stände lassen sich ansehen und zurückholen", async () => {
  const eigen = fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-stand-"));
  const datei = path.join(eigen, "inventory.yaml");
  fs.writeFileSync(datei, START);
  const s2 = createServer({ inventory: datei, secrets: path.join(eigen, "secrets.json"), state: path.join(eigen, "incidents.json") });
  await new Promise(r => s2.listen(0, "127.0.0.1", r));
  const an = `http://127.0.0.1:${s2.address().port}`;
  const ruf = async (m, pfad, body) => {
    const res = await fetch(an + pfad, { method: m, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };

  try {
    /* Der Start allein legt schon einen Auszug an — sonst hätte ein Bestand,
       der sich monatelang nicht ändert, nie einen. */
    let { body: st } = await ruf("GET", "/api/admin/staende");
    assert.equal(st.archiv.length, 1, "ein Auszug vom Start");
    assert.equal(st.datei.hosts, 1);
    assert.equal(st.sicherung, null, "noch nichts geschrieben, also noch keine Sicherung");

    await ruf("POST", "/api/admin/hosts", { id: "neu", type: "other", site: "hq", ip: "127.0.0.1" });
    ({ body: st } = await ruf("GET", "/api/admin/staende"));
    assert.equal(st.datei.hosts, 2, "der neue Stand");
    assert.equal(st.sicherung.hosts, 1, "und daneben der Stand von vorher");

    const zurueck = await ruf("POST", "/api/admin/restore", { quelle: ".bak" });
    assert.equal(zurueck.status, 200);
    assert.equal(zurueck.body.hosts, 1);
    const { body: jetzt } = await ruf("GET", "/api/state");
    assert.equal(jetzt.hosts.length, 1, "der Dienst prüft danach den zurückgeholten Bestand");
    assert.ok(!jetzt.hosts.some(h => h.id === "neu"));

    /* Und der Griff daneben bleibt umkehrbar: die Sicherung trägt jetzt den
       Stand, der eben ersetzt wurde. */
    ({ body: st } = await ruf("GET", "/api/admin/staende"));
    assert.equal(st.sicherung.hosts, 2);

    /* Zurückgeholt wird nur, was ausdrücklich erlaubt ist. */
    for (const quelle of ["../../etc/passwd", "/etc/passwd", "inventory.yaml", "beliebig"]) {
      const nein = await ruf("POST", "/api/admin/restore", { quelle });
      assert.equal(nein.status, 400, `„${quelle}" hätte abgewiesen werden müssen`);
    }
  } finally {
    s2.engine.stop(); s2.close();
    fs.rmSync(eigen, { recursive: true, force: true });
  }
});

test("Erfundene Bereiche bleiben leer statt gefüllt", async () => {
  const { body } = await call("GET", "/api/state");
  for (const k of ["peers", "haproxy", "backups", "mails"]) assert.deepEqual(body[k], []);
  assert.equal(body.hosts[0].cpu, null, "ohne Sammler keine Auslastung");
});

test("Proxmox anlegen — genau der Weg aus der Oberfläche", async () => {
  const add = await call("POST", "/api/admin/hosts",
    { id: "pve-hq-01", type: "pve", site: "hq", ip: "127.0.0.1", url: fakeUrl, role: "Cluster-Node" });
  assert.equal(add.status, 201);
  assert.deepEqual(add.body.item.checks.map(c => c.kind), ["icmp", "tcp"], "http-Attrappe: kein TLS");

  const inv = await call("GET", "/api/admin/inventory");
  assert.ok(inv.body.hosts.some(h => h.id === "pve-hq-01"));
  assert.ok(fs.readFileSync(path.join(dir, "inventory.yaml"), "utf8").includes("pve-hq-01"), "steht in der Datei");
});

test("Doppelte id wird abgewiesen", async () => {
  const r = await call("POST", "/api/admin/hosts", { id: "pve-hq-01", type: "pve", site: "hq", ip: "10.0.0.1" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /gibt es bereits/);
});

test("Unsinniger Bestand wird abgelehnt und die Datei bleibt heil", async () => {
  const vorher = fs.readFileSync(path.join(dir, "inventory.yaml"), "utf8");
  const r = await call("POST", "/api/admin/hosts", { id: "kaputt", type: "pve", site: "gibtsnicht", ip: "10.0.0.2" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Standort/);
  assert.equal(fs.readFileSync(path.join(dir, "inventory.yaml"), "utf8"), vorher);
});

test("Verbindungstest ohne Zugangsdaten meldet nur Erreichbarkeit", async () => {
  const r = await call("POST", "/api/admin/test", { id: "pve-hq-01", type: "pve", url: fakeUrl, ip: "127.0.0.1" });
  assert.equal(r.body.reachable, true);
  assert.equal(r.body.api.ok, false);
  assert.match(r.body.api.detail, /Keine Zugangsdaten/);
});

test("Verbindungstest mit Zugangsdaten spricht die echte API", async () => {
  const r = await call("POST", "/api/admin/test", {
    id: "pve-hq-01", type: "pve", url: fakeUrl, ip: "127.0.0.1",
    credentials: { user: "leitstand@pve", tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555" }
  });
  assert.equal(r.body.api.ok, true);
  assert.match(r.body.summary, /Proxmox VE 8\.3\.2/);
});

test("Falsches Geheimnis wird erklärt, nicht nur abgelehnt", async () => {
  const r = await call("POST", "/api/admin/test", {
    id: "pve-hq-01", type: "pve", url: fakeUrl, ip: "127.0.0.1",
    credentials: { user: "leitstand@pve", tokenId: "ro", secret: "falsch" }
  });
  assert.equal(r.body.api.ok, false);
  assert.match(r.body.api.hint, /Token-ID/);
});

test("Zugangsdaten werden gespeichert, aber nur maskiert zurückgegeben", async () => {
  const geheim = "1a2b3c4d-0000-1111-2222-333344445555";
  const r = await call("POST", "/api/admin/credentials/pve-hq-01", { user: "leitstand@pve", tokenId: "ro", secret: geheim });
  assert.equal(r.body.credentials.user, "leitstand@pve");
  assert.match(r.body.credentials.secret, /^••••••/);
  assert.ok(!JSON.stringify(r.body).includes(geheim), "das Geheimnis verlässt den Server nicht");

  const inv = await call("GET", "/api/admin/inventory");
  assert.ok(!JSON.stringify(inv.body).includes(geheim));
  assert.ok(!fs.readFileSync(path.join(dir, "inventory.yaml"), "utf8").includes(geheim), "und steht nicht im Bestand");

  const mode = fs.statSync(path.join(dir, "secrets.json")).mode & 0o777;
  assert.equal(mode, 0o600, "nur für den Dienstbenutzer lesbar");
});

test("Teilweises Ändern behält das Geheimnis", async () => {
  const r = await call("POST", "/api/admin/credentials/pve-hq-01", { user: "anderer@pve" });
  assert.equal(r.body.credentials.user, "anderer@pve");
  assert.match(r.body.credentials.secret, /^••••••/, "Geheimnis blieb bestehen");
});

test("Mit hinterlegtem Token liefert der Durchlauf echte Kennzahlen", async () => {
  await call("POST", "/api/admin/credentials/pve-hq-01", { user: "leitstand@pve", tokenId: "ro", secret: "1a2b3c4d-0000-1111-2222-333344445555" });
  await call("POST", "/api/admin/check");
  const { body } = await call("GET", "/api/state");
  const h = body.hosts.find(x => x.id === "pve-hq-01");
  assert.equal(h.cpu, 34);
  assert.equal(h.vms, 2);
  assert.equal(h.cluster, "cl-hq");
  assert.equal(h.status, "crit", "der Sammler meldet vollen Speicher");
});

test("Störung lässt sich quittieren", async () => {
  await call("POST", "/api/admin/check");
  const { body } = await call("GET", "/api/state");
  const inc = body.incidents[0];
  assert.ok(inc, "es gibt eine offene Störung");
  const r = await call("POST", `/api/incidents/${inc.id}/ack`, { on: true });
  assert.equal(r.status, 200);
  const nach = await call("GET", "/api/state");
  assert.equal(nach.body.incidents.find(i => i.id === inc.id).ack, true);
});

test("Datenquellen-Übersicht spiegelt den echten Stand", async () => {
  const { body } = await call("GET", "/api/state");
  const pve = body.integrations.find(i => i.type === "pve");
  assert.match(pve.method, /API-Token/);
  assert.match(pve.note, /1 von 1 mit Zugangsdaten/);
  const other = body.integrations.find(i => i.type === "other");
  assert.match(other.method, /nur Erreichbarkeit/);
});

test("System ändern zieht Prüfungen und Verknüpfungen nach", async () => {
  const r = await call("PUT", "/api/admin/hosts/alt", { role: "Umbenannt", ip: "127.0.0.1", checks: [{ kind: "tcp", port: openPort }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.role, "Umbenannt");
  await call("POST", "/api/admin/check");
  const { body } = await call("GET", "/api/state");
  assert.equal(body.hosts.find(h => h.id === "alt").status, "ok", "neuer Port wird sofort geprüft");
});

test("Standort mit Systemen lässt sich nicht versehentlich löschen", async () => {
  const r = await call("DELETE", "/api/admin/sites/hq");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /trägt noch/);
});

test("System löschen entfernt Zugangsdaten und Verknüpfungen mit", async () => {
  await call("DELETE", "/api/admin/hosts/alt");
  const inv = await call("GET", "/api/admin/inventory");
  assert.ok(!inv.body.hosts.some(h => h.id === "alt"));
  assert.ok(!inv.body.links.some(g => g.items.some(i => i.host === "alt")), "verwaiste Kachel wäre ein toter Link");
});

test("Oberfläche wird ausgeliefert", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Leitstand/);
});

test("Kein Ausbruch aus dem Auslieferungsverzeichnis", async () => {
  const res = await fetch(base + "/../server/secrets.json");
  assert.ok(res.status === 404 || res.status === 403, `unerwartet ${res.status}`);
});

/* ---------- Änderungen müssen sofort ankommen ----------
   Der Zustandsstrom ist die einzige Quelle der Oberfläche. Meldete eine
   Bestandsänderung sich dort nicht, sah man einen neu angelegten Standort
   erst nach dem nächsten Durchlauf — und der dauert so lange wie das
   langsamste stille System. Genau so entstand der Eindruck, das Anlegen
   habe nicht funktioniert. */
test("Ein neuer Standort steht sofort im Zustandsstrom", async () => {
  const res = await fetch(base + "/api/stream");
  const leser = res.body.getReader();
  const dec = new TextDecoder();
  let puffer = "";

  const naechsterZustand = async () => {
    while (true) {
      const i = puffer.indexOf("\n\n");
      if (i >= 0) {
        const roh = puffer.slice(0, i);
        puffer = puffer.slice(i + 2);
        if (roh.startsWith("data: ")) return JSON.parse(roh.slice(6));
        continue;
      }
      const { value, done } = await leser.read();
      if (done) throw new Error("Strom zu Ende");
      puffer += dec.decode(value, { stream: true });
    }
  };

  try {
    await naechsterZustand();                       /* der Erstzustand beim Verbinden */
    const t0 = Date.now();
    const r = await call("POST", "/api/admin/sites", { id: "sofort", name: "Sofort da", short: "DEBN" });
    assert.equal(r.status, 201);

    const st = await naechsterZustand();
    assert.ok(st.sites.some(s => s.id === "sofort"), "der Standort ist im gemeldeten Zustand");
    assert.ok(Date.now() - t0 < 2000, "und zwar sofort, nicht erst nach einem Durchlauf");
  } finally {
    leser.cancel().catch(() => {});
    await call("DELETE", "/api/admin/sites/sofort");
  }
});

/* Ein Durchlauf über viele stille Systeme dauert länger als das Intervall.
   Früher wurde ein zweiter Aufruf dann verworfen — „Jetzt prüfen" tat
   ausgerechnet dann nichts, wenn es am meisten gebraucht wurde. */
test("Ein Prüfaufruf während eines Durchlaufs wartet ihn ab, statt zu verpuffen", async () => {
  const e = srv.engine;
  const vorher = e.lastRun;
  const [a, b] = await Promise.all([e.runOnce(), e.runOnce()]);
  assert.equal(a, b, "beide Aufrufe teilen sich denselben Durchlauf");
  assert.notEqual(e.lastRun, vorher, "und er ist wirklich gelaufen");
  assert.equal(e.laufend, null, "danach ist nichts mehr offen");
});

test("Ein Standort ohne vierstelliges Kürzel wird abgelehnt", async () => {
  const r = await call("POST", "/api/admin/sites", { id: "neu1", name: "Ohne Kürzel" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /vier/i);

  const r2 = await call("POST", "/api/admin/sites", { id: "neu2", name: "Zu kurz", short: "XY" });
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /2 Stellen/);
});

test("Ein vierstelliges Kürzel wird angenommen und großgeschrieben", async () => {
  const r = await call("POST", "/api/admin/sites", { id: "koeln", name: "Köln", short: "deko" });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.short, "DEKO");
  await call("DELETE", "/api/admin/sites/koeln");
});

/* Ein Standort mit altem Kürzel muss änderbar bleiben, ohne dass man ihn
   zugleich umbenennen muss — sonst ist er eingefroren. */
test("Ändern ohne Kürzel im Rumpf lässt das alte in Ruhe", async () => {
  const r = await call("PUT", "/api/admin/sites/hq", { place: "Bonn" });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.place, "Bonn");

  const schlecht = await call("PUT", "/api/admin/sites/hq", { short: "XY" });
  assert.equal(schlecht.status, 400, "wird es aber mitgeschickt, gilt die Regel");
});

/* ---------- Tunnel ↔ WireGuard-Peer ---------- */

test("Ein Tunnel lässt sich mit einem Peer anlegen und wieder lösen", async () => {
  await call("POST", "/api/admin/hosts", { id: "fw", type: "opnsense", site: "hq", ip: "127.0.0.1" });
  const neu = await call("POST", "/api/admin/tunnels", {
    id: "wg", a: "hq", b: "rz", iface: "wg0",
    probe: { ip: "127.0.0.1", port: openPort },
    peer: { host: "fw", iface: "wg0", name: "WG-Schweiz", key: "Aqujl" }
  });
  assert.equal(neu.status, 201);
  assert.deepEqual(neu.body.item.peer, { host: "fw", iface: "wg0", name: "WG-Schweiz", key: "Aqujl" });

  /* Die Oberfläche schickt beim Lösen ausdrücklich null — das darf nicht
     als `peer: null` in der Bestandsdatei stehenbleiben. */
  const geloest = await call("PUT", "/api/admin/tunnels/wg", { peer: null });
  assert.equal(geloest.status, 200);
  assert.equal(geloest.body.item.peer, undefined);
  assert.ok(!/peer/.test(fs.readFileSync(path.join(dir, "inventory.yaml"), "utf8")),
    "der leere Peer steht noch in der Datei");
});

test("Ein Peer auf einem nicht angelegten System wird abgewiesen", async () => {
  const r = await call("POST", "/api/admin/tunnels", {
    id: "wg2", a: "hq", b: "rz", probe: { ip: "127.0.0.1" }, peer: { host: "gibtsnicht", name: "X" }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /nicht angelegt/);
});

test("Ein Tunnel ohne Gegenstelle und ohne Peer wird abgewiesen", async () => {
  const r = await call("POST", "/api/admin/tunnels", { id: "wg3", a: "hq", b: "rz" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /weder probe\.ip noch ein verknüpfter Peer/);
});

/* Eine Antwort ohne Angabe darf der Browser nach eigenem Gutdünken
   aufheben. Ein aufgehobener Zustand sieht aus wie eine Messung von
   jetzt — in einer Überwachung ist das der schlimmste Fall. */
test("Der Zustand darf nicht im Zwischenspeicher des Browsers landen", async () => {
  for (const pfad of ["/api/state", "/api/version"]) {
    const res = await fetch(base + pfad);
    assert.equal(res.headers.get("cache-control"), "no-store", `${pfad} ohne no-store`);
  }
  /* Die Oberfläche selbst darf zwischengespeichert werden — aber nur mit
     Rückfrage, sonst überlebt sie einen Redeploy. */
  const seite = await fetch(base + "/");
  assert.match(seite.headers.get("cache-control") || "", /no-cache/);
});

/* Beim Schreiben abgefangen, beim Lesen durchgelassen: ein Netz als
   Messziel ist ein Fehler, aber keiner, für den der Dienst nicht mehr
   starten darf. Genau daran ist er einmal gescheitert. */
test("Ein Netz als Messziel wird beim Anlegen abgelehnt", async () => {
  const r = await call("POST", "/api/admin/tunnels", {
    id: "wg-krumm", a: "hq", b: "rz", probe: { ip: "10.99.0.0/30" }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Netz/);
});

test("Ein Messziel mit Leerzeichen wird beim Anlegen weggeräumt", async () => {
  const r = await call("POST", "/api/admin/tunnels", {
    id: "wg-rand", a: "hq", b: "rz", probe: { ip: " 10.99.0.2 " }
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.probe.ip, "10.99.0.2");
  await call("DELETE", "/api/admin/tunnels/wg-rand");
});

/* ============================================================
   Prüfungen selbst festlegen

   Ein „sonstiges" System bekommt seine Prüfliste sonst aus IP und
   Adresse geraten: ICMP, Port 443, Zertifikat. Ein Switch, der nur SSH
   spricht, leuchtet damit für immer gelb — und eine Ampel, die immer
   gelb ist, hat man nach zwei Wochen abtrainiert.
   ============================================================ */

test("Die Verwaltung sagt, welche Prüfliste eigen ist und welche abgeleitet", async () => {
  await call("POST", "/api/admin/hosts", {
    id: "eigen-01", type: "other", site: "hq", ip: "127.0.0.1", checks: [{ kind: "tcp", port: 9 }]
  });
  await call("POST", "/api/admin/hosts", { id: "abgeleitet-01", type: "other", site: "hq", ip: "127.0.0.1" });

  const { body } = await call("GET", "/api/admin/inventory");
  const eigen = body.hosts.find(h => h.id === "eigen-01");
  const abgeleitet = body.hosts.find(h => h.id === "abgeleitet-01");
  assert.equal(eigen.checksEigen, true, "im Bestand steht ausdrücklich tcp/9");
  assert.deepEqual(eigen.checks, [{ kind: "tcp", port: 9 }]);
  assert.equal(abgeleitet.checksEigen, false, "diese Liste kommt aus IP und Adresse");
  assert.ok(abgeleitet.checks.length > 1);

  /* Und in der Datei steht die abgeleitete Liste nicht — sonst fröre sie
     einen Standardwert ein, der sich am Typ noch ändern soll. */
  const datei = fs.readFileSync(path.join(dir, "inventory.yaml"), "utf8");
  const zeile = datei.split("\n").find(z => z.includes("abgeleitet-01"));
  assert.ok(!/checks/.test(zeile || ""), "abgeleitete Prüfungen gehören nicht in die Datei");
});

test("Eine angehakte Prüfliste wird übernommen und geprüft", async () => {
  const angelegt = await call("POST", "/api/admin/hosts", {
    id: "switch-01", type: "other", site: "hq", ip: "127.0.0.1",
    checks: [{ kind: "icmp" }, { kind: "tcp", port: openPort }]
  });
  assert.equal(angelegt.status, 201);
  assert.deepEqual(angelegt.body.item.checks, [{ kind: "icmp" }, { kind: "tcp", port: openPort }],
    "kein abgeleitetes tcp/443 dazwischen");

  const inv = await call("GET", "/api/admin/inventory");
  assert.equal(inv.body.hosts.find(h => h.id === "switch-01").checksEigen, true);

  await srv.engine.runOnce();
  const zustand = await call("GET", "/api/state");
  const h = zustand.body.hosts.find(x => x.id === "switch-01");
  assert.deepEqual(h.checks.map(c => `${c.kind}${c.port ? "/" + c.port : ""}`), ["icmp", `tcp/${openPort}`],
    "geprüft wird genau das Angehakte");
});

/* Der Weg zurück muss es auch geben — sonst wäre die eigene Liste eine
   Einbahnstraße, und niemand traut sich, sie überhaupt anzufassen. */
test("Eine leere Prüfliste heißt „wieder ableiten“, nicht „nichts prüfen“", async () => {
  const r = await call("PUT", "/api/admin/hosts/switch-01", { checks: [] });
  assert.equal(r.status, 200);
  const inv = await call("GET", "/api/admin/inventory");
  const h = inv.body.hosts.find(x => x.id === "switch-01");
  assert.equal(h.checksEigen, false);
  assert.ok(h.checks.some(c => c.kind === "icmp"), "abgeleitet aus der IP");
  assert.ok(h.checks.length > 1, "und aus der Adresse");
});

/* Ein Test, der etwas anderes prüft als die Überwachung danach, ist
   schlimmer als keiner: er sagt „erreichbar" zu einem Port, den niemand
   mehr ansieht. */
test("Der Verbindungstest prüft, was angehakt ist", async () => {
  const eigen = await call("POST", "/api/admin/test", {
    id: "probe", type: "other", site: "hq", ip: "127.0.0.1",
    checks: [{ kind: "tcp", port: openPort }]
  });
  assert.deepEqual(eigen.body.steps.map(s => `${s.kind}/${s.port}`), [`tcp/${openPort}`]);
  assert.equal(eigen.body.reachable, true);

  const abgeleitet = await call("POST", "/api/admin/test", {
    id: "probe", type: "other", site: "hq", ip: "127.0.0.1", checks: []
  });
  assert.ok(abgeleitet.body.steps.length > 1, "ohne eigene Liste wird abgeleitet");
});

test("Eine unbekannte Prüfart wird abgelehnt, statt still zu verschwinden", async () => {
  const r = await call("PUT", "/api/admin/hosts/switch-01", { checks: [{ kind: "quux", port: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /quux/);
});
