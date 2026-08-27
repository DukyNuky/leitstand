/* UniFi Network Controller — die Schicht, über die der Rest des
   Leitstands nichts weiß.

   Geprüft wird gegen einen nachgebauten Controller über echtes HTTP,
   und zwar in beiden Bauarten (UniFi OS mit Präfix, eigenständige
   Anwendung ohne) und über beide Anmeldungen (Keks und Schlüssel). Die
   Fälle, die zählen, sind die, die ein offener Port nie zeigt: ein AP,
   der sich abgemeldet hat, einer, der seinen Uplink verloren hat und
   für sich weitersendet, und ein Funkband, das so belegt ist, dass
   nichts mehr durchgeht. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectUnifi, testConnection, sitzungVergessen, baseUrl, basen, einordnen, keksAus, funkmodule, geraet,
  anmelden, keksVerbinden, istSitzung
} from "../src/collectors/unifi.js";
import { diagnoseHost } from "../src/diagnose.js";
import { listen, close } from "./fake-dienste.js";
import { fakeUnifi, geraete, UNIFI_USER, UNIFI_PASS, UNIFI_KEY } from "./fake-unifi.js";

const CRED = { user: UNIFI_USER, password: UNIFI_PASS };
const CRED_KEY = { apiKey: UNIFI_KEY };

let lauf = 0;
async function mitFake(opt, fn) {
  const s = fakeUnifi(opt);
  const url = await listen(s);
  /* Jeder Test bekommt eine eigene Kennung: die Sitzung wird je System
     gemerkt, und ein Keks von vorhin ist eine Auskunft über einen
     Controller, den es nicht mehr gibt. */
  const host = { id: `wlan-${++lauf}`, type: "unifi", name: "UniFi", url };
  try { return await fn(host, s); }
  finally { sitzungVergessen(host.id); await close(s); }
}

test("Der Sammler liest Access Points, Zustand und Kanalbelegung", async () => {
  const out = await mitFake({}, h => collectUnifi(h, CRED));

  assert.equal(out.quelle, "klassisch");
  assert.equal(out.site, "Zuhause");
  assert.equal(out.version, "9.0.114");
  assert.equal(out.aps, 3);
  assert.equal(out.apsOnline, 3);
  assert.equal(out.switche, 1);
  assert.equal(out.geraeteGesamt, 4);
  /* Die Clientzahl kommt aus der Gesundheit des Controllers, nicht aus
     einer eigenen Summe — sie zählt dieselben Geräte nur einmal. */
  assert.equal(out.clients, 23);
  assert.equal(out.clientsGast, 2);

  const ap = out.geraete.find(g => g.name === "ap-wohnzimmer");
  assert.equal(ap.art, "ap");
  assert.equal(ap.zustand, "online");
  assert.equal(ap.ip, "10.0.0.20");
  assert.equal(ap.fassung, "6.6.65");
  assert.equal(ap.clients, 12);
  assert.equal(ap.uplink, "sw-keller");
  assert.equal(ap.uplinkFunk, false);
  assert.equal(ap.funk.length, 2);
  assert.equal(ap.funk[0].band, "2,4 GHz");
  assert.equal(ap.funk[0].last, 62);
  assert.equal(ap.funk[0].breite, 20, "die Kanalbreite steht in radio_table, nicht in den Statistiken");
  assert.equal(ap.funk[1].band, "5 GHz");
  assert.equal(ap.kanalLast, 62, "die höchste Belegung über beide Bänder");

  assert.equal(out.status, undefined, "nichts Auffälliges, also keine Farbe");
  assert.match(out.note, /3 von 3 Access Points verbunden/);
  assert.match(out.note, /23 Clients/);
});

/* Der eigentliche Grund für diesen Sammler: ein AP, der sich abgemeldet
   hat, sieht von außen aus wie einer, der läuft — solange er Strom hat. */
