import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { collectWanUsage, counterDelta, importRouterUsage, loadWanUsage, parseWanUsageFile, recordWanUsage } from './wan-usage';
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
  db.prepare("DELETE FROM app_settings WHERE key IN ('wanUsageRouterImportedAt', 'wanUsageRouterFirstDay')").run();
});

describe('ficheiro do contador no router', () => {
  test('o dia do router vem em dias desde 1970 (UTC) e soma-se ao troço da v5 do mesmo dia', () => {
    // 20726 = 2026-09-30.
    expect(parseWanUsageFile('# 2026-09-30;WAN1;10;1\n# 20726;WAN1;5;2\n# 20725;WAN1;7;0\n')).toEqual([
      { day: '2026-09-30', interface: 'WAN1', rxBytes: 15, txBytes: 3 },
      { day: '2026-09-29', interface: 'WAN1', rxBytes: 7, txBytes: 0 }
    ]);
  });

  test('aceita linhas válidas e ignora linhas malformadas, negativas e valores sem precisão', () => {
    expect(parseWanUsageFile('2026-09-25;WAN1;123;45\nmalformada\n2026-09-26;WAN2;-1;3\n2026-09-27;WAN2;9007199254740992;3\n# 2026-09-28;WAN2;0;7\n# last;WAN2;5;6\n# uptime;1d02:03:04'))
      .toEqual([
        { day: '2026-09-25', interface: 'WAN1', rxBytes: 123, txBytes: 45 },
        { day: '2026-09-28', interface: 'WAN2', rxBytes: 0, txBytes: 7 }
      ]);
  });

  test('substitui apenas os dias presentes no ficheiro e conserva os restantes', () => {
    db.prepare('INSERT INTO wan_traffic_daily (day, interface, rx_bytes, tx_bytes) VALUES (?, ?, ?, ?)').run('2026-09-24', 'WAN1', 10, 2);
    db.prepare('INSERT INTO wan_traffic_daily (day, interface, rx_bytes, tx_bytes) VALUES (?, ?, ?, ?)').run('2026-09-25', 'WAN1', 50, 5);
    importRouterUsage(db, [{ day: '2026-09-25', interface: 'WAN1', rxBytes: 100, txBytes: 20 }]);
    expect(db.prepare('SELECT day, rx_bytes AS rx, tx_bytes AS tx FROM wan_traffic_daily ORDER BY day').all()).toEqual([
      { day: '2026-09-24', rx: 10, tx: 2 }, { day: '2026-09-25', rx: 100, tx: 20 }
    ]);
    expect(loadWanUsage(db, '2026-09-25').routerImportedAt).toBeTruthy();
    expect(loadWanUsage(db, '2026-09-25').days.at(-1)?.perInterface[0]).toEqual({ interface: 'WAN1', rxBytes: 100, txBytes: 20 });
  });

  test('exactSince: dia seguinte ao primeiro que o router contou, e não avança quando o router poda', () => {
    expect(loadWanUsage(db, '2026-10-03').exactSince).toBeNull();
    importRouterUsage(db, [{ day: '2026-09-30', interface: 'WAN1', rxBytes: 1, txBytes: 1 }, { day: '2026-09-29', interface: 'WAN1', rxBytes: 1, txBytes: 1 }]);
    importRouterUsage(db, [{ day: '2026-10-02', interface: 'WAN1', rxBytes: 1, txBytes: 1 }]);
    expect(loadWanUsage(db, '2026-10-03').exactSince).toBe('2026-09-30');
  });

  test('com dados do router soma a hoje o que passou desde a gravação; sem dados usa o fallback', async () => {
    const withFile: RouterTransport = async (request) => {
      if (request.path.startsWith('/system/script?name=ispm-wan-usage-data')) {
        return [{ source: '# uptime;1d\n# last;WAN1-STARLINK;90;40\n# last;WAN2-STARLINK;500;0\n# 2026-09-25;WAN1-STARLINK;7;3\n# 2026-09-24;WAN2-STARLINK;1;1\n' }];
      }
      if (request.path.startsWith('/interface/list/member')) throw new Error('Não devia usar o fallback');
      return fakeTransport(100, 200, 45)(request);
    };
    await expect(collectWanUsage(db, withFile, '2026-09-25')).resolves.toMatchObject({ source: 'router', rows: 3 });
    const today = (name: string) => db.prepare("SELECT rx_bytes AS rx, tx_bytes AS tx FROM wan_traffic_daily WHERE day = '2026-09-25' AND interface = ?").get(name);
    // WAN1: 7 gravados + (100 − 90) desde a gravação; WAN2: contador abaixo do gravado = reinício, conta 200.
    expect(today('WAN1-STARLINK')).toEqual({ rx: 17, tx: 8 });
    expect(today('WAN2-STARLINK')).toEqual({ rx: 200, tx: 0 });
    db.prepare('DELETE FROM wan_traffic_daily').run();
    const onlyTotals: RouterTransport = async (request) => {
      if (request.path.startsWith('/system/script?name=ispm-wan-usage-data')) return [{ source: '# uptime;1d\n# last;WAN1;9;9\n# 2026-09-25;WAN1;7;3\n' }];
      return fakeTransport(100, 200)(request);
    };
    await expect(collectWanUsage(db, onlyTotals, '2026-09-25')).resolves.toMatchObject({ source: 'router', rows: 1 });
    const withoutFile: RouterTransport = async (request) => {
      if (request.path.startsWith('/system/script?name=ispm-wan-usage-data')) return [];
      return fakeTransport(100, 200)(request);
    };
    await expect(collectWanUsage(db, withoutFile)).resolves.toMatchObject({ source: 'fallback', interfaces: 2 });
    // Script de dados já criado mas ainda sem totais: continua o fallback.
    const emptyData: RouterTransport = async (request) => {
      if (request.path.startsWith('/system/script?name=ispm-wan-usage-data')) return [{ source: '# uptime;5m\n' }];
      return fakeTransport(100, 200)(request);
    };
    await expect(collectWanUsage(db, emptyData)).resolves.toMatchObject({ source: 'fallback' });
    // Dia da instalação: o router só conta desde a instalação, não apaga o que o ISPM já tinha.
    importRouterUsage(db, [{ day: '2026-09-25', interface: 'WAN1', rxBytes: 3, txBytes: 1 }]);
    expect(db.prepare("SELECT rx_bytes AS rx FROM wan_traffic_daily WHERE day = '2026-09-25' AND interface = 'WAN1'").get()).toEqual({ rx: 7 });
  });
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
