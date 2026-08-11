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
let loadOperationsStatus: typeof import('./operations-status').loadOperationsStatus;

const TABLES_TO_CLEAR = [
  'whatsapp_notices',
  'whatsapp_outbox',
  'sms_outbox',
  'audit_logs',
  'service_events',
  'work_orders',
  'backbone_assignment_links',
  'backbone_links',
  'backbone_devices',
  'service_device_shares',
  'service_device_assignments',
  'payments',
  'services',
  'internet_plans',
  'stock_movements',
  'equipment_catalog',
  'app_settings',
  'clients'
];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-operations-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');
  const operations = await import('./operations-status');

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  loadOperationsStatus = operations.loadOperationsStatus;
});

beforeEach(() => {
  for (const table of TABLES_TO_CLEAR) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

// ------------------------------------------------------------- fixtures

function insertClient(code: string, name: string, opts: { zone?: string; status?: string; nif?: string; phone?: string } = {}): number {
  db.prepare(`
    INSERT INTO clients (client_code, full_name, zone, status, nif, phone)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(code, name, opts.zone ?? null, opts.status ?? 'active', opts.nif ?? null, opts.phone ?? null);
  return Number((db.prepare(`SELECT id FROM clients WHERE client_code = ?`).get(code) as { id: number }).id);
}

function insertPlan(name: string, priceCve: number): number {
  db.prepare(`
    INSERT INTO internet_plans (name, connection_type, monthly_price_cve, active)
    VALUES (?, 'radio', ?, 1)
  `).run(name, priceCve);
  return Number((db.prepare(`SELECT id FROM internet_plans WHERE name = ?`).get(name) as { id: number }).id);
}

function insertService(clientId: number, planId: number, monthlyCve: number, status = 'active'): number {
  const result = db.prepare(`
    INSERT INTO services (client_id, plan_id, monthly_value_cve, due_day, status)
    VALUES (?, ?, ?, 30, ?)
  `).run(clientId, planId, monthlyCve, status);
  return Number(result.lastInsertRowid);
}

function insertCatalog(model: string, stock: number, type = 'cpe'): number {
  const result = db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, stock_total, active)
    VALUES ('equipamento', ?, 'TP-Link', ?, ?, 1)
  `).run(type, model, stock);
  return Number(result.lastInsertRowid);
}

function insertBackbone(name: string, catalogId: number, ip: string | null = null): number {
  const result = db.prepare(`
    INSERT INTO backbone_devices (catalog_id, name, ip_address, status, provisional)
    VALUES (?, ?, ?, 'active', 0)
  `).run(catalogId, name, ip);
  return Number(result.lastInsertRowid);
}

/** Liga um serviço a um backbone através de uma atribuição de equipamento. */
function attachServiceToBackbone(serviceId: number, catalogId: number, backboneId: number): void {
  const assignment = db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, start_date)
    VALUES (?, ?, date('now'))
  `).run(serviceId, catalogId);
  db.prepare(`
    INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id, started_at)
    VALUES (?, ?, datetime('now'))
  `).run(backboneId, Number(assignment.lastInsertRowid));
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- testes

describe('loadOperationsStatus', () => {
  test('base vazia devolve um estado coerente em vez de rebentar', () => {
    const status = loadOperationsStatus(db);

    expect(status.customers.active).toBe(0);
    expect(status.customers.mrrCve).toBe(0);
    expect(status.customers.arpuCve).toBe(0);
    expect(status.network.devices).toEqual([]);
    expect(status.billing.wallet.overdueCve).toBe(0);
    expect(status.period.from < status.period.to).toBe(true);
    expect(['green', 'amber', 'red']).toContain(status.severity);
  });

  test('MRR e ARPU somam mensalidade e audiovisual apenas de serviços ativos', () => {
    const plan = insertPlan('Standard', 3000);
    const a = insertClient('C001', 'Ana');
    const b = insertClient('C002', 'Bruno');
    const c = insertClient('C003', 'Carla');
    insertService(a, plan, 3000);
    const serviceB = insertService(b, plan, 3000);
    insertService(c, plan, 3000, 'cancelled');
    db.prepare(`UPDATE services SET audiovisual_monthly_cve = 500 WHERE id = ?`).run(serviceB);

    const status = loadOperationsStatus(db);

    expect(status.customers.activeServices).toBe(2);
    expect(status.customers.mrrCve).toBe(6500);
    expect(status.customers.arpuCve).toBe(3250);
  });

  test('conta o MRR uma vez por serviço mesmo com vários equipamentos no mesmo backbone', () => {
    const plan = insertPlan('Standard', 3000);
    const client = insertClient('C010', 'Duarte');
    const service = insertService(client, plan, 3000);
    const cpe = insertCatalog('CPE 510', 5);
    const router = insertCatalog('Archer C20', 5, 'router');
    const backbone = insertBackbone('Antena Norte', cpe, '10.0.0.1');
    attachServiceToBackbone(service, cpe, backbone);
    attachServiceToBackbone(service, router, backbone);

    const status = loadOperationsStatus(db);
    const device = status.network.devices.find((row) => row.name === 'Antena Norte');

    expect(device?.serviceCount).toBe(1);
    expect(device?.clientCount).toBe(1);
    expect(device?.mrrCve).toBe(3000);
  });

  test('marca o equipamento sem uplink como ponto único quando concentra a receita', () => {
    const plan = insertPlan('Standard', 3000);
    const catalog = insertCatalog('CPE 510', 5);
    const root = insertBackbone('Uplink principal', catalog, '10.0.0.1');
    for (let i = 0; i < 3; i++) {
      const client = insertClient(`C10${i}`, `Cliente ${i}`);
      attachServiceToBackbone(insertService(client, plan, 3000), catalog, root);
    }

    const status = loadOperationsStatus(db);

    expect(status.network.rootDevices).toHaveLength(1);
    expect(status.network.rootDevices[0].mrrShare).toBeCloseTo(1, 5);
    expect(status.network.findings.map((finding) => finding.code)).toContain('network.single-uplink');
    expect(status.risks.map((risk) => risk.code)).toContain('R-UPLINK');
  });

  test('lista serviços ativos sem ligação a backbone', () => {
    const plan = insertPlan('Standard', 3000);
    const client = insertClient('C020', 'Orfao');
    insertService(client, plan, 3000);

    const status = loadOperationsStatus(db);

    expect(status.network.servicesWithoutBackbone).toHaveLength(1);
    expect(status.network.servicesWithoutBackbone[0].clientName).toBe('Orfao');
    expect(status.actions.map((action) => action.code)).toContain('A-TOPOLOGIA');
  });

  test('agrega devedores por cliente e escala a severidade com os dias de atraso', () => {
    const plan = insertPlan('Standard', 3000);
    const client = insertClient('C030', 'Devedor', { phone: '9990000' });
    // Um título por serviço/mês é UNIQUE no schema: dois títulos em atraso do
    // mesmo cliente vêm de meses diferentes, como acontece na realidade.
    const service = insertService(client, plan, 3000);
    for (const [month, days] of [['2026-01', 45], ['2026-02', 40]] as const) {
      db.prepare(`
        INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
        VALUES (?, ?, ?, 3000, ?, 'overdue')
      `).run(client, service, month, daysAgo(days));
    }

    const status = loadOperationsStatus(db);

    expect(status.billing.debtors).toHaveLength(1);
    expect(status.billing.debtors[0].payments).toBe(2);
    expect(status.billing.debtors[0].amountCve).toBe(6000);
    expect(status.billing.debtors[0].maxDaysOverdue).toBeGreaterThanOrEqual(44);
    expect(status.billing.findings.map((finding) => finding.code)).toContain('billing.critical-overdue');
    expect(status.severity).toBe('red');
  });

  test('nao conta como vencido o que ainda nao chegou a data', () => {
    const plan = insertPlan('Standard', 3000);
    const client = insertClient('C040', 'Em dia');
    const service = insertService(client, plan, 3000);
    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, '2026-02', 3000, ?, 'pending')
    `).run(client, service, daysAgo(-5));

    const status = loadOperationsStatus(db);

    expect(status.billing.wallet.overdueCve).toBe(0);
    expect(status.billing.wallet.pendingNotDueCve).toBe(3000);
    expect(status.billing.debtors).toHaveLength(0);
  });

  test('a taxa de cobranca por ciclo ignora titulos anulados', () => {
    const plan = insertPlan('Standard', 3000);
    const client = insertClient('C050', 'Ciclo');
    // Três títulos do mesmo mês exigem três serviços: o par (serviço, mês) é UNIQUE.
    const paid = insertService(client, plan, 3000);
    const pending = insertService(client, plan, 3000);
    const cancelled = insertService(client, plan, 3000);
    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
      VALUES (?, ?, '2026-03', 3000, '2026-03-30', '2026-03-30', 'paid')
    `).run(client, paid);
    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, '2026-03', 3000, '2026-03-30', 'pending')
    `).run(client, pending);
    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, '2026-03', 9000, '2026-03-30', 'cancelled')
    `).run(client, cancelled);

    const cycle = loadOperationsStatus(db).billing.collection.find((row) => row.referenceMonth === '2026-03');

    expect(cycle?.issuedCve).toBe(6000);
    expect(cycle?.collectedCve).toBe(3000);
    expect(cycle?.rate).toBeCloseTo(0.5, 5);
  });

  test('erro de subscricao do provedor bloqueia o canal e exige alternativa', () => {
    db.prepare(`
      INSERT INTO whatsapp_outbox (to_phone, kind, body, status, attempts, last_error)
      VALUES ('+2389990000', 'text', 'ola', 'failed', 5, 'Your instance has been Stopped due to non-payment.')
    `).run();

    const status = loadOperationsStatus(db);

    expect(status.messaging.whatsapp.providerBlocked).toBe(true);
    expect(status.messaging.findings.map((finding) => finding.code)).toContain('messaging.provider-blocked');
    expect(status.messaging.findings.map((finding) => finding.code)).toContain('messaging.no-fallback');
    expect(status.actions.map((action) => action.code)).toContain('A-CANAL');
    expect(status.severity).toBe('red');
  });

  test('uma falha transitoria nao e tratada como bloqueio de provedor', () => {
    db.prepare(`
      INSERT INTO whatsapp_outbox (to_phone, kind, body, status, attempts, last_error)
      VALUES ('+2389990001', 'text', 'ola', 'failed', 1, 'fetch failed')
    `).run();

    const status = loadOperationsStatus(db);

    expect(status.messaging.whatsapp.providerBlocked).toBe(false);
    expect(status.messaging.findings.map((finding) => finding.code)).toContain('messaging.failures');
    expect(status.messaging.findings.map((finding) => finding.code)).not.toContain('messaging.no-fallback');
  });

  test('so assinala falta de reserva no que ja esta instalado', () => {
    insertCatalog('Modelo sem uso', 0, 'router');
    const deployed = insertCatalog('Modelo em campo', 0);
    const plan = insertPlan('Standard', 3000);
    const client = insertClient('C060', 'Instalado');
    const service = insertService(client, plan, 3000);
    db.prepare(`
      INSERT INTO service_device_assignments (service_id, catalog_id, start_date)
      VALUES (?, ?, date('now'))
    `).run(service, deployed);

    const status = loadOperationsStatus(db);
    const idle = status.fleet.models.find((model) => model.label.includes('sem uso'));
    const inField = status.fleet.models.find((model) => model.label.includes('em campo'));

    expect(idle?.severity).toBe('green');
    expect(inField?.severity).toBe('red');
    expect(status.fleet.findings.map((finding) => finding.code)).toContain('fleet.no-spare');
  });

  test('quantifica o acerto de tarifa dos servicos abaixo do preco de tabela', () => {
    const plan = insertPlan('Standard', 3000);
    const a = insertClient('C070', 'Antigo A');
    const b = insertClient('C071', 'Antigo B');
    const c = insertClient('C072', 'Atual');
    insertService(a, plan, 2500);
    insertService(b, plan, 2500);
    insertService(c, plan, 3000);

    const status = loadOperationsStatus(db);

    expect(status.customers.belowPlanPrice.services).toBe(2);
    expect(status.customers.belowPlanPrice.upliftCve).toBe(1000);
    expect(status.actions.find((action) => action.code === 'A-TARIFA')?.upsideCve).toBe(1000);
  });

  test('regista a divida deixada por clientes ja cancelados', () => {
    const plan = insertPlan('Standard', 3000);
    const client = insertClient('C080', 'Saiu', { status: 'cancelled' });
    const service = insertService(client, plan, 3000, 'cancelled');
    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, '2026-01', 2500, ?, 'overdue')
    `).run(client, service, daysAgo(60));

    const status = loadOperationsStatus(db);

    expect(status.customers.cancelledDebtCve).toBe(2500);
    expect(status.billing.debtors[0].clientCancelled).toBe(true);
    expect(status.actions.map((action) => action.code)).toContain('A-DIVIDA-MORTA');
  });

  test('registado hoje vem da auditoria, nao da data-valor do pagamento', () => {
    const plan = insertPlan('Standard', 3000);
    const client = insertClient('C090', 'Recibo');
    const service = insertService(client, plan, 3000);
    const payment = db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, payment_date, status)
      VALUES (?, ?, '2026-06', 3000, '2026-06-30', ?, 'paid')
    `).run(client, service, daysAgo(20));
    db.prepare(`
      INSERT INTO audit_logs (actor_username, action, entity_type, entity_id, summary)
      VALUES ('admin', 'pay', 'payment', ?, 'Marcou pagamento como pago')
    `).run(String(payment.lastInsertRowid));

    const status = loadOperationsStatus(db);

    expect(status.billing.registeredTodayCount).toBe(1);
    expect(status.billing.registeredTodayCve).toBe(3000);
    // A data-valor tem 20 dias, logo fica fora da janela semanal.
    expect(status.billing.receivedThisWeekCve).toBe(0);
  });

  test('riscos e acoes desaparecem quando o problema deixa de existir', () => {
    const plan = insertPlan('Standard', 3000);
    const client = insertClient('C100', 'Regularizado', { phone: '9990001', nif: '123456789' });
    const service = insertService(client, plan, 3000);
    db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status)
      VALUES (?, ?, '2026-01', 3000, ?, 'overdue')
    `).run(client, service, daysAgo(50));

    expect(loadOperationsStatus(db).actions.map((action) => action.code)).toContain('A-COBRAR');

    db.prepare(`UPDATE payments SET status = 'paid', payment_date = date('now')`).run();

    expect(loadOperationsStatus(db).actions.map((action) => action.code)).not.toContain('A-COBRAR');
  });
});

describe('GET /api/reports/operations', () => {
  test('devolve o estado com o mesmo contrato do read model', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/reports/operations' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('severity');
    expect(body).toHaveProperty('headline');
    expect(body).toHaveProperty('network.devices');
    expect(body).toHaveProperty('billing.wallet');
    expect(Array.isArray(body.risks)).toBe(true);
    expect(Array.isArray(body.actions)).toBe(true);
  });

  test('exporta o PDF mensal com o nome do periodo', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/reports/operations.pdf' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(String(response.headers['content-disposition'])).toContain('Estado da operacao');
    expect(response.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });
});
