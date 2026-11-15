import type { Migration } from './types';

// A antena Starlink só guarda 15 minutos segundo a segundo: o ISPM lê-a de minuto a minuto
// e guarda um resumo por leitura e cada corte que ela registou.
const migration: Migration = {
  version: 106,
  name: 'starlink_dish',
  sql: `
    CREATE TABLE starlink_dish_samples (
      at TEXT PRIMARY KEY,
      dish_id TEXT NOT NULL,
      latency_ms REAL,
      drop_rate REAL NOT NULL,
      downlink_bps REAL NOT NULL,
      uplink_bps REAL NOT NULL,
      obstructed INTEGER NOT NULL DEFAULT 0,
      fraction_obstructed REAL NOT NULL DEFAULT 0,
      alerts TEXT NOT NULL DEFAULT '',
      outage_cause TEXT
    );
    CREATE TABLE starlink_dish_outages (
      dish_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      cause TEXT NOT NULL,
      PRIMARY KEY (dish_id, started_at)
    );
    CREATE INDEX starlink_dish_outages_started ON starlink_dish_outages (started_at);
  `
};
export default migration;
