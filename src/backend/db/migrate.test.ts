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

  test('document_sequences seeds from legacy id-based numbers without collision', () => {
    const db = freshDb();
    // Apply everything up to (but not including) the sequences migration, then
    // simulate a field database whose invoice/receipt numbers were produced by
    // the old id-based scheme (with gaps and across two years).
    const beforeSequences = migrations.filter((m) => m.version < 20);
    runMigrations(db, beforeSequences);

    const clientId = db.prepare(`
      INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-SEQ', 'Cliente Seq', 'active')
    `).run().lastInsertRowid;
    const serviceId = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 3500, 10, 'active')
    `).run(clientId).lastInsertRowid;

    const insertPayment = db.prepare(`
      INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number, receipt_number)
      VALUES (?, ?, ?, 3500, '2026-01-31', 'paid', ?, ?)
    `);
    insertPayment.run(clientId, serviceId, '2026-01', 'FT-2026-00005', 'RC-2026-00003');
    insertPayment.run(clientId, serviceId, '2026-02', 'FT-2026-00009', null);
    insertPayment.run(clientId, serviceId, '2027-01', 'FT-2027-00002', null);

    runMigrations(db, migrations);

    const seeded = db
      .prepare('SELECT series, year, last_number FROM document_sequences ORDER BY series, year')
      .all() as Array<{ series: string; year: number; last_number: number }>;
    expect(seeded).toEqual([
      { series: 'FT', year: 2026, last_number: 9 },
      { series: 'FT', year: 2027, last_number: 2 },
      { series: 'RC', year: 2026, last_number: 3 },
    ]);

    // The new uniqueness invariant is enforced at the schema level.
    expect(() =>
      insertPayment.run(clientId, serviceId, '2026-03', 'FT-2026-00009', null),
    ).toThrow();
  });

  test('document_sequences starts empty on a fresh database', () => {
    const db = freshDb();
    runMigrations(db);
    const count = db.prepare('SELECT COUNT(*) AS n FROM document_sequences').get() as { n: number };
    expect(count.n).toBe(0);
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

  test('creates the SMS monthly report index', () => {
    const db = freshDb();
    runMigrations(db, migrations);

    const indexes = db.prepare(`PRAGMA index_list('sms_outbox')`).all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain('idx_sms_outbox_created_status');

    db.close();
  });

  test('retires catalog backbone quantities only after preserving their physical devices', () => {
    const db = freshDb();
    const beforePhysicalBackboneMapping = migrations.filter((migration) => migration.version < 33);
    runMigrations(db, beforePhysicalBackboneMapping);

    db.prepare(`
      INSERT INTO equipment_catalog (type, brand, model, stock_total, backbone_qty, active)
      VALUES ('antena', 'Ubiquiti', 'Rocket Prism', 2, 2, 1)
    `).run();

    const throughPhysicalBackboneMapping = migrations.filter((migration) => migration.version <= 33);
    runMigrations(db, throughPhysicalBackboneMapping);

    const materializedDevices = db.prepare(`
      SELECT name, provisional, serial_number AS serialNumber
      FROM backbone_devices
      ORDER BY id
    `).all();
    expect(materializedDevices).toEqual([
      { name: 'Ubiquiti Rocket Prism #1', provisional: 1, serialNumber: null },
      { name: 'Ubiquiti Rocket Prism #2', provisional: 1, serialNumber: null }
    ]);
    expect(db.prepare('PRAGMA table_info(equipment_catalog)').all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'backbone_qty' })]));

    runMigrations(db, migrations);

    expect(db.prepare('PRAGMA table_info(equipment_catalog)').all())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'backbone_qty' })]));
    expect(db.prepare(`
      SELECT name, provisional, serial_number AS serialNumber
      FROM backbone_devices
      ORDER BY id
    `).all()).toEqual(materializedDevices);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('adopts backbone units and links recorded by the abandoned migration 31', () => {
    const db = freshDb();
    runMigrations(db, migrations.filter((migration) => migration.version < 33));

    const catalogId = db.prepare(`
      INSERT INTO equipment_catalog (type, brand, model, stock_total, backbone_qty, active)
      VALUES ('antena', 'TP-Link', 'CPE710', 3, 3, 1)
    `).run().lastInsertRowid;
    const clientId = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-LEGACY', 'Cliente Legacy', 'active')
    `).run().lastInsertRowid;
    const serviceId = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, due_day, status)
      VALUES (?, 3500, 10, 'active')
    `).run(clientId).lastInsertRowid;
    const assignmentId = db.prepare(`
      INSERT INTO service_device_assignments (service_id, catalog_id, start_date)
      VALUES (?, ?, '2026-07-28')
    `).run(serviceId, catalogId).lastInsertRowid;

    // The shape the abandoned development build left in the field.
    db.exec(`
      CREATE TABLE backbone_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        catalog_id INTEGER NOT NULL REFERENCES equipment_catalog(id) ON DELETE RESTRICT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        serial_number TEXT,
        asset_tag TEXT,
        ip_address TEXT,
        mac_address TEXT,
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE backbone_client_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backbone_device_id INTEGER NOT NULL REFERENCES backbone_devices(id) ON DELETE CASCADE,
        client_assignment_id INTEGER NOT NULL REFERENCES service_device_assignments(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(client_assignment_id)
      );
    `);
    db.prepare(`
      INSERT INTO backbone_devices (catalog_id, name, ip_address, active, created_at)
      VALUES (?, 'CPE710-Cruz', '192.168.1.140', 1, '2026-07-28 14:57:48')
    `).run(catalogId);
    db.prepare(`
      INSERT INTO backbone_devices (catalog_id, name, active) VALUES (?, 'CPE710-Retirado', 0)
    `).run(catalogId);
    db.prepare(`
      INSERT INTO backbone_client_links (backbone_device_id, client_assignment_id, created_at)
      VALUES (1, ?, '2026-07-28 16:29:48')
    `).run(assignmentId);

    runMigrations(db, migrations);

    expect(db.prepare(`
      SELECT name, ip_address AS ipAddress, status, provisional
      FROM backbone_devices ORDER BY id
    `).all()).toEqual([
      { name: 'CPE710-Cruz', ipAddress: '192.168.1.140', status: 'active', provisional: 0 },
      { name: 'CPE710-Retirado', ipAddress: null, status: 'retired', provisional: 0 },
      // Only the third catalogued unit is still unaccounted for.
      { name: 'TP-Link CPE710 #1', ipAddress: null, status: 'active', provisional: 1 }
    ]);
    expect(db.prepare(`
      SELECT backbone_device_id AS backboneDeviceId, assignment_id AS assignmentId,
             started_at AS startedAt, ended_at AS endedAt
      FROM backbone_assignment_links
    `).all()).toEqual([{
      backboneDeviceId: 1,
      assignmentId,
      startedAt: '2026-07-28 16:29:48',
      endedAt: null
    }]);
    expect(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%legacy%'
    `).all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'backbone_client_links'").all())
      .toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('enforces live physical identity and assignment-link invariants', () => {
    const db = freshDb();
    runMigrations(db);

    const catalogId = db.prepare(`
      INSERT INTO equipment_catalog (type, brand, model, stock_total, active)
      VALUES ('antena', 'Ubiquiti', 'Rocket Prism', 2, 1)
    `).run().lastInsertRowid;
    const clientId = db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('CLT-BACKBONE', 'Cliente Backbone', 'active')
    `).run().lastInsertRowid;
    const serviceId = db.prepare(`
      INSERT INTO services (client_id, monthly_value_cve, due_day, status)
      VALUES (?, 3500, 10, 'active')
    `).run(clientId).lastInsertRowid;
    const assignmentId = db.prepare(`
      INSERT INTO service_device_assignments (service_id, catalog_id, start_date)
      VALUES (?, ?, '2026-07-28')
    `).run(serviceId, catalogId).lastInsertRowid;
    const firstBackboneDeviceId = db.prepare(`
      INSERT INTO backbone_devices (catalog_id, name, serial_number)
      VALUES (?, 'Rocket Prism Norte', 'BACKBONE-42')
    `).run(catalogId).lastInsertRowid;
    const secondBackboneDeviceId = db.prepare(`
      INSERT INTO backbone_devices (catalog_id, name)
      VALUES (?, 'Rocket Prism Sul')
    `).run(catalogId).lastInsertRowid;

    db.prepare(`
      INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id)
      VALUES (?, ?)
    `).run(firstBackboneDeviceId, assignmentId);

    const insertSecondActiveLinkForSameAssignment = () => db.prepare(`
      INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id)
      VALUES (?, ?)
    `).run(secondBackboneDeviceId, assignmentId);
    const insertDuplicateLiveSerialIgnoringCase = () => db.prepare(`
      INSERT INTO backbone_devices (catalog_id, name, serial_number)
      VALUES (?, 'Rocket Prism Este', 'backbone-42')
    `).run(catalogId);
    const insertDuplicateRetiredSerial = () => db.prepare(`
      INSERT INTO backbone_devices (catalog_id, name, serial_number, status)
      VALUES (?, 'Rocket Prism Reserva', 'backbone-42', 'retired')
    `).run(catalogId);

    expect(insertSecondActiveLinkForSameAssignment).toThrow();
    expect(insertDuplicateLiveSerialIgnoringCase).toThrow();
    expect(insertDuplicateRetiredSerial).not.toThrow();
  });
});
