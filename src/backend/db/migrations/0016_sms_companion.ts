import type { Migration } from './types';

const migration: Migration = {
  version: 16,
  name: 'sms_companion',
  sql: `
    CREATE TABLE IF NOT EXISTS sms_companion_pairing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_name TEXT,
      base_url TEXT,
      pairing_key_hash TEXT,
      paired_at TEXT,
      revoked_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        paired_at IS NULL
        OR (
          pairing_key_hash IS NOT NULL
          AND length(pairing_key_hash) = 64
          AND base_url IS NOT NULL
          AND length(trim(base_url)) > 0
        )
      ),
      CHECK (revoked_at IS NULL OR paired_at IS NOT NULL),
      CHECK (revoked_at IS NULL OR revoked_at >= paired_at)
    );

    CREATE TABLE IF NOT EXISTS sms_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id),
      payment_id INTEGER REFERENCES payments(id),
      service_id INTEGER REFERENCES services(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('invoice_issued','receipt_confirmed','payment_overdue','suspension_notice','test')),
      to_phone TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending_dispatch','pending_approval','approved','sent','failed','rejected','cancelled')) DEFAULT 'pending_dispatch',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      next_attempt_at TEXT,
      android_request_id TEXT,
      approved_at TEXT,
      sent_at TEXT,
      rejected_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sms_outbox_ready ON sms_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_sms_outbox_payment_event ON sms_outbox(payment_id, event_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_outbox_android_request ON sms_outbox(android_request_id) WHERE android_request_id IS NOT NULL;
  `
};

export default migration;
