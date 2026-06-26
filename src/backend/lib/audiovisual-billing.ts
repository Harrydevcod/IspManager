import { getSqliteDatabase } from '../db/database';
import { dueDateFromIssue, todayIso, PAYMENT_DUE_DAYS } from './billing';
import { nextDocumentNumber } from './numbering';
import { audiovisualAnnualReference, loadAudiovisualConfig } from './audiovisual';

type AnnualServiceRow = {
  serviceId: number;
  clientId: number;
  activationDate: string | null;
  createdAt: string;
  annualCve: number;
};

/**
 * Início do ciclo anual: o aniversário (mês/dia da ativação) mais recente que já
 * passou à data `now`. Antes do aniversário deste ano, o ciclo corrente começou no
 * ano anterior. A granularidade da chave de competência é o mês de aniversário.
 */
function cycleStartYear(activation: Date, now: Date): number {
  const anniversaryThisYear = new Date(now.getFullYear(), activation.getMonth(), activation.getDate());
  return anniversaryThisYear.getTime() <= now.getTime() ? now.getFullYear() : now.getFullYear() - 1;
}

function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type AudiovisualAnnualResult =
  | { skipped: true; reason: string }
  | { ran: true; created: number; references: string[] };

/**
 * Gera a fatura anual de "Distribuição de Conteúdos Audiovisuais" (modalidade
 * anual) — separada da fatura mensal da internet. Idempotente por ciclo via
 * `UNIQUE(service_id, reference_month)`: cobre a adesão e cada renovação anual sem
 * duplicar. Faz catch-up implícito (o ciclo corrente é sempre o alvo); não retroage
 * anos anteriores. Pode ser restringida a um serviço (`onlyServiceId`) para emitir
 * a fatura de adesão no momento em que o serviço é criado.
 */
export function runAudiovisualAnnualIfDue(now: Date = new Date(), onlyServiceId?: number): AudiovisualAnnualResult {
  const db = getSqliteDatabase();
  const config = loadAudiovisualConfig(db);

  const params: unknown[] = [];
  let sql = `
    SELECT
      s.id AS serviceId,
      s.client_id AS clientId,
      s.activation_date AS activationDate,
      s.created_at AS createdAt,
      s.audiovisual_annual_centavos / 100.0 AS annualCve
    FROM services s
    JOIN clients c ON c.id = s.client_id
    WHERE s.status = 'active'
      AND c.status != 'cancelled'
      AND s.audiovisual_mode = 'annual'
  `;
  if (onlyServiceId) {
    sql += ' AND s.id = ?';
    params.push(onlyServiceId);
  }
  const services = db.prepare(sql).all(...params) as AnnualServiceRow[];

  // Slot livre só se não houver cobrança *não anulada* para o ciclo — espelha a
  // regra de reemissão da faturação mensal.
  const existsStmt = db.prepare(`SELECT 1 AS hit FROM payments WHERE service_id = ? AND reference_month = ? AND status != 'cancelled'`);
  const insert = db.prepare(`
    INSERT INTO payments (
      client_id, service_id, reference_month, amount_centavos, due_date,
      status, invoice_number, invoice_date, created_at, updated_at
    )
    VALUES (?, ?, ?, CAST(ROUND(? * 100) AS INTEGER), ?, 'pending', NULL, date('now'), datetime('now'), datetime('now'))
  `);
  const updateInvoice = db.prepare('UPDATE payments SET invoice_number = ? WHERE id = ? AND invoice_number IS NULL');
  const insertLine = db.prepare(`
    INSERT INTO payment_lines (payment_id, kind, description, amount_centavos, sort_order)
    VALUES (?, 'audiovisual', ?, CAST(ROUND(? * 100) AS INTEGER), 0)
  `);

  const dueIso = dueDateFromIssue(todayIso(), PAYMENT_DUE_DAYS);
  const references: string[] = [];

  const run = db.transaction(() => {
    let created = 0;
    for (const svc of services) {
      const amount = Number(svc.annualCve) > 0 ? Number(svc.annualCve) : config.annualCve;
      if (amount <= 0) continue;

      const activation = parseDateOnly(svc.activationDate) ?? parseDateOnly(svc.createdAt) ?? now;
      const reference = audiovisualAnnualReference(cycleStartYear(activation, now), activation.getMonth());
      if (existsStmt.get(svc.serviceId, reference)) continue;

      const inserted = insert.run(svc.clientId, svc.serviceId, reference, amount, dueIso);
      const paymentId = Number(inserted.lastInsertRowid);
      updateInvoice.run(nextDocumentNumber('invoice', paymentId), paymentId);
      insertLine.run(paymentId, config.label, amount);
      references.push(reference);
      created += 1;
    }
    return created;
  });

  const created = run();
  if (created === 0) {
    return { skipped: true, reason: 'sem anuidades audiovisuais por faturar' };
  }
  return { ran: true, created, references };
}
