import type { Migration } from './types';

/**
 * Acordo de pagamento: um calendário de prestações por cima de faturas em aberto.
 *
 * As faturas numeradas não se reescrevem; os pagamentos continuam a cair nelas pelos recibos.
 * O acordo só guarda o total renegociado e as prestações — o pago e o estado (em dia, em atraso,
 * cumprido) derivam do saldo atual das faturas abrangidas. Só `cancelled` é decisão guardada.
 */
const migration: Migration = {
  version: 103,
  name: 'payment_plans',
  sql: `
    CREATE TABLE payment_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      total_cve REAL NOT NULL CHECK(total_cve > 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cancelled_at TEXT,
      cancel_reason TEXT
    );
    CREATE INDEX idx_payment_plans_client ON payment_plans(client_id);

    CREATE TABLE payment_plan_invoices (
      plan_id INTEGER NOT NULL REFERENCES payment_plans(id),
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      PRIMARY KEY (plan_id, payment_id)
    );
    CREATE INDEX idx_payment_plan_invoices_payment ON payment_plan_invoices(payment_id);

    CREATE TABLE payment_plan_installments (
      plan_id INTEGER NOT NULL REFERENCES payment_plans(id),
      seq INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      amount_cve REAL NOT NULL CHECK(amount_cve > 0),
      PRIMARY KEY (plan_id, seq)
    );
  `
};

export default migration;
