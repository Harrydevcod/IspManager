import type { Database } from 'better-sqlite3';
import { buildMonthlyServiceLines, dueDateFromIssue, sumLines, todayIso, type BillingLine } from './billing';
import { isAudiovisualAnnualReference, loadAudiovisualConfig } from './audiovisual';
import { allocateDocumentNumber } from './numbering';

type PaymentStatus = 'pending' | 'paid' | 'overdue' | 'cancelled';
type PaymentMethod = 'numerario' | 'transferencia' | 'outro';
type PaymentRecord = Record<string, unknown>;

/**
 * Resultado de uma operação de domínio: ou correu bem (`ok: true` + dados para
 * o audit/resposta), ou falhou uma regra (`ok: false` + status HTTP + mensagem).
 * Mesma convenção de `serviceInstall.preflightItems` — o handler só mapeia.
 */
export type PaymentOpResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function selectPayment(db: Database, id: number): PaymentRecord | undefined {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as PaymentRecord | undefined;
}

// ---------------------------------------------------------------------------
// Reversão de cobrança mensal (apaga pendentes/atraso; pagas e anuladas ficam)
// ---------------------------------------------------------------------------

export function previewReverseMonthly(db: Database, referenceMonth: string) {
  const rows = db.prepare(`
    SELECT
      py.id,
      py.client_id AS clientId,
      c.full_name AS clientName,
      c.client_code AS clientCode,
      py.amount_cve AS amountCve,
      py.due_date AS dueDate,
      py.invoice_number AS invoiceNumber,
      py.status
    FROM payments py
    JOIN clients c ON c.id = py.client_id
    WHERE py.reference_month = ?
    ORDER BY c.full_name
  `).all(referenceMonth) as Array<{
    id: number;
    clientId: number;
    clientName: string;
    clientCode: string | null;
    amountCve: number;
    dueDate: string;
    invoiceNumber: string | null;
    status: PaymentStatus;
  }>;

  const eligible = rows.filter((r) => r.status === 'pending' || r.status === 'overdue');
  const paidLocked = rows.filter((r) => r.status === 'paid');
  const cancelledKept = rows.filter((r) => r.status === 'cancelled');

  return {
    referenceMonth,
    total: rows.length,
    eligibleCount: eligible.length,
    paidLockedCount: paidLocked.length,
    cancelledCount: cancelledKept.length,
    totalCve: eligible.reduce((sum, r) => sum + r.amountCve, 0),
    eligible,
    paidLocked: paidLocked.map((r) => ({
      id: r.id,
      clientName: r.clientName,
      clientCode: r.clientCode,
      invoiceNumber: r.invoiceNumber,
      amountCve: r.amountCve
    }))
  };
}

export function executeReverseMonthly(db: Database, referenceMonth: string): { reversed: number; invoiceNumbers: string[] } {
  const eligibleRows = db.prepare(`
    SELECT id, invoice_number AS invoiceNumber
    FROM payments
    WHERE reference_month = ? AND status IN ('pending', 'overdue')
  `).all(referenceMonth) as Array<{ id: number; invoiceNumber: string | null }>;

  const deleteLinesStmt = db.prepare(`
    DELETE FROM payment_lines WHERE payment_id IN (
      SELECT id FROM payments WHERE reference_month = ? AND status IN ('pending', 'overdue')
    )
  `);
  const deleteStmt = db.prepare(`
    DELETE FROM payments
    WHERE reference_month = ? AND status IN ('pending', 'overdue')
  `);

  const result = db.transaction(() => {
    deleteLinesStmt.run(referenceMonth); // filhos primeiro (FK)
    return deleteStmt.run(referenceMonth);
  })();

  return {
    reversed: result.changes,
    invoiceNumbers: eligibleRows.map((r) => r.invoiceNumber).filter((n): n is string => Boolean(n))
  };
}

// ---------------------------------------------------------------------------
// Reverter uma cobrança individual (só pendente/atraso — paga usa-se anular)
// ---------------------------------------------------------------------------

export function revertPayment(db: Database, id: number): PaymentOpResult<{
  referenceMonth: string;
  invoiceNumber: string | null;
  clientId: number;
}> {
  const payment = db.prepare(`
    SELECT id, status, reference_month AS referenceMonth, invoice_number AS invoiceNumber, client_id AS clientId
    FROM payments WHERE id = ?
  `).get(id) as {
    id: number;
    status: PaymentStatus;
    referenceMonth: string;
    invoiceNumber: string | null;
    clientId: number;
  } | undefined;

  if (!payment) {
    return { ok: false, status: 404, error: 'Pagamento nao encontrado' };
  }
  if (payment.status === 'paid') {
    return { ok: false, status: 400, error: 'Pagamento pago nao pode ser revertido. Use anular.' };
  }
  if (payment.status === 'cancelled') {
    return { ok: false, status: 400, error: 'Pagamento ja esta anulado. Nada a reverter.' };
  }

  db.transaction(() => {
    db.prepare('DELETE FROM payment_lines WHERE payment_id = ?').run(id); // filhos primeiro (FK)
    db.prepare('DELETE FROM payments WHERE id = ?').run(id);
  })();

  return {
    ok: true,
    value: { referenceMonth: payment.referenceMonth, invoiceNumber: payment.invoiceNumber, clientId: payment.clientId }
  };
}

