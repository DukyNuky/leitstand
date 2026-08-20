/* Welche Fassung läuft hier gerade?

   Bei automatischem Redeploy ist das die Frage, die man am häufigsten hat und
   am schlechtesten beantworten kann: Portainer hat neu ausgerollt — ist das
   schon der neue Stand, oder sehe ich noch den alten? Deshalb trägt der Dienst
   seine Herkunft mit sich und zeigt sie in der Oberfläche.

   Drei Quellen, in dieser Reihenfolge:

   1. Umgebung — im Abbild beim Bauen eingebrannt (LEITSTAND_COMMIT & Co.).
      Das ist die verlässliche Angabe im Betrieb.
   2. Arbeitsbaum — beim Entwickeln mit `npm start` gibt es kein Abbild, dafür
      ein .git-Verzeichnis. Das wird direkt gelesen, ohne git aufzurufen:
      ein Unterprozess je Abfrage wäre für eine Anzeige zu teuer, und in einem
      Abbild ohne git würde er scheitern.
   3. Dateistand — wer das Abbild selbst baut (Portainer: Stack aus einem
      Repository), hat weder Bauparameter noch .git im Kontext. Dann bleibt der
      Änderungszeitpunkt des Programms: er sagt nicht, *welcher* Stand läuft,
      aber verlässlich, wie alt er ist. Genau so wird er auch benannt.
   4. Nichts davon — dann wird das auch so gesagt, statt etwas zu behaupten. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* Einmal ermitteln: im Betrieb ändert sich das nie — ein neuer Stand ist ein
   neuer Prozess. Genau darauf beruht die Erkennung in der Oberfläche. */
let zwischenspeicher = null;

export function buildInfo() {
  if (!zwischenspeicher) zwischenspeicher = ermitteln();
  return zwischenspeicher;
}

function ermitteln() {
  const basis = { version: paketVersion(), commit: null, shortCommit: null, branch: null, committed: null, built: null };
  return { ...basis, ...(ausUmgebung() || ausArbeitsbaum() || ausDateistand() || { source: "unbekannt" }) };
}

/* ---------- 1. Aus dem Abbild ---------- */
function ausUmgebung() {
  const commit = wert("LEITSTAND_COMMIT");
  const built = wert("LEITSTAND_BUILT");
  if (!commit && !built) return null;
  return {
    source: "abbild",
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    branch: wert("LEITSTAND_BRANCH"),
    committed: iso(wert("LEITSTAND_COMMITTED")),
    built: iso(built),
    version: wert("LEITSTAND_VERSION") || paketVersion()
  };
}

/* ---------- 2. Aus dem Arbeitsbaum ---------- */
function ausArbeitsbaum() {
  const gitDir = findeGit(ROOT);
  if (!gitDir) return null;
  try {
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    let commit = null, branch = null, refDatei = null;

    if (head.startsWith("ref: ")) {
      const ref = head.slice(5).trim();
      branch = ref.replace(/^refs\/heads\//, "");
      refDatei = path.join(gitDir, ref);
      if (fs.existsSync(refDatei)) commit = fs.readFileSync(refDatei, "utf8").trim();
      else commit = ausPackedRefs(gitDir, ref);          /* frisch geklont: Referenzen liegen gepackt */
    } else {
      commit = head;                                      /* abgelöster HEAD */
      branch = "(losgelöst)";
    }
    if (!commit) return null;

    /* Wann zuletzt festgeschrieben wurde, steht im Commit-Objekt — das ist
       zlib-komprimiert und damit hier zu teuer. Der Änderungszeitpunkt der
       Referenz liegt nah genug dran und wird auch so benannt. */
    const quelle = refDatei && fs.existsSync(refDatei) ? refDatei : path.join(gitDir, "HEAD");
    const stand = fs.statSync(quelle).mtime.toISOString();

    return {
      source: "arbeitsbaum",
      commit,
      shortCommit: commit.slice(0, 7),
      branch,
      committed: stand,
      built: null,
      version: paketVersion()
    };
  } catch { return null; }
}

/* ---------- 3. Aus dem Dateistand ---------- */
function ausDateistand() {
  try {
    const src = path.join(ROOT, "src");
    const neuste = fs.readdirSync(src)
      .filter(f => f.endsWith(".js"))
      .map(f => fs.statSync(path.join(src, f)).mtime.getTime());
    if (!neuste.length) return null;
    return {
      source: "dateistand",
      built: new Date(Math.max(...neuste)).toISOString(),
      version: paketVersion()
    };
  } catch { return null; }
}

function ausPackedRefs(gitDir, ref) {
  try {
    const text = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    for (const zeile of text.split("\n")) {
      if (!zeile || zeile.startsWith("#") || zeile.startsWith("^")) continue;
      const [sha, name] = zeile.trim().split(/\s+/);
      if (name === ref) return sha;
    }
  } catch {}
  return null;
}

/* .git kann auch eine Datei sein (Worktree, Submodul) — dann steht der Pfad drin. */
function findeGit(von) {
  let dir = von;
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, ".git");
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) return p;
      if (st.isFile()) {
        const m = fs.readFileSync(p, "utf8").match(/^gitdir:\s*(.+)$/m);
        if (m) return path.resolve(dir, m[1].trim());
      }
    } catch {}
    const oben = path.dirname(dir);
    if (oben === dir) break;
    dir = oben;
  }
  return null;
}

/* ---------- Kleinkram ---------- */
const wert = name => {
  const v = process.env[name];
  /* Ein nicht ersetzter Bauparameter ist keine Angabe, sondern ein Fehler
     im Bauvorgang — er darf nicht als Fassung durchgehen. */
  return v && v.trim() && !/^\$?\{?\{?[A-Z_]+\}?\}?$/.test(v.trim()) ? v.trim() : null;
};

function iso(v) {
  if (!v) return null;
  const d = new Date(/^\d+$/.test(v) ? Number(v) * 1000 : v);   /* auch Unix-Sekunden */
  return isNaN(d) ? null : d.toISOString();
}

function paketVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || null; }
  catch { return null; }
}
