# Zielarchitektur

Dieses Dokument beschreibt den Aufbau. **Stufe 1 ist gebaut und läuft**
(`server/`) — was davon steht und was noch fehlt, sagt die Tabelle ganz unten.

## Leitgedanken

1. **Nur lesen.** Jeder Zugang ist ein Konto ohne Schreibrechte. Steuerbefehle
   (Dienst neu starten, Tunnel neu aushandeln) kommen später und dann über einen
   getrennten, ausdrücklich freigeschalteten Pfad.
2. **Zwei Wege hinein.** Aktives Abfragen für Zustände, das Alarm-Postfach für
   alles, was sich nicht abfragen lässt. Beides mündet in dasselbe Ereignismodell.
3. **Der Leitstand darf nicht die einzige Instanz sein**, die weiß, dass etwas
   kaputt ist. Ein Totmannschalter meldet nach außen, wenn er selbst schweigt.
4. **Standort vor Gerät.** Fällt ein Standort aus, wird eine Meldung erzeugt —
   nicht zwölf. *(Gebaut: `Engine#rollup`. Sind alle überwachten Systeme eines
   Standorts gleichzeitig still, entsteht eine Standortmeldung; die
   Einzelmeldungen bleiben erhalten, werden aber als mitbetroffen geführt und
   nicht einzeln angezeigt.)*

5. **Kein erfundener Wert.** Was eine Stufe noch nicht wissen kann, steht auf
   `null` und wird als Strich angezeigt. Ein Platzhalterwert in einer
   Überwachung ist schlimmer als eine Lücke, weil man ihm glaubt.
   *(Gebaut: die Oberfläche hat keinen Beispielbestand mehr, auf den sie
   zurückfallen könnte. Antwortet der Dienst nicht, zeigt sie das statt
   irgendetwas; reißt der Zustandsstrom ab, werden die stehengebliebenen
   Werte als veraltet gekennzeichnet. Die wenigen Bereiche ohne Anbindung
   zeigen je ein Muster aus `ui/assets/examples.js`, sichtbar als
   **Beispiel** markiert und von einem Satz begleitet, was dort fehlt.)*

## Bausteine

```
   Proxmox / OPNsense / pfSense / TrueNAS / AdGuard / Portainer / Mailcow / HA
                  │  API, read-only                    │  SMTP
                  ▼                                    ▼
        ┌───────────────────┐                 ┌──────────────────┐
        │   Collector       │                 │  Mail-Ingest     │
        │  Go, ein Prozess  │                 │  IMAP IDLE       │
        │  pro Quelle ein   │                 │  + Regelwerk     │
        │  Poller           │                 └────────┬─────────┘
        └─────────┬─────────┘                          │
                  │        normalisierte Ereignisse    │
                  └──────────────┬─────────────────────┘
                                 ▼
                   ┌─────────────────────────────┐
                   │  Kern                       │
                   │  Zustand · Regeln · Alarme  │
                   │  Bündelung · Wartungsfenster│
                   └───┬───────────────┬─────────┘
                       │               │
          PostgreSQL   │               │   VictoriaMetrics
          (Bestand,    │               │   (Zeitreihen, 400 T)
           Ereignisse) │               │
                       ▼               ▼
                   ┌─────────────────────────────┐
                   │  API  GET /api/state        │
                   │       WS  /api/stream       │
                   └───────────┬─────────────────┘
                               ▼
                       Oberfläche (dieses Repo)
                               │
                               ▼
                  ntfy · Telegram · E-Mail · Signal
```

## Datenmodell (Kern)

```jsonc
// Host
{ "id":"pve-hq-01", "type":"pve", "site":"hq", "name":"pve-hq-01",
  "status":"ok|warn|crit|idle|info", "url":"https://…", "ip":"10.10.1.11",
  "version":"8.3.2", "metrics": { "cpu":34, "ram":61, "disk":47 },
  "note":null, "lastSeen":"2026-08-19T10:41:02Z" }

// Ereignis (aus Abfrage ODER Mail)
{ "id":"evt-…", "source":"poll|mail|api|webhook", "host":"pbs-hq-01",
  "rule":"mail.pbs.verify_failed", "sev":"crit", "title":"…", "detail":"…",
  "raw":"…", "ts":"…", "fingerprint":"pbs-hq-01/verify/nas-archive" }

// Störung = gebündelte Ereignisse mit gleichem fingerprint
{ "id":"INC-0411", "sev":"crit", "first":"…", "last":"…", "count":3,
  "ack":false, "ackBy":null, "silencedUntil":null }
```

`fingerprint` ist der Schlüssel gegen Alarmfluten: gleiche Ursache, gleiche
Störung, Zähler statt neuer Zeile.

## Zustandsermittlung

| Ampel | Bedeutung |
|---|---|
| grün | Wert innerhalb der Schwelle, letzte Abfrage frisch |
| gelb | Schwelle überschritten oder Abfrage veraltet (> 3 Intervalle) |
| rot | Ausfall, kritische Schwelle, oder Meldung mit Schwere „kritisch“ |
| grau | absichtlich unüberwacht (z. B. Laborinstanz) |

