import type { Migration } from './types';

/**
 * Audit log of WhatsApp overdue/suspension notices actually delivered.
 *
 * This table is the backend source of truth for "was a notice already sent",
 * replacing the renderer's per-browser localStorage marker. It serves two
 * jobs at once:
 *  - idempotency for the automatic control job (`runOverdueNoticesIfDue`),
 *    which dedupes by (payment_id, notice_type) inside a cooldown window, and
 *  - the operational audit trail required for customer communications.
 *
 * Both the manual route and the automatic job append here, so the dedupe
 * window covers human-triggered sends too. `origin` distinguishes them.
 */
const migration: Migration = {
  version: 11,
  name: 'whatsapp_notices',
  sql: `
    CREATE TABLE IF NOT EXISTS whatsapp_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      client_id INTEGER NOT NULL REFERENCES clients(id),
      notice_type TEXT NOT NULL CHECK(notice_type IN ('overdue', 'suspension')),
      origin TEXT NOT NULL CHECK(origin IN ('auto', 'manual')) DEFAULT 'auto',
      phone TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sent', 'failed')) DEFAULT 'sent',
      error TEXT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_notices_dedupe
      ON whatsapp_notices(payment_id, notice_type, sent_at);
  `
};

export default migration;
