import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { businessDay } from '../../shared/business-day';
import { monthsBefore } from '../../shared/payment-score';
import { runMigrations } from '../db/migrate';
import { insertClient } from './client-records';
import { HISTORY_MONTHS, clientBehaviourDetail, portfolioHistory } from './payment-behaviour';

/**
 * A evolução sai da mesma função com outra data de corte — é o que a decisão de
 * derivar (ADR 0026) paga. Aqui mede-se que paga mesmo: que o passado responde,
 * e que responde o que lá estava, não o que está hoje.
 */

let db: Database.Database;
const TODAY = businessDay();
const dueMonthsAgo = (n: number) => monthsBefore(TODAY, n);
let seq = 0;

beforeAll(() => {
  db = new Database(':memory:');
  runMigrations(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM clients').run();
});

function addInvoice(clientId: number, dueDate: string): number {
  seq += 1;
  const referenceMonth = dueDate.slice(0, 7);
  return db.prepare(`
    INSERT INTO payments (client_id, reference_month, amount_cve, due_date, status, document_type, invoice_number)
    VALUES (?, ?, 2500, ?, 'pending', 'invoice', ?)
  `).run(clientId, referenceMonth, dueDate, `FT${seq}`).lastInsertRowid as number;
}

function addReceipt(paymentId: number, paymentDate: string) {
  seq += 1;
  db.prepare(`
    INSERT INTO payment_receipts
      (payment_id, amount_cve, payment_date, payment_method, source, receipt_number, receipt_date)
    VALUES (?, 2500, ?, 'numerario', 'cash', ?, ?)
  `).run(paymentId, paymentDate, `RC${seq}`, paymentDate);
}

/** Paga todas as mensalidades no dia do vencimento, dos n meses atrás até ao mês passado. */
function pontual(name: string, meses: number): number {
  const clientId = insertClient(db, { fullName: name });
  for (let n = meses; n >= 1; n -= 1) {
    const dueDate = dueMonthsAgo(n);
    addReceipt(addInvoice(clientId, dueDate), dueDate);
  }
  return clientId;
}

describe('a evolução de um cliente', () => {
  test('tem um ponto por mês, do mais antigo ao mais recente', () => {
    const clientId = pontual('Impecável', 8);
    const detail = clientBehaviourDetail(db, clientId, TODAY)!;
    expect(detail.history).toHaveLength(HISTORY_MONTHS);
    const meses = detail.history.map((p) => p.month);
    expect([...meses].sort()).toEqual(meses);
    expect(meses[meses.length - 1]).toBe(TODAY.slice(0, 7));
  });

  test('os meses anteriores ao primeiro pagamento não têm letra', () => {
    const clientId = pontual('Entrou há pouco', 2);
    const detail = clientBehaviourDetail(db, clientId, TODAY)!;
    // Doze meses de janela, duas mensalidades: a maior parte é anterior a ele.
    expect(detail.history.filter((p) => p.letter === null).length).toBeGreaterThan(0);
    expect(detail.history[detail.history.length - 1].letter).toBe('A');
  });

  test('quem deixou de pagar vê a letra cair ao longo dos meses', () => {
    const clientId = insertClient(db, { fullName: 'Parou de pagar' });
    // Seis pagas a horas, e depois três por pagar.
    for (let n = 9; n >= 4; n -= 1) {
      const dueDate = dueMonthsAgo(n);
      addReceipt(addInvoice(clientId, dueDate), dueDate);
    }
    for (let n = 3; n >= 1; n -= 1) addInvoice(clientId, dueMonthsAgo(n));

    const detail = clientBehaviourDetail(db, clientId, TODAY)!;
    const comLetra = detail.history.filter((p) => p.letter !== null);
    expect(comLetra[0].score).toBeGreaterThan(comLetra[comLetra.length - 1].score);
    expect(detail.letter).not.toBe('A');
  });

  test('um cliente que não existe não devolve ficha', () => {
    expect(clientBehaviourDetail(db, 99_999, TODAY)).toBeNull();
  });
});

describe('a evolução da carteira', () => {
  test('conta os classificados de cada mês, e a carteira cresce com eles', () => {
    pontual('Veterano', 10);
    pontual('Recente', 2);

    const months = portfolioHistory(db, TODAY);
    expect(months).toHaveLength(HISTORY_MONTHS);
    const ultimo = months[months.length - 1];
    expect(ultimo.classified).toBe(2);
    expect(ultimo.distribution.A).toBe(2);
    // Há dez meses só um deles tinha mensalidades.
    expect(months[2].classified).toBeLessThanOrEqual(1);
  });

  test('uma carteira vazia não rebenta nem inventa médias', () => {
    const months = portfolioHistory(db, TODAY);
    expect(months).toHaveLength(HISTORY_MONTHS);
    for (const mes of months) {
      expect(mes).toMatchObject({ classified: 0, avgScore: 0 });
    }
  });
});
