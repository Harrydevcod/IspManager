import { getSqliteDatabase } from '../db/database';

const DEFAULT_INVOICE_PREFIX = 'FT';
const DEFAULT_RECEIPT_PREFIX = 'RC';

export type DocumentKind = 'invoice' | 'receipt';

export function readDocumentPrefix(kind: DocumentKind): string {
  const db = getSqliteDatabase();
  const key = kind === 'invoice' ? 'invoicePrefix' : 'receiptPrefix';
  const fallback = kind === 'invoice' ? DEFAULT_INVOICE_PREFIX : DEFAULT_RECEIPT_PREFIX;
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  const raw = row?.value?.trim();
  return raw && raw.length > 0 ? raw : fallback;
}

/**
 * Allocates the next sequential number for a document series, atomically.
 *
 * Series = the configured prefix (FT/RC by default). The counter resets each
 * calendar year and is independent per series, producing gap-free sequences
 * like `FT-2026-00001`, `FT-2026-00002`, … and a separate `RC-2026-00001` run.
 *
 * The allocation mutates `document_sequences`, so it is a side-effecting call,
 * not a pure formatter. The single UPSERT…RETURNING is atomic; callers that
 * also persist the number onto a row should wrap both in one transaction so a
 * mid-flight failure never burns a number without recording it.
 *
 * NEVER reuse a number once allocated — that is the whole point. A gap from a
 * crashed emission is acceptable; a duplicate is not.
 */
export function allocateDocumentNumber(kind: DocumentKind): string {
  const db = getSqliteDatabase();
  const series = readDocumentPrefix(kind);
  const year = new Date().getFullYear();
  const row = db.prepare(`
    INSERT INTO document_sequences (series, year, last_number)
    VALUES (?, ?, 1)
    ON CONFLICT(series, year) DO UPDATE SET last_number = last_number + 1
    RETURNING last_number
  `).get(series, year) as { last_number: number };
  return `${series}-${year}-${String(row.last_number).padStart(5, '0')}`;
}
