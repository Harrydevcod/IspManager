import type { Migration } from './types';

/**
 * Pagamentos parciais: o dinheiro passa a ter registo próprio.
 *
 * Até aqui a fatura era tudo-ou-nada — `payments.status` saltava de 'pending'
 * para 'paid' e não havia onde escrever os 10.000$ que o cliente entregou por
 * conta de 50.000$. `payment_receipts` é essa camada: cada entrada de dinheiro
 * é uma linha, com o seu número de recibo, data e método.
 *
 * `payments.amount_cve` e `payments.status` NÃO mudam de significado. O valor
 * da fatura é imutável porque a fatura nasce numerada, e o estado continua a
 * fechar só quando a soma dos recebimentos cobre o valor — é isso que deixa o
 * `overdueSqlPredicate`, o índice único parcial e os PDFs continuarem válidos.
 *
 * `source` distingue dinheiro novo de conta-corrente: um recibo liquidado a
 * partir de crédito não é caixa do mês (o dinheiro entrou quando o crédito
 * nasceu), e somá-lo outra vez duplicava a receita.
 *
 * O backfill faz de `payment_receipts` a única verdade de caixa, histórico
 * incluído: sem ele os totais por regime de caixa passariam a ignorar tudo o
 * que foi pago antes desta migração.
 */
const migration: Migration = {
  version: 52,
  name: 'partial_payments',
  sql: `
    CREATE TABLE IF NOT EXISTS payment_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      amount_cve REAL NOT NULL CHECK(amount_cve > 0),
      payment_date TEXT NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('numerario','transferencia','outro')),
      source TEXT NOT NULL DEFAULT 'cash' CHECK(source IN ('cash','credit')),
      receipt_number TEXT NOT NULL,
      receipt_date TEXT NOT NULL,
      voided_at TEXT,
      void_reason TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_payment_receipts_payment ON payment_receipts(payment_id);
    CREATE INDEX IF NOT EXISTS idx_payment_receipts_date ON payment_receipts(payment_date);

    CREATE TABLE IF NOT EXISTS client_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      amount_cve REAL NOT NULL,
      receipt_id INTEGER REFERENCES payment_receipts(id),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_client_credits_client ON client_credits(client_id);

    -- Histórico: cada fatura já paga vira um recibo pelo valor total. A data é a
    -- melhor que existir na linha; o número, o que lá está — e 'LEGACY-<id>'
    -- quando nem número houve, para o NOT NULL não obrigar a inventar série.
    INSERT INTO payment_receipts (
      payment_id, amount_cve, payment_date, payment_method, source,
      receipt_number, receipt_date, notes, created_at
    )
    SELECT
      id,
      amount_cve,
      COALESCE(payment_date, receipt_date, date(updated_at), date(created_at)),
      COALESCE(payment_method, 'outro'),
      'cash',
      COALESCE(receipt_number, 'LEGACY-' || id),
      COALESCE(receipt_date, payment_date, date(updated_at), date(created_at)),
      'Recebimento historico (antes dos pagamentos parciais)',
      COALESCE(updated_at, created_at)
    FROM payments
    WHERE status = 'paid' AND amount_cve > 0;
  `
};

export default migration;
