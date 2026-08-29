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

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-reprice-test-'));
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
  db.prepare('DELETE FROM service_device_shares').run();
  db.prepare('DELETE FROM service_device_assignments').run();
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payment_lines').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM equipment_catalog').run();
  db.prepare('DELETE FROM internet_plans').run();
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

function seedPlan(monthlyPriceCve: number): number {
  return Number(db.prepare(`
    INSERT INTO internet_plans (name, monthly_price_cve, active) VALUES ('PLANO STANDART', ?, 1)
  `).run(monthlyPriceCve).lastInsertRowid);
}

function seedService(planId: number, name: string, monthlyCve: number, status = 'active'): number {
  const clientId = Number(db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')
  `).run(`C-${name}`, name).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO services (client_id, plan_id, status, monthly_value_cve, due_day)
    VALUES (?, ?, ?, ?, 10)
  `).run(clientId, planId, status, monthlyCve).lastInsertRowid);
}

function seedCatalog(model: string, rentalCve: number): number {
  return Number(db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, stock_total, rental_fee_cve)
    VALUES ('equipamento', 'antena', 'TP-Link', ?, 5, ?)
  `).run(model, rentalCve).lastInsertRowid);
}

function assign(serviceId: number, catalogId: number, rentalFeeCve: number, ownership = 'isp') {
  db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, start_date, ownership, rental_fee_cve)
    VALUES (?, ?, date('now'), ?, ?)
  `).run(serviceId, catalogId, ownership, rentalFeeCve);
}

