import type { Migration } from './types';

/**
 * Pedidos de assistência: o que o cliente reportou (avaria, lentidão, fatura), à parte das
 * OS técnicas, que são o trabalho planeado. Um pedido pode gerar várias OS.
 *
 * As entradas são a conversa e o histórico do pedido na mesma linha do tempo, só de
 * acrescento: notas, mudanças de estado e OS criadas.
 */
const migration: Migration = {
  version: 71,
  name: 'support_tickets',
  sql: `
    CREATE TABLE support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      service_id INTEGER REFERENCES services(id),
      subject TEXT NOT NULL CHECK(length(trim(subject)) > 0),
      channel TEXT NOT NULL CHECK(channel IN ('telefone','whatsapp','presencial','email','outro')),
      category TEXT NOT NULL CHECK(category IN ('sem_ligacao','lento','intermitente','equipamento','faturacao','outro')),
      priority TEXT NOT NULL CHECK(priority IN ('baixa','media','alta')) DEFAULT 'media',
      status TEXT NOT NULL CHECK(status IN ('aberto','em_curso','aguarda_cliente','resolvido','fechado')) DEFAULT 'aberto',
      opened_by INTEGER REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id),
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      first_response_at TEXT,
      resolved_at TEXT,
      closed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_support_tickets_status ON support_tickets(status);
    CREATE INDEX idx_support_tickets_client ON support_tickets(client_id);

    CREATE TABLE support_ticket_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id),
      kind TEXT NOT NULL CHECK(kind IN ('nota','mudanca_estado','os_criada')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_support_ticket_entries_ticket ON support_ticket_entries(ticket_id, id);

    ALTER TABLE work_orders ADD COLUMN ticket_id INTEGER REFERENCES support_tickets(id);
  `
};

export default migration;
