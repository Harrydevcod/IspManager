import type { Migration } from './types';

const migration: Migration = {
  version: 108,
  name: 'customer_portal',
  sql: `CREATE TABLE customer_portal_links (
    id TEXT PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    relay_origin TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    published_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_customer_portal_links_client ON customer_portal_links(client_id);`
};
export default migration;
