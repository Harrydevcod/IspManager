import type { Migration } from './types';

/**
 * Alarga o CHECK de `router_log_findings` a 'laco_rede'.
 *
 * Uma mensagem de servidor DHCP numa porta não confiável com o MAC do próprio router é a
 * resposta dele a voltar-lhe: há um laço na rede. Até aqui gravava-se como 'ip_duplicado',
 * que manda procurar outro equipamento com o endereço do router — e não há nenhum.
 * As linhas antigas ficam como estão; a vigia corrige-as quando souber os MAC do router.
 *
 * O SQLite não altera um CHECK no sítio: rebuild, como em 0004/0018/0029/0038/0040.
 */
const migration: Migration = {
  version: 75,
  name: 'router_log_loop_kind',
  sql: `
    CREATE TABLE router_log_findings_new (
      day TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('antena_em_baixo','ip_duplicado','laco_rede','dhcp_intruso','dhcp_ciclo','pppoe_queda','login_falhado')),
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
