import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../lib/paths';
import { runMigrations } from './migrate';
import * as schema from './schema';

let database: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqliteInstance: Database.Database | null = null;

export function getDatabase() {
  if (database) {
    return database;
  }

  const dataDir = resolveDataDir();

  mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'ispm.sqlite');
  const sqlite = new Database(dbPath);
  sqliteInstance = sqlite;

  sqlite.pragma('journal_mode = WAL');

  // Schema is owned entirely by the versioned migration chain. Safe on every
  // boot: pending migrations apply, applied ones are skipped, and an existing
  // field database is adopted (baseline is CREATE ... IF NOT EXISTS).
  // See docs/adr/0003-versioned-sql-migrations.md.
  runMigrations(sqlite);

  database = drizzle(sqlite, { schema });
  return database;
}

export function getSqliteDatabase() {
  if (!sqliteInstance) {
    getDatabase();
  }

  if (!sqliteInstance) {
    throw new Error('SQLite database is not initialized');
  }

  return sqliteInstance;
}

/** Closes the live SQLite connection. Used by restore before swapping the
 *  file, and by tests. After this, getDatabase() reopens + re-migrates. */
export function closeDatabase() {
  sqliteInstance?.close();
  sqliteInstance = null;
  database = null;
}

export function closeDatabaseForTests() {
  closeDatabase();
}
