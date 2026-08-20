# Leitstand

Zentrale Schaltstelle für ein verteiltes Heimnetz: Startseite, Ampelwand und
Störungsübersicht in einem Werkzeug.

Der Leitstand ist ein laufender Dienst (`server/`) mit eigener Oberfläche
(`ui/`): er prüft Erreichbarkeit, Antwortzeiten, Zertifikate und VPN-Tunnel,
liest Proxmox über die API aus und wird vollständig in der Oberfläche gepflegt —
Standorte, Systeme, Tunnel, Startseite, Schwellwerte. Kein Build, eine einzige
Abhängigkeit.

**Alles, was angezeigt wird, ist gemessen.** Es gibt keinen Beispielbestand mehr,
auf den die Oberfläche zurückfällt: antwortet der Dienst nicht, sagt sie das und
zeigt nichts. Nur die Bereiche, die noch gar nicht angebunden sind
(Alarm-Postfach, HAProxy, Road-Warrior, Sicherungsaufträge, Push-Kanäle), zeigen
je *ein* ausdrücklich als **Beispiel** gekennzeichnetes Muster — damit sichtbar
bleibt, was dort einmal stehen wird.

## Loslegen

```bash
cd server
npm install
npm start                     # http://localhost:8080
```

Mitgeliefert wird ein **Beispielbestand**: je ein System pro Typ, ein Tunnel,
zwei Standorte, eine Startseite. Die Adressen zeigen ins Leere — bis sie ersetzt
sind, stehen diese Systeme auf Rot. Das ist gewollt: eine Überwachung, die für
ein nicht vorhandenes Gerät Grün zeigt, wäre wertlos. Einzig `leitstand`
(127.0.0.1:8080) trifft zu — das ist der Dienst selbst und damit die einzige
grüne Ampel beim ersten Start.

Erster Schritt: unter **Verwaltung** die Beispiele löschen oder auf die eigenen
Adressen ziehen.

Eigener Bestand an anderer Stelle:

```bash
LEITSTAND_INVENTORY=/pfad/zu/inventory.yaml PORT=8080 node src/server.js
```

## Als Stack in Portainer

**Portainer → Stacks → Add stack → Web editor**, den Inhalt von
[`docker-compose.yml`](docker-compose.yml) hineinkopieren, *Deploy the stack*.
Fertig — es wird nichts gebaut, das Abbild kommt aus der GitHub Container
Registry und enthält Dienst und Oberfläche.

### Einstellen

Alle Stellschrauben des Stacks stehen in [`.env`](.env) neben der Compose-Datei:

| Wert | Vorgabe | wofür |
|---|---|---|
| `LEITSTAND_IMAGE` | `ghcr.io/dukynuky/leitstand:main` | für einen festen Stand einen `sha-`Tag eintragen |
| `LEITSTAND_PORT` | `8080` | Port auf dem Docker-Wirt |
| `LEITSTAND_BIND` | leer (alle Adressen) | z. B. `127.0.0.1`, wenn ein Reverse Proxy davor liegt |
| `LEITSTAND_DATA` | `leitstand-data` | benanntes Volume — oder ein Pfad wie `/srv/leitstand/data` |
| `TZ` | `Europe/Berlin` | Zeitzone für Zeitstempel |
| `LEITSTAND_RESTART` | `unless-stopped` | Neustartverhalten |

Ohne `.env` greifen dieselben Vorgaben; in Portainer lassen sich die Werte auch
im Formular unter *Environment variables* setzen, das gewinnt gegenüber der Datei.

**Zugangsdaten gehören nicht in die `.env`.** API-Token werden in der Oberfläche
unter *Verwaltung* hinterlegt und landen in `secrets.json` im Volume, mit
Rechten `0600`. Ein Test wacht darüber, dass in der `.env` nichts steht, was
nach einem Geheimnis aussieht.

Abfrageintervall, Zeitlimits und Schwellwerte stehen bewusst **nicht** in der
`.env`, sondern in `inventory.yaml` und damit in der Oberfläche unter
*Verwaltung → Schwellwerte*. Zwei Quellen für denselben Wert wären der sichere
Weg in Verwirrung — eine Änderung in der Oberfläche sähe folgenlos aus.

Beim ersten Start ist das Volume leer. Der Leitstand legt dann selbst einen
Bestand an — die im Abbild mitgelieferte **Beispielvorlage** — und läuft sofort.
Erwartungsgemäß steht dann fast alles auf Rot: die Beispieladressen gibt es im
eigenen Netz nicht. Unter *Verwaltung* werden sie gelöscht oder auf die echten
Geräte gezogen. Im Volume liegen danach:

