import type Database from 'better-sqlite3';

/**
 * Shared equipment-installation logic, used both by the standalone device-assignment
 * endpoint and by service creation with an inline device. Keeping it here guarantees
 * the two paths deduct stock, record movements and write the installation event the
 * exact same way.
 */

export type DeviceInput = {
  catalogId: number;
  serialNumber?: string | null;
  assetTag?: string | null;
  ipAddress?: string | null;
  macAddress?: string | null;
  technicianId?: number | null;
  notes?: string | null;
};

export type CatalogIdentity = {
  id: number;
  stockTotal: number;
  landedCostCve: number;
};

export type PreflightResult =
  | { ok: true; catalog: CatalogIdentity }
  | { ok: false; status: number; error: string };

export type InstallResult = {
  assignmentId: number | bigint;
  eventId: number | bigint;
};

export function cleanValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function loadCatalogIdentity(db: Database.Database, id: number): CatalogIdentity | undefined {
  return db.prepare(`
    SELECT
      id,
      stock_total AS stockTotal,
      (purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve) AS landedCostCve
    FROM equipment_catalog
    WHERE id = ?
  `).get(id) as CatalogIdentity | undefined;
}

/**
 * Validates that a device can be installed before opening a transaction: the model
 * exists, has stock, the technician (if any) is real, and no active assignment already
 * owns the serial/asset tag. Returns a discriminated result so callers map it to a reply.
 */
export function preflightDeviceInstall(db: Database.Database, device: DeviceInput): PreflightResult {
  const catalog = loadCatalogIdentity(db, device.catalogId);
  if (!catalog) {
    return { ok: false, status: 404, error: 'Modelo nao encontrado' };
  }
  if (catalog.stockTotal < 1) {
    return { ok: false, status: 400, error: `Stock insuficiente. Disponivel: ${catalog.stockTotal}` };
  }
  if (device.technicianId) {
    const technician = db.prepare('SELECT id FROM users WHERE id = ?').get(device.technicianId);
    if (!technician) {
      return { ok: false, status: 404, error: 'Tecnico nao encontrado' };
    }
  }

  const serialNumber = cleanValue(device.serialNumber);
  if (serialNumber) {
    const duplicate = db.prepare(`
      SELECT id FROM service_device_assignments
      WHERE serial_number = ? AND end_date IS NULL
    `).get(serialNumber);
    if (duplicate) {
      return { ok: false, status: 409, error: 'Serial ja esta atribuido a outro equipamento ativo' };
    }
  }

  const assetTag = cleanValue(device.assetTag);
  if (assetTag) {
    const duplicate = db.prepare(`
      SELECT id FROM service_device_assignments
      WHERE asset_tag = ? AND end_date IS NULL
    `).get(assetTag);
    if (duplicate) {
      return { ok: false, status: 409, error: 'Asset tag ja esta atribuido a outro equipamento ativo' };
    }
  }

  return { ok: true, catalog };
}

/**
 * Installs a device for a service. MUST be called inside a transaction so the
 * assignment, stock movement, catalog decrement and installation event commit or
 * roll back together. Re-checks stock for race safety and throws coded errors
 * (`stock_insufficient:<n>` / `catalog_missing`) consumed by {@link mapInstallError}.
 */
export function installDeviceWithinTx(
  db: Database.Database,
  params: { serviceId: number; clientName: string; device: DeviceInput; userId: number | null }
): InstallResult {
  const { serviceId, clientName, device, userId } = params;

  const freshCatalog = loadCatalogIdentity(db, device.catalogId);
  if (!freshCatalog) {
    throw new Error('catalog_missing');
  }
  if (freshCatalog.stockTotal < 1) {
    throw new Error(`stock_insufficient:${freshCatalog.stockTotal}`);
  }

  const serialNumber = cleanValue(device.serialNumber);
  const assetTag = cleanValue(device.assetTag);
  const ipAddress = cleanValue(device.ipAddress);
  const macAddress = cleanValue(device.macAddress);
  const notes = cleanValue(device.notes);
  const technicianId = device.technicianId || null;

  const assignment = db.prepare(`
    INSERT INTO service_device_assignments (
      service_id, catalog_id, serial_number, asset_tag, ip_address, mac_address,
      technician_id, notes, start_date, end_date, created_by, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now'), NULL, ?, datetime('now'), datetime('now'))
  `).run(
    serviceId,
    device.catalogId,
    serialNumber,
    assetTag,
    ipAddress,
    macAddress,
    technicianId,
    notes,
    technicianId
  );

  db.prepare(`
    INSERT INTO stock_movements (
      catalog_id, type, quantity, unit_cost_cve, reference, notes, service_id, client_name, created_by
    )
    VALUES (?, 'saida', 1, ?, ?, ?, ?, ?, ?)
  `).run(
    device.catalogId,
    freshCatalog.landedCostCve,
    `Instalacao servico ${serviceId}`,
    notes,
    serviceId,
    clientName,
    userId
  );

  db.prepare(`
    UPDATE equipment_catalog
    SET stock_total = stock_total - 1,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(device.catalogId);

  const event = db.prepare(`
    INSERT INTO service_events (
      service_id, event_type, notes, technician_id, created_by, created_at
    )
    VALUES (?, 'instalacao', ?, ?, ?, datetime('now'))
  `).run(serviceId, notes, technicianId, technicianId);

  return { assignmentId: assignment.lastInsertRowid, eventId: event.lastInsertRowid };
}

/** Maps an error thrown by {@link installDeviceWithinTx} to a reply, or null if unrelated. */
export function mapInstallError(error: unknown): { status: number; error: string } | null {
  if (error instanceof Error && error.message.startsWith('stock_insufficient:')) {
    return { status: 400, error: `Stock insuficiente. Disponivel: ${error.message.split(':')[1]}` };
  }
  return null;
}
