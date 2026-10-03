import type { Migration } from './types';

const migration: Migration = {
  version: 69,
  name: 'client_traffic',
  sql: `
    CREATE TABLE client_traffic_daily (
      day TEXT NOT NULL,
      service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      rx_bytes INTEGER NOT NULL DEFAULT 0,
      tx_bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, service_id)
    );

    CREATE TABLE client_usage_state (
      pppoe_name TEXT PRIMARY KEY,
      rx_total INTEGER NOT NULL,
      tx_total INTEGER NOT NULL,
      seen_at TEXT NOT NULL
    );
  `
};

export default migration;
