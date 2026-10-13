import type { Migration } from './types';

/**
 * Reembolso e comissão de um pagamento Stripe (ADR 0016).
 *
 * `payment_intent_id` é o que o Stripe pede para reembolsar e para chegar à comissão; guarda-se
 * quando se apura, para não o voltar a perguntar. `fee_cve` nulo = comissão por apurar; zero =
 * apurada e sem custo. `fee_expense_id` aponta para a despesa que a comissão gerou.
 *
 * O estado ganha `refunded` (reembolsado pelo ISPM, recibo anulado). Continua sem CHECK.
 */
const migration: Migration = {
  version: 80,
  name: 'stripe_refunds_and_fees',
  sql: `
    ALTER TABLE stripe_payment_links ADD COLUMN payment_intent_id TEXT;
    ALTER TABLE stripe_payment_links ADD COLUMN refund_id TEXT;
    ALTER TABLE stripe_payment_links ADD COLUMN fee_cve REAL;
    ALTER TABLE stripe_payment_links ADD COLUMN fee_expense_id INTEGER;
  `
};

export default migration;
