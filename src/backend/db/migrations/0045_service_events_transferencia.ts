import type { Migration } from './types';

/**
 * Alarga o CHECK de `service_events` com 'transferencia': o serviço mudou de
 * titular.
 *
 * Até aqui trocar o cliente era mais um campo do formulário — o serviço saltava
 * de cliente sem data, sem motivo e sem aparecer na história de nenhum dos dois.
 * Com o evento, a pergunta "desde quando este serviço é deste cliente?" tem
 * resposta sem ir ao audit log.
 *
 * O SQLite não altera um CHECK no sítio: rebuild, como em 0004/0018/0029/0038/0040.
 */
const migration: Migration = {
  version: 45,
  name: 'service_events_transferencia',
  sql: `
    PRAGMA defer_foreign_keys = ON;

    CREATE TABLE service_events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL REFERENCES services(id),
      event_type TEXT NOT NULL CHECK(event_type IN (
        'instalacao','manutencao','troca_equipamento','visita','alteracao_servico',
        'suspensao','reativacao','cancelamento',
        'corte_rede','reposicao_rede',
        'transferencia'
      )),
      notes TEXT,
      technician_id INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO service_events_new (id, service_id, event_type, notes, technician_id, created_by, created_at)
    SELECT id, service_id, event_type, notes, technician_id, created_by, created_at
    FROM service_events;

    DROP TABLE service_events;
    ALTER TABLE service_events_new RENAME TO service_events;

    CREATE INDEX IF NOT EXISTS idx_service_events_service ON service_events(service_id);
    CREATE INDEX IF NOT EXISTS idx_service_events_type ON service_events(event_type);
  `
};

export default migration;
