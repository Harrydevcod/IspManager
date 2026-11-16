import type { Migration } from './types';

/**
 * Aviso de avaria aos clientes a jusante de um equipamento do backbone em baixo.
 *
 * - `incident_notices`: um aviso por incidente, cliente e tipo. Os incidentes não têm tabela
 *   (derivam das transições da sonda); a chave é `NetworkIncident.key` (`deviceId:startedAt`).
 *   A chave única é o que impede um segundo aviso, e o `reposto` só vai a quem teve o `avaria`.
 * - `sms_outbox`: o SMS de avaria precisa do seu tipo; o CHECK só muda reconstruindo a tabela.
 */
const migration: Migration = {
  version: 107,
  name: 'incident_notices',
  sql: `
    CREATE TABLE incident_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_key TEXT NOT NULL,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('outage', 'restored')),
      channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
      outbox_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (incident_key, client_id, kind)
    );
    CREATE INDEX idx_incident_notices_outbox ON incident_notices (channel, outbox_id);

    CREATE TABLE sms_outbox_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id),
      payment_id INTEGER REFERENCES payments(id),
      service_id INTEGER REFERENCES services(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('invoice_issued','receipt_confirmed','payment_overdue','suspension_notice','test','fup_notice','outage_notice')),
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
