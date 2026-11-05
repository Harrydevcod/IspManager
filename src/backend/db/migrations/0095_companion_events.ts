import type { Migration } from './types';

/**
 * Canal de volta da app móvel. O desktop puxa eventos do telemóvel (nunca o
 * contrário: a API continua só em 127.0.0.1) e guarda cada um pelo id que o
 * telemóvel lhe deu, por isso puxar duas vezes o mesmo evento não faz nada.
 *
 * - `companion_events`: o registo de tudo o que chegou, com o desfecho. Um
 *   recebimento em mão fica `pending` até o operador o confirmar: a caixa nunca
 *   muda sozinha.
 * - `work_order_attachments`: fotos e posição da conclusão no terreno. As fotos
 *   ficam na própria base (BLOB, ~200 KB cada) para irem no backup, que é uma
 *   cópia do ficheiro SQLite; em ficheiros soltos ficariam de fora.
 * - `sms_inbox`: respostas dos clientes. O telemóvel só reencaminha números que
 *   estão na lista de clientes.
 */
const migration: Migration = {
  version: 95,
  name: 'companion_events',
  sql: `
    CREATE TABLE companion_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
      reason TEXT,
      decided_by TEXT,
      decided_at TEXT
    );
    CREATE INDEX idx_companion_events_kind_status ON companion_events (kind, status);

    CREATE TABLE work_order_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('photo', 'location')),
      mime TEXT,
      data BLOB,
      lat REAL,
      lon REAL,
      taken_at TEXT,
      event_id TEXT REFERENCES companion_events (id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_work_order_attachments_order ON work_order_attachments (work_order_id);

    CREATE TABLE sms_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE REFERENCES companion_events (id),
      client_id INTEGER REFERENCES clients (id),
      phone TEXT NOT NULL,
      body TEXT NOT NULL,
      received_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX idx_sms_inbox_client ON sms_inbox (client_id, received_at);
  `
};

export default migration;