function issueInvoice(serviceId: number, referenceMonth: string, amountCve: number) {
  const clientId = (db.prepare('SELECT client_id AS c FROM services WHERE id = ?')
    .get(serviceId) as { c: number }).c;
  db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
    VALUES (?, ?, ?, ?, date('now'), 'pending')
  `).run(clientId, serviceId, referenceMonth, amountCve);
}

/** Fatura com linhas — é assim que saem as mensalidades desde o audiovisual. */
function issueInvoiceWithLines(
  serviceId: number,
  referenceMonth: string,
  lines: Array<{ kind: string; amountCve: number }>
) {
  const clientId = (db.prepare('SELECT client_id AS c FROM services WHERE id = ?')
    .get(serviceId) as { c: number }).c;
  const total = lines.reduce((sum, line) => sum + line.amountCve, 0);
  const paymentId = Number(db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
    VALUES (?, ?, ?, ?, date('now'), 'pending')
  `).run(clientId, serviceId, referenceMonth, total).lastInsertRowid);
  lines.forEach((line, index) => {
    db.prepare(`
      INSERT INTO payment_lines (payment_id, kind, description, amount_cve, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(paymentId, line.kind, line.kind, line.amountCve, index);
  });
}

const preview = (planId: number) =>
  app.inject({ method: 'GET', url: `/api/plans/${planId}/reprice-preview` });

describe('GET /api/plans/:id/reprice-preview', () => {
  // O caso real do Chia: paga 3000, tem 250+500 de equipamento, passa a 3250.
  test('mostra o valor de hoje, o aluguer e o total novo por cliente', async () => {
    const planId = seedPlan(2500);
    const serviceId = seedService(planId, 'Chia', 3000);
    assign(serviceId, seedCatalog('MW325R', 250), 250);
    assign(serviceId, seedCatalog('TL-S5-5KM', 500), 500);
    issueInvoice(serviceId, '2026-07', 3000);

    const body = (await preview(planId)).json();
    expect(body.plan.monthlyPriceCve).toBe(2500);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      clientName: 'Chia',
      currentCve: 3000,
      rentalCve: 750,
      lastInvoiceCve: 3000,
      newTotalCve: 3250,
      deltaCve: 250,
      changed: true
    });
  });

  test('o caso que não muda nada: 3000 na última fatura = 2500 + 500 de aluguer', async () => {
    const planId = seedPlan(2500);
    const serviceId = seedService(planId, 'Helen', 3000);
    assign(serviceId, seedCatalog('CPE 510', 250), 250);
    assign(serviceId, seedCatalog('Archer C20', 250), 250);
    issueInvoice(serviceId, '2026-07', 3000);

    const row = (await preview(planId)).json().rows[0];
    expect(row.newTotalCve).toBe(3000);
    expect(row.lastInvoiceCve).toBe(3000);
    // A fatura fica igual, mas o valor guardado no serviço tem de mudar.
    expect(row.deltaCve).toBe(0);
    expect(row.changed).toBe(true);
  });

  // O caso do Anderson: paga 3500 = 3000 de internet + 500 de audiovisual. O
  // audiovisual continua a ser cobrado por cima depois do acerto, por isso
  // compará-lo com o total anunciava uma descida de 500 que não existe.
  test('o audiovisual da fatura não entra na comparação', async () => {
    const planId = seedPlan(2500);
    const serviceId = seedService(planId, 'Anderson', 3000);
    assign(serviceId, seedCatalog('CPE 510', 250), 250);
    assign(serviceId, seedCatalog('Archer C20', 250), 250);
    issueInvoiceWithLines(serviceId, '2026-07', [
      { kind: 'internet', amountCve: 3000 },
      { kind: 'audiovisual', amountCve: 500 }
    ]);

    const row = (await preview(planId)).json().rows[0];
    expect(row.lastInvoiceCve).toBe(3000);
    expect(row.newTotalCve).toBe(3000);
    expect(row.deltaCve).toBe(0);
  });

  test('fatura antiga sem linhas continua a servir de comparação', async () => {
    const planId = seedPlan(2500);
    const serviceId = seedService(planId, 'Maria', 2500);
    assign(serviceId, seedCatalog('MW325R', 250), 250);
    issueInvoice(serviceId, '2026-07', 2500);

    const row = (await preview(planId)).json().rows[0];
    expect(row.lastInvoiceCve).toBe(2500);
    expect(row.deltaCve).toBe(250);
  });

  test('a diferença mede-se contra a última mensalidade, não contra cobranças avulsas', async () => {
    const planId = seedPlan(2500);
    const serviceId = seedService(planId, 'Instalado', 3000);
    assign(serviceId, seedCatalog('CPE 510', 250), 250);
    issueInvoice(serviceId, '2026-07', 3000);
    // Taxa de instalação de 15.000$: não pode contaminar a comparação mensal.
    issueInvoice(serviceId, 'INSTALACAO', 15000);

    const row = (await preview(planId)).json().rows[0];
    expect(row.lastInvoiceCve).toBe(3000);
    expect(row.deltaCve).toBe(-250);
  });

  test('serviço ainda sem mensalidade emitida compara com o valor guardado', async () => {
    const planId = seedPlan(2500);
    seedService(planId, 'Novo', 3000);
    const row = (await preview(planId)).json().rows[0];
    expect(row.lastInvoiceCve).toBeNull();
    expect(row.deltaCve).toBe(-500);
  });

  test('equipamento do cliente não conta para o aluguer', async () => {
    const planId = seedPlan(2500);
    const serviceId = seedService(planId, 'Dono', 2500);
    assign(serviceId, seedCatalog('CPE 510', 250), 250, 'cliente');

    const row = (await preview(planId)).json().rows[0];
    expect(row.rentalCve).toBe(0);
    expect(row.newTotalCve).toBe(2500);
    expect(row.changed).toBe(false);
  });

  test('serviços cancelados e suspensos ficam de fora', async () => {
    const planId = seedPlan(2500);
    seedService(planId, 'Cancelado', 3000, 'cancelled');
    seedService(planId, 'Suspenso', 3000, 'suspended');
    expect((await preview(planId)).json().rows).toHaveLength(0);
  });

  test('plano inexistente responde 404', async () => {
    expect((await preview(9999)).statusCode).toBe(404);
  });
});

describe('POST /api/plans/:id/reprice', () => {
  test('aplica o preço só a quem está desalinhado', async () => {
    const planId = seedPlan(2500);
    const desalinhado = seedService(planId, 'Tres mil', 3000);
    const jaCerto = seedService(planId, 'Ja certo', 2500);

    const response = await app.inject({ method: 'POST', url: `/api/plans/${planId}/reprice` });
    expect(response.statusCode).toBe(200);
    expect(response.json().updated).toBe(1);

    const read = (id: number) => (db.prepare('SELECT monthly_value_cve AS v FROM services WHERE id = ?')
      .get(id) as { v: number }).v;
    expect(read(desalinhado)).toBe(2500);
    expect(read(jaCerto)).toBe(2500);
  });

  test('a pré-visualização e o que se aplica dizem a mesma coisa', async () => {
    const planId = seedPlan(2500);
    seedService(planId, 'A', 3000);
    seedService(planId, 'B', 3000);
    seedService(planId, 'C', 2500);

    const expected = (await preview(planId)).json().rows.filter((r: { changed: boolean }) => r.changed).length;
    const applied = (await app.inject({ method: 'POST', url: `/api/plans/${planId}/reprice` })).json().updated;
    expect(applied).toBe(expected);
  });

  test('correr duas vezes não muda nada da segunda', async () => {
    const planId = seedPlan(2500);
    seedService(planId, 'Unico', 3000);
    await app.inject({ method: 'POST', url: `/api/plans/${planId}/reprice` });
    const second = await app.inject({ method: 'POST', url: `/api/plans/${planId}/reprice` });
    expect(second.json().updated).toBe(0);
  });

  test('deixa rasto na auditoria com o antes e o depois', async () => {
    const planId = seedPlan(2500);
    seedService(planId, 'Auditado', 3000);
    await app.inject({ method: 'POST', url: `/api/plans/${planId}/reprice` });

    const row = db.prepare(`
      SELECT action, metadata_json AS metadata FROM audit_logs WHERE action = 'plan_reprice' ORDER BY id DESC LIMIT 1
    `).get() as { action: string; metadata: string } | undefined;
    expect(row).toBeTruthy();
    const metadata = JSON.parse(row!.metadata) as { services: Array<{ from: number; to: number }> };
    expect(metadata.services[0]).toMatchObject({ from: 3000, to: 2500 });
  });

  test('a faturação seguinte usa o valor novo mais o aluguer', async () => {
    const planId = seedPlan(2500);
    const serviceId = seedService(planId, 'Faturado', 3000);
    assign(serviceId, seedCatalog('MW325R', 250), 250);
    assign(serviceId, seedCatalog('TL-S5-5KM', 500), 500);

    await app.inject({ method: 'POST', url: `/api/plans/${planId}/reprice` });

    const { computeMonthlyBilling } = await import('../lib/billing');
    const row = computeMonthlyBilling(db, '2026-09').toCreate.find((r) => r.serviceId === serviceId)!;
    expect(row.amountCve).toBe(3250);
    expect(row.lines.map((l) => l.kind)).toEqual(['internet', 'aluguer', 'aluguer']);
  });
});
