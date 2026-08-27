import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

const TABLES_TO_CLEAR = [
  'network_probe_events',
  'network_probe_state',
  'network_discovery_hosts',
  'backbone_devices',
  'network_discovery_dismissals',
  'equipment_catalog',
  'app_settings'
];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-network-routes-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';

  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  for (const table of TABLES_TO_CLEAR) db.prepare(`DELETE FROM ${table}`).run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});

function seedBackbone(name: string, ip: string): number {
  const catalogId = Number(db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, stock_total)
    VALUES ('equipamento', 'antena', 'TP-Link', ?, 3)
  `).run(`Modelo ${name}`).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO backbone_devices (catalog_id, name, ip_address) VALUES (?, ?, ?)
  `).run(catalogId, name, ip).lastInsertRowid);
}

function seedState(targetId: number, ip: string, state: 'up' | 'down') {
  db.prepare(`
    INSERT INTO network_probe_state (target_kind, target_id, ip_address, state, consecutive_fails, last_ok_at, last_change_at, checked_at)
    VALUES ('backbone', ?, ?, ?, 0, datetime('now'), datetime('now','-1 hour'), datetime('now'))
  `).run(targetId, ip, state);
}

describe('GET /api/network/status', () => {
  test('devolve o estado por equipamento e conta os que estão em baixo', async () => {
    const up = seedBackbone('Torre Norte', '10.0.0.1');
    const down = seedBackbone('Torre Sul', '10.0.0.2');
    seedState(up, '10.0.0.1', 'up');
    seedState(down, '10.0.0.2', 'down');

    const response = await app.inject({ method: 'GET', url: '/api/network/status' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.downCount).toBe(1);
    expect(body.enabled).toBe(false);
    expect(body.targets.map((t: { name: string }) => t.name).sort()).toEqual(['Torre Norte', 'Torre Sul']);
  });

  test('um equipamento com IP que a sonda ainda não leu é contado à parte', async () => {
    seedBackbone('Acabado de registar', '10.0.0.3');
    const body = (await app.inject({ method: 'GET', url: '/api/network/status' })).json();
    expect(body.targets).toHaveLength(0);
    expect(body.neverProbed).toBe(1);
  });

  test('recusa uma janela fora do intervalo aceite', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/network/status?days=400' });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/network/targets/:kind/:id/events', () => {
  test('devolve as transições do equipamento pedido', async () => {
    const id = seedBackbone('Torre Norte', '10.0.0.1');
    db.prepare(`
      INSERT INTO network_probe_events (target_kind, target_id, ip_address, from_state, to_state, at, duration_seconds)
      VALUES ('backbone', ?, '10.0.0.1', 'up', 'down', datetime('now','-2 hours'), 600)
    `).run(id);
    db.prepare(`
      INSERT INTO network_probe_events (target_kind, target_id, ip_address, from_state, to_state, at, duration_seconds)
      VALUES ('backbone', 999, '10.0.0.9', 'up', 'down', datetime('now','-2 hours'), 600)
    `).run();

    const body = (await app.inject({ method: 'GET', url: `/api/network/targets/backbone/${id}/events` })).json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ toState: 'down', durationSeconds: 600 });
  });

  test('recusa um tipo de alvo desconhecido', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/network/targets/router/1/events' });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/network/probe', () => {
  test('sem equipamentos com IP, responde que saltou em vez de falhar', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/network/probe' });
    expect(response.statusCode).toBe(200);
    expect(response.json().skipped).toBe(true);
  });
});

// TEST-NET-3 (RFC 5737): endereços reservados para documentação. Nunca vão
// aparecer na tabela ARP real da máquina que corre os testes, o que deixa as
// asserções sobre o cruzamento determinísticas.
const RANGE = ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4'];

async function discoveryContext(body: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/network/discovery',
    payload: { rangeIps: RANGE, alive: [], includeRouter: false, ...body }
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

type ReportRow = {
  ip: string;
  category: string;
  alive: boolean;
  rttMs: number | null;
  registeredAs: Array<{ name: string }>;
};

function rowFor(body: { rows: ReportRow[] }, ip: string): ReportRow {
  const row = body.rows.find((item) => item.ip === ip);
  if (!row) throw new Error(`Sem linha para ${ip} no relatório`);
  return row;
}

describe('POST /api/network/discovery/sweep', () => {
  test('recusa mais endereços do que cabem num lote', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/network/discovery/sweep',
      payload: { ips: Array.from({ length: 65 }, (_, i) => `10.0.0.${i + 1}`), range: '10.0.0.0/24', batchIndex: 0 }
    });
    expect(response.statusCode).toBe(400);
  });

  test('recusa um endereço que não é IPv4 — o valor vai para a linha de comando', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/network/discovery/sweep',
      payload: { ips: ['10.0.0.1', '; rm -rf /'], range: '10.0.0.0/24', batchIndex: 0 }
    });
    expect(response.statusCode).toBe(400);
  });

  test('recusa corpo sem intervalo', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/network/discovery/sweep',
      payload: { ips: ['10.0.0.1'], batchIndex: 0 }
    });
    expect(response.statusCode).toBe(400);
  });

  test('devolve uma linha por endereço pedido', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/network/discovery/sweep',
      payload: { ips: ['203.0.113.1', '203.0.113.2'], range: '203.0.113.1-2', batchIndex: 0 }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results.map((r: { ip: string }) => r.ip)).toEqual(['203.0.113.1', '203.0.113.2']);
  });
});

