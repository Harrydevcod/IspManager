import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { collectClientUsage, loadClientUsage, parseClientUsageFile } from './client-usage';
import { utcDay } from './wan-usage';
import type { RouterTransport } from './routeros';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
const source = (text: string): RouterTransport => async () => [{ source: text }];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-client-usage-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM client_traffic_daily').run();
  db.prepare('DELETE FROM client_usage_state').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare("INSERT INTO clients (client_code, full_name) VALUES ('C001', 'Ana')").run();
  db.prepare("INSERT INTO services (client_id, pppoe_username, status) VALUES ((SELECT id FROM clients WHERE client_code = 'C001'), 'ana', 'active')").run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

describe('consumo PPPoE', () => {
  test('analisa linhas válidas e ignora valores inseguros', () => {
    expect(parseClientUsageFile('# ana;10;20;1;2;1h\n# mau;-1;2;1;2;1h\n# grande;9007199254740992;1;1;1;1h'))
      .toEqual([{ name: 'ana', rxTotal: 10, txTotal: 20, rxLast: 1, txLast: 2, uptime: '1h' }]);
  });

  test('a primeira leitura conta zero; diferenças, reinício e nomes desconhecidos avançam o estado', async () => {
    await collectClientUsage(db, source('# ana;100;200;10;20;1h\n# desconhecido;5;6;1;1;1h'), '2026-10-01');
    expect(loadClientUsage(db, '2026-10-01')[0]).toMatchObject({ measured: 1, todayDownBytes: 0, todayUpBytes: 0 });
    await collectClientUsage(db, source('# ana;130;260;30;60;2h\n# desconhecido;10;15;2;2;2h'), '2026-10-01');
    expect(loadClientUsage(db, '2026-10-01')[0]).toMatchObject({ todayDownBytes: 60, todayUpBytes: 30 });
    await collectClientUsage(db, source('# ana;8;12;8;12;1m'), '2026-10-02');
    expect(loadClientUsage(db, '2026-10-02')[0]).toMatchObject({ todayDownBytes: 12, todayUpBytes: 8, monthDownBytes: 72, monthUpBytes: 38 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM client_traffic_daily').get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT rx_total AS rx FROM client_usage_state WHERE pppoe_name = 'desconhecido'").get() as { rx: number }).rx).toBe(10);
  });

  test('dia UTC', () => {
    expect(utcDay(new Date('2026-10-02T00:30:00Z'))).toBe('2026-10-02');
  });
});
