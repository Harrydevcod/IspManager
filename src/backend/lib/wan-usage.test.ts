import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { counterDelta, loadWanUsage, recordWanUsage } from './wan-usage';
import type { RouterRequest, RouterTransport } from './routeros';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

function fakeTransport(rx1: number, rx2: number, tx1 = 0, tx2 = 0): RouterTransport {
  return async (request: RouterRequest) => {
    if (request.path.startsWith('/interface/list/member')) return [{ interface: 'WAN1-STARLINK' }, { interface: 'WAN2-STARLINK' }];
    if (request.path.startsWith('/interface?')) return [
      { name: 'WAN1-STARLINK', 'rx-byte': String(rx1), 'tx-byte': String(tx1) },
      { name: 'WAN2-STARLINK', 'rx-byte': String(rx2), 'tx-byte': String(tx2) },
      { name: 'LAN1', 'rx-byte': '999', 'tx-byte': '999' }
    ];
    throw new Error(`Pedido inesperado: ${request.path}`);
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-wan-usage-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM wan_traffic_daily').run();
  db.prepare('DELETE FROM wan_counter_state').run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

describe('counterDelta', () => {
  test('crescimento', () => expect(counterDelta(100, 150)).toBe(50));
  test('reinício do router', () => expect(counterDelta(100, 30)).toBe(30));
  test('primeira leitura', () => expect(counterDelta(null, 100)).toBe(0));
});

describe('tráfego acumulado das WAN', () => {
  test('duas leituras acumulam; o reinício soma o contador novo sem duplicar; outro dia abre linha', async () => {
    expect(await recordWanUsage(db, fakeTransport(100, 200, 10, 20), '2026-09-25')).toMatchObject({ interfaces: 2, rxBytes: 0, txBytes: 0 });
    expect(await recordWanUsage(db, fakeTransport(150, 240, 15, 24), '2026-09-25')).toMatchObject({ rxBytes: 90, txBytes: 9 });
    expect(await recordWanUsage(db, fakeTransport(20, 10, 2, 1), '2026-09-25')).toMatchObject({ rxBytes: 30, txBytes: 3 });
    expect(await recordWanUsage(db, fakeTransport(30, 15, 3, 2), '2026-09-26')).toMatchObject({ rxBytes: 15, txBytes: 2 });
    expect(db.prepare('SELECT day, interface, rx_bytes AS rx FROM wan_traffic_daily ORDER BY day, interface').all()).toEqual([
      { day: '2026-09-25', interface: 'WAN1-STARLINK', rx: 70 },
      { day: '2026-09-25', interface: 'WAN2-STARLINK', rx: 50 },
      { day: '2026-09-26', interface: 'WAN1-STARLINK', rx: 10 },
      { day: '2026-09-26', interface: 'WAN2-STARLINK', rx: 5 }
    ]);
  });

  test('lê hoje, o mês e 30 dias com zeros nas datas sem leituras', async () => {
    await recordWanUsage(db, fakeTransport(100, 200), '2026-09-01');
    await recordWanUsage(db, fakeTransport(110, 220), '2026-09-01');
    await recordWanUsage(db, fakeTransport(120, 240), '2026-09-26');
    const result = loadWanUsage(db, '2026-09-26');
    expect(result.since).toBeTruthy();
    expect(result.today).toEqual([
      { interface: 'WAN1-STARLINK', rxBytes: 10, txBytes: 0 },
      { interface: 'WAN2-STARLINK', rxBytes: 20, txBytes: 0 }
    ]);
    expect(result.month.map((row) => row.rxBytes)).toEqual([20, 40]);
    expect(result.days).toHaveLength(30);
    expect(result.days[0].day).toBe('2026-08-28');
    expect(result.days[0].perInterface.map((row) => row.rxBytes)).toEqual([0, 0]);
    expect(result.days.at(-1)?.perInterface.map((row) => row.rxBytes)).toEqual([10, 20]);
  });
});
