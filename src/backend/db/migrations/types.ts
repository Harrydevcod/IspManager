/**
 * A single, immutable schema migration.
 *
 * Migrations are authored as TypeScript modules (not loose `.sql` files) so the
 * plain-`tsc` backend build compiles and packages them automatically into
 * `dist/**` — see docs/adr/0003-versioned-sql-migrations.md.
 *
 * Once a migration has shipped and been applied in the field its `sql` is
 * frozen: the runner records a checksum and refuses to start if it changes.
 * Evolve the schema by adding a new, higher-numbered migration.
 */
export interface Migration {
  /** Monotonic, unique, gap-free is preferred but only ordering matters. */
  version: number;
  /** Human-readable label, recorded in schema_migrations for audit. */
  name: string;
  /** One or more SQL statements applied atomically in a transaction. */
  sql: string;
}