test("Ein getrennter Access Point ist gelb, und zwar mit Namen", async () => {
  const out = await mitFake({ zustaende: [1, 0, 1] }, h => collectUnifi(h, CRED));
  assert.equal(out.status, "warn");
  assert.equal(out.apsOffline, 1);
  assert.match(out.note, /1 von 3 Access Points getrennt: ap-buero/);
});

test("Steht kein einziger Access Point mehr, ist das rot", async () => {
  const out = await mitFake({ zustaende: [0, 0, 0] }, h => collectUnifi(h, CRED));
  assert.equal(out.status, "crit");
  assert.match(out.note, /Keiner der 3 Access Points/);
  assert.match(out.note, /kein WLAN/);
});

/* „Isoliert" heißt: der AP funkt weiter, hat aber keinen Uplink mehr.
   Seine Clients sind verbunden und kommen nirgendwohin — der Fall, den
   niemand sucht, weil das WLAN ja „da" ist. */
test("Ein isolierter Access Point wird als solcher benannt", async () => {
  const out = await mitFake({ zustaende: [1, 11, 1] }, h => collectUnifi(h, CRED));
  assert.equal(out.status, "warn");
  assert.equal(out.apsIsoliert, 1);
  assert.match(out.note, /isoliert \(Uplink verloren\): ap-buero/);
  const ap = out.geraete.find(g => g.name === "ap-buero");
  assert.match(ap.zustandText, /funkt für sich allein/);
});

test("Ein getrennter Switch fällt ebenfalls auf", async () => {
  const out = await mitFake({ switchAus: true }, h => collectUnifi(h, CRED));
  assert.equal(out.status, "warn");
  assert.match(out.note, /Switch\(es\) getrennt: sw-keller/);
});

/* Kanalbelegung ist die Zahl, die „das WLAN ist langsam" erklärt, während
   jede Ampel grün steht. Sie darf aber nicht täglich leuchten: 2,4 GHz
   liegt fast überall dauerhaft hoch. */
test("Ein volles Funkband geht auf Gelb — mit Band, Kanal und Gerät", async () => {
  const out = await mitFake({ cu: [91, 20] }, h => collectUnifi(h, CRED, { wlan_kanal_warn: 80 }));
  assert.equal(out.status, "warn");
  assert.match(out.note, /2,4 GHz zu 91 % belegt/);
  assert.match(out.note, /Kanal 6/);
});

test("Unterhalb der Grenze ist eine hohe Belegung nur eine Zahl, keine Ampel", async () => {
  const out = await mitFake({ cu: [62, 18] }, h => collectUnifi(h, CRED, { wlan_kanal_warn: 80 }));
  assert.equal(out.status, undefined);
  assert.match(out.note, /Kanal bis 62 % belegt/);
});

test("Die Grenze ist einstellbar", async () => {
  const out = await mitFake({ cu: [62, 18] }, h => collectUnifi(h, CRED, { wlan_kanal_warn: 50 }));
  assert.equal(out.status, "warn");
  assert.match(out.note, /2,4 GHz zu 62 % belegt/);
});

/* Eine anstehende Firmware ist eine Aufgabe, keine Störung. Eine Ampel
   dafür leuchtete ständig — und mit ihr wäre die nächste, die zählt,
   nichts mehr wert. */
test("Eine neue Fassung ist eine Notiz, keine Farbe", async () => {
  const out = await mitFake({ update: true }, h => collectUnifi(h, CRED));
  assert.equal(out.status, undefined);
  assert.equal(out.wlanUpdates ?? out.updates, 1);
  assert.match(out.note, /1 Gerät\(e\) mit neuer Fassung/);
});

/* Beide Bauarten — und der Fall, an dem die Anmeldung am selbst
   betriebenen Controller lange scheiterte: dort ist `/api/auth/login`
   kein unbekannter Pfad mit einer 404, sondern eine 401 vom Wachposten
   vor `/api/`. Wird die für ein falsches Passwort gehalten, wird
   `/api/login` nie versucht — und der Leitstand meldet abgelehnte
   Zugangsdaten, obwohl sie stimmen. */
