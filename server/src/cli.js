/* Diagnose von der Kommandozeile.

     npm run probe                 alle Systeme mit Sammler, kurz
     npm run probe pve-01          ein System, ausführlich
     npm run probe --alle          jedes System, ausführlich

   Im Container:
     docker exec leitstand node src/cli.js pve-01

   Nützlich, wenn die Oberfläche gerade nicht erreichbar ist oder man das
   Ergebnis in eine Meldung kopieren will. Läuft gegen denselben Bestand
   wie der Dienst und ändert nichts. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Inv from "./inventory.js";
import { Secrets } from "./secrets.js";
import { diagnoseHost, alsText } from "./diagnose.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function bestandPfad() {
  if (process.env.LEITSTAND_INVENTORY) return path.resolve(process.env.LEITSTAND_INVENTORY);
  const imArbeitsverzeichnis = path.resolve(process.cwd(), "inventory.yaml");
  if (fs.existsSync(imArbeitsverzeichnis)) return imArbeitsverzeichnis;
  return path.join(ROOT, "inventory.yaml");
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--hilfe") || args.includes("--help")) {
  console.log(`Leitstand — Diagnose

  node src/cli.js                 Übersicht aller Systeme mit Sammler
  node src/cli.js <kennung>       ein System, jeder Aufruf einzeln
  node src/cli.js --alle          jedes System, jeder Aufruf einzeln

Der Bestand kommt aus LEITSTAND_INVENTORY, sonst aus dem
Arbeitsverzeichnis, sonst von neben dem Programm.`);
  process.exit(0);
}

const datei = bestandPfad();
let inv;
try { inv = Inv.load(datei); }
catch (e) { console.error(`Bestand nicht lesbar (${datei}):\n${e.message}`); process.exit(2); }

const secrets = new Secrets(path.join(path.dirname(datei), "secrets.json"));
const kennung = args.find(a => !a.startsWith("-"));
const alle = args.includes("--alle");

console.log(`Bestand: ${datei}`);
console.log(`Systeme: ${inv.hosts.length}\n`);

/* Ein bestimmtes System */
if (kennung) {
  const host = inv.hosts.find(h => String(h.id) === kennung);
  if (!host) {
    console.error(`„${kennung}" ist nicht angelegt. Vorhanden: ${inv.hosts.map(h => h.id).join(", ") || "keine"}`);
    process.exit(2);
  }
  const b = await diagnoseHost(host, secrets.get(host.id), inv.settings);
  console.log(alsText(b));
  process.exit(b.ok ? 0 : 1);
}

/* Alle — ausführlich oder als Übersicht */
const mitSammler = inv.hosts.filter(h => ["pve", "pbs", "pmg"].includes(h.type));
const zuPruefen = alle ? inv.hosts : mitSammler;
if (!zuPruefen.length) {
  console.log("Kein System mit Sammler angelegt. Mit --alle werden auch die reinen Erreichbarkeitsprüfungen gezeigt.");
  process.exit(0);
}

let schlecht = 0;
for (const host of zuPruefen) {
  const b = await diagnoseHost(host, secrets.get(host.id), inv.settings);
  if (!b.ok) schlecht++;
  if (alle || kennung) { console.log(alsText(b)); console.log("\n" + "─".repeat(64) + "\n"); }
  else console.log(`${b.ok ? "OK" : "!!"}  ${host.id.padEnd(16)} ${b.fazit}`);
}
if (!alle) console.log(`\n${zuPruefen.length - schlecht} von ${zuPruefen.length} in Ordnung.`);
process.exit(schlecht ? 1 : 0);
