import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { runMigrations } from './migrate';
import * as schema from './schema';

/**
 * Drift guard between the Drizzle schema (`schema.ts`) and the actual database
 * built by the migration chain. If a migration adds, renames, drops or retypes
 * a column without the matching change in `schema.ts` (or vice-versa), this
 * fails — turning "column does not exist" into a CI failure instead of a
 * runtime surprise.
 *
 * Internal tables owned by the migration runner are not part of the domain
 * schema and are intentionally not declared in Drizzle.
 */
const RUNNER_OWNED = new Set(['schema_migrations']);

type PragmaColumn = { name: string; type: string; notnull: number; pk: number };

function buildLiveSchema(): Map<string, Map<string, PragmaColumn>> {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>;
    const map = new Map<string, Map<string, PragmaColumn>>();
    for (const { name } of tables) {
      if (RUNNER_OWNED.has(name)) continue;
      const cols = db.prepare(`PRAGMA table_info(${name})`).all() as PragmaColumn[];
      map.set(name, new Map(cols.map((c) => [c.name, c])));
    }
    return map;
  } finally {
    db.close();
  }
}

function drizzleTables() {
  // Cast through `unknown` because `schema` also exports inferred row *types*
  // (erased at runtime) alongside the table values; the predicate then narrows
  // cleanly from the generic base type.
  return (Object.values(schema) as unknown[])
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .map((table) => getTableConfig(table));
}

describe('schema drift: Drizzle ↔ migrations', () => {
  const live = buildLiveSchema();
  const declared = drizzleTables();
  const declaredNames = new Set(declared.map((t) => t.name));

  test('every migrated table is declared in the Drizzle schema', () => {
    const missing = [...live.keys()].filter((name) => !declaredNames.has(name)).sort();
    expect(missing, `tables in DB but missing from schema.ts: ${missing.join(', ')}`).toEqual([]);
  });

  test('every Drizzle table exists in the migrated database', () => {
    const extra = [...declaredNames].filter((name) => !live.has(name)).sort();
    expect(extra, `tables in schema.ts but not created by any migration: ${extra.join(', ')}`).toEqual([]);
  });

  // One assertion per declared table so a failure points at the exact table.
  for (const table of declared) {
    test(`table "${table.name}" matches columns, affinity and primary key`, () => {
      const liveCols = live.get(table.name);
      expect(liveCols, `table ${table.name} not found in migrated DB`).toBeDefined();
      if (!liveCols) return;

      const declaredCols = new Map(
        table.columns.map((c) => [
          c.name,
          { type: c.getSQLType().toUpperCase(), pk: c.primary }
        ])
      );

      // Same set of column names, both directions.
      expect(
        [...declaredCols.keys()].sort(),
        `column name mismatch on ${table.name}`
      ).toEqual([...liveCols.keys()].sort());

      // Affinity + primary-key flag per column.
      for (const [colName, declaredCol] of declaredCols) {
        const liveCol = liveCols.get(colName);
        if (!liveCol) continue; // covered by the set comparison above
        expect(declaredCol.type, `affinity mismatch on ${table.name}.${colName}`).toBe(liveCol.type);
        expect(declaredCol.pk, `primary-key flag mismatch on ${table.name}.${colName}`).toBe(liveCol.pk === 1);
      }
    });
  }
});
