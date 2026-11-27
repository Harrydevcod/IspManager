import type { Migration } from './types';

/**
 * A causa de uma queda do backbone: reinício, corte de energia ou queda de ligação.
 *
 * O ping só diz "não responde". A prova que separa um reinício de uma ligação perdida é o
 * tempo ligado do próprio equipamento (`sysUpTime` por SNMP): depois de reiniciar ou de
 * ficar sem energia volta a zero; numa ligação perdida continua a contar.
 *
 * - `network_sites`: o local físico (torre, poste, casa). Vários equipamentos do mesmo local
 *   a reiniciar juntos, sem um arrastar o outro, é um corte de energia nesse local.
 * - `network_probe_state.device_uptime_seconds`: a última leitura do uptime, para apanhar um
 *   reinício tão curto que a sonda nem chegou a dar a queda.
 * - `network_outage_evidence`: por queda (mesma chave do incidente: equipamento + início), se o
 *   uptime voltou a zero e a causa que o operador escolheu. A causa em si deriva-se ao ler.
 *   `observed_down = 0` é um reinício sem queda registada.
 * - `planned_reboots`: o "Vou reiniciar" do operador.
 */
const migration: Migration = {
  version: 115,
  name: 'outage_causes',
  sql: `
    CREATE TABLE IF NOT EXISTS network_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE backbone_devices ADD COLUMN site_id INTEGER REFERENCES network_sites(id) ON DELETE SET NULL;

    ALTER TABLE network_probe_state ADD COLUMN device_uptime_seconds INTEGER;
    ALTER TABLE network_probe_state ADD COLUMN uptime_read_at TEXT;

    CREATE TABLE IF NOT EXISTS network_outage_evidence (
      device_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      uptime_reset INTEGER CHECK (uptime_reset IN (0, 1)),
      observed_down INTEGER NOT NULL DEFAULT 1 CHECK (observed_down IN (0, 1)),
      operator_cause TEXT CHECK (operator_cause IN ('reboot', 'power', 'link')),
      decided_by INTEGER,
      decided_at TEXT,
      PRIMARY KEY (device_id, started_at)
    );

    CREATE TABLE IF NOT EXISTS planned_reboots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      starts_at TEXT NOT NULL,
      until_at TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_planned_reboots_device ON planned_reboots(device_id, starts_at);
  `
};

export default migration;
