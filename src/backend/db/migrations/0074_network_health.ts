import type { Migration } from './types';

/**
 * A saúde da rede que hoje se perde:
 *
 * - `router_log_findings`: o que o registo do router conta (quedas vistas pelo netwatch, DHCP
 *   intruso, o endereço do router duplicado, PPPoE, logins falhados), somado por dia. O router
 *   só guarda ~1000 linhas — umas horas —, por isso o que não for lido a tempo desaparece.
 *   `subject` é o IP, o MAC ou o login, conforme o `kind`.
 * - `network_diary`: o que o operador escreve sobre uma situação — o que foi, a causa e como se
 *   resolveu. Uma ocorrência fecha-se, não se apaga.
 */
const migration: Migration = {
  version: 74,
  name: 'network_health',
  sql: `
    CREATE TABLE router_log_findings (
      day TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('antena_em_baixo','ip_duplicado','dhcp_intruso','dhcp_ciclo','pppoe_queda','login_falhado')),
      subject TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      count INTEGER NOT NULL DEFAULT 0,
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      PRIMARY KEY (day, kind, subject)
    );

    CREATE INDEX idx_router_log_findings_last ON router_log_findings(last_at);

    CREATE TABLE network_diary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      happened_at TEXT NOT NULL,
      title TEXT NOT NULL CHECK(length(trim(title)) > 0),
      cause TEXT NOT NULL DEFAULT '',
      resolution TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('aberta','resolvida')) DEFAULT 'aberta',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `
};

export default migration;
