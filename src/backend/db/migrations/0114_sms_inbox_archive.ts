import type { Migration } from './types';

export const archiveTableSql = `
  CREATE TABLE IF NOT EXISTS sms_inbox_archive (
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    client_id INTEGER,
    phone TEXT NOT NULL,
    body TEXT NOT NULL,
    received_at TEXT NOT NULL,
    read_at TEXT
  );
`;

const migration: Migration = { version: 114, name: 'sms_inbox_archive', sql: archiveTableSql };
export default migration;
