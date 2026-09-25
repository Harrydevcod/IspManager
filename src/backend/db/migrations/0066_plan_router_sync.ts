import type { Migration } from './types';

/**
 * Estado da sincronização do perfil PPP de cada plano com o router (ADR 0011).
 *
 * O plano é a intenção; o perfil no MikroTik é a realidade. Uma linha por
 * plano com o resultado da última passagem, para a lista de Planos dizer se o
 * perfil está pronto, pendente, alheio ou em erro — e porquê.
 */
const migration: Migration = {
  version: 66,
  name: 'plan_router_sync',
  sql: `
    CREATE TABLE plan_router_sync (
      plan_id INTEGER PRIMARY KEY REFERENCES internet_plans(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('synced', 'pending', 'external', 'error', 'dry_run')),
      detail TEXT,
      last_error TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `
};

export default migration;
