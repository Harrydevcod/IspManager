import type { Migration } from './types';

/**
 * Repetidor WiFi no catálogo de equipamento.
 *
 * O que está instalado na casa de um cliente atrás da antena nem sempre é um
 * router: um repetidor com entrada de cabo liga por rede à segunda saída do CPE
 * e distribui sem fios lá dentro, fazendo também de ponto de acesso. Não
 * encaminha nem é a antena — registá-lo como `router` era o menos errado dos
 * tipos que havia.
 *
 * Isto não mexe na topologia: o que decide onde um equipamento pende é ter ou
 * não link ao backbone, nunca o tipo de catálogo.
 *
 * O CHECK de `type` alarga-se por reconstrução da tabela, no molde da 0018 que
 * criou este mesmo CHECK — o SQLite não altera um CHECK no sítio. As colunas
 * copiam-se por nome e os ids mantêm-se, para as quatro tabelas que referenciam
 * o catálogo (`stock_movements`, `service_device_assignments`,
 * `service_material_lines`, `backbone_devices`) continuarem a apontar para as
 * mesmas linhas.
 */
const migration: Migration = {
  version: 46,
  name: 'catalog_repeater_type',
  sql: `
    PRAGMA defer_foreign_keys = ON;

    CREATE TABLE equipment_catalog_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'equipamento' CHECK(category IN ('equipamento','material')),
      type TEXT NOT NULL CHECK(type IN ('cpe','router','antena','repetidor','switch','cabo','conector','ficha','suporte','outro')),
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
      id, category, type, brand, model, description, supplier, unit_of_measure, is_serialized,
      purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve,
      selling_price_cve, rental_fee_cve, stock_total, active, created_at, updated_at
    FROM equipment_catalog;

    DROP TABLE equipment_catalog;
    ALTER TABLE equipment_catalog_new RENAME TO equipment_catalog;

    CREATE INDEX IF NOT EXISTS idx_eq_catalog_type ON equipment_catalog(type);
    CREATE INDEX IF NOT EXISTS idx_eq_catalog_category ON equipment_catalog(category);
  `
};

export default migration;
