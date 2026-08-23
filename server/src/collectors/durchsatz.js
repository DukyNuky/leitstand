/* Aus Zählerständen wird Durchsatz — für jede Firewall dieselbe Rechnung.

   OPNsense und pfSense liefern beide keine Bandbreite, sondern Zähler:
   Bytes und Pakete seit dem letzten Neustart des Geräts. Eine Rate
   entsteht erst aus der Differenz zweier Abfragen. Das ist bei beiden
   dieselbe Arbeit — und weil sie an drei Stellen leicht falsch wird,
   steht sie genau einmal hier:

   1. **Vor der zweiten Abfrage gibt es nichts.** Kein Durchsatz, keine
      Null. Eine Null läse sich wie „gerade nichts los", und das ist eine
      Behauptung über einen Zeitraum, den niemand gemessen hat.

   2. **Läuft ein Zähler zurück, hat das Gerät neu gestartet** — oder es
      antwortet ein anderes unter derselben Adresse. Aus so einer Differenz
      eine Rate zu rechnen ergäbe eine große Zufallszahl.

   3. **Fehler und Verwürfe sind Stände, keine Ereignisse.** 17 Fehler
      können drei Monate alt sein. Was zählt, ist der Zuwachs seit der
      letzten Abfrage; beides wird geführt und getrennt gemeldet.

   Was hereingegeben wird, ist eine Liste bereits entpackter
   Schnittstellen — jedes Gerät bringt seine Zählerstände in einer eigenen
   Verpackung mit, und die auszuwickeln bleibt Sache des jeweiligen
   Sammlers. Was herauskommt, ist bei beiden dieselbe Gestalt, damit die
   Oberfläche sie nicht auseinanderhalten muss. */

/* Der Schlüssel enthält die Adresse, nicht nur die Kennung: zeigt ein
   System plötzlich woandershin, antwortet ein anderes Gerät mit ganz
   anderen Zählerständen. Die Differenz dazwischen wäre kein Durchsatz. */
const zaehlerstand = new Map();

/* Nur für Tests: den gemerkten Stand vergessen, damit zwei Fälle
   hintereinander nicht die Zähler des jeweils anderen sehen. */
export function vergiss(schluessel = null) {
  if (schluessel) zaehlerstand.delete(schluessel);
  else zaehlerstand.clear();
}

/* `physisch`: [{ name, label, rx, tx, rxPakete, txPakete, fehler,
                  verworfen, kollisionen }]
   `zusatz`:   Map name -> { link, beschreibung, mtu }  (darf leer sein)

   Ergebnis: { interfaces, thrIn, thrOut, thrQuelle, ifNote } — oder
   lauter null, wenn nichts Verwertbares dabei war. */
export function ausZaehlern(schluessel, physisch, zusatz = new Map(), jetzt = Date.now()) {
  const leer = { interfaces: null, thrIn: null, thrOut: null, thrQuelle: null, ifNote: null };
  if (!Array.isArray(physisch) || !physisch.length) return leer;

  const vorher = zaehlerstand.get(schluessel);
  zaehlerstand.set(schluessel, {
    t: jetzt,
    je: Object.fromEntries(physisch.map(p => [p.name, {
      rx: p.rx, tx: p.tx, rxPakete: p.rxPakete, txPakete: p.txPakete,
      fehler: p.fehler, verworfen: p.verworfen
    }]))
  });

  const sekunden = vorher ? (jetzt - vorher.t) / 1000 : 0;
  const zuwachs = (name, feld, wert) => {
    const alt = vorher?.je?.[name]?.[feld];
    if (alt == null || wert == null || sekunden <= 0) return null;
    const delta = wert - alt;
    return delta < 0 ? null : delta;              /* Zähler zurückgesetzt */
  };
  const mbit = (name, feld, wert) => {
    const d = zuwachs(name, feld, wert);
    return d == null ? null : Math.round((d * 8) / sekunden / 1000) / 1000;
  };
  const proSekunde = (name, feld, wert) => {
    const d = zuwachs(name, feld, wert);
    return d == null ? null : Math.round(d / sekunden);
  };

  const interfaces = physisch.map(p => {
    const z = zusatz.get(p.name) || {};
    return {
      name: p.name,
      label: p.label || p.name,
      beschreibung: z.beschreibung ?? p.beschreibung ?? null,
      link: z.link ?? p.link ?? null,             /* "up" / "down" / null = unbekannt */
      mtu: z.mtu ?? p.mtu ?? null,
      in: mbit(p.name, "rx", p.rx),
      out: mbit(p.name, "tx", p.tx),
      inPps: proSekunde(p.name, "rxPakete", p.rxPakete),
      outPps: proSekunde(p.name, "txPakete", p.txPakete),
      rxBytes: p.rx ?? null, txBytes: p.tx ?? null,
      fehler: p.fehler ?? null,
      fehlerNeu: zuwachs(p.name, "fehler", p.fehler),
      verworfen: p.verworfen ?? null,
      verworfenNeu: zuwachs(p.name, "verworfen", p.verworfen),
      kollisionen: p.kollisionen ?? null
    };
  });

  /* Gibt es eine ausdrücklich als WAN beschriebene Schnittstelle, zählt
     die — sonst die Summe über alles Physische. */
  const wan = interfaces.find(i => /^wan/i.test(i.label));
  const summe = f => {
    const bekannt = interfaces.map(i => i[f]).filter(v => v != null);
    return bekannt.length ? Math.round(bekannt.reduce((a, b) => a + b, 0) * 1000) / 1000 : null;
  };

  /* Zuwachs an Fehlern oder Verwürfen ist eine Notiz, keine Ampel: ein
     einzelnes verworfenes Paket auf einer ausgelasteten Leitung ist
     normal, und eine Schwelle dafür wäre geraten. Geratene Schwellen
     erzeugen Fehlalarme, und Fehlalarme bringen eine Überwachung um
     ihren Zweck. Sichtbar gehört es trotzdem. */
  const auffaellig = interfaces.filter(i => (i.fehlerNeu || 0) + (i.verworfenNeu || 0) > 0);

  return {
    interfaces,
    thrIn: wan ? wan.in : summe("in"),
    thrOut: wan ? wan.out : summe("out"),
    thrQuelle: wan ? wan.label : "alle Schnittstellen",
    ifNote: auffaellig.length
      ? auffaellig.map(i => `${i.label}: ${(i.fehlerNeu || 0)} Fehler, ${(i.verworfenNeu || 0)} verworfen`).join(" · ")
      : null
  };
}

/* Schnittstellen, die keine eigene Leitung sind — Loopback, Kapselung,
   Protokoll- und Abgleichsgeräte. Bei beiden Herstellern dieselben Namen. */
export const NICHT_PHYSISCH = /^(lo|enc|pflog|pfsync|ipfw|ovpn|tun|tap|gif|gre|bridge|npt)/;

export const zahl = v => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
