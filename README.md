# Leitstand

Zentrale Schaltstelle für ein verteiltes Heimnetz: Startseite, Ampelwand und
Störungsübersicht in einem Werkzeug.

Das Repository enthält zwei Dinge:

1. **Ein laufendes Werkzeug** (`server/`) — prüft Erreichbarkeit, Antwortzeiten,
   Zertifikate und VPN-Tunnel, liest Proxmox über die API aus und wird über eine
   **Admin-Oberfläche** gepflegt. Kein Build, eine einzige Abhängigkeit.
2. **Den klickbaren Entwurf** (`mockup/`) — zeigt mit Beispieldaten, wohin es
   geht, und läuft auch ohne Server per Doppelklick.

Dieselbe Oberfläche bedient beides: läuft der Dienst, zeigt sie echte Werte;
läuft er nicht, fällt sie auf den Beispielbestand zurück.

## Loslegen

```bash
cd server
npm install
npm start                     # http://localhost:8080
```

Ohne weitere Einstellungen wird `server/inventory.yaml` geprüft — **darin stehen
geratene Hostnamen und Netze aus der ersten Beschreibung.** Entweder direkt
anpassen oder gleich in der Oberfläche unter **Verwaltung** zurechtziehen.

Eigener Bestand an anderer Stelle:

```bash
LEITSTAND_INVENTORY=/pfad/zu/inventory.yaml PORT=8080 node src/server.js
```

## Als Stack in Portainer

**Portainer → Stacks → Add stack → Web editor**, den Inhalt von
[`docker-compose.yml`](docker-compose.yml) hineinkopieren, *Deploy the stack*.
Fertig — es wird nichts gebaut, das Abbild kommt aus der GitHub Container
Registry und enthält Dienst und Oberfläche.

Beim ersten Start ist das Volume leer. Der Leitstand legt dann selbst einen
Bestand an (aus der im Abbild mitgelieferten Vorlage) und läuft sofort; alles
Weitere wird unter *Verwaltung* gepflegt. Im Volume liegen danach:

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
| **Verwaltung** | Systeme, Standorte, Tunnel und Schwellwerte in der Oberfläche pflegen |

Alles andere (OPNsense, pfSense, TrueNAS, AdGuard, Portainer, Mailcow, Home
Assistant) wird bisher nur auf Erreichbarkeit geprüft. Die Oberfläche zeigt für
noch unbekannte Kennzahlen einen Strich — **nie einen erfundenen Wert.**

## Proxmox hinzufügen

In der Oberfläche: **Verwaltung → + System**

1. Kennung (`pve-hq-01` — muss dem Knotennamen im Cluster entsprechen), Typ
   *Proxmox VE*, Standort, IP-Adresse
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
.github/workflows/        baut das Abbild bei jedem Push auf main

server/
  inventory.yaml          Bestand — Vorlage für den ersten Start
  src/probe.js            ICMP, TCP, TLS-Restlaufzeit, DNS, HTTP
  src/inventory.js        Laden, Prüfen, Zurückschreiben (mit Sicherung)
  src/engine.js           Ampeln, Verlauf, Störungen, Standort-Bündelung
  src/collectors/proxmox.js   VE, Backup Server, Mail Gateway
  src/secrets.js          Zugangsdaten, 0600, nach außen nur maskiert
  src/api.js              Zustand in der Form, die die Oberfläche erwartet
  src/server.js           HTTP, SSE, Verwaltungs-Schnittstelle
  test/                   58 Tests, u. a. gegen einen nachgebauten Proxmox
  Dockerfile, docker-compose.yml

mockup/                   Die Oberfläche (auch vom Server ausgeliefert)
  assets/live.js          Brücke zum Server, mit Rückfall auf Beispieldaten
  assets/data.js          Beispielbestand
  assets/app.js           Zustand, Ansichten, Inspector, Verwaltung
build.mjs                 baut dist/leitstand.html (eine Datei, offline lauffähig)

ARCHITECTURE.md           Zielarchitektur und Ausbaustufen
docs/DATA-SOURCES.md      je System: Zugang, Endpunkte, Kennzahlen, Mail-Alarme
```

## Tests

```bash
cd server && npm test     # 58 Tests
```

Geprüft wird gegen echte offene und geschlossene Ports sowie gegen einen
nachgebauten Proxmox-Endpunkt (`test/fake-proxmox.js`), der auch 401 und 403
richtig beantwortet. Dadurch lässt sich der Proxmox-Weg vollständig prüfen,
ohne einen echten Cluster anzufassen.

## Gestaltung

Dunkel als Grundzustand, weil das Werkzeug dauerhaft auf einem Zweitbildschirm
läuft. **Die einzige laute Farbe ist ein Problem:** Chrome und Akzent bleiben
zurückhaltend, gesättigtes Rot, Amber und Grün sind ausschließlich für Zustände
reserviert. Kanten sind eckig (2 px) — Rack-Vokabular. Schrift: Archivo für
Überschriften, IBM Plex Sans für Fließtext, IBM Plex Mono für alles, was
ausgerichtet gelesen wird. Ein helles Thema ist vollständig mitgeführt.

## Nächste Schritte

1. `inventory.yaml` auf den echten Bestand ziehen (Hostnamen, IPs, Tunnelnetze)
2. Proxmox-Token für die sechs Knoten hinterlegen — dann sind Compute-Ansicht
   und Backup-Status echt
3. OPNsense-Sammler: Version, Zustandstabelle, CARP und **WireGuard-Handshake**
   (ersetzt die Ersatzmessung durch den Tunnel)
4. Alarm-Postfach anbinden (IMAP IDLE + Regelwerk), danach Push-Kanäle
