/**
 * Ficha financeira do cliente e acordo de pagamento (0103), do lado HTTP.
 *
 * O que importa provar: a ficha conta o mesmo que a carteira, e um acordo em dia tira as faturas
 * do corte automático e dos avisos — e devolve-as sozinho quando uma prestação fica por pagar.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { businessDay } from '../../shared/business-day';
import { monthlyDueDates, splitInstallments } from '../../shared/payment-plan';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let loadOverdueCandidates: (window: number) => Array<{ paymentId: number }>;
let loadAutoSuspensionPreview: (db: Database.Database) => { candidates: Array<{ paymentId: number }> };

const FUTURE = monthlyDueDates(businessDay(), 2)[1];
const YESTERDAY = businessDay(Date.now() - 86_400_000);

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-client-finance-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');
  ({ loadOverdueCandidates } = await import('../lib/notices'));
  ({ loadAutoSuspensionPreview } = await import('../lib/auto-suspension'));

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.exec(`
    DELETE FROM payment_plan_installments;
    DELETE FROM payment_plan_invoices;
    DELETE FROM payment_plans;
    DELETE FROM whatsapp_notices;
    DELETE FROM sms_outbox;
    DELETE FROM audit_logs;
    DELETE FROM client_credits;
    DELETE FROM treasury_movements;
    DELETE FROM payment_receipts;
    DELETE FROM payment_lines;
    DELETE FROM payments;
    DELETE FROM services;
    DELETE FROM clients;
  `);
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

/** Cliente com serviço PPPoE ativo e duas faturas vencidas há meses (cortáveis). */
function seed(code = 'CLT-F1'): { clientId: number; serviceId: number; invoices: number[] } {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, phone, status) VALUES (?, 'Cliente Ficha', ?, 'active')
  `).run(code, code === 'CLT-B' ? '9912346' : '9912345').lastInsertRowid as number;
  const serviceId = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status, pppoe_username) VALUES (?, 2500, 10, 'active', ?)
  `).run(clientId, `pppoe-${code}`).lastInsertRowid as number;
  const invoice = db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number, invoice_date)
    VALUES (?, ?, ?, 2500, ?, 'pending', ?, ?)
  `);
  const invoices = [
    invoice.run(clientId, serviceId, '2026-07', '2026-07-10', `FT-${code}-7`, '2026-07-01').lastInsertRowid as number,
    invoice.run(clientId, serviceId, '2026-08', '2026-08-10', `FT-${code}-8`, '2026-08-01').lastInsertRowid as number
  ];
  return { clientId, serviceId, invoices };
}

const pay = (paymentId: number, amountCve: number) =>
  app.inject({ method: 'POST', url: `/api/payments/${paymentId}/pay`, payload: { paymentMethod: 'numerario', amountCve } });

const createPlan = (clientId: number, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/clients/${clientId}/payment-plans`, payload: body });

const finance = async (clientId: number) =>
  (await app.inject({ method: 'GET', url: `/api/clients/${clientId}/finance` })).json();

const suspendable = () => loadAutoSuspensionPreview(db).candidates.map((c) => c.paymentId);
const noticed = () => loadOverdueCandidates(3).map((c) => c.paymentId);

describe('prestações', () => {
  test('escudos inteiros e a última fecha o total ao centavo', () => {
    expect(splitInstallments(1000.5, 3)).toEqual([333, 333, 334.5]);
    expect(splitInstallments(5000, 4)).toEqual([1250, 1250, 1250, 1250]);
  });

  test('mesmo dia do mês; mês curto fica no último dia', () => {
    expect(monthlyDueDates('2027-01-31', 3)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
    expect(monthlyDueDates('2026-12-15', 2)).toEqual(['2026-12-15', '2027-01-15']);
  });
});

describe('GET /api/clients/:id/finance', () => {
  test('dívida, faturas, recibos e avisos de WhatsApp e SMS numa só ficha', async () => {
    const { clientId, invoices } = seed();
    expect((await pay(invoices[0], 1000)).statusCode).toBe(200);
    db.prepare(`
      INSERT INTO whatsapp_notices (payment_id, client_id, notice_type, origin, phone, body, sent_at)
      VALUES (?, ?, 'overdue', 'auto', '9912345', 'x', '2026-08-12 10:00:00')
    `).run(invoices[0], clientId);
    db.prepare(`
      INSERT INTO sms_outbox (client_id, payment_id, event_type, to_phone, body, status, sent_at)
      VALUES (?, ?, 'payment_overdue', '9912345', 'x', 'sent', '2026-08-20 10:00:00')
    `).run(clientId, invoices[1]);
    db.prepare(`
      INSERT INTO sms_outbox (client_id, event_type, to_phone, body) VALUES (?, 'test', '9912345', 'x')
    `).run(clientId);

    const body = await finance(clientId);

    expect(body.summary).toMatchObject({ openCve: 4000, overdueCve: 4000, overdueInvoices: 2, creditCve: 0, lastPaymentCve: 1000 });
    expect(body.invoices.map((i: { balanceCve: number }) => i.balanceCve)).toEqual([1500, 2500]);
    expect(body.receipts).toHaveLength(1);
    expect(body.notices.map((n: { channel: string }) => n.channel)).toEqual(['sms', 'whatsapp']);
    expect(body.plans).toEqual([]);
  });

  test('cliente inexistente é 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/clients/999999/finance' })).statusCode).toBe(404);
  });
});

