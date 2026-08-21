/* Zeitreihen — die Messwerte, die einen Neustart überleben.

   Die Zustandsmaschine hält je Gegenstand ein paar Dutzend Punkte im
   Arbeitsspeicher. Das reicht für die Sparkline in der Tabelle und für
   sonst nichts: nach einer halben Stunde ist der älteste Punkt heraus,
   nach einem Neustart alle. Die Frage nach einer Störung lautet aber
   „war das gestern Nacht auch schon so?" — und die beantwortet nur eine
   Ablage auf der Platte.

   Ablage: eine Datei je Tag, eine Zeile je Messpunkt, JSON pro Zeile.

     verlauf/2026-08-21.jsonl
     {"t":1755765600,"k":"h","id":"pve-01","ms":12,"min":10,"max":41,"n":4,"cpu":3.5,"ram":61,"st":"ok"}

   Bewusst keine Datenbank: eine Zeile je Punkt lässt sich anhängen, ohne
   etwas zu sperren, überlebt einen abgeschnittenen Schreibvorgang (die
   letzte Zeile ist dann kaputt, nicht die Datei), und ist mit `grep`,
   `jq` oder drei Zeilen Python auslesbar. Wenn später eine echte
   Zeitreihendatenbank dazukommt, ist das hier das Format, aus dem sie
   befüllt wird — nichts geht dabei verloren.

   Verdichtet wird auf einen Punkt je Takt (Vorgabe: eine Minute). Bei
   fünfzehn Sekunden Abstand fielen sonst 5760 Zeilen je System und Tag
   an, ohne dass ein Verlauf über Tage dadurch mehr aussagt. Was innerhalb
   des Taktes gemessen wurde, geht trotzdem nicht verloren: Mittel-,
   Kleinst- und Größtwert stehen in der Zeile, und die schlechteste Ampel
   des Taktes gewinnt — ein Aussetzer von zwanzig Sekunden verschwindet
   also nicht im Mittelwert.

   Platzbedarf: rund 100 Byte je Zeile, ein Punkt je Minute und Gegenstand,
   macht etwa 0,15 MB je Gegenstand und Tag. Zwanzig Systeme über dreißig
   Tage sind knapp 90 MB. Wem das zu viel ist, stellt den Takt hoch oder
   die Aufbewahrung herunter (verlauf_takt, verlauf_tage). */

import fs from "node:fs";
import path from "node:path";

const TAGDATEI = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const SEV = { ok: 0, idle: 0, unknown: 0, info: 1, warn: 2, crit: 3 };

/* Welche Kennzahlen mitgeschrieben werden. Mehr als diese kennt die
   Detailseite nicht — und was sie nicht zeichnen kann, muss auch nicht
   dreißig Tage lang auf der Platte liegen. */
export const REIHEN = [
  { key: "ms",   label: "Antwortzeit", einheit: "ms" },
  { key: "cpu",  label: "CPU",         einheit: "%" },
  { key: "ram",  label: "RAM",         einheit: "%" },
  { key: "disk", label: "Speicher",    einheit: "%" },
  { key: "in",   label: "Durchsatz ein", einheit: "Mbit/s" },
  { key: "out",  label: "Durchsatz aus", einheit: "Mbit/s" }
];

/* Der Tag in Ortszeit — dieselbe Rechnung wie beim Bestandsarchiv. Wer
   um 23:50 auf die Platte schaut, sucht die Datei von heute, nicht die
   von morgen früh nach UTC. */
