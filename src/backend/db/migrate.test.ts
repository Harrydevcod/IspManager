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
    expect(tableExists(db, 'sms_outbox')).toBe(true);
    expect(tableExists(db, 'sms_companion_pairing')).toBe(true);
    const smsOutboxColumns = (db.prepare('PRAGMA table_info(sms_outbox)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(smsOutboxColumns).toContain('failed_at');
  });

  test('catalog rebuild preserves referenced rows with foreign keys enabled', () => {
    const db = freshDb();
    const beforeCatalogMaterials = migrations.filter((migration) => migration.version < 18);
    runMigrations(db, beforeCatalogMaterials);

    const clientId = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-MIG', 'Cliente Migration', 'active')
    `).run().lastInsertRowid;
    const serviceId = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, due_day, status)
      VALUES (?, 3500, 10, 'active')
    `).run(clientId).lastInsertRowid;
    const catalogId = db.prepare(`
      INSERT INTO equipment_catalog (type, model, stock_total, active)
      VALUES ('router', 'Router Referenciado', 2, 1)
    `).run().lastInsertRowid;

    db.prepare(`
      INSERT INTO service_device_assignments (service_id, catalog_id, start_date)
      VALUES (?, ?, '2026-06-06')
    `).run(serviceId, catalogId);
    db.prepare(`
      INSERT INTO stock_movements (catalog_id, type, quantity, service_id)
      VALUES (?, 'saida', 1, ?)
    `).run(catalogId, serviceId);

    db.pragma('foreign_keys = ON');

    expect(() => runMigrations(db, migrations)).not.toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT category, is_serialized AS isSerialized FROM equipment_catalog WHERE id = ?').get(catalogId))
      .toEqual({ category: 'equipamento', isSerialized: 1 });
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

  test('money_centavos converts every money column ×100 and preserves rows', () => {
    const db = freshDb();
    const beforeMoney = migrations.filter((m) => m.version < 21);
    runMigrations(db, beforeMoney);

    // Seed one row per money-bearing table with known escudo amounts.
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-CENT','Cliente Cent','active')`).run().lastInsertRowid;
    const planId = db.prepare(`INSERT INTO internet_plans (name, monthly_price_cve, installation_fee_cve) VALUES ('P', 3500, 12000)`).run().lastInsertRowid;
    const serviceId = db.prepare(`INSERT INTO services (client_id, plan_id, monthly_value_cve, audiovisual_monthly_cve, audiovisual_annual_cve, due_day, status) VALUES (?, ?, 3500, 500, 6000, 10, 'active')`).run(clientId, planId).lastInsertRowid;
    const paymentId = db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?, ?, '2026-01', 4000, '2026-01-31', 'pending')`).run(clientId, serviceId).lastInsertRowid;
    db.prepare(`INSERT INTO payment_lines (payment_id, kind, description, amount_cve, sort_order) VALUES (?, 'internet', 'Internet', 3500, 0)`).run(paymentId);
    const catalogId = db.prepare(`INSERT INTO equipment_catalog (type, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, selling_price_cve, rental_fee_cve, stock_total, active) VALUES ('router','R', 10000, 500, 250, 100, 15000, 800, 1, 1)`).run().lastInsertRowid;
    db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve) VALUES (?, 'entrada', 1, 10000)`).run(catalogId);
    const investmentId = db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, status, expected_monthly_revenue_cve, total_cost_cve, monthly_operational_cost_cve, accumulated_revenue_cve) VALUES ('Inv','zona','2026-01-01','2026-01','ativo', 9000, 50000, 1200, 3000)`).run().lastInsertRowid;
    db.prepare(`INSERT INTO investment_items (investment_id, item_type, item_name, quantity, unit_cost_cve, total_cost_cve) VALUES (?, 'router', 'Item', 2, 2500, 5000)`).run(investmentId);
    db.prepare(`INSERT INTO expenses (category, description, amount_cve, expense_date, reference_month) VALUES ('energia','Luz', 7500, '2026-01-05', '2026-01')`).run();
    db.prepare(`INSERT INTO expense_templates (name, category, amount_cve, day_of_month) VALUES ('Renda','aluguer', 25000, 1)`).run();

    db.pragma('foreign_keys = ON');
    expect(() => runMigrations(db, migrations)).not.toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // Money columns are now INTEGER centavos = escudos × 100.
    const isInteger = (table: string, col: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>)
        .find((c) => c.name === col)?.type === 'INTEGER';

    expect(isInteger('payments', 'amount_centavos')).toBe(true);
    expect(isInteger('expenses', 'amount_centavos')).toBe(true);
    expect(isInteger('investments', 'total_cost_centavos')).toBe(true);

    expect(db.prepare('SELECT monthly_price_centavos AS v FROM internet_plans WHERE id=?').get(planId)).toEqual({ v: 350000 });
    expect(db.prepare('SELECT installation_fee_centavos AS v FROM internet_plans WHERE id=?').get(planId)).toEqual({ v: 1200000 });
    expect(db.prepare('SELECT monthly_value_centavos AS m, audiovisual_monthly_centavos AS am, audiovisual_annual_centavos AS aa FROM services WHERE id=?').get(serviceId))
      .toEqual({ m: 350000, am: 50000, aa: 600000 });
    expect(db.prepare('SELECT amount_centavos AS v FROM payments WHERE id=?').get(paymentId)).toEqual({ v: 400000 });
    expect(db.prepare('SELECT amount_centavos AS v FROM payment_lines WHERE payment_id=?').get(paymentId)).toEqual({ v: 350000 });
    expect(db.prepare('SELECT purchase_price_centavos AS p, selling_price_centavos AS s, rental_fee_centavos AS r FROM equipment_catalog WHERE id=?').get(catalogId))
      .toEqual({ p: 1000000, s: 1500000, r: 80000 });
    expect(db.prepare('SELECT unit_cost_centavos AS v FROM stock_movements WHERE catalog_id=?').get(catalogId)).toEqual({ v: 1000000 });
    expect(db.prepare('SELECT total_cost_centavos AS t, monthly_operational_cost_centavos AS o, accumulated_revenue_centavos AS a, expected_monthly_revenue_centavos AS e FROM investments WHERE id=?').get(investmentId))
      .toEqual({ t: 5000000, o: 120000, a: 300000, e: 900000 });
    expect(db.prepare('SELECT unit_cost_centavos AS u, total_cost_centavos AS t FROM investment_items WHERE investment_id=?').get(investmentId))
      .toEqual({ u: 250000, t: 500000 });
    expect(db.prepare(`SELECT amount_centavos AS v FROM expenses WHERE description='Luz'`).get()).toEqual({ v: 750000 });
    expect(db.prepare(`SELECT amount_centavos AS v FROM expense_templates WHERE name='Renda'`).get()).toEqual({ v: 2500000 });
  });

  test('sms companion pairing rejects active rows without key hash or base URL', () => {
    const db = freshDb();

    runMigrations(db);

    expect(() => db.prepare(`
      INSERT INTO sms_companion_pairing (id, device_name, paired_at)
      VALUES (1, 'Android', datetime('now'))
    `).run()).toThrow();

    expect(() => db.prepare(`
      INSERT INTO sms_companion_pairing (id, device_name, base_url, pairing_key_hash, paired_at)
      VALUES (1, 'Android', 'http://192.168.1.50:8765', ?, datetime('now'))
    `).run('a'.repeat(64))).not.toThrow();
  });
});
