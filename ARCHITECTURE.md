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

**Und sie dürfen je System abweichen.** Ein Host, der seit Jahren bei 93 %
Belegung läuft, weil mehr Platte nicht drin ist, ist kein Notfall — mit der
globalen Grenze leuchtet er trotzdem jede Nacht rot. Eine Ampel, die immer rot
ist, hat man nach zwei Wochen abtrainiert; damit ist nicht nur dieser Host
unüberwacht, sondern die Ansicht insgesamt entwertet. Deshalb trägt ein Eintrag
im Bestand optional `schwellen:` und überschreibt einzelne der vier Werte
(`disk_warn`, `disk_crit`, `ram_warn`, `ram_crit`); was nicht dasteht, kommt
weiter aus den Einstellungen. Pflegen lässt sich das in der Oberfläche unter
*Verwaltung → System bearbeiten → Schwellwerte*, und welche Systeme abweichen,
steht unter *Einstellungen* mit Namen — eine Ausnahme, die niemand mehr findet,
ist eine stillgelegte Überwachung.

## Alarm-Postfach

Adresse `alarm@…`, hinter dem bestehenden Proxmox Mail Gateway — Spam wird nie
zugestellt. Dass dieser Gateway inzwischen selbst überwacht wird, ist kein
Zufall: er ist der Weg, über den alle Meldungen ohne Schnittstelle
hereinkommen. Steht sein Filter oder läuft seine Warteschlange voll, fällt
nicht nur Mail aus — es fällt der Kanal aus, über den der Leitstand von allem
anderen erfährt. Der Ingest hält die Verbindung per IMAP IDLE offen, prüft jede
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

Was von hier aus als Nächstes zu tun ist — mit Grund, Einstieg und Abnahme je
Punkt — steht in [TODO.md](TODO.md).

| Stufe | Inhalt | Stand |
|---|---|---|
| 1 | Bestand als YAML, ICMP/TCP/TLS-Prober, Startseite mit Ampeln | **gebaut** |
| 1b | Verwaltung in der Oberfläche: Standorte, Systeme, Tunnel, Startseite, Schwellwerte, Zugangsdaten, Verbindungstest | **gebaut** |
| 1c | Standort-Bündelung, Quittieren, Stummschalten, Fortschreibung über Neustarts | **gebaut** |
| 2 | Proxmox VE + PBS + PMG anbinden | **gebaut** — VE inklusive Knotendetails (Kernel, Fassung, Ausstattung, ausstehende Pakete) und jedem Gast mit seiner Auslastung, in einer eigenen Ansicht *Virtualisierung*; PMG mit Durchsatz, Warteschlange samt Alter, Quarantäne, Signaturstand und den filternden Diensten in der Ansicht *Mail* — **und mit Ticket statt Token**, weil PMG keine kennt |
| 3 | OPNsense/pfSense inkl. WireGuard-Handshake | **OPNsense vollständig** — Fassung, Laufzeit, Last, Speicher, Platte, **Schnittstellen einzeln** (Durchsatz, Pakete, Fehler, Verwürfe, Verbindungszustand, Verlauf je Leitung), **Gateways**, **Zustandstabelle**, **CARP**, Peers und Handshake am Tunnel; offen sind nur die HAProxy-Backends. pfSense liefert dasselbe, **aber nur mit dem Fremdpaket `pfSense-pkg-API`** — das nicht im Paketverzeichnis steht und für neuere Fassungen fehlt; ohne es bleibt es bei der Erreichbarkeit |
| 4 | Alarm-Postfach mit Regelwerk | offen — die Ansicht erklärt den Weg und zeigt ein Beispiel |
| 5 | TrueNAS, AdGuard, Portainer, Mailcow, Home Assistant | **AdGuard Home, Portainer und Mailcow gebaut** — AdGuard zusätzlich mit einer echten Auflösung über UDP/53 als *wesentlicher* Prüfung; Mailcow mit Containern, Warteschlange samt Grund, Postfächern und rspamd, in derselben Ansicht *Mail* wie der Gateway. TrueNAS und Home Assistant offen — bislang nur Erreichbarkeit |
| 6 | Wartungsfenster, Zeitreihen-Detailseiten, **Push-Kanäle und Totmannschalter** | Zeitreihen und Detailseite **gebaut** (eigene Ablage statt VictoriaMetrics, siehe unten); Wartungsfenster, Push und Totmannschalter offen — ohne sie ist der Leitstand ein Bildschirm, kein Wecker |