export function tagVon(ts) {
  const d = new Date(ts);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export class Verlauf {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.takt = takt(opts.takt);
    this.tage = tage(opts.tage);
    this.koerbe = new Map();      /* art|id -> laufender Korb */
    this.fertig = [];             /* abgeschlossene Körbe, noch nicht geschrieben */
    this.fehler = null;           /* letzter Schreibfehler — wird sichtbar gemacht, nicht verschluckt */
    this.zeilen = 0;              /* seit dem Start geschriebene Zeilen */
    this.#info = null;
  }

  /* Geänderte Schwellwerte greifen ohne Neustart; laufende Körbe bleiben,
     sie werden nur nach dem neuen Takt abgeschlossen. */
  einstellen({ takt: t, tage: n } = {}) {
    if (t != null) this.takt = takt(t);
    if (n != null) this.tage = tage(n);
  }

  /* ---------- Schreiben ---------- */

  /* Einen Messwert in den laufenden Korb legen. `werte` darf lückenhaft
     sein: was null ist, wird nicht gemittelt und steht später auch nicht
     in der Zeile — eine Kennzahl, die dieses System nicht liefert, soll
     keine Reihe aus lauter Nullen ergeben. */
  notiere(art, id, werte = {}, jetzt = Date.now()) {
    const slot = Math.floor(jetzt / 1000 / this.takt) * this.takt;
    const schluessel = `${art}|${id}`;
    let korb = this.koerbe.get(schluessel);
    if (korb && korb.slot !== slot) { this.fertig.push(korb); korb = null; }
    if (!korb) {
      korb = { slot, art, id, ms: [], werte: new Map(), st: null };
      this.koerbe.set(schluessel, korb);
    }
    if (Number.isFinite(werte.ms)) korb.ms.push(werte.ms);
    for (const { key } of REIHEN) {
      if (key === "ms") continue;
      const v = werte[key];
      if (Number.isFinite(v)) {
        const liste = korb.werte.get(key) || [];
        liste.push(v);
        korb.werte.set(key, liste);
      }
    }
    if (werte.st && (korb.st == null || (SEV[werte.st] ?? 0) > (SEV[korb.st] ?? 0))) korb.st = werte.st;
    return korb;
  }

  /* Alles wegschreiben, was abgeschlossen ist. Der Korb des laufenden
     Taktes bleibt offen — er wird erst vollständig, wenn der Takt vorbei
     ist. Aufgerufen nach jedem Durchlauf. */
  schreibe(jetzt = Date.now()) {
    const slot = Math.floor(jetzt / 1000 / this.takt) * this.takt;
    const raus = this.fertig;
    this.fertig = [];
    for (const [k, korb] of this.koerbe) if (korb.slot !== slot) { raus.push(korb); this.koerbe.delete(k); }
    return this.#schreibeKoerbe(raus);
  }

  /* Beim Herunterfahren: auch den laufenden Takt festhalten. Sonst fehlt
     nach jedem Neustart die letzte Minute — und ein Neustart passiert
     gern genau dann, wenn etwas los war. */
  schliesse() {
    const raus = [...this.fertig, ...this.koerbe.values()];
    this.fertig = [];
    this.koerbe.clear();
    return this.#schreibeKoerbe(raus);
  }

  #schreibeKoerbe(koerbe) {
    if (!koerbe.length) return 0;
    /* Nach Tag bündeln: ein Durchlauf über Mitternacht schreibt in zwei
       Dateien, und je Datei genügt ein einziger Anhängevorgang. */
    const jeTag = new Map();
    for (const korb of koerbe) {
      const tag = tagVon(korb.slot * 1000);
      const zeile = JSON.stringify(zeileVon(korb));
      jeTag.set(tag, (jeTag.get(tag) || "") + zeile + "\n");
    }
    let n = 0;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.#liesmich();
      for (const [tag, text] of jeTag) {
        const datei = path.join(this.dir, `${tag}.jsonl`);
        /* Wurde der letzte Schreibvorgang abgeschnitten (Strom weg mitten
           in der Zeile), fehlt am Dateiende der Zeilenumbruch. Ohne ihn
           klebte die nächste Zeile an der kaputten und wäre genauso
           unlesbar — aus einem verlorenen Punkt würden zwei. Das kostet
           einmal je Takt einen Blick auf das letzte Byte. */
        fs.appendFileSync(datei, (angebrochen(datei) ? "\n" : "") + text);
        n += text.split("\n").length - 1;
      }
      this.fehler = null;
      this.zeilen += n;
      this.#info = null;
      this.aufraeumen();
    } catch (e) {
      /* Eine volle Platte darf die Überwachung nicht anhalten — gemeldet
         wird sie trotzdem, sonst fehlt der Verlauf still. */
      this.fehler = e.message;
    }
    return n;
  }

  /* Was älter ist als die Aufbewahrung, fällt heraus. Nach Namen, nicht
     nach Änderungszeit: der Name ist der Tag, um den es geht. */
  aufraeumen(jetzt = Date.now()) {
    const grenze = tagVon(jetzt - this.tage * 86400000);
    let weg = 0;
    for (const n of this.#dateien()) {
      if (n.slice(0, 10) > grenze) continue;
      try { fs.rmSync(path.join(this.dir, n)); weg++; } catch {}
    }
    if (weg) this.#info = null;
    return weg;
  }

  /* ---------- Lesen ---------- */

  /* Die Reihe eines Gegenstands über die letzten `tage` Tage. Gelesen wird
     Datei für Datei; die Vorprüfung auf die Kennung im Text erspart es,
     jede Zeile zu zerlegen, die einem anderen System gehört. */
  reihe(id, { tage: wieviele = 7, art = null, jetzt = Date.now() } = {}) {
    const nadel = `"id":${JSON.stringify(String(id))}`;
    const vonTag = tagVon(jetzt - (Math.max(1, wieviele) - 1) * 86400000);
    const punkte = [];
    for (const name of this.#dateien()) {
      const tag = name.slice(0, 10);
      if (tag < vonTag) continue;
      let text;
      try { text = fs.readFileSync(path.join(this.dir, name), "utf8"); } catch { continue; }
      for (const zeile of text.split("\n")) {
        if (!zeile || !zeile.includes(nadel)) continue;
        let p;
        /* Eine abgeschnittene letzte Zeile (Absturz beim Schreiben) ist
           kein Grund, den ganzen Tag zu verwerfen. */
        try { p = JSON.parse(zeile); } catch { continue; }
        if (String(p.id) !== String(id)) continue;
        if (art && p.k !== art) continue;
        punkte.push(p);
      }
    }
    punkte.sort((a, b) => a.t - b.t);
    return punkte;
  }

  /* Für die Oberfläche: was liegt überhaupt da? */
  info() {
    if (this.#info && Date.now() - this.#info.stand < 60000) return this.#info.wert;
    const dateien = this.#dateien();
    let bytes = 0;
    for (const n of dateien) { try { bytes += fs.statSync(path.join(this.dir, n)).size; } catch {} }
    const wert = {
      verzeichnis: this.dir,
      takt: this.takt,
      tage: this.tage,
      vorhanden: dateien.length,
      seit: dateien[0]?.slice(0, 10) || null,
      bytes,
      fehler: this.fehler
    };
    this.#info = { stand: Date.now(), wert };
    return wert;
  }

  #info;
  #dateien() {
    try { return fs.readdirSync(this.dir).filter(n => TAGDATEI.test(n)).sort(); }
    catch { return []; }
  }

  /* Wer das Volume in die Hand bekommt, soll nicht raten müssen, was
     diese Dateien sind. Einmal angelegt, danach nie wieder angefasst. */
  #liesmich() {
    const datei = path.join(this.dir, "LIESMICH.md");
    if (fs.existsSync(datei)) return;
    fs.writeFileSync(datei, LIESMICH);
  }
}

