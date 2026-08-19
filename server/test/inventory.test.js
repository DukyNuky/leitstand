import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Inv from "../src/inventory.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "leitstand-")), "inventory.yaml");

const minimal = {
  sites: [{ id: "hq", name: "HQ" }],
  hosts: [{ id: "pve-1", type: "pve", site: "hq", ip: "10.0.0.5" }],
  tunnels: [], links: []
};

test("Prüfungen werden aus Typ und Adresse abgeleitet", () => {
  const inv = Inv.normalize(minimal);
  const kinds = inv.hosts[0].checks.map(c => `${c.kind}${c.port || ""}`);
  assert.deepEqual(kinds, ["icmp", "tcp8006", "tls8006"], "Proxmox VE bringt Port 8006 mit");
  assert.equal(inv.hosts[0].url, "https://10.0.0.5:8006");
});

test("Portainer bekommt seinen eigenen Standardport", () => {
  const inv = Inv.normalize({ ...minimal, hosts: [{ id: "p", type: "portainer", site: "hq", ip: "10.0.0.9" }] });
  assert.equal(inv.hosts[0].url, "https://10.0.0.9:9443");
});

test("Eigene Prüfungen verdrängen die abgeleiteten", () => {
  const inv = Inv.normalize({ ...minimal, hosts: [{ ...minimal.hosts[0], checks: [{ kind: "tcp", port: 22 }] }] });
  assert.equal(inv.hosts[0].checks.length, 1);
});

test("Unbekannter Standort wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({ ...minimal, hosts: [{ id: "x", type: "pve", site: "gibtsnicht", ip: "1.2.3.4" }] }),
    /Standort .gibtsnicht. ist nicht angelegt/);
});

test("Doppelte id wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({ ...minimal, hosts: [minimal.hosts[0], minimal.hosts[0]] }), /doppelt/);
});

test("System ohne Adresse wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({ ...minimal, hosts: [{ id: "leer", type: "pve", site: "hq" }] }), /weder ip noch url/);
});

test("Verknüpfung auf ein unbekanntes System wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({ ...minimal, links: [{ group: "G", items: [{ name: "X", host: "weg" }] }] }), /ist nicht angelegt/);
});

test("Tunnel ohne Gegenstelle wird abgelehnt", () => {
  assert.throws(() => Inv.normalize({ ...minimal, tunnels: [{ id: "t", a: "hq", b: "hq", probe: {} }] }), /probe\.ip fehlt/);
});

test("Speichern und erneut laden ergibt denselben Bestand", () => {
  const file = tmp();
  const inv = Inv.normalize(minimal);
  Inv.save(file, inv);
  const again = Inv.load(file);
  assert.deepEqual(again.hosts.map(h => h.id), inv.hosts.map(h => h.id));
  assert.deepEqual(again.hosts[0].checks, inv.hosts[0].checks);
  assert.equal(again.settings.interval, Inv.DEFAULTS.interval);
});

test("Abgeleitete Prüfungen landen nicht in der Datei", () => {
  const file = tmp();
  Inv.save(file, Inv.normalize(minimal));
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes("checks:"), "sonst friert die Datei Standardwerte ein");
});

test("Vor dem Überschreiben wird gesichert", () => {
  const file = tmp();
  Inv.save(file, Inv.normalize(minimal));
  const zwei = Inv.normalize({ ...minimal, hosts: [...minimal.hosts, { id: "pve-2", type: "pve", site: "hq", ip: "10.0.0.6" }] });
  Inv.save(file, zwei);
  assert.ok(fs.existsSync(file + ".bak"));
  assert.equal(Inv.load(file).hosts.length, 2);
  const wieder = Inv.restore(file);
  assert.equal(wieder.hosts.length, 1, "Sicherung lässt sich zurückholen");
});

test("Kaputtes YAML nennt den Grund", () => {
  const file = tmp();
  fs.writeFileSync(file, "sites: [\n  broken");
  assert.throws(() => Inv.load(file), /YAML lässt sich nicht lesen/);
});

test("Der mitgelieferte Bestand ist gültig", () => {
  const inv = Inv.load(new URL("../inventory.yaml", import.meta.url).pathname);
  assert.ok(inv.hosts.length >= 20);
  assert.ok(inv.tunnels.every(t => t.probe?.ip));
});

test("Prüfziel wird notfalls aus der Oberflächen-URL gezogen", async () => {
  const { targetHost } = await import("../src/probe.js");
  assert.equal(targetHost({ kind: "tcp", port: 443 }, { url: "https://pve.example.de:8006" }), "pve.example.de");
  assert.equal(targetHost({ kind: "tcp", port: 443 }, { ip: "10.0.0.1", url: "https://name.example.de" }), "10.0.0.1", "die IP hat Vorrang");
  assert.equal(targetHost({ kind: "tcp", port: 25, ip: "10.0.0.9" }, { ip: "10.0.0.1" }), "10.0.0.9", "die Prüfung selbst hat den Vorrang");
  assert.equal(targetHost({ kind: "icmp" }, {}), null);
});