test("Die eigenständige Network Application wird ohne Präfix gefunden", async () => {
  await mitFake({ unifios: false }, async (h, server) => {
    const out = await collectUnifi(h, CRED);
    assert.equal(out.aps, 3);
    assert.equal(out.status, undefined);
    assert.ok(server.gesehen.includes("/api/auth/login"),
      "der Weg über UniFi OS wird zuerst versucht");
    assert.ok(server.gesehen.includes("/api/login"),
      "und nach dessen 401 der Weg der eigenständigen Anwendung — sonst kommt hier niemand hinein");
  });
});

/* Die Ablehnung muss trotzdem eine Ablehnung bleiben: wer beide Pfade
   versucht, darf nicht jedes falsche Passwort als „Pfad nicht gefunden"
   durchgehen lassen. */
test("Am eigenständigen Controller bleibt ein falsches Passwort eine Ablehnung", async () => {
  const out = await mitFake({ unifios: false }, h => collectUnifi(h, { user: "x", password: "y" }));
  assert.equal(out.status, "warn");
  assert.match(out.note, /abgelehnt/);
});

/* Der Fall, der eine Fehlersuche gekostet hat: die Zugangsdaten
   stimmen — dieselben, mit denen man sich in der Weboberfläche anmeldet
   — und der Controller weist sie trotzdem ab. Neuere Fassungen nehmen
   einen POST nur an, wenn er aussieht, als käme er von ihrer eigenen
   Seite: mit `Origin` und dem `csrf_token`, das die Anmeldeseite
   ausstellt. Ein Browser schickt beides von selbst mit, ein Dienst muss
   es sagen. Fehlt es, kommt dieselbe Absage wie bei einem falschen
   Passwort — und der Leitstand warf jemandem sein Passwort vor, während
   es stimmte. */
test("Verlangt der Controller Herkunft und CSRF-Token, kommt die Anmeldung trotzdem durch", async () => {
  await mitFake({ unifios: false, csrfPflicht: true }, async (h, server) => {
    const out = await collectUnifi(h, CRED);
    assert.equal(out.aps, 3, "die Anmeldung muss durchkommen, nicht scheitern");
    assert.equal(out.status, undefined);
    assert.ok(server.gesehen.includes("/"),
      "die Anmeldeseite wird geholt — dort liegt das csrf_token, ohne das der POST abgewiesen wird");
  });
});

/* Ein falsches Passwort bleibt auch dann falsch, wenn die Herkunft
   stimmt — sonst hätte der Griff nach der Anmeldeseite nur die Absage
   verschoben. */
test("Mit Herkunft und Token bleibt ein falsches Passwort abgelehnt", async () => {
  const out = await mitFake({ unifios: false, csrfPflicht: true },
    h => collectUnifi(h, { user: UNIFI_USER, password: "falsch" }));
  assert.equal(out.status, "warn");
  assert.match(out.note, /abgelehnt/);
});

/* Manche Fassungen beantworten die geglückte Anmeldung mit einer
   Umleitung auf die Oberfläche und legen die Sitzung trotzdem bei. Wer
   nur auf 200 wartet, wirft einen gültigen Keks weg und meldet einen
   Fehler, den es nicht gibt. */
test("Eine Anmeldung, die mit einer Umleitung endet, ist trotzdem eine Anmeldung", async () => {
  const out = await mitFake({ unifios: false, umleitung: true }, h => collectUnifi(h, CRED));
  assert.equal(out.aps, 3);
  assert.equal(out.status, undefined);
});

/* Eine Absage ohne Grund ist eine halbe Auskunft. Was der Controller
   selbst dazu sagt, gehört in die Meldung — daran hängt, ob man beim
   Konto sucht oder beim Weg. */
