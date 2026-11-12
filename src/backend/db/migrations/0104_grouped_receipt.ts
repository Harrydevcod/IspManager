import type { Migration } from './types';

/**
 * Um recibo pode liquidar várias faturas (`settleInvoices`): cada fatura fechada guarda o número
 * do recibo que a saldou, por isso o mesmo número passa a aparecer em mais do que um pagamento.
 *
 * O índice único de 0081 deixa de valer; fica um índice simples para as pesquisas por número.
 * A série continua sem saltos nem repetições do lado de quem aloca (`allocateDocumentNumber`).
 */
const migration: Migration = {
  version: 104,
  name: 'grouped_receipt',
  sql: `
    DROP INDEX IF EXISTS idx_payments_receipt_number;
    CREATE INDEX idx_payments_receipt_number ON payments(receipt_number) WHERE receipt_number IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_payment_receipts_number ON payment_receipts(receipt_number);
  `
};

export default migration;
