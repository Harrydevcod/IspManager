import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { classifyOutage, uptimeWasReset } from './outage-cause';
import type { PingResult, Pinger, UptimeReader } from './network-probe';

describe('uptimeWasReset', () => {
  test('arrancou depois da última resposta: reiniciou', () => {
    expect(uptimeWasReset(90, 600)).toBe(true);
  });
  test('o uptime cobre a queda toda: a ligação caiu, o equipamento não', () => {
    expect(uptimeWasReset(400_000, 600)).toBe(false);
  });
});

describe('classifyOutage', () => {
  const base = { planned: false, operatorCause: null, uptimeReset: null, siteMateFell: false } as const;
  test('o "Vou reiniciar" manda sobre tudo', () => {
    expect(classifyOutage({ ...base, planned: true, operatorCause: 'link', uptimeReset: false })).toEqual({ cause: 'planned', source: 'operator' });
  });
  test('a escolha do operador manda sobre a prova', () => {
    expect(classifyOutage({ ...base, operatorCause: 'power', uptimeReset: false })).toEqual({ cause: 'power', source: 'operator' });
  });
  test('uptime a zero e um vizinho do mesmo local caído: corte de energia', () => {
    expect(classifyOutage({ ...base, uptimeReset: true, siteMateFell: true })).toEqual({ cause: 'power', source: 'auto' });
  });
  test('uptime a zero sozinho: reinício', () => {
    expect(classifyOutage({ ...base, uptimeReset: true })).toEqual({ cause: 'reboot', source: 'auto' });
  });
  test('uptime a contar: queda de ligação', () => {
    expect(classifyOutage({ ...base, uptimeReset: false })).toEqual({ cause: 'link', source: 'auto' });
  });
  test('sem resposta SNMP: por confirmar', () => {
    expect(classifyOutage(base)).toEqual({ cause: 'unknown', source: null });
  });
});

// ------------------------------------------------------------- sonda + leitura

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let probe: typeof import('./network-probe');
let incidents: typeof import('./network-incidents');
let causes: typeof import('./outage-cause');

const UP: PingResult = { ok: true, rttMs: 4 };
const DOWN: PingResult = { ok: false, rttMs: null };

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-outage-cause-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  probe = await import('./network-probe');
  incidents = await import('./network-incidents');
  causes = await import('./outage-cause');
});

