import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createDiaryEntry, listDiary, loadNetworkHealth, updateDiaryEntry } from './network-health';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let catalogId: number;

const NOW = new Date('2026-10-07T14:00:00');
/** Os eventos da sonda estão em UTC; os achados do router na hora local dele. */
const utc = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-network-health-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  catalogId = Number(db.prepare("INSERT INTO equipment_catalog (type, model) VALUES ('antena', 'Teste')").run().lastInsertRowid);
});

beforeEach(() => {
  for (const table of ['network_diary', 'router_log_findings', 'network_probe_events', 'network_probe_state', 'network_discovery_hosts',
    'service_device_assignments', 'backbone_devices', 'services', 'clients', 'app_settings']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

const antenna = (name: string, ip: string) => Number(db.prepare('INSERT INTO backbone_devices (catalog_id, name, ip_address) VALUES (?, ?, ?)')
  .run(catalogId, name, ip).lastInsertRowid);

function clientDevice(name: string, ip: string, mac: string | null = null, login: string | null = null) {
  const clientId = Number(db.prepare('INSERT INTO clients (client_code, full_name) VALUES (?, ?)').run(`C-${name}`, name).lastInsertRowid);
  const serviceId = Number(db.prepare("INSERT INTO services (client_id, status, pppoe_username) VALUES (?, 'active', ?)").run(clientId, login).lastInsertRowid);
  return Number(db.prepare("INSERT INTO service_device_assignments (service_id, catalog_id, start_date, ip_address, mac_address) VALUES (?, ?, '2026-01-01', ?, ?)")
    .run(serviceId, catalogId, ip, mac).lastInsertRowid);
}

/** Uma queda fechada: caiu há `hoursAgo` horas e voltou `seconds` depois. */
function outage(kind: 'backbone' | 'assignment', id: number, hoursAgo: number, seconds: number) {
  const insert = db.prepare(`INSERT INTO network_probe_events (target_kind, target_id, ip_address, from_state, to_state, at, duration_seconds, gap_before)
    VALUES (?, ?, '10.0.0.1', ?, ?, ?, ?, 0)`);
  insert.run(kind, id, 'up', 'down', utc(hoursAgo), 999);
  insert.run(kind, id, 'down', 'up', utc(hoursAgo - seconds / 3600), seconds);
}

const finding = (kind: string, subject: string, lastAt: string, count = 1, label = '') =>
  db.prepare('INSERT INTO router_log_findings (day, kind, subject, label, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(lastAt.slice(0, 10), kind, subject, label, count, lastAt, lastAt);

describe('saúde da rede', () => {
  test('rede sem nada a assinalar', () => {
    expect(loadNetworkHealth(db, 72, NOW)).toMatchObject({
      hours: 72, tone: 'ok', probeEnabled: false, lastProbeAt: null, lastRouterReadAt: null, routerJournal: false,
      antennas: [], clients: [], downNow: [], findings: [], diary: []
    });
  });

  test('soma as quedas da janela por antena e por cliente, e deixa de fora o que é mais antigo', () => {
    const espia = antenna('TL-S5 Espia', '192.168.1.251');
    const cruz = antenna('CPE710 Cruz', '192.168.1.140');
    outage('backbone', espia, 20, 600);
    outage('backbone', espia, 10, 1200);
    outage('backbone', cruz, 100, 300);
    const anilsa = clientDevice('Anilsa', '192.168.1.248');
    const helen = clientDevice('Helen', '192.168.1.112');
    outage('assignment', anilsa, 5, 900);
    outage('assignment', helen, 5, 60);
    const health = loadNetworkHealth(db, 72, NOW);
    expect(health.tone).toBe('warn');
    expect(health.antennas).toEqual([{ id: espia, name: 'TL-S5 Espia', ipAddress: '192.168.1.251', downs: 2, downSeconds: 1800, longestSeconds: 1200 }]);
    expect(health.clients.map(({ name, downs, downSeconds }) => ({ name, downs, downSeconds }))).toEqual([
      { name: 'Anilsa', downs: 1, downSeconds: 900 },
      { name: 'Helen', downs: 1, downSeconds: 60 }
    ]);
  });

  test('em baixo agora só conta a última passagem da sonda; uma antena em baixo é crítico', () => {
    const espia = antenna('TL-S5 Espia', '192.168.1.251');
    const velha = antenna('Antena velha', '192.168.1.169');
    const state = db.prepare(`INSERT INTO network_probe_state (target_kind, target_id, ip_address, state, last_change_at, checked_at)
      VALUES ('backbone', ?, ?, 'down', ?, ?)`);
    state.run(espia, '192.168.1.251', utc(1), utc(0));
    state.run(velha, '192.168.1.169', utc(700), utc(600));
    const health = loadNetworkHealth(db, 72, NOW);
    expect(health.downNow).toEqual([{ kind: 'backbone', id: espia, name: 'TL-S5 Espia', ipAddress: '192.168.1.251', since: utc(1) }]);
    expect(health.lastProbeAt).toBe(utc(0));
    expect(health.tone).toBe('danger');
  });

  test('os achados do router somam os dias da janela e ganham nome, cliente e fabricante', () => {
    antenna('TL-S5 Espia', '192.168.1.251');
    clientDevice('Alcindo Alves', '192.168.1.146', '18:FD:74:22:23:B7', 'skn001');
    db.prepare("INSERT INTO network_discovery_hosts (ip_address, mac_address, vendor) VALUES ('192.168.0.1', '30:16:9D:AA:53:8B', 'MERCUSYS')").run();
    finding('antena_em_baixo', '192.168.1.251', '2026-10-06 20:00:00', 21);
    finding('antena_em_baixo', '192.168.1.251', '2026-10-07 12:00:00', 17);
    finding('antena_em_baixo', '192.168.1.251', '2026-10-01 12:00:00', 99);
    finding('dhcp_intruso', '30:16:9D:AA:53:8B', '2026-10-07 13:00:00', 174, 'LAN1 · 192.168.0.1');
    finding('pppoe_queda', 'skn001', '2026-10-07 12:30:00', 1, 'hungup');
    finding('dhcp_ciclo', '08:8A:F1:6F:4C:93', '2026-10-07 12:00:00', 9, 'MW325R · 192.168.2.249');
    finding('dhcp_ciclo', '18:FD:74:22:23:B7', '2026-10-07 12:00:00', 10);
    const health = loadNetworkHealth(db, 72, NOW);
    expect(health.tone).toBe('warn');
    expect(health.findings.map(({ kind, subject, count, deviceName, clientName, vendor }) => ({ kind, subject, count, deviceName, clientName, vendor }))).toEqual([
      { kind: 'antena_em_baixo', subject: '192.168.1.251', count: 38, deviceName: 'TL-S5 Espia', clientName: null, vendor: null },
      { kind: 'dhcp_intruso', subject: '30:16:9D:AA:53:8B', count: 174, deviceName: null, clientName: null, vendor: 'MERCUSYS' },
      { kind: 'pppoe_queda', subject: 'skn001', count: 1, deviceName: null, clientName: 'Alcindo Alves', vendor: null },
      // Abaixo do limiar não é ciclo: é um aparelho a sair da rede.
      { kind: 'dhcp_ciclo', subject: '18:FD:74:22:23:B7', count: 10, deviceName: null, clientName: 'Alcindo Alves', vendor: null }
    ]);
    expect(health.findings[0]).toMatchObject({ firstAt: '2026-10-06 20:00:00', lastAt: '2026-10-07 12:00:00' });
  });

  test('o endereço do router duplicado é crítico durante 24 horas, depois só aviso', () => {
    finding('ip_duplicado', 'BC:07:1D:5E:42:9E', '2026-10-07 13:16:00', 74, 'LAN1 · 192.168.1.1');
    expect(loadNetworkHealth(db, 72, NOW).tone).toBe('danger');
    expect(loadNetworkHealth(db, 72, new Date('2026-10-08T13:17:00')).tone).toBe('warn');
  });

  test('o laço na rede é crítico durante 24 horas e vem à frente de tudo', () => {
    finding('ip_duplicado', 'BC:07:1D:5E:42:9E', '2026-10-05 13:16:00', 74, 'LAN1 · 192.168.1.1');
    finding('laco_rede', '04:F4:1C:45:FD:96', '2026-10-07 13:16:00', 1, 'LAN1 · 192.168.1.1');
    const health = loadNetworkHealth(db, 72, NOW);
    expect(health.tone).toBe('danger');
    expect(health.findings.map((row) => row.kind)).toEqual(['laco_rede', 'ip_duplicado']);
    expect(loadNetworkHealth(db, 72, new Date('2026-10-08T13:17:00')).tone).toBe('warn');
  });

  test('diz quando foi a última leitura do router', () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('routerLogReadAt', '2026-10-07T14:55:00.000Z'), ('networkProbeEnabled', 'true')").run();
    expect(loadNetworkHealth(db, 72, NOW)).toMatchObject({ lastRouterReadAt: '2026-10-07T14:55:00.000Z', probeEnabled: true });
  });
});

describe('diário de ocorrências', () => {
  test('regista, fecha com a resolução e mostra as abertas primeiro', () => {
    const conflito = createDiaryEntry(db, { happenedAt: '2026-10-06T17:54', title: 'Antenas a cair em conjunto' }, null);
    createDiaryEntry(db, { happenedAt: '2026-10-07T20:00', title: 'Mercusys com DHCP na rede', cause: 'Cabo na porta LAN' }, null);
    expect(listDiary(db).map((row) => row.title)).toEqual(['Mercusys com DHCP na rede', 'Antenas a cair em conjunto']);
    expect(updateDiaryEntry(db, conflito.id, { status: 'resolvida', cause: 'TL-WR850N no 192.168.1.1', resolution: 'Retirado da rede' }))
      .toMatchObject({ id: conflito.id, status: 'resolvida', cause: 'TL-WR850N no 192.168.1.1', resolution: 'Retirado da rede', title: 'Antenas a cair em conjunto' });
    expect(listDiary(db).map((row) => row.status)).toEqual(['aberta', 'resolvida']);
    expect(updateDiaryEntry(db, 999_999, { status: 'resolvida' })).toBeNull();
    expect(loadNetworkHealth(db, 72, NOW).diary).toHaveLength(2);
  });
});
