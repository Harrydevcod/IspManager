import type { Migration } from './types';

/**
 * Stripe como mais uma via de pagamento (ADR 0016).
 *
 * Um link é uma fatura avulsa no Stripe, no valor do saldo de uma fatura do ISPM. "Fatura por
 * Stripe" é ter um link vivo aqui; `payment_method` não ganha valor novo, porque o CHECK dele já
 * foi lançado e o recibo entra como `outro`.
 *
 * Estado: `creating` (linha escrita, Stripe por confirmar) → `open` → `paid` | `void` | `review`
 * (o Stripe recebeu mas a fatura já estava liquidada: decide uma pessoa). Sem CHECK nos estados:
 * alargar um CHECK já lançado obriga a reconstruir a tabela.
 *
 * O índice parcial garante um só link vivo por fatura, para não haver dois sítios onde pagar a
 * mesma dívida.
 */
const migration: Migration = {
  version: 79,
  name: 'stripe_payment_links',
  sql: `
    ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT;

    CREATE TABLE stripe_payment_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      stripe_invoice_id TEXT UNIQUE,
      url TEXT,
      amount_cve REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'creating',
      receipt_id INTEGER,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX idx_stripe_links_live ON stripe_payment_links(payment_id)
      WHERE status IN ('creating', 'open');
  `
};

export default migration;
