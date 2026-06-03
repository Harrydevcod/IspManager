import type { Migration } from './types';

/**
 * Link an automatic notice to the outbox row that actually delivers it. ADD
 * COLUMN is safe in SQLite (no table rebuild), unlike a CHECK change.
 */
const migration: Migration = {
  version: 15,
  name: 'whatsapp_notices_outbox_link',
  sql: `
    ALTER TABLE whatsapp_notices ADD COLUMN outbox_id INTEGER REFERENCES whatsapp_outbox(id);
  `
};

export default migration;
