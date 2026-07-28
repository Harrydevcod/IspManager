import type { Migration } from './types';

const migration: Migration = {
  version: 31,
  name: 'physical_backbone_mapping',
  sql: `
    CREATE TABLE backbone_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_id INTEGER NOT NULL REFERENCES equipment_catalog(id) ON DELETE RESTRICT,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      serial_number TEXT,
      asset_tag TEXT,
      ip_address TEXT,
      mac_address TEXT,
      island TEXT,
      zone TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','maintenance','retired')) DEFAULT 'active',
      provisional INTEGER NOT NULL CHECK(provisional IN (0,1)) DEFAULT 0,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_backbone_devices_serial_live
      ON backbone_devices(lower(serial_number))
      WHERE serial_number IS NOT NULL AND trim(serial_number) <> '' AND status <> 'retired';
    CREATE UNIQUE INDEX idx_backbone_devices_asset_live
      ON backbone_devices(lower(asset_tag))
      WHERE asset_tag IS NOT NULL AND trim(asset_tag) <> '' AND status <> 'retired';
    CREATE INDEX idx_backbone_devices_catalog_status
      ON backbone_devices(catalog_id, status);

    CREATE TABLE backbone_assignment_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backbone_device_id INTEGER NOT NULL REFERENCES backbone_devices(id) ON DELETE RESTRICT,
      assignment_id INTEGER NOT NULL REFERENCES service_device_assignments(id) ON DELETE RESTRICT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      change_reason TEXT,
      created_by INTEGER REFERENCES users(id),
      ended_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(ended_at IS NULL OR ended_at >= started_at)
    );
    CREATE UNIQUE INDEX idx_backbone_assignment_links_one_active
      ON backbone_assignment_links(assignment_id) WHERE ended_at IS NULL;
    CREATE INDEX idx_backbone_assignment_links_backbone_active
      ON backbone_assignment_links(backbone_device_id, ended_at);
    CREATE INDEX idx_backbone_assignment_links_assignment_history
      ON backbone_assignment_links(assignment_id, started_at);

    WITH RECURSIVE units(catalog_id, label, ordinal, maximum) AS (
      SELECT id, trim(coalesce(brand || ' ', '') || model), 1, backbone_qty
      FROM equipment_catalog WHERE backbone_qty > 0
      UNION ALL
      SELECT catalog_id, label, ordinal + 1, maximum
      FROM units WHERE ordinal < maximum
    )
    INSERT INTO backbone_devices(catalog_id, name, provisional)
      SELECT catalog_id, label || ' #' || ordinal, 1 FROM units;
  `
};

export default migration;
