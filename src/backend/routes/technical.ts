import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import {
  checkDeviceIdentity,
  cleanValue,
  insertInstallCostsWithinTx,
  installDeviceWithinTx,
  installItemsWithinTx,
  loadCatalogIdentity,
  mapInstallError,
  preflightDeviceInstall,
  preflightItems,
  type InstallCostInput,
  type ServiceItemInput
} from '../lib/serviceInstall';
import { requireAuth, requireRole } from './auth';

const deviceAssignmentSchema = z.object({
  catalogId: z.coerce.number().int().positive(),
  serialNumber: z.string().trim().optional().nullable(),
  assetTag: z.string().trim().optional().nullable(),
  ipAddress: z.string().trim().optional().nullable(),
  macAddress: z.string().trim().optional().nullable(),
  technicianId: z.coerce.number().int().positive().optional().nullable(),
  notes: z.string().trim().optional().nullable()
});

const batchItemsSchema = z.object({
  items: z.array(z.object({
    catalogId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int().positive().optional().nullable(),
    serialNumber: z.string().trim().optional().nullable(),
    assetTag: z.string().trim().optional().nullable(),
    ipAddress: z.string().trim().optional().nullable(),
    macAddress: z.string().trim().optional().nullable(),
    technicianId: z.coerce.number().int().positive().optional().nullable(),
    notes: z.string().trim().optional().nullable()
  })).optional().nullable(),
  installCosts: z.array(z.object({
    kind: z.enum(['mao_de_obra', 'transporte', 'outro']).default('mao_de_obra'),
    description: z.string().trim().optional().nullable(),
    amountCve: z.coerce.number().min(0)
  })).optional().nullable()
}).refine(
  (data) => (data.items?.length ?? 0) > 0 || (data.installCosts?.length ?? 0) > 0,
  { message: 'Indique pelo menos um item ou custo' }
);

/**
 * Correcao da identificacao de um equipamento ja instalado. Sem `catalogId`: o
 * vinculo ao catalogo (e portanto ao stock) nao se move numa edicao.
 */
const deviceIdentitySchema = z.object({
  serialNumber: z.string().trim().optional().nullable(),
  assetTag: z.string().trim().optional().nullable(),
  ipAddress: z.string().trim().optional().nullable(),
  macAddress: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable()
});

const deviceReturnSchema = z.object({
  technicianId: z.coerce.number().int().positive().optional().nullable(),
  notes: z.string().trim().optional().nullable()
});

const technicalEventSchema = z.object({
  eventType: z.enum(['instalacao', 'manutencao', 'troca_equipamento', 'visita', 'alteracao_servico']),
  notes: z.string().trim().optional().nullable(),
  technicianId: z.coerce.number().int().positive().optional().nullable()
});

type ServiceIdentity = {
  id: number;
  clientId: number;
  clientName: string;
};

function loadService(id: number) {
  const db = getSqliteDatabase();
  return db.prepare(`
    SELECT s.id, s.client_id AS clientId, c.full_name AS clientName
    FROM services s
    JOIN clients c ON c.id = s.client_id
    WHERE s.id = ?
  `).get(id) as ServiceIdentity | undefined;
}

function loadUser(id: number) {
  const db = getSqliteDatabase();
  return db.prepare('SELECT id FROM users WHERE id = ?').get(id) as { id: number } | undefined;
}

