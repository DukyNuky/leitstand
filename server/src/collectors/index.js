/* Alle Sammler an einer Stelle.

   Ein Sammler bekommt ein System und liefert Zusatzangaben zurück — oder
   null, wenn kein Zugang hinterlegt ist. Ohne Token bleibt es bei der
   reinen Erreichbarkeit; das ist kein Fehler, sondern eine Lücke, und
   die Oberfläche sagt sie an. */

import { collectPve, collectPbs, TESTERS as PROXMOX_TESTERS } from "./proxmox.js";
import { collectPmg, testConnection as testPmg } from "./pmg.js";
import { collectMailcow, testConnection as testMailcow } from "./mailcow.js";
import { collectOpnsense, testConnection as testOpnsense } from "./opnsense.js";
import { collectPfsense, testConnection as testPfsense } from "./pfsense.js";
import { collectAdguard, testConnection as testAdguard } from "./adguard.js";
import { collectPortainer, testConnection as testPortainer } from "./portainer.js";

/* Der zweite Parameter sind die Einstellungen des laufenden Bestands. Ein
   Sammler braucht sie für die Schwellwerte: ab wann eine Belegung gelb
   und ab wann sie rot ist, ist eine Betriebsentscheidung und darf je
   System abweichen (siehe `schwellenFuer` in inventory.js). */
export function makeCollectors(secrets) {
  const wrap = fn => async (host, settings) => {
    const cred = secrets.get(host.id);
    if (!cred) return null;
    return fn(host, cred, settings);
  };
  return {
    pve: wrap(collectPve),
    pbs: wrap(collectPbs),
    pmg: wrap(collectPmg),
    opnsense: wrap(collectOpnsense),
    pfsense: wrap(collectPfsense),
    adguard: wrap(collectAdguard),
    portainer: wrap(collectPortainer),
    mailcow: wrap(collectMailcow)
  };
}

export const TESTERS = {
  ...PROXMOX_TESTERS,
  pmg: (h, c) => testPmg(h, c),
  mailcow: (h, c) => testMailcow(h, c),
  opnsense: (h, c) => testOpnsense(h, c),
  pfsense: (h, c) => testPfsense(h, c),
  adguard: (h, c) => testAdguard(h, c),
  portainer: (h, c) => testPortainer(h, c)
};
