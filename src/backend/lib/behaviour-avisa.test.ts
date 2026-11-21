import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { businessDay } from '../../shared/business-day';
import { monthsBefore } from '../../shared/payment-score';
import { runMigrations } from '../db/migrate';
import { insertClient } from './client-records';
import { classDrops } from './payment-behaviour';
import { funnelForClass, reminderLeadFor, stageFor, type FunnelStage } from './notices';

/**
 * As duas pontas do aviso: o sino, que fala connosco, e a antecedência do
 * lembrete, que fala com o cliente. A segunda é a que exige cuidado — mexer
 * nela muda quantas mensagens saem e a quem.
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
  return db.prepare(`
    INSERT INTO payments (client_id, reference_month, amount_cve, due_date, status, document_type, invoice_number)
    VALUES (?, ?, 2500, ?, 'pending', 'invoice', ?)
  `).run(clientId, dueDate.slice(0, 7), dueDate, `FT${seq}`).lastInsertRowid as number;
}

function addReceipt(paymentId: number, paymentDate: string) {
  seq += 1;
  db.prepare(`
    INSERT INTO payment_receipts
      (payment_id, amount_cve, payment_date, payment_method, source, receipt_number, receipt_date)
    VALUES (?, 2500, ?, 'numerario', 'cash', ?, ?)
  `).run(paymentId, paymentDate, `RC${seq}`, paymentDate);
}

describe('o sino avisa quem desce de classe', () => {
  test('uma carteira impecável não toca o sino', () => {
    const clientId = insertClient(db, { fullName: 'Impecável' });
    for (let n = 8; n >= 1; n -= 1) {
      const dueDate = dueMonthsAgo(n);
      addReceipt(addInvoice(clientId, dueDate), dueDate);
    }
    expect(classDrops(db, TODAY)).toEqual([]);
  });

  test('quem deixou de pagar no último mês aparece, com a letra de antes e a de agora', () => {
    const clientId = insertClient(db, { fullName: 'Parou de pagar' });
    for (let n = 9; n >= 3; n -= 1) {
      const dueDate = dueMonthsAgo(n);
      addReceipt(addInvoice(clientId, dueDate), dueDate);
    }
    // As duas últimas por pagar: há 30 dias só uma delas tinha vencido.
    addInvoice(clientId, dueMonthsAgo(2));
    addInvoice(clientId, dueMonthsAgo(1));

    const drops = classDrops(db, TODAY);
    expect(drops).toHaveLength(1);
    expect(drops[0].clientName).toBe('Parou de pagar');
    expect(drops[0].from < drops[0].to).toBe(true);
  });

  test('ganhar a primeira letra não é descer', () => {
    // Há 30 dias não havia nada para julgar; hoje há, e é má. Não é uma descida.
    const clientId = insertClient(db, { fullName: 'Entrou agora' });
    addInvoice(clientId, dueMonthsAgo(0));
    expect(classDrops(db, TODAY)).toEqual([]);
  });

  test('subir não toca o sino: boa notícia não precisa dele', () => {
    const clientId = insertClient(db, { fullName: 'Pôs-se em dia' });
    for (let n = 9; n >= 1; n -= 1) {
      const dueDate = dueMonthsAgo(n);
      // Pagou tudo esta semana: há 30 dias estava tudo por pagar.
      addReceipt(addInvoice(clientId, dueDate), TODAY);
    }
    expect(classDrops(db, TODAY)).toEqual([]);
  });
});

describe('a antecedência do lembrete pela classe', () => {
  const base: FunnelStage[] = [
    { stage: 'reminder', threshold: -2 },
    { stage: 'overdue', threshold: 1 },
    { stage: 'warning', threshold: 7 },
    { stage: 'suspension', threshold: 10 }
  ];

  test('quem paga sempre a horas deixa de levar lembrete antes do vencimento', () => {
    for (const letter of ['A', 'B'] as const) {
      expect(reminderLeadFor(letter, 2)).toBeNull();
      const funnel = funnelForClass(base, letter, 2);
      expect(funnel.some((stage) => stage.stage === 'reminder')).toBe(false);
      // Dois dias antes de vencer já não sai nada.
      expect(stageFor(funnel, -2)).toBeNull();
    }
  });

  test('quem costuma atrasar é avisado mais cedo', () => {
    expect(reminderLeadFor('C', 2)).toBe(3);
    expect(reminderLeadFor('D', 2)).toBe(5);
    expect(reminderLeadFor('E', 2)).toBe(5);
    expect(stageFor(funnelForClass(base, 'D', 2), -5)).toBe('reminder');
    // A classe C ainda não: só três dias antes.
    expect(stageFor(funnelForClass(base, 'C', 2), -5)).toBeNull();
    expect(stageFor(funnelForClass(base, 'C', 2), -3)).toBe('reminder');
  });

  test('sem letra vale o que está configurado', () => {
    expect(reminderLeadFor(null, 2)).toBe(2);
    expect(stageFor(funnelForClass(base, null, 2), -2)).toBe('reminder');
    expect(stageFor(funnelForClass(base, null, 2), -3)).toBeNull();
  });

  test('a classe não mexe no vencido, no aviso nem na suspensão', () => {
    // Essas etapas obedecem ao contrato, não ao histórico de pagamento.
    for (const letter of ['A', 'C', 'E', null] as const) {
      const funnel = funnelForClass(base, letter, 2);
      expect(stageFor(funnel, 1)).toBe('overdue');
      expect(stageFor(funnel, 7)).toBe('warning');
      expect(stageFor(funnel, 10)).toBe('suspension');
    }
  });

  test('o funil continua ordenado depois de trocar a antecedência', () => {
    for (const letter of ['A', 'B', 'C', 'D', 'E', null] as const) {
      const thresholds = funnelForClass(base, letter, 2).map((stage) => stage.threshold);
      expect([...thresholds].sort((a, b) => a - b)).toEqual(thresholds);
    }
  });
});
