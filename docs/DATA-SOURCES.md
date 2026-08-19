# Datenquellen

Je System: wie der Leitstand herankommt, was er liest und was das System von
sich aus per E-Mail meldet. Pfade sind gegen die jeweils installierte Version zu
prüfen — insbesondere bei OPNsense-Plugins ändern sie sich zwischen Releases.

## Proxmox VE — 6 Knoten

| | |
|---|---|
| Zugang | API-Token, Rolle `PVEAuditor` (nur lesen), `Authorization: PVEAPIToken=leitstand@pve!ro=<uuid>` |
| Endpunkte | `/api2/json/cluster/resources?type=vm`, `/api2/json/nodes/{node}/status`, `/api2/json/nodes/{node}/storage`, `/api2/json/cluster/status` (Quorum) |
| Kennzahlen | CPU, RAM, Speicher je Storage, Laufzeit, Gästezahl, Version, Cluster-Quorum |
| Ampel | RAM > 85 % über 15 min → gelb · Storage > 90 % → rot · Knoten ohne Quorum → rot |
| Meldet per Mail | `Datacenter → Notifications`: SMTP-Ziel `leitstand` anlegen, vzdump-Berichte und Fencing-Ereignisse dorthin |

Ein Token reicht für den ganzen Cluster; die Standalone-Knoten brauchen je eines.

## Proxmox Backup Server — 2 Instanzen

| | |
|---|---|
| Zugang | API-Token `PBSAPIToken=…`, Rolle `DatastoreAudit`, Port 8007 |
| Endpunkte | `/api2/json/status/datastore-usage`, `/api2/json/nodes/localhost/tasks?running=0`, `/api2/json/admin/datastore/{store}/snapshots` |
| Kennzahlen | Belegung je Datastore, letzter erfolgreicher Lauf, fehlgeschlagene Verify-/GC-/Sync-Aufträge, Alter der jüngsten Sicherung |
| Ampel | kein Erfolg in 26 h → rot · fehlgeschlagener Verify → rot · Belegung > 85 % → gelb |
| Meldet per Mail | Notification-Matcher für `verify`, `garbage collection`, `sync` — der Regelfall für die Störung im Entwurf |

## Proxmox Mail Gateway

| | |
|---|---|
| Zugang | API-Token `PMGAPIToken=…`, Port 8006 |
| Endpunkte | `/api2/json/statistics/mail`, `/api2/json/nodes/{node}/status`, `/api2/json/quarantine/spam` |
| Kennzahlen | Ein-/Ausgang 24 h, Spam- und Virenanteil, Quarantänegröße, Queue |
| Ampel | Queue > 25 → gelb · Virenfund → gelb (Information, kein Notfall) |
| Meldet per Mail | Tagesbericht |

## OPNsense — 4 Geräte

| | |
|---|---|
| Zugang | API Key/Secret je Gerät, eigener Benutzer mit lesenden Rechten (Basic-Auth über HTTPS) |
| Endpunkte | `/api/core/firmware/status` (Version, ausstehende Updates), `/api/diagnostics/interface/getInterfaceStatistics`, `/api/diagnostics/firewall/pf_states`, `/api/wireguard/service/show`, HAProxy-Plugin für Backend-Zustände |
| Kennzahlen | Version + Updatestand, Zustandstabelle, Durchsatz je Interface, CARP-Rolle, WireGuard-Peers mit Handshake-Alter |
| Ampel | Versionsabweichung im CARP-Paar → gelb · Zustandstabelle > 80 % → gelb · Backend ohne aktiven Server → rot |
| Meldet per Mail | `System → Settings → Notifications` (SMTP): Konfigurationsänderungen, ACME-Erneuerungen, CARP-Wechsel |

Der HA-Verbund liefert zwei Sichten: MASTER und BACKUP werden getrennt abgefragt,
sonst bleibt eine schleichende Config-Sync-Abweichung unsichtbar.

## pfSense — 3 Geräte

| | |
|---|---|
| Zugang | CE hat keine offizielle REST-Schnittstelle. Zwei Wege: **(a)** SSH mit eigenem Schlüssel und `pfSsh.php playback` bzw. `pfctl -si`, `wg show all dump` — robust, versionsunabhängig; **(b)** Paket `pfSense-pkg-API` (Fremdprojekt), bequemer, aber zusätzliche Angriffsfläche |
| Empfehlung | (a) für die Bestandsgeräte; der Prober braucht ohnehin SSH für `wg show` |
| Kennzahlen | Version, Zustandstabelle, Interface-Zähler, WireGuard-Peers, Gateway-Status |
| Meldet per Mail | `System → Advanced → Notifications`, zusätzlich das Paket *Notes/Status Email* für Gateway-Alarme |

## WireGuard — alle 7 Firewalls

Wird nicht getrennt angebunden, sondern über die jeweilige Firewall gelesen
(`/api/wireguard/service/show` bzw. `wg show all dump`).

| | |
|---|---|
| Kennzahlen | letzter Handshake je Peer, RX/TX, Endpunkt, erlaubte Netze |
| Zusätzlich | eigener ICMP-Test über den Tunnel für Latenz und Verlust — der Handshake allein sagt nichts über die Nutzbarkeit |
| Ampel | Handshake > 180 s → gelb · > 600 s → rot · Verlust > 2 % im 5-min-Mittel → gelb |
| Endgeräte | Peers ohne Handshake seit > 12 h gelten als ruhend, nicht als gestört |

