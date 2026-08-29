import type { Database } from 'better-sqlite3';
import { buildMonthlyServiceLines, dueDateFromIssue, loadServiceRentals, sumLines, todayIso, type BillingLine } from './billing';
import { isAudiovisualAnnualReference, loadAudiovisualConfig } from './audiovisual';
import { allocateDocumentNumber } from './numbering';
import { validatePaymentDates } from '../../shared/payment-dates';
import { escudosToCentavos, isSettled, roundEscudos } from '../../shared/money';

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
// Reversão de cobrança mensal
//
// Apaga só o que nunca foi documento: pendentes/atraso SEM número de fatura.
// Pagas, anuladas e numeradas ficam. O número é atribuído na geração da
// mensalidade (ver `billing.ts`), não na impressão do PDF — uma mensalidade
// gerada já é um documento antes de alguém a imprimir, e apagá-la deixaria um
// salto na sequência sem rasto de que existiu. Documento numerado anula-se.
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

  const openRows = rows.filter((r) => r.status === 'pending' || r.status === 'overdue');

  const withReceipts = new Set(
    (db.prepare(`
      SELECT DISTINCT r.payment_id AS paymentId
      FROM payment_receipts r
      JOIN payments p ON p.id = r.payment_id
      WHERE p.reference_month = ? AND r.voided_at IS NULL
    `).all(referenceMonth) as Array<{ paymentId: number }>).map((r) => r.paymentId)
  );

  const eligible = openRows.filter((r) => !r.invoiceNumber && !withReceipts.has(r.id));
  const invoicedLocked = openRows.filter((r) => Boolean(r.invoiceNumber) || withReceipts.has(r.id));
  const paidLocked = rows.filter((r) => r.status === 'paid');
  const cancelledKept = rows.filter((r) => r.status === 'cancelled');

  const locked = (r: (typeof rows)[number]) => ({
    id: r.id,
    clientName: r.clientName,
    clientCode: r.clientCode,
    invoiceNumber: r.invoiceNumber,
    amountCve: r.amountCve
  });

  return {
    referenceMonth,
    total: rows.length,
    eligibleCount: eligible.length,
    paidLockedCount: paidLocked.length,
    invoicedLockedCount: invoicedLocked.length,
    cancelledCount: cancelledKept.length,
    totalCve: eligible.reduce((sum, r) => sum + r.amountCve, 0),
    eligible,
    paidLocked: paidLocked.map(locked),
    invoicedLocked: invoicedLocked.map(locked)
  };
}