describe('POST /api/network/discovery/identify', () => {
  test('recusa mais endereços do que cabem num lote', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/network/discovery/identify',
      payload: { ips: Array.from({ length: 65 }, (_, i) => `10.0.0.${i + 1}`), batchIndex: 0 }
    });
    expect(response.statusCode).toBe(400);
  });

  test('recusa um endereço que não é IPv4', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/network/discovery/identify',
      payload: { ips: ['10.0.0.1', 'nao-e-um-ip'], batchIndex: 0 }
    });
    expect(response.statusCode).toBe(400);
  });

  test('devolve uma linha por endereço, sem modelo para quem não responde', async () => {
    // 203.0.113.0/24 é TEST-NET-3: não encaminha para lado nenhum, portanto o
    // teste exercita o caminho todo sem tocar em equipamento real.
    const response = await app.inject({
      method: 'POST',
      url: '/api/network/discovery/identify',
      payload: { ips: ['203.0.113.9'], batchIndex: 0 }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([{ ip: '203.0.113.9', model: null, modelSource: null }]);
  });
});

describe('POST /api/network/discovery', () => {
  test('um equipamento registado que não responde fica ausente', async () => {
    seedBackbone('Torre Norte', '203.0.113.2');
    const body = await discoveryContext();
    expect(rowFor(body, '203.0.113.2')).toMatchObject({ category: 'ausente', alive: false });
    expect(body.counts.ausente).toBe(1);
  });

  test('um endereço vivo sem registo é desconhecido', async () => {
    const body = await discoveryContext({ alive: [{ ip: '203.0.113.3', rttMs: 5 }] });
    expect(rowFor(body, '203.0.113.3')).toMatchObject({ category: 'desconhecido', alive: true, rttMs: 5 });
  });

  test('um endereço vivo com registo é registado e traz o nome', async () => {
    seedBackbone('Torre Sul', '203.0.113.1');
    const body = await discoveryContext({ alive: [{ ip: '203.0.113.1', rttMs: 2 }] });
    expect(rowFor(body, '203.0.113.1')).toMatchObject({ category: 'registado' });
    expect(rowFor(body, '203.0.113.1').registeredAs[0].name).toBe('Torre Sul');
  });

  test('o mesmo IP em dois equipamentos é assinalado como duplicado', async () => {
    seedBackbone('Torre A', '203.0.113.4');
    seedBackbone('Torre B', '203.0.113.4');
    const body = await discoveryContext();
    expect(rowFor(body, '203.0.113.4')).toMatchObject({ category: 'duplicado' });
    expect(body.counts.duplicado).toBe(1);
  });

  test('sugere o primeiro endereço livre do intervalo', async () => {
    seedBackbone('Torre Norte', '203.0.113.1');
    const body = await discoveryContext({ alive: [{ ip: '203.0.113.2', rttMs: 1 }] });
    expect(body.nextFreeIp).toBe('203.0.113.3');
    expect(body.freeIps).toEqual(['203.0.113.3', '203.0.113.4']);
  });

  test('sem MikroTik configurado responde na mesma, sem enriquecimento', async () => {
    const body = await discoveryContext({ includeRouter: true });
    expect(body.routerConfigured).toBe(false);
    expect(body.routerEnriched).toBe(false);
  });

  test('guarda o histórico: a segunda passagem incrementa sem perder o first_seen_at', async () => {
    await discoveryContext({ alive: [{ ip: '203.0.113.3', rttMs: 5 }] });
    const first = db.prepare(
      `SELECT first_seen_at AS firstSeenAt, times_seen AS timesSeen FROM network_discovery_hosts WHERE ip_address = ?`
    ).get('203.0.113.3') as { firstSeenAt: string; timesSeen: number };

    await discoveryContext({ alive: [{ ip: '203.0.113.3', rttMs: 6 }] });
    const second = db.prepare(
      `SELECT first_seen_at AS firstSeenAt, times_seen AS timesSeen FROM network_discovery_hosts WHERE ip_address = ?`
    ).get('203.0.113.3') as { firstSeenAt: string; timesSeen: number };

    expect(second.timesSeen).toBe(first.timesSeen + 1);
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
  });

  test('recusa um intervalo acima do teto', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/network/discovery',
      payload: { rangeIps: Array.from({ length: 1025 }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`) }
    });
    expect(response.statusCode).toBe(400);
  });

  test('sem intervalo varrido responde na mesma, sem endereços livres', async () => {
    const body = await discoveryContext({ rangeIps: [] });
    expect(body.freeIps).toEqual([]);
    expect(body.nextFreeIp).toBeNull();
  });
});

describe('GET /api/network/discovery/proposals', () => {
  function seenHost(ip: string, mac: string | null, over: { model?: string; lastSeenAt?: string } = {}) {
    db.prepare(`
      INSERT INTO network_discovery_hosts (ip_address, mac_address, source, model, model_source, last_seen_at)
      VALUES (?, ?, 'ping', ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
    `).run(ip, mac, over.model ?? null, over.model ? 'http' : null, over.lastSeenAt ?? null);
  }

  async function proposals() {
    const response = await app.inject({ method: 'GET', url: '/api/network/discovery/proposals' });
    expect(response.statusCode).toBe(200);
    return response.json() as { proposals: Array<Record<string, unknown>>; orphans: unknown[] };
  }

  test('backbone com endereço e sem MAC ganha proposta de MAC', async () => {
    seedBackbone('Torre Norte', '203.0.113.2');
    seenHost('203.0.113.2', '50:C7:BF:AA:BB:CC');

    const body = await proposals();
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({
      kind: 'mac_em_falta',
      targetKind: 'backbone',
      proposed: '50:C7:BF:AA:BB:CC'
    });
  });

  test('a rota não escreve nada — as propostas são só uma leitura', async () => {
    const id = seedBackbone('Torre Norte', '203.0.113.2');
    seenHost('203.0.113.2', '50:C7:BF:AA:BB:CC');

    await proposals();
    const row = db.prepare('SELECT mac_address AS mac FROM backbone_devices WHERE id = ?').get(id) as { mac: string | null };
    expect(row.mac).toBeNull();
  });

  test('sem diferenças a lista vem vazia', async () => {
    seedBackbone('Torre Norte', '203.0.113.2');
    expect((await proposals()).proposals).toEqual([]);
  });

  test('dispensar tira a proposta e não volta no pedido seguinte', async () => {
    const id = seedBackbone('Torre Norte', '203.0.113.2');
    seenHost('203.0.113.2', '50:C7:BF:AA:BB:CC');
    expect((await proposals()).proposals).toHaveLength(1);

    const dismiss = await app.inject({
      method: 'POST',
      url: '/api/network/discovery/dismiss',
      payload: { kind: 'mac_em_falta', targetKind: 'backbone', targetId: id }
    });
    expect(dismiss.statusCode).toBe(200);
    expect((await proposals()).proposals).toEqual([]);
  });

  test('dispensar duas vezes não rebenta nem duplica', async () => {
    const id = seedBackbone('Torre Norte', '203.0.113.2');
    const payload = { kind: 'mac_em_falta', targetKind: 'backbone', targetId: id };
    await app.inject({ method: 'POST', url: '/api/network/discovery/dismiss', payload });
    const again = await app.inject({ method: 'POST', url: '/api/network/discovery/dismiss', payload });
    expect(again.statusCode).toBe(200);
    const count = db.prepare('SELECT COUNT(*) AS n FROM network_discovery_dismissals').get() as { n: number };
    expect(count.n).toBe(1);
  });

  test('recusa uma proposta que não existe', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/network/discovery/dismiss',
      payload: { kind: 'inventada', targetKind: 'backbone', targetId: 1 }
    });
    expect(response.statusCode).toBe(400);
  });
});
