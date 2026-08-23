# Was noch zu tun ist

Diese Liste ist die Übergabe an den Nächsten — ob Mensch oder Claude. Jeder
Punkt steht für sich: **warum** er zählt, **wo** er anfängt, und **woran** man
erkennt, dass er fertig ist. Wer einen davon anfasst, sollte ihn ganz machen und
danach hier den Haken setzen, statt eine halbe Baustelle offen zu lassen.

Die Reihenfolge ist ein Vorschlag, keine Fessel. Was oben steht, fehlt am
meisten; „Kleinkram" unten sind Sachen, die im Betrieb aufgefallen sind und je
eine Sitzung von unter einer Stunde brauchen.

**Hausregeln** (gelten überall, siehe auch [ARCHITECTURE.md](ARCHITECTURE.md)):

- **Kein erfundener Wert.** Was eine Stufe nicht wissen kann, ist `null` und
  wird als Strich angezeigt. Ein Platzhalter in einer Überwachung ist schlimmer
  als eine Lücke, weil man ihm glaubt.
- **Nur lesen.** Jeder Zugang ist ein Konto ohne Schreibrechte.
- **Tests gehören dazu**, nicht hinterher: `cd server && npm test`. Geprüft wird
  gegen echte Ports und nachgebaute Dienste, nicht gegen Attrappen der eigenen
  Funktionen.
- Oberfläche, Meldungen, Commit-Texte und Kommentare sind **deutsch**.

---

## 1. Die Verwaltung ist ungeschützt

**Warum.** Der Dienst hat keine Anmeldung. Wer Port 8080 erreicht, kann den
Bestand ändern, Systeme löschen und über `POST /api/admin/test` beliebige
Adressen und Ports vom Leitstand aus anwählen lassen — aus einem Netz heraus,
das dafür gebaut ist, überall hinzukommen. Zugangsdaten gehen nur maskiert nach
außen, das ist der einzige Teil, der heute schon stimmt. Bisher trägt das nur
die Annahme, dass der Port ausschließlich im vertrauten Netz hängt. Das ist eine
Annahme, keine Maßnahme.

**Wo.** [`server/src/server.js`](server/src/server.js) — alle Endpunkte unter
`/api/admin/`, dazu `/api/incidents/*/ack` und `/api/hosts/*/silence`.

**Fertig, wenn.** Schreibende Aufrufe brauchen einen Nachweis: als kleinster
tragfähiger Schritt ein Token aus `secrets.json`, das die Oberfläche beim Laden
erhält und mitschickt; besser die in der Architektur vorgesehene Anmeldung über
den vorhandenen OIDC-Anbieter. Lesende Endpunkte dürfen offen bleiben, solange
das ausdrücklich dasteht. Ein Test weist einen Aufruf ohne Nachweis mit 401 ab.

---

## 2. Mehr Details je System — die fehlenden Sammler

**Warum.** Vier von elf Systemtypen werden bisher nur angepingt — AdGuard Home
und Portainer sind seither dazugekommen. Sie stehen grün da, weil ein Port
offen ist; was auf ihnen los ist, weiß der Leitstand nicht. Genau das ist der
Unterschied zwischen „das Gerät antwortet" und „der Dienst tut, was er soll":
ein TrueNAS mit einem degradierten Pool antwortet tadellos.

