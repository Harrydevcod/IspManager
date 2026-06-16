import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { migrations as shippedMigrations } from './migrations';
import type { Migration } from './migrations/types';

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Applies pending migrations in version order, each in its own transaction,
 * recording every applied version in `schema_migrations`.
 *
 * Safe to call on every startup: already-applied migrations are skipped, and a
 * shipped migration whose SQL was edited after being applied aborts the boot
 * with a checksum-drift error rather than letting installs silently diverge.
 * Adopting an existing field database is a no-op beyond recording version 1,
 * because the baseline migration is `CREATE ... IF NOT EXISTS`.
 *
 * @param list defaults to the shipped chain; overridable for tests.
 */
export function runMigrations(
  db: Database.Database,
  list: Migration[] = shippedMigrations,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const ordered = [...list].sort((a, b) => a.version - b.version);

  const applied = new Map<number, string>();
  for (const row of db
    .prepare('SELECT version, checksum FROM schema_migrations')
    .all() as Array<{ version: number; checksum: string }>) {
    applied.set(row.version, row.checksum);
  }

  // Drift detection: any already-applied migration whose source changed.
  for (const m of ordered) {
    const recorded = applied.get(m.version);
    if (recorded !== undefined && recorded !== checksum(m.sql)) {
      throw new Error(
        `Migration ${m.version} (${m.name}): checksum drift — a migração já aplicada foi alterada. ` +
          'Migrations aplicadas são imutáveis; crie uma nova versão em vez de editar.',
      );
    }
  }

  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)',
  );

  const foreignKeysEnabled = Number(db.pragma('foreign_keys', { simple: true })) === 1;
  if (foreignKeysEnabled) {
    // Parent-table rebuilds cannot safely DROP/RENAME while FK enforcement is
    // active, even with defer_foreign_keys. Disable enforcement outside the
    // transaction, then validate the resulting graph before each COMMIT.
    db.pragma('foreign_keys = OFF');
  }

  try {
    for (const m of ordered) {
      if (applied.has(m.version)) {
        continue;
      }
      const apply = db.transaction(() => {
        db.exec(m.sql);
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(`Migration ${m.version} (${m.name}) deixou referencias invalidas`);
        }
        insert.run(m.version, m.name, checksum(m.sql));
      });
      apply();
    }
  } finally {
    if (foreignKeysEnabled) {
      db.pragma('foreign_keys = ON');
    }
  }
}
