/* Was sagt der Controller wirklich?

   Wenn der Leitstand „Zugangsdaten abgelehnt" meldet und dieselben Daten
   in der Weboberfläche funktionieren, ist die Frage nicht mehr, ob das
   Passwort stimmt — sondern was der Controller auf einen Anmeldeversuch
   ohne Browser antwortet. Genau das misst dieses Werkzeug: jede Adresse,
   jeder Anmeldepfad, jede Form der Anfrage, und zu jedem Versuch der
   nackte Statuscode, die ausgestellten Kekse und der Anfang des Rumpfes.

   Aufruf — im Behälter, in dem der Leitstand läuft:

     docker exec -it leitstand node /app/tools/unifi-probe.mjs \
       --url https://10.10.6.10:8443 --user leitstand --pass 'geheim'

   Ohne --pass wird das Passwort abgefragt, damit es nicht in der
   Verlaufsliste der Shell steht. Ausgegeben wird es nie. */

import https from "node:https";
import http from "node:http";
import readline from "node:readline";

const arg = n => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : null;
};

const rohUrl = arg("url") || arg("ip");
if (!rohUrl) {
  console.error("Aufruf: node unifi-probe.mjs --url https://<ip>[:port] --user <name> [--pass <wort>] [--site <name>]");
  process.exit(2);
}
const benutzer = arg("user") || arg("username");
if (!benutzer) { console.error("--user fehlt"); process.exit(2); }

/* Dieselbe Regel wie im Sammler: steht ein Anschluss in der Adresse,
   gilt genau der; sonst werden 443 und 8443 versucht. */
function basen(s) {
  const roh = /^https?:\/\//.test(s) ? s : `https://${s}`;
  const u = new URL(roh);
  if (u.port) return [`${u.protocol}//${u.hostname}:${u.port}`];
  if (u.protocol !== "https:") return [`${u.protocol}//${u.hostname}`];
  return [`https://${u.hostname}:443`, `https://${u.hostname}:8443`];
}

function frage(text) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(text, a => { rl.close(); res(a); });
  });
}

function ruf(url, { method = "GET", headers = {}, body = null, timeout = 8000 } = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const nutzlast = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const kopf = { accept: "application/json", "user-agent": "leitstand-probe/1", ...headers };
    if (nutzlast != null) kopf["content-length"] = Buffer.byteLength(nutzlast);
    const t0 = Date.now();
    const req = mod.request(u, { method, headers: kopf, rejectUnauthorized: false, timeout }, res => {
      const teile = [];
      res.on("data", c => teile.push(c));
      res.on("end", () => resolve({
        status: res.statusCode, ms: Date.now() - t0, headers: res.headers,
        body: Buffer.concat(teile).toString("utf8")
      }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ fehler: `Zeitüberschreitung nach ${timeout} ms`, ms: Date.now() - t0 }); });
    req.on("error", e => resolve({ fehler: e.code || e.message, ms: Date.now() - t0 }));
    if (nutzlast != null) req.write(nutzlast);
    req.end();
  });
}

const kekseVon = r => {
  const roh = r?.headers?.["set-cookie"];
  const liste = Array.isArray(roh) ? roh : roh ? [roh] : [];
  return liste.map(z => String(z).split("=")[0].trim());
};
const kekspaare = r => {
  const roh = r?.headers?.["set-cookie"];
  const liste = Array.isArray(roh) ? roh : roh ? [roh] : [];
  return liste.map(z => String(z).split(";")[0].trim()).filter(z => /^[^=]+=.+/.test(z)).join("; ");
};
const kurz = (s, n = 220) => String(s || "").replace(/\s+/g, " ").slice(0, n);

/* Das csrf_token steckt bei UniFi OS im JWT des TOKEN-Kekses, bei der
   eigenständigen Anwendung in einem eigenen Keks gleichen Namens. */
function csrfAus(keks) {
  const m = /(?:^|;\s*)csrf_token=([^;]+)/.exec(keks || "");
  if (m) return m[1];
  const t = /(?:^|;\s*)TOKEN=([^;]+)/.exec(keks || "");
  if (!t) return null;
  try {
    const rumpf = JSON.parse(Buffer.from(t[1].split(".")[1], "base64").toString("utf8"));
    return rumpf.csrfToken || rumpf.csrf_token || null;
  } catch { return null; }
}

