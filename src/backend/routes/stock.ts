import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import { requireAuth, requireRole } from './auth';

const catalogSchema = z.object({
  category: z.enum(['equipamento', 'material']).default('equipamento'),
  type: z.enum(['cpe', 'router', 'antena', 'switch', 'cabo', 'conector', 'ficha', 'suporte', 'outro']),
  brand: z.string().trim().optional().nullable(),
  model: z.string().trim().min(1),
  description: z.string().trim().optional().nullable(),
  supplier: z.string().trim().optional().nullable(),
  unitOfMeasure: z.string().trim().min(1).default('un'),
  isSerialized: z.coerce.boolean().default(true),
  purchasePriceCve: z.coerce.number().min(0).default(0),
  shippingCostCve: z.coerce.number().min(0).default(0),
  customsDutyCve: z.coerce.number().min(0).default(0),
  otherCostsCve: z.coerce.number().min(0).default(0),
  sellingPriceCve: z.coerce.number().min(0).default(0),
  rentalFeeCve: z.coerce.number().min(0).default(0),
  stockTotal: z.coerce.number().int().min(0).default(0),
  active: z.coerce.boolean().default(true),
  backboneQty: z.coerce.number().int().min(0).default(0)
});

const movementSchema = z.object({
  catalogId: z.coerce.number().int().positive(),
  type: z.enum(['entrada', 'saida', 'ajuste']),
  quantity: z.coerce.number().int(),
  unitCostCve: z.coerce.number().min(0).default(0),
  supplier: z.string().trim().optional().nullable(),
  reference: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable()
});

function movementDelta(type: 'entrada' | 'saida' | 'ajuste', quantity: number) {
  if (type === 'saida') {
    return -Math.abs(quantity);
  }
  return quantity;
}

