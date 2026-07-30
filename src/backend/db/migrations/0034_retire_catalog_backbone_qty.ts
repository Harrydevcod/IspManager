import type { Migration } from './types';

const migration: Migration = {
  version: 34,
  name: 'retire_catalog_backbone_qty',
  sql: `
    ALTER TABLE equipment_catalog DROP COLUMN backbone_qty;
  `
};

export default migration;
