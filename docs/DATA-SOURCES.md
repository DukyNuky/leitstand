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
| Endpunkte | `/api2/json/cluster/resources`, `/api2/json/nodes/{node}/status`, `/api2/json/nodes/{node}/apt/update`, `/api2/json/cluster/status` (Quorum), `/api2/json/cluster/backup` (eingerichtete Aufträge), `/api2/json/nodes/{node}/tasks?typefilter=vzdump&limit=100` (was davon gelaufen ist) |
| Kennzahlen | CPU, RAM, Speicher je Storage, Laufzeit, Cluster-Quorum · **je Knoten** Kernel, `pve-manager`-Fassung, Kerne/Sockel/Modell, Last, Wurzeldateisystem, Auslagerung, ausstehende Pakete mit Paketnamen · **je Gast** Name, VMID, Art, Zustand, CPU, RAM, Platte, Kerne, Laufzeit, Tags · **je Sicherungsauftrag** Zeitplan, Ziel, Umfang, nächster Lauf, letzter Lauf mit Ausgang, letzter erfolgreicher und letzter fehlgeschlagener |
| Zuordnung | Was eingerichtet ist, steht in `/cluster/backup`; was gelaufen ist, in den `vzdump`-Aufgaben. Zusammen kommen sie nur, soweit Proxmox es zulässt: bei einem geplanten Lauf trägt die Aufgabe je nach Fassung die Kennung des Auftrags — und je nach Fassung nicht. Steht sie da, gehören die Zeitpunkte dem Auftrag (`quelle: "auftrag"`); sonst gelten die aller `vzdump`-Läufe des Knotens (`quelle: "knoten"`), und die Zeile weist das aus. Ein Auftrag ohne Knotenbindung läuft auf jedem Knoten für dessen eigene Gäste und steht deshalb bei jedem |
| Ampel | RAM ab `ram_warn` gelb, ab `ram_crit` rot · Storage ab `disk_warn`/`disk_crit` · Knoten ohne Quorum → rot · **letzter Lauf eines aktiven Sicherungsauftrags fehlgeschlagen → rot**, `WARNINGS: n` → gelb; ein *überstandener* Fehlschlag bleibt sichtbar, ohne zu alarmieren, und ein nie gelaufener Auftrag ist eine Notiz · ausstehende Pakete: **Notiz, keine Ampel** |
| Schwellwerte | global in den Einstellungen, je System über `schwellen:` überschreibbar — für Hosts, die bekanntermaßen voll laufen |
| Rechte | Der Paketstand hängt an `Sys.Audit` auf `/nodes/{node}`. Fehlt es, meldet der Sammler „unbekannt" statt „keine offen" — eine ruhige Null wäre hier die gefährlichere Auskunft |
| Meldet per Mail | `Datacenter → Notifications`: SMTP-Ziel `leitstand` anlegen, vzdump-Berichte und Fencing-Ereignisse dorthin |

Ein Token reicht für den ganzen Cluster; die Standalone-Knoten brauchen je eines.

## Proxmox Backup Server — 2 Instanzen

> **Gebaut** — jeder Datastore einzeln, dazu fehlgeschlagene Verify-, GC- und
> Sync-Aufträge der letzten 24 Stunden als kritische Störung.

