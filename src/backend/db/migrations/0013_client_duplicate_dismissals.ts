import type { Migration } from './types';

/**
 * Pairs of clients an operator has explicitly marked as "not a duplicate".
 * The data-quality duplicate detector excludes any pair stored here.
 * Pairs are stored normalized with client_id_low < client_id_high so a pair
 * is recorded once regardless of the order it was dismissed in.
 */
const migration: Migration = {
  version: 13,
  name: 'client_duplicate_dismissals',
  sql: `
    CREATE TABLE IF NOT EXISTS client_duplicate_dismissals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id_low INTEGER NOT NULL REFERENCES clients(id),
      client_id_high INTEGER NOT NULL REFERENCES clients(id),
      dismissed_by INTEGER REFERENCES users(id),
      dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(client_id_low, client_id_high)
    );
  `
};

export default migration;
