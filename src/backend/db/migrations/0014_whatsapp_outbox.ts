import type { Migration } from './types';

/**
 * Persistent WhatsApp send queue. Every outbound message (manual, automatic
 * notice, or document attachment) becomes a row here; an in-process worker
 * drains it with retry/backoff and a poller advances delivery status. Documents
 * store a reference (payment + kind) and are regenerated at send time.
 */
const migration: Migration = {
  version: 14,
  name: 'whatsapp_outbox',
  sql: `
    CREATE TABLE IF NOT EXISTS whatsapp_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      to_phone TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('text','document')) DEFAULT 'text',
      body TEXT,
      doc_payment_id INTEGER REFERENCES payments(id),
      doc_kind TEXT CHECK(doc_kind IN ('invoice','receipt')),
      client_id INTEGER REFERENCES clients(id),
      origin TEXT NOT NULL CHECK(origin IN ('manual','auto')) DEFAULT 'manual',
      provider TEXT NOT NULL DEFAULT 'ultramsg',
      provider_message_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','sent','delivered','read','failed','cancelled')) DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wa_outbox_ready ON whatsapp_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_wa_outbox_provider_msg ON whatsapp_outbox(provider_message_id);
  `
};

export default migration;
