import type { Migration } from './types';

/**
 * Marks catalog entries as backbone (signal transmission) infrastructure so the
 * inventory separates transmission gear from client equipment, and so the
 * profitability view can surface backbone capital on its own line.
 *
 * ADD COLUMN does not touch the existing CHECK constraint, so no table rebuild
 * is needed. Default 0 → all current catalog entries stay "client", unchanged.
 */
const migration: Migration = {
  version: 25,
  name: 'catalog_backbone_flag',
  sql: `
    ALTER TABLE equipment_catalog ADD COLUMN is_backbone INTEGER NOT NULL DEFAULT 0;
  `
};

export default migration;
