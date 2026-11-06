import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  bytesToGb, cycleFor, cycleStartDay, fupLimitedServices, inPeakWindow, loadFupUsage, nextTransitions, previewFupImpact,
  runFupEngine, usagePercent, type FupEngineDeps
} from './fup';
import { collectClientUsage } from './client-usage';
import { invalidateFupSettingsCache, readFupSettings, saveFupSettings } from './fup-settings';
import type { RouterTransport } from './routeros';

const GB = 1024 ** 3;
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
  test('GB em base 1024³ e percentagem da referência', () => {
    expect(bytesToGb(GB * 1.5)).toBe(1.5);
    expect(usagePercent(80 * GB, 100)).toBe(80);
    expect(usagePercent(150 * GB, 100)).toBe(150);
    expect(usagePercent(10 * GB, 0)).toBe(0);
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

    addUsage('2026-10-14', 20);
    runFupEngine(db, offPeak('2026-10-22'), d);
    expect(kinds()).toEqual(['2026-10:AVISO', '2026-10:LIMITADO']);
    expect(fupLimitedServices(db, offPeak('2026-10-22')).size).toBe(0);
    expect(fupLimitedServices(db, peak('2026-10-22'))).toEqual(new Map([[serviceId, 50]]));

    // Novo ciclo a 10/11: repõe e não limita.
    runFupEngine(db, peak('2026-11-10'), d);
    expect(kinds()).toEqual(['2026-10:AVISO', '2026-10:LIMITADO', '2026-10:RESTAURADO']);
    expect(fupLimitedServices(db, peak('2026-11-10')).size).toBe(0);
    runFupEngine(db, peak('2026-11-11'), d);
    expect(kinds()).toHaveLength(3);
    expect(d.enqueueNotice).toHaveBeenCalledTimes(1);
  });

  test('pede passagem ao router só quando o conjunto de limitados muda (bordas da janela)', () => {
    const d = deps();
    addUsage('2026-10-12', 120);
    runFupEngine(db, offPeak('2026-10-20'), d);
    const before = d.requestSync.mock.calls.length;
    runFupEngine(db, offPeak('2026-10-20'), d);
    expect(d.requestSync.mock.calls.length).toBe(before);
    runFupEngine(db, peak('2026-10-20'), d);
    expect(d.requestSync.mock.calls.length).toBe(before + 1);
    runFupEngine(db, offPeak('2026-10-21'), d);
    expect(d.requestSync.mock.calls.length).toBe(before + 2);
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

  test('pré-visualização conta com a configuração candidata e não grava nada', () => {
    addUsage('2026-10-12', 85);
    const settings = readFupSettings(db);
    expect(previewFupImpact(db, peak('2026-10-20'), settings)).toEqual({ aviso: 1, limitados: 0 });
    expect(previewFupImpact(db, peak('2026-10-20'), { ...settings, limiar_limitacao_percent: 85 })).toEqual({ aviso: 0, limitados: 1 });
    expect(kinds()).toEqual([]);
  });
});