```
/data/inventory.yaml       Bestand   (Sicherung als inventory.yaml.bak)
/data/secrets.json         Zugangsdaten, Rechte 0600
/data/incidents.json       Störungen und Quittierungen, überlebt Neustarts
```

**Das Abbild ist privat**, solange es das Repository ist. Zwei Wege:

- *Bequem:* auf GitHub unter **Packages → leitstand → Package settings →
  Change visibility** auf öffentlich stellen. Das Repository bleibt privat, nur
  das Abbild wird ziehbar. Danach genügt Kopieren und Einsetzen.
- *Geschlossen:* in Portainer unter **Registries** einmalig `ghcr.io`
  hinterlegen — Benutzername ist der GitHub-Name, Passwort ein Token mit
  `read:packages`.

Lieber selbst bauen? **Stacks → Add stack → Repository**, URL des Repositorys,
Compose-Pfad `docker-compose.yml`, und darin `image:` durch die beiden
auskommentierten `build:`-Zeilen ersetzen.

### ICMP im Container

Alpine erlaubt unprivilegiertes `ping` nur mit der Fähigkeit `NET_RAW`, die in
der Compose-Datei bereits gesetzt ist. Fehlt sie, überspringt der Prober ICMP
und prüft nur TCP — für Weboberflächen reicht das, für reine Ping-Ziele nicht.
Sollen Geräte im eigenen Netz direkt erreicht werden, ist `network_mode: host`
oft der einfachere Weg; die Portfreigabe entfällt dann.

### Ohne Portainer

```bash
docker compose up -d          # aus der Wurzel des Repositorys
```

## Was Stufe 1 kann

| | |
|---|---|
| **Erreichbarkeit** | ICMP, TCP-Port, HTTP-Status — alle 15 s, drei Fehlschläge bis Rot |
| **Antwortzeiten** | Verlauf je System, sichtbar als Sparkline |
| **Zertifikate** | Restlaufzeit aller TLS-Ziele, Warnung ab 30 Tagen, Rot ab 14 |
| **VPN-Tunnel** | Messung **durch** den Tunnel auf die Gegenstelle — ohne jeden Zugang |
| **Proxmox VE** | CPU, RAM, Speicher je Storage, VMs/LXC, Cluster-Quorum, Version |
| **Proxmox BS** | Datastore-Belegung, fehlgeschlagene Verify-/GC-/Sync-Aufträge |
| **Proxmox MG** | Ein-/Ausgang, Spam- und Virenzahlen |
| **Störungen** | Bündelung gleicher Ursachen, Quittieren, Stummschalten |
| **Standort-Bündelung** | Ist ein ganzer Standort still, gibt es **eine** Meldung statt zwölf |
| **Verwaltung** | Standorte, Systeme, Tunnel, Startseite und Schwellwerte in der Oberfläche pflegen |

Alles andere (OPNsense, pfSense, TrueNAS, AdGuard, Portainer, Mailcow, Home
Assistant) wird bisher nur auf Erreichbarkeit geprüft. Die Oberfläche zeigt für
noch unbekannte Kennzahlen einen Strich — **nie einen erfundenen Wert.**

**Was ausdrücklich noch fehlt: die Alarmierung.** Push-Kanäle und Totmannschalter
stehen aus (Stufe 6). Bis dahin ist der Leitstand ein Bildschirm, kein Wecker —
wer nicht hinsieht, erfährt nichts. Das ist der wichtigste offene Punkt und steht
deshalb auch in der Oberfläche unter *Einstellungen → Ausbaustand*.

## Welche Fassung läuft gerade?

Bei automatischem Redeploy ist das die Frage, die man am häufigsten hat: Portainer
hat neu ausgerollt — sehe ich schon den neuen Stand oder noch den alten?

**Unten links in der Leiste** steht dauerhaft die laufende Fassung, etwa
`● 9f3c1d2 · 20.08. 07:44`. Überfahren zeigt die Langfassung mit Zweig,
Commit-Zeitpunkt und Bauzeitpunkt; ein Klick führt zu *Einstellungen → Dieser Dienst*.
Das Zeichen davor nennt die Herkunft:

| | |
|---|---|
| `●` | aus dem Abbild — Commit und Bauzeitpunkt sind eingebrannt |
| `◆` | aus dem Arbeitsbaum — `npm start` beim Entwickeln, gelesen aus `.git` |
| `◇` | Dateistand — selbst gebaut ohne Bauparameter, nur der Zeitpunkt ist bekannt |
| `○` | unbekannt — es wird nichts behauptet |
| `▲` | **der Dienst ist inzwischen ein anderer als diese Seite** |

