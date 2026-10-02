import type { Migration } from './types';

/**
 * Histórico da configuração do router de gestão: uma linha por versão diferente da
 * exportação (sem passwords — a exportação normal do RouterOS 7 omite-as).
 */
const migration: Migration = {
  version: 70,
  name: 'router_config_snapshots',
  sql: `
    CREATE TABLE router_config_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taken_at TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      routeros_version TEXT,
      content TEXT NOT NULL,
      added_lines INTEGER NOT NULL DEFAULT 0,
      removed_lines INTEGER NOT NULL DEFAULT 0
    );
  `
};

export default migration;