function zeile(name, r) {
  if (r.fehler) return `      ${name.padEnd(34)} — ${r.fehler} (${r.ms} ms)`;
  const keks = kekseVon(r);
  const ort = r.headers?.location ? ` → ${r.headers.location}` : "";
  const art = String(r.headers?.["content-type"] || "").split(";")[0];
  return `      ${name.padEnd(34)} ${r.status}${ort}  [${art || "ohne Typ"}] ${r.ms} ms`
    + (keks.length ? `\n${" ".repeat(42)}Kekse: ${keks.join(", ")}` : "")
    + (r.body ? `\n${" ".repeat(42)}Rumpf: ${kurz(r.body)}` : "");
}

const passwort = arg("pass") || arg("password") || await frage("Passwort (wird nicht ausgegeben): ");
const site = arg("site") || "default";

console.log(`\nControllerprobe für ${rohUrl} als „${benutzer}“\n${"=".repeat(72)}`);

for (const basis of basen(rohUrl)) {
  console.log(`\n### ${basis}`);

  /* 1. Wer horcht hier überhaupt — und ist es UniFi OS?
        UniFi OS antwortet auf / mit 200, die eigenständige Anwendung
        leitet auf /manage um. */
  const wurzel = await ruf(`${basis}/`, { timeout: 6000 });
  console.log("\n   Wer horcht hier?");
  console.log(zeile("GET /", { ...wurzel, body: wurzel.body ? kurz(wurzel.body, 90) : "" }));
  if (wurzel.fehler) continue;

  const vorKeks = kekspaare(wurzel);
  const csrf = csrfAus(vorKeks);
  if (csrf) console.log(`      → csrf_token liegt vor (${csrf.slice(0, 8)}…)`);

  /* 2. Beide Anmeldepfade, jeder in drei Formen. Unterscheidet sich das
        Ergebnis zwischen ihnen, liegt es an der Form der Anfrage — und
        nicht am Konto. */
  const rumpf = { username: benutzer, password: passwort, rememberMe: false, remember: false };

  for (const pfad of ["/api/auth/login", "/api/login"]) {
    console.log(`\n   POST ${pfad}`);

    console.log(zeile("nackt (wie der Leitstand heute)", await ruf(`${basis}${pfad}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: rumpf
    })));

    console.log(zeile("+ Referer und Origin", await ruf(`${basis}${pfad}`, {
      method: "POST",
      headers: { "content-type": "application/json", referer: `${basis}/login`, origin: basis },
      body: rumpf
    })));

    console.log(zeile("+ Keks und X-CSRF-Token", await ruf(`${basis}${pfad}`, {
      method: "POST",
      headers: {
        "content-type": "application/json", referer: `${basis}/login`, origin: basis,
        ...(vorKeks ? { cookie: vorKeks } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {})
      },
      body: rumpf
    })));
  }

  /* 3. Trägt eine Anmeldung, dann sagt der nächste Abruf, ob der Keks
        auch reicht — dort scheitert es sonst als Zweites. */
  const an = await ruf(`${basis}/api/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json", referer: `${basis}/login`, origin: basis,
      ...(vorKeks ? { cookie: vorKeks } : {}), ...(csrf ? { "x-csrf-token": csrf } : {})
    }, body: rumpf
  });
  const an2 = an.status >= 200 && an.status < 400 ? an : await ruf(`${basis}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json", referer: `${basis}/login`, origin: basis,
      ...(vorKeks ? { cookie: vorKeks } : {}), ...(csrf ? { "x-csrf-token": csrf } : {})
    }, body: rumpf
  });
  const sitzung = kekspaare(an2);
  if (sitzung) {
    console.log("\n   Mit der ausgestellten Sitzung weiter:");
    for (const p of ["/api/self/sites", `/api/s/${site}/stat/device`, "/proxy/network/api/self/sites"]) {
      const r = await ruf(`${basis}${p}`, { headers: { cookie: sitzung, ...(csrfAus(sitzung) ? { "x-csrf-token": csrfAus(sitzung) } : {}) } });
      console.log(zeile(`GET ${p}`, { ...r, body: r.body ? kurz(r.body, 120) : "" }));
    }
  }
}

console.log(`\n${"=".repeat(72)}\nFertig. Entscheidend ist die Zeile, die 200 liefert — und ob dazu\nReferer, Origin oder ein CSRF-Token nötig waren.\n`);
