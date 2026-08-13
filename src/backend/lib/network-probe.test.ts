/**
 * A sonda de rede: quando é que um equipamento se declara em baixo, o que fica
 * registado, e como se conta disponibilidade num desktop que fecha à noite.
 *
 * Nenhum teste toca na rede — a sonda é injetada.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { computeUptime, decideProbeTransition, parsePingOutput } from './network-probe';
import type { PingResult, Pinger } from './network-probe';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let probe: typeof import('./network-probe');

const UP: PingResult = { ok: true, rttMs: 4 };
const DOWN: PingResult = { ok: false, rttMs: null };

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-network-probe-test-'));
  process.env.ISPM_DATA_DIR = dataDir;

  const database = await import('../db/database');
  database.getDatabase(); // corre as migrações
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  probe = await import('./network-probe');
});

beforeEach(() => {
  // Filhos primeiro: as atribuições dependem de serviços, clientes e catálogo.
  db.prepare('DELETE FROM network_probe_events').run();
  db.prepare('DELETE FROM network_probe_state').run();
  db.prepare('DELETE FROM service_device_assignments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM backbone_devices').run();
  db.prepare('DELETE FROM equipment_catalog').run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

function seedBackbone(name: string, ip: string | null, status = 'active'): number {
  const catalogId = db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, is_serialized, purchase_price_cve, stock_total, active)
    VALUES ('equipamento', 'antena', 'TP-Link', ?, 1, 10000, 10, 1)
  `).run(`Modelo ${name}`).lastInsertRowid as number;
  return db.prepare(`
    INSERT INTO backbone_devices (catalog_id, name, ip_address, status) VALUES (?, ?, ?, ?)
  `).run(catalogId, name, ip, status).lastInsertRowid as number;
}

/** Um CPE de cliente com IP fixo, para o caminho `includeClients`. */
function seedClientDevice(clientName: string, ip: string, serviceStatus = 'active'): number {
  const catalogId = db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, is_serialized, purchase_price_cve, stock_total, active)
    VALUES ('equipamento', 'cpe', 'TP-Link', ?, 1, 3000, 5, 1)
  `).run(`CPE ${clientName}`).lastInsertRowid as number;
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')
  `).run(`CLI-${ip}`, clientName).lastInsertRowid as number;
  const serviceId = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 2500, 10, ?)
  `).run(clientId, serviceStatus).lastInsertRowid as number;
  return db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, ip_address, start_date)
    VALUES (?, ?, ?, '2026-01-01')
  `).run(serviceId, catalogId, ip).lastInsertRowid as number;
}

/** Sonda que responde conforme o IP, para separar vivos de mortos. */
function pingerFor(deadIps: string[]): Pinger {
  return async (ip) => (deadIps.includes(ip) ? DOWN : UP);
}

describe('parsePingOutput', () => {
  test('uma resposta com TTL é vida', () => {
    const result = parsePingOutput('Resposta de 192.168.1.1: bytes=32 tempo=3ms TTL=64', 0);
    expect(result).toEqual({ ok: true, rttMs: 3 });
  });

  test('o Windows devolve 0 em "host inacessível" — sem TTL não há vida', () => {
    expect(parsePingOutput('Host de destino inacessivel.', 0).ok).toBe(false);
    expect(parsePingOutput('Esgotou-se o tempo limite do pedido.', 0).ok).toBe(false);
  });

  test('TTL com código de saída diferente de zero não conta', () => {
    expect(parsePingOutput('64 bytes from 10.0.0.1: ttl=64 time=1.2 ms', 1).ok).toBe(false);
  });

  test('lê o tempo do formato Unix, com decimais', () => {
    expect(parsePingOutput('64 bytes from 10.0.0.1: ttl=64 time=1.7 ms', 0)).toEqual({ ok: true, rttMs: 2 });
  });
});

