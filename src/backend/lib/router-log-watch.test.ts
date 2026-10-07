import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import * as adminNetwork from './admin-network';
import { collectFindings, freshEntries, runRouterLogWatchIfDue, watchRouterLog } from './router-log-watch';
import type { RouterLogEntry, RouterTransport } from './routeros';
import { writeSecret } from './secrets';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

const NOW = new Date('2026-10-07T14:00:00');
const ROGUE = (ip: string, mac: string) => `LAN1: received DHCP server message on untrusted port from source IP ${ip}, MAC ${mac}`;
const DOWN = (host: string) => `event down [ type: simple, host: ${host} ]`;

/** Linhas como o router as devolve: `.id` hexadecimal crescente, as mais antigas primeiro. */
function log(...lines: Array<[id: number, time: string, topics: string, message: string]>) {
  return lines.map(([id, time, topics, message]) => ({ '.id': `*${id.toString(16).toUpperCase()}`, time, topics, message }));
}

function router(rows: ReturnType<typeof log>, addresses = ['192.168.1.1/24', '192.168.2.1/24']): RouterTransport {
  return async ({ path: requested }) => requested.startsWith('/ip/address')
    ? addresses.map((address) => ({ address }))
    : rows;
}

const findings = () => db.prepare('SELECT day, kind, subject, label, count, first_at AS firstAt, last_at AS lastAt FROM router_log_findings ORDER BY day, kind, subject').all();

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-router-log-watch-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM router_log_findings').run();
  db.prepare('DELETE FROM app_settings').run();
  vi.restoreAllMocks();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

describe('achados do registo do router', () => {
  const entry = (id: string, time: string, topics: string, message: string): RouterLogEntry => ({ id, time, topics, message });

  test('cada tipo de linha vira um achado com o seu sujeito', () => {
    const found = collectFindings([
      entry('*1', '2026-10-07 10:29:34', 'netwatch,info', DOWN('192.168.1.251')),
      entry('*2', '2026-10-07 10:30:00', 'bridge,warning', ROGUE('192.168.0.1', '30:16:9d:aa:53:8b')),
      entry('*3', '2026-10-07 10:31:00', 'pppoe,ppp,info', '<pppoe-skn001>: terminating... - hungup'),
      entry('*4', '2026-10-07 10:32:00', 'dhcp,info', 'dhcp-SKYNET deassigned 192.168.2.249 for 08:8A:F1:6F:4C:93 MW325R'),
      entry('*5', '2026-10-07 10:33:00', 'system,error,critical', 'login failure for user admin from 192.168.2.50 via winbox'),
      entry('*6', '2026-10-07 10:34:00', 'netwatch,info', 'event up [ type: simple, host: 192.168.1.251 ]'),
      entry('*7', '2026-10-07 10:35:00', 'script,warning', 'ANTENA EM BAIXO: TL-S5 Espia')
    ], ['192.168.1.1'], NOW);
    expect(found.map(({ kind, subject, label, count }) => ({ kind, subject, label, count }))).toEqual([
      { kind: 'antena_em_baixo', subject: '192.168.1.251', label: '', count: 1 },
      { kind: 'dhcp_intruso', subject: '30:16:9D:AA:53:8B', label: 'LAN1 · 192.168.0.1', count: 1 },
      { kind: 'pppoe_queda', subject: 'skn001', label: 'hungup', count: 1 },
      { kind: 'dhcp_ciclo', subject: '08:8A:F1:6F:4C:93', label: 'MW325R · 192.168.2.249', count: 1 },
      { kind: 'login_falhado', subject: '192.168.2.50 winbox', label: 'admin', count: 1 }
    ]);
  });

  test('um DHCP intruso com o endereço do próprio router é um endereço duplicado', () => {
    const found = collectFindings([
      entry('*1', '2026-10-07 10:29:23', 'bridge,warning', ROGUE('192.168.1.1', 'bc:07:1d:5e:42:9e')),
      entry('*2', '2026-10-07 13:16:00', 'bridge,warning', ROGUE('192.168.1.1', 'bc:07:1d:5e:42:9e'))
    ], ['192.168.1.1', '192.168.2.1'], NOW);
    expect(found).toEqual([{
      day: '2026-10-07', kind: 'ip_duplicado', subject: 'BC:07:1D:5E:42:9E', label: 'LAN1 · 192.168.1.1',
      count: 2, firstAt: '2026-10-07 10:29:23', lastAt: '2026-10-07 13:16:00'
    }]);
  });

  test('linhas de dois dias caem em dois dias; uma hora sem data é de hoje', () => {
    const found = collectFindings([
      entry('*1', '2026-10-06 23:59:00', 'netwatch,info', DOWN('192.168.1.110')),
      entry('*2', '00:01:00', 'netwatch,info', DOWN('192.168.1.110'))
    ], [], NOW);
    expect(found.map(({ day, count, firstAt }) => ({ day, count, firstAt }))).toEqual([
      { day: '2026-10-06', count: 1, firstAt: '2026-10-06 23:59:00' },
      { day: '2026-10-07', count: 1, firstAt: '2026-10-07 00:01:00' }
    ]);
  });

  test('só as linhas depois do cursor são novas; um router reiniciado recomeça', () => {
    const entries = [entry('*A', 't', '', 'a'), entry('*B', 't', '', 'b'), entry('*10', 't', '', 'c')];
    expect(freshEntries(entries, null)).toEqual({ fresh: entries, cursor: '*10' });
    expect(freshEntries(entries, '*B').fresh.map((row) => row.message)).toEqual(['c']);
    expect(freshEntries(entries, '*10')).toEqual({ fresh: [], cursor: '*10' });
    // O maior id lido é menor do que o cursor: o registo recomeçou do zero.
    expect(freshEntries(entries, '*FFF')).toEqual({ fresh: entries, cursor: '*10' });
    expect(freshEntries([], '*B')).toEqual({ fresh: [], cursor: '*B' });
  });
});

