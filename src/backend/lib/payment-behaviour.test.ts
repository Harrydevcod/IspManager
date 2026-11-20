import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { businessDay } from '../../shared/business-day';
import { monthsBefore } from '../../shared/payment-score';
import { runMigrations } from '../db/migrate';
import { insertClient } from './client-records';
import { behaviourForClient, loadPaymentBehaviour } from './payment-behaviour';

let db: Database.Database;
beforeAll(() => { db = new Database(':memory:'); runMigrations(db); });
beforeEach(() => {
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
});
afterAll(() => { db.close(); });

const TODAY = businessDay();
/** Vencimento de há n meses, no mesmo dia do mês — sempre relativo a hoje, nunca uma data fixa. */
const dueMonthsAgo = (n: number) => monthsBefore(TODAY, n);
const daysAgo = (n: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

let seq = 0;

type InvoiceOptions = {
  dueDate: string;
  amountCve?: number;
  status?: string;
  documentType?: string;
  referenceMonth?: string;
};

function addInvoice(clientId: number, options: InvoiceOptions): number {
  seq += 1;
  const month = options.referenceMonth ?? options.dueDate.slice(0, 7);
  const info = db.prepare(`
    INSERT INTO payments (client_id, document_type, reference_month, amount_cve, due_date, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    clientId,
    options.documentType ?? 'invoice',
    month,
    options.amountCve ?? 2500,
    options.dueDate,
    options.status ?? 'pending'
  );
  return Number(info.lastInsertRowid);
}

function addReceipt(
  paymentId: number,
  date: string,
  amountCve = 2500,
  extra: { voided?: boolean; source?: 'cash' | 'credit' } = {}
) {
  seq += 1;
  db.prepare(`
    INSERT INTO payment_receipts
      (payment_id, amount_cve, payment_date, payment_method, source, receipt_number, receipt_date, voided_at)
    VALUES (?, ?, ?, 'numerario', ?, ?, ?, ?)
  `).run(
    paymentId, amountCve, date, extra.source ?? 'cash',
    `R${String(seq).padStart(4, '0')}`, date, extra.voided ? `${date} 10:00:00` : null
  );
}

/** Cliente com `months` mensalidades pagas no dia do vencimento. */
function punctualClient(name: string, months = 6): number {
  const clientId = insertClient(db, { fullName: name });
  for (let n = 1; n <= months; n += 1) {
    const dueDate = dueMonthsAgo(n);
    addReceipt(addInvoice(clientId, { dueDate }), dueDate);
  }
  return clientId;
}

const only = (clientId: number) => behaviourForClient(db, clientId, TODAY)!;

describe('o que entra no julgamento', () => {
  test('um cliente pontual chega a 100 e à classe A, e aparece em dia', () => {
    const clientId = punctualClient('Pontual');
    expect(only(clientId)).toMatchObject({
      evaluated: 6, onTime: 6, settled: 6, score: 100, letter: 'A', provisional: false,
      state: 'em_dia', overdueCve: 0
    });
  });

  test('uma fatura anulada não prejudica ninguém', () => {
    const clientId = punctualClient('Com anulada');
    addInvoice(clientId, { dueDate: dueMonthsAgo(2), status: 'cancelled', amountCve: 50_000 });
    expect(only(clientId)).toMatchObject({ evaluated: 6, score: 100, letter: 'A' });
  });

  test('um talão de venda não é mensalidade', () => {
    const clientId = punctualClient('Com talão');
    addInvoice(clientId, { dueDate: dueMonthsAgo(1), documentType: 'sale_ticket' });
    expect(only(clientId).evaluated).toBe(6);
  });

  test('instalação e faturas avulsas não são mensalidades', () => {
    const clientId = punctualClient('Com avulsas');
    addInvoice(clientId, { dueDate: dueMonthsAgo(1), referenceMonth: 'INSTALACAO' });
    addInvoice(clientId, { dueDate: dueMonthsAgo(2), referenceMonth: 'AVULSA-7' });
    expect(only(clientId).evaluated).toBe(6);
  });

  test('uma mensalidade que ainda não venceu não conta', () => {
    const clientId = punctualClient('Com futura');
    addInvoice(clientId, { dueDate: monthsBefore(TODAY, -1) });
    expect(only(clientId)).toMatchObject({ evaluated: 6, score: 100 });
  });

  test('um recibo anulado deixa a mensalidade por liquidar', () => {
    const clientId = insertClient(db, { fullName: 'Recibo anulado' });
    for (let n = 1; n <= 4; n += 1) {
      const dueDate = dueMonthsAgo(n);
      addReceipt(addInvoice(clientId, { dueDate }), dueDate, 2500, { voided: n === 1 });
    }
    const behaviour = only(clientId);
    expect(behaviour.evaluated).toBe(4);
    expect(behaviour.settled).toBe(3);
    expect(behaviour.onTime).toBe(3);
  });

  test('liquidar por conta corrente é liquidar', () => {
    const clientId = insertClient(db, { fullName: 'Por crédito' });
    for (let n = 1; n <= 3; n += 1) {
      const dueDate = dueMonthsAgo(n);
      addReceipt(addInvoice(clientId, { dueDate }), dueDate, 2500, { source: 'credit' });
    }
    expect(only(clientId)).toMatchObject({ settled: 3, onTime: 3, letter: 'A' });
  });

  test('um pagamento parcial não liquida a mensalidade', () => {
    const clientId = insertClient(db, { fullName: 'Parcial' });
    for (let n = 1; n <= 3; n += 1) {
      const dueDate = dueMonthsAgo(n);
      addReceipt(addInvoice(clientId, { dueDate }), dueDate, n === 1 ? 1000 : 2500);
    }
    const behaviour = only(clientId);
    expect(behaviour.settled).toBe(2);
    expect(behaviour.state).toBe('vencido');
    expect(behaviour.overdueCve).toBe(1500);
  });

  test('clientes de sistema ficam de fora da carteira', () => {
    punctualClient('Normal');
    const systemId = insertClient(db, { fullName: 'Caixa interna' });
    db.prepare("UPDATE clients SET system_kind = 'indifferentiated' WHERE id = ?").run(systemId);
    const report = loadPaymentBehaviour(db, { asOf: TODAY });
    expect(report.clients.map((c) => c.clientId)).not.toContain(systemId);
  });
});

describe('estado de hoje, separado da letra', () => {
  test('um cliente de classe A com uma mensalidade vencida continua classe A', () => {
    const clientId = punctualClient('A com dívida', 12);
    addInvoice(clientId, { dueDate: daysAgo(5) });
    const behaviour = only(clientId);
    expect(behaviour.letter).toBe('A');
    expect(behaviour.state).toBe('vencido');
    expect(behaviour.overdueCve).toBe(2500);
  });

  test('serviço suspenso manda no estado', () => {
    const clientId = punctualClient('Suspenso');
    db.prepare("INSERT INTO services (client_id, status) VALUES (?, 'suspended')").run(clientId);
    expect(only(clientId)).toMatchObject({ letter: 'A', state: 'suspenso' });
  });
});

describe('a carteira', () => {
  test('conta classificados e provisórios à parte, e a média é só dos classificados', () => {
    punctualClient('Com histórico', 6);
    const novo = insertClient(db, { fullName: 'Acabou de entrar' });
    const dueDate = dueMonthsAgo(1);
    addReceipt(addInvoice(novo, { dueDate }), dueDate);
    const semNada = insertClient(db, { fullName: 'Sem mensalidades' });

    const report = loadPaymentBehaviour(db, { asOf: TODAY });
    expect(report.totals).toMatchObject({
      classified: 1, provisional: 2, avgScore: 100, inGoodStandingPct: 100
    });
    expect(report.totals.distribution).toEqual({ A: 1, B: 0, C: 0, D: 0, E: 0 });
    expect(report.clients.find((c) => c.clientId === semNada)).toMatchObject({
      evaluated: 0, score: 0, letter: null, provisional: true
    });
    expect(report.clients.find((c) => c.clientId === novo)?.letter).toBeNull();
  });

  test('uma carteira vazia não rebenta nem inventa médias', () => {
    const report = loadPaymentBehaviour(db, { asOf: TODAY });
    expect(report.clients).toEqual([]);
    expect(report.totals).toMatchObject({ classified: 0, provisional: 0, avgScore: 0, inGoodStandingPct: 0 });
  });

  test('quem nunca pagou cai na classe E', () => {
    const clientId = insertClient(db, { fullName: 'Nunca pagou' });
    for (let n = 1; n <= 6; n += 1) addInvoice(clientId, { dueDate: dueMonthsAgo(n) });
    expect(only(clientId)).toMatchObject({ letter: 'E', settled: 0, state: 'vencido' });
  });
});
