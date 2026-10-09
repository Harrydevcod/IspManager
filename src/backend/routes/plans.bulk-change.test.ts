import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

/**
 * As rotas da mudança em massa são finas: a lógica está provada em
 * `lib/plan-change.test.ts`, com um router em memória. Aqui prova-se o que só a
 * rota decide — validação do pedido e a recusa quando não há router para ler.
 */

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-bulk-change-test-'));
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
  db.prepare('DELETE FROM plan_change_batches').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM internet_plans').run();
  db.prepare(`DELETE FROM app_settings WHERE key LIKE 'routeros%'`).run();
  db.prepare(`INSERT INTO internet_plans (id, name, monthly_price_cve, router_profile, active) VALUES (1, 'Base 10', 2500, 'plano-10M', 1), (2, 'Mais 20', 3500, 'plano-20M', 1)`).run();
  db.prepare(`INSERT INTO clients (id, client_code, full_name) VALUES (1, 'C0001', 'Joao Silva')`).run();
  db.prepare(`INSERT INTO services (id, client_id, plan_id, monthly_value_cve, status, pppoe_username) VALUES (1, 1, 1, 2500, 'active', 'skn001')`).run();
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

const body = { serviceIds: [1], targetPlanId: 2 };

describe('mudança de plano em massa — rotas', () => {
  test('a pré-visualização responde mesmo sem router, com o bloqueio à vista', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/plans/bulk-change/preview', payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      toChange: 1,
      targetPlan: { id: 2, name: 'Mais 20' },
      blockers: ['Integração MikroTik desligada ou por configurar.'],
      rows: [{ serviceId: 1, clientName: 'Joao Silva', fromValueCve: 2500, toValueCve: 3500 }]
    });
  });

  test('sem router para ler, executar é recusado e nada muda', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/plans/bulk-change', payload: body });
    expect(response.statusCode).toBe(409);
    expect(response.json().blockers).toEqual(['Integração MikroTik desligada ou por configurar.']);
    expect(db.prepare('SELECT plan_id AS planId FROM services WHERE id = 1').get()).toEqual({ planId: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_change_batches').get()).toEqual({ n: 0 });
  });

  test('pedidos mal formados são recusados', async () => {
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
    expect((await post('/api/plans/bulk-change/preview', { serviceIds: [], targetPlanId: 2 })).statusCode).toBe(400);
    expect((await post('/api/plans/bulk-change', { ...body, dropMode: 'talvez' })).statusCode).toBe(400);
    expect((await post('/api/plans/bulk-change', { ...body, dropMode: 'scheduled', dropAt: 'às quatro' })).statusCode).toBe(400);
    expect((await post('/api/plans/bulk-change', { ...body, apagarTudo: true })).statusCode).toBe(400);
  });

  test('a lista de serviços diz a que ponto de acesso cada um está ligado', async () => {
    db.prepare(`INSERT INTO clients (id, client_code, full_name) VALUES (2, 'C0002', 'Ana Lopes')`).run();
    db.prepare(`INSERT INTO services (id, client_id, plan_id, monthly_value_cve, status) VALUES (2, 2, 1, 2500, 'active')`).run();
    const catalogId = Number(db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, stock_total) VALUES ('equipamento', 'antena', 'TP-Link', 'CPE-teste-setor', 5)
    `).run().lastInsertRowid);
    const assignmentId = Number(db.prepare(`
      INSERT INTO service_device_assignments (service_id, catalog_id, start_date) VALUES (1, ?, '2026-10-01')
    `).run(catalogId).lastInsertRowid);
    const backboneId = Number(db.prepare(`INSERT INTO backbone_devices (catalog_id, name) VALUES (?, 'Setor Norte')`).run(catalogId).lastInsertRowid);
    db.prepare('INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id) VALUES (?, ?)').run(backboneId, assignmentId);

    try {
      const services = (await app.inject('/api/services')).json() as Array<{ id: number; accessPoints: string | null }>;
      expect(services.map((service) => [service.id, service.accessPoints]).sort()).toEqual([[1, 'Setor Norte'], [2, null]]);

      // Uma ligação terminada já não conta: o cliente mudou de setor.
      db.prepare(`UPDATE backbone_assignment_links SET ended_at = datetime('now')`).run();
      const after = (await app.inject('/api/services')).json() as Array<{ id: number; accessPoints: string | null }>;
      expect(after.find((service) => service.id === 1)?.accessPoints).toBeNull();
    } finally {
      db.prepare('DELETE FROM backbone_assignment_links').run();
      db.prepare('DELETE FROM backbone_devices WHERE id = ?').run(backboneId);
      db.prepare('DELETE FROM service_device_assignments WHERE id = ?').run(assignmentId);
      db.prepare('DELETE FROM equipment_catalog WHERE id = ?').run(catalogId);
    }
  });

  test('histórico, detalhe e cancelamento de um lote', async () => {
    expect((await app.inject('/api/plans/bulk-change')).json()).toEqual([]);
    expect((await app.inject('/api/plans/bulk-change/99')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/plans/bulk-change/99/cancel' })).statusCode).toBe(404);

    db.prepare(`INSERT INTO plan_change_batches (id, target_plan_id, target_plan_name, status) VALUES (5, 2, 'Mais 20', 'running')`).run();
    db.prepare(`INSERT INTO plan_change_items (batch_id, service_id, client_name, from_value_cve, to_value_cve) VALUES (5, 1, 'Joao Silva', 2500, 3500)`).run();

    expect((await app.inject('/api/plans/bulk-change')).json()).toEqual([
      expect.objectContaining({ id: 5, targetPlanName: 'Mais 20', status: 'running', counts: expect.objectContaining({ queued: 1 }) })
    ]);
    expect((await app.inject('/api/plans/bulk-change/5')).json().items).toEqual([expect.objectContaining({ clientName: 'Joao Silva', status: 'queued' })]);
    expect((await app.inject({ method: 'POST', url: '/api/plans/bulk-change/5/cancel' })).json()).toEqual({ outcome: 'cancelling' });
    expect(db.prepare('SELECT cancel_requested AS flag FROM plan_change_batches WHERE id = 5').get()).toEqual({ flag: 1 });
  });
});
