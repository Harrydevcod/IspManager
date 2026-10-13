import type { Migration } from './types';

/**
 * Fatura manual: passada à mão, a um cliente com ou sem serviço.
 *
 * Duas coisas que o SQLite só deixa mudar reconstruindo a tabela:
 *
 * - `payments.service_id` deixa de ser obrigatório. Uma venda avulsa a quem não tem ligação não
 *   pertence a serviço nenhum; o cliente continua obrigatório. O índice único
 *   `(service_id, reference_month)` não se altera: sem serviço o SQLite não compara, e com serviço
 *   cada avulsa leva a sua chave `AVULSA-<id>`.
 * - `payment_lines.kind` ganha `avulso`, a rubrica escrita à mão.
 *
 * Mesmo padrão da 0012 e da 0043: `defer_foreign_keys` dentro da transação do runner, os mesmos
 * `id`, e a integridade verificada no COMMIT. Nenhuma tabela que referencia `payments` apaga em
 * cascata, por isso o DROP não leva linhas atrás. Os índices caem com a tabela e são recriados
 * todos aqui — incluindo os da numeração (0020), que não estavam na 0012.
 */
const migration: Migration = {
  version: 81,
  name: 'manual_invoices',
  sql: `
    PRAGMA defer_foreign_keys = ON;

    CREATE TABLE payments_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      service_id INTEGER REFERENCES services(id),
      reference_month TEXT NOT NULL,
      amount_cve REAL NOT NULL,
      due_date TEXT NOT NULL,
      payment_date TEXT,
      payment_method TEXT CHECK(payment_method IN ('numerario','transferencia','outro')),
      status TEXT NOT NULL CHECK(status IN ('pending','paid','overdue','cancelled')) DEFAULT 'pending',
      invoice_number TEXT,
      invoice_date TEXT,
      receipt_number TEXT,
      receipt_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO payments_new (
      id, client_id, service_id, reference_month, amount_cve, due_date,
      payment_date, payment_method, status, invoice_number, invoice_date,
      receipt_number, receipt_date, notes, created_at, updated_at
    )
    SELECT
      id, client_id, service_id, reference_month, amount_cve, due_date,
      payment_date, payment_method, status, invoice_number, invoice_date,
      receipt_number, receipt_date, notes, created_at, updated_at
    FROM payments;

    DROP TABLE payments;
    ALTER TABLE payments_new RENAME TO payments;

    CREATE INDEX idx_payments_client ON payments(client_id);
    CREATE INDEX idx_payments_status ON payments(status);
    CREATE INDEX idx_payments_month ON payments(reference_month);
    CREATE UNIQUE INDEX idx_payments_service_month_active
      ON payments(service_id, reference_month) WHERE status != 'cancelled';
    CREATE UNIQUE INDEX idx_payments_invoice_number
      ON payments(invoice_number) WHERE invoice_number IS NOT NULL;
    CREATE UNIQUE INDEX idx_payments_receipt_number
      ON payments(receipt_number) WHERE receipt_number IS NOT NULL;

    CREATE TABLE payment_lines_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      kind TEXT NOT NULL CHECK(kind IN ('internet','audiovisual','instalacao','aluguer','equipamento','avulso')),
      description TEXT NOT NULL,
      amount_cve REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO payment_lines_new (id, payment_id, kind, description, amount_cve, sort_order, created_at)
    SELECT id, payment_id, kind, description, amount_cve, sort_order, created_at
    FROM payment_lines;

    DROP TABLE payment_lines;
    ALTER TABLE payment_lines_new RENAME TO payment_lines;

    CREATE INDEX idx_payment_lines_payment ON payment_lines(payment_id);
  `
};

export default migration;
