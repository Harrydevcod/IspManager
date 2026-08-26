import type { Migration } from './types';

/**
 * O tipo do catálogo deixa de ser uma lista fechada.
 *
 * Até aqui, `type` vivia preso a um CHECK com dez valores. Cada equipamento novo
 * que o vocabulário não previsse — um ponto de acesso, por exemplo — obrigava a
 * uma migração de reconstrução, uma linha em cada uma das quatro cópias da lista
 * e uma versão nova da aplicação para o operador poder registá-lo. Quem tem o
 * equipamento na mão não pode esperar por isso.
 *
 * A partir daqui o tipo é texto: os dez continuam a ser oferecidos como
 * predefinidos, e o operador escreve o que faltar no próprio formulário. O CHECK
 * que fica é o único que interessa a esta camada — que não venha vazio.
 *
 * Isto não dá comportamento nenhum a um tipo escrito à mão: quem leva IP fixo e
 * quem pode ligar ao backbone continua a ser decidido por listas fixas no código
 * (`STATIC_IP_EQUIPMENT_TYPES`, `BACKBONE_UPLINK_TYPES`), e um tipo novo cai
 * naturalmente fora das duas.
 *
 * Reconstrução no molde da 0046 — o SQLite não altera um CHECK no sítio. As
 * colunas copiam-se por nome e os ids mantêm-se, para as quatro tabelas que
 * referenciam o catálogo (`stock_movements`, `service_device_assignments`,
 * `service_material_lines`, `backbone_devices`) continuarem a apontar para as
 * mesmas linhas.
 */
const migration: Migration = {
  version: 47,
  name: 'catalog_free_type',
  sql: `
    PRAGMA defer_foreign_keys = ON;

    CREATE TABLE equipment_catalog_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'equipamento' CHECK(category IN ('equipamento','material')),
      type TEXT NOT NULL CHECK(length(trim(type)) > 0),
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
