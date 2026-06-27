import type { Migration } from './types';

/**
 * Real per-series, per-year sequential document numbering.
 *
 * Until now invoice/receipt numbers were derived from the payment row id:
 * `nextDocumentNumber(kind, paymentId)` produced `PREFIX-YEAR-{id}`. That has
 * three fiscal defects:
 *   1. Gaps — any payment created but never turned into a document (or a
 *      cancelled row) leaves a hole in the printed sequence.
 *   2. No yearly reset — the id keeps growing, so 2027 continues from where
 *      2026 left off instead of restarting at 1.
 *   3. Shared pool — invoices (FT) and receipts (RC) both draw from the same id
 *      sequence, so neither series is contiguous on its own.
 *
 * This migration introduces `document_sequences`, an atomic counter keyed by
 * (series, year). The series is the configured prefix (FT/RC by default), so a
 * deliberate prefix change starts a fresh series — the correct fiscal model.
 * Allocation lives in lib/numbering.ts (`allocateDocumentNumber`).
 *
 * Seeding is the delicate part: an existing field database already printed
 * id-based numbers, and the new allocator must never re-issue one. We seed
 * `last_number` to the highest number already emitted per (series, year),
 * parsed from the stored `invoice_number` / `receipt_number` strings. New
 * allocations continue from max+1, so historical numbers stay untouched (their
 * gaps are frozen as history) and nothing collides going forward.
 *
 * Parsing assumes the `PREFIX-YEAR-NUMBER` shape with a dash-free prefix and a
 * 4-digit year — exactly what nextDocumentNumber/readDocumentPrefix have ever
 * produced. Rows that don't match `%-%-%` are ignored.
 *
 * The partial unique indexes on invoice_number / receipt_number lock the
 * "every issued number is unique" invariant at the schema level. Historical
 * id-based numbers are already globally unique (id is the PK), so adding them
 * is safe.
 */
const migration: Migration = {
  version: 20,
  name: 'document_sequences',
  sql: `
    CREATE TABLE document_sequences (
      series TEXT NOT NULL,
      year INTEGER NOT NULL,
      last_number INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (series, year)
    );

    WITH issued(num_str) AS (
      SELECT invoice_number FROM payments
        WHERE invoice_number IS NOT NULL AND invoice_number LIKE '%-%-%'
      UNION ALL
      SELECT receipt_number FROM payments
        WHERE receipt_number IS NOT NULL AND receipt_number LIKE '%-%-%'
    ),
    split AS (
      SELECT
        substr(num_str, 1, instr(num_str, '-') - 1)        AS series,
        substr(num_str, instr(num_str, '-') + 1)           AS rest
      FROM issued
    ),
    parsed AS (
      SELECT
        series,
        CAST(substr(rest, 1, instr(rest, '-') - 1) AS INTEGER) AS year,
        CAST(substr(rest, instr(rest, '-') + 1)    AS INTEGER) AS num
      FROM split
    )
    INSERT INTO document_sequences (series, year, last_number)
    SELECT series, year, MAX(num)
    FROM parsed
    GROUP BY series, year;

    CREATE UNIQUE INDEX idx_payments_invoice_number
      ON payments(invoice_number) WHERE invoice_number IS NOT NULL;
    CREATE UNIQUE INDEX idx_payments_receipt_number
      ON payments(receipt_number) WHERE receipt_number IS NOT NULL;
  `
};

export default migration;
