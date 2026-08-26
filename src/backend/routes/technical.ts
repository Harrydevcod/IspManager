import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit, recordAuditStrict } from '../lib/audit';
import {
  SHARED_WITH_NAMES_SQL,
  SHARED_WITH_SQL,
  promoteAssignmentOwner,
  promoteOwnerSchema
} from '../lib/deviceShares';
import {
  IP_FORMAT_ERROR,
  checkDeviceIdentity,
  cleanValue,
  insertInstallCostsWithinTx,
  isIpv4,
  installDeviceWithinTx,
  installItemsWithinTx,
  loadCatalogIdentity,
  mapInstallError,
  preflightDeviceInstall,
  preflightItems,
  type InstallCostInput,
  type ServiceItemInput
} from '../lib/serviceInstall';
import {
  mapReturnError,
  processServiceReturn,
  returnAssignmentWithinTx,
  type ReturnCondition
} from '../lib/serviceReturn';
import { insertEquipmentPurchase } from '../lib/billing';
import { requireAuth, requireRole } from './auth';

const deviceAssignmentSchema = z.object({
  catalogId: z.coerce.number().int().positive(),
  serialNumber: z.string().trim().optional().nullable(),
  assetTag: z.string().trim().optional().nullable(),
  ipAddress: z.string().trim().optional().nullable(),
  macAddress: z.string().trim().optional().nullable(),
  technicianId: z.coerce.number().int().positive().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  /** 'cliente' = equipamento que o cliente trouxe; não gera renda. */
  ownership: z.enum(['isp', 'cliente']).optional().nullable()
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
    notes: z.string().trim().optional().nullable(),
    ownership: z.enum(['isp', 'cliente']).optional().nullable()
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
  notes: z.string().trim().optional().nullable(),
  /**
   * A renda vale a partir da proxima fatura e nao reescreve as passadas — cada
   * mensalidade ja emitida guarda as suas proprias linhas. E editavel porque
   * nasce copiada do catalogo na instalacao e fica congelada: sem isto, mudar o
   * preco no catalogo deixava o parque instalado a derivar sem conserto.
   */
  rentalFeeCve: z.coerce.number().min(0).max(1_000_000).optional().nullable()
});

const purchaseSchema = z.object({
  // Editável: equipamento com dois anos de uso não se vende ao preço de novo, e
  // zero é legítimo (oferecido ao fim de contrato, ou já pago por fora).
  amountCve: z.coerce.number().min(0).max(10_000_000),
  notes: z.string().trim().max(500).optional().nullable()
});

const shareSchema = z.object({
  serviceId: z.coerce.number().int().positive()
});

/** Atribuição de IPs em massa: só o par (id, IP), para o ecrã de preenchimento. */
const bulkIpSchema = z.object({
  items: z.array(z.object({
    id: z.coerce.number().int().positive(),
    ipAddress: z.string().trim().optional().nullable()
  })).min(1).max(1000)
});

const returnConditionSchema = z.enum(['bom', 'avariado', 'nao_devolvido']);

const deviceReturnSchema = z.object({
  /** Como a unidade voltou. Só 'bom' repõe stock; o resto é perda registada. */
  condition: returnConditionSchema.optional().nullable(),
  technicianId: z.coerce.number().int().positive().optional().nullable(),
  notes: z.string().trim().optional().nullable()
});

