import type { Migration } from './types';

const migration: Migration = {
  version: 83,
  name: 'sale_tickets',
  sql: `
    ALTER TABLE clients ADD COLUMN system_kind TEXT CHECK (system_kind IS NULL OR system_kind = 'indifferentiated');
    CREATE UNIQUE INDEX clients_system_kind_unique ON clients(system_kind) WHERE system_kind IS NOT NULL;
    WITH RECURSIVE codes(n, code) AS (
      SELECT 0, 'INDIF'
      UNION ALL SELECT n + 1, 'INDIF-' || (n + 1) FROM codes WHERE n < (SELECT count(*) FROM clients)
    )
    INSERT INTO clients(client_code, full_name, status, system_kind)
    SELECT code, 'Cliente Indiferenciado', 'active', 'indifferentiated' FROM codes
    WHERE NOT EXISTS (SELECT 1 FROM clients WHERE client_code = codes.code)
    ORDER BY n LIMIT 1;

    ALTER TABLE payments ADD COLUMN document_type TEXT NOT NULL DEFAULT 'invoice' CHECK(document_type IN ('invoice', 'sale_ticket'));
    ALTER TABLE payments ADD COLUMN sale_request_key TEXT;
    ALTER TABLE payments ADD COLUMN sale_request_hash TEXT;
    ALTER TABLE payments ADD COLUMN cancellation_reason TEXT;
    CREATE UNIQUE INDEX payments_sale_request_key_unique ON payments(sale_request_key) WHERE sale_request_key IS NOT NULL;
    CREATE TABLE sale_ticket_lines (
      payment_line_id INTEGER PRIMARY KEY REFERENCES payment_lines(id) ON DELETE CASCADE,
      catalog_id INTEGER REFERENCES equipment_catalog(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price_cve REAL NOT NULL CHECK(unit_price_cve > 0)
    );
    CREATE TABLE sale_ticket_serials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_line_id INTEGER NOT NULL REFERENCES sale_ticket_lines(payment_line_id) ON DELETE CASCADE,
      serial_number TEXT NOT NULL,
      normalized_serial TEXT NOT NULL,
      released_at TEXT
    );
    CREATE UNIQUE INDEX sale_ticket_serial_active_unique ON sale_ticket_serials(normalized_serial) WHERE released_at IS NULL;
    CREATE INDEX sale_ticket_serial_line ON sale_ticket_serials(payment_line_id);
    ALTER TABLE stock_movements ADD COLUMN sale_ticket_line_id INTEGER REFERENCES sale_ticket_lines(payment_line_id);
    CREATE UNIQUE INDEX stock_sale_ticket_operation_unique ON stock_movements(sale_ticket_line_id, type) WHERE sale_ticket_line_id IS NOT NULL;
  `
};

export default migration;