test("Eine abgelehnte Anmeldung nennt den Grund, den der Controller angibt", async () => {
  await mitFake({ unifios: false }, async h => {
    const an = await anmelden(h, { user: "x", password: "y" });
    assert.equal(an.ok, false);
    assert.match(an.error, /api\.err\.Invalid/, "der Satz aus dem Rumpf, nicht nur „abgelehnt“");
    assert.ok(an.versuche.length >= 2, "jeder Versuch steht mit Adresse, Pfad und Code darin");
    assert.ok(an.versuche.some(v => v.pfad === "/api/auth/login" && v.art === "weg"));
    assert.ok(an.versuche.some(v => v.pfad === "/api/login" && v.art === "daten"));
  });
});

/* Und in der Diagnose steht dasselbe sichtbar: ohne die Rohantwort ließe
   sich „das Konto wird abgelehnt“ nicht von „so nimmt der Controller
   keine Anfrage an“ unterscheiden. */
test("Die Diagnose zeigt, was der Controller auf jeden Anmeldeversuch geantwortet hat", async () => {
  await mitFake({ unifios: false }, async h => {
    const b = await diagnoseHost(h, { user: "x", password: "y" });
    const an = b.api.find(a => /login/.test(a.pfad));
    assert.equal(an.ok, false);
    assert.match(an.antwort, /api\.err\.Invalid/);
    assert.match(an.antwort, /api\/login/, "welcher Pfad die Absage gab, steht dabei");
  });
});

/* Was zusammengehört, ergibt die Sitzung: das Token von der
   Anmeldeseite und der Keks aus der Anmeldung. Fällt eines davon unter
   den Tisch, scheitert der erste Abruf statt der Anmeldung — und der
   Fehler stünde an der falschen Stelle. */
test("Vorab-Keks und Anmelde-Keks ergeben zusammen die Sitzung", () => {
  assert.equal(keksVerbinden("csrf_token=vorab", "unifises=abc; csrf_token=neu"),
    "csrf_token=neu; unifises=abc", "bei gleichem Namen gilt das Neuere");
  assert.equal(keksVerbinden(null, "TOKEN=x"), "TOKEN=x");
  assert.equal(keksVerbinden(null, null), null);
  assert.equal(istSitzung("csrf_token=vorab"), false, "ein CSRF-Token allein ist keine Sitzung");
  assert.equal(istSitzung("csrf_token=v; unifises=abc"), true);
});

/* Der Kern der Unterscheidung, an den echten Antworten beider Bauarten.
   Ein Statuscode allein trägt sie nicht: 401 steht auf beiden Seiten. */
test("Eine Absage wird am Rumpf gelesen, nicht am Statuscode", () => {
  const wachposten = { status: 401, body: JSON.stringify({ meta: { rc: "error", msg: "api.err.LoginRequired" } }) };
  assert.equal(einordnen(wachposten), "weg", "der Wachposten vor einem unbekannten Pfad");
  assert.equal(einordnen({ status: 400, body: JSON.stringify({ meta: { rc: "error", msg: "api.err.Invalid" } }) }), "daten");
  assert.equal(einordnen({ status: 401, body: JSON.stringify({ code: "AUTHENTICATION_FAILED" }) }), "daten");
  assert.equal(einordnen({ status: 401, body: "" }), "daten", "ohne Rumpf bleibt es bei der Auskunft des Codes");
  assert.equal(einordnen({ status: 499, body: JSON.stringify({ code: "Ubic2faTokenRequired" }) }), "2fa");
  assert.equal(einordnen({ status: 200, body: "<html><body>UniFi</body></html>" }), "weg", "die Weboberfläche ist kein Endpunkt");
  assert.equal(einordnen({ error: "Verbindung abgewiesen — läuft die Oberfläche auf diesem Port?" }), "port");
  assert.equal(einordnen({ error: "Zeitüberschreitung nach 8000 ms" }), "netz");
});

test("Mit einem API-Schlüssel wird zuerst die klassische API versucht", async () => {
  const out = await mitFake({}, h => collectUnifi(h, CRED_KEY));
  assert.equal(out.quelle, "klassisch", "sie trägt die Funkzahlen — deshalb hat sie Vorrang");
  assert.equal(out.kanalLast, 62);
});

