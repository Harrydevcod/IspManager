import type Database from 'better-sqlite3';
import { z } from 'zod';

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
  /**
   * 'cliente' = equipamento que o cliente trouxe, não gera renda nem cobrança de
   * compra. Por omissão o equipamento é do ISP e é alugado.
   */
  ownership?: 'isp' | 'cliente' | null;
};

export type ServiceItemInput = DeviceInput & { quantity?: number | null };

export type InstallCostInput = {
  kind?: 'mao_de_obra' | 'transporte' | 'outro';
  description?: string | null;
  amountCve: number;
};

export type CatalogIdentity = {
  id: number;
  stockTotal: number;
  /** Renda mensal em vigor para o modelo — copiada para a atribuição na instalação. */
  rentalFeeCve: number;
  landedCostCve: number;
};

export type CatalogKind = CatalogIdentity & {
  isSerialized: number;
};

export type PreflightResult =
  | { ok: true; catalog: CatalogIdentity }
  | { ok: false; status: number; error: string };

export type ItemsPreflight =
  | { ok: true }
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
      rental_fee_cve AS rentalFeeCve,
      (purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve) AS landedCostCve
    FROM equipment_catalog
    WHERE id = ?
  `).get(id) as CatalogIdentity | undefined;
}

export function loadCatalogKind(db: Database.Database, id: number): CatalogKind | undefined {
  return db.prepare(`
    SELECT
      id,
      is_serialized AS isSerialized,
      stock_total AS stockTotal,
      rental_fee_cve AS rentalFeeCve,
      (purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve) AS landedCostCve
    FROM equipment_catalog
    WHERE id = ?
  `).get(id) as CatalogKind | undefined;
}

const IPV4 = z.string().ip({ version: 'v4' });

export const IP_FORMAT_ERROR = 'IP invalido. Use o formato IPv4, ex.: 192.168.1.10';

export function isIpv4(value: string): boolean {
  return IPV4.safeParse(value).success;
}

const IDENTITY_FIELDS = [
  { key: 'serialNumber', column: 'serial_number', label: 'Serial' },
  { key: 'assetTag', column: 'asset_tag', label: 'Asset tag' },
  { key: 'ipAddress', column: 'ip_address', label: 'IP' }
] as const;

export type DeviceIdentity = Pick<DeviceInput, 'serialNumber' | 'assetTag' | 'ipAddress'>;

export type IdentityIssue = { status: number; error: string };

/**
 * Formato do IP + unicidade de serial/asset tag/IP entre atribuicoes ATIVAS
 * (`end_date IS NULL`). Ponto unico partilhado pelos quatro caminhos de escrita:
 * criacao de servico com itens, POST /items, /replace e PATCH. `excludeAssignmentId`
 * ignora a propria linha. Campos vazios nao sao verificados.
 *
 * O IP e critico para manutencao remota (identificar a antena do cliente), por isso
 * duplicados ativos sao recusados aqui em vez de por indice unico: a BD real pode ja
 * conter duplicados legados e uma migracao a falhar bloqueia o arranque da app.
 */
export function checkDeviceIdentity(
  db: Database.Database,
  device: DeviceIdentity,
  excludeAssignmentId?: number | null
): IdentityIssue | null {
  const ipAddress = cleanValue(device.ipAddress);
  if (ipAddress && !isIpv4(ipAddress)) {
    return { status: 400, error: IP_FORMAT_ERROR };
  }

  for (const field of IDENTITY_FIELDS) {
    const value = cleanValue(device[field.key]);
    if (!value) {
      continue;
    }
    // ponytail: scan sem indice em ip_address; se a tabela crescer, CREATE INDEX (nao-unico).
    const sql = `SELECT id FROM service_device_assignments WHERE ${field.column} = ? AND end_date IS NULL`
      + (excludeAssignmentId ? ' AND id != ?' : '');
    const duplicate = excludeAssignmentId
      ? db.prepare(sql).get(value, excludeAssignmentId)
      : db.prepare(sql).get(value);
    if (duplicate) {
      return { status: 409, error: `${field.label} ja esta atribuido a outro equipamento ativo` };
    }
  }

  return null;
}

/**
 * Validates that a device can be installed before opening a transaction: the model
 * exists, has stock, the technician (if any) is real, and no active assignment already
 * owns the serial/asset tag/IP. Returns a discriminated result so callers map it to a reply.
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

  const conflict = checkDeviceIdentity(db, device);
  if (conflict) {
    return { ok: false, ...conflict };
  }

  return { ok: true, catalog };
}

/**
 * Validates a batch of serialized equipment and consumable materials before the
 * transaction starts. It returns the first actionable error for API callers.
 */
export function preflightItems(db: Database.Database, items: ServiceItemInput[]): ItemsPreflight {
  if (items.length === 0) {
    return { ok: false, status: 400, error: 'Nenhum item indicado' };
  }

  // Identificadores ja usados por itens ANTERIORES do mesmo lote: ainda nao estao
  // na BD, por isso a verificacao por linha nao os apanharia.
  const batchIdentifiers = new Set<string>();

  for (const item of items) {
    const kind = loadCatalogKind(db, item.catalogId);
    if (!kind) {
      return { ok: false, status: 404, error: 'Modelo nao encontrado' };
    }

    if (kind.isSerialized) {
      const result = preflightDeviceInstall(db, item);
      if (!result.ok) {
        return result;
      }
      for (const field of IDENTITY_FIELDS) {
        const value = cleanValue(item[field.key]);
        if (!value) {
          continue;
        }
        const key = `${field.column}:${value}`;
        if (batchIdentifiers.has(key)) {
          return { ok: false, status: 409, error: `${field.label} repetido nos itens indicados` };
        }
        batchIdentifiers.add(key);
      }
      continue;
    }

    const quantity = Number(item.quantity ?? 0);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, status: 400, error: 'Quantidade de material invalida' };
    }
    if (kind.stockTotal < quantity) {
      return { ok: false, status: 400, error: `Stock insuficiente. Disponivel: ${kind.stockTotal}` };
    }
  }

  return { ok: true };
}

/**
 * Installs a device for a service. MUST be called inside a transaction so the
 * assignment, stock movement, catalog decrement and installation event commit or
 * roll back together. Re-checks stock for race safety and throws coded errors
 * (`stock_insufficient:<n>` / `catalog_missing`) consumed by {@link mapInstallError}.
 */
export function installDeviceWithinTx(
  db: Database.Database,
  params: { serviceId: number; clientName: string; device: DeviceInput; userId: number | null; skipEvent?: boolean }
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

  // Equipamento do cliente não gera renda; a renda do ISP é copiada do catálogo
  // agora e fica congelada nesta atribuição — mudar o preço do modelo no
  // catálogo não pode reescrever a fatura de quem já o tem instalado.
  const ownership = device.ownership === 'cliente' ? 'cliente' : 'isp';
  const rentalFeeCve = ownership === 'cliente' ? 0 : freshCatalog.rentalFeeCve;

  const assignment = db.prepare(`
    INSERT INTO service_device_assignments (
      service_id, catalog_id, serial_number, asset_tag, ip_address, mac_address,
      technician_id, notes, start_date, end_date, ownership, owned_since, rental_fee_cve,
      created_by, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now'), NULL, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    serviceId,
    device.catalogId,
    serialNumber,
    assetTag,
    ipAddress,
    macAddress,
    technicianId,
    notes,
    ownership,
    // Equipamento que o cliente já trouxe é dele desde o primeiro dia.
    ownership === 'cliente' ? new Date().toISOString().slice(0, 10) : null,
    rentalFeeCve,
    technicianId
  );

  // Equipamento do cliente nunca esteve no armazem: comprou-o ele, ou herdou-o da
  // operadora anterior. Dar-lhe baixa aqui inventava uma saida de stock e um custo
  // que a empresa nunca teve. So o material do ISP consome inventario.
  if (ownership === 'isp') {
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
  }

  let eventId: number | bigint = 0;
  if (!params.skipEvent) {
    const event = db.prepare(`
      INSERT INTO service_events (
        service_id, event_type, notes, technician_id, created_by, created_at
      )
      VALUES (?, 'instalacao', ?, ?, ?, datetime('now'))
    `).run(serviceId, notes, technicianId, technicianId);
    eventId = event.lastInsertRowid;
  }

  return { assignmentId: assignment.lastInsertRowid, eventId };
}

