import type { Migration } from './types';

/**
 * Sonda de rede: estado atual por equipamento e histórico de transições.
 *
 * Só transições, não série temporal: guardar cada ping seriam 1440 linhas por
 * equipamento por dia para responder a perguntas ("está de pé?", "quanto tempo
 * esteve em baixo?") que as mudanças de estado já respondem.
 */
const migration: Migration = {
  version: 37,
  name: 'network_probes',
  sql: `
    CREATE TABLE IF NOT EXISTS network_probe_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('backbone','assignment')),
      target_id INTEGER NOT NULL,
      ip_address TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('up','down')),
      rtt_ms INTEGER,
      consecutive_fails INTEGER NOT NULL DEFAULT 0,
      last_ok_at TEXT,
      last_change_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (target_kind, target_id)
    );

    CREATE TABLE IF NOT EXISTS network_probe_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('backbone','assignment')),
      target_id INTEGER NOT NULL,
      ip_address TEXT NOT NULL,
      from_state TEXT CHECK (from_state IN ('up','down')),
      to_state TEXT NOT NULL CHECK (to_state IN ('up','down')),
      at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      duration_seconds INTEGER,
      -- 1 = antes deste ponto houve um buraco de observação (aplicação fechada).
      -- O tempo até aqui não conta para a disponibilidade, em nenhum dos sentidos.
      gap_before INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_network_probe_events_target
      ON network_probe_events(target_kind, target_id, at);
  `
};

export default migration;
