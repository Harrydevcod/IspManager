import type { Migration } from './types';

/**
 * Sino de notificações: o histórico comum ao PC e ao telemóvel.
 *
 * `uid` é a identidade estável da entrada, partilhada com a app Android e,
 * ao mesmo tempo, a chave que evita duplicados: cada produtor compõe-na a
 * partir do evento que a origina (`probe:<id>:<at>`, `job:<run>`), e as que
 * nascem no telemóvel usam `phone:<uuid>`. Uma só coluna porque os dois
 * papéis têm sempre o mesmo valor.
 *
 * Lida e "visto até" são por utilizador: o que um lê não desaparece do sino
 * dos outros.
 */
const migration: Migration = {
  version: 112,
  name: 'notifications',
  sql: `
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL UNIQUE,
      origin TEXT NOT NULL DEFAULT 'pc' CHECK (origin IN ('pc', 'phone')),
      kind TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'danger')),
      title TEXT NOT NULL,
      detail TEXT,
      section TEXT,
      focus TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_notifications_created ON notifications (created_at DESC);

    CREATE TABLE notification_reads (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      read_at TEXT NOT NULL,
      PRIMARY KEY (user_id, notification_id)
    );

    CREATE TABLE notification_seen (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      seen_at TEXT NOT NULL
    );
  `
};
export default migration;
