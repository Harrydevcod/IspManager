import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  bytesToGb, cycleFor, cycleStartDay, fupLimitedServices, inLimitWindow, inPeakWindow, loadFupUsage, loadOperatorPool, nextTransitions, previewFupImpact,
  runFupEngine, syncFupQueues, usagePercent, type FupEngineDeps
} from './fup';
import { collectClientUsage } from './client-usage';
import { bytesPerGb, fupActionText, invalidateFupSettingsCache, readFupSettings, saveFupSettings } from './fup-settings';
import type { RouterTransport } from './routeros';

const GB = 1e9;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let serviceId: number;

// 20:00 em Cabo Verde (UTC−1) = 21:00 UTC; 12:00 em CV = 13:00 UTC.
const peak = (day: string) => new Date(`${day}T21:00:00Z`);
const offPeak = (day: string) => new Date(`${day}T13:00:00Z`);

function deps() {
  return { enqueueNotice: vi.fn(), requestSync: vi.fn() } satisfies FupEngineDeps;
}

function addUsage(day: string, downGb: number, upGb = 0) {
  db.prepare(`INSERT INTO client_traffic_daily (day, service_id, rx_bytes, tx_bytes) VALUES (?, ?, ?, ?)
    ON CONFLICT(day, service_id) DO UPDATE SET rx_bytes = rx_bytes + excluded.rx_bytes, tx_bytes = tx_bytes + excluded.tx_bytes`)
    .run(day, serviceId, Math.round(upGb * GB), Math.round(downGb * GB));
}

