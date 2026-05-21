import { getSqliteDatabase } from '../db/database';

const DEFAULT_INVOICE_PREFIX = 'FT';
const DEFAULT_RECEIPT_PREFIX = 'RC';

export function readDocumentPrefix(kind: 'invoice' | 'receipt'): string {
  const db = getSqliteDatabase();
  const key = kind === 'invoice' ? 'invoicePrefix' : 'receiptPrefix';
  const fallback = kind === 'invoice' ? DEFAULT_INVOICE_PREFIX : DEFAULT_RECEIPT_PREFIX;
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  const raw = row?.value?.trim();
  return raw && raw.length > 0 ? raw : fallback;
}

export function nextDocumentNumber(kind: 'invoice' | 'receipt', id: number): string {
  const prefix = readDocumentPrefix(kind);
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(id).padStart(5, '0')}`;
}
