import type { Migration } from './types';

/**
 * Rebuilds `payments` so the `status` CHECK includes 'cancelled'.
 *
 * The original 0001 migration shipped with the older 3-status CHECK
 * (pending, paid, overdue). Databases created at that time keep the
 * stale constraint even after 0001 was edited to declare 'cancelled',
 * because CREATE TABLE IF NOT EXISTS is a no-op once the table exists.
 * As a result, every UPDATE payments SET status='cancelled' on those
 * installs raised SQLITE_CONSTRAINT_CHECK, breaking the anular flow.
 *
 * SQLite cannot alter a CHECK constraint in place, so this migration
 * follows the standard rebuild pattern: create the corrected table,
 * copy rows, drop the old one, rename. The migration runner already
 * wraps SQL in a transaction; foreign_keys is OFF in this app (no
 * PRAGMA enables it), so the rebuild is safe.
 */
const migration: Migration = {
  version: 4,
  name: 'payments_status_check',
  sql: `
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(service_id, reference_month)
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
  `
};

export default migration;
