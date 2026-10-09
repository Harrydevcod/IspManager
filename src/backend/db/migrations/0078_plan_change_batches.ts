import type { Migration } from './types';

/**
 * Mudança de plano em massa: um lote por operação, um item por serviço.
 *
 * É o registo que responde "porque é que este cliente mudou de plano?" meses depois — quem, quando,
 * de que plano para qual, com que mensalidade, se a sessão foi derrubada e como acabou. Serve também
 * a execução: o progresso, o cancelamento e as sessões agendadas para derrubar leem-se daqui.
 *
 * Os nomes (cliente, planos, autor) ficam copiados e não há chaves estrangeiras para serviços nem
 * planos: o histórico tem de sobreviver a um serviço apagado ou a um plano renomeado.
 *
 * Estado de um item: `queued` (por começar) → `pending` (escrito na base, router por confirmar) →
 * `applied` | `unchanged` | `failed`; `not_processed` é o que ficou por fazer num lote parado.
 * Sem CHECK nos estados: alargar um CHECK já lançado obriga a reconstruir a tabela.
 */
const migration: Migration = {
  version: 78,
  name: 'plan_change_batches',
  sql: `
    CREATE TABLE plan_change_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_plan_id INTEGER NOT NULL,
      target_plan_name TEXT NOT NULL,
      reason TEXT,
      update_price INTEGER NOT NULL DEFAULT 1,
      drop_mode TEXT NOT NULL DEFAULT 'none',
      drop_at TEXT,
      drop_status TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      stop_reason TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_by_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE plan_change_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES plan_change_batches(id) ON DELETE CASCADE,
      service_id INTEGER NOT NULL,
      client_name TEXT NOT NULL,
      login TEXT,
      from_plan_id INTEGER,
      from_plan_name TEXT,
      from_value_cve REAL NOT NULL,
      to_value_cve REAL NOT NULL,
      from_profile TEXT,
      to_profile TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      note TEXT,
      error TEXT,
      was_online INTEGER NOT NULL DEFAULT 0,
      router_changed INTEGER NOT NULL DEFAULT 0,
      session_dropped_at TEXT,
      processed_at TEXT
    );

    CREATE INDEX idx_plan_change_items_batch ON plan_change_items(batch_id, id);
    CREATE INDEX idx_plan_change_items_service ON plan_change_items(service_id);
  `
};

export default migration;