beforeEach(() => {
  for (const table of ['notifications', 'network_probe_events', 'network_probe_state', 'network_outage_evidence', 'planned_reboots', 'backbone_links', 'backbone_devices', 'network_sites', 'equipment_catalog']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

function device(name: string, ip: string, siteId: number | null = null): number {
  const catalogId = Number(db.prepare("INSERT INTO equipment_catalog (type, model) VALUES ('antena', ?)").run(`M ${name}`).lastInsertRowid);
  return Number(db.prepare('INSERT INTO backbone_devices (catalog_id, name, ip_address, site_id) VALUES (?, ?, ?, ?)').run(catalogId, name, ip, siteId).lastInsertRowid);
}

const site = (name: string) => Number(db.prepare('INSERT INTO network_sites (name) VALUES (?)').run(name).lastInsertRowid);
const pinger = (dead: string[]): Pinger => async (ip) => (dead.includes(ip) ? DOWN : UP);
const uptimeOf = (values: Record<string, number>): UptimeReader => async (ip) => values[ip] ?? null;
const run = (dead: string[], uptimes: Record<string, number> = {}) =>
  probe.runNetworkProbe(db, { includeClients: false, failThreshold: 1, ping: pinger(dead), snmpCommunity: 'ro', uptime: uptimeOf(uptimes) });

/** Recua o relógio do que já foi gravado: a queda durou `minutes`. */
function ageState(minutes: number) {
  const shift = `-${minutes} minutes`;
  db.prepare(`UPDATE network_probe_state SET last_ok_at = datetime(last_ok_at, ?), last_change_at = datetime(last_change_at, ?), checked_at = datetime(checked_at, ?), uptime_read_at = datetime(uptime_read_at, ?)`)
    .run(shift, shift, shift, shift);
  db.prepare('UPDATE network_probe_events SET at = datetime(at, ?)').run(shift);
}

const titles = () => (db.prepare("SELECT title FROM notifications WHERE kind = 'network_up' ORDER BY id").all() as Array<{ title: string }>).map((row) => row.title);
const incidentOf = (name: string) => incidents.loadIncidents(db).incidents.find((incident) => incident.name === name)!;

describe('a sonda grava a prova e a causa lê-se dela', () => {
  test('uptime a zero no regresso: reinício, e o sino diz "reiniciou"', async () => {
    device('Torre', '10.0.0.1');
    await run([], { '10.0.0.1': 500_000 });
    ageState(5);
    await run(['10.0.0.1']);
    ageState(3);
    await run([], { '10.0.0.1': 60 });
    expect(incidentOf('Torre')).toMatchObject({ outageCause: 'reboot', causeSource: 'auto' });
    expect(titles()).toEqual(['Torre reiniciou']);
  });

  test('uptime a contar: queda de ligação', async () => {
    device('Torre', '10.0.0.1');
    await run([], { '10.0.0.1': 500_000 });
    ageState(5);
    await run(['10.0.0.1']);
    ageState(3);
    await run([], { '10.0.0.1': 500_600 });
    expect(incidentOf('Torre').outageCause).toBe('link');
    expect(titles()).toEqual(['Torre voltou']);
  });

  test('dois do mesmo local a reiniciar juntos, sem um depender do outro: corte de energia', async () => {
    const torre = site('Torre de Achada');
    device('Setor Norte', '10.0.0.1', torre);
    device('Setor Sul', '10.0.0.2', torre);
    await run([], { '10.0.0.1': 500_000, '10.0.0.2': 500_000 });
    ageState(5);
    await run(['10.0.0.1', '10.0.0.2']);
    ageState(20);
    await run([], { '10.0.0.1': 90, '10.0.0.2': 95 });
    expect(incidentOf('Setor Norte')).toMatchObject({ outageCause: 'power', siteName: 'Torre de Achada' });
    expect(titles()).toContain('Corte de energia em Torre de Achada');
  });

  test('sem resposta SNMP: por confirmar, e o operador pode escolher a causa', async () => {
    const id = device('Torre', '10.0.0.1');
    await run([]);
    ageState(5);
    await run(['10.0.0.1']);
    ageState(3);
    await run([]);
    const incident = incidentOf('Torre');
    expect(incident.outageCause).toBe('unknown');
    causes.setOperatorCause(db, id, incident.startedAt, 'power', null);
    expect(incidentOf('Torre')).toMatchObject({ outageCause: 'power', causeSource: 'operator' });
  });

  test('"Vou reiniciar" na antena de cima: o filho arrastado não toca o sino, e a queda é programada', async () => {
    const top = device('Transmissão', '10.0.0.1');
    const child = device('Cliente-AP', '10.0.0.2');
    db.prepare('INSERT INTO backbone_links (device_id, upstream_device_id) VALUES (?, ?)').run(child, top);
    await run([], { '10.0.0.1': 500_000, '10.0.0.2': 500_000 });
    causes.startPlannedReboot(db, top, null);
    await run(['10.0.0.1', '10.0.0.2']);
    expect((db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'network_down'").get() as { n: number }).n).toBe(0);
    await run([], { '10.0.0.1': 40, '10.0.0.2': 35 });
    expect(incidentOf('Transmissão').outageCause).toBe('planned');
    expect(titles()).toEqual([]);
    const status = probe.loadNetworkStatus(db);
    expect(status.targets.find((target) => target.id === top)!.uptime).toBe(1);
  });

  test('reinício tão curto que a sonda não deu a queda: só o uptime o mostra', async () => {
    device('Torre', '10.0.0.1');
    await run([], { '10.0.0.1': 500_000 });
    ageState(2);
    await run([], { '10.0.0.1': 45 });
    const incident = incidentOf('Torre');
    expect(incident).toMatchObject({ outageCause: 'reboot', observedDown: false, durationSeconds: null });
    expect(titles()).toEqual(['Torre reiniciou']);
  });
});