## AdGuard Home — 3 Instanzen

| | |
|---|---|
| Zugang | HTTP Basic-Auth, eigener Benutzer |
| Endpunkte | `/control/status`, `/control/stats`, `/control/querylog?limit=…` |
| Kennzahlen | Anfragen 24 h, Blockanteil, Ø Antwortzeit, Upstream-Fehler, Top-Domains |
| Ampel | Ø Antwortzeit > 100 ms → gelb · Instanz nicht erreichbar → rot (DNS-Ausfall wirkt sofort im ganzen Netz) |

## Portainer — 4 Instanzen

| | |
|---|---|
| Zugang | API-Token im Header `X-API-Key`, Benutzer mit Leserecht |
| Endpunkte | `/api/endpoints`, `/api/stacks`, `/api/endpoints/{id}/docker/containers/json?all=1` |
| Kennzahlen | Stacks, Container gesamt/laufend, `unhealthy`, Neustartzähler, veraltete Images |
| Ampel | Container in Restart-Schleife (> 3 Neustarts in 10 min) → gelb · Exit 137 (OOM) → gelb mit Hinweis auf Speichergrenze |

## TrueNAS SCALE

| | |
|---|---|
| Zugang | API-Key, `Authorization: Bearer …`, REST v2.0 (neuere Versionen zusätzlich JSON-RPC über WebSocket) |
| Endpunkte | `/api/v2.0/pool`, `/api/v2.0/alert/list`, `/api/v2.0/disk`, `/api/v2.0/replication` |
| Kennzahlen | Pool-Zustand und Belegung, Scrub-Alter, SMART-Auffälligkeiten, Replikationsläufe |
| Ampel | Pool nicht `ONLINE` → rot · SMART-Fehler → gelb · Scrub älter als 35 Tage → gelb |
| Meldet per Mail | `Alert Services → E-Mail`, Stufe ab `WARNING`; zusätzlich smartd auf allen Hosts |

## Mailcow

| | |
|---|---|
| Zugang | API-Key mit Leserecht, Header `X-API-Key` |
| Endpunkte | `/api/v1/get/mailq/all`, `/api/v1/get/domain/all`, `/api/v1/get/status/containers`, `/api/v1/get/status/vmail` |
| Kennzahlen | Warteschlange, Domains und Postfächer, Speicher, Containerzustand, Rspamd-Rate |
| Zusätzlich | eigene RBL-Prüfung der ausgehenden IP (Spamhaus, UCEPROTECT, Barracuda) — kommt von keiner API des Systems selbst |
| Ampel | Queue > 25 → gelb, > 100 → rot · RBL-Eintrag → gelb · Zertifikat < 14 Tage → rot |
| Meldet per Mail | Watchdog-Benachrichtigungen an `alarm@` |

## Home Assistant

| | |
|---|---|
| Zugang | Long-Lived Access Token, `Authorization: Bearer …` |
| Endpunkte | `/api/states`, `/api/config`, `/api/error_log` |
| Kennzahlen | Entitäten gesamt und `unavailable`, Automationen, Integrationen, Version |
| Ampel | nicht verfügbare Entitäten sind meist Information, keine Störung — Ausnahme: gruppierte Ausfälle hinter einem Zigbee-Router |

## Ohne Schnittstelle — nur E-Mail

| Quelle | Meldet | Regel |
|---|---|---|
| `smartd` auf allen Hosts | Sektorfehler, Temperatur | `from ~ /^smartd@/` → gelb |
| ACME-Clients | anstehende Erneuerung, Fehlschlag | Betreff `certificate .*(renewal\|expir)` → gelb |
| UPS (NUT/apcupsd) | Netzausfall, Akkustand | Betreff `On battery\|Power failure` → rot |
| UniFi-Controller | Port down, AP offline | Absenderliste, Betreffmuster je Ereignis |
| Drucker, NAS-Fremdgeräte | was auch immer sie schicken | landen als „ohne Regel“ im Postfach und werden dort eingeordnet |

## Eigene Prüfungen

Nicht jedes System liefert alles. Der Leitstand bringt drei eigene Prober mit:

1. **Erreichbarkeit** — ICMP und TCP-Port alle 15 s, drei Fehlschläge bis rot
2. **TLS** — Restlaufzeit aller veröffentlichten Zertifikate, täglich
3. **Tunnelgüte** — ICMP über jeden Site-to-Site-Tunnel für Latenz und Verlust

## Zugänge anlegen — Kurzfassung

```
Proxmox VE/PBS/PMG   Benutzer leitstand@pve, Rolle PVEAuditor/DatastoreAudit, Token ohne Ablauf
OPNsense             System → Access → Users → leitstand, Gruppe mit Lesezugriff, API-Key erzeugen
pfSense              eigener SSH-Schlüssel, Benutzer ohne Shell-Rechte darüber hinaus
AdGuard              zusätzlicher Benutzer in der YAML-Konfiguration
Portainer            Benutzer leitstand, Rolle „read-only“ je Umgebung, Token
TrueNAS              Credentials → API Keys
Mailcow              Configuration → Access → API, „Read-Only“, Quell-IP einschränken
Home Assistant       Profil → Long-Lived Access Tokens
```

Alle Token gehören nach Vaultwarden, nicht in eine Datei neben den Container.
