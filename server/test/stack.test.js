/* Prüft die Stack-Dateien: dass jede Variable eine Vorgabe hat, dass .env
   und docker-compose.yml zueinander passen und dass die Ersetzung zu einer
   brauchbaren Port- und Volumezeile führt. Ein Tippfehler in einem der
   beiden Dateien fällt sonst erst beim Einsetzen auf. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import YAML from "yaml";

const wurzel = new URL("../../", import.meta.url).pathname;
const composeText = fs.readFileSync(wurzel + "docker-compose.yml", "utf8");
const envText = fs.readFileSync(wurzel + ".env", "utf8");
const compose = YAML.parse(composeText);

function envLesen(text) {
  const out = {};
  for (const zeile of text.split("\n")) {
    const m = zeile.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/* Nachbau der Ersetzung von Docker Compose: ${VAR:-vorgabe} nimmt die
   Vorgabe, wenn die Variable fehlt ODER leer ist. */
function ersetzen(text, env) {
  return text.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g, (_, name, vorgabe) => {
    const v = env[name];
    return v === undefined || v === "" ? (vorgabe ?? "") : v;
  });
}

const variablen = [...composeText.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g)];

test("Jede Variable in der Compose-Datei hat eine Vorgabe", () => {
  const ohne = variablen.filter(m => m[2] === undefined).map(m => m[1]);
  assert.deepEqual(ohne, [], "sonst steht dort beim Einsetzen ohne .env eine leere Zeichenkette");
});

test("Alles, was die Compose-Datei nutzt, ist in der .env beschrieben", () => {
  const env = envLesen(envText);
  const genutzt = [...new Set(variablen.map(m => m[1]))];
  const fehlend = genutzt.filter(n => !(n in env));
  assert.deepEqual(fehlend, [], "eine genutzte Variable fehlt in der .env");
});

test("Die .env erfindet keine Werte, die niemand liest", () => {
  const env = Object.keys(envLesen(envText));
  const genutzt = new Set(variablen.map(m => m[1]));
  const verwaist = env.filter(n => !genutzt.has(n));
  assert.deepEqual(verwaist, [], "steht in der .env, wird aber nirgends verwendet");
});

test("Ohne .env greifen brauchbare Vorgaben", () => {
  const d = YAML.parse(ersetzen(composeText, {}));
  assert.equal(d.services.leitstand.ports[0], "0.0.0.0:8080:8080");
  assert.equal(d.services.leitstand.volumes[0], "leitstand-data:/data");
  assert.match(d.services.leitstand.image, /^ghcr\.io\/.+:.+$/);
  assert.equal(d.services.leitstand.restart, "unless-stopped");
});

test("Mit der mitgelieferten .env kommt dasselbe heraus", () => {
  const d = YAML.parse(ersetzen(composeText, envLesen(envText)));
  assert.equal(d.services.leitstand.ports[0], "0.0.0.0:8080:8080", "LEITSTAND_BIND ist leer und fällt auf 0.0.0.0 zurück");
  assert.equal(d.services.leitstand.volumes[0], "leitstand-data:/data");
});

test("Eigene Werte schlagen durch", () => {
  const d = YAML.parse(ersetzen(composeText, {
    LEITSTAND_BIND: "127.0.0.1", LEITSTAND_PORT: "9090",
    LEITSTAND_DATA: "/srv/leitstand/data", TZ: "UTC",
    LEITSTAND_IMAGE: "ghcr.io/dukynuky/leitstand:sha-abc1234",
    LEITSTAND_RESTART: "always"
  }));
  assert.equal(d.services.leitstand.ports[0], "127.0.0.1:9090:8080");
  assert.equal(d.services.leitstand.volumes[0], "/srv/leitstand/data:/data", "ein Pfad wird als Einhängepunkt genutzt");
  assert.equal(d.services.leitstand.environment.TZ, "UTC");
  assert.equal(d.services.leitstand.image, "ghcr.io/dukynuky/leitstand:sha-abc1234");
  assert.equal(d.services.leitstand.restart, "always");
});

