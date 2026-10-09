import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit, recordAuditStrict } from '../lib/audit';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from '../lib/admin-network';
import { runJob } from '../lib/jobRuns';
import { requestNetworkSync, runExclusive } from '../lib/network-sync';
import {
  cancelPlanChange, createPlanChangeBatch, listPlanChanges, loadPlanChange, PlanChangeBlocked, previewPlanChange, runPlanChangeBatch,
  type RouterSnapshot
} from '../lib/plan-change';
import { createTransport, describeRouterFailure, isRouterConfigured, listActive, listProfiles, listSecrets, readRouterConfig, type RouterTransport } from '../lib/routeros';
import { defaultProfileName } from '../lib/plan-profiles';
import { requireAuth, requireRole } from './auth';

const planSchema = z.object({
  name: z.string().trim().min(1),
  downloadSpeed: z.string().trim().min(1),
  uploadSpeed: z.string().trim().min(1),
  connectionType: z.enum(['radio', 'fibra', 'cabo', 'outro']).default('outro'),
  monthlyPriceCve: z.coerce.number().min(0),
  installationFeeCve: z.coerce.number().min(0).default(0),
  description: z.string().trim().optional().nullable(),
  // Velocidade legivel por maquina, para relatorios. O router nao a le: no
  // RouterOS a velocidade vive no perfil PPP (ver routerProfile).
  downloadMbps: z.coerce.number().int().min(1).max(10000).optional().nullable(),
  uploadMbps: z.coerce.number().int().min(1).max(10000).optional().nullable(),
  // Nome do perfil PPP no MikroTik. A reconciliacao cria-o (se nao existir) e
  // aponta para ele o secret de cada servico do plano. Vazio = o nome estavel
  // ispm-plano-<id>; um nome do operador fica como esta (ADR 0011).
  routerProfile: z.string().trim().max(64).regex(/^[\w .-]*$/).optional().nullable(),
  active: z.coerce.boolean().default(true)
});

const bulkPreviewSchema = z.object({
  serviceIds: z.array(z.number().int().positive()).min(1).max(1000),
  targetPlanId: z.number().int().positive(),
  updatePrice: z.boolean().default(true)
}).strict();

const bulkStartSchema = bulkPreviewSchema.extend({
  reason: z.string().trim().max(500).optional().nullable(),
  // Por omissão ninguém é derrubado: o perfil novo aplica-se quando o cliente reconectar.
  dropMode: z.enum(['none', 'now', 'scheduled']).default('none'),
  dropAt: z.string().datetime({ offset: true }).optional().nullable()
}).strict();

type RouterReading =
  | { router: RouterSnapshot; transport: RouterTransport; dryRun: boolean }
  | { router: null; issue: string; dryRun: boolean };

/** A leitura do router para a mudança em massa: em série, e só dentro da rede de gestão. */
async function readRouterForPlanChange(db: DatabaseType): Promise<RouterReading> {
  const config = readRouterConfig(db);
  if (!config.enabled || !isRouterConfigured(config)) {
    return { router: null, issue: 'Integração MikroTik desligada ou por configurar.', dryRun: config.dryRun };
  }
  const presence = await detectAdminNetwork(db);
  if (isOffNetwork(presence)) return { router: null, issue: offNetworkReason(presence), dryRun: config.dryRun };
  try {
    const transport = createTransport(config);
    const secrets = await listSecrets(transport);
    const active = await listActive(transport);
    const profiles = (await listProfiles(transport)).map((profile) => profile.name);
    return { router: { secrets, active, profiles }, transport, dryRun: config.dryRun };
  } catch (err) {
    const failure = describeRouterFailure(err);
    return { router: null, issue: `${failure.title}. ${failure.detail}`, dryRun: config.dryRun };
  }
}

