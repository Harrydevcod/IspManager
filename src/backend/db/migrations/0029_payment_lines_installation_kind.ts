import type { Migration } from './types';

/**
 * Rebuilds `payment_lines` so the `kind` CHECK also accepts 'instalacao' —
 * a one-time installation-fee line, issued when a service is created for a
 * plan with a non-zero `installation_fee_cve`.
 *
 * SQLite cannot alter a CHECK constraint in place, so this follows the same
 * rebuild pattern as 0004/0018 (PRAGMA defer_foreign_keys so the mid-transaction
 * DROP TABLE doesn't trip the payment_lines -> payments FK).
 */
const migration: Migration = {
  version: 29,
  name: 'payment_lines_installation_kind',
  sql: `
    PRAGMA defer_foreign_keys = ON;

    CREATE TABLE payment_lines_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      kind TEXT NOT NULL CHECK(kind IN ('internet','audiovisual','instalacao')),
      description TEXT NOT NULL,
      amount_cve REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO payment_lines_new (id, payment_id, kind, description, amount_cve, sort_order, created_at)
    SELECT id, payment_id, kind, description, amount_cve, sort_order, created_at
    FROM payment_lines;

    DROP TABLE payment_lines;
    ALTER TABLE payment_lines_new RENAME TO payment_lines;

    CREATE INDEX IF NOT EXISTS idx_payment_lines_payment ON payment_lines(payment_id);
  `
};

export default migration;
