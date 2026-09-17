import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import {
  createAccount,
  createTransfer,
  listAccounts,
  listMovements,
  recordCashCount,
  reverseMovement,
  treasurySummary,
  updateAccount
} from '../lib/treasury';
import { requireRole } from './auth';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();

const accountFields = {
  name: z.string().trim().min(1).max(80),
  bankName: optionalText(80),
  accountNumber: optionalText(60),
  holderName: optionalText(120),
  reference: optionalText(120),
  openingBalanceCve: z.number().finite().optional(),
  openingDate: isoDate.optional(),
  isDefaultCash: z.boolean().optional(),
  showOnDocuments: z.boolean().optional(),
  active: z.boolean().optional()
};

const createAccountSchema = z.object({ kind: z.enum(['caixa', 'banco']), ...accountFields });
const updateAccountSchema = z.object(accountFields).partial();

const movementsQuerySchema = z.object({
  accountId: z.coerce.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  kind: z.enum(['recebimento', 'deposito', 'transferencia', 'despesa', 'investimento', 'ajuste', 'estorno']).optional()
});

const transferSchema = z.object({
  fromAccountId: z.number().int().positive(),
  toAccountId: z.number().int().positive(),
  amountCve: z.number().finite().positive(),
  movementDate: isoDate.optional(),
  reference: optionalText(80),
  notes: optionalText(240),
  allowNegative: z.boolean().optional()
});

const countSchema = z.object({
  accountId: z.number().int().positive(),
  countedCve: z.number().finite().min(0),
  movementDate: isoDate.optional(),
  reason: optionalText(240)
});

const reverseSchema = z.object({ reason: z.string().trim().max(240).optional().nullable() });

type UserRequest = { user?: { id?: number; role?: string } };

export async function registerTreasuryRoutes(app: FastifyInstance) {
  const canOperate = { preHandler: requireRole(['admin', 'operator']) };
  const adminOnly = { preHandler: requireRole(['admin']) };
  const userIdOf = (request: unknown) => (request as UserRequest).user?.id ?? null;

  app.get('/api/treasury/summary', canOperate, async () => treasurySummary(getSqliteDatabase()));

  app.get('/api/treasury/accounts', canOperate, async (request) => {
    const activeOnly = (request.query as { active?: string } | undefined)?.active === '1';
    return listAccounts(getSqliteDatabase(), { includeInactive: !activeOnly });
  });

  app.post('/api/treasury/accounts', adminOnly, async (request, reply) => {
    const parsed = createAccountSchema.safeParse(request.body || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Dados da conta invalidos' });

    const result = createAccount(getSqliteDatabase(), parsed.data, userIdOf(request));
    if (!result.ok) return reply.status(result.status).send({ error: result.error });

    recordAudit(request, {
      action: 'create',
      entityType: 'treasury_account',
      entityId: result.value.id,
      summary: `Criou a ${result.value.kind === 'caixa' ? 'caixa' : 'conta bancaria'} ${result.value.name}`,
      metadata: parsed.data
    });
    return reply.status(201).send(result.value);
  });

  app.patch('/api/treasury/accounts/:id', adminOnly, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = updateAccountSchema.safeParse(request.body || {});
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) return reply.status(400).send({ error: 'Dados da conta invalidos' });

    const db = getSqliteDatabase();
    const before = listAccounts(db).find((account) => account.id === id);
    const result = updateAccount(db, id, parsed.data);
    if (!result.ok) return reply.status(result.status).send({ error: result.error });

    recordAudit(request, {
      action: 'update',
      entityType: 'treasury_account',
      entityId: id,
      summary: `Atualizou a conta ${result.value.name}`,
      metadata: {
        changes: parsed.data,
        before: before && {
          openingBalanceCve: before.openingBalanceCve,
          openingDate: before.openingDate,
          active: before.active,
          isDefaultCash: before.isDefaultCash
        }
      }
    });
    return result.value;
  });

  app.get('/api/treasury/movements', canOperate, async (request, reply) => {
    const parsed = movementsQuerySchema.safeParse(request.query || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Filtros invalidos' });
    return listMovements(getSqliteDatabase(), parsed.data);
  });

  // Depósito (caixa → banco) e transferência entre contas usam a mesma porta:
  // o tipo decide-se pelas contas, não pelo operador.
  app.post('/api/treasury/transfers', canOperate, async (request, reply) => {
    const parsed = transferSchema.safeParse(request.body || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Dados da transferencia invalidos' });
    if (parsed.data.allowNegative && (request as UserRequest).user?.role !== 'admin' && (request as UserRequest).user) {
      return reply.status(403).send({ error: 'So um administrador pode deixar uma conta com saldo negativo.' });
    }

    const result = createTransfer(getSqliteDatabase(), { ...parsed.data, userId: userIdOf(request) });
    if (!result.ok) return reply.status(result.status).send({ error: result.error });

    const { kind, from, to, amountCve, transferGroup } = result.value;
    recordAudit(request, {
      action: kind,
      entityType: 'treasury_movement',
      entityId: transferGroup,
      summary: `${kind === 'deposito' ? 'Depositou' : 'Transferiu'} ${amountCve} de ${from.name} para ${to.name}`,
      metadata: { ...parsed.data, transferGroup }
    });
    return reply.status(201).send(result.value);
  });

  app.post('/api/treasury/counts', canOperate, async (request, reply) => {
    const parsed = countSchema.safeParse(request.body || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Dados da contagem invalidos' });

    const result = recordCashCount(getSqliteDatabase(), { ...parsed.data, userId: userIdOf(request) });
    if (!result.ok) return reply.status(result.status).send({ error: result.error });

    const { account, systemCve, countedCve, differenceCve, movementId } = result.value;
    recordAudit(request, {
      action: 'cash_count',
      entityType: 'treasury_account',
      entityId: account.id,
      summary: differenceCve === 0
        ? `Contou ${account.name}: bate com o sistema (${countedCve})`
        : `Contou ${account.name}: ${differenceCve > 0 ? 'sobra' : 'falta'} de ${Math.abs(differenceCve)}`,
      metadata: { systemCve, countedCve, differenceCve, movementId, reason: parsed.data.reason }
    });
    return result.value;
  });

  app.post('/api/treasury/movements/:id/reverse', adminOnly, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = reverseSchema.safeParse(request.body || {});
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) return reply.status(400).send({ error: 'Movimento invalido' });

    const result = reverseMovement(getSqliteDatabase(), id, parsed.data.reason, userIdOf(request));
    if (!result.ok) return reply.status(result.status).send({ error: result.error });

    recordAudit(request, {
      action: 'reverse',
      entityType: 'treasury_movement',
      entityId: id,
      summary: `Estornou ${result.value.reversed.map((m) => `${m.description} (${m.amountCve})`).join(' + ')}`,
      metadata: { reason: parsed.data.reason, movementIds: result.value.reversed.map((m) => m.id) }
    });
    return result.value;
  });
}
