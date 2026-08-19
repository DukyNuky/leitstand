# Leitstand

Zentrale Schaltstelle für ein verteiltes Heimnetz: Startseite, Ampelwand und
Störungsübersicht in einem Werkzeug. Dieses Repository enthält einen
**klickbaren Entwurf** (HTML/CSS/JS, kein Build nötig) sowie die Zielarchitektur
für die spätere Umsetzung.

> Alle angezeigten Werte sind erfunden. Der Entwurf ruft nichts ab und sendet nichts.

## Ansehen

```bash
git clone git@github.com:DukyNuky/leitstand.git
cd leitstand
xdg-open mockup/index.html          # oder: python3 -m http.server 8080
```

Einzeldatei zum Weitergeben bauen:

```bash
node build.mjs                       # -> dist/leitstand.html
```

## Bedienung

| Eingabe | Wirkung |
|---|---|
| `⌘K` / `Strg+K` | Kommandopalette: Sprung zu Host, Standort, Tunnel, Störung, Link |
| `1` – `9` | Ansicht wechseln |
| `Esc` | Inspector oder Palette schließen |
| Klick auf Zeile/Kachel | Inspector rechts mit Details und Aktionen |
| Kopfleiste `HQ RZ ELT BÜR FH` | Standortfilter über alle Ansichten |
| „Nur Probleme“ | blendet alles Grüne aus |
| `◐` | Hell/Dunkel |

Nach etwa 25 Sekunden trifft absichtlich eine kritische Alarm-Mail ein. Damit
lässt sich der ganze Weg **Gerät → Postfach → Regel → Störung → Ampel** an einem
Beispiel durchklicken.

## Was der Entwurf abdeckt

- **Lagebild** — Sammelalarm über alles, offene Störungen nach Schwere, Ereignisstrom, Standortkacheln
- **Standorte** — Topologie (HQ als Zentrum, Außenstandorte per WireGuard), Anbindung und Systemliste je Standort
- **Compute** — 6× Proxmox VE mit CPU/RAM/Speicher, TrueNAS, 2× PBS, 4× Portainer, Sicherungsaufträge der letzten 24 h
- **Netz & Proxy** — 4× OPNsense (inkl. CARP-Paar) und 3× pfSense mit Version, Zustandstabelle, Durchsatz; HAProxy-Backends einzeln
- **VPN-Tunnel** — Site-to-Site-Strecken mit Handshake-Alter, Verlust und Latenzverlauf, Verbindungsmatrix, Road-Warrior-Peers
- **Dienste** — 3× AdGuard, Mailcow, Proxmox Mail Gateway, Home Assistant, Zertifikatsablauf
- **Alarm-Postfach** — Posteingang mit Rohtext, Auswerteregeln, Annahme- und Versandkonfiguration
- **Startseite** — Linkwand, jede Kachel mit dem Zustand des dahinterliegenden Systems
- **Einstellungen** — Datenquellen und Zugangsart, Schwellwerte, Betrieb des Leitstands selbst

## Aufbau

```
mockup/index.html          Gerüst
mockup/assets/styles.css   Token-System (Dark-first, Light-Theme, Ampelfarben)
mockup/assets/data.js      Beispielbestand — Struktur = geplantes API-Schema
mockup/assets/app.js       Zustand, Ansichten, Inspector, Palette
build.mjs                  erzeugt dist/leitstand.html (eine Datei, offline lauffähig)
ARCHITECTURE.md            Zielarchitektur der echten Umsetzung
docs/DATA-SOURCES.md       je System: Zugang, Endpunkt, Kennzahlen, Mail-Alarme
```

`data.js` ist absichtlich so geschnitten, dass es später gegen die Antwort von
`GET /api/state` getauscht werden kann, ohne die Ansichten anzufassen.

## Gestaltung

Dunkel als Grundzustand, weil das Werkzeug dauerhaft auf einem Zweitbildschirm
läuft. **Die einzige laute Farbe ist ein Problem:** Chrome und Akzent bleiben
zurückhaltend, gesättigtes Rot, Amber und Grün sind ausschließlich für Zustände
reserviert. Kanten sind eckig (2 px) statt abgerundet — Rack-Vokabular.
Schrift: Archivo für Überschriften, IBM Plex Sans für Fließtext, IBM Plex Mono
für alles, was ausgerichtet gelesen wird (Hosts, IPs, Zeiten, Zahlen).
Ein helles Thema ist vollständig mitgeführt.

## Nächste Schritte

1. Rückmeldung zu Aufteilung und Umfang der Ansichten
2. `docs/DATA-SOURCES.md` gegen den echten Bestand abgleichen (Hostnamen, Netze, Standorte)
3. Sammler für Proxmox, OPNsense und WireGuard zuerst — sie decken den größten Teil ab
4. Alarm-Postfach anbinden, danach Push-Kanäle