/* Trägt der Schlüssel nur die offizielle Integration-API, kommen weniger
   Zahlen — aber die Zustände kommen. Und es steht dabei, dass etwas
   fehlt: sonst sähe eine leere Kanalbelegung wie ein Fehler aus. */
test("Weist die klassische API den Schlüssel ab, greift die Integration-API", async () => {
  const out = await mitFake({ nurIntegration: true }, h => collectUnifi(h, CRED_KEY));
  assert.equal(out.quelle, "integration");
  assert.equal(out.aps, 3);
  assert.equal(out.apsOnline, 3);
  assert.equal(out.kanalLast, null, "Funkzahlen kennt diese API nicht — null, nicht 0");
  assert.equal(out.clients, null);
  assert.match(out.note, /Integration-API/);
});

test("Auch über die Integration-API fällt ein getrennter AP auf", async () => {
  const out = await mitFake({ nurIntegration: true, zustaende: [1, 0, 1] }, h => collectUnifi(h, CRED_KEY));
  assert.equal(out.status, "warn");
  assert.match(out.note, /ap-buero/);
});

/* Eine Überwachung ist kein Anwesenheitsprotokoll. */
test("Die Clientliste wird nicht abgerufen — gezählt, nicht aufgeschrieben", async () => {
  await mitFake({}, async (h, server) => {
    await collectUnifi(h, CRED);
    assert.ok(!server.gesehen.some(p => p.includes("/stat/sta")),
      "kein Abruf der Clientliste: " + server.gesehen.join(", "));
  });
});

test("Falsche Zugangsdaten sind gelb mit Grund, nicht still", async () => {
  const out = await mitFake({}, h => collectUnifi(h, { user: "x", password: "y" }));
  assert.equal(out.status, "warn");
  assert.match(out.note, /abgelehnt/);
});

/* Ein Konto mit zweitem Faktor lässt keinen Dienst herein. Das steht bei
   UniFi nur im Rumpf der Antwort — im Statuscode steht es nicht. */
test("Zwei-Faktor-Anmeldung wird als solche gemeldet", async () => {
  const out = await mitFake({ zweiFaktoren: true }, h => collectUnifi(h, CRED));
  assert.match(out.note, /Zwei-Faktor/);
});

test("Der Verbindungstest nennt Site, Geräte und Access Points", async () => {
  const r = await mitFake({}, h => testConnection(h, CRED));
  assert.equal(r.ok, true);
  assert.match(r.detail, /Site „Zuhause“/);
  assert.match(r.detail, /4 Geräte, 4 online, 3 Access Point/);
});

test("Der Verbindungstest sagt, wenn nur die Integration-API trägt", async () => {
  const r = await mitFake({ nurIntegration: true }, h => testConnection(h, CRED_KEY));
  assert.equal(r.ok, true);
  assert.match(r.detail, /ohne Funkzahlen/);
});

/* ---------- Diagnose ---------- */

