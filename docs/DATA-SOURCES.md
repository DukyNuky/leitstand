# Datenquellen

Je System: wie der Leitstand herankommt, was er liest und was das System von
sich aus per E-Mail meldet. Pfade sind gegen die jeweils installierte Version zu
prüfen — insbesondere bei OPNsense-Plugins ändern sie sich zwischen Releases.

## Proxmox VE — 6 Knoten

> **Gebaut** — `server/src/collectors/proxmox.js`. In der Oberfläche unter
> *Verwaltung → + System* anlegen; „Verbindung testen" prüft Erreichbarkeit und
> API in einem Zug und nennt bei 401/403 den wahrscheinlichen Grund.

| | |
|---|---|
| Zugang | API-Token, Rolle `PVEAuditor` (nur lesen), `Authorization: PVEAPIToken=leitstand@pve!ro=<uuid>` |
| Endpunkte | `/api2/json/cluster/resources`, `/api2/json/nodes/{node}/status`, `/api2/json/nodes/{node}/apt/update`, `/api2/json/cluster/status` (Quorum) |
| Kennzahlen | CPU, RAM, Speicher je Storage, Laufzeit, Cluster-Quorum · **je Knoten** Kernel, `pve-manager`-Fassung, Kerne/Sockel/Modell, Last, Wurzeldateisystem, Auslagerung, ausstehende Pakete mit Paketnamen · **je Gast** Name, VMID, Art, Zustand, CPU, RAM, Platte, Kerne, Laufzeit, Tags |
| Ampel | RAM ab `ram_warn` gelb, ab `ram_crit` rot · Storage ab `disk_warn`/`disk_crit` · Knoten ohne Quorum → rot · ausstehende Pakete: **Notiz, keine Ampel** |
| Schwellwerte | global in den Einstellungen, je System über `schwellen:` überschreibbar — für Hosts, die bekanntermaßen voll laufen |
| Rechte | Der Paketstand hängt an `Sys.Audit` auf `/nodes/{node}`. Fehlt es, meldet der Sammler „unbekannt" statt „keine offen" — eine ruhige Null wäre hier die gefährlichere Auskunft |
| Meldet per Mail | `Datacenter → Notifications`: SMTP-Ziel `leitstand` anlegen, vzdump-Berichte und Fencing-Ereignisse dorthin |

Ein Token reicht für den ganzen Cluster; die Standalone-Knoten brauchen je eines.

## Proxmox Backup Server — 2 Instanzen

> **Gebaut** — meldet fehlgeschlagene Verify-, GC- und Sync-Aufträge der letzten
> 24 Stunden als kritische Störung.

| | |
|---|---|
| Zugang | API-Token, Rolle `Audit` auf `/` mit Propagate, Port 8007, `Authorization: PBSAPIToken=leitstand@pbs!ro:<uuid>` — **Doppelpunkt** vor dem Geheimnis, nicht `=` wie bei VE und PMG |
| Rechte | `Audit` deckt beides ab: `Datastore.Audit` für die Belegung *und* `Sys.Audit` auf `/system/tasks` für die Aufgabenliste. `DatastoreAudit` allein reicht **nicht** — die Belegung käme an, die fehlgeschlagenen Aufträge blieben unsichtbar. Die Berechtigung gehört auf die **Token-ID**: PBS schneidet die Rechte des Tokens mit denen des Benutzers, eigene ACL-Einträge für das Token sind Pflicht |
| Endpunkte | `/api2/json/status/datastore-usage`, `/api2/json/nodes/localhost/tasks?running=0`, `/api2/json/admin/datastore/{store}/snapshots` |
| Kennzahlen | Belegung je Datastore, letzter erfolgreicher Lauf, fehlgeschlagene Verify-/GC-/Sync-Aufträge, Alter der jüngsten Sicherung |
| Ampel | kein Erfolg in 26 h → rot · fehlgeschlagener Verify → rot · Belegung > 85 % → gelb |
| Meldet per Mail | Notification-Matcher für `verify`, `garbage collection`, `sync` — der Regelfall für eine Störung aus dem Postfach (Stufe 4) |