const kinds = () => (db.prepare('SELECT period, kind FROM fup_events WHERE service_id = ? ORDER BY id').all(serviceId) as Array<{ period: string; kind: string }>)
  .map((e) => `${e.period}:${e.kind}`);

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-fup-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  for (const table of ['fup_events', 'client_traffic_daily', 'client_usage_state', 'services', 'clients', 'internet_plans', 'fup_settings']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  invalidateFupSettingsCache(db);
  db.prepare("INSERT INTO internet_plans (name, download_mbps, upload_mbps, fup_reference_gb) VALUES ('Standard', 10, 2, 100)").run();
  db.prepare("INSERT INTO clients (client_code, full_name, phone) VALUES ('C001', 'Ana', '9911111')").run();
  serviceId = Number(db.prepare(`INSERT INTO services (client_id, plan_id, pppoe_username, status, activation_date)
    VALUES ((SELECT id FROM clients), (SELECT id FROM internet_plans), 'ana', 'active', '2026-03-10')`).run().lastInsertRowid);
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

describe('cálculos', () => {
  test('GB decimais (10⁹) e percentagem da referência: 160,1 GB passam os 150', () => {
    expect(bytesToGb(GB * 1.5)).toBe(1.5);
    expect(usagePercent(80 * GB, 100)).toBe(80);
    expect(usagePercent(150 * GB, 100)).toBe(150);
    expect(usagePercent(10 * GB, 0)).toBe(0);
    expect(Math.round(usagePercent(160.1e9, 150))).toBe(107);
    // Com a unidade binária das Definições, os mesmos bytes ficam nos 99 %.
    expect(bytesPerGb({ unidade_gb: 'BINARIO' })).toBe(1024 ** 3);
    expect(bytesPerGb({ unidade_gb: 'DECIMAL' })).toBe(1e9);
    expect(Math.round(usagePercent(160.1e9, 150, bytesPerGb({ unidade_gb: 'BINARIO' })))).toBe(99);
  });

  test('ciclo a partir do dia da ativação, do dia definido, e limitado a 28', () => {
    expect(cycleStartDay(null, '2026-03-10')).toBe(10);
    expect(cycleStartDay(5, '2026-03-10')).toBe(5);
    expect(cycleStartDay(null, '2026-01-31')).toBe(28);
    expect(cycleStartDay(null, null)).toBe(1);
    expect(cycleFor('2026-11-06', 10)).toEqual({ start: '2026-10-10', end: '2026-11-09', period: '2026-10' });
    expect(cycleFor('2026-11-10', 10)).toEqual({ start: '2026-11-10', end: '2026-12-09', period: '2026-11' });
    expect(cycleFor('2027-01-05', 28)).toEqual({ start: '2026-12-28', end: '2027-01-27', period: '2026-12' });
    expect(cycleFor('2026-02-28', 1)).toEqual({ start: '2026-02-01', end: '2026-02-28', period: '2026-02' });
  });

  test('janela de pico no fuso: [início, fim)', () => {
    const settings = { janela_pico_inicio: '18:00', janela_pico_fim: '23:00', fuso_horario: 'Atlantic/Cape_Verde' };
    // CV = UTC−1: 17:59 CV = 18:59 UTC.
    expect(inPeakWindow(new Date('2026-11-06T18:59:00Z'), settings)).toBe(false);
    expect(inPeakWindow(new Date('2026-11-06T19:00:00Z'), settings)).toBe(true);
    expect(inPeakWindow(new Date('2026-11-06T23:59:00Z'), settings)).toBe(true);
    expect(inPeakWindow(new Date('2026-11-07T00:00:00Z'), settings)).toBe(false);
    expect(inPeakWindow(new Date('2026-11-06T23:30:00Z'), { ...settings, fuso_horario: 'UTC' })).toBe(false);
    const midnight = { ...settings, janela_pico_fim: '00:00' };
    expect(inPeakWindow(new Date('2026-11-07T00:59:00Z'), midnight)).toBe(true);
    expect(inPeakWindow(new Date('2026-11-07T01:00:00Z'), midnight)).toBe(false);
  });

  test('transições: só sobem, e o salto direto leva aviso e limitação', () => {
    const settings = { limiar_aviso_percent: 80, limiar_limitacao_percent: 100 };
    expect(nextTransitions('NORMAL', 79, settings)).toEqual([]);
    expect(nextTransitions('NORMAL', 80, settings)).toEqual(['AVISO']);
    expect(nextTransitions('AVISO', 99, settings)).toEqual([]);
    expect(nextTransitions('AVISO', 100, settings)).toEqual(['LIMITADO']);
    expect(nextTransitions('NORMAL', 130, settings)).toEqual(['AVISO', 'LIMITADO']);
    expect(nextTransitions('LIMITADO', 300, settings)).toEqual([]);
  });
});

describe('recolha', () => {
  test('contador PPPoE que reinicia soma o valor atual, não uma diferença negativa', async () => {
    const read = (text: string): RouterTransport => async () => [{ source: text }];
    await collectClientUsage(db, read('ana;1000;5000;0;0;1h'), '2026-11-06');
    await collectClientUsage(db, read('ana;1500;9000;0;0;2h'), '2026-11-06');
    // Sessão caiu: contadores voltam a valores baixos.
    await collectClientUsage(db, read('ana;200;300;0;0;1m'), '2026-11-06');
    const row = db.prepare('SELECT rx_bytes AS rx, tx_bytes AS tx FROM client_traffic_daily WHERE service_id = ?').get(serviceId);
    expect(row).toEqual({ rx: 500 + 200, tx: 4000 + 300 });
  });
});

describe('motor', () => {
  test('normal → aviso → limitado → restaurado, com um aviso só', () => {
    const d = deps();
    addUsage('2026-10-12', 50);
    runFupEngine(db, peak('2026-10-20'), d);
    expect(kinds()).toEqual([]);

    addUsage('2026-10-13', 35);
    runFupEngine(db, peak('2026-10-20'), d);
    runFupEngine(db, peak('2026-10-21'), d);
    expect(kinds()).toEqual(['2026-10:AVISO']);
    expect(d.enqueueNotice).toHaveBeenCalledTimes(1);
    expect(d.enqueueNotice.mock.calls[0][0]).toMatchObject({ channel: 'WHATSAPP', phone: '9911111', serviceId });
    expect(d.enqueueNotice.mock.calls[0][0].body).toContain('85%');
    expect(d.enqueueNotice.mock.calls[0][0].body).toContain('(85,0 de');

    addUsage('2026-10-14', 20);
    runFupEngine(db, offPeak('2026-10-22'), d);
    expect(kinds()).toEqual(['2026-10:AVISO', '2026-10:LIMITADO']);
    expect(fupLimitedServices(db, offPeak('2026-10-22'))).toEqual(new Map([[serviceId, 50]]));
    expect(loadFupUsage(db, offPeak('2026-10-22'), readFupSettings(db))[0].limitedNow).toBe(false);
    expect(fupLimitedServices(db, peak('2026-10-22'))).toEqual(new Map([[serviceId, 50]]));

    // Novo ciclo a 10/11: repõe e não limita.
    runFupEngine(db, peak('2026-11-10'), d);
    expect(kinds()).toEqual(['2026-10:AVISO', '2026-10:LIMITADO', '2026-10:RESTAURADO']);
    expect(fupLimitedServices(db, peak('2026-11-10')).size).toBe(0);
    runFupEngine(db, peak('2026-11-11'), d);
    expect(kinds()).toHaveLength(3);
    expect(d.enqueueNotice).toHaveBeenCalledTimes(1);
  });

  test('não pede passagem ao router nas bordas da janela', () => {
    const d = deps();
    addUsage('2026-10-12', 120);
    runFupEngine(db, offPeak('2026-10-20'), d);
    const before = d.requestSync.mock.calls.length;
    runFupEngine(db, offPeak('2026-10-20'), d);
    expect(d.requestSync.mock.calls.length).toBe(before);
    runFupEngine(db, peak('2026-10-20'), d);
    expect(d.requestSync.mock.calls.length).toBe(before);
    runFupEngine(db, offPeak('2026-10-21'), d);
    expect(d.requestSync.mock.calls.length).toBe(before);
  });

  test('alteração a meio do ciclo não repete o aviso; subir o limiar levanta a limitação já', () => {
    const d = deps();
    addUsage('2026-10-12', 110);
    runFupEngine(db, peak('2026-10-20'), d);
    expect(kinds()).toEqual(['2026-10:AVISO', '2026-10:LIMITADO']);
    saveFupSettings(db, { limiar_aviso_percent: '50', limiar_limitacao_percent: '150' }, 'admin');
    runFupEngine(db, peak('2026-10-20'), d);
    expect(kinds()).toEqual(['2026-10:AVISO', '2026-10:LIMITADO']);
    expect(d.enqueueNotice).toHaveBeenCalledTimes(1);
    expect(fupLimitedServices(db, peak('2026-10-20')).size).toBe(0);
  });

  test('precedência da % de pico: plano > global', () => {
    addUsage('2026-10-12', 120);
    runFupEngine(db, peak('2026-10-20'), deps());
    expect(fupLimitedServices(db, peak('2026-10-20')).get(serviceId)).toBe(50);
    saveFupSettings(db, { percent_velocidade_pico: '40' }, 'admin');
    expect(fupLimitedServices(db, peak('2026-10-20')).get(serviceId)).toBe(40);
    db.prepare('UPDATE internet_plans SET fup_peak_percent = 25').run();
    expect(fupLimitedServices(db, peak('2026-10-20')).get(serviceId)).toBe(25);
  });

  test('plano sem referência e serviço suspenso nunca são limitados nem avisados', () => {
    const d = deps();
    addUsage('2026-10-12', 500);
    db.prepare('UPDATE services SET status = ?').run('suspended');
    runFupEngine(db, peak('2026-10-20'), d);
    db.prepare('UPDATE services SET status = ?').run('active');
    db.prepare('UPDATE internet_plans SET fup_reference_gb = 0').run();
    runFupEngine(db, peak('2026-10-20'), d);
    expect(kinds()).toEqual([]);
    expect(d.enqueueNotice).not.toHaveBeenCalled();
  });

  test('cliente que recusou avisos não é avisado, mas o evento fica', () => {
    db.prepare('UPDATE clients SET whatsapp_opt_out = 1').run();
    const d = deps();
    addUsage('2026-10-12', 85);
    runFupEngine(db, peak('2026-10-20'), d);
    expect(d.enqueueNotice).not.toHaveBeenCalled();
    expect(kinds()).toEqual(['2026-10:AVISO']);
  });

  test('dia de ciclo definido no serviço manda sobre a ativação', () => {
    db.prepare('UPDATE services SET fup_cycle_day = 1').run();
    addUsage('2026-10-31', 90);
    expect(loadFupUsage(db, peak('2026-11-02'), readFupSettings(db))[0]).toMatchObject({ percent: 0, cycle: { start: '2026-11-01' } });
    expect(loadFupUsage(db, peak('2026-10-31'), readFupSettings(db))[0].percent).toBeCloseTo(90);
  });

  test('plafond: serviço > plano > predefinido; 0 no serviço isenta', () => {
    addUsage('2026-10-12', 120);
    const gb = () => loadFupUsage(db, peak('2026-10-20'), readFupSettings(db))[0];
    expect(gb()).toMatchObject({ referenceGb: 100, serviceReferenceGb: null, inheritedReferenceGb: 100 });
    db.prepare('UPDATE internet_plans SET fup_reference_gb = 0').run();
    expect(gb().referenceGb).toBe(0);
    saveFupSettings(db, { plafond_predefinido_gb: '250' }, 'admin');
    expect(gb()).toMatchObject({ referenceGb: 250, inheritedReferenceGb: 250 });
    db.prepare('UPDATE services SET fup_reference_gb = 500').run();
    expect(gb()).toMatchObject({ referenceGb: 500, serviceReferenceGb: 500, inheritedReferenceGb: 250 });
    db.prepare('UPDATE services SET fup_reference_gb = 0').run();
    runFupEngine(db, peak('2026-10-20'), deps());
    expect(gb().referenceGb).toBe(0);
    expect(kinds()).toEqual([]);
  });

  test('dia de renovação: serviço > Definições > ativação', () => {
    saveFupSettings(db, { dia_ciclo: '1' }, 'admin');
    expect(loadFupUsage(db, peak('2026-11-02'), readFupSettings(db))[0].cycle.start).toBe('2026-11-01');
    db.prepare('UPDATE services SET fup_cycle_day = 5').run();
    expect(loadFupUsage(db, peak('2026-11-06'), readFupSettings(db))[0].cycle.start).toBe('2026-11-05');
  });

  test('bloquear: limitado a toda a hora e o aviso diz que a ligação fica bloqueada', () => {
    saveFupSettings(db, { acao_ao_limite: 'BLOQUEAR' }, 'admin');
    const d = deps();
    addUsage('2026-10-12', 120);
    runFupEngine(db, offPeak('2026-10-20'), d);
    expect(loadFupUsage(db, offPeak('2026-10-20'), readFupSettings(db))[0].limitedNow).toBe(true);
    expect(d.enqueueNotice.mock.calls[0][0].body).toContain('a ligação fica bloqueada até ao próximo ciclo');
  });

  test('pré-visualização conta com a configuração candidata e não grava nada', () => {
    addUsage('2026-10-12', 85);
    const settings = readFupSettings(db);
    expect(previewFupImpact(db, peak('2026-10-20'), settings)).toEqual({ aviso: 1, limitados: 0 });
    expect(previewFupImpact(db, peak('2026-10-20'), { ...settings, limiar_limitacao_percent: 85 })).toEqual({ aviso: 0, limitados: 1 });
    expect(kinds()).toEqual([]);
  });
});

test('fila persiste fora do pico, acompanha a configuração e sai no ciclo seguinte', async () => {
  addUsage('2026-10-12', 120);
  runFupEngine(db, offPeak('2026-10-20'), deps());
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const queues: Array<Record<string, unknown>> = [{ '.id': '*1', name: '<pppoe-ana>', dynamic: 'true' }];
  const transport: RouterTransport = async (request) => {
    calls.push(request);
    if (request.path.startsWith('/queue/simple?')) return queues;
    if (request.path.startsWith('/ppp/active')) return [{ '.id': '*a', name: 'ana' }];
    if (request.path.startsWith('/system/clock')) return [{ 'time-zone-name': 'UTC' }];
    return {};
  };
  const first = await syncFupQueues(db, { transport, dryRun: false, now: offPeak('2026-10-20') });
  expect(first).toMatchObject({ added: 1, clockZone: 'UTC', clockMismatch: true });
  expect(calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/queue/simple', body: expect.objectContaining({ time: '18:00:00-24:00:00,sun,mon,tue,wed,thu,fri,sat' }) }));
  queues.push({ '.id': '*2', name: `ispm-fup-${serviceId}`, dynamic: 'false', 'max-limit': '1000000/5000000', time: '18h-1d,sun,mon,tue,wed,thu,fri,sat' });
  expect(await syncFupQueues(db, { transport, dryRun: false, now: peak('2026-10-20') })).toMatchObject({ updated: 0 });
  saveFupSettings(db, { janela_pico_fim: '22:00' }, 'admin');
  expect(await syncFupQueues(db, { transport, dryRun: false, now: peak('2026-10-20') })).toMatchObject({ updated: 1 });
  expect(calls).toContainEqual(expect.objectContaining({ method: 'PATCH', path: '/queue/simple/*2', body: expect.objectContaining({ time: '18:00:00-22:00:00,sun,mon,tue,wed,thu,fri,sat' }) }));
  expect(await syncFupQueues(db, { transport, dryRun: false, now: peak('2026-11-10') })).toMatchObject({ removed: 1 });
});

test('bloquear usa a mesma fila, o dia todo a 1k, e trocar a ação corrige a fila existente', async () => {
  saveFupSettings(db, { acao_ao_limite: 'BLOQUEAR' }, 'admin');
  db.prepare('UPDATE internet_plans SET download_mbps = NULL, upload_mbps = NULL').run();
  addUsage('2026-10-12', 120);
  runFupEngine(db, offPeak('2026-10-20'), deps());
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const queues: Array<Record<string, unknown>> = [{ '.id': '*1', name: '<pppoe-ana>', dynamic: 'true' }];
  const transport: RouterTransport = async (request) => {
    calls.push(request);
    if (request.path.startsWith('/queue/simple?')) return queues;
    if (request.path.startsWith('/ppp/active')) return [{ '.id': '*a', name: 'ana' }];
    return [];
  };
  // Sem Mbps no plano, bloquear continua a funcionar: não depende delas.
  expect(await syncFupQueues(db, { transport, dryRun: false, now: offPeak('2026-10-20') })).toMatchObject({ added: 1 });
  expect(calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/queue/simple', body: expect.objectContaining({ 'max-limit': '1k/1k', time: '0s-1d,sun,mon,tue,wed,thu,fri,sat' }) }));
  queues.push({ '.id': '*2', name: `ispm-fup-${serviceId}`, dynamic: 'false', 'max-limit': '1000/1000', time: '0s-1d,sun,mon,tue,wed,thu,fri,sat' });
  expect(await syncFupQueues(db, { transport, dryRun: false, now: offPeak('2026-10-20') })).toMatchObject({ updated: 0 });
  db.prepare('UPDATE internet_plans SET download_mbps = 10, upload_mbps = 2').run();
  saveFupSettings(db, { acao_ao_limite: 'REDUZIR' }, 'admin');
  expect(await syncFupQueues(db, { transport, dryRun: false, now: offPeak('2026-10-20') })).toMatchObject({ updated: 1 });
  expect(calls).toContainEqual(expect.objectContaining({ method: 'PATCH', path: '/queue/simple/*2', body: expect.objectContaining({ time: '18:00:00-24:00:00,sun,mon,tue,wed,thu,fri,sat' }) }));
});

test('aguarda a fila dinâmica antes de criar uma fila FUP', async () => {
  addUsage('2026-10-12', 120);
  runFupEngine(db, peak('2026-10-20'), deps());
  const calls: Array<{ method: string; path: string }> = [];
  const transport: RouterTransport = async (request) => {
    calls.push(request);
    if (request.path.startsWith('/ppp/active')) return [{ '.id': '*a', name: 'ana' }];
    return [];
  };
  const result = await syncFupQueues(db, { transport, dryRun: false, now: peak('2026-10-20') });
  expect(result.added).toBe(0);
  expect(calls.some((request) => request.method === 'PUT' && request.path === '/queue/simple')).toBe(false);
});

describe('horário da limitação', () => {
  // 2026-11-14 é sábado, 2026-11-17 terça; 10:00 em CV = 11:00 UTC.
  const saturday = new Date('2026-11-14T11:00:00Z');
  const tuesday = new Date('2026-11-17T11:00:00Z');

  test('janela, fim de semana inteiro e dia inteiro', () => {
    const base = readFupSettings(db);
    expect(inLimitWindow(saturday, base)).toBe(false);
    expect(inLimitWindow(saturday, { ...base, horario_limitacao: 'JANELA_FDS' })).toBe(true);
    expect(inLimitWindow(tuesday, { ...base, horario_limitacao: 'JANELA_FDS' })).toBe(false);
    expect(inLimitWindow(tuesday, { ...base, horario_limitacao: 'DIA_INTEIRO' })).toBe(true);
    expect(() => saveFupSettings(db, { horario_limitacao: 'NOITE' }, 'teste')).toThrow('Horário inválido');
    expect(() => saveFupSettings(db, { horario_limitacao: 'DIA_INTEIRO', mensagem_aviso: 'Das {inicio} às {fim}' }, 'teste')).toThrow('dia inteiro');
    expect(fupActionText({ ...base, horario_limitacao: 'JANELA_FDS' }, 50)).toBe('a velocidade entre as 18:00 e as 00:00, e o dia inteiro ao sábado e ao domingo, passa a 50% da contratada');
    expect(fupActionText({ ...base, horario_limitacao: 'DIA_INTEIRO' }, 50)).toBe('a velocidade passa a 50% da contratada');
  });

  test('fim de semana inteiro = duas filas; voltar à janela tira a do fim de semana; dia inteiro = uma fila 24 h', async () => {
    saveFupSettings(db, { horario_limitacao: 'JANELA_FDS' }, 'admin');
    addUsage('2026-11-12', 120);
    runFupEngine(db, saturday, deps());
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const queues: Array<Record<string, unknown>> = [{ '.id': '*1', name: '<pppoe-ana>', dynamic: 'true' }];
    const transport: RouterTransport = async (request) => {
      calls.push(request);
      if (request.path.startsWith('/queue/simple?')) return queues;
      if (request.path.startsWith('/ppp/active')) return [{ '.id': '*a', name: 'ana' }];
      return [];
    };
    expect(await syncFupQueues(db, { transport, dryRun: false, now: saturday })).toMatchObject({ added: 2 });
    expect(calls).toContainEqual(expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ name: `ispm-fup-${serviceId}`, time: '18:00:00-24:00:00,mon,tue,wed,thu,fri' }) }));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ name: `ispm-fup-${serviceId}-fds`, time: '0s-1d,sat,sun' }) }));
    queues.push(
      { '.id': '*2', name: `ispm-fup-${serviceId}`, dynamic: 'false', 'max-limit': '1000000/5000000', time: '18h-1d,mon,tue,wed,thu,fri' },
      // O RouterOS devolve os dias pela ordem dele: `sun,sat`.
      { '.id': '*3', name: `ispm-fup-${serviceId}-fds`, dynamic: 'false', 'max-limit': '1000000/5000000', time: '0s-1d,sun,sat' }
    );
    expect(await syncFupQueues(db, { transport, dryRun: false, now: saturday })).toMatchObject({ added: 0, updated: 0, removed: 0 });

    saveFupSettings(db, { horario_limitacao: 'JANELA' }, 'admin');
    expect(await syncFupQueues(db, { transport, dryRun: false, now: saturday })).toMatchObject({ updated: 1, removed: 1 });
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/queue/simple/*3' }));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'PATCH', path: '/queue/simple/*2', body: expect.objectContaining({ time: '18:00:00-24:00:00,sun,mon,tue,wed,thu,fri,sat' }) }));

    saveFupSettings(db, { horario_limitacao: 'DIA_INTEIRO' }, 'admin');
    queues.splice(2);
    expect(await syncFupQueues(db, { transport, dryRun: false, now: saturday })).toMatchObject({ updated: 1 });
    expect(calls).toContainEqual(expect.objectContaining({ method: 'PATCH', path: '/queue/simple/*2', body: expect.objectContaining({ 'max-limit': '1000k/5000k', time: '0s-1d,sun,mon,tue,wed,thu,fri,sat' }) }));
  });

  test('dia inteiro dura até ao ciclo de cada serviço, pela data de ativação', () => {
    saveFupSettings(db, { horario_limitacao: 'DIA_INTEIRO' }, 'admin');
    db.prepare('UPDATE services SET activation_date = ?').run('2026-03-09');
    const other = Number(db.prepare(`INSERT INTO services (client_id, plan_id, pppoe_username, status, activation_date)
      VALUES ((SELECT id FROM clients), (SELECT id FROM internet_plans), 'beto', 'active', '2026-03-22')`).run().lastInsertRowid);
    addUsage('2026-10-23', 120);
    db.prepare('INSERT INTO client_traffic_daily (day, service_id, rx_bytes, tx_bytes) VALUES (?, ?, 0, ?)').run('2026-10-23', other, 120 * GB);
    runFupEngine(db, offPeak('2026-10-24'), deps());
    expect([...fupLimitedServices(db, offPeak('2026-10-24')).keys()].sort()).toEqual([serviceId, other].sort());
    expect(loadFupUsage(db, offPeak('2026-10-24'), readFupSettings(db)).every((row) => row.limitedNow)).toBe(true);

    // A 9/11 o primeiro renova; o segundo fica limitado até 22/11.
    runFupEngine(db, offPeak('2026-11-09'), deps());
    expect([...fupLimitedServices(db, offPeak('2026-11-09')).keys()]).toEqual([other]);
    runFupEngine(db, offPeak('2026-11-22'), deps());
    expect(fupLimitedServices(db, offPeak('2026-11-22')).size).toBe(0);
  });
});

describe('uso justo global: pacote da operadora', () => {
  // Ciclo da conta por omissão: dia 19 → 2026-10-19..2026-11-18.
  const day = (d: string) => new Date(`${d}T13:00:00Z`);
  const wan = (d: string, gb: number) => db.prepare('INSERT INTO wan_traffic_daily (day, interface, rx_bytes, tx_bytes) VALUES (?, ?, ?, 0)').run(d, `wan-${Math.random()}`, gb * GB);
  let beto: number;
  beforeEach(() => {
    db.prepare('DELETE FROM wan_traffic_daily').run();
    beto = Number(db.prepare(`INSERT INTO services (client_id, plan_id, pppoe_username, status, activation_date)
      VALUES ((SELECT id FROM clients), (SELECT id FROM internet_plans), 'beto', 'active', '2026-03-10')`).run().lastInsertRowid);
    db.prepare('INSERT INTO client_traffic_daily (day, service_id, rx_bytes, tx_bytes) VALUES (?, ?, 0, ?)').run('2026-10-20', beto, 30 * GB);
    addUsage('2026-10-20', 120);
  });
  const byId = (now: Date) => new Map(loadFupUsage(db, now, readFupSettings(db)).map((row) => [row.serviceId, row]));

  test('desligado (0): manda o plafond do plano e o ciclo de cada serviço', () => {
    expect(byId(day('2026-10-24')).get(serviceId)).toMatchObject({ referenceGb: 100, cycle: { start: '2026-10-10' }, globalLimit: false });
  });

  test('quota igual: pacote ÷ clientes ativos, no ciclo da operadora, sem olhar ao plano', () => {
    db.prepare('UPDATE internet_plans SET fup_reference_gb = 500').run();
    saveFupSettings(db, { pacote_operadora_gb: '200', ligacoes_extra_pacote: '0' }, 'admin');
    wan('2026-10-20', 150);
    runFupEngine(db, day('2026-10-24'), deps());
    const rows = byId(day('2026-10-24'));
    expect(rows.get(serviceId)).toMatchObject({ referenceGb: 100, cycle: { start: '2026-10-19', end: '2026-11-18' }, state: 'LIMITADO', limited: true, globalLimit: false });
    expect(rows.get(beto)).toMatchObject({ referenceGb: 100, state: 'NORMAL', limited: false });
    expect(loadOperatorPool(db, day('2026-10-24'), readFupSettings(db))).toMatchObject({ activeClients: 2, shareGb: 100, percent: 75, exhausted: false });
  });

  test('pacote acima do limiar limita todos sem gravar eventos, e levanta na renovação da operadora', () => {
    saveFupSettings(db, { pacote_operadora_gb: '200', ligacoes_extra_pacote: '0' }, 'admin');
    wan('2026-10-20', 185);
    runFupEngine(db, day('2026-10-24'), deps());
    const rows = byId(day('2026-10-24'));
    expect(rows.get(beto)).toMatchObject({ state: 'NORMAL', limited: true, globalLimit: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fup_events WHERE service_id = ?').get(beto)).toEqual({ n: 0 });
    expect(previewFupImpact(db, day('2026-10-24'), readFupSettings(db)).limitados).toBe(2);
    runFupEngine(db, day('2026-11-19'), deps());
    expect(fupLimitedServices(db, day('2026-11-19')).size).toBe(0);
  });

  test('ligações sem ficha (escritório, colaboradores) entram no divisor', () => {
    saveFupSettings(db, { pacote_operadora_gb: '300' }, 'admin');
    expect(loadOperatorPool(db, day('2026-10-24'), readFupSettings(db))).toMatchObject({ activeClients: 2, extraConnections: 1, shareGb: 100 });
    saveFupSettings(db, { ligacoes_extra_pacote: '0' }, 'admin');
    expect(loadOperatorPool(db, day('2026-10-24'), readFupSettings(db)).shareGb).toBe(150);
    expect(() => saveFupSettings(db, { ligacoes_extra_pacote: '-1' }, 'admin')).toThrow('0 a 100');
  });

  test('isento fica fora da quota e do divisor', () => {
    db.prepare('UPDATE services SET fup_reference_gb = 0 WHERE id = ?').run(beto);
    saveFupSettings(db, { pacote_operadora_gb: '200', ligacoes_extra_pacote: '0' }, 'admin');
    wan('2026-10-20', 190);
    const rows = byId(day('2026-10-24'));
    expect(loadOperatorPool(db, day('2026-10-24'), readFupSettings(db))).toMatchObject({ activeClients: 1, shareGb: 200, exhausted: true });
    expect(rows.get(beto)).toMatchObject({ referenceGb: 0, limited: false });
    expect(rows.get(serviceId)).toMatchObject({ referenceGb: 200, limited: true });
  });

  test('pacote esgotado cria a fila de todos os que estão ligados', async () => {
    saveFupSettings(db, { pacote_operadora_gb: '200', ligacoes_extra_pacote: '0' }, 'admin');
    wan('2026-10-20', 190);
    const queues = [{ '.id': '*1', name: '<pppoe-ana>', dynamic: 'true' }, { '.id': '*2', name: '<pppoe-beto>', dynamic: 'true' }];
    const transport: RouterTransport = async (request) => {
      if (request.path.startsWith('/queue/simple?')) return queues;
      if (request.path.startsWith('/ppp/active')) return [{ '.id': '*a', name: 'ana' }, { '.id': '*b', name: 'beto' }];
      return [];
    };
    expect(await syncFupQueues(db, { transport, dryRun: false, now: day('2026-10-24') })).toMatchObject({ wanted: 2, added: 2 });
  });
});

describe('unidade de consumo nas Definições', () => {
  test('aceita só DECIMAL ou BINARIO e o motor conta na unidade gravada', () => {
    expect(() => saveFupSettings(db, { unidade_gb: 'TB' }, 'teste')).toThrow('Unidade inválida');
    saveFupSettings(db, { unidade_gb: 'BINARIO' }, 'teste');
    expect(readFupSettings(db).unidade_gb).toBe('BINARIO');
    saveFupSettings(db, { unidade_gb: 'DECIMAL' }, 'teste');
    expect(readFupSettings(db).unidade_gb).toBe('DECIMAL');
  });
});
