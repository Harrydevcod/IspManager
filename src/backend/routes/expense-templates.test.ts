import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-templates-test-'));
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
  db.prepare('DELETE FROM expenses').run();
  db.prepare('DELETE FROM expense_templates').run();
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

describe('expense templates', () => {
  test('CRUD lifecycle and totals', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/expense-templates',
      payload: { name: 'Banda mensal', category: 'banda_internet', amountCve: 85000, dayOfMonth: 1 }
    });
    expect(create.statusCode).toBe(201);
    const id = (create.json() as { id: number }).id;

    const list = await app.inject({ method: 'GET', url: '/api/expense-templates' });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { rows: Array<{ name: string }>; totals: { totalActiveMonthlyCve: number } };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].name).toBe('Banda mensal');
    expect(body.totals.totalActiveMonthlyCve).toBe(85000);

    const pause = await app.inject({
      method: 'PUT',
      url: `/api/expense-templates/${id}`,
      payload: { name: 'Banda mensal', category: 'banda_internet', amountCve: 85000, dayOfMonth: 1, active: false }
    });
    expect(pause.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/expense-templates' }).then((r) => r.json())) as { totals: { totalActiveMonthlyCve: number } };
    expect(after.totals.totalActiveMonthlyCve).toBe(0);

    const del = await app.inject({ method: 'DELETE', url: `/api/expense-templates/${id}` });
    expect(del.statusCode).toBe(200);
  });
});

describe('recurring expenses cron', () => {
  test('generates one expense per active due template and is idempotent', async () => {
    const { runRecurringExpensesIfDue } = await import('../lib/recurring-expenses');
    const now = new Date('2026-05-15T10:00:00Z');

    db.prepare(`INSERT INTO expense_templates (name, category, amount_cve, day_of_month, active)
                VALUES ('Salarios', 'salarios', 250000, 1, 1)`).run();
    db.prepare(`INSERT INTO expense_templates (name, category, amount_cve, day_of_month, active)
                VALUES ('Aluguer torre', 'aluguer', 15000, 5, 1)`).run();
    db.prepare(`INSERT INTO expense_templates (name, category, amount_cve, day_of_month, active)
                VALUES ('Combustivel pago dia 20', 'combustivel', 4000, 20, 1)`).run();
    db.prepare(`INSERT INTO expense_templates (name, category, amount_cve, day_of_month, active)
                VALUES ('Pausado', 'outros', 999, 1, 0)`).run();

    const first = runRecurringExpensesIfDue(now);
    expect('ran' in first && first.ran).toBe(true);
    if ('ran' in first) {
      expect(first.generated).toBe(2); // salarios + aluguer (dayOfMonth <= 15); combustivel ainda nao
      expect(first.month).toBe('2026-05');
    }

    const rows = db.prepare(`SELECT category, amount_cve AS amountCve, reference_month AS rm FROM expenses ORDER BY id`).all() as Array<{ category: string; amountCve: number; rm: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.rm === '2026-05')).toBe(true);

    // 2nd call same month — nothing new.
    const second = runRecurringExpensesIfDue(now);
    expect('skipped' in second && second.skipped).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 2 });

    // Avançar para dia 21 — combustivel passa a ser elegível, e os outros já não duplicam.
    const later = runRecurringExpensesIfDue(new Date('2026-05-21T10:00:00Z'));
    expect('ran' in later && later.ran).toBe(true);
    if ('ran' in later) expect(later.generated).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 3 });

    // Mês seguinte — todos os 3 voltam a gerar.
    const nextMonth = runRecurringExpensesIfDue(new Date('2026-06-25T10:00:00Z'));
    expect('ran' in nextMonth && nextMonth.ran).toBe(true);
    if ('ran' in nextMonth) expect(nextMonth.generated).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 6 });
  });

  test('skips cleanly when there are no active templates', async () => {
    const { runRecurringExpensesIfDue } = await import('../lib/recurring-expenses');
    const result = runRecurringExpensesIfDue(new Date('2026-05-15T10:00:00Z'));
    expect('skipped' in result).toBe(true);
  });
});