**Wo.** Vorlage sind die fertigen Sammler — am nächsten liegen die beiden
zuletzt gebauten, weil sie klein sind:
[`adguard.js`](server/src/collectors/adguard.js) (Basic-Auth) und
[`portainer.js`](server/src/collectors/portainer.js) (Token im Kopf); ausführlicher
sind [`proxmox.js`](server/src/collectors/proxmox.js) und
[`opnsense.js`](server/src/collectors/opnsense.js).
Angemeldet wird in [`collectors/index.js`](server/src/collectors/index.js)
(`makeCollectors` und `TESTERS`), Zugangsfelder in
[`ui/assets/app.js`](ui/assets/app.js) (`zugangsFelder`), Endpunkte und
Kennzahlen je System stehen fertig recherchiert in
[`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md).

**Für jeden gilt:** Sammler liefert `{ ...kennzahlen, status?, note?, error? }`;
ein erreichbares System mit abgelehntem Zugang geht auf Gelb statt still ohne
Werte dazustehen; die Diagnose
([`server/src/diagnose.js`](server/src/diagnose.js)) zeigt jeden einzelnen
Aufruf mit Antwort; ein Test läuft gegen einen nachgebauten Dienst wie
[`server/test/fake-dienste.js`](server/test/fake-dienste.js). Für Sammler, die
sich wie AdGuard und Portainer verhalten (eine Kopfzeile, feste Pfade, JSON),
genügt in der Diagnose ein Eintrag in `EINFACH` — der Weg dorthin ist schon
gebaut.

- [x] **2.1 AdGuard Home** — gebaut:
      [`server/src/collectors/adguard.js`](server/src/collectors/adguard.js).
      Anmeldung mit Benutzer und Passwort der Oberfläche (einen eigenen
      Nur-Lese-Zugang kennt AdGuard nicht), gelesen werden `/control/status`,
      `/control/stats`, `/control/filtering/status` und `/control/dns_info`.
      Ampel: DNS-Dienst steht → rot; **Schutz oder Filterung abgeschaltet** →
      gelb (das sieht ein offener Port nie); Ø Bearbeitungszeit > 100 ms → gelb.
      Zwei Fallen sind unterwegs aufgefallen und stehen im Sammler beschrieben:
      das Statistikfenster ist einstellbar (24 h bis 90 Tage — der Sammler
      summiert bei Stundeneimern die letzten 24 und benennt sonst den echten
      Zeitraum), und `avg_processing_time` kommt je nach Fassung in Sekunden
      oder Millisekunden. **Nicht gebaut, weil die API es nicht hergibt:**
      Upstream-Fehler. Dafür gibt es keine Zahl — also steht dort keine.
- [ ] **2.2 TrueNAS SCALE** — `/api/v2.0/pool`, `/alert/list`, `/disk`.
      Pool-Zustand und Belegung, Scrub-Alter, SMART, Replikation. Ampel: Pool
      nicht `ONLINE` → rot, Scrub älter als 35 Tage → gelb.
- [x] **2.3 Portainer** — gebaut:
      [`server/src/collectors/portainer.js`](server/src/collectors/portainer.js).
      Die Zahlen kommen aus der Momentaufnahme, die Portainer je Umgebung
      ohnehin zieht (ein Aufruf für alles); die Containerliste wird nur geholt,
      um den Container zu **benennen**, der klemmt. Ampel: keine Umgebung
      antwortet → rot; einzelne Umgebung still, `unhealthy`, Neustartschleife
      oder Exit 137 → gelb mit Namen. Wichtig und leicht zu übersehen: fehlen
      die Rechte, liefert Portainer eine **leere Liste** statt einer
      Fehlermeldung — das wird ausdrücklich als Rechteproblem gemeldet, sonst
      stünde da eine ruhige Null, wo Dutzende Container laufen. **Nicht gebaut:**
      der Neustartzähler; er stünde nur in einem `inspect` je Container, und
      der Zustand `restarting` samt Exit-Code sagt dasselbe billiger.
- [ ] **2.4 Mailcow** — `/api/v1/get/mailq/all`, `/get/status/containers`,
      `/get/status/vmail`. Warteschlange, Domains, Postfächer, Containerzustand.
      Ampel: Queue > 25 gelb, > 100 rot.
- [ ] **2.5 Home Assistant** — `/api/states`, `/api/config`. Entitäten gesamt
      und `unavailable`, Automationen, Fassung. Nicht verfügbare Entitäten sind
      meist Information, keine Störung — gruppierte Ausfälle hinter einem
      Zigbee-Router sind die Ausnahme und der eigentliche Fund.
- [~] **2.6 pfSense** — gebaut, in der Praxis aber meist nicht nutzbar:
      [`server/src/collectors/pfsense.js`](server/src/collectors/pfsense.js).
      **Das Paket `pfSense-pkg-API` steht nicht im Paketverzeichnis von
      pfSense** — es ist ein Fremdprojekt, wird von Hand aus dessen
      Veröffentlichungen installiert, und für neuere pfSense-Fassungen gibt es
      nicht immer eine passende. Wer es nicht hat, bekommt weiterhin nur
      Erreichbarkeit. Der Sammler bleibt stehen: er ist geprüft und kostet
      nichts, solange keine Zugangsdaten hinterlegt sind.
      Bliebe als Weg nur SSH — und der ist bewusst verworfen, weil er einen
      SSH-Client ins Abbild und einen privaten Schlüssel ins Volume brächte.
      Wer pfSense wirklich auswerten will, hat damit zwei ehrliche
      Möglichkeiten: das Paket auftreiben, oder auf OPNsense wechseln, das
      eine Schnittstelle ab Werk hat.
      **Entschieden gegen SSH**, für das Paket `pfSense-pkg-API`: der Weg über
      SSH hätte einen Client im Abbild, einen privaten Schlüssel im Volume und
      das Auswerten von Textausgaben verlangt — der Dienst soll nur lesen und
      sonst nichts können. Mit dem Paket fällt pfSense in dasselbe Muster wie
      alles andere: eine Kopfzeile, feste Pfade, JSON.
      Beide Fassungen des Pakets werden gefunden (v2 mit `X-API-Key` unter
      `/api/v2/…`, v1 mit `Authorization` unter `/api/v1/…`) — eingetragen
      werden muss nur der Zugang.
      Geliefert wird dasselbe wie bei OPNsense, plus drei Dinge, die OPNsense
      hier noch nicht hat: **Gateways** mit Zustand, Latenz und Verlust,
      die **Zustandstabelle** und die **CARP**-Rolle. Ampel: Gateway `down` →
      rot, Zustandstabelle > 90 % → rot; CARP-Rolle und ausstehende
      Aktualisierung bleiben Notizen.
      **Vorbehalt:** die Antwortfelder des Pakets sind nirgends verbindlich
      beschrieben. Jedes Feld kennt deshalb mehrere mögliche Namen, was nicht
      kommt bleibt null, und die Diagnose zeigt zu jedem Aufruf die
      tatsächlichen Feldnamen. Ein Test hält ausdrücklich fest, dass eine
      unbekannte Antwortgestalt zu Strichen führt und nicht zum Absturz —
      nachziehen lässt sich der Sammler dann gegen einen echten Bericht.
- [x] **2.7 OPNsense vervollständigen** — gebaut: **Gateways**
      (`/api/routes/gateway/status`), **Zustandstabelle**
      (`/api/diagnostics/firewall/pf_statistics/state`) und **CARP**
      (`/api/diagnostics/interface/get_vip_status`, ältere Fassung
      `getVipStatus`). Damit liefern beide Firewall-Bauarten dasselbe, unter
      denselben Feldnamen, und die Oberfläche unterscheidet sie nicht mehr.
      Ampel wie bei pfSense: Gateway `down` → rot, Zustandstabelle > 90 % →
      rot und > 80 % → gelb, Verlust ab 2 % → gelb; CARP-Rolle bleibt eine
      Notiz. Drei Eigenheiten stehen im Sammler beschrieben und je in einem
      Test: `status: "none"` heißt bei OPNsense „steht, wird nicht überwacht"
      und nicht „unbekannt"; `~` bei Latenz und Verlust heißt „nicht gemessen"
      und wird zu null statt zu 0; und die Zahl der Zustandstabelle liegt je
      nach Fassung flach oder in einem Unterobjekt, wird also über mehrere
      Ebenen gesucht. **Offen bleiben allein die HAProxy-Backends** — die
      hängen an einem eigenen Plugin.
      **Erledigt davon:** die Schnittstellen. Je Leitung kommen Durchsatz in
      beide Richtungen, Pakete je Sekunde, Fehler, Verwürfe und Kollisionen;
      Verbindungszustand, Beschreibung und MTU aus
      `/api/interfaces/overview/export`, sofern die Fassung ihn kennt. Jede
      Leitung bekommt eine eigene Zeitreihe (`k:"i"`, siehe ARCHITECTURE.md) und
      auf der Systemseite ein eigenes Diagramm. Fehler und Verwürfe werden als
      Stand **und** als Zuwachs seit dem letzten Durchlauf geführt — nur der
      Zuwachs ist eine Nachricht, und eine Ampel machen sie bewusst nicht.

- [x] **2.8 Beide Enden einer VPN-Strecke** — gebaut. Ein Tunnel darf neben
      `peer` ein `peerB` benennen: den Peer, den die *andere* Firewall meldet.
      Der Anlass kam aus dem Betrieb — eine verknüpfte Strecke, und die
      Gegenzeile in der Gegenstellenliste behauptete trotzdem, zu keiner
      Strecke zu gehören. Sie tat es zu Recht: verknüpft war nur ein Ende.
      Für den Zustand zählt jetzt das **frischere** der beiden (WireGuard
      erneuert den Handshake nur bei Verkehr, und die Firewalls werden zu
      verschiedenen Zeitpunkten abgefragt); liegen sie weit auseinander, ist
      das eine Notiz — dieselbe Strecke wäre sich einig.
      Dazu werden **Tunneladressen und Netze gelesen** statt abgeschrieben:
      was eine Firewall als `allowed-ips` meldet, ist die Adresse des anderen
      Endes (/32 bzw. /128) und die Netze dahinter. Beides steht an der
      Strecke und lässt sich im Formular als `probe.ip` bzw. `net` übernehmen
      — angeboten, nicht stillschweigend eingetragen: welches Ende von hier
      aus erreichbar ist, weiß der Betreiber und nicht der Dienst.

- [x] **2.9 Datastores des Backup Servers** — gebaut. Bisher war ein
      Datastore ein Prozentsatz. Jetzt steht je Datastore auch der freie
      Platz (von PBS, nicht aus `total − used` gerechnet — bei ZFS mit
      Reservierungen wäre das falsch), die Gesamtgröße, PBS' eigene
      Schätzung, *wann er voll ist*, sowie die letzte Sicherung, das letzte
      Aufräumen und die letzte Prüfung, je mit Erfolg oder Fehlschlag. „Nie
      geprüft" ist eine Auskunft und steht als solche da. Ohne
      `estimated-full-date` wird nichts hochgerechnet.

- [x] **2.10 Abgelaufene eigensignierte Zertifikate** — erledigt. Sie
      bezeugen keine Herkunft, sondern tragen nur einen Schlüssel; läuft
      eines ab, ändert sich für den Betrieb nichts. Eine rote Ampel dafür ist
      genau die Meldung, die man zu übergehen lernt — und mit ihr die
      nächste, die zählt. Sie bekommen deshalb keine (`tls_selfsigned_ignore`,
      Vorgabe `true`), stehen aber weiter in der Zertifikatsliste, dort als
      „nicht bewertet". Einzelne Systeme: `tls_ignore: true`.

- [x] **2.11 Fassung einer OPNsense ohne anstehendes Update** — erledigt.
      `firmware/status` nennt `product_version` nur, wenn es zu den
      Aktualisierungen etwas zu sagen gibt; auf einem gepflegten Gerät fehlte
      die Fassung deshalb, auf einem vernachlässigten stand sie da. Gefragt
      wird jetzt der Reihe nach: `firmware/status`, `firmware/info`, zuletzt
      die Zeile aus `system_information.versions`.

---

## 3. Alarmierung — Push-Kanäle und Totmannschalter

**Warum.** Das ist die größte Lücke im ganzen Werkzeug: Bis hierhin ist der
Leitstand ein Bildschirm, kein Wecker. Wer nicht hinsieht, erfährt nichts —
auch nicht um drei Uhr nachts, wenn der Speicher volläuft. Und schweigt der
Leitstand selbst, merkt es niemand: ein abgestürzter Wächter sieht aus wie
ein ruhiges Netz.

**Wo.** Neu (`server/src/alarm.js`), angestoßen aus
[`Engine#reconcile`](server/src/engine.js); die Oberfläche hat unter
*Benachrichtigungen* bereits eine Ansicht mit Beispiel
([`ui/assets/examples.js`](ui/assets/examples.js), `route`).

**Fertig, wenn.** Eine neue Störung ab einer einstellbaren Schwere geht binnen
Sekunden als Push hinaus (ntfy zuerst — kein Konto, kein Anbieter dazwischen);
Quittieren und Stummschalten unterdrücken Wiederholungen; ein Wiederholtakt
verhindert die Alarmflut; und der Kern meldet sich minütlich bei einem externen
Healthcheck, damit sein eigenes Verstummen auffällt. Kanal, Ziel und Schwelle
stehen in der Oberfläche, nicht im Code.

---

## 4. Zeitreihen und eine Detailseite je System — **erledigt**

**Was daraus geworden ist.** Eine eigene, sehr kleine Ablage
([`server/src/verlauf.js`](server/src/verlauf.js)): eine Datei je Tag im Volume
(`/data/verlauf/2026-08-21.jsonl`), eine Zeile je Messpunkt als JSON, ein Punkt
je Minute und Gegenstand, 30 Tage lang. Angehängt wird ohne Sperre; ein
abgeschnittener Schreibvorgang kostet eine Zeile, nicht die Datei. Innerhalb
eines Taktes bleiben Mittel-, Kleinst- und Größtwert erhalten, und die
schlechteste Ampel gewinnt — ein Aussetzer von zwanzig Sekunden verschwindet
nicht im Mittelwert.

Ein Klick auf ein System führt auf `#/system/<kennung>`: Verlauf über 24 h, 7
oder 30 Tage (Antwortzeit mit Spannweite, CPU, RAM, Speicher, Durchsatz, dazu
ein Ampelband), darunter Stammdaten, Prüfungen, Zertifikat, Auslastung, offene
Meldungen und die Diagnose. Der Inspector für Systeme ist damit entfallen —
zwei Darstellungen desselben Gegenstands driften auseinander. Wo nichts
gemessen wurde, ist die Linie **unterbrochen**, nicht durchgezogen.

Abrufbar auch ohne Oberfläche: `GET /api/verlauf/<kennung>?tage=7`. Takt und
Aufbewahrung stehen als `verlauf_takt` / `verlauf_tage` in den Schwellwerten;
was tatsächlich auf der Platte liegt — und ob zuletzt geschrieben werden
konnte — steht unter *Einstellungen → Dieser Dienst*.

**Offen geblieben:** VictoriaMetrics (die Architektur sieht sie vor; das
Zeilenformat ist so gewählt, dass sie sich daraus befüllen ließe) und ein
Vergleich zweier Zeiträume nebeneinander.

---

## 5. Alarm-Postfach (Stufe 4)

**Warum.** smartd, ACME-Clients, vzdump-Berichte und Herstellergeräte melden
verlässlich per SMTP und sonst gar nicht. Ohne diesen Kanal bleibt ein Teil der
Anlage stumm, und zwar der Teil, der am ehesten kaputtgeht: die Platten.

**Wo.** Neu (IMAP IDLE + Regelliste), Ereignisse in dasselbe Modell wie die
Abfragen. Die Ansicht *Post* erklärt den Weg bereits und zeigt ein Beispiel.

**Fertig, wenn.** Eine eingehende Mail wird gegen eine geordnete Regelliste
geprüft und erzeugt ein Ereignis; **was keine Regel trifft, wird nicht
verworfen**, sondern als „ohne Regel" sichtbar — samt Schaltfläche, aus genau
dieser Nachricht eine Regel zu machen.

---

## 6. Wartungsfenster

**Warum.** Ein geplanter Neustart darf keine Störung erzeugen; sonst gewöhnt man
sich daran, Meldungen wegzuklicken, und genau dann geht die echte unter.

**Wo.** [`server/src/engine.js`](server/src/engine.js) neben `silence`, das die
halbe Arbeit schon tut — es fehlen Wiederholung (jeden Sonntag 03:00) und die
Zuordnung zu Standort oder Systemgruppe statt zu einem einzelnen Gerät.

---

## Kleinkram aus dem Betrieb

- [ ] **Herzschlag im Ereignisstrom.** `/api/stream` schickt nur, wenn ein
      Durchlauf fertig ist. Steht das Intervall hoch oder dauert ein Durchlauf,
      hält ein Reverse Proxy die Verbindung für tot und kappt sie. Ein `: ping`
      alle 20 s und `X-Accel-Buffering: no` beim Öffnen kosten drei Zeilen.
      → [`server/src/server.js`](server/src/server.js), `/api/stream`.
- [ ] **Prüfziel im Inspector zeigen.** Seit Port- und TLS-Prüfung zwei Ziele
      versuchen (IP, dann Name aus der Adresse), steht im Ergebnis ein Feld
      `ziel` — `hostView` reicht es nicht weiter. In der Liste „Prüfungen im
      letzten Durchlauf" gehört hin, *wer* geantwortet hat.
      → [`server/src/api.js`](server/src/api.js), `hostView.checks`.
- [ ] **Doppelte Fehlermeldung zusammenfassen.** Ist ein Port zu, meldet der
      Zustand „tcp/443 Verbindung abgewiesen, tls/443 Verbindung abgewiesen" —
      zweimal dieselbe Ursache. Nach Port und Text gruppieren.
      → [`server/src/engine.js`](server/src/engine.js), `Teilausfall`.
- [ ] **Prüfungen je System nebeneinander laufen lassen.** Sie laufen
      nacheinander; mit zwei Zielen kostet ein totes System bis zu zweimal das
      Zeitlimit je Prüfung. Systeme untereinander sind längst nebenläufig.
      → [`server/src/engine.js`](server/src/engine.js), `#checkHost`.
- [ ] **Standortkürzel ohne Eintrag.** Fehlt das Kürzel, leitet `shortOf` zwei
      bis vier Stellen aus der Kennung ab — in Filterleiste und Topologie sieht
      das aus wie ein gepflegtes Kürzel. In der Verwaltung steht „anpassen"
      daran, überall sonst nicht. Entweder überall kennzeichnen oder beim Laden
      einmalig ergänzen. → [`server/src/api.js`](server/src/api.js), `shortOf`.
- [ ] **Zugangsdaten sichern.** Das Archiv nimmt nur `inventory.yaml` mit;
      `secrets.json` bleibt außen vor — mit Absicht, aber nirgends steht das.
      Entweder verschlüsselt mitnehmen oder im Reiter *Sicherung* dazuschreiben,
      dass Zugangsdaten nicht Teil eines zurückgeholten Standes sind.
- [x] **Testzahl im README.** Stand an zwei Stellen als Zahl und veraltete bei
      jedem Zulauf. Jetzt steht der Satz ohne Zahl.
- [ ] **Fehler beim Zusammenbauen des Zustands sind unsichtbar.** Der
      Healthcheck fragt `/api/version`, damit ein Anzeigefehler keine
      Neustartschleife auslöst — richtig so. Nur merkt dann niemand, wenn
      `/api/state` dauerhaft 500 liefert. Ein Zähler in `/api/version` und eine
      Zeile im Log wären genug.
- [ ] **Ein Zeichenfehler in einer Ansicht hinterlässt eine leere Seite.**
      Wirft ein Renderer, bleibt `#wrap` leer und die Ausnahme wird im
      Zustandsstrom verschluckt. Der Aufruf gehört in ein `try`, mit einer roten
      Kachel statt einer weißen Fläche. → [`ui/assets/app.js`](ui/assets/app.js),
      `render()`.

---

## Fragen, die vor dem Bauen entschieden gehören

- **Datenbank — ja, aber wofür?** Der Bestand bleibt YAML: klein, selten
  geändert, von Hand lesbar, mit `cp` zu retten. Zeitreihen sind der Fall, der
  eine echte Ablage verdient (Punkt 4). Beides zu vermischen macht die
  Konfiguration schwerer zu retten, ohne die Messreihe besser zu machen.
- **Zweiter Leitstand.** Die Architektur nennt einen kalten Zwilling auf
  `pve-rz-01`. Solange der Erste nicht alarmiert, wäre ein Zweiter nur doppelt
  stumm — erst Punkt 3, dann diese Frage.
- **Wie weit darf der Leitstand eingreifen?** Heute liest er ausschließlich.
  Steuerbefehle (Dienst neu starten, Tunnel neu aushandeln) sind vorgesehen,
  aber nur über einen getrennten, ausdrücklich freigeschalteten Pfad. Diese
  Grenze sollte man bewusst überschreiten, nicht nebenbei.