test("Der Dienst im Container bleibt auf 8080 — nur der Wirt ist frei wählbar", () => {
  const d = YAML.parse(ersetzen(composeText, { LEITSTAND_PORT: "9090" }));
  assert.ok(d.services.leitstand.ports[0].endsWith(":8080"), "sonst passt die Gesundheitsprüfung nicht mehr");
  assert.match(JSON.stringify(d.services.leitstand.healthcheck), /127\.0\.0\.1:8080/);
});

test("In der .env stehen keine Zugangsdaten", () => {
  const env = envLesen(envText);
  const verdaechtig = Object.entries(env).filter(([k, v]) =>
    /secret|token|pass|key/i.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(v));
  assert.deepEqual(verdaechtig, [], "Geheimnisse gehören nach secrets.json im Volume, nicht in eine versionierte Datei");
});

/* ---------- Dockerfile ---------- */
const dockerText = fs.readFileSync(wurzel + "Dockerfile", "utf8");

/* Eine fortgesetzte Zeile (\ am Ende) verträgt keinen Kommentar dazwischen —
   je nach Bauwerkzeug bricht der Bau ab oder die Anweisung wird verstümmelt.
   Beim Bearbeiten passiert genau das leicht, und auffallen würde es erst im
   Arbeitsablauf. */
test("Kein Kommentar mitten in einer fortgesetzten Dockerfile-Zeile", () => {
  const zeilen = dockerText.split("\n");
  for (let i = 0; i < zeilen.length - 1; i++) {
    if (!zeilen[i].trimEnd().endsWith("\\")) continue;
    const naechste = zeilen[i + 1].trim();
    assert.ok(!naechste.startsWith("#"),
      `Zeile ${i + 2} ist ein Kommentar innerhalb der Fortsetzung von Zeile ${i + 1}`);
  }
});

/* Die Fassungsanzeige lebt davon, dass die Bauparameter auch in der Umgebung
   landen — ein ARG allein ist zur Laufzeit nicht sichtbar. */
test("Jeder Bauparameter für die Fassung wird in die Umgebung übernommen", () => {
  const args = [...dockerText.matchAll(/^ARG\s+(LEITSTAND_[A-Z_]+)/gm)].map(m => m[1]);
  assert.ok(args.includes("LEITSTAND_COMMIT"), "der Commit gehört dazu");
  assert.ok(args.includes("LEITSTAND_BUILT"), "der Bauzeitpunkt gehört dazu");
  for (const a of args)
    assert.match(dockerText, new RegExp(`${a}=\\$${a}`), `${a} wird nicht als ENV weitergereicht`);
});

/* Was der Arbeitsablauf mitgibt, muss das Abbild auch entgegennehmen. */
test("Arbeitsablauf und Dockerfile kennen dieselben Bauparameter", () => {
  const workflow = fs.readFileSync(wurzel + ".github/workflows/image.yml", "utf8");
  const imWorkflow = [...workflow.matchAll(/^\s+(LEITSTAND_[A-Z_]+)=/gm)].map(m => m[1]);
  assert.ok(imWorkflow.length >= 4, "der Arbeitsablauf gibt die Herkunft mit");
  for (const name of imWorkflow)
    assert.match(dockerText, new RegExp(`^ARG\\s+${name}`, "m"), `${name} fehlt als ARG im Dockerfile`);
});

/* Der Healthcheck darf nicht am Zustand hängen: ein Fehler beim Zusammenbauen
   der Anzeige würde den Behälter sonst dauerhaft neu starten. */
test("Der Healthcheck fragt die Fassung ab, nicht den Zustand", () => {
  for (const [was, text] of [["Dockerfile", dockerText], ["docker-compose.yml", composeText]]) {
    const zeile = text.split("\n").find(z => z.includes("process.exit(r.ok"));
    assert.ok(zeile, `${was}: kein Healthcheck gefunden`);
    assert.match(zeile, /\/api\/version/, `${was}: der Healthcheck hängt am Zustand`);
  }
});