### Zeitreihen: eine Datei je Tag statt einer Datenbank

Vorgesehen ist VictoriaMetrics. Gebaut ist zunächst eine eigene, sehr kleine
Ablage — `server/src/verlauf.js`, eine Datei je Tag im Volume, eine Zeile je
Messpunkt als JSON:

```
/data/verlauf/2026-08-21.jsonl
{"t":1755765600,"k":"h","id":"pve-01","ms":12,"min":10,"max":41,"n":4,"cpu":3.5,"ram":61,"st":"ok"}
{"t":1755765600,"k":"i","id":"fw-01|vtnet1","in":42.5,"out":3.2}
```

Der Grund ist derselbe wie beim Bestand als YAML: ein weiterer Container, ein
weiteres Ablageformat und eine weitere Abfragesprache kosten mehr, als sie in
diesem Netz einbringen. Anhängen braucht keine Sperre, ein abgeschnittener
Schreibvorgang kostet eine Zeile statt der Datei, und auslesen lässt sich das
mit `grep` und `jq`. Kommt VictoriaMetrics später doch, ist dies das Format,
aus dem sie befüllt wird — es geht nichts verloren.

Es gibt drei Gegenstandsarten: `h` für ein System, `t` für einen Tunnel und
`i` für **eine einzelne Schnittstelle** einer Firewall (Kennung
`system|schnittstelle`). Die letzte ist dazugekommen, weil am System nur der
Durchsatz der WAN-Seite steht — die Frage „auf welcher Leitung war das heute
Nacht?" beantwortet erst eine Reihe je Leitung. Eine Firewall mit vier
Schnittstellen kostet damit rund 0,25 MB je Tag mehr.

Verdichtet wird auf einen Punkt je Minute (`verlauf_takt`). Was innerhalb
dieser Minute gemessen wurde, bleibt trotzdem erhalten: Mittel-, Kleinst- und
Größtwert stehen in der Zeile, und die **schlechteste** Ampel der Minute
gewinnt — ein Aussetzer von zwanzig Sekunden darf nicht im Mittelwert
verschwinden. Aufbewahrt wird 30 Tage (`verlauf_tage`); die Detailseite
verdichtet beim Abruf ein zweites Mal, weil kein Diagramm 10 000 Punkte zeigt.

Auf der Detailseite wird eine Lücke als Lücke gezeichnet: lief der Dienst eine
Nacht lang nicht, ist die Linie unterbrochen statt durchgezogen. Eine
durchgezogene Linie über eine Nacht ohne Messwerte wäre genau die Sorte
Behauptung, die Regel 5 verbietet.

### Was in Stufe 1 bewusst anders gelöst ist

**Die Karte ist kein Stern.** In der Mitte steht der Hauptstandort, ringsum die
übrigen — aber ein Tunnel zwischen zwei Nebenstandorten wird genauso gezeichnet,
nach außen gebogen, damit er nicht durch die Nabe läuft. Wer eine solche Strecke
legt, tut das gerade, damit der Verkehr nicht über die Mitte geht; eine Karte,
die sie verschweigt, zeigt ein Netz, das es so nicht gibt. Liegen mehrere Tunnel
zwischen denselben Standorten, trägt die Linie den schlechtesten Zustand: eine
tote zweite Strecke darf nicht hinter einer lebenden verschwinden.

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

**Eine Strecke hat zwei Enden.** Neben `peer` darf ein Tunnel deshalb ein
`peerB` benennen: den Peer, den die *andere* Firewall meldet. Jede kennt nur
die jeweils andere Seite — dasselbe Kabel, zweimal beschrieben. Das hat zwei
Folgen. Erstens stimmt die Zuordnung in beide Richtungen: ohne das zweite Ende
steht die Gegenzeile in der Gegenstellenliste für immer auf „keiner Strecke
zugeordnet", mitten in einer Strecke. Zweitens lassen sich die beiden Auskünfte
gegeneinander halten — dieselbe Strecke ist sich über ihren Handshake einig;
liegen die Enden weit auseinander, zeigt eine der Verknüpfungen woandershin,
und das steht als Notiz da.