describe('acordo de pagamento', () => {
  test('em dia protege do corte e dos avisos; prestação por pagar devolve-as ao funil', async () => {
    const { clientId, invoices } = seed();
    expect(suspendable()).toContain(invoices[0]);
    expect(noticed()).toEqual(expect.arrayContaining(invoices));

    const response = await createPlan(clientId, { paymentIds: invoices, installments: 2, firstDueDate: FUTURE, notes: 'Combinado ao balcão' });
    expect(response.statusCode).toBe(201);
    const plan = response.json();
    expect(plan).toMatchObject({ totalCve: 5000, paidCve: 0, status: 'em_dia' });
    expect(plan.installments.map((i: { amountCve: number }) => i.amountCve)).toEqual([2500, 2500]);
    expect(db.prepare(`SELECT action FROM audit_logs WHERE entity_type = 'payment_plan'`).get()).toEqual({ action: 'payment_plan_create' });

    expect(suspendable()).toEqual([]);
    expect(noticed()).toEqual([]);
    expect((await finance(clientId)).invoices.every((i: { planId: number }) => i.planId === plan.id)).toBe(true);

    // A 1.ª prestação venceu ontem e nada foi pago: o acordo cai em atraso e a proteção sai.
    db.prepare('UPDATE payment_plan_installments SET due_date = ? WHERE plan_id = ? AND seq = 1').run(YESTERDAY, plan.id);
    const late = (await finance(clientId)).plans[0];
    expect(late).toMatchObject({ status: 'em_atraso', arrearsCve: 2500 });
    expect(late.installments[0].status).toBe('em_atraso');
    expect(suspendable()).toContain(invoices[0]);

    // Pagar a prestação (em qualquer fatura do acordo) volta a pô-lo em dia.
    expect((await pay(invoices[1], 2500)).statusCode).toBe(200);
    const back = (await finance(clientId)).plans[0];
    expect(back).toMatchObject({ status: 'em_dia', paidCve: 2500, remainingCve: 2500 });
    expect(back.installments.map((i: { status: string }) => i.status)).toEqual(['paga', 'por_pagar']);
    expect(suspendable()).toEqual([]);

    expect((await pay(invoices[0], 2500)).statusCode).toBe(200);
    expect((await finance(clientId)).plans[0].status).toBe('cumprido');
  });

  test('recusa fatura de outro cliente, fatura já num acordo e data no passado', async () => {
    const a = seed('CLT-A');
    const b = seed('CLT-B');

    expect((await createPlan(a.clientId, { paymentIds: [b.invoices[0]], installments: 2, firstDueDate: FUTURE })).statusCode).toBe(400);
    expect((await createPlan(a.clientId, { paymentIds: a.invoices, installments: 2, firstDueDate: YESTERDAY })).statusCode).toBe(400);
    expect((await createPlan(a.clientId, { paymentIds: a.invoices, installments: 13, firstDueDate: FUTURE })).statusCode).toBe(400);
    expect((await createPlan(a.clientId, { paymentIds: [a.invoices[0]], installments: 2, firstDueDate: FUTURE })).statusCode).toBe(201);
    expect((await createPlan(a.clientId, { paymentIds: a.invoices, installments: 2, firstDueDate: FUTURE })).statusCode).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM payment_plans').get()).toEqual({ n: 1 });
  });

  test('cancelar exige motivo, devolve as faturas ao funil e só acontece uma vez', async () => {
    const { clientId, invoices } = seed();
    const plan = (await createPlan(clientId, { paymentIds: invoices, installments: 3, firstDueDate: FUTURE })).json();
    const cancel = (body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/payment-plans/${plan.id}/cancel`, payload: body });

    expect((await cancel({})).statusCode).toBe(400);
    const response = await cancel({ reason: 'Cliente deixou de responder' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'cancelado', cancelReason: 'Cliente deixou de responder' });
    expect(suspendable()).toContain(invoices[0]);
    expect((await cancel({ reason: 'outra vez' })).statusCode).toBe(409);

    // Cancelado, as faturas podem entrar num acordo novo.
    expect((await createPlan(clientId, { paymentIds: invoices, installments: 2, firstDueDate: FUTURE })).statusCode).toBe(201);
  });
});
