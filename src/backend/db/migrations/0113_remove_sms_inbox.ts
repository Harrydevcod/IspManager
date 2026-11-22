import type { Migration } from './types';

const migration: Migration = {
  version: 113,
  name: 'remove_sms_inbox',
  sql: `
    CREATE TEMP TABLE sms_inbox_empty_guard (
      count INTEGER CONSTRAINT sms_inbox_contains_messages CHECK (count = 0)
    );
    INSERT INTO sms_inbox_empty_guard SELECT COUNT(*) FROM sms_inbox;
    DROP TABLE sms_inbox_empty_guard;
    DROP TABLE sms_inbox;
  `
};

export default migration;