Für den Zustand zählt das **frischere** Ende. WireGuard erneuert den Handshake
nur, wenn Verkehr fließt, und die beiden Firewalls werden zu verschiedenen
Zeitpunkten abgefragt; vom älteren auszugehen hieße, eine tragende Strecke rot
zu melden. Ein `peerB` ohne `peer` gibt es nicht — es rückt beim Einlesen auf,
damit sich alles Weitere auf ein Feld verlassen darf.

Zugeordnet wird über den **öffentlichen Schlüssel**, nicht über den Namen: der
Schlüssel übersteht eine Umbenennung auf der Firewall. Ein Name greift nur als
Rückfall und nur, wenn er eindeutig ist — lieber kein Treffer als der falsche,
denn ein falscher meldete den Handshake eines fremden Geräts als den dieser
Strecke.

**Transfernetz und Gegenstelle stehen schon da.** Was eine Firewall als
`allowed-ips` eines Peers meldet, ist zweierlei in einer Zeile: die Adresse des
anderen Endes im Transfernetz — eine /32 beziehungsweise /128 — und die Netze,
die dahinter geroutet werden. Der Dienst trennt beides und zeigt es an der
Strecke; im Formular lässt es sich mit einem Klick als `probe.ip`
beziehungsweise `net` übernehmen. Stillschweigend eingetragen wird nichts: von
hier aus ist nur eines der beiden Enden erreichbar, und welches, weiß der
Betreiber, nicht der Dienst.

**Zwei Prüfziele, nicht eines.** Port- und TLS-Prüfung fragen zuerst die IP des
Systems und, wenn dort nichts antwortet, den Namen aus seiner
Oberflächen-Adresse. Meistens ist das dasselbe. Nicht dasselbe ist es, wenn die
Oberfläche hinter einem Reverse Proxy liegt: dann steht auf dem System selbst
kein Port 443 offen, obwohl die Seite im Browser einwandfrei kommt — und eine
Überwachung, die nur die IP kennt, meldet dafür einen Teilausfall. Umgekehrt
löst ein interner Name nicht überall auf, deshalb bleibt die IP der erste
Versuch. Es genügt, wenn eines von beiden trägt; im Ergebnis steht, welches es
war. ICMP und DNS fragen weiterhin nur das System selbst — ein Resolver
antwortet auf seiner Adresse, nicht unter dem Namen, unter dem ein Proxy seine
Weboberfläche ausliefert.

**Erreichbar, aber Abruf scheitert.** Ein System, das antwortet, dessen API-Zugang
aber abgelehnt wird, geht auf Gelb statt still ohne Kennzahlen dazustehen. Ein
falsch gesetztes Token ist sonst monatelang unsichtbar.

**Wesentliche Prüfungen: der Dienst, nicht seine Oberfläche.** Eine Prüfung darf
`wesentlich: true` tragen. Dann ist ihr Ausfall kein „Teilausfall, gelb" neben
einem grünen Port, sondern eine Störung wie ein toter Host — mit derselben
Zurückhaltung, erst nach `fail_threshold` Fehlschlägen. Bislang gibt es genau
einen Fall dafür, und der ist der Grund für die Regel: **AdGuard Home** bekommt
von Haus aus eine DNS-Auflösung über **UDP/53**. Ein Resolver, dessen Dienst
gestorben ist, hält seine Oberfläche weiter offen; wer nur den Port misst, sieht
Grün, während im Netz nichts mehr auflöst.

Gefragt wird mit einem selbst gebauten DNS-Paket statt über `dns.Resolver`, und
zwar aus einem Grund: der Systemauflöser fällt bei zugemachtem UDP still auf TCP
zurück und meldet Erfolg — während kein Gerät im Netz das täte. Kommt über UDP
gar nichts, wird deshalb einmal TCP versucht, nicht als Rückfall, sondern als
Befund: „über TCP antwortet er, UDP/53 kommt nicht durch" ist eine ganz andere
Suche als „der Dienst ist weg". Ebenso wenig gilt als aufgelöst, wer mit NOERROR
und null Antworten zurückkommt — das liefert ein Filter, der den Prüfnamen
blockt, und „er antwortet" ist nicht „er löst auf".