export async function registerStockRoutes(app: FastifyInstance) {
  const canWriteStock = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/stock/summary', { preHandler: requireAuth() }, async () => {
    const db = getSqliteDatabase();
    const rows = db.prepare(`
      SELECT
        id,
        category,
        type,
        brand,
        model,
        description,
        supplier,
        unit_of_measure AS unitOfMeasure,
        is_serialized AS isSerialized,
        purchase_price_cve AS purchasePriceCve,
        shipping_cost_cve AS shippingCostCve,
        customs_duty_cve AS customsDutyCve,
        other_costs_cve AS otherCostsCve,
        selling_price_cve AS sellingPriceCve,
        rental_fee_cve AS rentalFeeCve,
        stock_total AS stockTotal,
        active,
        backbone_qty AS backboneQty,
        (purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve) AS landedCostCve,
        (SELECT MAX(created_at) FROM stock_movements sm WHERE sm.catalog_id = equipment_catalog.id) AS lastMovementAt
      FROM equipment_catalog
      WHERE active = 1
      ORDER BY brand, model
    `).all() as Array<{ stockTotal: number; landedCostCve: number }>;

    const totals = rows.reduce((acc, row) => {
      const stock = Number(row.stockTotal) || 0;
      const cost = Number(row.landedCostCve) || 0;
      acc.models += 1;
      acc.available += stock;
      acc.inventoryValueCve += stock * cost;
      if (stock <= 0) {
        acc.outOfStock += 1;
      } else if (stock <= 3) {
        acc.lowStock += 1;
      }
      return acc;
    }, { models: 0, available: 0, lowStock: 0, outOfStock: 0, inventoryValueCve: 0 });

    return { totals, rows };
  });

  app.post('/api/equipment-catalog', canWriteStock, async (request, reply) => {
    const parsed = catalogSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de equipamento invalidos' });
    }

    const db = getSqliteDatabase();
    const result = db.prepare(`
      INSERT INTO equipment_catalog (
        category, type, brand, model, description, supplier, unit_of_measure, is_serialized,
        purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve,
        selling_price_cve, rental_fee_cve, stock_total, active, backbone_qty, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      parsed.data.category,
      parsed.data.type,
      parsed.data.brand || null,
      parsed.data.model,
      parsed.data.description || null,
      parsed.data.supplier || null,
      parsed.data.unitOfMeasure,
      parsed.data.isSerialized ? 1 : 0,
      parsed.data.purchasePriceCve,
      parsed.data.shippingCostCve,
      parsed.data.customsDutyCve,
      parsed.data.otherCostsCve,
      parsed.data.sellingPriceCve,
      parsed.data.rentalFeeCve,
      parsed.data.stockTotal,
      parsed.data.active ? 1 : 0,
      parsed.data.backboneQty
    );

    recordAudit(request, {
      action: 'create',
      entityType: 'equipment_catalog',
      entityId: Number(result.lastInsertRowid),
      summary: `Criou equipamento ${parsed.data.model}`,
      metadata: { type: parsed.data.type, stockTotal: parsed.data.stockTotal }
    });
    return reply.status(201).send({ id: result.lastInsertRowid });
  });

  app.put('/api/equipment-catalog/:id', canWriteStock, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = catalogSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de equipamento invalidos' });
    }

    const db = getSqliteDatabase();
    const result = db.prepare(`
      UPDATE equipment_catalog
      SET category = ?,
          type = ?,
          brand = ?,
          model = ?,
          description = ?,
          supplier = ?,
          unit_of_measure = ?,
          is_serialized = ?,
          purchase_price_cve = ?,
          shipping_cost_cve = ?,
          customs_duty_cve = ?,
          other_costs_cve = ?,
          selling_price_cve = ?,
          rental_fee_cve = ?,
          stock_total = ?,
          active = ?,
          backbone_qty = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      parsed.data.category,
      parsed.data.type,
      parsed.data.brand || null,
      parsed.data.model,
      parsed.data.description || null,
      parsed.data.supplier || null,
      parsed.data.unitOfMeasure,
      parsed.data.isSerialized ? 1 : 0,
      parsed.data.purchasePriceCve,
      parsed.data.shippingCostCve,
      parsed.data.customsDutyCve,
      parsed.data.otherCostsCve,
      parsed.data.sellingPriceCve,
      parsed.data.rentalFeeCve,
      parsed.data.stockTotal,
      parsed.data.active ? 1 : 0,
      parsed.data.backboneQty,
      id
    );

    if (result.changes === 0) {
      return reply.status(404).send({ error: 'Modelo nao encontrado' });
    }

    recordAudit(request, {
      action: 'update',
      entityType: 'equipment_catalog',
      entityId: id,
      summary: `Atualizou equipamento ${parsed.data.model}`,
      metadata: { type: parsed.data.type, stockTotal: parsed.data.stockTotal, active: parsed.data.active }
    });
    return { ok: true };
  });

  app.get('/api/equipment-catalog/:id/assignments', { preHandler: requireAuth() }, async (request, reply) => {
    const catalogId = Number((request.params as { id: string }).id);
    if (!Number.isInteger(catalogId) || catalogId <= 0) {
      return reply.status(400).send({ error: 'Catalogo invalido' });
    }

    const db = getSqliteDatabase();
    const catalog = db.prepare('SELECT id FROM equipment_catalog WHERE id = ?').get(catalogId);
    if (!catalog) {
      return reply.status(404).send({ error: 'Modelo nao encontrado' });
    }

    const items = db.prepare(`
      SELECT
        a.id,
        a.service_id AS serviceId,
        s.client_id AS clientId,
        c.client_code AS clientCode,
        c.full_name AS clientName,
        c.phone AS clientPhone,
        a.serial_number AS serialNumber,
        a.asset_tag AS assetTag,
        a.mac_address AS macAddress,
        a.ip_address AS ipAddress,
        a.start_date AS startDate,
        a.end_date AS endDate,
        a.notes
      FROM service_device_assignments a
      JOIN services s ON s.id = a.service_id
      JOIN clients c ON c.id = s.client_id
      WHERE a.catalog_id = ?
      ORDER BY CASE WHEN a.end_date IS NULL THEN 0 ELSE 1 END, a.start_date DESC, a.id DESC
    `).all(catalogId) as Array<{ endDate: string | null }>;

    const activeCount = items.reduce((acc, row) => acc + (row.endDate ? 0 : 1), 0);
    return { catalogId, activeCount, totalCount: items.length, items };
  });

  app.get('/api/stock', { preHandler: requireAuth() }, async (request, reply) => {
    const catalogId = Number((request.query as { catalogId?: string }).catalogId);
    if (!Number.isInteger(catalogId) || catalogId <= 0) {
      return reply.status(400).send({ error: 'catalogId e obrigatorio' });
    }

    const db = getSqliteDatabase();
    const catalog = db.prepare(`
      SELECT
        id,
        type,
        brand,
        model,
        stock_total AS stockTotal,
        (purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve) AS landedCostCve
      FROM equipment_catalog
      WHERE id = ?
    `).get(catalogId);

    if (!catalog) {
      return reply.status(404).send({ error: 'Modelo nao encontrado' });
    }

    const movements = db.prepare(`
      SELECT
        id,
        catalog_id AS catalogId,
        type,
        quantity,
        unit_cost_cve AS unitCostCve,
        supplier,
        reference,
        notes,
        client_name AS clientName,
        created_at AS createdAt
      FROM stock_movements
      WHERE catalog_id = ?
      ORDER BY created_at DESC
    `).all(catalogId);

    return { catalog, movements };
  });

  app.post('/api/stock', canWriteStock, async (request, reply) => {
    const parsed = movementSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.quantity === 0) {
      return reply.status(400).send({ error: 'Movimento de stock invalido' });
    }

    const db = getSqliteDatabase();
    const catalog = db.prepare('SELECT id, stock_total AS stockTotal FROM equipment_catalog WHERE id = ?')
      .get(parsed.data.catalogId) as { id: number; stockTotal: number } | undefined;

    if (!catalog) {
      return reply.status(404).send({ error: 'Modelo nao encontrado' });
    }

    const delta = movementDelta(parsed.data.type, parsed.data.quantity);
    if (catalog.stockTotal + delta < 0) {
      return reply.status(400).send({ error: `Stock insuficiente. Disponivel: ${catalog.stockTotal}` });
    }

    const save = db.transaction(() => {
      db.prepare(`
        INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve, supplier, reference, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        parsed.data.catalogId,
        parsed.data.type,
        parsed.data.quantity,
        parsed.data.unitCostCve,
        parsed.data.supplier || null,
        parsed.data.reference || null,
        parsed.data.notes || null
      );

      db.prepare('UPDATE equipment_catalog SET stock_total = stock_total + ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(delta, parsed.data.catalogId);
    });

    save();
    recordAudit(request, {
      action: 'create',
      entityType: 'stock_movement',
      entityId: parsed.data.catalogId,
      summary: `Registou movimento de stock ${parsed.data.type}`,
      metadata: { catalogId: parsed.data.catalogId, type: parsed.data.type, quantity: parsed.data.quantity }
    });
    return reply.status(201).send({ ok: true });
  });
}
