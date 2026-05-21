const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sourcePath = process.argv[2] || path.join(
  process.env.APPDATA || path.join(os.homedir(), '.local', 'share'),
  'ISPManager',
  'isp-manager.db'
);
const targetDir = process.env.ISPM_DATA_DIR || path.join(
  process.env.APPDATA || path.join(os.homedir(), '.local', 'share'),
  'ISPM'
);
const targetPath = path.join(targetDir, 'ispm.sqlite');

if (!fs.existsSync(sourcePath)) {
  console.error(`Base antiga nao encontrada: ${sourcePath}`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

const source = new Database(sourcePath, { readonly: true });
const target = new Database(targetPath);

target.exec(`
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

  CREATE INDEX IF NOT EXISTS idx_eq_catalog_type ON equipment_catalog(type);
  CREATE INDEX IF NOT EXISTS idx_stock_mov_catalog ON stock_movements(catalog_id);
  CREATE INDEX IF NOT EXISTS idx_stock_mov_service ON stock_movements(service_id);
`);

const sourceTables = source.prepare(`
  SELECT name FROM sqlite_master WHERE type = 'table'
`).all().map((row) => row.name);

if (!sourceTables.includes('equipment_catalog')) {
  console.error('A base antiga nao contem a tabela equipment_catalog.');
  process.exit(1);
}

const importCatalog = target.prepare(`
  INSERT INTO equipment_catalog (
    id, type, brand, model, description, supplier, purchase_price_cve,
    shipping_cost_cve, customs_duty_cve, other_costs_cve, selling_price_cve,
    rental_fee_cve, stock_total, active, created_at, updated_at
  )
  VALUES (
    @id, @type, @brand, @model, @description, @supplier, @purchase_price_cve,
    @shipping_cost_cve, @customs_duty_cve, @other_costs_cve, @selling_price_cve,
    @rental_fee_cve, @stock_total, @active, @created_at, @updated_at
  )
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type,
    brand = excluded.brand,
    model = excluded.model,
    description = excluded.description,
    supplier = excluded.supplier,
    purchase_price_cve = excluded.purchase_price_cve,
    shipping_cost_cve = excluded.shipping_cost_cve,
    customs_duty_cve = excluded.customs_duty_cve,
    other_costs_cve = excluded.other_costs_cve,
    selling_price_cve = excluded.selling_price_cve,
    rental_fee_cve = excluded.rental_fee_cve,
    stock_total = excluded.stock_total,
    active = excluded.active,
    updated_at = excluded.updated_at
`);

const importMovement = target.prepare(`
  INSERT INTO stock_movements (
    id, catalog_id, type, quantity, unit_cost_cve, supplier, reference,
    notes, service_id, client_name, created_by, created_at
  )
  VALUES (
    @id, @catalog_id, @type, @quantity, @unit_cost_cve, @supplier, @reference,
    @notes, @service_id, @client_name, @created_by, @created_at
  )
  ON CONFLICT(id) DO UPDATE SET
    catalog_id = excluded.catalog_id,
    type = excluded.type,
    quantity = excluded.quantity,
    unit_cost_cve = excluded.unit_cost_cve,
    supplier = excluded.supplier,
    reference = excluded.reference,
    notes = excluded.notes,
    service_id = excluded.service_id,
    client_name = excluded.client_name,
    created_by = excluded.created_by,
    created_at = excluded.created_at
`);

const catalogs = source.prepare(`
  SELECT id, type, brand, model, description, supplier, purchase_price_cve,
    shipping_cost_cve, customs_duty_cve, other_costs_cve, selling_price_cve,
    rental_fee_cve, stock_total, active, created_at, updated_at
  FROM equipment_catalog
`).all();

const movements = sourceTables.includes('stock_movements')
  ? source.prepare(`
      SELECT id, catalog_id, type, quantity, unit_cost_cve, supplier, reference,
        notes, service_id, client_name, created_by, created_at
      FROM stock_movements
    `).all()
  : [];

target.transaction(() => {
  catalogs.forEach((row) => importCatalog.run(row));
  movements.forEach((row) => importMovement.run(row));
})();

console.log(`Equipamentos importados/atualizados: ${catalogs.length}`);
console.log(`Movimentos de stock importados/atualizados: ${movements.length}`);
console.log(`Origem: ${sourcePath}`);
console.log(`Destino: ${targetPath}`);

source.close();
target.close();