/**
 * Consumes a non-serialized material for a service inside a transaction.
 * Records the material line, stock movement and catalog decrement together.
 */
export function consumeMaterialWithinTx(
  db: Database.Database,
  params: { serviceId: number; clientName: string; catalogId: number; quantity: number; notes?: string | null; userId: number | null }
): { lineId: number | bigint } {
  const { serviceId, clientName, catalogId, quantity, userId } = params;
  const notes = cleanValue(params.notes);

  const fresh = loadCatalogKind(db, catalogId);
  if (!fresh) {
    throw new Error('catalog_missing');
  }
  if (fresh.stockTotal < quantity) {
    throw new Error(`stock_insufficient:${fresh.stockTotal}`);
  }

  const line = db.prepare(`
    INSERT INTO service_material_lines (service_id, catalog_id, quantity, unit_cost_cve, notes, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(serviceId, catalogId, quantity, fresh.landedCostCve, notes, userId);

  db.prepare(`
    INSERT INTO stock_movements (
      catalog_id, type, quantity, unit_cost_cve, reference, notes, service_id, client_name, created_by
    )
    VALUES (?, 'saida', ?, ?, ?, ?, ?, ?, ?)
  `).run(catalogId, quantity, fresh.landedCostCve, `Instalacao servico ${serviceId}`, notes, serviceId, clientName, userId);

  db.prepare(`
    UPDATE equipment_catalog
    SET stock_total = stock_total - ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(quantity, catalogId);

  return { lineId: line.lastInsertRowid };
}

/**
 * Applies a batch of serialized equipment and materials inside a transaction,
 * generating a single installation event for the whole batch.
 */
export function installItemsWithinTx(
  db: Database.Database,
  params: { serviceId: number; clientName: string; items: ServiceItemInput[]; userId: number | null }
): { assignmentIds: Array<number | bigint>; materialLineIds: Array<number | bigint>; eventId: number | bigint } {
  const { serviceId, clientName, items, userId } = params;
  const assignmentIds: Array<number | bigint> = [];
  const materialLineIds: Array<number | bigint> = [];

  for (const item of items) {
    const kind = loadCatalogKind(db, item.catalogId);
    if (!kind) {
      throw new Error('catalog_missing');
    }

    if (kind.isSerialized) {
      const { assignmentId } = installDeviceWithinTx(db, { serviceId, clientName, device: item, userId, skipEvent: true });
      assignmentIds.push(assignmentId);
    } else {
      const { lineId } = consumeMaterialWithinTx(db, {
        serviceId,
        clientName,
        catalogId: item.catalogId,
        quantity: Number(item.quantity ?? 1),
        notes: item.notes,
        userId
      });
      materialLineIds.push(lineId);
    }
  }

  const summary = `Instalou ${assignmentIds.length} equipamento(s) e ${materialLineIds.length} material(is)`;
  const technicianId = items.find((item) => item.technicianId)?.technicianId ?? null;
  const event = db.prepare(`
    INSERT INTO service_events (service_id, event_type, notes, technician_id, created_by, created_at)
    VALUES (?, 'instalacao', ?, ?, ?, datetime('now'))
  `).run(serviceId, summary, technicianId, technicianId);

  return { assignmentIds, materialLineIds, eventId: event.lastInsertRowid };
}

/**
 * Records the non-stock installation costs (labour, transport, …) for a service.
 * MUST run inside the same transaction as the service/items so everything commits or
 * rolls back together. Independent of items — a service may carry only labour.
 */
export function insertInstallCostsWithinTx(
  db: Database.Database,
  params: { serviceId: number; costs: InstallCostInput[]; userId: number | null }
): { installCostIds: Array<number | bigint> } {
  const installCostIds: Array<number | bigint> = [];
  for (const cost of params.costs) {
    const res = db.prepare(`
      INSERT INTO service_install_costs (service_id, kind, description, amount_cve, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(
      params.serviceId,
      cost.kind ?? 'mao_de_obra',
      cleanValue(cost.description),
      Number(cost.amountCve || 0),
      params.userId
    );
    installCostIds.push(res.lastInsertRowid);
  }
  return { installCostIds };
}

/** Maps an error thrown by {@link installDeviceWithinTx} to a reply, or null if unrelated. */
export function mapInstallError(error: unknown): { status: number; error: string } | null {
  if (error instanceof Error && error.message.startsWith('stock_insufficient:')) {
    return { status: 400, error: `Stock insuficiente. Disponivel: ${error.message.split(':')[1]}` };
  }
  return null;
}
