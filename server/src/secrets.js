/* Zugangsdaten liegen getrennt vom Bestand.

   inventory.yaml darf man weitergeben oder in ein Repository legen —
   secrets.json nicht. Die Datei wird mit 0600 geschrieben und verlässt
   den Server nie im Klartext: nach außen geht nur eine Maske. */

import fs from "node:fs";

export class Secrets {
  constructor(file) { this.file = file; this.data = {}; this.#load(); }

  #load() {
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch (e) { if (e.code !== "ENOENT") console.error("[secrets] nicht lesbar:", e.message); this.data = {}; }
  }
  #save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
  }

  get(hostId) { return this.data[hostId] || null; }
  has(hostId) { return !!this.data[hostId]; }

  set(hostId, cred) {
    const prev = this.data[hostId] || {};
    const next = { ...prev, ...cred };
    /* Leere Felder aus der Oberfläche überschreiben nichts Bestehendes —
       so kann man den Benutzernamen ändern, ohne das Geheimnis erneut zu tippen. */
    for (const k of Object.keys(next)) if (next[k] === "" || next[k] == null) delete next[k];
    if (!Object.keys(next).length) delete this.data[hostId]; else this.data[hostId] = next;
    this.#save();
    return this.masked(hostId);
  }

  remove(hostId) { delete this.data[hostId]; this.#save(); }

  /* Was die Oberfläche zu sehen bekommt. */
  masked(hostId) {
    const c = this.data[hostId];
    if (!c) return null;
    const out = {};
    for (const [k, v] of Object.entries(c)) out[k] = SECRET_FIELDS.has(k) ? mask(v) : v;
    return out;
  }
  maskedAll() {
    const out = {};
    for (const id of Object.keys(this.data)) out[id] = this.masked(id);
    return out;
  }
}

/* Was nie im Klartext zurückgegeben wird. `key` steht mit dabei, weil er
   je nach Gerät das Geheimnis *ist*: bei pfSense ist der API-Schlüssel
   die ganze Anmeldung, bei OPNsense ihre Hälfte. Beides gehört nicht in
   eine Antwort, die eine Browserseite anfordern kann. */
export const SECRET_FIELDS = new Set(["secret", "password", "token", "apiKey", "key", "clientToken"]);
function mask(v) {
  const s = String(v ?? "");
  if (!s) return "";
  return s.length <= 6 ? "••••••" : "••••••" + s.slice(-4);
}