**Schnittstellen: Zähler sind keine Bandbreite.** OPNsense liefert Bytes und
Pakete seit dem letzten Neustart. Ein Durchsatz entsteht erst aus der Differenz
zweier Abfragen — vor der zweiten steht deshalb ein Strich und keine Null, und
nach einem Zählerrücksetzer ebenfalls. Fehler und Verwürfe werden doppelt
geführt: der Stand (kann Monate alt sein) und der Zuwachs seit dem letzten
Durchlauf (das ist die Nachricht). Eine Ampel machen sie nicht — ein verworfenes
Paket auf einer ausgelasteten Leitung ist normal, und eine Schwelle dafür wäre
geraten. Der Verbindungszustand kommt aus einem eigenen Endpunkt, den ältere
Fassungen nicht kennen; dann bleibt er unbekannt und wird als Strich gezeigt,
nicht als „up".

**pfSense: ein Fremdpaket statt einer Shell — und meist gar nichts.** pfSense
CE hat keine Schnittstelle ab Werk, und es gab zwei Wege: SSH mit festen
Lesebefehlen, oder das Paket `pfSense-pkg-API`. Gewählt ist das Paket — nicht
weil es bequemer ist, sondern weil der andere Weg dem Leitstand Fähigkeiten
gegeben hätte, die er nicht haben soll: einen SSH-Client im Abbild, einen
privaten Schlüssel im Volume und das Auswerten von Textausgaben, die sich
zwischen zwei Fassungen ändern dürfen.

Nachtrag aus dem Betrieb: **das Paket ist meist nicht zu haben.** Es steht
nicht im Paketverzeichnis von pfSense, wird von Hand aus den
Veröffentlichungen des Projekts installiert, und für neuere pfSense-Fassungen
gibt es nicht immer eine passende. Damit bleibt pfSense in der Praxis bei
Erreichbarkeit, Antwortzeit und Zertifikat. Der Sammler steht trotzdem — er
ist geprüft und kostet nichts, solange keine Zugangsdaten hinterlegt sind —,
aber die Oberfläche sagt jetzt vorweg, dass zuerst zu prüfen ist, ob es das
Paket überhaupt gibt. Eine Anleitung, die auf ein nicht vorhandenes Paket
zeigt, ist schlimmer als keine: sie lässt einen suchen statt umplanen.

Die ehrliche Auskunft lautet damit: wer eine Firewall wirklich auswerten will,
nimmt OPNsense, das eine Schnittstelle ab Werk hat.

Dass das Paket in zwei Fassungen umläuft, die verschieden anmelden und unter
verschiedenen Pfaden liegen, wird nicht zur Frage an den Betreiber gemacht:
der Sammler probiert beide durch und nimmt, was antwortet — aber nur bei
„gibt es nicht" (404). Bei 401 hilft ein anderer Pfad nicht, das ist eine
Rechtefrage, und weiterzufragen erzeugt nur Last auf einem Gerät, das gerade
ohnehin nein sagt.

**Was von beiden Firewalls kommt, trägt dieselben Namen.** Die Oberfläche
unterscheidet nicht zwischen OPNsense und pfSense; das tun die Sammler, und
zwar so, dass hinterher dieselben Felder dastehen. Wo ein Hersteller etwas
nicht liefert — Gateways bei OPNsense, der ZFS-Cache bei pfSense —, bleibt die
Zeile weg statt leer dazustehen: ein „CARP: —" an einem Gerät, bei dem CARP
gar nicht abgefragt wird, wäre eine Aussage über etwas, wonach niemand gefragt
hat. Die Rechnung von Zählerständen auf Durchsatz steht deshalb auch nur
einmal da (`collectors/firewall.js`) — zweimal wäre sie zweimal falsch.

**Ein gestoppter Gast hat keine Auslastung.** Proxmox meldet für ihn cpu 0 und
mem 0 — das ist die Abwesenheit einer Messung. Als „0 %" angezeigt sähe eine
ausgeschaltete Maschine aus wie eine, die sich langweilt. Ebenso bleibt die
Plattenbelegung einer VM leer: der Wirt kennt sie nicht und schreibt 0 hin. Bei
Containern ist dieselbe Zahl echt.

**Gefragt wird nur, was der Leitstand nicht wissen kann.** Das Interface eines
Tunnels stand früher als leeres Textfeld im Formular. Ist ein Peer verknüpft,
meldet die Firewall es ohnehin — dann verschwindet die Frage, und in der
Bestandsdatei steht kein `iface` mehr: eine getippte Angabe daneben wäre eine
zweite Quelle, die still veraltet, sobald jemand am Gerät etwas verschiebt.
Bleibt der Fall, den er *nicht* wissen kann: eine Strecke, deren anderes Ende
jemand anderem gehört. Dann ist es wieder eine Eingabe, aber als Auswahl über
die Namen, die die erreichbaren Firewalls melden — und „andere" führt zurück
zum Tippen, denn eine Liste aus dem eigenen Netz ist keine Aussage über ein
fremdes.

