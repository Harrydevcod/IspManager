import type { Migration } from './types';

const migration: Migration = {
  version: 28,
  name: 'sms_outbox_created_status_index',
  sql: `
    CREATE INDEX IF NOT EXISTS idx_sms_outbox_created_status
      ON sms_outbox(created_at, status);
  `
};

export default migration;