describe('decideProbeTransition', () => {
  test('uma falha isolada não derruba nada', () => {
    const result = decideProbeTransition({ state: 'up', consecutiveFails: 0 }, DOWN, 3);
    expect(result).toEqual({ state: 'up', changed: false, consecutiveFails: 1 });
  });

  test('cai ao atingir o limiar de falhas seguidas', () => {
    const second = decideProbeTransition({ state: 'up', consecutiveFails: 1 }, DOWN, 3);
    expect(second.state).toBe('up');
    const third = decideProbeTransition({ state: 'up', consecutiveFails: 2 }, DOWN, 3);
    expect(third).toEqual({ state: 'down', changed: true, consecutiveFails: 3 });
  });

  test('já em baixo, continuar em baixo não é transição nova', () => {
    const result = decideProbeTransition({ state: 'down', consecutiveFails: 9 }, DOWN, 3);
    expect(result).toEqual({ state: 'down', changed: false, consecutiveFails: 10 });
  });

  test('volta a subir à primeira resposta', () => {
    const result = decideProbeTransition({ state: 'down', consecutiveFails: 7 }, UP, 3);
    expect(result).toEqual({ state: 'up', changed: true, consecutiveFails: 0 });
  });

  test('sem estado anterior, uma resposta é subida e uma falha ainda não é queda', () => {
    expect(decideProbeTransition(null, UP, 3).state).toBe('up');
    expect(decideProbeTransition(null, DOWN, 3)).toEqual({ state: 'up', changed: false, consecutiveFails: 1 });
  });
});

describe('runNetworkProbe', () => {
  test('só sonda equipamentos ativos com IP', async () => {
    seedBackbone('Com IP', '10.0.0.1');
    seedBackbone('Sem IP', null);
    seedBackbone('Retirado', '10.0.0.9', 'retired');

    const summary = await probe.runNetworkProbe(db, { includeClients: false, failThreshold: 3, ping: pingerFor([]) });

    expect(summary.checked).toBe(1);
    expect(summary.up).toBe(1);
    const rows = probe.loadProbeStates(db);
    expect(rows.map((row) => row.ipAddress)).toEqual(['10.0.0.1']);
  });

  // Este caminho não estava coberto e passou uma coluna inexistente (`c.name`
  // em vez de `c.full_name`) para produção: o job morria e o painel Operação
  // recusava o pedido inteiro. Cobre-se aqui com clientes a sério.
  test('com clientes ligados, sonda também as CPEs e trá-las com o nome do cliente', async () => {
    seedBackbone('Torre', '10.0.0.1');
    seedClientDevice('Ana Silva', '192.168.1.50');
    seedClientDevice('Cancelado', '192.168.1.51', 'cancelled');

    const summary = await probe.runNetworkProbe(db, { includeClients: true, failThreshold: 3, ping: pingerFor([]) });

    // O serviço cancelado não entra: já não é rede que se monitorize.
    expect(summary.checked).toBe(2);
    const status = probe.loadNetworkStatus(db);
    const cpe = status.targets.find((target) => target.kind === 'assignment');
    expect(cpe).toMatchObject({ name: 'Ana Silva', ipAddress: '192.168.1.50', state: 'up' });
  });

  test('sem equipamentos com IP, o job salta em vez de fingir que correu', async () => {
    seedBackbone('Sem IP', null);
    const summary = await probe.runNetworkProbe(db, { includeClients: false, failThreshold: 3, ping: pingerFor([]) });
    expect(summary.skipped).toBe(true);
    expect(summary.checked).toBe(0);
  });

  test('a queda só é registada ao fim das falhas seguidas, e uma só vez', async () => {
    seedBackbone('Torre', '10.0.0.5');
    const options = { includeClients: false, failThreshold: 2, ping: pingerFor(['10.0.0.5']) };

    const first = await probe.runNetworkProbe(db, options);
    expect(first.down).toBe(0);
    expect(first.transitions).toBe(0);

    const second = await probe.runNetworkProbe(db, options);
    expect(second.down).toBe(1);
    expect(second.transitions).toBe(1);

    const third = await probe.runNetworkProbe(db, options);
    expect(third.transitions).toBe(0);

    const events = db.prepare('SELECT from_state, to_state FROM network_probe_events').all();
    expect(events).toEqual([{ from_state: 'up', to_state: 'down' }]);
  });

  test('a recuperação fecha o evento e devolve o equipamento a vivo', async () => {
    seedBackbone('Torre', '10.0.0.5');
    await probe.runNetworkProbe(db, { includeClients: false, failThreshold: 1, ping: pingerFor(['10.0.0.5']) });
    await probe.runNetworkProbe(db, { includeClients: false, failThreshold: 1, ping: pingerFor([]) });

    const state = probe.loadProbeStates(db)[0];
    expect(state.state).toBe('up');
    expect(state.consecutiveFails).toBe(0);
    expect(state.lastOkAt).not.toBeNull();

    const events = db.prepare('SELECT to_state FROM network_probe_events ORDER BY id').all();
    expect(events).toEqual([{ to_state: 'down' }, { to_state: 'up' }]);
  });

  test('o estado lido traz nome, IP e disponibilidade', async () => {
    seedBackbone('Monte Vermelho', '10.0.0.7');
    await probe.runNetworkProbe(db, { includeClients: false, failThreshold: 1, ping: pingerFor([]) });

    const status = probe.loadNetworkStatus(db);
    expect(status.targets).toHaveLength(1);
    expect(status.targets[0]).toMatchObject({ kind: 'backbone', name: 'Monte Vermelho', ipAddress: '10.0.0.7', state: 'up' });
    expect(status.downCount).toBe(0);
  });
});

