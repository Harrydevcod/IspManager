import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let runMonthlyBillingIfDue: typeof import('./auto-billing').runMonthlyBillingIfDue;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-autobilling-test-'));
  process.env.ISPM_DATA_DIR = dataDir;

  const database = await import('../db/database');
  database.getDatabase(); // run migrations
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  ({ runMonthlyBillingIfDue } = await import('./auto-billing'));
});

beforeEach(() => {
  // Child-first: payments reference services/clients.
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM app_settings').run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

function setSetting(key: string, value: string) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

/** Seeds one active client with one active service. Returns the service id. */
function seedActiveService(code: string, amount = 2500): number {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')
  `).run(code, `Cliente ${code}`).lastInsertRowid as number;
  return db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status)
    VALUES (?, ?, 1, 'active')
  `).run(clientId, amount).lastInsertRowid as number;
}

/** Seeds a cancelled client whose service is (wrongly) still active. */
function seedCancelledClientWithActiveService(code: string): number {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'cancelled')
  `).run(code, `Cancelado ${code}`).lastInsertRowid as number;
  return db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status)
    VALUES (?, 2500, 1, 'active')
  `).run(clientId).lastInsertRowid as number;
}

const billedMonths = () =>
  (db.prepare("SELECT DISTINCT reference_month AS m FROM payments WHERE status != 'cancelled' ORDER BY m").all() as Array<{ m: string }>)
    .map((r) => r.m);

const paymentsForService = (serviceId: number) =>
  (db.prepare('SELECT reference_month AS m FROM payments WHERE service_id = ? ORDER BY m').all(serviceId) as Array<{ m: string }>)
    .map((r) => r.m);

describe('runMonthlyBillingIfDue — competência do mês fechado', () => {
  test('no dia 30, fatura o próprio mês que fecha', () => {
    seedActiveService('A');
    setSetting('autoBillingDay', '30');

    const result = runMonthlyBillingIfDue(new Date(2026, 5, 30)); // 30 Jun

    expect(result).toMatchObject({ ran: true, months: ['2026-06'], created: 1 });
    expect(billedMonths()).toEqual(['2026-06']);
  });

  test('no início do mês seguinte (dia 3) fatura o mês anterior, não o corrente', () => {
    const svc = seedActiveService('A');
    setSetting('autoBillingDay', '30');
    setSetting('lastAutoBillingMonth', '2026-05');

    const result = runMonthlyBillingIfDue(new Date(2026, 6, 3)); // 3 Jul

    expect(result).toMatchObject({ ran: true, months: ['2026-06'] });
    expect(paymentsForService(svc)).toEqual(['2026-06']); // Junho, nunca Julho
  });

  test('no dia 30 do mês seguinte fatura esse mês', () => {
    seedActiveService('A');
    setSetting('autoBillingDay', '30');
    setSetting('lastAutoBillingMonth', '2026-06');

    const result = runMonthlyBillingIfDue(new Date(2026, 6, 30)); // 30 Jul

    expect(result).toMatchObject({ ran: true, months: ['2026-07'] });
  });

  test('recupera meses em falta sem gaps (catch-up)', () => {
    seedActiveService('A');
    setSetting('autoBillingDay', '30');
    setSetting('lastAutoBillingMonth', '2026-04');

    const result = runMonthlyBillingIfDue(new Date(2026, 6, 10)); // 10 Jul → alvo Junho

    expect(result).toMatchObject({ ran: true, months: ['2026-05', '2026-06'], created: 2 });
    expect(billedMonths()).toEqual(['2026-05', '2026-06']);
  });

  test('instalação nova não retroage histórico — fatura só o alvo', () => {
    seedActiveService('A');
    setSetting('autoBillingDay', '30');
    // sem lastAutoBillingMonth

    const result = runMonthlyBillingIfDue(new Date(2026, 6, 10)); // 10 Jul → alvo Junho

    expect(result).toMatchObject({ ran: true, months: ['2026-06'] });
    expect(billedMonths()).toEqual(['2026-06']);
  });

  test('não regride quando o último mês faturado já está à frente do alvo', () => {
    seedActiveService('A');
    setSetting('autoBillingDay', '30');
    setSetting('lastAutoBillingMonth', '2026-08');

    const result = runMonthlyBillingIfDue(new Date(2026, 6, 10)); // 10 Jul → alvo Junho

    expect(result).toMatchObject({ skipped: true });
    expect(billedMonths()).toEqual([]);
  });

  test('Fevereiro (sem dia 30) só é faturado no início de Março', () => {
    const svc = seedActiveService('A');
    setSetting('autoBillingDay', '30');
    setSetting('lastAutoBillingMonth', '2026-01');

    // 27 Fev: ainda não fecha Fevereiro; alvo recai em Janeiro (já feito) → skip
    const feb = runMonthlyBillingIfDue(new Date(2026, 1, 27));
    expect(feb).toMatchObject({ skipped: true });
    expect(paymentsForService(svc)).toEqual([]);

    // 1 Mar: fecha Fevereiro
    const mar = runMonthlyBillingIfDue(new Date(2026, 2, 1));
    expect(mar).toMatchObject({ ran: true, months: ['2026-02'] });
    expect(paymentsForService(svc)).toEqual(['2026-02']);
  });

  test('idempotente — segunda corrida no mesmo estado não duplica', () => {
    seedActiveService('A');
    setSetting('autoBillingDay', '30');

    const first = runMonthlyBillingIfDue(new Date(2026, 5, 30));
    expect(first).toMatchObject({ ran: true, months: ['2026-06'] });

    const second = runMonthlyBillingIfDue(new Date(2026, 5, 30));
    expect(second).toMatchObject({ skipped: true });

    const count = (db.prepare('SELECT COUNT(*) AS n FROM payments').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  test('cliente cancelado nunca é faturado, mesmo com serviço ativo', () => {
    const active = seedActiveService('OK');
    const cancelled = seedCancelledClientWithActiveService('NOK');
    setSetting('autoBillingDay', '30');

    runMonthlyBillingIfDue(new Date(2026, 5, 30));

    expect(paymentsForService(active)).toEqual(['2026-06']);
    expect(paymentsForService(cancelled)).toEqual([]);
  });

  test('default 30 quando autoBillingDay não está configurado', () => {
    seedActiveService('A');
    // sem autoBillingDay → default 30

    const onDay29 = runMonthlyBillingIfDue(new Date(2026, 5, 29)); // alvo = Maio
    expect(onDay29).toMatchObject({ ran: true, months: ['2026-05'] });

    db.prepare('DELETE FROM payments').run();
    db.prepare('DELETE FROM app_settings').run();
    seedActiveService('B');
    const onDay30 = runMonthlyBillingIfDue(new Date(2026, 5, 30)); // alvo = Junho
    expect(onDay30).toMatchObject({ ran: true, months: ['2026-06'] });
  });
});
