import type { Migration } from './types';

/**
 * OS técnica (work_orders) — tarefas planeadas com workflow vivo.
 *
 * Service_events ficam reservados ao histórico do que ACONTECEU.
 * work_orders representam o que está PLANEADO / EM CURSO.
 * Ao concluir uma OS o servidor cria automaticamente um service_event
 * correspondente, preservando o registo histórico.
 */
const migration: Migration = {
  version: 2,
  name: 'work_orders',
  sql: `
    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER REFERENCES services(id),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL
        CHECK(status IN ('aguarda','agendada','em_curso','concluida','cancelada'))
        DEFAULT 'aguarda',
      priority TEXT NOT NULL
        CHECK(priority IN ('baixa','media','alta'))
        DEFAULT 'media',
      event_type TEXT
        CHECK(event_type IN ('instalacao','manutencao','troca_equipamento','visita','alteracao_servico')),
      assigned_to TEXT,
      scheduled_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      completion_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
    CREATE INDEX IF NOT EXISTS idx_work_orders_service ON work_orders(service_id);
    CREATE INDEX IF NOT EXISTS idx_work_orders_scheduled ON work_orders(scheduled_at);
  `
};

export default migration;
