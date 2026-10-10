import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import * as adminNetwork from './admin-network';
import {
  collectFindings, compactStoredLines, freshEntries, freshJournalLines, installLogJournal, listLogDays, loadLogDay, parseJournal, runRouterLogWatchIfDue, watchRouterLog
} from './router-log-watch';
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

const ROUTER_MAC = '04:F4:1C:45:FD:96';

function router(rows: ReturnType<typeof log>, addresses = ['192.168.1.1/24', '192.168.2.1/24']): RouterTransport {
  return async ({ path: requested }) => {
    if (requested.startsWith('/ip/address')) return addresses.map((address) => ({ address }));
    if (requested.startsWith('/interface')) return [{ name: 'bridge-LAN', 'mac-address': ROUTER_MAC }, { name: 'pppoe-out1' }];
    return rows;
  };
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
  db.prepare('DELETE FROM router_log_lines').run();
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
    ], { addresses: ['192.168.1.1'], macs: [] }, NOW);
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
    ], { addresses: ['192.168.1.1', '192.168.2.1'], macs: [ROUTER_MAC] }, NOW);
    expect(found).toEqual([{
      day: '2026-10-07', kind: 'ip_duplicado', subject: 'BC:07:1D:5E:42:9E', label: 'LAN1 · 192.168.1.1',
      count: 2, firstAt: '2026-10-07 10:29:23', lastAt: '2026-10-07 13:16:00'
    }]);
  });

  test('o router a ouvir a própria resposta DHCP é um laço na rede, não um endereço duplicado', () => {
    const found = collectFindings([
      entry('*1', '2026-10-08 20:06:54', 'bridge,warning', ROGUE('192.168.1.1', '04:f4:1c:45:fd:96'))
    ], { addresses: ['192.168.1.1'], macs: [ROUTER_MAC.toLowerCase()] }, NOW);
    expect(found).toMatchObject([{ kind: 'laco_rede', subject: ROUTER_MAC, label: 'LAN1 · 192.168.1.1', count: 1 }]);
  });

  test('linhas de dois dias caem em dois dias; uma hora sem data é de hoje', () => {
    const found = collectFindings([
      entry('*1', '2026-10-06 23:59:00', 'netwatch,info', DOWN('192.168.1.110')),
      entry('*2', '00:01:00', 'netwatch,info', DOWN('192.168.1.110'))
    ], { addresses: [], macs: [] }, NOW);
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

  test('o laço grava-se com os MAC que o router diz ter, e o que estava como duplicado é corrigido', async () => {
    const insert = db.prepare("INSERT INTO router_log_findings (day, kind, subject, label, count, first_at, last_at) VALUES (?, 'ip_duplicado', ?, 'LAN1 · 192.168.1.1', ?, ?, ?)");
    insert.run('2026-10-08', ROUTER_MAC, 1, '2026-10-08 20:06:54', '2026-10-08 20:06:54');
    insert.run('2026-10-07', 'BC:07:1D:5E:42:9E', 49, '2026-10-07 16:13:12', '2026-10-07 18:18:53');
    const rows = log([1, '2026-10-08 21:00:00', 'bridge,warning', ROGUE('192.168.1.1', '04:f4:1c:45:fd:96')]);
    await watchRouterLog(db, router(rows), NOW);
    const expected = [
      { day: '2026-10-07', kind: 'ip_duplicado', subject: 'BC:07:1D:5E:42:9E', count: 49 },
      { day: '2026-10-08', kind: 'laco_rede', subject: ROUTER_MAC, count: 2, firstAt: '2026-10-08 20:06:54', lastAt: '2026-10-08 21:00:00' }
    ];
    expect(findings()).toMatchObject(expected);
    // Outra passagem com linhas novas não volta a mexer no que já está certo.
    await watchRouterLog(db, router([...rows, ...log([2, '2026-10-08 21:01:00', 'netwatch,info', 'event up [ type: simple, host: 192.168.1.251 ]'])]), NOW);
    expect(findings()).toMatchObject(expected);
    expect(findings()).toHaveLength(2);
  });

  test('as linhas reais do cartão (RouterOS 7.24) viram achados', () => {
    const found = collectFindings(parseJournal([
      'Oct/07/2026 23:40:51 system,info log rule added by api:ispm-api@:: (*5 = /system logging add action=ispmdiario topics=info)',
      'Oct/07/2026 23:43:49 bridge,warning LAN1: received DHCP server message on untrusted port from source IP 192.168.0.1, MAC 30:16:9d:aa:53:8b',
      'Oct/07/2026 23:45:40 dhcp,info dhcp-SKYNET deassigned 192.168.2.230 for 3C:64:CF:7B:80:08 Archer_C20',
      'Oct/07/2026 23:45:41 dhcp,info dhcp-SKYNET assigned 192.168.2.230 for 3C:64:CF:7B:80:08 Archer_C20'
    ].join('\n')), { addresses: ['192.168.2.1'], macs: [] }, NOW);
    expect(found.map(({ kind, subject, firstAt }) => ({ kind, subject, firstAt }))).toEqual([
      { kind: 'dhcp_intruso', subject: '30:16:9D:AA:53:8B', firstAt: '2026-10-07 23:43:49' },
      { kind: 'dhcp_ciclo', subject: '3C:64:CF:7B:80:08', firstAt: '2026-10-07 23:45:40' }
    ]);
  });

  test('o diário em disco lê-se pela ordem do texto e ignora o que não é linha de registo', () => {
    expect(parseJournal(`Oct/07/2026 10:29:34 netwatch,info ${DOWN('192.168.1.251')}\r\nlixo\n\nOct/07/2026 10:30:00 system,error,critical login failure for user admin from 192.168.2.50 via winbox\n`)).toEqual([
      { id: '*0', time: '2026-10-07 10:29:34', topics: 'netwatch,info', message: DOWN('192.168.1.251') },
      { id: '*1', time: '2026-10-07 10:30:00', topics: 'system,error,critical', message: 'login failure for user admin from 192.168.2.50 via winbox' }
    ]);
  });

  test('o cursor do diário é o segundo da última linha e quantas desse segundo já se contaram', () => {
    const line = (time: string, message: string): RouterLogEntry => ({ id: '', time, topics: '', message });
    const entries = [line('10:00:00', 'a'), line('10:00:01', 'b'), line('10:00:01', 'c')];
    expect(freshJournalLines(entries, null)).toEqual({ fresh: entries, cursor: { time: '10:00:01', seen: 2 } });
    expect(freshJournalLines(entries, { time: '10:00:01', seen: 2 })).toEqual({ fresh: [], cursor: { time: '10:00:01', seen: 2 } });
    // Mais uma linha no mesmo segundo, depois de lido: só essa é nova.
    const more = freshJournalLines([...entries, line('10:00:01', 'd'), line('10:00:02', 'e')], { time: '10:00:01', seen: 2 });
    expect(more.fresh.map((row) => row.message)).toEqual(['d', 'e']);
    expect(more.cursor).toEqual({ time: '10:00:02', seen: 1 });
    expect(freshJournalLines([line('10:00:01', 'd')], { time: '10:00:01', seen: 0 }).cursor).toEqual({ time: '10:00:01', seen: 1 });
    // A rotação levou os ficheiros antigos: o que sobra depois do cursor conta na mesma.
    expect(freshJournalLines([line('10:00:05', 'f')], { time: '10:00:01', seen: 2 }).fresh).toHaveLength(1);
  });

  test('ligar o diário conta o que a memória tinha e passa a ler só o que o cartão ganhar', async () => {
    const memory = log([1, '2026-10-07 10:29:34', 'netwatch,info', DOWN('192.168.1.251')]);
    const files: Record<string, string> = { 'sd1/ispm-log.0.txt': `Oct/07/2026 10:20:00 netwatch,info ${DOWN('192.168.1.251')}\n` };
    const writes: string[] = [];
    const transport: RouterTransport = async ({ method, path: requested, body }) => {
      // O texto vem pelo /execute, como a cópia da configuração.
      if (requested === '/execute') return { ret: files[/get "([^"]+)" contents/.exec((body as { script: string }).script)![1]] };
      if (method !== 'GET') { writes.push(`${method} ${requested} ${JSON.stringify(body)}`); return {}; }
      if (requested.startsWith('/ip/address')) return [];
      if (requested.startsWith('/log')) return memory;
      if (requested.startsWith('/system/logging/action')) return writes.length ? [{ '.id': '*9', 'disk-file-name': 'sd1/ispm-log' }] : [];
      if (requested.startsWith('/system/logging')) return [{ topics: 'info', action: 'memory' }];
      if (requested.startsWith('/file?.proplist')) return Object.entries(files).map(([name, text]) => ({ name, size: String(text.length), 'last-modified': '2026-10-07 10:20:00' }));
      return [];
    };
    await installLogJournal(db, transport, 'sd1', NOW);
    expect(writes).toHaveLength(5); // a ação e as quatro regras
    expect(writes[0]).toContain('"disk-file-name":"sd1/ispm-log"');
    // A linha que já estava no cartão ficou atrás do cursor; a da memória contou.
    expect(findings()).toMatchObject([{ count: 1, firstAt: '2026-10-07 10:29:34' }]);

    files['sd1/ispm-log.0.txt'] += `Oct/07/2026 23:10:00 netwatch,info ${DOWN('192.168.1.251')}\n`;
    expect(await watchRouterLog(db, transport, NOW)).toEqual({ lines: 1, findings: 1 });
    expect(await watchRouterLog(db, transport, NOW)).toEqual({ lines: 0, findings: 0 });
    expect(findings()).toMatchObject([{ count: 2, lastAt: '2026-10-07 23:10:00' }]);
  });

  test('cada linha lida fica guardada uma vez, com a hora completa, e lê-se por dia', async () => {
    const rows = log(
      [1, '2026-10-06 23:59:00', 'netwatch,info', DOWN('192.168.1.110')],
      [2, '00:01:00', 'dhcp,info', 'dhcp-SKYNET assigned 192.168.2.230 for 3C:64:CF:7B:80:08 Archer_C20'],
      [3, '00:01:00', 'dhcp,info', 'dhcp-SKYNET assigned 192.168.2.230 for 3C:64:CF:7B:80:08 Archer_C20']
    );
    await watchRouterLog(db, router(rows), NOW);
    await watchRouterLog(db, router(rows), NOW);
    expect(listLogDays(db)).toEqual([{ day: '2026-10-07', lines: 2 }, { day: '2026-10-06', lines: 1 }]);
    expect(loadLogDay(db, '2026-10-06').map(({ time, topics, message }) => ({ time, topics, message }))).toEqual([
      { time: '2026-10-06 23:59:00', topics: 'netwatch,info', message: DOWN('192.168.1.110') }
    ]);
    // Duas linhas iguais no mesmo segundo são duas linhas; o id dá a ordem ao ecrã.
    expect(loadLogDay(db, '2026-10-07').map((row) => row.time)).toEqual(['2026-10-07 00:01:00', '2026-10-07 00:01:00']);
    expect(new Set(loadLogDay(db, '2026-10-07').map((row) => row.id)).size).toBe(2);
  });

  test('as linhas guardadas há mais de 90 dias saem na passagem seguinte', async () => {
    const insert = db.prepare("INSERT INTO router_log_lines (at, topics, message) VALUES (?, 'system,info', 'antiga')");
    insert.run('2026-07-08 23:59:59');
    insert.run('2026-07-09 00:00:00');
    await watchRouterLog(db, router(log([1, '2026-10-07 10:00:00', 'system,info', 'nova'])), NOW);
    expect(listLogDays(db)).toEqual([{ day: '2026-10-07', lines: 1 }, { day: '2026-07-09', lines: 1 }]);
  });

  const COUNTER = (name: string, body: string) =>
    `changed script settings by scheduler:${name}/script:${name}/action:388 (/system script set ${name}-data policy="" source="${body}`;

  test('a gravação de um contador guarda-se numa linha curta, mesmo partida em fragmentos', async () => {
    const rows = log(
      [1, '2026-10-07 05:59:50', 'system,info', COUNTER('ispm-client-usage', String.raw`# skn001;43;69;13;13;03:21:00\; \n")`)],
      [2, '2026-10-07 05:59:50', 'system,info', COUNTER('ispm-wan-usage', String.raw`# uptime;4d22:49:29\; \n# 2`)],
      [3, '2026-10-07 05:59:50', 'system,info', String.raw`0731;WAN1-STARLINK;197;163\; \n# 20736;WAN2-STARLINK;0;0\; \n")`],
      [4, '2026-10-07 06:00:10', 'netwatch,info', DOWN('192.168.1.110')]
    );
    expect(await watchRouterLog(db, router(rows), NOW)).toMatchObject({ lines: 4, findings: 1 });
    expect(loadLogDay(db, '2026-10-07').map((row) => row.message)).toEqual([
      'changed script settings by scheduler:ispm-client-usage/script:ispm-client-usage/action:388 (/system script set ispm-client-usage-data source=…)',
      'changed script settings by scheduler:ispm-wan-usage/script:ispm-wan-usage/action:388 (/system script set ispm-wan-usage-data source=…)',
      DOWN('192.168.1.110')
    ]);
  });

  test('as gravações já guardadas encurtam-se uma só vez', async () => {
    const insert = db.prepare("INSERT INTO router_log_lines (at, topics, message) VALUES ('2026-10-06 05:59:50', ?, ?)");
    insert.run('system,info', COUNTER('ispm-wan-usage', String.raw`# uptime;4d\; \n# 2`));
    insert.run('system,info', String.raw`0731;WAN1-STARLINK;197;163\; \n")`);
    insert.run('dhcp,info', 'fica');
    await watchRouterLog(db, router([]), NOW);
    expect(loadLogDay(db, '2026-10-06').map((row) => row.message)).toEqual([
      'changed script settings by scheduler:ispm-wan-usage/script:ispm-wan-usage/action:388 (/system script set ispm-wan-usage-data source=…)',
      'fica'
    ]);
    // Daqui para a frente as linhas já entram curtas: a limpeza não volta a correr a tabela.
    insert.run('system,info', String.raw`0731;WAN1-STARLINK;197;163\; \n")`);
    await watchRouterLog(db, router([]), NOW);
    expect(loadLogDay(db, '2026-10-06')).toHaveLength(3);
    expect(compactStoredLines(db)).toBe(1);
  });

  /** Um router com o diário em `sd1`: só o cartão tem linhas. */
  function card(files: Record<string, string>, reads: string[] = []): RouterTransport {
    return async ({ path: requested, body }) => {
      if (requested === '/execute') {
        const name = /get "([^"]+)" contents/.exec((body as { script: string }).script)![1];
        reads.push(name);
        return { ret: files[name] };
      }
      if (requested.startsWith('/interface')) return [{ name: 'bridge-LAN', 'mac-address': ROUTER_MAC }];
      if (requested.startsWith('/file?.proplist')) return Object.entries(files).map(([name, text]) => ({ name, size: String(text.length), 'last-modified': '2026-10-08 20:00:00' }));
      return [];
    };
  }

  test('a primeira passagem traz do cartão o que já tinha sido contado, sem o contar outra vez', async () => {
    const setting = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)');
    setting.run('routerLogJournal', 'sd1');
    setting.run('routerLogJournalCursor', JSON.stringify({ time: '2026-10-08 20:07:07', seen: 1 }));
    const files = {
      'sd1/ispm-log.0.txt': [
        `Oct/08/2026 08:31:04 netwatch,info ${DOWN('192.168.1.110')}`,
        `Oct/08/2026 20:07:07 netwatch,info ${DOWN('192.168.1.110')}`,
        `Oct/08/2026 20:07:07 netwatch,info ${DOWN('192.168.1.122')}`,
        ''
      ].join('\n')
    };
    expect(await watchRouterLog(db, card(files), NOW)).toEqual({ lines: 1, findings: 1, recovered: 2 });
    // Só a linha depois do cursor é um achado novo; as duas de trás ficam guardadas e mais nada.
    expect(findings()).toMatchObject([{ subject: '192.168.1.122', count: 1 }]);
    expect(loadLogDay(db, '2026-10-08').map((row) => row.time)).toEqual(['2026-10-08 08:31:04', '2026-10-08 20:07:07', '2026-10-08 20:07:07']);

    // Feito uma vez: a passagem seguinte não volta a ler o cartão todo nem repete linhas.
    expect(await watchRouterLog(db, card(files), NOW)).toEqual({ lines: 0, findings: 0 });
    expect(listLogDays(db)).toEqual([{ day: '2026-10-08', lines: 3 }]);
  });

  test('se o cartão não se deixar ler todo, a vigia segue com o que é novo e não insiste', async () => {
    const setting = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)');
    setting.run('routerLogJournal', 'sd1');
    setting.run('routerLogJournalCursor', JSON.stringify({ time: '2026-10-08 20:00:00', seen: 1 }));
    const fresh = `Oct/08/2026 20:07:07 netwatch,info ${DOWN('192.168.1.110')}\n`;
    const reads: string[] = [];
    const transport = card({ 'sd1/ispm-log.0.txt': 'x'.repeat(500), 'sd1/ispm-log.1.txt': fresh }, reads);
    // O ficheiro antigo vem cortado: a listagem diz 500 bytes e o router devolve menos.
    const broken: RouterTransport = async (request) => {
      const result = await transport(request);
      return request.path === '/execute' && reads.at(-1) === 'sd1/ispm-log.0.txt' ? { ret: 'x' } : result;
    };
    const stale: RouterTransport = async (request) => request.path.startsWith('/file?.proplist')
      ? [{ name: 'sd1/ispm-log.0.txt', size: '500', 'last-modified': '2026-10-08 10:00:00' }, { name: 'sd1/ispm-log.1.txt', size: String(fresh.length), 'last-modified': '2026-10-08 20:07:07' }]
      : broken(request);
    expect(await watchRouterLog(db, stale, NOW)).toEqual({ lines: 1, findings: 1, recovered: 0 });
    reads.length = 0;
    await watchRouterLog(db, stale, NOW);
    expect(reads).toEqual(['sd1/ispm-log.1.txt']);
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
