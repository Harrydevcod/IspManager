import type { Migration } from './types';

/**
 * Extends the stock catalog so serialized equipment and consumable materials
 * share one inventory surface, then records material consumption per service.
 *
 * SQLite cannot alter the existing CHECK constraint on equipment_catalog.type
 * in place, so this follows the rebuild pattern while preserving catalog ids.
 */
const migration: Migration = {
  version: 18,
  name: 'catalog_categories_materials',
  sql: `
    PRAGMA defer_foreign_keys = ON;

    CREATE TABLE equipment_catalog_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'equipamento' CHECK(category IN ('equipamento','material')),
      type TEXT NOT NULL CHECK(type IN ('cpe','router','antena','switch','cabo','conector','ficha','suporte','outro')),
      brand TEXT,
      model TEXT NOT NULL,
      description TEXT,
      supplier TEXT,
      unit_of_measure TEXT NOT NULL DEFAULT 'un',
      is_serialized INTEGER NOT NULL DEFAULT 1,
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

    INSERT INTO equipment_catalog_new (
      id, category, type, brand, model, description, supplier, unit_of_measure, is_serialized,
      purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve,
      selling_price_cve, rental_fee_cve, stock_total, active, created_at, updated_at
    )
    SELECT
      id, 'equipamento', type, brand, model, description, supplier, 'un', 1,
      purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve,
      selling_price_cve, rental_fee_cve, stock_total, active, created_at, updated_at
    FROM equipment_catalog;

    DROP TABLE equipment_catalog;
    ALTER TABLE equipment_catalog_new RENAME TO equipment_catalog;

    CREATE INDEX IF NOT EXISTS idx_eq_catalog_type ON equipment_catalog(type);
    CREATE INDEX IF NOT EXISTS idx_eq_catalog_category ON equipment_catalog(category);

    CREATE TABLE IF NOT EXISTS service_material_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL REFERENCES services(id),
      catalog_id INTEGER NOT NULL REFERENCES equipment_catalog(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_cost_cve REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_service_material_lines_service ON service_material_lines(service_id);
    CREATE INDEX IF NOT EXISTS idx_service_material_lines_catalog ON service_material_lines(catalog_id);

    CREATE TABLE IF NOT EXISTS service_install_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL REFERENCES services(id),
      kind TEXT NOT NULL CHECK(kind IN ('mao_de_obra','transporte','outro')),
      description TEXT,
      amount_cve REAL NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_service_install_costs_service ON service_install_costs(service_id);
  `
};

export default migration;
