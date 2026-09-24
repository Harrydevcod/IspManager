import type { Migration } from './types';

/**
 * Password PPPoE pendente de sincronização.
 *
 * A REST do RouterOS não deve ser usada como fonte de verdade para a password:
 * o utilizador da API pode não ter política sensitive. Em vez de comparar
 * passwords, o ISPM marca explicitamente quando a password local mudou; a
 * reconciliação aplica-a e limpa esta marca apenas depois de um PATCH bem sucedido.
 */
const migration: Migration = {
  version: 63,
  name: 'pppoe_password_sync_pending',
  sql: `
    ALTER TABLE services
      ADD COLUMN pppoe_password_sync_pending INTEGER NOT NULL DEFAULT 0;
  `
};

export default migration;
