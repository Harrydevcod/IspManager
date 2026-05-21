import type { Database as DatabaseType } from 'better-sqlite3';
import { nextDocumentNumber } from './numbering';

export type BillingPreviewRow = {
  serviceId: number;
  clientId: number;
  clientName: string;
  planName: string | null;
  amountCve: number;
  dueDate: string;
};

export type BillingPreview = {
  referenceMonth: string;
  activeServices: number;
  alreadyBilled: number;
  toCreate: BillingPreviewRow[];
  totalCve: number;
};

export function dueDateFor(referenceMonth: string, dueDay: number): string {
  const [year, month] = referenceMonth.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return `${referenceMonth}-${String(Math.min(dueDay, lastDay)).padStart(2, '0')}`;
}

/**
 * Read-only diff: what `generateMonthlyBilling` would create. Used by the
 * preview endpoint and by the actual generator. No writes.
 */
export function computeMonthlyBilling(db: DatabaseType, referenceMonth: string): BillingPreview {
  const services = db.prepare(`
    SELECT
      s.id AS serviceId,
      s.client_id AS clientId,
      c.full_name AS clientName,
      p.name AS planName,
      s.monthly_value_cve AS amountCve,
      s.due_day AS dueDay
    FROM services s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
    WHERE s.status = 'active'
    ORDER BY c.full_name
  `).all() as Array<BillingPreviewRow & { dueDay: number }>;

  const existsStmt = db.prepare('SELECT 1 AS hit FROM payments WHERE service_id = ? AND reference_month = ?');
  const toCreate: BillingPreviewRow[] = [];
  let alreadyBilled = 0;

  for (const svc of services) {
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
      amountCve: svc.amountCve,
      dueDate: dueDateFor(referenceMonth, svc.dueDay)
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
      client_id, service_id, reference_month, amount_cve, due_date,
      status, invoice_number, invoice_date, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'pending', NULL, date('now'), datetime('now'), datetime('now'))
  `);
  const updateInvoice = db.prepare('UPDATE payments SET invoice_number = ? WHERE id = ? AND invoice_number IS NULL');

  const run = db.transaction(() => {
    for (const item of preview.toCreate) {
      const inserted = insert.run(
        item.clientId,
        item.serviceId,
        referenceMonth,
        item.amountCve,
        item.dueDate
      );
      updateInvoice.run(nextDocumentNumber('invoice', Number(inserted.lastInsertRowid)), Number(inserted.lastInsertRowid));
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
