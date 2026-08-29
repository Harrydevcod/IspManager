/**
 * A fronteira entre rascunho de cobrança e documento emitido.
 *
 * O `invoice_number` é atribuído na geração da mensalidade, não na impressão
 * do PDF: uma mensalidade gerada já é um documento. Reverter apaga a linha,
 * por isso reverter um documento numerado apagaria o número e deixaria um
 * salto na sequência sem rasto. Documento numerado anula-se e fica.
 *
 * Em todos os casos recusados, o teste confirma que a linha continua lá — é
 * essa a asserção que interessa numa regra fiscal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let payments: typeof import('./payments');

const MONTH = '2026-07';

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-payments-test-'));
  process.env.ISPM_DATA_DIR = dataDir;

  const database = await import('../db/database');
  database.getDatabase(); // corre as migrações
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  payments = await import('./payments');
});

beforeEach(() => {
  // Filhos primeiro: creditos → recibos → linhas → payments → services/clients.
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payment_lines').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

/** Uma cobrança do mês, com ou sem número de fatura atribuído. */
function seedPayment(
  code: string,
  { invoiceNumber = null as string | null, status = 'pending' as string, amountCve = 2500 } = {}
): number {
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')
  `).run(code, `Cliente ${code}`).lastInsertRowid as number;

  const serviceId = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status)
    VALUES (?, ?, 10, 'active')
  `).run(clientId, amountCve).lastInsertRowid as number;

  return db.prepare(`
    INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(clientId, serviceId, MONTH, amountCve, `${MONTH}-10`, status, invoiceNumber).lastInsertRowid as number;
}

const exists = (id: number) =>
  Boolean(db.prepare('SELECT 1 FROM payments WHERE id = ?').get(id));

const statusOf = (id: number) =>
  (db.prepare('SELECT status FROM payments WHERE id = ?').get(id) as { status: string }).status;

describe('revertPayment', () => {
  test('apaga uma cobrança que nunca chegou a ser documento', () => {
    const id = seedPayment('A');

    const result = payments.revertPayment(db, id);

    expect(result.ok).toBe(true);
    expect(exists(id)).toBe(false);
  });

  test('recusa reverter uma cobrança com fatura emitida, e a linha fica', () => {
    const id = seedPayment('B', { invoiceNumber: 'FT-2026-00042' });

    const result = payments.revertPayment(db, id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain('FT-2026-00042');
      expect(result.error).toContain('anular');
    }
    expect(exists(id)).toBe(true);
  });

  test('continua a recusar uma cobrança paga', () => {
    const id = seedPayment('C', { status: 'paid' });

    const result = payments.revertPayment(db, id);

    expect(result.ok).toBe(false);
    expect(exists(id)).toBe(true);
  });
});

describe('previewReverseMonthly', () => {
  test('separa o que é documento do que ainda não é', () => {
    const semNumero = seedPayment('D');
    const comNumero = seedPayment('E', { invoiceNumber: 'FT-2026-00043' });

    const preview = payments.previewReverseMonthly(db, MONTH);

    expect(preview.eligible.map((r) => r.id)).toEqual([semNumero]);
    expect(preview.eligibleCount).toBe(1);
    expect(preview.invoicedLocked.map((r) => r.id)).toEqual([comNumero]);
    expect(preview.invoicedLockedCount).toBe(1);
    // O total a apagar não pode contar o que fica.
    expect(preview.totalCve).toBe(2500);
  });
});

describe('executeReverseMonthly', () => {
  test('apaga só o que não tem número, e o documento sobrevive', () => {
    const semNumero = seedPayment('F');
    const comNumero = seedPayment('G', { invoiceNumber: 'FT-2026-00044' });

    const result = payments.executeReverseMonthly(db, MONTH);

    expect(result.reversed).toBe(1);
    expect(result.invoicedKept).toBe(1);
    expect(exists(semNumero)).toBe(false);
    expect(exists(comNumero)).toBe(true);
  });

  test('um mês só com documentos não apaga nada', () => {
    const a = seedPayment('H', { invoiceNumber: 'FT-2026-00045' });
    const b = seedPayment('I', { invoiceNumber: 'FT-2026-00046' });

    const result = payments.executeReverseMonthly(db, MONTH);

    expect(result.reversed).toBe(0);
    expect(exists(a)).toBe(true);
    expect(exists(b)).toBe(true);
  });
});

describe('cancelPayment — a saída para um documento numerado', () => {
  test('anular uma fatura sem motivo é recusado', () => {
    const id = seedPayment('J', { invoiceNumber: 'FT-2026-00047' });

    const result = payments.cancelPayment(db, id, 'curto');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('FT-2026-00047');
    expect(statusOf(id)).toBe('pending');
  });

  test('anular uma fatura com motivo detalhado passa, e a linha fica', () => {
    const id = seedPayment('K', { invoiceNumber: 'FT-2026-00048' });

    const result = payments.cancelPayment(db, id, 'Servico cancelado a pedido do cliente');

    expect(result.ok).toBe(true);
    expect(exists(id)).toBe(true);
    expect(statusOf(id)).toBe('cancelled');
  });

  test('anular uma cobrança sem número não exige motivo', () => {
    const id = seedPayment('L');

    const result = payments.cancelPayment(db, id, null);

    expect(result.ok).toBe(true);
    expect(statusOf(id)).toBe('cancelled');
  });
});
