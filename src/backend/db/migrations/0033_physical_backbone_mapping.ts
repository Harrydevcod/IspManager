import type { Migration } from './types';

/**
 * Physical backbone units become first-class rows with their own identity, and
 * CPE assignments hang off them through an explicit, temporal link.
 *
 * Version 33 rather than 31: an abandoned development build applied a different
 * migration 31 (`backbone_devices`) on at least one field database, where an
 * operator already recorded real units and links. That legacy shape is adopted
 * here instead of being dropped. The `CREATE TABLE IF NOT EXISTS` pair makes the
 * legacy tables addressable on installs that never ran that build, so one
 * statement list is valid everywhere; both are dropped before the migration ends.
 */
const migration: Migration = {
  version: 33,
  name: 'physical_backbone_mapping',
  sql: `
    CREATE TABLE IF NOT EXISTS backbone_devices (
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
    CREATE TABLE IF NOT EXISTS backbone_client_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backbone_device_id INTEGER NOT NULL REFERENCES backbone_devices(id) ON DELETE CASCADE,
      client_assignment_id INTEGER NOT NULL REFERENCES service_device_assignments(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(client_assignment_id)
    );
    ALTER TABLE backbone_devices RENAME TO backbone_devices_legacy;
    ALTER TABLE backbone_client_links RENAME TO backbone_client_links_legacy;

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

    INSERT INTO backbone_devices(
      id, catalog_id, name, serial_number, asset_tag, ip_address, mac_address,
      status, provisional, notes, created_by, created_at, updated_at
    )
      SELECT
        id, catalog_id, name, serial_number, asset_tag, ip_address, mac_address,
        CASE WHEN active = 1 THEN 'active' ELSE 'retired' END, 0,
        notes, created_by, created_at, updated_at
      FROM backbone_devices_legacy;

    INSERT INTO backbone_assignment_links(
      backbone_device_id, assignment_id, started_at, created_at, updated_at
    )
      SELECT backbone_device_id, client_assignment_id, created_at, created_at, updated_at
      FROM backbone_client_links_legacy;

    WITH RECURSIVE units(catalog_id, label, ordinal, maximum) AS (
      SELECT
        ec.id,
        trim(coalesce(ec.brand || ' ', '') || ec.model),
        1,
        ec.backbone_qty - (
          SELECT COUNT(*) FROM backbone_devices_legacy legacy
          WHERE legacy.catalog_id = ec.id
        )
      FROM equipment_catalog ec
      WHERE ec.backbone_qty > (
        SELECT COUNT(*) FROM backbone_devices_legacy legacy
        WHERE legacy.catalog_id = ec.id
      )
      UNION ALL
      SELECT catalog_id, label, ordinal + 1, maximum
      FROM units WHERE ordinal < maximum
    )
    INSERT INTO backbone_devices(catalog_id, name, provisional)
      SELECT catalog_id, label || ' #' || ordinal, 1 FROM units;

    DROP TABLE backbone_client_links_legacy;
    DROP TABLE backbone_devices_legacy;
  `
};

export default migration;
