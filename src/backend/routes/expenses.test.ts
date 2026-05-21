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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-expenses-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM expenses').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

describe('expenses CRUD', () => {
  test('creates, lists, updates and deletes an expense', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/expenses',
      payload: {
        category: 'banda_internet',
        description: 'Banda mensal Sotelco',
        amountCve: 85000,
        expenseDate: '2026-05-10',
        supplier: 'Sotelco',
        invoiceReference: 'FT-2026/142'
      }
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json() as { id: number };
    expect(id).toBeGreaterThan(0);

    const list = await app.inject({ method: 'GET', url: '/api/expenses' });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      rows: Array<{ id: number; category: string; amountCve: number; referenceMonth: string }>;
      totals: { count: number; totalCve: number; byCategory: Array<{ category: string; totalCve: number }> };
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].category).toBe('banda_internet');
    expect(body.rows[0].amountCve).toBe(85000);
    expect(body.rows[0].referenceMonth).toBe('2026-05');
    expect(body.totals.totalCve).toBe(85000);
    expect(body.totals.byCategory[0]).toMatchObject({ category: 'banda_internet', totalCve: 85000 });

    const update = await app.inject({
      method: 'PUT',
      url: `/api/expenses/${id}`,
      payload: {
        category: 'banda_internet',
        description: 'Banda mensal Sotelco (revisao)',
        amountCve: 92000,
        expenseDate: '2026-05-10',
        supplier: 'Sotelco'
      }
    });
    expect(update.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/expenses' });
    const afterBody = after.json() as { rows: Array<{ amountCve: number; description: string }> };
    expect(afterBody.rows[0].amountCve).toBe(92000);
    expect(afterBody.rows[0].description).toBe('Banda mensal Sotelco (revisao)');

    const del = await app.inject({ method: 'DELETE', url: `/api/expenses/${id}` });
    expect(del.statusCode).toBe(200);
    const empty = await app.inject({ method: 'GET', url: '/api/expenses' });
    expect((empty.json() as { rows: unknown[] }).rows).toHaveLength(0);
  });

  test('filters by reference month and category', async () => {
    const seed = [
      { category: 'salarios', description: 'Salarios Abril', amountCve: 250000, expenseDate: '2026-04-30' },
      { category: 'salarios', description: 'Salarios Maio', amountCve: 270000, expenseDate: '2026-05-31' },
      { category: 'marketing', description: 'Outdoor Praia', amountCve: 18000, expenseDate: '2026-05-12' }
    ];
    for (const payload of seed) {
      const r = await app.inject({ method: 'POST', url: '/api/expenses', payload });
      expect(r.statusCode).toBe(201);
    }

    const may = await app.inject({ method: 'GET', url: '/api/expenses?month=2026-05' });
    const mayBody = may.json() as { rows: Array<{ description: string }>; totals: { totalCve: number } };
    expect(mayBody.rows.map((r) => r.description).sort()).toEqual(['Outdoor Praia', 'Salarios Maio']);
    expect(mayBody.totals.totalCve).toBe(288000);

    const salarios = await app.inject({ method: 'GET', url: '/api/expenses?year=2026&category=salarios' });
    const salariosBody = salarios.json() as { rows: Array<{ description: string }>; totals: { totalCve: number } };
    expect(salariosBody.rows.map((r) => r.description).sort()).toEqual(['Salarios Abril', 'Salarios Maio']);
    expect(salariosBody.totals.totalCve).toBe(520000);
  });

  test('rejects invalid payload and missing ids', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/expenses',
      payload: { category: 'salarios', description: '', amountCve: -10, expenseDate: '2026-05-10' }
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PUT',
      url: '/api/expenses/9999',
      payload: { category: 'outros', description: 'x', amountCve: 1, expenseDate: '2026-05-10' }
    });
    expect(missing.statusCode).toBe(404);

    const badId = await app.inject({ method: 'DELETE', url: '/api/expenses/abc' });
    expect(badId.statusCode).toBe(400);
  });
});