export function executeReverseMonthly(db: Database, referenceMonth: string): { reversed: number; invoicedKept: number } {
  // Nao apagavel = ja e documento (numerado) ou ja recebeu dinheiro. As duas
  // condicoes andam juntas nos tres sitios; separa-las era convidar a que um
  // deles se esquecesse de uma.
  const notReversible = `(invoice_number IS NOT NULL OR EXISTS (
    SELECT 1 FROM payment_receipts r WHERE r.payment_id = payments.id AND r.voided_at IS NULL))`;

  const invoicedKept = db.prepare(`
    SELECT COUNT(*) AS n
    FROM payments
    WHERE reference_month = ? AND status IN ('pending', 'overdue') AND ${notReversible}
  `).get(referenceMonth) as { n: number };

  // A mesma condicao nos dois passos: e ela que separa o rascunho de cobranca
  // do documento emitido (ou ja recebido).
  const deleteLinesStmt = db.prepare(`
    DELETE FROM payment_lines WHERE payment_id IN (
      SELECT id FROM payments
      WHERE reference_month = ? AND status IN ('pending', 'overdue') AND NOT ${notReversible}
    )
  `);
  const deleteStmt = db.prepare(`
    DELETE FROM payments
    WHERE reference_month = ? AND status IN ('pending', 'overdue') AND NOT ${notReversible}
  `);

  const result = db.transaction(() => {
    deleteLinesStmt.run(referenceMonth); // filhos primeiro (FK)
    return deleteStmt.run(referenceMonth);
  })();

  return { reversed: result.changes, invoicedKept: invoicedKept.n };
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
  // Reverter apaga a linha, e uma linha apagada levava os recibos com ela.
  // Onde entrou dinheiro nao ha rascunho nenhum para deitar fora: anula-se.
  if (receivedTotal(db, id) > 0) {
    return {
      ok: false,
      status: 400,
      error: 'Pagamento com recebimentos registados nao pode ser revertido. Use anular.'
    };
  }
  // Reverter apaga a linha. Um documento numerado nunca desaparece: anula-se e
  // fica, senão o número some e a sequência ganha um salto sem explicacao.
  if (payment.invoiceNumber) {
    return {
      ok: false,
      status: 400,
      error: `Pagamento com fatura ${payment.invoiceNumber} emitida nao pode ser revertido. Use anular.`
    };
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
  if (payment.serviceStatus === 'cancelled') {
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
    : buildMonthlyServiceLines(
        { ...payment, status: payment.serviceStatus },
        config.label,
        loadServiceRentals(db).get(payment.serviceId) ?? []
      );
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

// ---------------------------------------------------------------------------
// Recebimentos
//
// A fatura e imutavel: `amount_cve` nasce com o documento numerado e fica. O
// que varia e quanto dela ja foi recebido, e isso vive em `payment_receipts` —
// uma linha por entrada de dinheiro, cada uma com o seu numero de recibo.
// `payments.status` continua a fechar so quando a soma cobre o valor, para que
// o `overdueSqlPredicate` e os PDFs continuem a valer sem saber de parciais.
// ---------------------------------------------------------------------------

export type ReceiptSource = 'cash' | 'credit';

export type ReceiptRecord = {
  id: number;
  paymentId: number;
  amountCve: number;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  source: ReceiptSource;
  receiptNumber: string;
  receiptDate: string;
  voidedAt: string | null;
  voidReason: string | null;
  notes: string | null;
};

const receiptSelect = `
  SELECT id, payment_id AS paymentId, amount_cve AS amountCve, payment_date AS paymentDate,
         payment_method AS paymentMethod, source, receipt_number AS receiptNumber,
         receipt_date AS receiptDate, voided_at AS voidedAt, void_reason AS voidReason, notes
  FROM payment_receipts
`;

/**
 * Quanto falta receber de uma fatura, em SQL. Irma do `overdueSqlPredicate`:
 * existe para nenhum painel inventar a sua propria conta de saldo.
 *
 * O alias e obrigatorio na pratica (o default e o nome da tabela) porque a
 * subconsulta correlacionada precisa de distinguir o `id` da fatura do `id` do
 * recibo — sem qualificacao, o SQLite resolveria para o de dentro.
 */
export function balanceSqlExpr(alias = 'payments'): string {
  const col = `${alias}.`;
  return `(${col}amount_cve - COALESCE((`
    + ` SELECT SUM(r.amount_cve) FROM payment_receipts r`
    + ` WHERE r.payment_id = ${col}id AND r.voided_at IS NULL), 0))`;
}

/**
 * Caixa: cada escudo que ENTROU, contado uma vez so. Irma do `balanceSqlExpr`,
 * do outro lado da fatura — e existe pela mesma razao: para nenhum painel
 * inventar a sua propria definicao de dinheiro recebido.
 *
 * `source = 'credit'` fica de fora porque nao e dinheiro novo: o credito nasceu
 * de um recibo `cash` que ja contou. `voided_at` fica de fora porque um recibo
 * anulado nunca foi caixa.
 */
export function cashReceiptFilterSql(alias = 'r'): string {
  return `${alias}.source = 'cash' AND ${alias}.voided_at IS NULL`;
}

/** Total recebido (recibos nao anulados) numa fatura. */
export function receivedTotal(db: Database, paymentId: number): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_cve), 0) AS total
    FROM payment_receipts
    WHERE payment_id = ? AND voided_at IS NULL
  `).get(paymentId) as { total: number };
  return roundEscudos(row.total);
}

export function listPaymentReceipts(db: Database, paymentId: number): ReceiptRecord[] {
  return db.prepare(`${receiptSelect} WHERE payment_id = ? ORDER BY payment_date, id`).all(paymentId) as ReceiptRecord[];
}

/** Saldo do cliente na conta corrente: positivo e credito a favor dele. */
export function clientCreditBalance(db: Database, clientId: number): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_cve), 0) AS total FROM client_credits WHERE client_id = ?
  `).get(clientId) as { total: number };
  return roundEscudos(row.total);
}

type PaymentHead = {
  id: number;
  clientId: number;
  status: PaymentStatus;
  amountCve: number;
  invoiceDate: string | null;
  invoiceNumber: string | null;
  referenceMonth: string;
};

const paymentHeadSelect = `
  SELECT id, client_id AS clientId, status, amount_cve AS amountCve,
         invoice_date AS invoiceDate, invoice_number AS invoiceNumber,
         reference_month AS referenceMonth
  FROM payments WHERE id = ?
`;

