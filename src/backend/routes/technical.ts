import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
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

const technicalEventSchema = z.object({
  eventType: z.enum(['instalacao', 'manutencao', 'troca_equipamento', 'visita', 'alteracao_servico']),
  notes: z.string().trim().optional().nullable(),
  technicianId: z.coerce.number().int().positive().optional().nullable()
});

function cleanValue(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function loadService(id: number) {
  const db = getSqliteDatabase();
  return db.prepare('SELECT id FROM services WHERE id = ?').get(id) as { id: number } | undefined;
}

function loadCatalog(id: number) {
  const db = getSqliteDatabase();
  return db.prepare('SELECT id FROM equipment_catalog WHERE id = ?').get(id) as { id: number } | undefined;
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

    return { serviceId: service.id, assignments, events };
  });

  app.post('/api/services/:id/device-assignments', canWriteTechnical, async (request, reply) => {
    const serviceId = Number((request.params as { id: string }).id);
    const parsed = deviceAssignmentSchema.safeParse(request.body);
    if (!Number.isInteger(serviceId) || serviceId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de atribuicao invalidos' });
    }

    const db = getSqliteDatabase();
    if (!loadService(serviceId)) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }
    if (!loadCatalog(parsed.data.catalogId)) {
      return reply.status(404).send({ error: 'Modelo nao encontrado' });
    }
    if (parsed.data.technicianId && !loadUser(parsed.data.technicianId)) {
      return reply.status(404).send({ error: 'Tecnico nao encontrado' });
    }

    const serialNumber = cleanValue(parsed.data.serialNumber);
    const assetTag = cleanValue(parsed.data.assetTag);
    const ipAddress = cleanValue(parsed.data.ipAddress);
    const macAddress = cleanValue(parsed.data.macAddress);
    const notes = cleanValue(parsed.data.notes);

    if (serialNumber) {
      const duplicate = db.prepare(`
        SELECT id
        FROM service_device_assignments
        WHERE serial_number = ? AND end_date IS NULL
      `).get(serialNumber);
      if (duplicate) {
        return reply.status(409).send({ error: 'Serial ja esta atribuido a outro equipamento ativo' });
      }
    }
    if (assetTag) {
      const duplicate = db.prepare(`
        SELECT id
        FROM service_device_assignments
        WHERE asset_tag = ? AND end_date IS NULL
      `).get(assetTag);
      if (duplicate) {
        return reply.status(409).send({ error: 'Asset tag ja esta atribuido a outro equipamento ativo' });
      }
    }

    const run = db.transaction(() => {
      const assignment = db.prepare(`
        INSERT INTO service_device_assignments (
          service_id, catalog_id, serial_number, asset_tag, ip_address, mac_address,
          technician_id, notes, start_date, end_date, created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now'), NULL, ?, datetime('now'), datetime('now'))
      `).run(
        serviceId,
        parsed.data.catalogId,
        serialNumber,
        assetTag,
        ipAddress,
        macAddress,
        parsed.data.technicianId || null,
        notes,
        parsed.data.technicianId || null
      );

      const event = db.prepare(`
        INSERT INTO service_events (
          service_id, event_type, notes, technician_id, created_by, created_at
        )
        VALUES (?, 'instalacao', ?, ?, ?, datetime('now'))
      `).run(
        serviceId,
        notes,
        parsed.data.technicianId || null,
        parsed.data.technicianId || null
      );

      return { assignmentId: assignment.lastInsertRowid, eventId: event.lastInsertRowid };
    });

    const result = run();
    recordAudit(request, {
      action: 'assign_device',
      entityType: 'service',
      entityId: serviceId,
      summary: `Atribuiu equipamento ao servico ${serviceId}`,
      metadata: { catalogId: parsed.data.catalogId, assignmentId: result.assignmentId }
    });
    return reply.status(201).send(result);
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
    if (!loadCatalog(parsed.data.catalogId)) {
      return reply.status(404).send({ error: 'Modelo nao encontrado' });
    }
    if (parsed.data.technicianId && !loadUser(parsed.data.technicianId)) {
      return reply.status(404).send({ error: 'Tecnico nao encontrado' });
    }

    const serialNumber = cleanValue(parsed.data.serialNumber);
    const assetTag = cleanValue(parsed.data.assetTag);
    const ipAddress = cleanValue(parsed.data.ipAddress);
    const macAddress = cleanValue(parsed.data.macAddress);
    const notes = cleanValue(parsed.data.notes);

    if (serialNumber) {
      const duplicate = db.prepare(`
        SELECT id
        FROM service_device_assignments
        WHERE serial_number = ? AND end_date IS NULL AND id != ?
      `).get(serialNumber, assignmentId);
      if (duplicate) {
        return reply.status(409).send({ error: 'Serial ja esta atribuido a outro equipamento ativo' });
      }
    }
    if (assetTag) {
      const duplicate = db.prepare(`
        SELECT id
        FROM service_device_assignments
        WHERE asset_tag = ? AND end_date IS NULL AND id != ?
      `).get(assetTag, assignmentId);
      if (duplicate) {
        return reply.status(409).send({ error: 'Asset tag ja esta atribuido a outro equipamento ativo' });
      }
    }

    const run = db.transaction(() => {
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

    const result = run();
    recordAudit(request, {
      action: 'replace_device',
      entityType: 'service_device_assignment',
      entityId: assignmentId,
      summary: `Substituiu equipamento atribuido ${assignmentId}`,
      metadata: { catalogId: parsed.data.catalogId, replacementAssignmentId: result.assignmentId }
    });
    return reply.status(201).send(result);
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
