import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAuditStrict } from '../lib/audit';
import { requireAuth, requireRole } from './auth';

const planSchema = z.object({
  name: z.string().trim().min(1),
  downloadSpeed: z.string().trim().min(1),
  uploadSpeed: z.string().trim().min(1),
  connectionType: z.enum(['radio', 'fibra', 'cabo', 'outro']).default('outro'),
  monthlyPriceCve: z.coerce.number().min(0),
  installationFeeCve: z.coerce.number().min(0).default(0),
  description: z.string().trim().optional().nullable(),
  // Velocidade legivel por maquina: e daqui que sai o rate-limit no MikroTik.
  // Nulo = sem limite definido; a reconciliacao nao adivinha a partir do texto.
  downloadMbps: z.coerce.number().int().min(1).max(10000).optional().nullable(),
  uploadMbps: z.coerce.number().int().min(1).max(10000).optional().nullable(),
  active: z.coerce.boolean().default(true)
});

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
        description,
        active,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM internet_plans
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
    const result = db.prepare(`
      INSERT INTO internet_plans (
        name, download_speed, upload_speed, connection_type, monthly_price_cve,
        installation_fee_cve, description, active, download_mbps, upload_mbps, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
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
      parsed.data.uploadMbps ?? null
    );

    return reply.status(201).send({ id: result.lastInsertRowid });
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
      id
    );

    if (result.changes === 0) {
      return reply.status(404).send({ error: 'Plano nao encontrado' });
    }

    return { ok: true };
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