| | |
|---|---|
| Zugang | API-Token, Rolle `Audit` auf `/` mit Propagate, Port 8007, `Authorization: PBSAPIToken=leitstand@pbs!ro:<uuid>` — **Doppelpunkt** vor dem Geheimnis, nicht `=` wie bei VE |
| Rechte | `Audit` deckt beides ab: `Datastore.Audit` für die Belegung *und* `Sys.Audit` auf `/system/tasks` für die Aufgabenliste. `DatastoreAudit` allein reicht **nicht** — die Belegung käme an, die fehlgeschlagenen Aufträge blieben unsichtbar. Die Berechtigung gehört auf die **Token-ID**: PBS schneidet die Rechte des Tokens mit denen des Benutzers, eigene ACL-Einträge für das Token sind Pflicht |
| Endpunkte | `/api2/json/status/datastore-usage`, `/api2/json/admin/datastore`, `/api2/json/nodes/localhost/tasks?limit=60&errors=1` **und** `?limit=200`. Zwei Aufgabenlisten, weil sie zwei Fragen beantworten: die gefilterte findet Fehler auch dann, wenn hundert geglückte Sicherungen davorstehen; die ungefilterte sagt, wann ein Datastore zuletzt gesichert, aufgeräumt und geprüft wurde |
| Kennzahlen | je Datastore: Belegung, belegt/frei/gesamt in Bytes, `estimated-full-date` (PBS' eigene Schätzung, wann er voll ist), letzte Sicherung, letztes Aufräumen, letzte Prüfung — je mit Erfolg oder Fehlschlag —, Kommentar und Wartungsmodus. Dazu, wie bisher: der vollste Datastore als Kennzahl des Systems, fehlgeschlagene Aufträge, letzter Erfolg |
| Zuordnung | PBS hängt den Datastore vor die Kennung der Aufgabe (`main:host/web-01/…`). Alles vor dem ersten Doppelpunkt ist der Datastore — **aber nur, wenn es auch einer ist**: eine ältere Sicherung namens `vm/101` wird sonst zum erfundenen Datastore |
| Ampel | fehlgeschlagener Auftrag in 24 h → rot · Belegung über der Grenze des Systems (Vorgabe 90 %) → rot, ab 80 % gelb · laut PBS in ≤ 14 Tagen voll → gelb. Ohne `estimated-full-date` wird **nichts** hochgerechnet |
| Meldet per Mail | Notification-Matcher für `verify`, `garbage collection`, `sync` — der Regelfall für eine Störung aus dem Postfach (Stufe 4) |

## Proxmox Mail Gateway

> **Gebaut** — `server/src/collectors/pmg.js`, eigener Sammler mit eigener
> Ansicht *Mail-Gateway*.

> [!IMPORTANT]
> **PMG kennt keine API-Token.** Die API-Dokumentation weist sie an jedem
> Endpunkt als erlaubt aus (`allowtoken: 1`) — die Beschreibung wird aus
> derselben Vorlage erzeugt wie die von Proxmox VE. Der HTTP-Dienst weist sie
> aber vor jeder Rechteprüfung ab:
> `die "API tokens not implemented\n" if $api_token;` (`src/PMG/HTTPServer.pm`).
> Wer eine Token-Kopfzeile schickt, bekommt eine wortlose 401 — und sucht
> danach am falschen Ende. Deshalb steht dieser Sammler nicht in `proxmox.js`.

| | |
|---|---|
| Zugang | Benutzer und Passwort gegen `POST /api2/json/access/ticket`, danach das Ticket als Cookie `PMGAuthCookie`. Es gilt **zwei Stunden**; erneuert wird nach 90 Minuten und bei einer 401 sofort. Port 8006 |
| Fallstrick 2 | Der Rumpf dieses POST **muss seine Länge ansagen**. Ohne `Content-Length` schickt ihn jede gängige Bibliothek stückweise, und der HTTP-Dienst von Proxmox nimmt das nicht an: `$self->error($reqstate, 501, "chunked transfer encoding not supported")` (pve-http-server, `AnyEvent.pm`). Die Antwort ist eine **501, bevor jemand die Zugangsdaten ansieht** — sie sieht aus wie ein Gerätefehler und ist eine fehlende Kopfzeile |
| Rechte | ein Konto unter *Configuration → User Management*, Realm `pmg`, Rolle **Auditor**. PMG kennt keine ACL-Pfade wie VE: der Benutzer trägt genau eine Rolle, und `audit` deckt alles ab, was hier gelesen wird. Der Benutzername gehört **mit Realm** eingetragen (`leitstand@pmg`) — sonst hängt PMG `@quarantine` an und findet das Konto nicht |
| Endpunkte, jede Minute | `/nodes/{node}/status`, `/nodes/{node}/services`, `/nodes/{node}/postfix/qshape?queue=` für `deferred`, `active` und `hold` |
| Endpunkte, alle 5 Minuten | `/statistics/mail?starttime=`, `/statistics/domains`, `/statistics/virus`, `/quarantine/spamstatus`, `/quarantine/virusstatus`, `/nodes/{node}/clamav/database`, `/nodes/{node}/apt/update`, `/version` |
| Warum zwei Takte | der Durchlauf kommt alle 15 s. Die Tagesstatistik ändert sich darin nicht messbar, `qshape` startet je Abruf einen Prozess auf dem Gerät, und `apt/update` liest eine Liste, die einmal täglich erneuert wird. Einstellbar als `pmg_takt` und `pmg_takt_lang`. Die Erreichbarkeit misst der Prober weiterhin in jedem Durchlauf |
| Kennzahlen Verkehr | `count_in`/`count_out`, `spamcount_in` mit Anteil am **angenommenen** Eingang, `viruscount_in` **und** `viruscount_out`, `bytes_in`/`bytes_out`, `glcount`, `rbl_rejects`, `pregreet_rejects`, `spfcount`, Bounces, `avptime` (Sekunden → ms) |
| Kennzahlen Betrieb | Warteschlange je Queue mit Altersverteilung und Top-Domänen, Quarantäne (Anzahl, Platz, Ø Spam-Wert), ClamAV-Datenbanken mit Signaturzahl und Alter, alle Dienste mit `state`/`active-state`, CPU/RAM/Wurzel-Belegung, Last, Laufzeit, Kernel, `pmgversion`, `insync`, ausstehende Pakete |
| Ampel rot | ein **Kerndienst** steht (postfix, pmg-smtp-filter, pmgproxy, pmgdaemon, pmgpolicy, postgres, clamav-daemon) · **ausgehender** Virenfund · Warteschlange ≥ `mail_queue_crit` (100) · Wurzeldateisystem über `disk_crit` · RAM über `ram_crit` |
| Ampel gelb | Verbund nicht abgeglichen (`insync: 0`) · Warteschlange ≥ `mail_queue_warn` (25) **oder** Mail liegt seit über zehn Stunden · Belegung über den Warngrenzen · `daily`-Signaturen älter als 24 h · ein Nebendienst meldet `failed` |
| Ampel bewusst **nicht** | ein **eingehender** Virenfund. Er ist der Zweck des Geräts; eine Ampel, die dabei jedes Mal leuchtet, ist nach zwei Wochen abtrainiert — und mit ihr die Ampel für alles andere. Die Zahl steht groß auf der Karte, sie leuchtet nur nicht. Ebenso `hold`: dort liegt, was eine Regel angehalten hat, das ist eine Entscheidung und keine Störung — sie steht als Notiz da |
| Bewusst nicht abgefragt | `/nodes/{node}/spamassassin/rules` — der Endpunkt ruft je Kanal `sa-update --checkonly` auf und geht dafür ins Netz. Ein Abruf im Minutentakt wäre eine Last, die in keinem Verhältnis zur Auskunft steht. `/nodes/{node}/postfix/queue` liefert nur die **Namen** der Warteschlangen, keine Zahlen; die Zahlen stehen in `qshape` |
| Meldet per Mail | Tagesbericht, Quarantänebericht |

## OPNsense — 4 Geräte

| | |
|---|---|
| Zugang | API Key/Secret je Gerät, eigener Benutzer mit lesenden Rechten (Basic-Auth über HTTPS) |
> **Gebaut** — `server/src/collectors/opnsense.js`. Seit der Ergänzung um
> Gateways, Zustandstabelle und CARP ist die Anbindung vollständig bis auf die
> HAProxy-Backends.

| Endpunkte | `/api/core/firmware/status` (Version, ausstehende Updates), `/api/core/firmware/info` (Version auch dann, wenn nichts ansteht), `/api/diagnostics/interface/get_interface_statistics` (ältere Fassungen: `getInterfaceStatistics`), `/api/interfaces/overview/export` (Verbindungszustand, Beschreibung, MTU — fehlt auf älteren Fassungen), `/api/routes/gateway/status`, `/api/diagnostics/firewall/pf_statistics/state`, `/api/diagnostics/interface/get_vip_status` (CARP), `/api/wireguard/service/show`, HAProxy-Plugin für Backend-Zustände |
| Kennzahlen | Version + Updatestand, **je Schnittstelle** Durchsatz ↓/↑ in Mbit/s, Pakete/s, übertragene Menge, Fehler und Verwürfe (Stand *und* Zuwachs), Kollisionen, Verbindungszustand, MTU · **Gateways** mit Zustand, Latenz, Schwankung und Verlust · **Zustandstabelle** belegt/maximal · **CARP**-Rolle und Wartungsmodus · WireGuard-Peers mit Handshake-Alter |
| Zähler, nicht Raten | Was hier zurückkommt, sind kumulative Zähler seit dem Neustart. Durchsatz gibt es erst aus der Differenz zweier Abfragen — davor ein Strich, keine Null; nach einem Zählerrücksetzer ebenso |
| Ampel | Gateway `down` → rot · Zustandstabelle > 90 % → rot, > 80 % → gelb · Verlust ≥ 2 % oder Zustand `loss`/`delay` → gelb · Platte und RAM nach den Schwellwerten (je System überschreibbar) · CARP-Rolle und ausstehende Aktualisierungen: **Notiz, keine Ampel** · Backend ohne aktiven Server → rot (offen) |
| Fallstrick | `firmware/status` nennt `product_version` nur, wenn es zu den Aktualisierungen etwas zu sagen gibt. Auf einem Gerät, das gerade auf dem letzten Stand ist, fehlt das Feld — dann stand in der Übersicht bei den gepflegten Geräten ein Strich und bei den vernachlässigten eine Zahl, genau verkehrt herum. Gefragt wird deshalb der Reihe nach: `firmware/status`, `firmware/info` (dort je nach Fassung flach oder unter `product`), zuletzt die Zeile „OPNsense 26.1.11_10-amd64" aus `system_information.versions` |
| Fallstrick | OPNsense schreibt beim Gateway `status: "none"`, wenn es steht und **nicht überwacht** wird. Das ist die Auskunft „nichts zu beanstanden" und nicht das Fehlen einer — als unbekannt gelesen stünde die halbe Tabelle grau da |
| Fallstrick | Latenz und Verlust kommen als Text mit Einheit; wo nichts gemessen wurde, steht `~`. Das wird zu null, nicht zu 0 — eine tote Strecke als verlustfrei zu melden wäre schlimmer als eine Lücke |
| Fallstrick | Die Zahl der Zustandstabelle liegt je nach Fassung flach im Antwortobjekt oder in einem Unterobjekt. Gesucht wird deshalb nach Namen über bis zu drei Ebenen; was sich nicht finden lässt, bleibt null |
| Meldet per Mail | `System → Settings → Notifications` (SMTP): Konfigurationsänderungen, ACME-Erneuerungen, CARP-Wechsel |

Der HA-Verbund liefert zwei Sichten: MASTER und BACKUP werden getrennt abgefragt,
sonst bleibt eine schleichende Config-Sync-Abweichung unsichtbar.

## pfSense — 3 Geräte

| | |
|---|---|
> **Gebaut, aber in der Praxis oft nicht nutzbar** —
> `server/src/collectors/pfsense.js` liest über das Paket `pfSense-pkg-API`.
> Das Paket steht **nicht** im Paketverzeichnis von pfSense: es ist ein
> Fremdprojekt, wird von Hand aus dessen Veröffentlichungen installiert, und
> für neuere pfSense-Fassungen gibt es nicht immer eine passende. Wer es nicht
> hat, bekommt von pfSense weiterhin nur Erreichbarkeit, Antwortzeit und
> Zertifikat.
>
> Der Sammler bleibt trotzdem stehen: er ist geprüft und kostet nichts,
> solange keine Zugangsdaten hinterlegt sind. Der Weg über SSH bleibt
> unabhängig davon verworfen — er hätte einen SSH-Client im Abbild und einen
> privaten Schlüssel im Volume verlangt.

| | |
|---|---|
| Zugang | CE hat keine Schnittstelle ab Werk. Gelesen wird über das Fremdpaket `pfSense-pkg-API`: **Fassung 2** meldet mit `X-API-Key` an und liegt unter `/api/v2/…`, **Fassung 1** mit `Authorization: <client-id> <token>` unter `/api/v1/…`. Der Sammler probiert beide durch und nimmt, was antwortet — eingetragen werden muss nur der Zugang |
| Verworfener Weg | SSH mit `pfctl -si` und `wg show all dump`. Wäre versionsunabhängig, verlangte aber einen SSH-Client im Abbild, einen privaten Schlüssel im Volume und das Auswerten von Textausgaben. Der Dienst soll nur lesen und sonst nichts können |
| Endpunkte | `/status/system`, `/system/version`, `/status/interfaces`, `/status/gateways`, `/firewall/states/size`, `/status/carp`, `/status/wireguard/peers` — je mit den Schreibweisen beider Paketfassungen |
| Kennzahlen | Fassung und ob eine neuere bereitsteht, Laufzeit, Last, Speicher, Platte, Temperatur · **je Schnittstelle** dieselben Zahlen wie bei OPNsense, den Verbindungszustand liefert pfSense gleich mit · **Gateways** mit Zustand, Latenz, Schwankung und Verlust · **Zustandstabelle** belegt/maximal · **CARP**-Rolle und Wartungsmodus · WireGuard-Peers |
| Ampel | Gateway `down` → rot · Zustandstabelle > 90 % → rot, > 80 % → gelb · Verlust ≥ 2 % oder Zustand `loss`/`delay` → gelb · Platte und RAM nach den Schwellwerten (je System überschreibbar) · CARP-Rolle und ausstehende Aktualisierung: **Notiz, keine Ampel** |
| Fallstrick | Die Antwortfelder stammen aus den pfSense-Internas und sind nirgends verbindlich beschrieben. Jedes Feld kennt deshalb mehrere mögliche Namen; was nicht kommt, bleibt null. Die **Diagnose zeigt zu jedem Aufruf die tatsächlichen Feldnamen** — daran lässt sich der Sammler nachziehen, statt zu raten |
| Fallstrick | Ob das Paket den WireGuard-**Handshake** führt, hängt an seiner Fassung. Führt es ihn nicht, stehen die Peers trotzdem da — aber ausdrücklich *ohne* Handshake-Alter. Ein Peer, über den nichts bekannt ist, sähe sonst genauso aus wie einer, der sich nie gemeldet hat, und daran hängt ein Tunnelzustand |
| Meldet per Mail | `System → Advanced → Notifications`, zusätzlich das Paket *Notes/Status Email* für Gateway-Alarme |

## WireGuard — alle 7 Firewalls

Wird nicht getrennt angebunden, sondern über die jeweilige Firewall gelesen
(OPNsense: `/api/wireguard/service/show`, pfSense: `/status/wireguard/peers`
über das API-Paket).

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
Proxmox VE           Benutzer leitstand@pve, Rolle PVEAuditor auf / mit Vererbung, Token ohne Ablauf
Proxmox Mail GW      KEIN Token — Benutzer leitstand@pmg, Rolle Auditor; angemeldet wird mit Passwort
Proxmox Backup       Benutzer leitstand@pbs, Rolle Audit auf / mit Propagate — auch für die Token-ID selbst
OPNsense             System → Access → Users → leitstand, Gruppe mit Lesezugriff, API-Key erzeugen
pfSense              nur mit dem Fremdpaket pfSense-pkg-API (nicht im Paketverzeichnis) — sonst nur Erreichbarkeit
AdGuard              zusätzlicher Benutzer in AdGuardHome.yaml (users), Benutzer + Passwort eintragen
Portainer            Benutzer leitstand, Rolle „read-only“ je Umgebung, Token unter My account → Access tokens
TrueNAS              Credentials → API Keys
Mailcow              Configuration → Access → API, „Read-Only“, Quell-IP einschränken
Home Assistant       Profil → Long-Lived Access Tokens
```

Alle Token gehören nach Vaultwarden, nicht in eine Datei neben den Container.