test("Die Diagnose zeigt Anmeldung, Site und jeden Abruf", async () => {
  const b = await mitFake({}, h => diagnoseHost(h, CRED, { icmp: false, timeout: 1 }));
  assert.equal(b.ok, true);
  assert.equal(b.zugang.vorhanden, true);

  const an = b.api[0];
  assert.match(an.pfad, /login/);
  assert.equal(an.ok, true);
  assert.match(an.befund, /UniFi OS/);

  const sites = b.api.find(a => a.pfad.includes("self/sites"));
  assert.match(sites.befund, /gelesen wird „Zuhause"/);

  const dev = b.api.find(a => a.pfad.includes("stat/device"));
  assert.equal(dev.ok, true);
  assert.match(dev.pfad, /^\/proxy\/network/, "das gefundene Präfix gehört in den Bericht");
  assert.match(dev.befund, /4 Geräte, 4 online, davon 3 Access Point/);
  assert.match(b.fazit, /kommen durch/);
});

test("Die Diagnose zeigt eine abgelehnte Anmeldung als solche", async () => {
  const b = await mitFake({}, h => diagnoseHost(h, { user: "x", password: "y" }, { icmp: false, timeout: 1 }));
  assert.equal(b.ok, false);
  assert.equal(b.api[0].ok, false);
  assert.match(b.fazit, /Anmeldung kommt nicht durch/);
  assert.match(b.fazit, /Viewer/, "der Bericht sagt auch, welches Konto gemeint ist");
});

test("Ohne Zugang sagt die Diagnose, welcher gebraucht wird", async () => {
  const b = await mitFake({}, h => diagnoseHost(h, null, { icmp: false, timeout: 1 }));
  assert.equal(b.zugang.vorhanden, false);
  assert.match(b.fazit, /kein Zugang hinterlegt/);
  assert.match(b.fazit, /Integrations/);
});

test("Über die Integration-API sagt das Fazit, was dabei fehlt", async () => {
  const b = await mitFake({ nurIntegration: true }, h => diagnoseHost(h, CRED_KEY, { icmp: false, timeout: 1 }));
  assert.equal(b.ok, true);
  assert.match(b.fazit, /Kanalbelegung/);
});

/* ---------- Kleinteile ---------- */

test("Die Adresse kommt aus der url, sonst aus ip und Standardport", () => {
  assert.equal(baseUrl({ url: "https://10.0.0.1:8443/" }), "https://10.0.0.1:8443");
  assert.equal(baseUrl({ ip: "10.0.0.1" }), "https://10.0.0.1:443");
});

/* Welcher Anschluss gilt, ist von außen nicht zu sehen: UniFi OS hört auf
   443, die selbst betriebene Anwendung auf 8443. Wer nur eine Adresse
   einträgt, soll deshalb nicht an einem „Verbindung abgewiesen" hängen
   bleiben — es sei denn, er hat den Anschluss selbst hingeschrieben. */
test("Ohne Anschluss in der Adresse gelten 443 und 8443", () => {
  assert.deepEqual(basen({ ip: "10.0.0.1" }), ["https://10.0.0.1:443", "https://10.0.0.1:8443"]);
  assert.deepEqual(basen({ url: "https://unifi.lan" }), ["https://unifi.lan:443", "https://unifi.lan:8443"]);
  assert.deepEqual(basen({ url: "https://unifi.lan:8443/" }), ["https://unifi.lan:8443"],
    "wer 8443 hinschreibt, meint 8443 — dann wird nichts anderes probiert");
});

test("Aus set-cookie wird zurückgeschickt, was ausgestellt wurde", () => {
  assert.equal(keksAus({ "set-cookie": ["TOKEN=a1; Path=/; HttpOnly", "csrf_token=b2; Path=/"] }),
    "TOKEN=a1; csrf_token=b2");
  assert.equal(keksAus({}), null);
});

/* Was ein Gerät nicht meldet, bleibt leer. Eine 0 stünde für „gemessen
   und nichts gefunden" — das wäre bei einem fehlenden Feld gelogen. */
test("Ein Gerät ohne Funkangaben ergibt Striche, keine Nullen", () => {
  const g = geraet({ name: "ap-x", type: "uap", state: 1 });
  assert.equal(g.kanalLast, null);
  assert.equal(g.clients, null);
  assert.equal(g.laufzeit, null);
  assert.deepEqual(g.funk, []);
  assert.equal(g.zustand, "online");
});

test("Ein unbekannter Zustand wird benannt, nicht geraten", () => {
  const g = geraet({ name: "ap-y", type: "uap", state: 42 });
  assert.equal(g.zustand, "unbekannt");
  assert.match(g.zustandText, /42/);
});

test("Funkmodule ohne Statistik ergeben eine leere Liste", () => {
  assert.deepEqual(funkmodule({}), []);
  assert.deepEqual(funkmodule({ radio_table_stats: null }), []);
});
