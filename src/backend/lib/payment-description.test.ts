import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { describePaymentGroup, describePayments, describeReceipt } from './payment-description';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let clientId: number;
let serviceId: number;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-payment-description-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  for (const table of ['payment_receipts', 'payment_lines', 'payments', 'services', 'internet_plans', 'clients']) db.prepare(`DELETE FROM ${table}`).run();
  clientId = Number(db.prepare("INSERT INTO clients (client_code, full_name) VALUES ('C1', 'Ana')").run().lastInsertRowid);
  const planId = Number(db.prepare("INSERT INTO internet_plans (name, monthly_price_cve, download_mbps, upload_mbps) VALUES ('Standard', 2500, 20, 5)").run().lastInsertRowid);
  serviceId = Number(db.prepare("INSERT INTO services (client_id, plan_id, status, monthly_value_cve, due_day) VALUES (?, ?, 'active', 2500, 10)").run(clientId, planId).lastInsertRowid);
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

function invoice(reference: string, lines: Array<[string, string]>, extra: { service?: number | null; invoiceDate?: string } = {}) {
  const id = Number(db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number, invoice_date)
    VALUES (?, ?, ?, 2500, '2026-11-10', 'pending', ?, ?)`).run(clientId, extra.service === undefined ? serviceId : extra.service, reference, `FT ${reference}`, extra.invoiceDate ?? null).lastInsertRowid);
  lines.forEach(([kind, description], index) => db.prepare('INSERT INTO payment_lines (payment_id, kind, description, amount_cve, sort_order) VALUES (?, ?, ?, 100, ?)').run(id, kind, description, index));
  return id;
}

test('mensalidade com audiovisual e aluguer; fatura antiga sem linhas usa o plano', () => {
  const monthly = invoice('2026-10', [['internet', 'Servico de Internet'], ['audiovisual', 'Distribuição de Conteúdos Audiovisuais'], ['aluguer', 'Aluguer — Router']]);
  const legacy = invoice('2026-09', []);
  const out = describePayments(db, [monthly, legacy]);
  expect(out.get(monthly)).toEqual({ services: 'Internet Standard, Distribuição de Conteúdos Audiovisuais e aluguer de equipamento', period: 'outubro de 2026' });
  expect(out.get(legacy)).toEqual({ services: 'Internet Standard', period: 'setembro de 2026' });
});

test('instalação e fatura avulsa sem serviço: o mês da emissão, nunca "-"', () => {
  const install = invoice('INSTALACAO', [['instalacao', 'Instalacao']], { invoiceDate: '2026-03-04' });
  const manual = invoice('AVULSA-9', [['avulso', 'Cabo UTP 10 m']], { service: null, invoiceDate: '2026-07-02' });
  const out = describePayments(db, [install, manual]);
  expect(out.get(install)).toEqual({ services: 'instalação', period: 'março de 2026' });
  expect(out.get(manual)).toEqual({ services: 'Cabo UTP 10 m', period: 'julho de 2026' });
});

test('o recibo diz o valor recebido e cobre todas as faturas que liquidou', () => {
  const october = invoice('2026-10', [['internet', 'Servico de Internet']]);
  const november = invoice('2026-11', [['internet', 'Servico de Internet'], ['audiovisual', 'TV']]);
  const receipt = db.prepare(`INSERT INTO payment_receipts (payment_id, amount_cve, payment_date, payment_method, receipt_number, receipt_date)
    VALUES (?, ?, '2026-11-12', 'numerario', ?, '2026-11-12')`);
  receipt.run(october, 1000, 'RC 1');
  receipt.run(november, 2500, 'RC 1');
  expect(describeReceipt(db, 'RC 1')).toEqual({ amountCve: 3500, services: 'Internet Standard e TV', period: 'outubro e novembro de 2026' });
  expect(describeReceipt(db, 'RC 404')).toBeNull();
  expect(describePaymentGroup(db, [])).toEqual({ services: '', period: '' });
});