function loadHead(db: Database, id: number): PaymentHead | undefined {
  return db.prepare(paymentHeadSelect).get(id) as PaymentHead | undefined;
}

/**
 * Escreve um recibo e fecha a fatura se ele a cobrir.
 *
 * Chamada de dentro de uma transacao: `allocateDocumentNumber` incrementa a
 * serie, e um numero alocado que nao chegue a pousar numa linha e um salto na
 * sequencia sem explicacao.
 */
function writeReceipt(
  db: Database,
  head: PaymentHead,
  input: {
    amountCve: number;
    paymentDate: string;
    paymentMethod: PaymentMethod;
    source: ReceiptSource;
    notes?: string | null;
    userId?: number | null;
  }
): ReceiptRecord {
  const receiptNumber = allocateDocumentNumber('receipt');
  const info = db.prepare(`
    INSERT INTO payment_receipts (
      payment_id, amount_cve, payment_date, payment_method, source,
      receipt_number, receipt_date, notes, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, date('now'), ?, ?)
  `).run(
    head.id,
    input.amountCve,
    input.paymentDate,
    input.paymentMethod,
    input.source,
    receiptNumber,
    input.notes ?? null,
    input.userId ?? null
  );

  const receipt = db.prepare(`${receiptSelect} WHERE id = ?`).get(Number(info.lastInsertRowid)) as ReceiptRecord;

  // A fatura fecha com os dados do recibo que a saldou — e esse o numero que o
  // PDF por fatura vai buscar, e a data que os relatorios de caixa ja liam
  // antes de existirem parciais.
  if (isSettled(head.amountCve - receivedTotal(db, head.id))) {
    db.prepare(`
      UPDATE payments
      SET status = 'paid', payment_method = ?, payment_date = ?,
          receipt_number = ?, receipt_date = COALESCE(receipt_date, date('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(input.paymentMethod, input.paymentDate, receipt.receiptNumber, head.id);
  }

  return receipt;
}

export type PayResult = {
  payment: PaymentRecord;
  receipt: ReceiptRecord;
  /** Excesso que foi parar a conta corrente do cliente (0 quando nao sobrou). */
  creditAddedCve: number;
  balanceCve: number;
  settled: boolean;
};

/**
 * Regista dinheiro recebido por conta de uma fatura.
 *
 * Sem `amountCve` recebe o saldo todo — e o comportamento de sempre, e e o que
 * mantem os chamadores antigos (pagamento em massa incluido) a funcionar sem
 * saberem que os parciais existem.
 *
 * O que exceder o saldo nao se perde nem fecha a fatura duas vezes: vira
 * credito do cliente, abatido na fatura seguinte.
 */
export function payPayment(
  db: Database,
  id: number,
  input: { paymentMethod: PaymentMethod; paymentDate?: string; amountCve?: number; notes?: string | null; userId?: number | null }
): PaymentOpResult<PayResult> {
  const head = loadHead(db, id);
  if (!head) {
    return { ok: false, status: 404, error: 'Pagamento nao encontrado' };
  }
  if (head.status === 'cancelled') {
    return { ok: false, status: 400, error: 'Pagamento anulado nao pode ser pago' };
  }

  const paymentDate = input.paymentDate || todayIso();
  // A data de pagamento nao pode ser anterior a emissao da fatura.
  const { errors } = validatePaymentDates({ dataEmissao: head.invoiceDate, dataPagamento: paymentDate });
  if (errors.length) {
    return { ok: false, status: 400, error: errors.join(' ') };
  }

  const balance = roundEscudos(head.amountCve - receivedTotal(db, id));
  if (isSettled(balance)) {
    return { ok: false, status: 400, error: 'Fatura ja esta totalmente recebida' };
  }

  const requested = input.amountCve === undefined ? balance : roundEscudos(input.amountCve);
  if (!Number.isFinite(requested) || escudosToCentavos(requested) <= 0) {
    return { ok: false, status: 400, error: 'Valor recebido tem de ser positivo' };
  }

  const applied = Math.min(requested, balance);
  const excess = roundEscudos(requested - applied);

  const value = db.transaction(() => {
    const receipt = writeReceipt(db, head, {
      amountCve: applied,
      paymentDate,
      paymentMethod: input.paymentMethod,
      source: 'cash',
      notes: input.notes,
      userId: input.userId
    });

    if (escudosToCentavos(excess) > 0) {
      db.prepare(`
        INSERT INTO client_credits (client_id, amount_cve, receipt_id, reason)
        VALUES (?, ?, ?, ?)
      `).run(head.clientId, excess, receipt.id, `Excesso do recibo ${receipt.receiptNumber}`);
    }

    const remaining = roundEscudos(head.amountCve - receivedTotal(db, id));
    return {
      payment: selectPayment(db, id)!,
      receipt,
      creditAddedCve: excess,
      balanceCve: remaining,
      settled: isSettled(remaining)
    };
  })();

  return { ok: true, value };
}

/**
 * Abate o credito do cliente numa fatura em aberto.
 *
 * O recibo sai com `source = 'credit'`: a fatura fica liquidada, mas nao entrou
 * dinheiro novo — entrou quando o credito nasceu. Conta-lo outra vez na caixa
 * do mes duplicava a receita.
 *
 * Devolve o recibo, ou `null` quando nao havia credito ou saldo para mexer —
 * e chamada da geracao mensal, onde a maioria dos clientes nao tem credito
 * nenhum e nada disso e um erro.
 */
export function applyClientCreditToPayment(
  db: Database,
  paymentId: number,
  userId?: number | null
): ReceiptRecord | null {
  const head = loadHead(db, paymentId);
  if (!head || head.status === 'cancelled' || head.status === 'paid') return null;

  const balance = roundEscudos(head.amountCve - receivedTotal(db, paymentId));
  const credit = clientCreditBalance(db, head.clientId);
  const applied = roundEscudos(Math.min(balance, credit));
  if (escudosToCentavos(applied) <= 0) return null;

  return db.transaction(() => {
    const receipt = writeReceipt(db, head, {
      amountCve: applied,
      paymentDate: todayIso(),
      paymentMethod: 'outro',
      source: 'credit',
      notes: 'Liquidado por conta corrente',
      userId
    });
    db.prepare(`
      INSERT INTO client_credits (client_id, amount_cve, receipt_id, reason)
      VALUES (?, ?, ?, ?)
    `).run(head.clientId, -applied, receipt.id, `Aplicado na fatura ${head.invoiceNumber || head.referenceMonth}`);
    return receipt;
  })();
}

/**
 * Anula um recibo mal lancado (o classico 100.000 onde eram 10.000).
 *
 * O numero nao se recicla nem desaparece — documento numerado anula-se, fica, e
 * deixa o motivo escrito. A fatura reabre se este recibo era o que a fechava, e
 * o lancamento de conta corrente que dele nasceu e revertido pelo simetrico,
 * para o razao continuar a somar certo.
 */
export function voidReceipt(db: Database, id: number, rawReason: string | null | undefined): PaymentOpResult<{
  receipt: ReceiptRecord;
  paymentId: number;
  reopened: boolean;
  balanceCve: number;
}> {
  const receipt = db.prepare(`${receiptSelect} WHERE id = ?`).get(id) as ReceiptRecord | undefined;
  if (!receipt) {
    return { ok: false, status: 404, error: 'Recibo nao encontrado' };
  }
  if (receipt.voidedAt) {
    return { ok: false, status: 400, error: 'Recibo ja esta anulado' };
  }

  const reason = rawReason?.trim() || '';
  if (reason.length < 10) {
    return { ok: false, status: 400, error: `Anular o recibo ${receipt.receiptNumber} exige um motivo detalhado (minimo 10 caracteres).` };
  }

  const head = loadHead(db, receipt.paymentId);
  if (!head) {
    return { ok: false, status: 404, error: 'Pagamento nao encontrado' };
  }
  if (head.status === 'cancelled') {
    return { ok: false, status: 400, error: 'Fatura anulada: o recibo ja nao pode ser mexido' };
  }

  const value = db.transaction(() => {
    db.prepare(`
      UPDATE payment_receipts SET voided_at = datetime('now'), void_reason = ? WHERE id = ?
    `).run(reason, id);

    // Simetrico do lancamento que este recibo gerou (excesso a favor ou uso do
    // credito), qualquer que tenha sido o sentido.
    const ledger = db.prepare(`
      SELECT COALESCE(SUM(amount_cve), 0) AS total FROM client_credits WHERE receipt_id = ?
    `).get(id) as { total: number };
    if (escudosToCentavos(ledger.total) !== 0) {
      db.prepare(`
        INSERT INTO client_credits (client_id, amount_cve, receipt_id, reason)
        VALUES (?, ?, ?, ?)
      `).run(head.clientId, -ledger.total, id, `Estorno do recibo ${receipt.receiptNumber}`);
    }

    const remaining = roundEscudos(head.amountCve - receivedTotal(db, head.id));
    const reopened = head.status === 'paid' && !isSettled(remaining);
    if (reopened) {
      // O recibo da fatura passa a ser o ultimo que ainda vale; se nao sobrou
      // nenhum, a fatura volta a nao ter recibo — como antes de alguem pagar.
      const survivor = db.prepare(`
        SELECT receipt_number AS receiptNumber, receipt_date AS receiptDate,
               payment_date AS paymentDate, payment_method AS paymentMethod
        FROM payment_receipts
        WHERE payment_id = ? AND voided_at IS NULL
        ORDER BY payment_date DESC, id DESC LIMIT 1
      `).get(head.id) as { receiptNumber: string; receiptDate: string; paymentDate: string; paymentMethod: string } | undefined;

      db.prepare(`
        UPDATE payments
        SET status = 'pending',
            payment_date = ?, payment_method = ?, receipt_number = ?, receipt_date = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(
        survivor?.paymentDate ?? null,
        survivor?.paymentMethod ?? null,
        survivor?.receiptNumber ?? null,
        survivor?.receiptDate ?? null,
        head.id
      );
    }

    return {
      receipt: db.prepare(`${receiptSelect} WHERE id = ?`).get(id) as ReceiptRecord,
      paymentId: head.id,
      reopened,
      balanceCve: remaining
    };
  })();

  return { ok: true, value };
}

