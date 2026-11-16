import type { Migration } from './types';

/**
 * SMS em paridade com o WhatsApp: o lembrete antes do vencimento e o atraso prolongado têm o seu
 * tipo, o reposto deixa de partilhar o da avaria, e entram a mensagem geral e o aviso de
 * manutenção. O CHECK só muda reconstruindo a tabela (como na 0096 e na 0107).
 */
const migration: Migration = {
  version: 110,
  name: 'sms_event_types_parity',
  sql: `
    CREATE TABLE sms_outbox_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id),
      payment_id INTEGER REFERENCES payments(id),
      service_id INTEGER REFERENCES services(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('invoice_issued','receipt_confirmed','payment_reminder','payment_overdue','payment_warning','suspension_notice','test','fup_notice','outage_notice','outage_restored','general','maintenance_notice')),
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      failed_at TEXT,
      delivered_at TEXT
    );
    INSERT INTO sms_outbox_new (id, client_id, payment_id, service_id, event_type, to_phone, body, status, attempts, max_attempts,
      last_error, next_attempt_at, android_request_id, approved_at, sent_at, rejected_at, created_at, updated_at, failed_at, delivered_at)
    SELECT id, client_id, payment_id, service_id, event_type, to_phone, body, status, attempts, max_attempts,
      last_error, next_attempt_at, android_request_id, approved_at, sent_at, rejected_at, created_at, updated_at, failed_at, delivered_at
    FROM sms_outbox;
    DROP TABLE sms_outbox;
    ALTER TABLE sms_outbox_new RENAME TO sms_outbox;
    CREATE INDEX idx_sms_outbox_ready ON sms_outbox(status, next_attempt_at);
    CREATE INDEX idx_sms_outbox_payment_event ON sms_outbox(payment_id, event_type);
    CREATE UNIQUE INDEX idx_sms_outbox_android_request ON sms_outbox(android_request_id) WHERE android_request_id IS NOT NULL;
    CREATE INDEX idx_sms_outbox_created_status ON sms_outbox(created_at, status);
  `
};
export default migration;