**Ein Neuzeichnen aus dem Netz darf keine Eingabe unterbrechen.** Alle 15
Sekunden kommt ein Zustand und die Seite wird neu gezeichnet. Getippte Werte
überleben das — `render` sichert sie und setzt Fokus und Schreibmarke zurück.
Ein aufgeklapptes Auswahlmenü überlebt es nicht: es hängt am Knoten des
`<select>`, und ein Browser öffnet es nur auf eine echte Geste hin, also lässt
es sich auch nicht wiederherstellen. Wer aus einer langen Peerliste sucht, wurde
so alle 15 Sekunden herausgeworfen — ausgerechnet in dem Formular, in dem
Sorgfalt am nötigsten ist.

Aufgeschoben wird deshalb das *Bild*, nicht die Daten: die stehen längst im
Zustand, und der nächste Strich holt sie ein. Sobald die Auswahl vorbei ist —
Wert gewählt oder Fokus weiter —, wird nachgezeichnet. Nur der Zustandsstrom
wird aufgeschoben; was der Benutzer selbst auslöst, zeichnet sofort. Und weil
eine Überwachung, die stehenbleibt und dabei aktuell aussieht, das schlechtere
Übel wäre, gibt es eine Obergrenze von zwei Minuten — für den Fall, dass jemand
ein Menü aufklappt und weggeht.

**Sortiert wird, was dasteht.** Jede Spalte jeder Tabelle lässt sich anklicken.
Das klingt nach einer Abkürzung und ist eine Entscheidung: die Ansichten sind
reine Funktionen von Zustand nach HTML, und jede Tabelle bräuchte sonst eine
eigene Liste von Vergleichsfunktionen, passend zu dem, was sie gerade anzeigt.
Zwanzig solcher Listen wären zwanzig Gelegenheiten, dass eine Spalte anders
sortiert, als sie beschriftet ist.