Genau dafür ist das gedacht: Die Oberfläche merkt sich beim Laden, welcher Stand
antwortet, und vergleicht das mit jeder Antwort. Rollt Portainer neu aus, läuft im
Browser weiterhin das alte JavaScript — dann erscheint oben ein Streifen
*„Neue Fassung ausgerollt … Neu laden"*. Nicht automatisch, damit niemand ein
offenes Formular unter den Händen verliert.

Nennt das Abbild keine Fassung, greift der Startzeitpunkt des Prozesses: nach
einem Redeploy ist er in jedem Fall ein anderer, und die Meldung lautet dann
ehrlich *„Der Dienst wurde neu gestartet"*.

Zum Nachsehen ohne Oberfläche:

```bash
curl -s http://leitstand:8080/api/version
{"version":"0.1.0","commit":"9f3c1d2…","shortCommit":"9f3c1d2","branch":"main",
 "committed":"2026-08-20T05:40:00Z","built":"2026-08-20T05:44:12Z",
 "source":"abbild","started":"2026-08-20T05:47:29Z","uptimeSeconds":312}
```

Die Angaben kommen aus Bauparametern, die
[`.github/workflows/image.yml`](.github/workflows/image.yml) beim Bauen setzt.
Wer das Abbild **selbst** baut, kann sie mitgeben:

```bash
docker build \
  --build-arg LEITSTAND_COMMIT=$(git rev-parse HEAD) \
  --build-arg LEITSTAND_BRANCH=$(git rev-parse --abbrev-ref HEAD) \
  --build-arg LEITSTAND_COMMITTED=$(git show -s --format=%cI HEAD) \
  --build-arg LEITSTAND_BUILT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t leitstand .
```

Ohne diese Angaben läuft alles genauso, die Zeile sagt dann nur `◇ Dateistand`.
Ein **nicht ersetzter** Bauparameter wird verworfen statt angezeigt — eine falsche
Fassungsangabe wäre beim Ausrollen schlimmer als gar keine, weil man ihr glaubt.

## Vollständig verwaltbar

Unter **Verwaltung** wird der gesamte Bestand gepflegt — nichts davon braucht
einen Texteditor:

| Reiter | Was dort geht |
|---|---|
| **Systeme** | anlegen, ändern, löschen · Typ, Adresse, Beschreibung · Überwachung abschalten · API-Zugangsdaten hinterlegen · **Verbindung testen** mit Einzelschritten |
| **Standorte** | anlegen, ändern, löschen · Kürzel, Ort, Anschluss, WAN · **Hauptstandort** festlegen (Mitte der Topologie) |
| **Tunnel** | anlegen, ändern, löschen · Strecke, Interface, Transfernetz, Gegenstelle im Tunnel |
| **Startseite** | Gruppen anlegen, umbenennen, sortieren · Verknüpfungen hinzufügen, mit System verbinden, sortieren, löschen |
| **Schwellwerte** | Intervall, Zeitlimit, Fehlschläge bis Rot, „langsam“, Zertifikatsfristen, Verlaufslänge, ICMP |

Alles landet in derselben `inventory.yaml`, die sich auch von Hand bearbeiten
lässt; vor jedem Schreiben wird eine Sicherung als `.bak` daneben abgelegt.
Nach einer Änderung von Hand: *Bestand neu einlesen*.

## Proxmox hinzufügen

In der Oberfläche: **Verwaltung → + System**

1. Kennung (muss dem **Knotennamen im Cluster** entsprechen, z. B. `pve-hq-01`),
   Typ *Proxmox VE*, Standort, IP-Adresse
2. Zugangsdaten: Benutzer `leitstand@pve`, Token-ID `ro`, Geheimnis
3. **Verbindung testen** — zeigt jeden Schritt einzeln: ICMP, Port, TLS und den
   API-Aufruf samt Version. Schlägt etwas fehl, steht dabei, woran es liegt.
4. Speichern — der Bestand wird nach `inventory.yaml` geschrieben (Sicherung als
   `inventory.yaml.bak`), das Geheimnis nach `secrets.json` mit Rechten `0600`.

Das Token vorher in Proxmox anlegen unter
`Datacenter → Permissions → API Tokens`, dazu dem Benutzer die Rolle
`PVEAuditor` auf `/` mit Vererbung geben. **Nur lesend** — der Leitstand
schreibt nichts.

## Bedienung

