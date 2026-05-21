import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate';
import { migrations } from './migrations';
import type { Migration } from './migrations/types';

function freshDb(): Database.Database {
  return new Database(':memory:');
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return Boolean(row);
}

const LEGACY_CLIENTS_DDL = `
  CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_code TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    phone TEXT UNIQUE,
    email TEXT,
    nif TEXT UNIQUE,
    address TEXT,
    island TEXT,
    zone TEXT,
    status TEXT NOT NULL CHECK(status IN ('active','suspended','cancelled')) DEFAULT 'active',
    notes TEXT,
    admission_date TEXT,
    default_payment_method TEXT CHECK(default_payment_method IN ('numerario','transferencia','outro')),
    whatsapp_opt_out INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

describe('runMigrations', () => {
  test('fresh database applies the full chain and records every version', () => {
    const db = freshDb();

    runMigrations(db);

    // schema_migrations registers exactly the shipped migrations, in order.
    const recorded = db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string }>;
    expect(recorded.map((r) => r.version)).toEqual(migrations.map((m) => m.version));
    expect(recorded.map((r) => r.name)).toEqual(migrations.map((m) => m.name));

    // Baseline tables exist after the chain runs.
    expect(tableExists(db, 'clients')).toBe(true);
    expect(tableExists(db, 'payments')).toBe(true);
    expect(tableExists(db, 'app_settings')).toBe(true);
  });

  test('is idempotent — running twice applies nothing the second time', () => {
    const db = freshDb();

    runMigrations(db);
    const first = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number };

    expect(() => runMigrations(db)).not.toThrow();

    const second = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number };
    expect(second.n).toBe(first.n);
    expect(second.n).toBe(migrations.length);
  });

  test('adopts a legacy database without data loss', () => {
    const db = freshDb();

    // Simulate a field database created by the old bootstrap: a core table
    // already exists with real data, and there is no schema_migrations table.
    db.exec(LEGACY_CLIENTS_DDL);
    db.prepare(
      `INSERT INTO clients (client_code, full_name) VALUES (?, ?)`,
    ).run('C-0001', 'Cliente Existente');

    runMigrations(db);

    const survived = db
      .prepare('SELECT full_name FROM clients WHERE client_code = ?')
      .get('C-0001') as { full_name: string } | undefined;
    expect(survived?.full_name).toBe('Cliente Existente');

    const baseline = db
      .prepare('SELECT version FROM schema_migrations WHERE version = 1')
      .get();
    expect(baseline).toBeTruthy();
    // Adoption still completes the rest of the baseline schema.
    expect(tableExists(db, 'payments')).toBe(true);
  });

  test('throws when an already-applied migration was edited (checksum drift)', () => {
    const db = freshDb();
    const original: Migration[] = [
      { version: 1, name: 'init', sql: 'CREATE TABLE t1 (a TEXT);' },
    ];
    const tampered: Migration[] = [
      { version: 1, name: 'init', sql: 'CREATE TABLE t1 (b TEXT);' },
    ];

    runMigrations(db, original);

    expect(() => runMigrations(db, tampered)).toThrow(/checksum|drift|alterada/i);
  });

  test('applies migrations in version order regardless of array order', () => {
    const db = freshDb();
    // v2 depends on v1 having created the table. Passed out of order on purpose.
    const list: Migration[] = [
      { version: 2, name: 'add-col', sql: 'ALTER TABLE ord ADD COLUMN b TEXT;' },
      { version: 1, name: 'create', sql: 'CREATE TABLE ord (a TEXT);' },
    ];

    expect(() => runMigrations(db, list)).not.toThrow();

    const cols = (db.prepare('PRAGMA table_info(ord)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('a');
    expect(cols).toContain('b');

    const versions = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
        version: number;
      }>
    ).map((r) => r.version);
    expect(versions).toEqual([1, 2]);
  });
});
