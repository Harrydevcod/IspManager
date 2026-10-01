import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

vi.mock('./admin-network', () => ({
  detectAdminNetwork: async () => ({ state: 'offsite', checkedAt: new Date().toISOString(), detail: 'O router de gestão do ISP não respondeu.' }),
  isOffNetwork: (presence: { state: string }) => presence.state === 'offsite' || presence.state === 'foreign',
  offNetworkReason: (presence: { detail: string }) => `Fora da rede de gestão: ${presence.detail}`
}));
vi.mock('./routeros', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./routeros')>();
  return { ...actual, readRouterConfig: () => ({
    enabled: true, host: '192.0.2.1', port: 443, user: 'ispm', password: 'segredo',
    dryRun: false, intervalSeconds: 120, tlsCert: 'fixado', maxDisablesPerRun: 5
  }) };
});

let db: Database.Database;
let close: () => void;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ispm-network-gates-'));
  process.env.ISPM_DATA_DIR = dir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  close = database.closeDatabaseForTests;
});

afterAll(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

test('trabalhos de rede fora do local saltam sem escrever dados nem auditoria', async () => {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('networkProbeEnabled', 'true')").run();
  const tables = ['network_probe_events', 'network_probe_state', 'wan_traffic_daily', 'wan_counter_state', 'audit_logs', 'service_network_state'];
  const counts = () => tables.map((table) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const before = counts();
  const { runNetworkProbeIfDue } = await import('./network-probe');
  const { runWanUsageIfDue } = await import('./wan-usage');
  const { runNetworkEnforcementIfDue } = await import('./network-enforcement');
  for (const run of [runNetworkProbeIfDue, runWanUsageIfDue, runNetworkEnforcementIfDue]) {
    expect(await run()).toMatchObject({ skipped: true, reason: expect.stringContaining('Fora da rede de gestão') });
    expect(counts()).toEqual(before);
  }
});