export async function registerPlanRoutes(app: FastifyInstance) {
  const canWritePlans = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/plans', { preHandler: requireAuth() }, async () => {
    const db = getSqliteDatabase();
    return db.prepare(`
      SELECT
        id,
        name,
        download_speed AS downloadSpeed,
        upload_speed AS uploadSpeed,
        connection_type AS connectionType,
        monthly_price_cve AS monthlyPriceCve,
        installation_fee_cve AS installationFeeCve,
        download_mbps AS downloadMbps,
        upload_mbps AS uploadMbps,
        router_profile AS routerProfile,
        rs.status AS routerSyncStatus,
        rs.detail AS routerSyncDetail,
        rs.last_error AS routerSyncError,
        rs.checked_at AS routerSyncCheckedAt,
        description,
        active,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM internet_plans
      LEFT JOIN plan_router_sync rs ON rs.plan_id = internet_plans.id
      ORDER BY active DESC, monthly_price_cve, name
    `).all();
  });

  app.get('/api/plans/:id', { preHandler: requireAuth() }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const db = getSqliteDatabase();
    const plan = db.prepare(`
      SELECT
        id,
        name,
        download_speed AS downloadSpeed,
        upload_speed AS uploadSpeed,
        connection_type AS connectionType,
        monthly_price_cve AS monthlyPriceCve,
        installation_fee_cve AS installationFeeCve,
        download_mbps AS downloadMbps,
        upload_mbps AS uploadMbps,
        router_profile AS routerProfile,
        description,
        active
      FROM internet_plans
      WHERE id = ?
    `).get(id);

    if (!plan) {
      return reply.status(404).send({ error: 'Plano nao encontrado' });
    }

    return plan;
  });

  app.post('/api/plans', canWritePlans, async (request, reply) => {
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de plano invalidos' });
    }

    const db = getSqliteDatabase();
    const id = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO internet_plans (
          name, download_speed, upload_speed, connection_type, monthly_price_cve,
          installation_fee_cve, description, active, download_mbps, upload_mbps, router_profile, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        parsed.data.name,
        parsed.data.downloadSpeed,
        parsed.data.uploadSpeed,
        parsed.data.connectionType,
        parsed.data.monthlyPriceCve,
        parsed.data.installationFeeCve,
        parsed.data.description || null,
        parsed.data.active ? 1 : 0,
        parsed.data.downloadMbps ?? null,
        parsed.data.uploadMbps ?? null,
        parsed.data.routerProfile || null
      );
      const planId = Number(result.lastInsertRowid);
      // O nome estável depende do id, que só existe depois do INSERT.
      if (!parsed.data.routerProfile) {
        db.prepare('UPDATE internet_plans SET router_profile = ? WHERE id = ?').run(defaultProfileName(planId), planId);
      }
      return planId;
    })();

    recordAudit(request, { action: 'create', entityType: 'plan', entityId: id, summary: `Criou o plano ${parsed.data.name}` });
    requestNetworkSync();
    return reply.status(201).send({ id });
  });

  app.put('/api/plans/:id', canWritePlans, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = planSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de plano invalidos' });
    }

    const db = getSqliteDatabase();
    const result = db.prepare(`
      UPDATE internet_plans
      SET name = ?,
          download_speed = ?,
          upload_speed = ?,
          connection_type = ?,
          monthly_price_cve = ?,
          installation_fee_cve = ?,
          description = ?,
          active = ?,
          download_mbps = ?,
          upload_mbps = ?,
          router_profile = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      parsed.data.name,
      parsed.data.downloadSpeed,
      parsed.data.uploadSpeed,
      parsed.data.connectionType,
      parsed.data.monthlyPriceCve,
      parsed.data.installationFeeCve,
      parsed.data.description || null,
      parsed.data.active ? 1 : 0,
      parsed.data.downloadMbps ?? null,
      parsed.data.uploadMbps ?? null,
      parsed.data.routerProfile || defaultProfileName(id),
      id
    );

    if (result.changes === 0) {
      return reply.status(404).send({ error: 'Plano nao encontrado' });
    }

    recordAudit(request, { action: 'update', entityType: 'plan', entityId: id, summary: `Atualizou o plano ${parsed.data.name}` });
    requestNetworkSync();
    return { ok: true };
  });

  // ------------------------------------------------- mudança de plano em massa

  const adminOnly = { preHandler: requireRole(['admin']) };
  // Um serviço de cada vez é de quem já o pode editar; vários de uma vez mexem
  // em muitas faturas e em muitos secrets, e isso é só de administrador.
  const manyIsAdminOnly = (request: FastifyRequest, serviceIds: number[]) =>
    serviceIds.length > 1 && request.user !== undefined && request.user.role !== 'admin';
  const MANY_REFUSED = { error: 'Só administradores mudam o plano de vários serviços de uma vez' };

  /** O que a operação faria, serviço a serviço, e o que a impede. Não escreve nada. */
  app.post('/api/plans/bulk-change/preview', canWritePlans, async (request, reply) => {
    const parsed = bulkPreviewSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Pedido inválido' });
    if (manyIsAdminOnly(request, parsed.data.serviceIds)) return reply.status(403).send(MANY_REFUSED);
    const db = getSqliteDatabase();
    const reading = await readRouterForPlanChange(db);
    return previewPlanChange(db, parsed.data, reading.router, {
      dryRun: reading.dryRun,
      routerIssue: reading.router ? undefined : reading.issue
    });
  });

  /**
   * Valida contra o router lido agora, grava o lote e corre-o em segundo plano,
   * na mesma fila da reconciliação. O progresso lê-se em GET …/:id.
   */
  app.post('/api/plans/bulk-change', canWritePlans, async (request, reply) => {
    const parsed = bulkStartSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Pedido inválido' });
    if (manyIsAdminOnly(request, parsed.data.serviceIds)) return reply.status(403).send(MANY_REFUSED);
    const db = getSqliteDatabase();
    const reading = await readRouterForPlanChange(db);
    if (!reading.router) return reply.status(409).send({ error: reading.issue, blockers: [reading.issue] });

    // Só o autor: o lote continua a correr depois de este pedido responder.
    const actor = { user: request.user } as typeof request;
    let batchId: number;
    try {
      batchId = createPlanChangeBatch(db, parsed.data, reading.router, { dryRun: reading.dryRun, actor });
    } catch (err) {
      if (err instanceof PlanChangeBlocked) return reply.status(409).send({ error: err.message, blockers: err.blockers });
      throw err;
    }
    const { router, transport, dryRun } = reading;
    void runExclusive(() => runJob('plan_change', async () => ({
      batchId,
      status: await runPlanChangeBatch(db, { transport, dryRun }, batchId, router, actor)
    }))).catch((err) => app.log.error({ err, batchId }, 'plan change batch failed'));
    return reply.status(202).send({ batchId });
  });

  app.get('/api/plans/bulk-change', adminOnly, async () => listPlanChanges(getSqliteDatabase()));

  app.get('/api/plans/bulk-change/:id', adminOnly, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const batch = Number.isInteger(id) && id > 0 ? loadPlanChange(getSqliteDatabase(), id) : null;
    return batch ?? reply.status(404).send({ error: 'Mudança de plano não encontrada' });
  });

  /** Em curso: pára antes do serviço seguinte. Já acabado: desmarca as sessões agendadas. */
  app.post('/api/plans/bulk-change/:id/cancel', adminOnly, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const outcome = Number.isInteger(id) && id > 0 ? cancelPlanChange(getSqliteDatabase(), id) : 'not_found';
    if (outcome === 'not_found') return reply.status(404).send({ error: 'Mudança de plano não encontrada' });
    if (outcome !== 'nothing') {
      recordAudit(request, {
        action: 'plan_change_cancel', entityType: 'plan_change', entityId: id,
        summary: outcome === 'cancelling' ? `Cancelou a mudança de plano em massa #${id}` : `Desmarcou as sessões agendadas da mudança de plano #${id}`
      });
    }
    return { outcome };
  });

  // ------------------------------------------------- alinhar preços dos serviços

  /**
   * O que mudaria se os serviços ativos deste plano passassem a valer o preço
   * atual do plano.
   *
   * Existe porque `services.monthly_value_cve` é um instantâneo: mudar o preço
   * do plano não toca em quem já está instalado. Sem esta vista, alterar o preço
   * e esperar que aconteça alguma coisa é a forma mais fácil de faturar errado
   * durante meses sem ninguém dar por isso.
   */
  app.get('/api/plans/:id/reprice-preview', { preHandler: requireRole(['admin']) }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Plano invalido' });
    }
    const db = getSqliteDatabase();
    const plan = db.prepare('SELECT id, name, monthly_price_cve AS monthlyPriceCve FROM internet_plans WHERE id = ?')
      .get(id) as { id: number; name: string; monthlyPriceCve: number } | undefined;
    if (!plan) {
      return reply.status(404).send({ error: 'Plano nao encontrado' });
    }
    return { plan, rows: repriceRows(db, plan.id, plan.monthlyPriceCve) };
  });

  /**
   * Aplica o preço do plano aos serviços ativos. Só `admin`: mexer no valor
   * mensal de dezenas de clientes de uma vez não é trabalho de operador.
   */
  app.post('/api/plans/:id/reprice', { preHandler: requireRole(['admin']) }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Plano invalido' });
    }
    const db = getSqliteDatabase();
    const plan = db.prepare('SELECT id, name, monthly_price_cve AS monthlyPriceCve FROM internet_plans WHERE id = ?')
      .get(id) as { id: number; name: string; monthlyPriceCve: number } | undefined;
    if (!plan) {
      return reply.status(404).send({ error: 'Plano nao encontrado' });
    }

    const rows = repriceRows(db, plan.id, plan.monthlyPriceCve).filter((row) => row.changed);
    if (rows.length === 0) {
      return { ok: true, updated: 0 };
    }

    const update = db.prepare(`
      UPDATE services SET monthly_value_cve = ?, updated_at = datetime('now') WHERE id = ?
    `);
    db.transaction(() => {
      for (const row of rows) update.run(plan.monthlyPriceCve, row.serviceId);
      // Uma linha por lote, com o antes e o depois de cada serviço: é a prova de
      // quem mudou o preço de quem, e quando.
      recordAuditStrict(db, request, {
        action: 'plan_reprice',
        entityType: 'internet_plan',
        entityId: plan.id,
        summary: `Alinhou ${rows.length} servico(s) ao preco ${plan.monthlyPriceCve} CVE do plano ${plan.name}`,
        metadata: {
          monthlyPriceCve: plan.monthlyPriceCve,
          services: rows.map((row) => ({
            serviceId: row.serviceId,
            clientName: row.clientName,
            from: row.currentCve,
            to: plan.monthlyPriceCve
          }))
        }
      });
    })();

    return { ok: true, updated: rows.length };
  });
}