export async function registerTechnicalRoutes(app: FastifyInstance) {
  const canWriteTechnical = { preHandler: requireRole(['admin', 'operator', 'technician']) };

  app.get('/api/services/:id/technical-history', { preHandler: requireAuth() }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Servico invalido' });
    }

    const db = getSqliteDatabase();
    const service = loadService(id);
    if (!service) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }

    const assignments = db.prepare(`
      SELECT
        a.id,
        a.service_id AS serviceId,
        a.catalog_id AS catalogId,
        ec.type AS catalogType,
        ec.brand,
        ec.model,
        a.serial_number AS serialNumber,
        a.asset_tag AS assetTag,
        a.ip_address AS ipAddress,
        a.mac_address AS macAddress,
        a.technician_id AS technicianId,
        tu.full_name AS technicianName,
        a.notes,
        a.start_date AS startDate,
        a.end_date AS endDate,
        a.created_by AS createdBy,
        cu.full_name AS createdByName,
        a.created_at AS createdAt,
        a.updated_at AS updatedAt
      FROM service_device_assignments a
      JOIN equipment_catalog ec ON ec.id = a.catalog_id
      LEFT JOIN users tu ON tu.id = a.technician_id
      LEFT JOIN users cu ON cu.id = a.created_by
      WHERE a.service_id = ?
      ORDER BY a.created_at DESC, a.id DESC
    `).all(id);

    const events = db.prepare(`
      SELECT
        e.id,
        e.service_id AS serviceId,
        e.event_type AS eventType,
        e.notes,
        e.technician_id AS technicianId,
        u.full_name AS technicianName,
        e.created_by AS createdBy,
        cu.full_name AS createdByName,
        e.created_at AS createdAt
      FROM service_events e
      LEFT JOIN users u ON u.id = e.technician_id
      LEFT JOIN users cu ON cu.id = e.created_by
      WHERE e.service_id = ?
      ORDER BY e.created_at DESC, e.id DESC
    `).all(id);

    const materials = db.prepare(`
      SELECT
        ml.id,
        ml.catalog_id AS catalogId,
        ec.type AS catalogType,
        ec.brand,
        ec.model,
        ec.unit_of_measure AS unitOfMeasure,
        ml.quantity,
        ml.unit_cost_cve AS unitCostCve,
        ml.notes,
        ml.created_at AS createdAt,
        cu.full_name AS createdByName
      FROM service_material_lines ml
      JOIN equipment_catalog ec ON ec.id = ml.catalog_id
      LEFT JOIN users cu ON cu.id = ml.created_by
      WHERE ml.service_id = ?
      ORDER BY ml.created_at DESC, ml.id DESC
    `).all(id);

    const installCosts = db.prepare(`
      SELECT
        ic.id,
        ic.kind,
        ic.description,
        ic.amount_cve AS amountCve,
        ic.created_by AS createdBy,
        cu.full_name AS createdByName,
        ic.created_at AS createdAt
      FROM service_install_costs ic
      LEFT JOIN users cu ON cu.id = ic.created_by
      WHERE ic.service_id = ?
      ORDER BY ic.created_at DESC, ic.id DESC
    `).all(id);

    return { serviceId: service.id, assignments, materials, installCosts, events };
  });

  app.post('/api/services/:id/items', canWriteTechnical, async (request, reply) => {
    const serviceId = Number((request.params as { id: string }).id);
    const parsed = batchItemsSchema.safeParse(request.body);
    if (!Number.isInteger(serviceId) || serviceId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de instalacao invalidos' });
    }

    const db = getSqliteDatabase();
    const service = loadService(serviceId);
    if (!service) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }

    const items = (parsed.data.items ?? []) as ServiceItemInput[];
    const installCosts = (parsed.data.installCosts ?? []) as InstallCostInput[];
    if (items.length > 0) {
      const preflight = preflightItems(db, items);
      if (!preflight.ok) {
        return reply.status(preflight.status).send({ error: preflight.error });
      }
    }

    const run = db.transaction(() => {
      const install = items.length > 0
        ? installItemsWithinTx(db, {
            serviceId,
            clientName: service.clientName,
            items,
            userId: request.user?.id ?? null
          })
        : { assignmentIds: [], materialLineIds: [], eventId: 0 as number | bigint };
      const costs = installCosts.length > 0
        ? insertInstallCostsWithinTx(db, { serviceId, costs: installCosts, userId: request.user?.id ?? null })
        : { installCostIds: [] as Array<number | bigint> };
      return { ...install, ...costs };
    });

    let result: ReturnType<typeof run>;
    try {
      result = run();
    } catch (error) {
      const mapped = mapInstallError(error);
      if (mapped) {
        return reply.status(mapped.status).send({ error: mapped.error });
      }
      throw error;
    }
    recordAudit(request, {
      action: 'assign_device',
      entityType: 'service',
      entityId: serviceId,
      summary: `Instalou ${items.length} item(s) e ${installCosts.length} custo(s) no servico ${serviceId}`,
      metadata: { items: items.length, installCosts: installCosts.length, eventId: result.eventId }
    });
    return reply.status(201).send(result);
  });

  /**
   * Corrige a identificacao (IP, MAC, serial, asset tag, notas) de um equipamento ja
   * instalado. Um unico UPDATE: nao mexe em stock, nao fecha nem cria atribuicoes e
   * nao escreve evento tecnico — ao contrario de /replace, que existe para a troca
   * fisica do equipamento. O IP fixo e a chave de manutencao remota das antenas, por
   * isso tem de ser corrigivel sem custar uma unidade de inventario.
   */
  app.patch('/api/service-device-assignments/:id', canWriteTechnical, async (request, reply) => {
    const assignmentId = Number((request.params as { id: string }).id);
    const parsed = deviceIdentitySchema.safeParse(request.body ?? {});
    if (!Number.isInteger(assignmentId) || assignmentId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de atribuicao invalidos' });
    }

    const db = getSqliteDatabase();
    const current = db.prepare(`
      SELECT
        id,
        service_id AS serviceId,
        end_date AS endDate,
        serial_number AS serialNumber,
        asset_tag AS assetTag,
        ip_address AS ipAddress,
        mac_address AS macAddress,
        notes
      FROM service_device_assignments
      WHERE id = ?
    `).get(assignmentId) as {
      id: number; serviceId: number; endDate: string | null;
      serialNumber: string | null; assetTag: string | null;
      ipAddress: string | null; macAddress: string | null; notes: string | null;
    } | undefined;

    if (!current) {
      return reply.status(404).send({ error: 'Atribuicao nao encontrada' });
    }
    if (current.endDate) {
      return reply.status(400).send({ error: 'Atribuicao ja encerrada' });
    }

    // Patch parcial: campo ausente mantem o valor atual, campo a null/'' limpa.
    const merge = (next: string | null | undefined, previous: string | null) =>
      next === undefined ? previous : cleanValue(next);
    const next = {
      serialNumber: merge(parsed.data.serialNumber, current.serialNumber),
      assetTag: merge(parsed.data.assetTag, current.assetTag),
      ipAddress: merge(parsed.data.ipAddress, current.ipAddress),
      macAddress: merge(parsed.data.macAddress, current.macAddress),
      notes: merge(parsed.data.notes, current.notes)
    };

    // So o que muda e validado: dados legados duplicados (nao ha indice unico) nao
    // podem bloquear a correcao de um campo que o tecnico nem tocou.
    const changed = (value: string | null, previous: string | null) => value === previous ? null : value;
    const conflict = checkDeviceIdentity(db, {
      serialNumber: changed(next.serialNumber, current.serialNumber),
      assetTag: changed(next.assetTag, current.assetTag),
      ipAddress: changed(next.ipAddress, current.ipAddress)
    }, assignmentId);
    if (conflict) {
      return reply.status(conflict.status).send({ error: conflict.error });
    }

    db.prepare(`
      UPDATE service_device_assignments
      SET serial_number = ?,
          asset_tag = ?,
          ip_address = ?,
          mac_address = ?,
          notes = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(next.serialNumber, next.assetTag, next.ipAddress, next.macAddress, next.notes, assignmentId);

    recordAudit(request, {
      action: 'update_device',
      entityType: 'service_device_assignment',
      entityId: assignmentId,
      summary: `Atualizou identificacao do equipamento ${assignmentId}`,
      metadata: {
        serviceId: current.serviceId,
        ipAddress: next.ipAddress,
        previousIpAddress: current.ipAddress
      }
    });
    return reply.status(200).send({ assignmentId, ...next });
  });

  app.post('/api/service-device-assignments/:id/replace', canWriteTechnical, async (request, reply) => {
    const assignmentId = Number((request.params as { id: string }).id);
    const parsed = deviceAssignmentSchema.safeParse(request.body);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de atribuicao invalidos' });
    }

    const db = getSqliteDatabase();
    const current = db.prepare(`
      SELECT id, service_id AS serviceId, catalog_id AS catalogId, end_date AS endDate
      FROM service_device_assignments
      WHERE id = ?
    `).get(assignmentId) as { id: number; serviceId: number; catalogId: number; endDate: string | null } | undefined;

    if (!current) {
      return reply.status(404).send({ error: 'Atribuicao nao encontrada' });
    }
    if (current.endDate) {
      return reply.status(400).send({ error: 'Atribuicao ja encerrada' });
    }
    if (!loadService(current.serviceId)) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }
    const catalog = loadCatalogIdentity(db, parsed.data.catalogId);
    if (!catalog) {
      return reply.status(404).send({ error: 'Modelo nao encontrado' });
    }
    if (catalog.stockTotal < 1) {
      return reply.status(400).send({ error: `Stock insuficiente. Disponivel: ${catalog.stockTotal}` });
    }
    if (parsed.data.technicianId && !loadUser(parsed.data.technicianId)) {
      return reply.status(404).send({ error: 'Tecnico nao encontrado' });
    }

    const serialNumber = cleanValue(parsed.data.serialNumber);
    const assetTag = cleanValue(parsed.data.assetTag);
    const ipAddress = cleanValue(parsed.data.ipAddress);
    const macAddress = cleanValue(parsed.data.macAddress);
    const notes = cleanValue(parsed.data.notes);

    const conflict = checkDeviceIdentity(db, { serialNumber, assetTag, ipAddress }, assignmentId);
    if (conflict) {
      return reply.status(conflict.status).send({ error: conflict.error });
    }

    const run = db.transaction(() => {
      const service = loadService(current.serviceId);
      if (!service) {
        throw new Error('service_missing');
      }
      const freshCatalog = loadCatalogIdentity(db, parsed.data.catalogId);
      if (!freshCatalog) {
        throw new Error('catalog_missing');
      }
      if (freshCatalog.stockTotal < 1) {
        throw new Error(`stock_insufficient:${freshCatalog.stockTotal}`);
      }

      db.prepare(`
        UPDATE service_device_assignments
        SET end_date = date('now'),
            updated_at = datetime('now')
        WHERE id = ? AND end_date IS NULL
      `).run(assignmentId);

      const replacement = db.prepare(`
        INSERT INTO service_device_assignments (
          service_id, catalog_id, serial_number, asset_tag, ip_address, mac_address,
          technician_id, notes, start_date, end_date, created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now'), NULL, ?, datetime('now'), datetime('now'))
      `).run(
        current.serviceId,
        parsed.data.catalogId,
        serialNumber,
        assetTag,
        ipAddress,
        macAddress,
        parsed.data.technicianId || null,
        notes,
        parsed.data.technicianId || null
      );

      db.prepare(`
        INSERT INTO stock_movements (
          catalog_id, type, quantity, unit_cost_cve, reference, notes, service_id, client_name, created_by
        )
        VALUES (?, 'saida', 1, ?, ?, ?, ?, ?, ?)
      `).run(
        parsed.data.catalogId,
        freshCatalog.landedCostCve,
        `Troca servico ${current.serviceId}`,
        notes,
        current.serviceId,
        service.clientName,
        request.user?.id || null
      );

      db.prepare(`
        UPDATE equipment_catalog
        SET stock_total = stock_total - 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(parsed.data.catalogId);

      const event = db.prepare(`
        INSERT INTO service_events (
          service_id, event_type, notes, technician_id, created_by, created_at
        )
        VALUES (?, 'troca_equipamento', ?, ?, ?, datetime('now'))
      `).run(
        current.serviceId,
        notes,
        parsed.data.technicianId || null,
        parsed.data.technicianId || null
      );

      return { assignmentId: replacement.lastInsertRowid, eventId: event.lastInsertRowid };
    });

    let result: { assignmentId: string | number | bigint; eventId: string | number | bigint };
    try {
      result = run();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('stock_insufficient:')) {
        return reply.status(400).send({ error: `Stock insuficiente. Disponivel: ${error.message.split(':')[1]}` });
      }
      if (error instanceof Error && error.message === 'service_missing') {
        return reply.status(404).send({ error: 'Servico nao encontrado' });
      }
      throw error;
    }
    recordAudit(request, {
      action: 'replace_device',
      entityType: 'service_device_assignment',
      entityId: assignmentId,
      summary: `Substituiu equipamento atribuido ${assignmentId}`,
      metadata: { catalogId: parsed.data.catalogId, replacementAssignmentId: result.assignmentId }
    });
    return reply.status(201).send(result);
  });

  app.post('/api/service-device-assignments/:id/return', canWriteTechnical, async (request, reply) => {
    const assignmentId = Number((request.params as { id: string }).id);
    const parsed = deviceReturnSchema.safeParse(request.body ?? {});
    if (!Number.isInteger(assignmentId) || assignmentId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de devolucao invalidos' });
    }

    const db = getSqliteDatabase();
    const current = db.prepare(`
      SELECT id, service_id AS serviceId, catalog_id AS catalogId, end_date AS endDate
      FROM service_device_assignments
      WHERE id = ?
    `).get(assignmentId) as { id: number; serviceId: number; catalogId: number; endDate: string | null } | undefined;

    if (!current) {
      return reply.status(404).send({ error: 'Atribuicao nao encontrada' });
    }
    if (current.endDate) {
      return reply.status(400).send({ error: 'Atribuicao ja encerrada' });
    }
    const service = loadService(current.serviceId);
    if (!service) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }
    if (parsed.data.technicianId && !loadUser(parsed.data.technicianId)) {
      return reply.status(404).send({ error: 'Tecnico nao encontrado' });
    }

    const notes = cleanValue(parsed.data.notes);
    const catalog = loadCatalogIdentity(db, current.catalogId);

    const run = db.transaction(() => {
      const updated = db.prepare(`
        UPDATE service_device_assignments
        SET end_date = date('now'),
            updated_at = datetime('now')
        WHERE id = ? AND end_date IS NULL
      `).run(assignmentId);
      if (updated.changes === 0) {
        throw new Error('already_closed');
      }

      db.prepare(`
        INSERT INTO stock_movements (
          catalog_id, type, quantity, unit_cost_cve, reference, notes, service_id, client_name, created_by
        )
        VALUES (?, 'devolucao', 1, ?, ?, ?, ?, ?, ?)
      `).run(
        current.catalogId,
        catalog?.landedCostCve ?? 0,
        `Devolucao servico ${current.serviceId}`,
        notes,
        current.serviceId,
        service.clientName,
        request.user?.id || null
      );

      db.prepare(`
        UPDATE equipment_catalog
        SET stock_total = stock_total + 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(current.catalogId);

      const event = db.prepare(`
        INSERT INTO service_events (
          service_id, event_type, notes, technician_id, created_by, created_at
        )
        VALUES (?, 'alteracao_servico', ?, ?, ?, datetime('now'))
      `).run(
        current.serviceId,
        notes,
        parsed.data.technicianId || null,
        parsed.data.technicianId || null
      );

      return { eventId: event.lastInsertRowid };
    });

    let result: { eventId: string | number | bigint };
    try {
      result = run();
    } catch (error) {
      if (error instanceof Error && error.message === 'already_closed') {
        return reply.status(400).send({ error: 'Atribuicao ja encerrada' });
      }
      throw error;
    }
    recordAudit(request, {
      action: 'return_device',
      entityType: 'service_device_assignment',
      entityId: assignmentId,
      summary: `Removeu equipamento atribuido ${assignmentId}`,
      metadata: { catalogId: current.catalogId, serviceId: current.serviceId }
    });
    return reply.status(200).send({ assignmentId, eventId: result.eventId });
  });

  app.post('/api/services/:id/technical-events', canWriteTechnical, async (request, reply) => {
    const serviceId = Number((request.params as { id: string }).id);
    const parsed = technicalEventSchema.safeParse(request.body);
    if (!Number.isInteger(serviceId) || serviceId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de evento invalidos' });
    }

    const db = getSqliteDatabase();
    if (!loadService(serviceId)) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }
    if (parsed.data.technicianId && !loadUser(parsed.data.technicianId)) {
      return reply.status(404).send({ error: 'Tecnico nao encontrado' });
    }

    const event = db.prepare(`
      INSERT INTO service_events (
        service_id, event_type, notes, technician_id, created_by, created_at
      )
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(
      serviceId,
      parsed.data.eventType,
      cleanValue(parsed.data.notes),
      parsed.data.technicianId || null,
      parsed.data.technicianId || null
    );

    recordAudit(request, {
      action: 'create_event',
      entityType: 'service',
      entityId: serviceId,
      summary: `Registou evento tecnico ${parsed.data.eventType}`,
      metadata: { eventId: event.lastInsertRowid, eventType: parsed.data.eventType }
    });
    return reply.status(201).send({ id: event.lastInsertRowid });
  });
}