Schwellwerte stehen in der Oberfläche unter *Einstellungen → Schwellwerte* und
gehören in eine Konfigurationsdatei, nicht in den Code.

## Alarm-Postfach

Adresse `alarm@…`, hinter dem bestehenden Proxmox Mail Gateway — Spam wird nie
zugestellt. Der Ingest hält die Verbindung per IMAP IDLE offen, prüft jede
eingehende Nachricht gegen eine geordnete Regelliste und erzeugt daraus ein
Ereignis. Regeln bestehen aus Absender- und Betreffmuster, einer Zuordnung zum
Host und einer Einstufung.

Trifft keine Regel, wird die Mail **nicht verworfen**, sondern als
„ohne Regel“ sichtbar gemacht — samt Schaltfläche, aus genau dieser Nachricht
eine Regel zu erzeugen. So wächst das Regelwerk im Betrieb statt am Reißbrett.

Warum überhaupt Mail, wo es APIs gibt: smartd, ACME-Clients, vzdump-Berichte und
Herstellergeräte melden verlässlich per SMTP und sonst gar nicht. Das Postfach
ist der Auffangkanal für alles, was keine Schnittstelle hat.

## Betrieb

- Ein Container-Stack (Kern, Collector, Mail-Ingest, Postgres, VictoriaMetrics)
  auf `pve-hq-01`, ein kalter Zwilling auf `pve-rz-01`
- Erreichbar nur über WireGuard oder HAProxy mit Client-Zertifikat
- Anmeldung über den vorhandenen OIDC-Anbieter, Passkey bevorzugt
- API-Token liegen in Vaultwarden und werden zur Laufzeit geholt, nicht in
  einer `.env` abgelegt
- Totmannschalter: der Kern meldet sich minütlich bei einem externen
  Healthcheck; bleibt das aus, kommt eine Push-Nachricht

## Umsetzungsstand

| Stufe | Inhalt | Stand |
|---|---|---|
| 1 | Bestand als YAML, ICMP/TCP/TLS-Prober, Startseite mit Ampeln | **gebaut** |
| 1b | Verwaltung in der Oberfläche: Standorte, Systeme, Tunnel, Startseite, Schwellwerte, Zugangsdaten, Verbindungstest | **gebaut** |
| 1c | Standort-Bündelung, Quittieren, Stummschalten, Fortschreibung über Neustarts | **gebaut** |
| 2 | Proxmox VE + PBS + PMG anbinden | **gebaut** |
| 3 | OPNsense/pfSense inkl. WireGuard-Handshake | **OPNsense gebaut** — Fassung, Laufzeit, Last, Speicher, Platte, Durchsatz, Peers und Handshake am Tunnel; Zustandstabelle, CARP und pfSense offen |
| 4 | Alarm-Postfach mit Regelwerk | offen — die Ansicht erklärt den Weg und zeigt ein Beispiel |
| 5 | TrueNAS, AdGuard, Portainer, Mailcow, Home Assistant | offen — bislang nur Erreichbarkeit |
| 6 | Wartungsfenster, Zeitreihen-Detailseiten, **Push-Kanäle und Totmannschalter** | offen — ohne sie ist der Leitstand ein Bildschirm, kein Wecker |

### Was in Stufe 1 bewusst anders gelöst ist

**Tunnel: zwei Zeugen, nicht einer.** Der Leitstand misst *durch* den Tunnel —
jeder Tunnel bekommt in `inventory.yaml` eine `probe`-Adresse im Transfernetz.
Das braucht keinerlei Zugangsdaten und beantwortet die Frage, die zählt: trägt
die Strecke gerade?

Dazu darf ein Tunnel einen `peer` benennen — einen WireGuard-Peer auf einer
Firewall, die der Leitstand ausliest. Der liefert Handshake-Alter und
übertragene Menge. Beides zusammen ist mehr als jedes für sich: der Handshake
sagt, wann die Strecke zuletzt *stand*, die Messung, ob gerade etwas
hindurchkommt. Widersprechen sie sich — Antwort da, Handshake uralt —, dann
zeigt die Verknüpfung auf den falschen Peer, und genau das schreibt der Dienst
als Notiz an die Strecke, ohne die Ampel zu drehen.

Zugeordnet wird über den **öffentlichen Schlüssel**, nicht über den Namen: der
Schlüssel übersteht eine Umbenennung auf der Firewall. Ein Name greift nur als
Rückfall und nur, wenn er eindeutig ist — lieber kein Treffer als der falsche,
denn ein falscher meldete den Handshake eines fremden Geräts als den dieser
Strecke.

**Erreichbar, aber Abruf scheitert.** Ein System, das antwortet, dessen API-Zugang
aber abgelehnt wird, geht auf Gelb statt still ohne Kennzahlen dazustehen. Ein
falsch gesetztes Token ist sonst monatelang unsichtbar.
