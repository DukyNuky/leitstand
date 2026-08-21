/* Alle Sammler an einer Stelle.

   Ein Sammler bekommt ein System und liefert Zusatzangaben zurück — oder
   null, wenn kein Zugang hinterlegt ist. Ohne Token bleibt es bei der
   reinen Erreichbarkeit; das ist kein Fehler, sondern eine Lücke, und
   die Oberfläche sagt sie an. */

import { collectPve, collectPbs, collectPmg, TESTERS as PROXMOX_TESTERS } from "./proxmox.js";
import { collectOpnsense, testConnection as testOpnsense } from "./opnsense.js";
import { collectAdguard, testConnection as testAdguard } from "./adguard.js";
import { collectPortainer, testConnection as testPortainer } from "./portainer.js";

export function makeCollectors(secrets) {
  const wrap = fn => async host => {
    const cred = secrets.get(host.id);
    if (!cred) return null;
    return fn(host, cred);
  };
  return {
    pve: wrap(collectPve),
    pbs: wrap(collectPbs),
    pmg: wrap(collectPmg),
    opnsense: wrap(collectOpnsense),
    adguard: wrap(collectAdguard),
    portainer: wrap(collectPortainer)
  };
}

export const TESTERS = {
  ...PROXMOX_TESTERS,
  opnsense: (h, c) => testOpnsense(h, c),
  adguard: (h, c) => testAdguard(h, c),
  portainer: (h, c) => testPortainer(h, c)
};
