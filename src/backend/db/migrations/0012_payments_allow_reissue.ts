import type { Migration } from './types';

/**
 * Allows a corrected payment/invoice to be re-issued for a (service, month)
 * after the original was anulado.
 *
 * The 0001/0004 `payments` table carried a rigid `UNIQUE(service_id,
 * reference_month)` table constraint — one payment per service per month,
 * forever. That made anulação a dead end: the cancelled row keeps the slot,
 * so re-running the month's billing could neither find a gap (the idempotency
 * check counted the cancelled row) nor insert a replacement (UNIQUE violation).
 *
 * Fiscal model (CV): never delete a document — the anulada row stays as the
 * permanent record, and the correction is a NEW document with the next
 * sequential number. So we replace the rigid table constraint with a PARTIAL
 * unique index that only covers non-cancelled rows:
 *
 *   UNIQUE(service_id, reference_month) WHERE status != 'cancelled'
 *
 * This keeps the real invariant ("at most one ACTIVE payment per service/month")
 * while permitting any number of cancelled rows alongside it. The billing
 * idempotency check is updated in lib/billing.ts to ignore cancelled rows.
 *
 * SQLite cannot drop a table-level UNIQUE in place, so we follow the standard
 * rebuild pattern (create → copy → drop → rename). `payments` is referenced by
 * `whatsapp_notices(payment_id)` and foreign_keys is ON at runtime, so we use
 * `PRAGMA defer_foreign_keys = ON` (the runner wraps each migration in a
 * transaction; `foreign_keys` cannot be toggled inside one, but
 * `defer_foreign_keys` can). FK integrity is re-checked at COMMIT, by which
 * point the rebuilt table exists with the same `id`s, so the references hold.
 */
const migration: Migration = {
  version: 12,
  name: 'payments_allow_reissue',
  sql: `
    PRAGMA defer_foreign_keys = ON;

    CREATE TABLE payments_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      service_id INTEGER NOT NULL REFERENCES services(id),
      reference_month TEXT NOT NULL,
      amount_cve REAL NOT NULL,
      due_date TEXT NOT NULL,
      payment_date TEXT,
      payment_method TEXT CHECK(payment_method IN ('numerario','transferencia','outro')),
      status TEXT NOT NULL CHECK(status IN ('pending','paid','overdue','cancelled')) DEFAULT 'pending',
      invoice_number TEXT,
      invoice_date TEXT,
      receipt_number TEXT,
      receipt_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO payments_new (
      id, client_id, service_id, reference_month, amount_cve, due_date,
      payment_date, payment_method, status, invoice_number, invoice_date,
      receipt_number, receipt_date, notes, created_at, updated_at
    )
    SELECT
      id, client_id, service_id, reference_month, amount_cve, due_date,
      payment_date, payment_method, status, invoice_number, invoice_date,
      receipt_number, receipt_date, notes, created_at, updated_at
    FROM payments;

    DROP TABLE payments;
    ALTER TABLE payments_new RENAME TO payments;

    CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(reference_month);

    -- At most one non-cancelled payment per (service, month); cancelled rows
    -- are unconstrained so anulação + reemissão can coexist.
    CREATE UNIQUE INDEX idx_payments_service_month_active
      ON payments(service_id, reference_month) WHERE status != 'cancelled';
  `
};

export default migration;