Der Vergleich versteht deshalb die Schreibweisen, die hier vorkommen: Mengen mit
Einheit („1.1 GB"), Zeiten („900 ms", „3 T"), Prozente, Zeitpunkte („14:15",
„23.08. 09:00"). Eine Zelle ohne Text ist die Ampel — dann gilt der Zustand der
Zeile, nach Dringlichkeit geordnet. Ein Name mit Ziffern (`pve-hq-01`) bleibt
ein Name. Und ein Strich bleibt hinten, in beiden Richtungen: er ist keine Null,
und eine Spalte, die mit lauter Unbekanntem anfängt, hätte niemandem geholfen.

Der dritte Klick nimmt die Sortierung zurück statt eine dritte Richtung zu
erfinden. Die Ordnung der Ansicht ist meist die nach Dringlichkeit, und das ist
die einzige, die von selbst das Wichtige nach oben bringt — man muss zu ihr
zurückfinden können.

**Was eingerichtet ist und was gelaufen ist, sind zwei Auskünfte.** Bei
Sicherungsaufträgen fällt das besonders auf: `/cluster/backup` nennt die
Absicht — Zeitplan, Ziel, Umfang —, und nur die `vzdump`-Aufgaben sagen, ob
heute Nacht etwas gesichert wurde. Beides steht nebeneinander in einer Zeile,
und die drei Zeitpunkte stehen getrennt: „zuletzt gelaufen" beantwortet nicht,
ob es geklappt hat, und „zuletzt erfolgreich" nicht, ob seither etwas
schiefging. Ein Auftrag, der heute Nacht scheiterte und vorgestern glückte, ist
etwas anderes als einer, der nie lief.

Zusammenführen lassen sich die beiden nur, soweit Proxmox es zulässt: die
Aufgabe trägt je nach Fassung die Kennung des Auftrags, je nach Fassung nicht.
Steht sie da, gehören die Zeitpunkte dem Auftrag; sonst gelten die aller
`vzdump`-Läufe des Knotens — und die Zeile schreibt „vom Knoten" dazu. Eine
Zuordnung zu behaupten, die die Antwort nicht hergibt, wäre schlimmer als eine
ungenaue, die sich zu erkennen gibt.

Bewertet wird der **letzte** Lauf, nicht „ein Fehlschlag in den letzten 24
Stunden". Ist danach einer geglückt, ist die Sache erledigt; eine Meldung, die
trotzdem stehen bleibt, lernt man zu übergehen — und mit ihr die nächste.

**Grün muss verdient sein.** Die Kurzlage ist die Seite, auf die sich jemand
morgens im Vorbeigehen verlässt — sie beantwortet eine Frage, in einem Wort.
Genau deshalb ist sie die gefährlichste Ansicht des Werkzeugs: „nichts leuchtet
rot" ist nicht dasselbe wie „alles in Ordnung". Ein Zustandsstrom, der hängt,
ein Bestand ohne ein einziges überwachtes System, ein Sammler ohne
Zugangsdaten — jedes davon ergäbe eine Anzeige ohne rote Zeile.

Der Befund kennt deshalb vier Ausgänge, und die Reihenfolge ist die Aussage:
*kann* ich es wissen (Dienst da? Strom frisch? überhaupt etwas überwacht?),
und erst dann: *weiß* ich es. Eine quittierte Störung macht die Fläche nicht
grün — „quittiert" heißt, dass jemand hinsieht, nicht, dass es behoben ist.

Und unter der Fläche steht, was in ihr nicht enthalten ist: wie viele Systeme
ohne Zugangsdaten nur angepingt werden, wie viele von der Überwachung
ausgenommen sind, ob ICMP übersprungen wird. Ohne diesen Absatz wäre das Grün
eine Behauptung über Dinge, die gar nicht gemessen werden — der Fehler, an dem
Überwachungen still scheitern. Ist wirklich keine Lücke da, steht auch das da;
dann ist es eine Aussage und keine Auslassung.

**„Darf nicht" ist keine Antwort des Ziels.** Der Dienst läuft im Abbild als
unprivilegierter Benutzer (`USER node`). Fehlt dem Behälter `NET_RAW` — oder
erlaubt der Wirt unprivilegierte ICMP-Sockets nicht —, scheitert `ping` mit
„Operation not permitted", **ohne ein einziges Paket zu senden**. Das als
„keine Antwort" zu melden, ist eine Falschaussage über das Ziel: die Strecke
steht rot da, und dieselbe Adresse lässt sich aus demselben Behälter von Hand
anpingen — von Hand nämlich als root.

Ein Rechteproblem zählt deshalb als **übersprungen**, wie ein fehlendes `ping`
auch, und die Oberfläche nennt den Grund. Gemerkt wird es zusätzlich: es geht
nicht vorbei, und ohne diese Notiz liefe der Prober bei jedem System aufs Neue
in denselben Fehler. Geprüft wird die Benutzbarkeit beim ersten Mal mit einem
echten Paket an die eigene Adresse, nicht mit `ping -V`: dass die Datei da ist,
sagt nichts darüber, ob dieser Prozess sie benutzen darf.

Für Tunnel hat das eine Folge, die man kennen muss: hat eine Strecke nur ICMP
und keinen `probe.port`, ist nach einer übersprungenen ICMP-Prüfung *nichts*
mehr auswertbar. Sie steht dann auf Grau mit „keine auswertbare Prüfung" — und
nicht auf Grün, was die gefährlichere Anzeige wäre.

**Eine Formalie darf nie die Überwachung mitnehmen.** Für Standortkürzel steht
das weiter oben; es einmal an anderer Stelle vergessen zu haben, hat den Dienst
gekostet: ein Messziel mit einem Leerzeichen davor ließ `validate` beim *Lesen*
scheitern, und damit startete der Leitstand nicht mehr — wegen eines
Leerzeichens, während er dafür da ist, Ausfälle zu melden.

Die Regel gilt deshalb allgemein: was beim **Schreiben** geprüft wird, darf
beim **Lesen** höchstens zurechtgerückt werden. `normalizeTunnel` schneidet
Leerzeichen ab (gemeint war offensichtlich die Adresse), und ob ein Messziel
eine Adresse und kein Netz ist, prüft `pruefeProbeIp` — aufgerufen im
Schreibpfad des Servers, wie `pruefeKuerzel` auch. Ein bestehender Bestand
startet immer. Was darin krumm ist, sagt die Oberfläche an der Stelle, an der
es auffällt: im Tunnel-Inspektor steht dann „Name nicht auflösbar" an der
ICMP-Prüfung, und das ist die Auskunft, die weiterhilft.
