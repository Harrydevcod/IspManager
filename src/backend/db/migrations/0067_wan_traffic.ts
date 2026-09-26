import type { Migration } from './types';

const migration: Migration = {
  version: 67,
  name: 'wan_traffic',
  sql: `
    CREATE TABLE wan_traffic_daily (
      day TEXT NOT NULL,
      interface TEXT NOT NULL,
      rx_bytes INTEGER NOT NULL DEFAULT 0,
      tx_bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, interface)
    );

    CREATE TABLE wan_counter_state (
      interface TEXT PRIMARY KEY,
      rx_last INTEGER NOT NULL,
      tx_last INTEGER NOT NULL,
      seen_at TEXT NOT NULL
    );
  `
};

export default migration;