export type RepriceRow = {
  serviceId: number;
  clientName: string;
  /** Valor mensal guardado no serviço — a linha de internet da fatura. */
  currentCve: number;
  rentalCve: number;
  /** Última mensalidade realmente emitida, ou null se ainda não houve nenhuma. */
  lastInvoiceCve: number | null;
  newTotalCve: number;
  deltaCve: number;
  changed: boolean;
};

/**
 * O antes e o depois por serviço. `newTotalCve` já inclui o aluguer do
 * equipamento instalado — é o valor que o cliente vai ver na fatura, que é a
 * única grandeza sobre a qual alguém consegue decidir.
 *
 * A diferença mede-se contra a **última mensalidade emitida**, não contra o
 * valor guardado no serviço. É o número que o cliente viu no papel, e é o único
 * que continua a dizer a verdade depois de o aluguer passar a ser faturado — se
 * comparássemos com o valor do serviço, no dia em que o aluguer entrou em vigor
 * a coluna passaria a mentir por exatamente o valor do aluguer.
 */
function repriceRows(db: DatabaseType, planId: number, monthlyPriceCve: number): RepriceRow[] {
  const rows = db.prepare(`
    SELECT s.id AS serviceId, c.full_name AS clientName, s.monthly_value_cve AS currentCve,
           COALESCE((
             SELECT SUM(a.rental_fee_cve)
             FROM service_device_assignments a
             WHERE a.service_id = s.id AND a.end_date IS NULL AND a.ownership = 'isp'
           ), 0) AS rentalCve,
           (
             -- Só mensalidades: 'YYYY-MM'. As chaves fixas ('INSTALACAO',
             -- 'AV-...', 'EQUIP-...') são cobranças avulsas e não servem de
             -- termo de comparação para o valor mensal.
             --
             -- E dentro da mensalidade, só a linha de internet: o audiovisual
             -- viaja na mesma fatura e continua a ser cobrado por cima depois
             -- do acerto, por isso compará-lo com o total anunciava uma descida
             -- do tamanho do audiovisual que não existe. Faturas antigas não
             -- têm linhas — aí o total é a melhor aproximação que há.
             SELECT COALESCE((
               SELECT SUM(l.amount_cve) FROM payment_lines l
               WHERE l.payment_id = p.id AND l.kind = 'internet'
             ), p.amount_cve)
             FROM payments p
             WHERE p.service_id = s.id
               AND p.status != 'cancelled'
               AND p.reference_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
             ORDER BY p.reference_month DESC
             LIMIT 1
           ) AS lastInvoiceCve
    FROM services s
    JOIN clients c ON c.id = s.client_id
    WHERE s.plan_id = ? AND s.status = 'active' AND c.status != 'cancelled'
    ORDER BY c.full_name
  `).all(planId) as Array<{
    serviceId: number; clientName: string; currentCve: number;
    rentalCve: number; lastInvoiceCve: number | null;
  }>;

  return rows.map((row) => {
    const newTotalCve = monthlyPriceCve + row.rentalCve;
    const reference = row.lastInvoiceCve ?? row.currentCve;
    return {
      ...row,
      newTotalCve,
      deltaCve: newTotalCve - reference,
      changed: row.currentCve !== monthlyPriceCve
    };
  });
}
