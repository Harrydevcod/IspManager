import type { Database as DatabaseType } from 'better-sqlite3';
import { nextDocumentNumber } from './numbering';
import { loadAudiovisualConfig } from './audiovisual';

export type BillingLine = {
  kind: 'internet' | 'audiovisual';
  description: string;
  amountCve: number;
};

export type BillingPreviewRow = {
  serviceId: number;
  clientId: number;
  clientName: string;
  planName: string | null;
  amountCve: number;
  dueDate: string;
  /** Composição da fatura (1+ linhas). O `amountCve` é a soma destas linhas. */
  lines: BillingLine[];
};

const INTERNET_LINE_DESCRIPTION = 'Servico de Internet';

/**
 * Composição mensal de um serviço: linha de internet (se houver mensalidade) +
 * linha audiovisual (se a modalidade for mensal). A anuidade NÃO entra aqui — é
 * faturada à parte. Fonte única usada pela geração mensal e pela regeneração de
 * uma mensalidade anulada, para que o total nunca divirja entre os dois caminhos.
 */
export function buildMonthlyServiceLines(
  svc: { monthlyValueCve: number; audiovisualMode: 'none' | 'monthly' | 'annual'; audiovisualMonthlyCve: number },
  audiovisualLabel: string
): BillingLine[] {
  const lines: BillingLine[] = [];
  if (svc.monthlyValueCve > 0) {
    lines.push({ kind: 'internet', description: INTERNET_LINE_DESCRIPTION, amountCve: svc.monthlyValueCve });
  }
  if (svc.audiovisualMode === 'monthly' && svc.audiovisualMonthlyCve > 0) {
    lines.push({ kind: 'audiovisual', description: audiovisualLabel, amountCve: svc.audiovisualMonthlyCve });
  }
  return lines;
}

export function sumLines(lines: BillingLine[]): number {
  return lines.reduce((total, line) => total + line.amountCve, 0);
}

export type BillingPreview = {
  referenceMonth: string;
  activeServices: number;
  alreadyBilled: number;
  toCreate: BillingPreviewRow[];
  totalCve: number;
};

/**
 * Política fiscal: vencimento padrão = data de emissão + 30 dias (≈ um mês).
 * Mantemos a assinatura antiga (referenceMonth, dueDay) por compatibilidade
 * mas o cálculo passou a ser independente desses argumentos.
 */
export const PAYMENT_DUE_DAYS = 30;

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function dueDateFromIssue(issueIso: string, days: number = PAYMENT_DUE_DAYS): string {
  const issue = new Date(`${issueIso}T00:00:00Z`);
  if (Number.isNaN(issue.getTime())) return issueIso;
  issue.setUTCDate(issue.getUTCDate() + days);
  return issue.toISOString().slice(0, 10);
}

// kept for back-compat with callers that still pass the old signature
export function dueDateFor(_referenceMonth: string, _dueDay: number): string {
  return dueDateFromIssue(todayIso(), PAYMENT_DUE_DAYS);
}

/**
 * Read-only diff: what `generateMonthlyBilling` would create. Used by the
 * preview endpoint and by the actual generator. No writes.
 */
export function computeMonthlyBilling(db: DatabaseType, referenceMonth: string): BillingPreview {
  const audiovisual = loadAudiovisualConfig(db);
  const services = db.prepare(`
    SELECT
      s.id AS serviceId,
      s.client_id AS clientId,
      c.full_name AS clientName,
      p.name AS planName,
      s.monthly_value_centavos / 100.0 AS monthlyValueCve,
      s.audiovisual_mode AS audiovisualMode,
      s.audiovisual_monthly_centavos / 100.0 AS audiovisualMonthlyCve,
      s.due_day AS dueDay
    FROM services s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
    WHERE s.status = 'active'
      -- Regra de negócio: clientes cancelados não geram mensalidades, mesmo
      -- que um serviço tenha ficado 'active'. O cancelamento do cliente não
      -- propaga automaticamente para os serviços, por isso filtramos aqui.
      AND c.status != 'cancelled'
    ORDER BY c.full_name
  `).all() as Array<{
    serviceId: number;
    clientId: number;
    clientName: string;
    planName: string | null;
    monthlyValueCve: number;
    audiovisualMode: 'none' | 'monthly' | 'annual';
    audiovisualMonthlyCve: number;
    dueDay: number;
  }>;

  // Só uma cobrança *não anulada* por serviço/mês bloqueia a geração. Uma
  // cobrança anulada deixa o slot livre para reemitir a fatura corrigida — o
  // registo anulado permanece (índice único parcial em payments permite-o).
  const existsStmt = db.prepare(`SELECT 1 AS hit FROM payments WHERE service_id = ? AND reference_month = ? AND status != 'cancelled'`);
  const toCreate: BillingPreviewRow[] = [];
  let alreadyBilled = 0;

  // Vencimento = data de emissão + 30 dias (todas as faturas geradas nesta corrida
  // partilham a mesma data de emissão, hoje).
  const issueIso = todayIso();
  const dueIso = dueDateFromIssue(issueIso, PAYMENT_DUE_DAYS);

  for (const svc of services) {
    const lines = buildMonthlyServiceLines(svc, audiovisual.label);
    const total = sumLines(lines);
    // Serviço sem valor mensal (ex.: standalone anual) não gera fatura mensal vazia.
    if (total <= 0) continue;

    const hit = existsStmt.get(svc.serviceId, referenceMonth) as { hit: number } | undefined;
    if (hit) {
      alreadyBilled += 1;
      continue;
    }
    toCreate.push({
      serviceId: svc.serviceId,
      clientId: svc.clientId,
      clientName: svc.clientName,
      planName: svc.planName,
      amountCve: total,
      dueDate: dueIso,
      lines
    });
  }

  const totalCve = toCreate.reduce((sum, item) => sum + item.amountCve, 0);
  return {
    referenceMonth,
    activeServices: services.length,
    alreadyBilled,
    toCreate,
    totalCve
  };
}

/**
 * Idempotent generator: inserts payments for `toCreate` items, assigns the
 * next invoice number for each. Returns the count created and the preview
 * snapshot that drove the inserts.
 */
export function generateMonthlyBilling(db: DatabaseType, referenceMonth: string): {
  referenceMonth: string;
  activeServices: number;
  created: number;
  preview: BillingPreview;
} {
  const preview = computeMonthlyBilling(db, referenceMonth);

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
    VALUES (?, ?, ?, CAST(ROUND(? * 100) AS INTEGER), ?)
  `);

  const run = db.transaction(() => {
    for (const item of preview.toCreate) {
      const inserted = insert.run(
        item.clientId,
        item.serviceId,
        referenceMonth,
        item.amountCve,
        item.dueDate
      );
      const paymentId = Number(inserted.lastInsertRowid);
      updateInvoice.run(nextDocumentNumber('invoice', paymentId), paymentId);
      item.lines.forEach((line, index) => {
        insertLine.run(paymentId, line.kind, line.description, line.amountCve, index);
      });
    }
  });

  run();

  return {
    referenceMonth,
    activeServices: preview.activeServices,
    created: preview.toCreate.length,
    preview
  };
}
