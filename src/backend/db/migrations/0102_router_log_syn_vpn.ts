import type { Migration } from './types';

/**
 * Alarga o CHECK de `router_log_findings` a 'syn_flood' e 'vpn_falha'.
 *
 * O registo de 03–12/11/2026 tinha duas coisas que a vigia lia mas não contava: "possible SYN
 * flooding on tcp port 53" (10/11) e o túnel `wg-surfshark` a falhar o handshake (até 15 por dia).
 *
 * O SQLite não altera um CHECK no sítio: rebuild, como em 0087.
 */
const migration: Migration = {
  version: 102,
  name: 'router_log_syn_vpn',
  sql: `
    CREATE TABLE router_log_findings_new (
      day TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('antena_em_baixo','ip_duplicado','laco_rede','dhcp_intruso','dhcp_ciclo','pppoe_queda','login_falhado','config_externa','porta_oscila','router_reiniciou','syn_flood','vpn_falha')),
      subject TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      count INTEGER NOT NULL DEFAULT 0,
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      PRIMARY KEY (day, kind, subject)
    );

    INSERT INTO router_log_findings_new (day, kind, subject, label, count, first_at, last_at)
    SELECT day, kind, subject, label, count, first_at, last_at
    FROM router_log_findings;

    DROP TABLE router_log_findings;
    ALTER TABLE router_log_findings_new RENAME TO router_log_findings;

    CREATE INDEX idx_router_log_findings_last ON router_log_findings(last_at);
  `
};

export default migration;