describe('vigia do registo do router', () => {
  test('a mesma leitura duas vezes conta uma, e as linhas novas somam ao dia', async () => {
    const first = log(
      [1, '2026-10-07 10:29:34', 'netwatch,info', DOWN('192.168.1.251')],
      [2, '2026-10-07 10:36:04', 'netwatch,info', DOWN('192.168.1.251')]
    );
    expect(await watchRouterLog(db, router(first), NOW)).toEqual({ lines: 2, findings: 1 });
    expect(await watchRouterLog(db, router(first), NOW)).toEqual({ lines: 0, findings: 0 });
    const second = [...first, ...log([3, '2026-10-07 10:38:04', 'netwatch,info', DOWN('192.168.1.251')])];
    await watchRouterLog(db, router(second), NOW);
    expect(findings()).toEqual([{
      day: '2026-10-07', kind: 'antena_em_baixo', subject: '192.168.1.251', label: '',
      count: 3, firstAt: '2026-10-07 10:29:34', lastAt: '2026-10-07 10:38:04'
    }]);
  });

  test('o endereço duplicado grava-se com os endereços que o router diz ter', async () => {
    await watchRouterLog(db, router(log([1, '2026-10-07 10:29:23', 'bridge,warning', ROGUE('192.168.1.1', 'bc:07:1d:5e:42:9e')])), NOW);
    expect(findings()).toMatchObject([{ kind: 'ip_duplicado', subject: 'BC:07:1D:5E:42:9E' }]);
  });

  test('router por configurar ou fora da rede de gestão: salta sem escrever', async () => {
    expect(await runRouterLogWatchIfDue()).toMatchObject({ skipped: true });
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('routerosEnabled', 'true'), ('routerosHost', '127.0.0.1'), ('routerosUser', 'ispm')").run();
    writeSecret(db, 'routerosPassword', 'segredo');
    vi.spyOn(adminNetwork, 'detectAdminNetwork').mockResolvedValue({ state: 'offsite' } as adminNetwork.AdminNetworkPresence);
    expect(await runRouterLogWatchIfDue()).toMatchObject({ skipped: true });
    expect(findings()).toEqual([]);
  });
});
