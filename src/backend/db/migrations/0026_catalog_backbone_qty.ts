import type { Migration } from './types';

/**
 * Replaces the boolean is_backbone (0025) with a per-model backbone quantity.
 * The same model can have some units on the backbone and others installed at
 * clients, which a boolean cannot express. `backbone_qty` counts how many units
 * of the model are transmission/backbone infrastructure.
 *
 * Carries forward existing data: a model previously flagged backbone keeps its
 * whole in-hand stock as backbone (the operator refines the exact count in the
 * UI). Then drops the now-redundant boolean column.
 */
const migration: Migration = {
  version: 26,
  name: 'catalog_backbone_qty',
  sql: `
    ALTER TABLE equipment_catalog ADD COLUMN backbone_qty INTEGER NOT NULL DEFAULT 0;
    UPDATE equipment_catalog SET backbone_qty = stock_total WHERE is_backbone = 1;
    ALTER TABLE equipment_catalog DROP COLUMN is_backbone;
  `
};

export default migration;
