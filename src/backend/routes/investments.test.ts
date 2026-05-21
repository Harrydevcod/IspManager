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
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-investments-test-'));
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
  db.prepare('DELETE FROM investment_items').run();
  db.prepare('DELETE FROM investments').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM internet_plans').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

describe('investments CRUD', () => {
  test('creates, lists, updates and deletes an investment with calculated items', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/investments',
      payload: {
        name: 'Instalacao Achada Santo Antonio',
        type: 'zona',
        zone: 'Achada Santo Antonio',
        investmentDate: '2026-05-05',
        targetClients: 10,
        installedClients: 4,
        desiredPaybackMonths: 6,
        desiredMarginPct: 30,
        expectedMonthlyRevenueCve: 18000,
        monthlyOperationalCostCve: 3000,
        accumulatedRevenueCve: 9000,
        items: [
          { itemType: 'router', itemName: 'Router principal', quantity: 2, quantityUsed: 1, unitCostCve: 5000 },
          { itemType: 'cabo', itemName: 'Cabo UTP', quantity: 40, quantityUsed: 12, unitCostCve: 75 }
        ]
      }
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as number;

    const listMonth = await app.inject({ method: 'GET', url: '/api/investments?month=2026-05' });
    expect(listMonth.statusCode).toBe(200);
    const body = listMonth.json();
    expect(body.rows).toHaveLength(1);
    expect(body.totals.totalCostCve).toBe(13000);
    expect(body.rows[0]).toMatchObject({
      name: 'Instalacao Achada Santo Antonio',
      zone: 'Achada Santo Antonio',
      totalCostCve: 13000,
      expectedMonthlyRevenueCve: 18000,
      monthlyNetProfitCve: 15000,
      costPerClientCve: 1300
    });
    expect(body.rows[0].items).toHaveLength(2);
    expect(body.rows[0].items[1].quantityRemaining).toBe(28);
    expect(body.rows[0].recommendedPlanCve).toBeCloseTo(1256.67, 2);
    expect(body.rows[0].roiPct).toBeCloseTo(-30.769, 2);
    expect(body.rows[0].annualRoiPct).toBeCloseTo(1284.615, 2);

    const update = await app.inject({
      method: 'PUT',
      url: `/api/investments/${id}`,
      payload: {
        name: 'Cliente empresarial Palmarejo',
        type: 'cliente',
        zone: 'Palmarejo',
        investmentDate: '2026-05-07',
        status: 'ativo',
        expectedMonthlyRevenueCve: 10000,
        items: [
          { itemType: 'cpe', itemName: 'CPE 5GHz', quantity: 1, unitCostCve: 7000 },
          { itemType: 'mao_obra', itemName: 'Instalacao tecnica', quantity: 1, unitCostCve: 2500 }
        ]
      }
    });
    expect(update.statusCode).toBe(200);

    const after = db.prepare('SELECT name, total_cost_cve AS totalCostCve FROM investments WHERE id = ?')
      .get(id) as { name: string; totalCostCve: number };
    expect(after).toEqual({ name: 'Cliente empresarial Palmarejo', totalCostCve: 9500 });

    const remove = await app.inject({ method: 'DELETE', url: `/api/investments/${id}` });
    expect(remove.statusCode).toBe(200);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM investments').get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  test('filters by month, type and zone', async () => {
    db.prepare(`INSERT INTO investments (name, type, zone, investment_date, reference_month, total_cost_cve)
                VALUES ('Zona Mar', 'zona', 'Vila Nova', '2026-03-01', '2026-03', 10)`).run();
    db.prepare(`INSERT INTO investments (name, type, zone, investment_date, reference_month, total_cost_cve)
                VALUES ('CPE Mar', 'equipamento', 'Vila Nova', '2026-03-15', '2026-03', 20)`).run();
    db.prepare(`INSERT INTO investments (name, type, zone, investment_date, reference_month, total_cost_cve)
                VALUES ('Zona Abr', 'zona', 'Palmarejo', '2026-04-01', '2026-04', 30)`).run();

    const march = await app.inject({ method: 'GET', url: '/api/investments?month=2026-03' });
    expect(march.json().rows).toHaveLength(2);

    const marchZone = await app.inject({ method: 'GET', url: '/api/investments?month=2026-03&type=zona&zone=Vila%20Nova' });
    expect(marchZone.json().rows).toHaveLength(1);
    expect(marchZone.json().totals.totalCostCve).toBe(10);
  });

  test('dashboard summary aggregates investment cost per month', async () => {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, total_cost_cve)
                VALUES ('Backbone corrente', 'infraestrutura', ?, ?, 15000)`).run(`${currentMonth}-01`, currentMonth);
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, total_cost_cve)
                VALUES ('Instalacao corrente', 'cliente', ?, ?, 5000)`).run(`${currentMonth}-02`, currentMonth);

    const response = await app.inject({ method: 'GET', url: '/api/dashboard/summary' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const currentPoint = body.revenueByMonth.find(
      (p: { referenceMonth: string }) => p.referenceMonth === currentMonth
    );
    expect(currentPoint).toBeDefined();
    expect(currentPoint.expenseCve).toBe(20000);
  });
});
