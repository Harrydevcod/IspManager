import type { Migration } from './types';

/** Prova da tentativa de eliminar um rascunho, para recuperar após reinício. */
const migration: Migration = {
  version: 82,
  name: 'stripe_draft_cancellation',
  sql: `ALTER TABLE stripe_payment_links ADD COLUMN draft_cancel_key_hash TEXT;`
};

export default migration;