/**
 * "Vencido" deriva da data, não do estado: `status = 'overdue'` só aparece
 * quando alguém marca o pagamento à mão (markPaymentOverdue), por isso um
 * read model que conte só esse estado dá zero enquanto há dívida real na
 * carteira. Todos os painéis partilham este predicado para não discordarem.
 */
export function overdueSqlPredicate(alias = ''): string {
  const col = alias ? `${alias}.` : '';
  return `(${col}status = 'overdue'`
    + ` OR (${col}status = 'pending' AND date(${col}due_date) < date('now')))`;
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
  /** Recebido que passou a credito do cliente (0 quando nada tinha entrado). */
  creditedCve: number;
}> {
  const payment = db.prepare(`
    SELECT id, client_id AS clientId, status, notes, amount_cve AS amountCve,
           invoice_number AS invoiceNumber, receipt_number AS receiptNumber,
           reference_month AS referenceMonth
    FROM payments WHERE id = ?
  `).get(id) as {
    id: number;
    clientId: number;
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
  const received = receivedTotal(db, id);
  const wasPaid = payment.status === 'paid';
  // Uma fatura meio recebida nao e um rascunho: mexer nela exige a mesma
  // justificacao que mexer numa ja paga.
  if (!wasPaid && received > 0 && reason.length < 10) {
    return {
      ok: false,
      status: 400,
      error: 'Anular fatura com recebimentos registados exige um motivo detalhado (minimo 10 caracteres).'
    };
  }
  if (wasPaid && reason.length < 10) {
    return { ok: false, status: 400, error: 'Anular pagamento ja registado exige um motivo detalhado (minimo 10 caracteres).' };
  }
  // Anular passou a ser a única saída para um documento numerado (reverter
  // recusa-o). Se a anulação não deixar motivo, o rasto fica pior do que era.
  if (!wasPaid && payment.invoiceNumber && reason.length < 10) {
    return {
      ok: false,
      status: 400,
      error: `Anular a fatura ${payment.invoiceNumber} exige um motivo detalhado (minimo 10 caracteres).`
    };
  }

  const stampedReason = reason
    ? wasPaid
      ? `[ANULACAO POS-PAGAMENTO] ${reason}`
      : reason
    : '';
  const notes = stampedReason
    ? [payment.notes?.trim(), stampedReason].filter(Boolean).join('\n')
    : payment.notes;

  db.transaction(() => {
    db.prepare(`
      UPDATE payments
      SET status = 'cancelled',
          notes = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(notes || null, id);

    // O dinheiro nao se anula com o documento: fica a favor do cliente, para
    // abater na fatura seguinte. Sem isto, anular uma fatura meio paga era o
    // mesmo que ficar com o dinheiro dele sem deixar rasto.
    if (escudosToCentavos(received) > 0) {
      db.prepare(`
        INSERT INTO client_credits (client_id, amount_cve, receipt_id, reason)
        VALUES (?, ?, NULL, ?)
      `).run(
        payment.clientId,
        received,
        `Recebido na fatura ${payment.invoiceNumber || payment.referenceMonth}, anulada`
      );
    }
  })();

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
      referenceMonth: payment.referenceMonth,
      creditedCve: received
    }
  };
}
