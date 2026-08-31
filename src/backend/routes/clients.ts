import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDatabase, getSqliteDatabase } from '../db/database';
import { clients } from '../db/schema';
import { recordAudit } from '../lib/audit';
import { buildClientsImportTemplate } from '../lib/clients-import-template';
import { portfolioRows } from '../lib/capex';
import { loadCompanyOpexContext } from '../lib/opex';
import { balanceSqlExpr, clientCreditBalance } from '../lib/payments';
import { changeServiceStatus } from '../lib/services';
import { requireAuth, requireRole } from './auth';

function addMonthsIso(isoDate: string, months: number): string {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  date.setUTCMonth(date.getUTCMonth() + Math.round(months));
  return date.toISOString().slice(0, 10);
}

const createClientSchema = z.object({
  fullName: z.string().trim().min(1),
  phone: z.string().trim().optional().nullable(),
  nif: z.string().trim().regex(/^[12]\d{8}$/).optional().nullable().or(z.literal('').transform(() => null)),
  island: z.string().trim().optional().nullable(),
  zone: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  status: z.enum(['active', 'suspended', 'cancelled']).default('active')
});

export async function registerClientRoutes(app: FastifyInstance) {
  const canWriteClients = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/clients', { preHandler: requireAuth() }, async () => {
    const db = getDatabase();

    return db
      .select()
      .from(clients)
      .orderBy(asc(clients.fullName));
  });

  app.get('/api/clients/import-template.xlsx', canWriteClients, async (_request, reply) => {
    const buffer = await buildClientsImportTemplate();
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="clientes-template.xlsx"')
      .send(buffer);
  });

  app.get('/api/clients/:id/profitability', { preHandler: requireAuth() }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Id invalido' });
    }
    const db = getSqliteDatabase();

    const client = db.prepare(`
      SELECT id, client_code AS clientCode, full_name AS fullName, phone, island, zone, status
      FROM clients WHERE id = ?
    `).get(id) as {
      id: number; clientCode: string; fullName: string; phone: string | null;
      island: string | null; zone: string | null; status: string;
    } | undefined;
    if (!client) return reply.status(404).send({ error: 'Cliente nao encontrado' });

    const investmentRows = db.prepare(`
      SELECT id, name, type, investment_date AS investmentDate, reference_month AS referenceMonth,
             status, zone, total_cost_cve AS totalCostCve
      FROM investments
      WHERE client_id = ?
      ORDER BY investment_date ASC, id ASC
    `).all(id) as Array<{
      id: number; name: string; type: string; investmentDate: string; referenceMonth: string;
      status: string; zone: string | null; totalCostCve: number;
    }>;

    const investmentEquipmentUsed = investmentRows.length === 0 ? [] : db.prepare(`
      SELECT item_type AS itemType,
             item_name AS itemName,
             SUM(quantity) AS quantity,
             SUM(quantity_used) AS quantityUsed,
             SUM(total_cost_cve) AS totalCostCve
      FROM investment_items
      WHERE investment_id IN (${investmentRows.map(() => '?').join(',')})
      GROUP BY item_type, item_name
      ORDER BY totalCostCve DESC, item_name ASC
    `).all(...investmentRows.map((r) => r.id)) as Array<{
      itemType: string; itemName: string; quantity: number; quantityUsed: number; totalCostCve: number;
    }>;

    // Rateio: uma antena que serve N serviços (prédio com switch) custa 1/N a cada
    // um. A soma sobre todos os clientes dá o custo do equipamento exatamente uma
    // vez — o mesmo princípio do rateio de investimentos em lib/opex.ts.
    // ponytail: a quantidade fica inteira; só o custo se divide. "0,5 antena" não
    // significa nada para quem lê a ficha do cliente.
    const installedEquipmentUsed = db.prepare(`
      SELECT ec.type AS itemType,
             TRIM(COALESCE(ec.brand || ' ', '') || ec.model) AS itemName,
             COUNT(*) AS quantity,
             SUM(CASE WHEN a.end_date IS NULL THEN 1 ELSE 0 END) AS quantityUsed,
             SUM((ec.purchase_price_cve + ec.shipping_cost_cve + ec.customs_duty_cve + ec.other_costs_cve)
                 * 1.0 / sh.n) AS totalCostCve
      FROM assignment_services asv
      JOIN service_device_assignments a ON a.id = asv.assignment_id
      JOIN equipment_catalog ec ON ec.id = a.catalog_id
      JOIN services s ON s.id = asv.service_id
      JOIN (SELECT assignment_id, COUNT(*) AS n FROM assignment_services GROUP BY assignment_id) sh
        ON sh.assignment_id = a.id
      WHERE s.client_id = ?
      GROUP BY ec.type, ec.brand, ec.model
      ORDER BY totalCostCve DESC, itemName ASC
    `).all(id) as Array<{
      itemType: string; itemName: string; quantity: number; quantityUsed: number; totalCostCve: number;
    }>;

    const installedMaterialsUsed = db.prepare(`
      SELECT 'material' AS itemType,
             TRIM(COALESCE(ec.brand || ' ', '') || ec.model) AS itemName,
             SUM(ml.quantity) AS quantity,
             SUM(ml.quantity) AS quantityUsed,
             SUM(ml.quantity * ml.unit_cost_cve) AS totalCostCve
      FROM service_material_lines ml
      JOIN equipment_catalog ec ON ec.id = ml.catalog_id
      JOIN services s ON s.id = ml.service_id
      WHERE s.client_id = ?
      GROUP BY ec.id, ec.brand, ec.model
      ORDER BY totalCostCve DESC, itemName ASC
    `).all(id) as Array<{
      itemType: string; itemName: string; quantity: number; quantityUsed: number; totalCostCve: number;
    }>;

    const equipmentUsed = [...investmentEquipmentUsed, ...installedEquipmentUsed, ...installedMaterialsUsed]
      .reduce((items, row) => {
        const existing = items.find((item) => item.itemType === row.itemType && item.itemName === row.itemName);
        if (existing) {
          existing.quantity += Number(row.quantity || 0);
          existing.quantityUsed += Number(row.quantityUsed || 0);
          existing.totalCostCve += Number(row.totalCostCve || 0);
        } else {
          items.push({
            itemType: row.itemType,
            itemName: row.itemName,
            quantity: Number(row.quantity || 0),
            quantityUsed: Number(row.quantityUsed || 0),
            totalCostCve: Number(row.totalCostCve || 0)
          });
        }
        return items;
      }, [] as Array<{ itemType: string; itemName: string; quantity: number; quantityUsed: number; totalCostCve: number }>)
      .sort((a, b) => b.totalCostCve - a.totalCostCve || a.itemName.localeCompare(b.itemName));

    // Os numeros vem da carteira — a mesma funcao que alimenta a lista em
    // Financeiro. Enquanto viveram nos dois sitios, bastava mexer num para a
    // ficha e a lista discordarem sobre o mesmo cliente.
    const portfolio = portfolioRows([id])[0];
    const installationCostCve = portfolio.installationCostCve;

    const payments = db.prepare(`
      SELECT id, status, amount_cve AS amountCve, due_date AS dueDate,
             payment_date AS paymentDate, reference_month AS referenceMonth,
             COALESCE((
               SELECT SUM(r.amount_cve) FROM payment_receipts r
               WHERE r.payment_id = payments.id AND r.voided_at IS NULL
             ), 0) AS receivedCve,
             ${balanceSqlExpr('payments')} AS balanceCve
      FROM payments
      WHERE client_id = ?
      ORDER BY due_date ASC, id ASC
    `).all(id) as Array<{
      id: number; status: string; amountCve: number; dueDate: string;
      paymentDate: string | null; referenceMonth: string;
      receivedCve: number; balanceCve: number;
    }>;

    // Recebido e em divida saem da mesma fatura quando ela esta meio paga: o
    // recebido e o que entrou, o pendente e o que falta — nunca o valor cheio
    // dos dois lados.
    const paidRevenueCve = payments
      .filter((p) => p.status !== 'cancelled')
      .reduce((s, p) => s + Number(p.receivedCve), 0);
    const pendingRevenueCve = payments
      .filter((p) => p.status === 'pending' || p.status === 'overdue')
      .reduce((s, p) => s + Number(p.balanceCve), 0);
    const creditCve = clientCreditBalance(db, id);
    const monthsActive = new Set(payments.map((p) => p.referenceMonth)).size;
    const paidMonths = new Set(payments.filter((p) => p.status === 'paid').map((p) => p.referenceMonth)).size;
    const monthlyAverageRevenueCve = paidMonths > 0 ? paidRevenueCve / paidMonths : 0;

    const opexCtx = loadCompanyOpexContext();
    // A reparticao do OPEX continua a mostrar-se parcela a parcela na ficha; o
    // efetivo, o acumulado e tudo o que deriva deles vem da carteira.
    const imputedMonthlyOpexCve = opexCtx.opexPerClientPerMonth;
    const directClientOpexCve = opexCtx.directByClient[client.id] || 0;
    const directZoneOpexCve = client.zone ? (opexCtx.directByZone[client.zone] || 0) : 0;
    const zoneActiveCount = client.zone
      ? (db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE zone = ? AND status = 'active'`).get(client.zone) as { n: number }).n
      : 0;
    const directZonePerClientCve = zoneActiveCount > 0 ? directZoneOpexCve / zoneActiveCount : 0;
    const directInvestmentOpexCve = investmentRows
      .reduce((sum, inv) => sum + (opexCtx.directByInvestment[inv.id] || 0), 0);
    const effectiveMonthlyOpexCve = portfolio.effectiveMonthlyOpexCve;
    const cumulativeOpexCve = portfolio.cumulativeOpexCve;
    const monthlyNetProfitCve = portfolio.monthlyNetProfitCve;
    const netProfitCve = portfolio.netProfitCve;
    const monthsToBreakeven = portfolio.monthsToBreakeven;
    const profitabilityPct = portfolio.profitabilityPct;
    const isRecovered = portfolio.isRecovered;

    const oldestPaidDate = payments
      .filter((p) => p.status === 'paid' && p.paymentDate)
      .map((p) => p.paymentDate!)
      .sort()[0] || null;
    const projectedBreakevenDate = (oldestPaidDate && monthsToBreakeven)
      ? addMonthsIso(oldestPaidDate, monthsToBreakeven)
      : null;

    return {
      clientId: client.id,
      client,
      installationCostCve,
      investments: investmentRows,
      equipmentUsed,
      paidRevenueCve,
      pendingRevenueCve,
      creditCve,
      monthsActive,
      paidMonths,
      monthlyAverageRevenueCve,
      imputedMonthlyOpexCve,
      directClientOpexCve,
      directZoneOpexCve: directZonePerClientCve,
      directInvestmentOpexCve,
      effectiveMonthlyOpexCve,
      cumulativeOpexCve,
      monthlyNetProfitCve,
      netProfitCve,
      monthsToBreakeven,
      projectedBreakevenDate,
      profitabilityPct,
      isRecovered,
      companyOpexShare: opexCtx
    };
  });

  app.get('/api/clients/:id/notices', { preHandler: requireAuth() }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Id invalido' });
    }
    const db = getSqliteDatabase();
    // Timeline do funil de cobrança do cliente (avisos automáticos + manuais).
    return db.prepare(`
      SELECT n.id, n.notice_type AS noticeType, n.origin, n.status, n.sent_at AS sentAt,
             n.payment_id AS paymentId, p.reference_month AS referenceMonth,
             p.invoice_number AS invoiceNumber, p.amount_cve AS amountCve, p.due_date AS dueDate
      FROM whatsapp_notices n
      LEFT JOIN payments p ON p.id = n.payment_id
      WHERE n.client_id = ?
      ORDER BY n.sent_at DESC, n.id DESC
      LIMIT 100
    `).all(id);
  });

  app.post('/api/clients', canWriteClients, async (request, reply) => {
    const parsed = createClientSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de cliente invalidos' });
    }

    const db = getDatabase();
    const total = await db.$count(clients);
    const clientCode = `C${String(total + 1).padStart(4, '0')}`;
    const now = new Date().toISOString();

    const [client] = await db
      .insert(clients)
      .values({
        clientCode,
        fullName: parsed.data.fullName,
        phone: parsed.data.phone || null,
        nif: parsed.data.nif || null,
        island: parsed.data.island || null,
        zone: parsed.data.zone || null,
        address: parsed.data.address || null,
        status: parsed.data.status,
        createdAt: now,
        updatedAt: now
      })
      .returning();

    recordAudit(request, {
      action: 'create',
      entityType: 'client',
      entityId: client.id,
      summary: `Criou cliente ${client.fullName}`,
      metadata: { clientCode: client.clientCode, status: client.status }
    });
    return reply.status(201).send(client);
  });

  app.put('/api/clients/:id', canWriteClients, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = createClientSchema.safeParse(request.body);

    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de cliente invalidos' });
    }

    const db = getDatabase();
    const now = new Date().toISOString();

    try {
      const [client] = await db
        .update(clients)
        .set({
          fullName: parsed.data.fullName,
          phone: parsed.data.phone || null,
          nif: parsed.data.nif || null,
          island: parsed.data.island || null,
          zone: parsed.data.zone || null,
          address: parsed.data.address || null,
          status: parsed.data.status,
          updatedAt: now
        })
        .where(eq(clients.id, id))
        .returning();

      if (!client) {
        return reply.status(404).send({ error: 'Cliente nao encontrado' });
      }

      recordAudit(request, {
        action: 'update',
        entityType: 'client',
        entityId: client.id,
        summary: `Atualizou cliente ${client.fullName}`,
        metadata: { clientCode: client.clientCode, status: client.status }
      });

      // Cascata fiscal: cancelar/suspender um cliente propaga o estado aos
      // serviços ativos dele, mantendo a coerência. A faturação só cobra
      // serviços 'active', por isso suspensos/cancelados deixam de gerar
      // mensalidade. Idempotente — só toca em serviços ainda 'active', e nunca
      // reativa um serviço já cancelado (estado mais terminal que suspenso).
      if (client.status === 'cancelled' || client.status === 'suspended') {
        const sqlite = getSqliteDatabase();
        const affected = sqlite
          .prepare(`SELECT id FROM services WHERE client_id = ? AND status = 'active'`)
          .all(client.id) as Array<{ id: number }>;
        // Um a um pela mesma porta que qualquer outra mudança de estado: cada
        // serviço fica com a sua entrada na história, com o motivo.
        for (const service of affected) {
          changeServiceStatus(sqlite, service.id, client.status, {
            reason: `Cascata do cliente ${client.fullName} (${client.status === 'cancelled' ? 'cancelado' : 'suspenso'})`
          });
        }
        if (affected.length > 0) {
          const cancelled = client.status === 'cancelled';
          recordAudit(request, {
            action: cancelled ? 'cancel' : 'suspend',
            entityType: 'service',
            entityId: client.id,
            summary: `${cancelled ? 'Cancelou' : 'Suspendeu'} ${affected.length} servico(s) em cascata do cliente ${client.fullName}`,
            metadata: { clientCode: client.clientCode, status: client.status, affectedServices: affected.length }
          });
        }
      }
      return client;
    } catch {
      return reply.status(409).send({ error: 'Telefone ou NIF ja existe noutro cliente' });
    }
  });

  const bulkRowSchema = z.object({
    fullName: z.string().trim().min(1).max(180),
    clientCode: z.string().trim().max(40).optional().nullable(),
    nif: z.string().trim().regex(/^[12]\d{8}$/).optional().nullable().or(z.literal('').transform(() => null)),
    phone: z.string().trim().max(40).optional().nullable().or(z.literal('').transform(() => null)),
    email: z.string().trim().email().optional().nullable().or(z.literal('').transform(() => null)),
    address: z.string().trim().max(240).optional().nullable(),
    island: z.string().trim().max(80).optional().nullable(),
    zone: z.string().trim().max(120).optional().nullable(),
    status: z.enum(['active', 'suspended', 'cancelled']).default('active')
  });

  const bulkSchema = z.object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000)
  });

  app.post('/api/clients/bulk', canWriteClients, async (request, reply) => {
    const parsed = bulkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Payload de importacao invalido' });
    }

    const db = getSqliteDatabase();

    const existingCodes = new Set(
      (db.prepare('SELECT client_code FROM clients').all() as Array<{ client_code: string }>).map(
        (row) => row.client_code
      )
    );
    const existingNifs = new Set(
      (db.prepare('SELECT nif FROM clients WHERE nif IS NOT NULL').all() as Array<{ nif: string }>).map(
        (row) => row.nif
      )
    );
    const existingPhones = new Set(
      (
        db
          .prepare('SELECT phone FROM clients WHERE phone IS NOT NULL AND phone <> \'\'')
          .all() as Array<{ phone: string }>
      ).map((row) => row.phone)
    );

    let codeSequence =
      (db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n + 1;

    function nextCode(): string {
      while (existingCodes.has(`C${String(codeSequence).padStart(4, '0')}`)) {
        codeSequence += 1;
      }
      const code = `C${String(codeSequence).padStart(4, '0')}`;
      codeSequence += 1;
      return code;
    }

    const insertStmt = db.prepare(`
      INSERT INTO clients (
        client_code, full_name, phone, email, nif, address,
        island, zone, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    const skipped: Array<{ index: number; reason: string; value?: string }> = [];
    const errors: Array<{ index: number; reason: string; detail?: string }> = [];
    const inserted: Array<{ index: number; clientCode: string }> = [];

    const runImport = db.transaction(() => {
      parsed.data.rows.forEach((raw, index) => {
        const rowParsed = bulkRowSchema.safeParse(raw);
        if (!rowParsed.success) {
          errors.push({
            index,
            reason: 'validation',
            detail: rowParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          });
          return;
        }
        const row = rowParsed.data;
        const code = row.clientCode || nextCode();

        if (existingCodes.has(code)) {
          skipped.push({ index, reason: 'clientCode_duplicate', value: code });
          return;
        }
        if (row.nif && existingNifs.has(row.nif)) {
          skipped.push({ index, reason: 'nif_duplicate', value: row.nif });
          return;
        }
        if (row.phone && existingPhones.has(row.phone)) {
          skipped.push({ index, reason: 'phone_duplicate', value: row.phone });
          return;
        }

        try {
          insertStmt.run(
            code,
            row.fullName,
            row.phone || null,
            row.email || null,
            row.nif || null,
            row.address || null,
            row.island || null,
            row.zone || null,
            row.status
          );
        } catch (err) {
          errors.push({
            index,
            reason: 'insert_failed',
            detail: err instanceof Error ? err.message : 'unknown'
          });
          return;
        }

        existingCodes.add(code);
        if (row.nif) existingNifs.add(row.nif);
        if (row.phone) existingPhones.add(row.phone);
        inserted.push({ index, clientCode: code });
      });
    });

    try {
      runImport();
    } catch (err) {
      return reply.status(500).send({
        error: 'Importacao falhou',
        detail: err instanceof Error ? err.message : 'unknown'
      });
    }

    recordAudit(request, {
      action: 'bulk_import',
      entityType: 'client',
      summary: `Importou ${inserted.length} cliente(s)`,
      metadata: {
        received: parsed.data.rows.length,
        inserted: inserted.length,
        skipped: skipped.length,
        errors: errors.length
      }
    });

    return reply.status(200).send({
      summary: {
        received: parsed.data.rows.length,
        inserted: inserted.length,
        skipped: skipped.length,
        errors: errors.length
      },
      inserted,
      skipped,
      errors
    });
  });
}
