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

**Warum.** Sechs von elf Systemtypen werden bisher nur angepingt. Sie stehen
grün da, weil ein Port offen ist — was auf ihnen los ist, weiß der Leitstand
nicht. Genau das ist der Unterschied zwischen „das Gerät antwortet" und „der
Dienst tut, was er soll": ein TrueNAS mit einem degradierten Pool antwortet
tadellos.

**Wo.** Vorlage sind die beiden fertigen Sammler:
[`server/src/collectors/proxmox.js`](server/src/collectors/proxmox.js) und
[`server/src/collectors/opnsense.js`](server/src/collectors/opnsense.js).
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
[`server/test/fake-proxmox.js`](server/test/fake-proxmox.js).

- [ ] **2.1 AdGuard Home** — `/control/status`, `/control/stats`. Anfragen 24 h,
      Blockanteil, Ø Antwortzeit, Upstream-Fehler, Fassung. Ampel: Ø > 100 ms
      gelb. Der DNS-Filter ist der Dienst, dessen Ausfall im ganzen Netz sofort
      weh tut — er verdient mehr als einen offenen Port. *(Beim Anlegen liegt
      die Oberfläche oft hinter einem Reverse Proxy; die Prüfung versucht
      deshalb IP und Namen aus der Adresse, siehe `probe.js`.)*
- [ ] **2.2 TrueNAS SCALE** — `/api/v2.0/pool`, `/alert/list`, `/disk`.
      Pool-Zustand und Belegung, Scrub-Alter, SMART, Replikation. Ampel: Pool
      nicht `ONLINE` → rot, Scrub älter als 35 Tage → gelb.
- [ ] **2.3 Portainer** — `/api/endpoints`, `/api/stacks`, Containerliste je
      Endpunkt. Stacks, Container gesamt/laufend, `unhealthy`, Neustartzähler.
      Ampel: Restart-Schleife → gelb, Exit 137 → gelb mit Hinweis auf die
      Speichergrenze.
- [ ] **2.4 Mailcow** — `/api/v1/get/mailq/all`, `/get/status/containers`,
      `/get/status/vmail`. Warteschlange, Domains, Postfächer, Containerzustand.
      Ampel: Queue > 25 gelb, > 100 rot.
- [ ] **2.5 Home Assistant** — `/api/states`, `/api/config`. Entitäten gesamt
      und `unavailable`, Automationen, Fassung. Nicht verfügbare Entitäten sind
      meist Information, keine Störung — gruppierte Ausfälle hinter einem
      Zigbee-Router sind die Ausnahme und der eigentliche Fund.
- [ ] **2.6 pfSense** — kein offizielles REST. Weg (a) aus den Datenquellen:
      SSH mit eigenem Schlüssel, `pfctl -si`, `wg show all dump`. Bringt
      Zustandstabelle, Interface-Zähler, Gateways und die WireGuard-Peers, die
      heute nur OPNsense liefert. Erst entscheiden, ob SSH aus dem Behälter
      heraus in Ordnung geht.
- [ ] **2.7 OPNsense vervollständigen** — offen sind Zustandstabelle, CARP und
      Gateway-Status. Der Sammler steht, es fehlen die Abrufe.

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

## 4. Zeitreihen und eine Detailseite je System

**Warum.** Messwerte halten heute 120 Punkte im Arbeitsspeicher, also gut eine
halbe Stunde, und ein Neustart wischt sie weg. Damit lässt sich die Frage
„war das gestern Nacht auch schon so?" nicht beantworten — und das ist die
Frage, die nach jeder Störung kommt.

**Wo.** [`server/src/engine.js`](server/src/engine.js) (`push`, `hist`),
Ablage im Volume neben dem Bestand. Die Architektur sieht VictoriaMetrics vor;
für den Anfang tut es eine schlanke eigene Datei je Tag, solange das Format
später auslesbar bleibt.

**Fertig, wenn.** Ein Klick auf ein System führt auf eine eigene Seite mit
Verlauf über Tage — Antwortzeit, CPU, RAM, Platte, Durchsatz —, und die Werte
überleben einen Neustart des Behälters.

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
- [ ] **Testzahl im README.** Steht an zwei Stellen als Zahl und veraltet bei
      jedem Zulauf. Entweder aus dem Testlauf erzeugen oder den Satz ohne Zahl
      schreiben.
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
