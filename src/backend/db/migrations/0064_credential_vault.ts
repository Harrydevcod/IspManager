import type { Migration } from './types';

/**
 * Cofre de credenciais (ver docs/superpowers/plans/2026-09-24-cofre-de-credenciais.md).
 *
 * Uma só linha: a chave de dados embrulhada duas vezes — pela proteção local
 * (DPAPI, não viaja com o ficheiro) e pela chave de recuperação que o
 * administrador guarda. `pending_recovery_local` guarda a chave de recuperação
 * selada localmente até o administrador confirmar que a anotou; depois fica NULL.
 * Só a tabela: a conversão dos valores legados é código, não DDL.
 */
const migration: Migration = {
  version: 64,
  name: 'credential_vault',
  sql: `
    CREATE TABLE credential_vault (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      vault_id TEXT NOT NULL,
      format_version INTEGER NOT NULL DEFAULT 1,
      local_wrapped_key TEXT NOT NULL,
      recovery_wrapped_key TEXT NOT NULL,
      pending_recovery_local TEXT,
      recovery_confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `
};

export default migration;