/* Ein Korb wird zur Zeile. Kurze Schlüssel, weil davon je System und Tag
   1440 Stück anfallen; lesbar bleibt es trotzdem. */
function zeileVon(korb) {
  const z = { t: korb.slot, k: korb.art, id: korb.id };
  if (korb.ms.length) {
    z.ms = Math.round(mittel(korb.ms));
    const min = Math.min(...korb.ms), max = Math.max(...korb.ms);
    /* Kleinst- und Größtwert nur, wenn sie etwas hinzufügen. */
    if (min !== z.ms || max !== z.ms) { z.min = Math.round(min); z.max = Math.round(max); }
    if (korb.ms.length > 1) z.n = korb.ms.length;
  }
  for (const { key } of REIHEN) {
    if (key === "ms") continue;
    const liste = korb.werte.get(key);
    if (liste?.length) z[key] = rund(mittel(liste));
  }
  if (korb.st) z.st = korb.st;
  return z;
}

/* Endet die Datei mitten in einer Zeile? */
function angebrochen(datei) {
  try {
    const groesse = fs.statSync(datei).size;
    if (!groesse) return false;
    const fd = fs.openSync(datei, "r");
    const puffer = Buffer.alloc(1);
    try { fs.readSync(fd, puffer, 0, 1, groesse - 1); } finally { fs.closeSync(fd); }
    return puffer[0] !== 0x0a;
  } catch { return false; }
}