## Proxmox Mail Gateway

> **Gebaut** — Tagesstatistik über `/statistics/mail`.

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
| Endpunkte | `/api/core/firmware/status` (Version, ausstehende Updates), `/api/diagnostics/interface/get_interface_statistics` (ältere Fassungen: `getInterfaceStatistics`), `/api/interfaces/overview/export` (Verbindungszustand, Beschreibung, MTU — fehlt auf älteren Fassungen), `/api/diagnostics/firewall/pf_states`, `/api/wireguard/service/show`, HAProxy-Plugin für Backend-Zustände |
| Kennzahlen | Version + Updatestand, Zustandstabelle, **je Schnittstelle** Durchsatz ↓/↑ in Mbit/s, Pakete/s, übertragene Menge, Fehler und Verwürfe (Stand *und* Zuwachs), Kollisionen, Verbindungszustand, MTU; CARP-Rolle, WireGuard-Peers mit Handshake-Alter |
| Zähler, nicht Raten | Was hier zurückkommt, sind kumulative Zähler seit dem Neustart. Durchsatz gibt es erst aus der Differenz zweier Abfragen — davor ein Strich, keine Null; nach einem Zählerrücksetzer ebenso |
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

> **Gebaut** — `server/src/collectors/adguard.js`. Einen eigenen Nur-Lese-Zugang
> kennt AdGuard nicht: es sind dieselben Daten wie für die Oberfläche. Gelesen
> wird ausschließlich.

| | |
|---|---|
| Zugang | HTTP Basic-Auth, Benutzer und Passwort der Oberfläche |
| Endpunkte | `/control/status`, `/control/stats`, `/control/filtering/status`, `/control/dns_info` |
| Kennzahlen | Anfragen und Blockanteil über das eingestellte Statistikfenster, Ø Bearbeitungszeit, Filterlisten und Regelzahl, Upstreams, Fassung |
| Ohne Zugangsdaten | **Auflösung über UDP/53** — eine echte DNS-Anfrage an das System selbst, ohne API und ohne Passwort. Wird jedem AdGuard-Eintrag von Haus aus mitgegeben und gilt als *wesentlich*: ihr Ausfall ist eine Störung, kein Teilausfall neben einem grünen Port |
| Ampel | DNS-Dienst steht → rot · **UDP/53 antwortet nicht → nach `fail_threshold` Durchläufen rot** · Schutz oder Filterung abgeschaltet → gelb · Ø Bearbeitungszeit > 100 ms → gelb |
| Warum nicht `dns.Resolver` | Der Systemauflöser fällt bei zugemachtem UDP still auf TCP zurück und meldet Erfolg — während im Netz kein Gerät mehr auflöst. Gefragt wird deshalb mit einem selbst gebauten Paket. Kommt über UDP nichts, wird einmal TCP versucht, nicht als Rückfall, sondern als Befund: „über TCP antwortet er, UDP/53 kommt nicht durch" |
| Fallstrick | Steht der Prüfname selbst auf einer Filterliste, antwortet AdGuard mit NOERROR und null Sätzen. Das gilt nicht als aufgelöst — „er antwortet" ist nicht „er löst auf" —, und der wahrscheinlichste Grund steht in der Meldung. Ein anderer Name geht über `checks: [{ kind: dns, query: … }]` |
| Nicht abrufbar | **Upstream-Fehler** — die API führt dafür keine Zahl, weder im Zustand noch in der Statistik. Steht deshalb nirgends, statt geschätzt zu werden |
| Fallstrick | Das Statistikfenster ist einstellbar (24 h bis 90 Tage). Der Sammler summiert bei stündlichen Eimern die letzten 24 und benennt sonst den tatsächlichen Zeitraum — „Anfragen 24 h" an eine Zahl über 90 Tage zu schreiben wäre schlicht falsch |
| Fallstrick | `avg_processing_time` kommt je nach Fassung in Sekunden (dokumentiert) oder Millisekunden. Umgedeutet wird nur, was als Sekunde absurd wäre (> 5 s je Anfrage) |

