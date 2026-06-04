import type { Migration } from './types';

const migration: Migration = {
  version: 17,
  name: 'sms_outbox_failed_at',
  sql: `
    ALTER TABLE sms_outbox ADD COLUMN failed_at TEXT;
  `
};

export default migration;