const serviceReturnSchema = z.object({
  devices: z.array(z.object({
    assignmentId: z.coerce.number().int().positive(),
    condition: returnConditionSchema.default('bom'),
    notes: z.string().trim().optional().nullable()
  })).optional().nullable(),
  materials: z.array(z.object({
    catalogId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int().positive(),
    notes: z.string().trim().optional().nullable()
  })).optional().nullable(),
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
  // Vender equipamento e emitir a cobrança é ato comercial, não trabalho de campo.
  const canManageBilling = { preHandler: requireRole(['admin', 'operator']) };

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
        a.ownership,
        a.owned_since AS ownedSince,
        a.rental_fee_cve AS rentalFeeCve,
        a.return_condition AS returnCondition,
        ec.selling_price_cve AS sellingPriceCve,
        a.created_by AS createdBy,
        cu.full_name AS createdByName,
        a.created_at AS createdAt,
        a.updated_at AS updatedAt,
        -- Partilha: is_owner distingue a antena instalada NESTE servico da que
        -- vem partilhada de outro. Só o titular manipula a unidade física.
        asv.is_owner AS isOwner,
        ${SHARED_WITH_NAMES_SQL} AS sharedWithNames,
        ${SHARED_WITH_SQL} AS sharedWithJson,
        (SELECT c2.full_name FROM services s2 JOIN clients c2 ON c2.id = s2.client_id
          WHERE s2.id = a.service_id) AS ownerClientName,
        (SELECT COUNT(*) FROM service_device_shares sh WHERE sh.assignment_id = a.id) AS shareCount
      FROM assignment_services asv
      JOIN service_device_assignments a ON a.id = asv.assignment_id
      JOIN equipment_catalog ec ON ec.id = a.catalog_id
      LEFT JOIN users tu ON tu.id = a.technician_id
      LEFT JOIN users cu ON cu.id = a.created_by
      WHERE asv.service_id = ?
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

    // Material por artigo: quanto saiu para este servico e quanto ja voltou.
    // Agregado (e nao por linha) porque a devolucao e parcial e sobre o artigo:
    // 50 m de cabo em duas linhas continuam a ser 50 m para recuperar.
    const materialReturns = db.prepare(`
      SELECT
        ml.catalog_id AS catalogId,
        ec.brand,
        ec.model,
        ec.unit_of_measure AS unitOfMeasure,
        SUM(ml.quantity) AS consumed,
        COALESCE((
          SELECT SUM(sm.quantity) FROM stock_movements sm
          WHERE sm.service_id = ml.service_id AND sm.catalog_id = ml.catalog_id AND sm.type = 'devolucao'
        ), 0) AS recovered
      FROM service_material_lines ml
      JOIN equipment_catalog ec ON ec.id = ml.catalog_id
      WHERE ml.service_id = ?
      GROUP BY ml.catalog_id, ec.brand, ec.model, ec.unit_of_measure
      ORDER BY ec.model
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

    // `sharedWithJson` vem da BD como texto; o cliente escolhe um destes serviços
    // para lhe passar a titularidade da antena.
    const assignmentsOut = (assignments as Array<Record<string, unknown>>).map(({ sharedWithJson, ...rest }) => ({
      ...rest,
      sharedWith: JSON.parse((sharedWithJson as string) ?? '[]') as Array<{ serviceId: number; clientName: string }>
    }));

    return { serviceId: service.id, assignments: assignmentsOut, materials, materialReturns, installCosts, events };
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
   * Todo o equipamento ativo dos servicos — base do ecra de atribuicao de IPs.
   * Sem filtro por tipo: quem leva endereco reservado e quem apanha DHCP decide-se
   * na instalacao, caso a caso, e um router de gestao tambem pode querer um. Aqui
   * so ha equipamento; os materiais vivem em `service_material_lines`.
   */
  app.get('/api/service-device-assignments', { preHandler: requireAuth() }, async () => {
    const db = getSqliteDatabase();
    return db.prepare(`
      SELECT
        a.id,
        a.service_id AS serviceId,
        c.id AS clientId,
        c.full_name AS clientName,
        e.brand,
        e.model,
        e.type AS catalogType,
        a.serial_number AS serialNumber,
        a.ip_address AS ipAddress,
        ${SHARED_WITH_NAMES_SQL} AS sharedWithNames
      FROM service_device_assignments a
      JOIN services s ON s.id = a.service_id
      JOIN clients c ON c.id = s.client_id
      JOIN equipment_catalog e ON e.id = a.catalog_id
      WHERE a.end_date IS NULL
      ORDER BY c.full_name, a.id
    `).all();
  });

  /**
   * Atribui IPs a varios equipamentos de uma vez, tudo ou nada. Valida o estado FINAL
   * em vez de linha a linha, para que trocar dois IPs entre equipamentos passe em vez
   * de colidir consigo proprio.
   */
  app.patch('/api/service-device-assignments', canWriteTechnical, async (request, reply) => {
    const parsed = bulkIpSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de atribuicao invalidos' });
    }

    const db = getSqliteDatabase();
    const active = new Map((db.prepare(`
      SELECT id, ip_address AS ipAddress
      FROM service_device_assignments
      WHERE end_date IS NULL
    `).all() as Array<{ id: number; ipAddress: string | null }>).map((row) => [row.id, row.ipAddress]));

    const changes: Array<{ id: number; ipAddress: string | null }> = [];
    for (const item of parsed.data.items) {
      if (!active.has(item.id)) {
        return reply.status(404).send({ error: `Equipamento ${item.id} nao encontrado ou ja removido` });
      }
      const ipAddress = cleanValue(item.ipAddress);
      if (ipAddress && !isIpv4(ipAddress)) {
        return reply.status(400).send({ error: IP_FORMAT_ERROR });
      }
      if (ipAddress !== active.get(item.id)) {
        changes.push({ id: item.id, ipAddress });
      }
      active.set(item.id, ipAddress);
    }

    // Estado final: nenhum IP pode ficar em dois equipamentos ativos.
    const seen = new Map<string, number>();
    for (const [id, ipAddress] of active) {
      if (!ipAddress) {
        continue;
      }
      if (seen.has(ipAddress)) {
        return reply.status(409).send({ error: `IP ${ipAddress} ficaria em dois equipamentos ativos` });
      }
      seen.set(ipAddress, id);
    }

    db.transaction(() => {
      const update = db.prepare(`
        UPDATE service_device_assignments
        SET ip_address = ?, updated_at = datetime('now')
        WHERE id = ? AND end_date IS NULL
      `);
      for (const change of changes) {
        update.run(change.ipAddress, change.id);
      }
    })();

    if (changes.length > 0) {
      recordAudit(request, {
        action: 'update_device',
        entityType: 'service_device_assignment',
        entityId: changes[0].id,
        summary: `Atribuiu IP a ${changes.length} equipamento(s)`,
        metadata: { changes }
      });
    }
    return reply.status(200).send({ updated: changes.length });
  });

  /**
   * Liga uma antena ja instalada a outro servico: predio com switch, ou antena com
   * varias saidas de rede. NAO toca em stock, movimentos nem eventos — e isso que
   * distingue partilhar de instalar. A unidade fisica continua a ser uma so.
   */
  app.post('/api/service-device-assignments/:id/shares', canWriteTechnical, async (request, reply) => {
    const assignmentId = Number((request.params as { id: string }).id);
    const parsed = shareSchema.safeParse(request.body);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de partilha invalidos' });
    }

    const db = getSqliteDatabase();
    const current = db.prepare(`
      SELECT id, service_id AS serviceId, end_date AS endDate
      FROM service_device_assignments
      WHERE id = ?
    `).get(assignmentId) as { id: number; serviceId: number; endDate: string | null } | undefined;

    if (!current) {
      return reply.status(404).send({ error: 'Atribuicao nao encontrada' });
    }
    if (current.endDate) {
      return reply.status(400).send({ error: 'Atribuicao ja encerrada' });
    }
    if (!loadService(parsed.data.serviceId)) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }
    if (parsed.data.serviceId === current.serviceId) {
      return reply.status(409).send({ error: 'Este servico ja e o titular do equipamento' });
    }

    const inserted = db.prepare(`
      INSERT OR IGNORE INTO service_device_shares (assignment_id, service_id)
      VALUES (?, ?)
    `).run(assignmentId, parsed.data.serviceId);
    if (inserted.changes === 0) {
      return reply.status(409).send({ error: 'Este equipamento ja serve este servico' });
    }

    recordAudit(request, {
      action: 'share_device',
      entityType: 'service_device_assignment',
      entityId: assignmentId,
      summary: `Ligou o equipamento ${assignmentId} ao servico ${parsed.data.serviceId}`,
      metadata: { serviceId: parsed.data.serviceId, ownerServiceId: current.serviceId }
    });
    return reply.status(201).send({ shareId: inserted.lastInsertRowid, serviceId: parsed.data.serviceId });
  });

  /** Desliga a antena de um servico partilhado. O titular nunca sai por aqui. */
  app.delete('/api/service-device-assignments/:id/shares/:serviceId', canWriteTechnical, async (request, reply) => {
    const params = request.params as { id: string; serviceId: string };
    const assignmentId = Number(params.id);
    const serviceId = Number(params.serviceId);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0 || !Number.isInteger(serviceId) || serviceId <= 0) {
      return reply.status(400).send({ error: 'Dados de partilha invalidos' });
    }

    const db = getSqliteDatabase();
    const removed = db.prepare(`
      DELETE FROM service_device_shares
      WHERE assignment_id = ? AND service_id = ?
    `).run(assignmentId, serviceId);
    if (removed.changes === 0) {
      return reply.status(404).send({ error: 'Partilha nao encontrada' });
    }

    recordAudit(request, {
      action: 'unshare_device',
      entityType: 'service_device_assignment',
      entityId: assignmentId,
      summary: `Desligou o equipamento ${assignmentId} do servico ${serviceId}`,
      metadata: { serviceId }
    });
    return reply.status(200).send({ removed: removed.changes });
  });

  /**
   * Passa a titularidade da antena a um dos servicos que ela ja serve.
   *
   * O titular e a ancora do que e fisico — stock, IP, devolucao e renda — por isso
   * quando ele sai a unidade tem de mudar de dono em vez de ficar orfa. Guarda de
   * faturacao e nao tecnica: isto move uma renda mensal de um cliente para outro.
   */
  app.post('/api/service-device-assignments/:id/owner', canManageBilling, async (request, reply) => {
    const assignmentId = Number((request.params as { id: string }).id);
    const parsed = promoteOwnerSchema.safeParse(request.body ?? {});
    if (!Number.isInteger(assignmentId) || assignmentId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de titularidade invalidos' });
    }

    const db = getSqliteDatabase();
    const result = promoteAssignmentOwner(db, assignmentId, parsed.data, request.user?.id ?? null);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }

    recordAudit(request, {
      action: 'transfer_device_owner',
      entityType: 'service_device_assignment',
      entityId: assignmentId,
      summary: `Titularidade do equipamento ${assignmentId}: ${result.value.fromClientName} para ${result.value.toClientName}`,
      metadata: {
        fromServiceId: result.value.fromServiceId,
        toServiceId: result.value.toServiceId,
        keepPreviousAsShare: result.value.keptPreviousAsShare
      }
    });
    return reply.status(200).send(result.value);
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
        notes,
        ownership,
        rental_fee_cve AS rentalFeeCve
      FROM service_device_assignments
      WHERE id = ?
    `).get(assignmentId) as {
      id: number; serviceId: number; endDate: string | null;
      serialNumber: string | null; assetTag: string | null;
      ipAddress: string | null; macAddress: string | null; notes: string | null;
      ownership: string; rentalFeeCve: number;
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
      notes: merge(parsed.data.notes, current.notes),
      rentalFeeCve: parsed.data.rentalFeeCve == null ? current.rentalFeeCve : Math.round(parsed.data.rentalFeeCve)
    };

    // Equipamento do cliente nao gera renda — a faturacao so soma o que e do
    // ISP, portanto aceitar uma renda aqui era guardar um numero que nunca sai
    // em fatura nenhuma.
    if (current.ownership === 'cliente' && next.rentalFeeCve > 0) {
      return reply.status(400).send({ error: 'Equipamento do cliente nao tem aluguer' });
    }

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
          rental_fee_cve = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      next.serialNumber, next.assetTag, next.ipAddress, next.macAddress, next.notes,
      next.rentalFeeCve, assignmentId
    );

    recordAudit(request, {
      action: 'update_device',
      entityType: 'service_device_assignment',
      entityId: assignmentId,
      summary: `Atualizou identificacao do equipamento ${assignmentId}`,
      metadata: {
        serviceId: current.serviceId,
        ipAddress: next.ipAddress,
        previousIpAddress: current.ipAddress,
        // O aluguer entra no que o cliente paga: quem o mudou fica escrito.
        rentalFeeCve: next.rentalFeeCve,
        previousRentalFeeCve: current.rentalFeeCve
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

      db.prepare(`
        UPDATE backbone_assignment_links
        SET ended_at = datetime('now'),
            ended_by = ?,
            change_reason = COALESCE(change_reason, 'assignment_closed'),
            updated_at = datetime('now')
        WHERE assignment_id = ? AND ended_at IS NULL
      `).run(request.user?.id ?? parsed.data.technicianId ?? null, assignmentId);

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

      // A unidade nova herda os serviços que a antiga servia: é troca física, os
      // clientes partilhados continuam servidos.
      db.prepare(`
        UPDATE service_device_shares SET assignment_id = ? WHERE assignment_id = ?
      `).run(replacement.lastInsertRowid, assignmentId);

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

  /**
   * O cliente compra o equipamento que tinha alugado.
   *
   * Emite a cobrança única e vira a propriedade no mesmo passo — a partir da
   * fatura seguinte a linha de aluguer desaparece. Não é trabalho de técnico:
   * é uma venda, e por isso fica em `admin`/`operator`.
   */
  app.post('/api/service-device-assignments/:id/purchase', canManageBilling, async (request, reply) => {
    const assignmentId = Number((request.params as { id: string }).id);
    const parsed = purchaseSchema.safeParse(request.body ?? {});
    if (!Number.isInteger(assignmentId) || assignmentId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de compra invalidos' });
    }

    const db = getSqliteDatabase();
    const current = db.prepare(`
      SELECT a.id, a.service_id AS serviceId, a.end_date AS endDate, a.ownership,
             s.client_id AS clientId,
             TRIM(COALESCE(ec.brand, '') || ' ' || ec.model) AS label
      FROM service_device_assignments a
      JOIN services s ON s.id = a.service_id
      JOIN equipment_catalog ec ON ec.id = a.catalog_id
      WHERE a.id = ?
    `).get(assignmentId) as {
      id: number; serviceId: number; endDate: string | null;
      ownership: string; clientId: number; label: string;
    } | undefined;

    if (!current) {
      return reply.status(404).send({ error: 'Atribuicao nao encontrada' });
    }
    if (current.endDate) {
      return reply.status(400).send({ error: 'Atribuicao ja encerrada' });
    }
    if (current.ownership === 'cliente') {
      return reply.status(409).send({ error: 'Este equipamento ja e do cliente' });
    }

    const result = db.transaction(() => {
      const purchase = insertEquipmentPurchase(db, {
        assignmentId,
        serviceId: current.serviceId,
        clientId: current.clientId,
        amountCve: parsed.data.amountCve,
        label: current.label
      });
      recordAuditStrict(db, request, {
        action: 'equipment_purchase',
        entityType: 'service_device_assignment',
        entityId: assignmentId,
        summary: `Cliente comprou ${current.label} por ${parsed.data.amountCve} CVE`,
        metadata: {
          serviceId: current.serviceId,
          amountCve: parsed.data.amountCve,
          paymentId: purchase.paymentId,
          notes: parsed.data.notes ?? null
        }
      });
      return purchase;
    })();

    return reply.send({ ok: true, paymentId: result.paymentId });
  });

  app.post('/api/service-device-assignments/:id/return', canWriteTechnical, async (request, reply) => {
    const assignmentId = Number((request.params as { id: string }).id);
    const parsed = deviceReturnSchema.safeParse(request.body ?? {});
    if (!Number.isInteger(assignmentId) || assignmentId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de devolucao invalidos' });
    }

    const db = getSqliteDatabase();
    const current = db.prepare(`
      SELECT service_id AS serviceId, catalog_id AS catalogId
      FROM service_device_assignments
      WHERE id = ?
    `).get(assignmentId) as { serviceId: number; catalogId: number } | undefined;
    if (!current) {
      return reply.status(404).send({ error: 'Atribuicao nao encontrada' });
    }
    const service = loadService(current.serviceId);
    if (!service) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }
    if (parsed.data.technicianId && !loadUser(parsed.data.technicianId)) {
      return reply.status(404).send({ error: 'Tecnico nao encontrado' });
    }

    let result: { eventId: number | bigint; condition: ReturnCondition; restoredStock: boolean };
    try {
      result = db.transaction(() => returnAssignmentWithinTx(db, {
        assignmentId,
        clientName: service.clientName,
        condition: parsed.data.condition,
        notes: parsed.data.notes,
        technicianId: parsed.data.technicianId,
        userId: request.user?.id ?? null
      }))();
    } catch (error) {
      const mapped = mapReturnError(error);
      if (mapped) {
        return reply.status(mapped.status).send({ error: mapped.error });
      }
      throw error;
    }

    recordAudit(request, {
      action: 'return_device',
      entityType: 'service_device_assignment',
      entityId: assignmentId,
      summary: `Devolveu equipamento atribuido ${assignmentId} (${result.condition})`,
      metadata: {
        catalogId: current.catalogId,
        serviceId: current.serviceId,
        condition: result.condition,
        restoredStock: result.restoredStock
      }
    });
    return reply.status(200).send({
      assignmentId,
      eventId: result.eventId,
      condition: result.condition,
      restoredStock: result.restoredStock
    });
  });

  /**
   * Devolucao em lote — o momento do cancelamento. Fecha os equipamentos do ISP
   * com o estado de cada um e recupera o material que o tecnico trouxe, tudo na
   * mesma transacao: ou o servico fica fechado, ou nada muda.
   */
  app.post('/api/services/:id/returns', canWriteTechnical, async (request, reply) => {
    const serviceId = Number((request.params as { id: string }).id);
    const parsed = serviceReturnSchema.safeParse(request.body ?? {});
    if (!Number.isInteger(serviceId) || serviceId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de devolucao invalidos' });
    }

    const devices = parsed.data.devices ?? [];
    const materials = parsed.data.materials ?? [];
    if (devices.length === 0 && materials.length === 0) {
      return reply.status(400).send({ error: 'Indique pelo menos um equipamento ou material' });
    }

    const db = getSqliteDatabase();
    const service = loadService(serviceId);
    if (!service) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }
    if (parsed.data.technicianId && !loadUser(parsed.data.technicianId)) {
      return reply.status(404).send({ error: 'Tecnico nao encontrado' });
    }

    let result;
    try {
      result = db.transaction(() => processServiceReturn(db, {
        serviceId,
        clientName: service.clientName,
        devices,
        materials,
        technicianId: parsed.data.technicianId,
        notes: parsed.data.notes,
        userId: request.user?.id ?? null
      }))();
    } catch (error) {
      const mapped = mapReturnError(error);
      if (mapped) {
        return reply.status(mapped.status).send({ error: mapped.error });
      }
      throw error;
    }

    recordAudit(request, {
      action: 'return_batch',
      entityType: 'service',
      entityId: serviceId,
      summary: `Devolucao no servico ${serviceId}: ${result.devices.length} equipamento(s), ${result.materials.length} material(is)`,
      metadata: { devices: result.devices, materials: result.materials, eventId: result.eventId }
    });
    return reply.status(200).send({ serviceId, ...result });
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
