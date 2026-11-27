import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { classifyAverage, collectClientUsage, loadClientUsage, loadServiceUsageCycles, overPlafond, parseClientUsageFile } from './client-usage';
import { utcDay } from './wan-usage';
import { loadFupUsage } from './fup';
import { readFupSettings } from './fup-settings';
import type { RouterTransport } from './routeros';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
const source = (text: string): RouterTransport => async () => [{ source: text }];
// Meio-dia UTC: o mesmo dia no fuso de Cabo Verde das Definições.
const at = (day: string) => new Date(`${day}T12:00:00Z`);

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
    // `@log` é a marca da última saída de sessão que o script do router já somou.
    expect(parseClientUsageFile('# @log;*44 2026-10-10 11:21:08\n# ana;10;20;1;2;1h\n# mau;-1;2;1;2;1h\n# grande;9007199254740992;1;1;1;1h'))
      .toEqual([{ name: 'ana', rxTotal: 10, txTotal: 20, rxLast: 1, txLast: 2, uptime: '1h' }]);
  });

  test('a primeira leitura conta zero; diferenças, reinício e nomes desconhecidos avançam o estado', async () => {
    await collectClientUsage(db, source('# ana;100;200;10;20;1h\n# desconhecido;5;6;1;1;1h'), '2026-10-01');
    expect(loadClientUsage(db, at('2026-10-01'))[0]).toMatchObject({ measured: 1, todayDownBytes: 0, todayUpBytes: 0 });
    await collectClientUsage(db, source('# ana;130;260;30;60;2h\n# desconhecido;10;15;2;2;2h'), '2026-10-01');
    expect(loadClientUsage(db, at('2026-10-01'))[0]).toMatchObject({ todayDownBytes: 60, todayUpBytes: 30 });
    await collectClientUsage(db, source('# ana;8;12;8;12;1m'), '2026-10-02');
    expect(loadClientUsage(db, at('2026-10-02'))[0]).toMatchObject({ todayDownBytes: 12, todayUpBytes: 8, cycleStart: '2026-10-01', cycleDownBytes: 72, cycleUpBytes: 38 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM client_traffic_daily').get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT rx_total AS rx FROM client_usage_state WHERE pppoe_name = 'desconhecido'").get() as { rx: number }).rx).toBe(10);
  });

  test('o total conta o ciclo do serviço, não o mês civil, e bate com o uso justo', () => {
    db.prepare("UPDATE services SET fup_cycle_day = 5").run();
    const id = (db.prepare('SELECT id FROM services').get() as { id: number }).id;
    const day = db.prepare('INSERT INTO client_traffic_daily (day, service_id, rx_bytes, tx_bytes) VALUES (?, ?, ?, ?)');
    day.run('2026-11-04', id, 1e9, 9e9); // fim do ciclo anterior
    day.run('2026-11-05', id, 2e9, 100e9);
    day.run('2026-11-14', id, 3e9, 55e9);
    const now = at('2026-11-14');
    const [row] = loadClientUsage(db, now);
    expect(row).toMatchObject({ cycleStart: '2026-11-05', cycleDownBytes: 155e9, cycleUpBytes: 5e9, todayDownBytes: 55e9 });
    const [fup] = loadFupUsage(db, now, readFupSettings(db), { serviceId: id });
    expect(fup.totalBytes).toBe(row.cycleDownBytes + row.cycleUpBytes);
  });

  test('um serviço inativo só aparece com consumo no ciclo', () => {
    db.prepare("UPDATE services SET status = 'suspended'").run();
    expect(loadClientUsage(db, at('2026-11-14'))).toHaveLength(0);
    db.prepare("INSERT INTO client_traffic_daily (day, service_id, rx_bytes, tx_bytes) VALUES ('2026-11-02', (SELECT id FROM services), 1, 1)").run();
    expect(loadClientUsage(db, at('2026-11-14'))).toHaveLength(1);
  });

  test('histórico ciclo a ciclo: do atual para trás, fronteiras certas, para no primeiro dia medido', () => {
    db.prepare('UPDATE services SET fup_cycle_day = 5').run();
    const id = (db.prepare('SELECT id FROM services').get() as { id: number }).id;
    const day = db.prepare('INSERT INTO client_traffic_daily (day, service_id, rx_bytes, tx_bytes) VALUES (?, ?, ?, ?)');
    day.run('2026-09-20', id, 1e9, 10e9); // ciclo 05-09 a 04-10, o primeiro medido
    day.run('2026-10-04', id, 1e9, 20e9); // último dia desse ciclo
    day.run('2026-10-05', id, 2e9, 30e9); // primeiro dia do ciclo seguinte
    day.run('2026-11-14', id, 3e9, 40e9); // ciclo atual
    db.prepare("INSERT INTO fup_events (service_id, period, kind) VALUES (?, '2026-10', 'AVISO'), (?, '2026-10', 'LIMITADO')").run(id, id);
    const now = at('2026-11-14');

    const { cycles } = loadServiceUsageCycles(db, id, now);
    expect(cycles.map((c) => [c.start, c.end, c.current, c.downBytes, c.upBytes, c.days, c.fup])).toEqual([
      ['2026-11-05', '2026-12-04', true, 40e9, 3e9, 1, null],
      ['2026-10-05', '2026-11-04', false, 30e9, 2e9, 1, 'LIMITADO'],
      ['2026-09-05', '2026-10-04', false, 30e9, 2e9, 2, null]
    ]);
    const [fup] = loadFupUsage(db, now, readFupSettings(db), { serviceId: id });
    expect(cycles[0].percent).toBe(fup.percent);
  });

  test('histórico vazio sem PPPoE ou sem medição', () => {
    const id = (db.prepare('SELECT id FROM services').get() as { id: number }).id;
    expect(loadServiceUsageCycles(db, id, at('2026-11-14')).cycles).toEqual([]);
    db.prepare('UPDATE services SET pppoe_username = NULL').run();
    db.prepare("INSERT INTO client_traffic_daily (day, service_id, rx_bytes, tx_bytes) VALUES ('2026-11-10', ?, 1, 1)").run(id);
    expect(loadServiceUsageCycles(db, id, at('2026-11-14')).cycles).toEqual([]);
  });

  test('classe pela posição na base: fronteiras P25, P75 e P95', () => {
    const peers = Array.from({ length: 21 }, (_, i) => i); // 0..20: o outro de cada um são 20
    expect(classifyAverage(peers, 0)).toEqual({ percentile: 0, klass: 'LEVE' });
    expect(classifyAverage(peers, 4)).toEqual({ percentile: 20, klass: 'LEVE' });
    expect(classifyAverage(peers, 5)).toEqual({ percentile: 25, klass: 'MEDIO' });
    expect(classifyAverage(peers, 15)).toEqual({ percentile: 75, klass: 'INTENSO' });
    expect(classifyAverage(peers, 19)).toEqual({ percentile: 95, klass: 'MUITO_INTENSO' });
    expect(classifyAverage(peers, 20)).toEqual({ percentile: 100, klass: 'MUITO_INTENSO' });
  });

  test('perfil: só ativos com 14 dias medidos, pelo menos 8 para comparar, e a série diária', () => {
    const insertClient = db.prepare('INSERT INTO clients (client_code, full_name) VALUES (?, ?)');
    const insertService = db.prepare("INSERT INTO services (client_id, pppoe_username, status) VALUES ((SELECT id FROM clients WHERE client_code = ?), ?, ?) RETURNING id");
    const day = db.prepare('INSERT INTO client_traffic_daily (day, service_id, rx_bytes, tx_bytes) VALUES (?, ?, 0, ?)');
    const fill = (id: number, perDay: number, days = 20) => {
      for (let d = 1; d <= days; d++) day.run(`2026-11-${String(d).padStart(2, '0')}`, id, perDay);
    };
    const ana = (db.prepare('SELECT id FROM services').get() as { id: number }).id;
    fill(ana, 9e9);
    const now = at('2026-11-20');
    // Só 7 comparáveis (contando a Ana): ainda não há classe.
    for (let i = 1; i <= 6; i++) {
      insertClient.run(`P${i}`, `P${i}`);
      fill((insertService.get(`P${i}`, `p${i}`, 'active') as { id: number }).id, i * 1e9);
    }
    insertClient.run('INA', 'Inativo');
    fill((insertService.get('INA', 'ina', 'cancelled') as { id: number }).id, 50e9);
    insertClient.run('NOVO', 'Novo');
    fill((insertService.get('NOVO', 'novo', 'active') as { id: number }).id, 50e9, 5);
    expect(loadServiceUsageCycles(db, ana, now).profile).toMatchObject({ klass: 'SEM_DADOS', peers: 7 });

    insertClient.run('P7', 'P7');
    fill((insertService.get('P7', 'p7', 'active') as { id: number }).id, 7e9);
    const result = loadServiceUsageCycles(db, ana, now);
    expect(result.profile).toMatchObject({ avgDailyBytes: 9e9, peers: 8, percentile: 100, klass: 'MUITO_INTENSO' });
    expect(result.daily).toHaveLength(20);
    expect(result.daily[0]).toEqual({ day: '2026-11-01', downBytes: 9e9, upBytes: 0 });
  });

  test('acima do plafond: ciclo anterior acima de 100% ou o atual projetado, nunca nos primeiros dias', () => {
    const cycle = (start: string, end: string, percent: number) => ({ start, end, period: start.slice(0, 7), current: false, downBytes: 0, upBytes: 0, days: 1, percent, fup: null });
    const current = cycle('2026-11-01', '2026-11-30', 40);
    expect(overPlafond([current, cycle('2026-10-01', '2026-10-31', 120)], 300, '2026-11-10')).toBe(true);
    expect(overPlafond([current], 300, '2026-11-10')).toBe(true); // 40% em 10 de 30 dias → 120%
    expect(overPlafond([current], 300, '2026-11-20')).toBe(false); // 40% em 20 dias → 60%
    expect(overPlafond([cycle('2026-11-01', '2026-11-30', 30)], 300, '2026-11-02')).toBe(false); // 2 dias: ruído
    expect(overPlafond([current], 0, '2026-11-10')).toBe(false);
  });

  test('dia UTC', () => {
    expect(utcDay(new Date('2026-10-02T00:30:00Z'))).toBe('2026-10-02');
  });
});