| Eingabe | Wirkung |
|---|---|
| `⌘K` / `Strg+K` | Kommandopalette: Sprung zu Host, Standort, Tunnel, Störung, Link |
| `1` – `9` | Ansicht wechseln |
| `Esc` | Inspector, Formular oder Palette schließen |
| Klick auf Zeile/Kachel | Inspector rechts mit Details und Aktionen |
| Kopfleiste `HQ RZ …` | Standortfilter über alle Ansichten |
| „Nur Probleme" | blendet alles Grüne aus |
| `◐` | Hell/Dunkel |

## Aufbau

```
Dockerfile                Abbild mit Dienst und Oberfläche
docker-compose.yml        Stack für Portainer
.env                      Port, Zeitzone, Ablageort, Abbild-Tag
.github/workflows/        baut das Abbild bei jedem Push auf main

server/
  inventory.yaml          Beispielbestand — Vorlage für den ersten Start
  src/probe.js            ICMP, TCP, TLS-Restlaufzeit, DNS, HTTP
  src/inventory.js        Laden, Prüfen, Zurückschreiben (mit Sicherung)
  src/engine.js           Ampeln, Verlauf, Störungen, Standort-Bündelung
  src/collectors/proxmox.js   VE, Backup Server, Mail Gateway
  src/secrets.js          Zugangsdaten, 0600, nach außen nur maskiert
  src/api.js              Zustand in der Form, die die Oberfläche erwartet
  src/version.js          welche Fassung läuft: Abbild, Arbeitsbaum oder Dateistand
  src/server.js           HTTP, SSE, Verwaltungs-Schnittstelle
  test/                   94 Tests, u. a. gegen einen nachgebauten Proxmox

ui/                       Die Oberfläche, vom Dienst ausgeliefert
  assets/live.js          Brücke zum Server: Erstabruf, SSE, Wiederverbinden
  assets/app.js           Zustand, Ansichten, Inspector, Verwaltung
  assets/examples.js      je ein Muster für das, was noch nicht angebunden ist

ARCHITECTURE.md           Zielarchitektur und Ausbaustufen
docs/DATA-SOURCES.md      je System: Zugang, Endpunkte, Kennzahlen, Mail-Alarme
```

## Tests

```bash
cd server && npm test     # 94 Tests
```

Geprüft wird gegen echte offene und geschlossene Ports sowie gegen einen
nachgebauten Proxmox-Endpunkt (`test/fake-proxmox.js`), der auch 401 und 403
richtig beantwortet. Dadurch lässt sich der Proxmox-Weg vollständig prüfen,
ohne einen echten Cluster anzufassen.

`test/ui.test.js` zeichnet die Oberfläche ohne Browser: die Ansichten sind reine
Funktionen von Zustand nach HTML, also lassen sie sich mit einer echten
Serverantwort füttern und einzeln prüfen. Damit fällt auf, was sonst erst im
Betrieb auffiele — ein `NaN` in einer Summe über unbekannte Werte, eine Division
durch null bei leerem Bestand, ein Beispiel in einer Ansicht, die messen kann.

## Gestaltung

Dunkel als Grundzustand, weil das Werkzeug dauerhaft auf einem Zweitbildschirm
läuft. **Die einzige laute Farbe ist ein Problem:** Chrome und Akzent bleiben
zurückhaltend, gesättigtes Rot, Amber und Grün sind ausschließlich für Zustände
reserviert. Kanten sind eckig (2 px) — Rack-Vokabular. Schrift: Archivo für
Überschriften, IBM Plex Sans für Fließtext, IBM Plex Mono für alles, was
ausgerichtet gelesen wird. Ein helles Thema ist vollständig mitgeführt.

## Nächste Schritte

**Beim Einrichten:**

1. Unter *Verwaltung → Standorte* die eigenen Standorte anlegen und den
   Hauptstandort setzen
2. Unter *Verwaltung → Systeme* die Beispiele durch die echten Geräte ersetzen —
   Kennung, Typ, IP genügen, die Prüfungen leiten sich daraus ab
3. Für Proxmox die Token hinterlegen und *Verbindung testen* — danach sind
   Compute-Ansicht und Speicherbelegung echt
4. Tunnel eintragen (Gegenstelle im Transfernetz) und die Startseite befüllen

**Am Werkzeug:**

5. OPNsense-Sammler: Version, Zustandstabelle, CARP, HAProxy und
   **WireGuard-Handshake** (ergänzt die Messung durch den Tunnel, ersetzt sie nicht)
6. Alarm-Postfach anbinden (IMAP IDLE + Regelwerk)
7. **Push-Kanäle und Totmannschalter** — solange die fehlen, muss jemand hinsehen