// ---------------------------------------------------------------------------
// Regenerar uma mensalidade anulada com o valor atual do serviço
// ---------------------------------------------------------------------------

export function regeneratePayment(db: Database, id: number): PaymentOpResult<{
  regeneratedId: number;
  invoiceNumber: string;
  referenceMonth: string;
  serviceId: number;
  amountCve: number;
  dueDate: string;
}> {
  const payment = db.prepare(`
    SELECT
      py.id,
      py.status,
      py.client_id AS clientId,
      py.service_id AS serviceId,
      py.reference_month AS referenceMonth,
      s.monthly_value_cve AS monthlyValueCve,
      s.audiovisual_mode AS audiovisualMode,
      s.audiovisual_monthly_cve AS audiovisualMonthlyCve,
      s.audiovisual_annual_cve AS audiovisualAnnualCve,
      s.status AS serviceStatus,
      c.status AS clientStatus
    FROM payments py
    JOIN services s ON s.id = py.service_id
    JOIN clients c ON c.id = py.client_id
    WHERE py.id = ?
  `).get(id) as {
    id: number;
    status: PaymentStatus;
    clientId: number;
    serviceId: number;
    referenceMonth: string;
    monthlyValueCve: number;
    audiovisualMode: 'none' | 'monthly' | 'annual';
    audiovisualMonthlyCve: number;
    audiovisualAnnualCve: number;
    serviceStatus: 'active' | 'suspended' | 'cancelled';
    clientStatus: 'active' | 'suspended' | 'cancelled';
  } | undefined;

  if (!payment) {
    return { ok: false, status: 404, error: 'Pagamento nao encontrado' };
  }
  if (payment.status !== 'cancelled') {
    return { ok: false, status: 400, error: 'Apenas pagamentos anulados podem regenerar mensalidade' };
  }
  if (payment.serviceStatus !== 'active') {
    return { ok: false, status: 400, error: 'Servico cancelado nao pode regenerar mensalidade' };
  }
  if (payment.clientStatus === 'cancelled') {
    return { ok: false, status: 400, error: 'Cliente cancelado nao pode regenerar mensalidade' };
  }

  const activePayment = db.prepare(`
    SELECT id
    FROM payments
    WHERE service_id = ? AND reference_month = ? AND status != 'cancelled'
  `).get(payment.serviceId, payment.referenceMonth);
  if (activePayment) {
    return { ok: false, status: 400, error: 'Ja existe uma mensalidade ativa para este servico e mes' };
  }

  // Reconstrói a composição a partir do serviço — mensal (internet + audiovisual)
  // ou anuidade audiovisual, conforme a competência. Mesma fonte da geração
  // original, para o total regenerado nunca divergir.
  const config = loadAudiovisualConfig(db);
  const lines: BillingLine[] = isAudiovisualAnnualReference(payment.referenceMonth)
    ? (() => {
        const annual = payment.audiovisualAnnualCve > 0 ? payment.audiovisualAnnualCve : config.annualCve;
        return annual > 0 ? [{ kind: 'audiovisual' as const, description: config.label, amountCve: annual }] : [];
      })()
    : buildMonthlyServiceLines(payment, config.label);
  const amountCve = sumLines(lines);
  if (amountCve <= 0) {
    return { ok: false, status: 400, error: 'Servico sem valor a regenerar' };
  }

  const dueDate = dueDateFromIssue(todayIso());
  const insertLine = db.prepare(`
    INSERT INTO payment_lines (payment_id, kind, description, amount_cve, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  const regenerated = db.transaction(() => {
    const inserted = db.prepare(`
      INSERT INTO payments (
        client_id, service_id, reference_month, amount_cve, due_date,
        status, invoice_number, invoice_date, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, date('now'), datetime('now'), datetime('now'))
    `).run(payment.clientId, payment.serviceId, payment.referenceMonth, amountCve, dueDate);
    const regeneratedId = Number(inserted.lastInsertRowid);
    const invoiceNumber = allocateDocumentNumber('invoice');
    db.prepare('UPDATE payments SET invoice_number = ? WHERE id = ?').run(invoiceNumber, regeneratedId);
    lines.forEach((line, index) => insertLine.run(regeneratedId, line.kind, line.description, line.amountCve, index));
    return { regeneratedId, invoiceNumber };
  })();

  return {
    ok: true,
    value: {
      regeneratedId: regenerated.regeneratedId,
      invoiceNumber: regenerated.invoiceNumber,
      referenceMonth: payment.referenceMonth,
      serviceId: payment.serviceId,
      amountCve,
      dueDate
    }
  };
}

// ---------------------------------------------------------------------------
// Registar pagamento / marcar em atraso / anular
// ---------------------------------------------------------------------------

export function payPayment(
  db: Database,
  id: number,
  input: { paymentMethod: PaymentMethod; paymentDate?: string }
): PaymentOpResult<PaymentRecord> {
  const payment = db.prepare('SELECT id, status, receipt_number AS receiptNumber FROM payments WHERE id = ?').get(id) as { id: number; status: PaymentStatus; receiptNumber: string | null } | undefined;
  if (!payment) {
    return { ok: false, status: 404, error: 'Pagamento nao encontrado' };
  }
  if (payment.status === 'cancelled') {
    return { ok: false, status: 400, error: 'Pagamento anulado nao pode ser pago' };
  }

  const paymentDate = input.paymentDate || todayIso();
  // Aloca o recibo só quando ainda não existe. Repagar uma linha já paga mantém
  // o recibo original e nunca queima um número de série — allocateDocumentNumber
  // incrementa o contador a cada chamada, logo chamá-lo à toa criaria gaps.
  if (!payment.receiptNumber) {
    const receiptNumber = allocateDocumentNumber('receipt');
    db.prepare(`
      UPDATE payments
      SET status = 'paid', payment_method = ?, payment_date = ?,
          receipt_number = ?, receipt_date = date('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(input.paymentMethod, paymentDate, receiptNumber, id);
  } else {
    db.prepare(`
      UPDATE payments
      SET status = 'paid', payment_method = ?, payment_date = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(input.paymentMethod, paymentDate, id);
  }

  return { ok: true, value: selectPayment(db, id)! };
}

export function markPaymentOverdue(db: Database, id: number): PaymentOpResult<PaymentRecord> {
  const payment = db.prepare('SELECT id, status FROM payments WHERE id = ?').get(id) as { id: number; status: PaymentStatus } | undefined;
  if (!payment) {
    return { ok: false, status: 404, error: 'Pagamento nao encontrado' };
  }
  if (payment.status === 'paid') {
    return { ok: false, status: 400, error: 'Pagamento pago nao pode ser marcado em atraso' };
  }
  if (payment.status === 'cancelled') {
    return { ok: false, status: 400, error: 'Pagamento anulado nao pode ser marcado em atraso' };
  }

  db.prepare(`
    UPDATE payments
    SET status = 'overdue',
        updated_at = datetime('now')
    WHERE id = ?
  `).run(id);

  return { ok: true, value: selectPayment(db, id)! };
}

export function cancelPayment(db: Database, id: number, rawReason: string | null | undefined): PaymentOpResult<{
  payment: PaymentRecord;
  wasPaid: boolean;
  reason: string;
  priorStatus: PaymentStatus;
  invoiceNumber: string | null;
  receiptNumber: string | null;
  amountCve: number;
  referenceMonth: string;
}> {
  const payment = db.prepare(`
    SELECT id, status, notes, amount_cve AS amountCve, invoice_number AS invoiceNumber,
           receipt_number AS receiptNumber, reference_month AS referenceMonth
    FROM payments WHERE id = ?
  `).get(id) as {
    id: number;
    status: PaymentStatus;
    notes: string | null;
    amountCve: number;
    invoiceNumber: string | null;
    receiptNumber: string | null;
    referenceMonth: string;
  } | undefined;

  if (!payment) {
    return { ok: false, status: 404, error: 'Pagamento nao encontrado' };
  }
  if (payment.status === 'cancelled') {
    return { ok: false, status: 400, error: 'Pagamento ja esta anulado' };
  }

  const reason = rawReason?.trim() || '';
  const wasPaid = payment.status === 'paid';
  if (wasPaid && reason.length < 10) {
    return { ok: false, status: 400, error: 'Anular pagamento ja registado exige um motivo detalhado (minimo 10 caracteres).' };
  }

  const stampedReason = reason
    ? wasPaid
      ? `[ANULACAO POS-PAGAMENTO] ${reason}`
      : reason
    : '';
  const notes = stampedReason
    ? [payment.notes?.trim(), stampedReason].filter(Boolean).join('\n')
    : payment.notes;

  db.prepare(`
    UPDATE payments
    SET status = 'cancelled',
        notes = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(notes || null, id);

  return {
    ok: true,
    value: {
      payment: selectPayment(db, id)!,
      wasPaid,
      reason,
      priorStatus: payment.status,
      invoiceNumber: payment.invoiceNumber,
      receiptNumber: payment.receiptNumber,
      amountCve: payment.amountCve,
      referenceMonth: payment.referenceMonth
    }
  };
}