const mittel = a => a.reduce((x, y) => x + y, 0) / a.length;
const rund = v => Math.round(v * 10) / 10;
const takt = v => Math.min(3600, Math.max(15, Math.round(Number(v) || 60)));
const tage = v => Math.min(3650, Math.max(1, Math.round(Number(v) || 30)));

/* Viele Punkte auf wenige eindampfen, ohne Ausreißer zu verstecken:
   je Fenster der Mittelwert, aber das Kleinste und das Größte des
   Fensters bleiben stehen. Eine Woche im Minutentakt sind 10 080 Punkte —
   ein Diagramm von 900 Pixeln Breite kann sie nicht zeigen, und sie durch
   die Leitung zu schicken kostet nur Zeit. */
export function verdichte(punkte, ziel = 900) {
  if (punkte.length <= ziel) return punkte;
  const breite = Math.ceil(punkte.length / ziel);
  const out = [];
  for (let i = 0; i < punkte.length; i += breite) {
    const fenster = punkte.slice(i, i + breite);
    const z = { t: fenster[0].t, k: fenster[0].k, id: fenster[0].id };
    const ms = fenster.map(p => p.ms).filter(Number.isFinite);
    if (ms.length) {
      z.ms = Math.round(mittel(ms));
      z.min = Math.round(Math.min(...fenster.map(p => (Number.isFinite(p.min) ? p.min : p.ms)).filter(Number.isFinite)));
      z.max = Math.round(Math.max(...fenster.map(p => (Number.isFinite(p.max) ? p.max : p.ms)).filter(Number.isFinite)));
      z.n = fenster.reduce((a, p) => a + (p.n || 1), 0);
    }
    for (const { key } of REIHEN) {
      if (key === "ms") continue;
      const w = fenster.map(p => p[key]).filter(Number.isFinite);
      if (w.length) z[key] = rund(mittel(w));
    }
    const schlimmste = fenster.map(p => p.st).filter(Boolean)
      .sort((a, b) => (SEV[b] ?? 0) - (SEV[a] ?? 0))[0];
    if (schlimmste) z.st = schlimmste;
    out.push(z);
  }
  return out;
}

/* Welche Reihen in dieser Punktmenge überhaupt Werte haben. Die
   Detailseite zeichnet nur die — ein leeres Diagramm „CPU" unter einem
   System ohne Sammler wäre eine Behauptung. */
export function belegteReihen(punkte) {
  return REIHEN.filter(r => punkte.some(p => Number.isFinite(p[r.key])));
}

const LIESMICH = `# Zeitreihen des Leitstands

Eine Datei je Tag, eine Zeile je Messpunkt, JSON pro Zeile (NDJSON):

    {"t":1755765600,"k":"h","id":"pve-01","ms":12,"min":10,"max":41,"n":4,"cpu":3.5,"ram":61,"st":"ok"}

| Feld  | Bedeutung |
|-------|-----------|
| t     | Zeitpunkt, Sekunden seit 1970 (UTC), Beginn des Taktes |
| k     | \`h\` = System, \`t\` = Tunnel |
| id    | Kennung aus dem Bestand |
| ms    | Antwortzeit, Mittel über den Takt |
| min/max/n | Kleinst-, Größtwert und Anzahl der Messungen im Takt |
| cpu, ram, disk | Auslastung in Prozent, Mittel über den Takt |
| in, out | Durchsatz in Mbit/s, Mittel über den Takt |
| st    | schlechteste Ampel des Taktes: ok, warn, crit, idle |

Fehlt ein Feld, wurde es nicht gemessen — es ist nicht null und erst recht
nicht 0. Die Dateien werden nur angehängt; die älteste fällt heraus, sobald
die eingestellte Aufbewahrung (verlauf_tage) überschritten ist.

Auswerten ohne den Leitstand, etwa die Antwortzeit eines Systems:

    grep '"id":"pve-01"' 2026-08-21.jsonl | jq -r '[.t,.ms] | @tsv'
`;
