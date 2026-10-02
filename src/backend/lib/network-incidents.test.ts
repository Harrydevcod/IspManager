import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { downstreamClosure, loadIncidents } from './network-incidents';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let catalogId: number;
const NOW = '2026-10-02 12:00:00';

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-network-incidents-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  catalogId = Number(db.prepare("INSERT INTO equipment_catalog (type, model) VALUES ('antena', 'Teste')").run().lastInsertRowid);
});

beforeEach(() => {
  for (const table of ['network_probe_events', 'network_probe_state', 'backbone_assignment_links',
    'service_device_assignments', 'backbone_links', 'backbone_devices', 'services', 'clients']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

const device = (name: string) => Number(db.prepare('INSERT INTO backbone_devices (catalog_id, name, zone) VALUES (?, ?, ?)')
  .run(catalogId, name, 'Praia').lastInsertRowid);
const link = (deviceId: number, upstreamId: number) =>
  db.prepare('INSERT INTO backbone_links (device_id, upstream_device_id) VALUES (?, ?)').run(deviceId, upstreamId);
const event = (id: number, toState: 'up' | 'down', at: string, gapBefore = 0) =>
  db.prepare(`INSERT INTO network_probe_events (target_kind, target_id, ip_address, from_state, to_state, at, gap_before)
    VALUES ('backbone', ?, '10.0.0.1', ?, ?, ?, ?)`).run(id, toState === 'up' ? 'down' : 'up', toState, at, gapBefore);
const stillDown = (id: number) =>
  db.prepare(`INSERT INTO network_probe_state (target_kind, target_id, ip_address, state) VALUES ('backbone', ?, '10.0.0.1', 'down')`).run(id);

/** Um cliente com um serviço ativo cujo equipamento pende dos backbones dados. */
function client(code: string, ...backboneIds: number[]) {
  const clientId = Number(db.prepare('INSERT INTO clients (client_code, full_name) VALUES (?, ?)').run(code, `Cliente ${code}`).lastInsertRowid);
  const serviceId = Number(db.prepare("INSERT INTO services (client_id, status) VALUES (?, 'active')").run(clientId).lastInsertRowid);
  for (const backboneId of backboneIds) {
    const assignmentId = Number(db.prepare("INSERT INTO service_device_assignments (service_id, catalog_id, start_date) VALUES (?, ?, '2026-01-01')")
      .run(serviceId, catalogId).lastInsertRowid);
    db.prepare('INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id) VALUES (?, ?)').run(backboneId, assignmentId);
  }
}

describe('downstreamClosure', () => {
  test('só arrasta quem não tem outro uplink de pé', () => {
    const uplinks = new Map([[2, [1]], [3, [2]], [4, [1, 9]]]);
    expect([...downstreamClosure(1, uplinks)].sort()).toEqual([1, 2, 3]);
  });
});

describe('loadIncidents', () => {
  test('emparelha a queda com o regresso e conta os clientes afetados', () => {
    const antena = device('Antena X');
    client('C001', antena);
    client('C002', antena);
    event(antena, 'down', '2026-10-01 10:00:00');
    event(antena, 'up', '2026-10-01 10:37:00');
    const [incident] = loadIncidents(db, 30, NOW).incidents;
    expect(incident).toMatchObject({ name: 'Antena X', zone: 'Praia', status: 'resolved', startedAt: '2026-10-01 10:00:00', endedAt: '2026-10-01 10:37:00', durationSeconds: 37 * 60 });
    expect(incident.clients.map((row) => row.clientCode)).toEqual(['C001', 'C002']);
  });

  test('sem regresso fica em curso, primeiro na lista, com a duração até agora', () => {
    const antiga = device('Antiga');
    const aberta = device('Aberta');
    event(antiga, 'down', '2026-10-02 08:00:00');
    event(antiga, 'up', '2026-10-02 08:05:00');
    event(aberta, 'down', '2026-10-01 12:00:00');
    stillDown(aberta);
    const incidents = loadIncidents(db, 30, NOW).incidents;
    expect(incidents.map((row) => row.name)).toEqual(['Aberta', 'Antiga']);
    expect(incidents[0]).toMatchObject({ status: 'open', endedAt: null, durationSeconds: 86_400 });
  });

  test('uma queda anterior à janela que continua aberta aparece', () => {
    const antena = device('Antena X');
    event(antena, 'down', '2026-06-01 10:00:00');
    stillDown(antena);
    expect(loadIncidents(db, 30, NOW).incidents).toHaveLength(1);
  });

  test('regresso depois de um buraco de observação não inventa duração', () => {
    const antena = device('Antena X');
    event(antena, 'down', '2026-10-01 10:00:00');
    event(antena, 'up', '2026-10-02 09:00:00', 1);
    expect(loadIncidents(db, 30, NOW).incidents[0]).toMatchObject({ status: 'unknown', durationSeconds: null });
  });

  test('o que cai por arrasto não é linha: entra na causa, com os seus clientes', () => {
    const antena = device('Antena X');
    const ap = device('AP Norte');
    link(ap, antena);
    client('C001', antena);
    client('C002', ap);
    // A jusante a sonda declarou a queda uma leitura antes da causa.
    event(ap, 'down', '2026-10-01 10:00:00');
    event(antena, 'down', '2026-10-01 10:01:00');
    event(antena, 'up', '2026-10-01 10:30:00');
    event(ap, 'up', '2026-10-01 10:30:00');
    const incidents = loadIncidents(db, 30, NOW).incidents;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ name: 'Antena X', draggedDevices: ['AP Norte'] });
    expect(incidents[0].clients).toHaveLength(2);
  });

  test('com dois uplinks e só um em baixo, a queda a jusante é um incidente próprio', () => {
    const starlinkA = device('Starlink A');
    const starlinkB = device('Starlink B');
    const router = device('Router');
    link(router, starlinkA);
    link(router, starlinkB);
    event(starlinkA, 'down', '2026-10-01 10:00:00');
    event(router, 'down', '2026-10-01 10:00:00');
    const incidents = loadIncidents(db, 30, NOW).incidents;
    expect(incidents.map((row) => row.name).sort()).toEqual(['Router', 'Starlink A']);
    expect(incidents.find((row) => row.name === 'Starlink A')?.draggedDevices).toEqual([]);
  });

  test('um cliente ligado a dois equipamentos arrastados conta uma vez', () => {
    const antena = device('Antena X');
    const ap = device('AP Norte');
    link(ap, antena);
    client('C001', antena, ap);
    event(antena, 'down', '2026-10-01 10:00:00');
    expect(loadIncidents(db, 30, NOW).incidents[0].clients).toHaveLength(1);
  });
});
