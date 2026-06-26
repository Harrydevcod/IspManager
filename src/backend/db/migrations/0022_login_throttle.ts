import type { Migration } from './types';

/**
 * Persistent brute-force throttle for the login endpoint.
 *
 * One row per identifier (`user:<lowercase-username>` or `ip:<address>`). The
 * row tracks consecutive failures within a rolling window and, once a threshold
 * is crossed, a `locked_until` timestamp that grows exponentially on each
 * further failure. Persisting (rather than keeping state in memory) means an
 * attacker cannot reset the lockout by restarting the desktop app.
 *
 * Rows are deleted on a successful login, so the table stays tiny in practice.
 */
const migration: Migration = {
  version: 22,
  name: 'login_throttle',
  sql: `
    CREATE TABLE login_throttle (
      identifier TEXT PRIMARY KEY,
      fail_count INTEGER NOT NULL DEFAULT 0,
      first_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
      locked_until TEXT
    );
  `
};

export default migration;