## Portainer — 4 Instanzen

> **Gebaut** — `server/src/collectors/portainer.js`. Die Zahlen kommen aus der
> Momentaufnahme, die Portainer ohnehin je Umgebung zieht; die Containerliste
> wird nur geholt, um den Container zu **benennen**, der klemmt.

| | |
|---|---|
| Zugang | API-Token im Header `X-API-Key`, je Umgebung Rolle `read-only` |
| Endpunkte | `/api/system/status` (alt: `/api/status`), `/api/endpoints`, `/api/stacks`, `/api/endpoints/{id}/docker/containers/json?all=1` |
| Kennzahlen | Umgebungen erreichbar/gesamt, Stacks (aktiv/angehalten), Container laufend/gestoppt, `unhealthy`, Neustartschleifen, Exit 137, Docker-Fassung und Alter der Momentaufnahme je Umgebung |
| Ampel | keine Umgebung antwortet → rot · einzelne Umgebung still, `unhealthy`, Neustartschleife oder Exit 137 → gelb mit Namen des Containers |
| Nicht abrufbar | **Neustartzähler** — die Containerliste führt ihn nicht, er stünde nur in einem `inspect` je Container. Gemeldet wird stattdessen der Zustand `restarting` und der Exit-Code |
| Fallstrick | Fehlen die Rechte, liefert Portainer eine **leere** Liste statt einer Fehlermeldung. Der Sammler meldet das ausdrücklich als Rechteproblem — sonst stünde da eine ruhige Null, wo Dutzende Container laufen |

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

> **Gebaut** — `server/src/probe.js`.

Nicht jedes System liefert alles. Der Leitstand bringt eigene Prober mit:

1. **Erreichbarkeit** — ICMP und TCP-Port im eingestellten Takt, drei Fehlschläge bis rot
2. **TLS** — Restlaufzeit jedes HTTPS-Ziels, eigensignierte Zertifikate werden erkannt und nicht abgelehnt
3. **Tunnelgüte** — TCP/ICMP auf die Gegenstelle im Transfernetz, also durch den Tunnel hindurch
4. **DNS** — echte Auflösung über UDP/53 gegen die AdGuard-Instanzen; jedem
   AdGuard-Eintrag von Haus aus mitgegeben, ohne Zugangsdaten

Fehlt `ping` auf dem Host oder ist ICMP im Netz gesperrt, wird die Prüfung
übersprungen statt als Ausfall gewertet; die TCP-Prüfung trägt dann allein.

## Zugänge anlegen — Kurzfassung

```
Proxmox VE/PMG       Benutzer leitstand@pve, Rolle PVEAuditor auf / mit Vererbung, Token ohne Ablauf
Proxmox Backup       Benutzer leitstand@pbs, Rolle Audit auf / mit Propagate — auch für die Token-ID selbst
OPNsense             System → Access → Users → leitstand, Gruppe mit Lesezugriff, API-Key erzeugen
pfSense              eigener SSH-Schlüssel, Benutzer ohne Shell-Rechte darüber hinaus
AdGuard              zusätzlicher Benutzer in AdGuardHome.yaml (users), Benutzer + Passwort eintragen
Portainer            Benutzer leitstand, Rolle „read-only“ je Umgebung, Token unter My account → Access tokens
TrueNAS              Credentials → API Keys
Mailcow              Configuration → Access → API, „Read-Only“, Quell-IP einschränken
Home Assistant       Profil → Long-Lived Access Tokens
```

Alle Token gehören nach Vaultwarden, nicht in eine Datei neben den Container.
