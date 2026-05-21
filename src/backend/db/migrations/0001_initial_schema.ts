import type { Migration } from './types';

/**
 * Baseline. This is the schema exactly as the old `getDatabase()` bootstrap
 * produced it — every statement is `CREATE TABLE/INDEX IF NOT EXISTS`, so
 * running it against a pre-existing field database is a no-op that touches no
 * data, while a fresh database is built entirely from here.
 *
 * `internet_plans.description` is included directly: the old code added it via
 * an ad-hoc `ensureColumn` probe, so field databases already have it and
 * `IF NOT EXISTS` keeps them untouched.
 */
const migration: Migration = {
  version: 1,
  name: 'initial_schema',
  sql: `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','operator','technician')),
      full_name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
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

    CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(full_name);
    CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

    CREATE TABLE IF NOT EXISTS internet_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      download_speed TEXT NOT NULL DEFAULT '',
      upload_speed TEXT NOT NULL DEFAULT '',
      connection_type TEXT NOT NULL DEFAULT 'outro',
      monthly_price_cve REAL NOT NULL DEFAULT 0,
      installation_fee_cve REAL NOT NULL DEFAULT 0,
      description TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS equipment_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('cpe','router','antena','switch','outro')),
      brand TEXT,
      model TEXT NOT NULL,
      description TEXT,
      supplier TEXT,
      purchase_price_cve REAL NOT NULL DEFAULT 0,
      shipping_cost_cve REAL NOT NULL DEFAULT 0,
      customs_duty_cve REAL NOT NULL DEFAULT 0,
      other_costs_cve REAL NOT NULL DEFAULT 0,
      selling_price_cve REAL NOT NULL DEFAULT 0,
      rental_fee_cve REAL NOT NULL DEFAULT 0,
      stock_total INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_eq_catalog_type ON equipment_catalog(type);

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      plan_id INTEGER REFERENCES internet_plans(id),
      monthly_value_cve REAL NOT NULL DEFAULT 0,
      activation_date TEXT,
      due_day INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('active','suspended','cancelled')) DEFAULT 'active',
      ip_address TEXT,
      technical_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS service_device_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL REFERENCES services(id),
      catalog_id INTEGER NOT NULL REFERENCES equipment_catalog(id),
      serial_number TEXT,
      asset_tag TEXT,
      ip_address TEXT,
      mac_address TEXT,
      technician_id INTEGER REFERENCES users(id),
      notes TEXT,
      start_date TEXT NOT NULL DEFAULT (date('now')),
      end_date TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_service_device_assignments_service ON service_device_assignments(service_id);
    CREATE INDEX IF NOT EXISTS idx_service_device_assignments_catalog ON service_device_assignments(catalog_id);
    CREATE INDEX IF NOT EXISTS idx_service_device_assignments_end_date ON service_device_assignments(end_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_service_device_assignments_serial_active
      ON service_device_assignments(serial_number)
      WHERE serial_number IS NOT NULL AND end_date IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_service_device_assignments_asset_active
      ON service_device_assignments(asset_tag)
      WHERE asset_tag IS NOT NULL AND end_date IS NULL;

    CREATE TABLE IF NOT EXISTS service_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL REFERENCES services(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('instalacao','manutencao','troca_equipamento','visita','alteracao_servico')),
      notes TEXT,
      technician_id INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_service_events_service ON service_events(service_id);
    CREATE INDEX IF NOT EXISTS idx_service_events_type ON service_events(event_type);

    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_id INTEGER NOT NULL REFERENCES equipment_catalog(id),
      type TEXT NOT NULL CHECK(type IN ('entrada','saida','devolucao','ajuste')),
      quantity INTEGER NOT NULL,
      unit_cost_cve REAL NOT NULL DEFAULT 0,
      supplier TEXT,
      reference TEXT,
      notes TEXT,
      service_id INTEGER REFERENCES services(id),
      client_name TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_stock_mov_catalog ON stock_movements(catalog_id);
    CREATE INDEX IF NOT EXISTS idx_stock_mov_service ON stock_movements(service_id);

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      service_id INTEGER NOT NULL REFERENCES services(id),
      reference_month TEXT NOT NULL,
      amount_cve REAL NOT NULL,
      due_date TEXT NOT NULL,
      payment_date TEXT,
      payment_method TEXT CHECK(payment_method IN ('numerario','transferencia','outro')),
      status TEXT NOT NULL CHECK(status IN ('pending','paid','overdue','cancelled')) DEFAULT 'pending',
      invoice_number TEXT,
      invoice_date TEXT,
      receipt_number TEXT,
      receipt_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(service_id, reference_month)
    );

    CREATE INDEX IF NOT EXISTS idx_services_client ON services(client_id);
    CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);
    CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(reference_month);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};

export default migration;