describe('computeUptime', () => {
  const base = { intervalSeconds: 60, windowStart: '2026-08-01 00:00:00', now: '2026-08-01 10:00:00' };

  test('sem eventos, o estado atual vale a janela toda', () => {
    const result = computeUptime({ ...base, events: [], currentState: 'up', lastCheckedAt: '2026-08-01 10:00:00' });
    expect(result.uptime).toBe(1);
    expect(result.observedSeconds).toBe(36_000);
  });

  test('uma queda de duas horas conta como indisponibilidade, não como buraco', () => {
    const result = computeUptime({
      ...base,
      events: [
        { fromState: 'up', toState: 'down', at: '2026-08-01 02:00:00' },
        { fromState: 'down', toState: 'up', at: '2026-08-01 04:00:00' }
      ],
      currentState: 'up',
      lastCheckedAt: '2026-08-01 10:00:00'
    });
    expect(result.downSeconds).toBe(7_200);
    expect(result.uptime).toBeCloseTo(1 - 7_200 / 36_000, 6);
  });

  test('aplicação fechada não conta para nenhum dos lados', () => {
    // Retoma às 09:00 depois de a última leitura ter sido às 01:00: as oito
    // horas por observar ficam de fora da conta, em vez de contarem como de pé.
    const result = computeUptime({
      ...base,
      events: [{ fromState: 'up', toState: 'up', at: '2026-08-01 09:00:00', gapBefore: true }],
      currentState: 'up',
      lastCheckedAt: '2026-08-01 10:00:00'
    });
    expect(result.observedSeconds).toBe(3_600);
    expect(result.uptime).toBe(1);
  });

  test('a cauda pára na última leitura quando a sonda deixou de correr', () => {
    const result = computeUptime({
      ...base,
      events: [],
      currentState: 'up',
      lastCheckedAt: '2026-08-01 01:00:00'
    });
    expect(result.observedSeconds).toBe(3_600);
  });

  test('sem tempo observado a disponibilidade é 1, não uma divisão por zero', () => {
    const result = computeUptime({
      ...base,
      events: [],
      currentState: 'up',
      windowStart: '2026-08-01 10:00:00',
      lastCheckedAt: '2026-08-01 10:00:00'
    });
    expect(result.uptime).toBe(1);
    expect(result.observedSeconds).toBe(0);
  });
});
