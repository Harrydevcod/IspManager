import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import {
  insertInstallCostsWithinTx,
  installItemsWithinTx,
  mapInstallError,
  preflightItems,
  type InstallCostInput,
  type ServiceItemInput
} from './serviceInstall';
import { insertInstallationFeeIfDue, loadInstallationFeeCve } from './billing';
import { ownedSharedAssignments } from './deviceShares';

const serviceItemSchema = z.object({
  catalogId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().optional().nullable(),
  serialNumber: z.string().trim().optional().nullable(),
  assetTag: z.string().trim().optional().nullable(),
  ipAddress: z.string().trim().optional().nullable(),
  macAddress: z.string().trim().optional().nullable(),
  technicianId: z.coerce.number().int().positive().optional().nullable(),
  notes: z.string().trim().optional().nullable()
});

const installCostSchema = z.object({
  kind: z.enum(['mao_de_obra', 'transporte', 'outro']).default('mao_de_obra'),
  description: z.string().trim().optional().nullable(),
  amountCve: z.coerce.number().min(0)
});

export const serviceSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  planId: z.coerce.number().int().positive().optional().nullable(),
  monthlyValueCve: z.coerce.number().min(0),
  dueDay: z.coerce.number().int().min(1).max(31).default(1),
  activationDate: z.string().optional().nullable(),
  status: z.enum(['active', 'suspended', 'cancelled']).default('active'),
  technicalNotes: z.string().trim().optional().nullable(),
  audiovisualMode: z.enum(['none', 'monthly', 'annual']).optional().default('none'),
  audiovisualMonthlyCve: z.coerce.number().min(0).optional().default(0),
  audiovisualAnnualCve: z.coerce.number().min(0).optional().default(0),
  items: z.array(serviceItemSchema).optional().nullable(),
  installCosts: z.array(installCostSchema).optional().nullable(),
  // Identidade do cliente no router (ADR 0007). Vazio = serviço fora do
  // controlo de acesso; a reconciliação ignora-o por completo.
  pppoeUsername: z.string().trim().max(64).optional().nullable(),
  pppoePassword: z.string().trim().max(64).optional().nullable()
});

export type ServiceInput = z.infer<typeof serviceSchema>;

/**
 * Credenciais PPPoE de um serviço novo. Nascem só na base de dados: o secret no
 * router é criado depois pela reconciliação (ADR 0007), para não haver uma
 * chamada de rede dentro de uma transação SQL.
 */
export function pppoeUsernameFor(clientName: string, serviceId: number): string {
  const slug = clientName
    .normalize('NFD')
    // Tira acentos: "João" tem de dar "joao-12", não "joa-o-12".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
    .replace(/-$/, '');
  return `${slug || 'cliente'}-${serviceId}`;
}

export function generatePppoePassword(): string {
  return randomBytes(9).toString('base64url');
}

/** Verdadeiro quando o controlo de acesso no MikroTik está ligado nas definições. */
function routerIntegrationOn(db: Database): boolean {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'routerosEnabled'`).get() as
    | { value: string }
    | undefined;
  return row?.value?.trim() === 'true';
}

export type ServiceOpResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/**
 * Regras do add-on audiovisual: a modalidade ativa exige o respetivo preço > 0; e
 * um serviço não pode ficar vazio (sem mensalidade de internet nem audiovisual),
 * caso contrário não geraria qualquer fatura. Devolve a mensagem de erro ou null.
 */
function validateServicePayload(data: {
  monthlyValueCve: number;
  audiovisualMode: 'none' | 'monthly' | 'annual';
  audiovisualMonthlyCve: number;
  audiovisualAnnualCve: number;
}): string | null {
  if (data.audiovisualMode === 'monthly' && data.audiovisualMonthlyCve <= 0) {
    return 'Valor mensal de conteúdos audiovisuais deve ser superior a zero';
  }
  if (data.audiovisualMode === 'annual' && data.audiovisualAnnualCve <= 0) {
    return 'Valor anual de conteúdos audiovisuais deve ser superior a zero';
  }
  const hasMonthlyCharge = data.monthlyValueCve > 0 || (data.audiovisualMode === 'monthly' && data.audiovisualMonthlyCve > 0);
  const hasAnnualCharge = data.audiovisualMode === 'annual' && data.audiovisualAnnualCve > 0;
  if (!hasMonthlyCharge && !hasAnnualCharge) {
    return 'Serviço sem valor: defina a mensalidade ou ative os conteúdos audiovisuais';
  }
  return null;
}

export function createService(db: Database, data: ServiceInput, userId: number | null): ServiceOpResult<{
  serviceId: number;
  install: ReturnType<typeof installItemsWithinTx> | null;
  costs: ReturnType<typeof insertInstallCostsWithinTx> | null;
  installationFee: ReturnType<typeof insertInstallationFeeIfDue>;
  installedItems: number;
}> {
  const validationError = validateServicePayload(data);
  if (validationError) {
    return { ok: false, status: 400, error: validationError };
  }

  const client = db.prepare('SELECT id, full_name AS fullName FROM clients WHERE id = ?')
    .get(data.clientId) as { id: number; fullName: string } | undefined;
  if (!client) {
    return { ok: false, status: 404, error: 'Cliente nao encontrado' };
  }

  // Preço de instalação: o override do plano (se > 0) tem precedência sobre o
  // valor global das Configurações; assim mudar condições comerciais é uma
  // edição única, mas um plano pode ter um preço específico.
  let planInstallationFeeOverride = 0;
  if (data.planId) {
    const plan = db.prepare('SELECT id, installation_fee_cve AS installationFeeCve FROM internet_plans WHERE id = ?')
      .get(data.planId) as { id: number; installationFeeCve: number } | undefined;
    if (!plan) {
      return { ok: false, status: 404, error: 'Plano nao encontrado' };
    }
    planInstallationFeeOverride = plan.installationFeeCve;
  }
  const installationFeeCve = planInstallationFeeOverride > 0
    ? planInstallationFeeOverride
    : loadInstallationFeeCve(db);

  const items = (data.items ?? []) as ServiceItemInput[];
  if (items.length > 0) {
    const preflight = preflightItems(db, items);
    if (!preflight.ok) {
      return { ok: false, status: preflight.status, error: preflight.error };
    }
  }
  const installCosts = (data.installCosts ?? []) as InstallCostInput[];

  const run = db.transaction(() => {
    const inserted = db.prepare(`
      INSERT INTO services (
        client_id, plan_id, monthly_value_cve, activation_date, due_day,
        status, technical_notes, audiovisual_mode, audiovisual_monthly_cve,
        audiovisual_annual_cve, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      data.clientId,
      data.planId || null,
      data.monthlyValueCve,
      data.activationDate || null,
      data.dueDay,
      data.status,
      data.technicalNotes || null,
      data.audiovisualMode,
      data.audiovisualMonthlyCve,
      data.audiovisualAnnualCve
    );
    const serviceId = Number(inserted.lastInsertRowid);

    // Com o router ligado, um serviço novo já nasce com identidade na rede. Sem
    // router, não se inventam credenciais que ninguém vai usar.
    const wantsPppoe = data.pppoeUsername?.trim() || routerIntegrationOn(db);
    if (wantsPppoe) {
      db.prepare('UPDATE services SET pppoe_username = ?, pppoe_password = ? WHERE id = ?').run(
        data.pppoeUsername?.trim() || pppoeUsernameFor(client.fullName, serviceId),
        data.pppoePassword?.trim() || generatePppoePassword(),
        serviceId
      );
    }

    const install = items.length > 0
      ? installItemsWithinTx(db, { serviceId, clientName: client.fullName, items, userId })
      : null;

    const costs = installCosts.length > 0
      ? insertInstallCostsWithinTx(db, { serviceId, costs: installCosts, userId })
      : null;

    const installationFee = data.status !== 'cancelled'
      ? insertInstallationFeeIfDue(db, { serviceId, clientId: data.clientId, amountCve: installationFeeCve })
      : null;

    return { serviceId, install, costs, installationFee };
  });

  try {
    const created = run();
    return { ok: true, value: { ...created, installedItems: items.length } };
  } catch (error) {
    const mapped = mapInstallError(error);
    if (mapped) {
      return { ok: false, status: mapped.status, error: mapped.error };
    }
    throw error;
  }
}

export type ServiceStatus = 'active' | 'suspended' | 'cancelled';

export type ServiceStatusChange = {
  changed: boolean;
  previous: ServiceStatus;
  next: ServiceStatus;
};

const STATUS_EVENT: Record<ServiceStatus, 'reativacao' | 'suspensao' | 'cancelamento'> = {
  active: 'reativacao',
  suspended: 'suspensao',
  cancelled: 'cancelamento'
};

/**
 * O único sítio por onde o estado de um serviço muda.
 *
 * Antes o estado era mais um campo do formulário e a cascata do cliente era um
 * UPDATE à parte: um serviço passava a suspenso sem data, sem motivo e sem
 * aparecer na história do cliente. Aqui a mudança fica registada em
 * `service_events`, com o motivo.
 *
 * É também a costura onde entra o dia em que houver um router com API: um
 * controlo de acesso na rede reage a esta transição, e não a cada chamador
 * (ver `docs/adr/0007-controlo-de-acesso-na-rede.md`). Enquanto não houver
 * router, cortar continua a ser trabalho de campo — mas a intenção fica escrita.
 */
export function changeServiceStatus(
  db: Database,
  id: number,
  next: ServiceStatus,
  options: { reason?: string | null; actorId?: number | null } = {}
): ServiceOpResult<ServiceStatusChange> {
  const row = db.prepare('SELECT status FROM services WHERE id = ?').get(id) as { status: ServiceStatus } | undefined;
  if (!row) {
    return { ok: false, status: 404, error: 'Servico nao encontrado' };
  }
  if (row.status === next) {
    return { ok: true, value: { changed: false, previous: row.status, next } };
  }

  db.prepare(`UPDATE services SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(next, id);
  db.prepare(`
    INSERT INTO service_events (service_id, event_type, notes, created_by)
    VALUES (?, ?, ?, ?)
  `).run(id, STATUS_EVENT[next], options.reason?.trim() || null, options.actorId ?? null);

  return { ok: true, value: { changed: true, previous: row.status, next } };
}

export function updateService(db: Database, id: number, data: ServiceInput): ServiceOpResult<void> {
  const validationError = validateServicePayload(data);
  if (validationError) {
    return { ok: false, status: 400, error: validationError };
  }

  const service = db.prepare('SELECT id FROM services WHERE id = ?').get(id);
  if (!service) {
    return { ok: false, status: 404, error: 'Servico nao encontrado' };
  }

  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(data.clientId);
  if (!client) {
    return { ok: false, status: 404, error: 'Cliente nao encontrado' };
  }

  if (data.planId) {
    const plan = db.prepare('SELECT id FROM internet_plans WHERE id = ?').get(data.planId);
    if (!plan) {
      return { ok: false, status: 404, error: 'Plano nao encontrado' };
    }
  }

  // O estado sai deste UPDATE: passa por `changeServiceStatus`, que o regista.
  db.prepare(`
    UPDATE services
    SET client_id = ?,
        plan_id = ?,
        monthly_value_cve = ?,
        activation_date = ?,
        due_day = ?,
        technical_notes = ?,
        audiovisual_mode = ?,
        audiovisual_monthly_cve = ?,
        audiovisual_annual_cve = ?,
        pppoe_username = ?,
        pppoe_password = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    data.clientId,
    data.planId || null,
    data.monthlyValueCve,
    data.activationDate || null,
    data.dueDay,
    data.technicalNotes || null,
    data.audiovisualMode,
    data.audiovisualMonthlyCve,
    data.audiovisualAnnualCve,
    data.pppoeUsername?.trim() || null,
    data.pppoePassword?.trim() || null,
    id
  );

  const statusResult = changeServiceStatus(db, id, data.status, { reason: 'Alteração no formulário do serviço' });
  if (!statusResult.ok) {
    return statusResult;
  }

  return { ok: true, value: undefined };
}

/**
 * Apagar um serviço criado por engano. Regra fiscal absoluta: um serviço que já
 * emitiu faturas (payments) NÃO pode ser apagado — a numeração sequencial e os
 * documentos fiscais têm de permanecer (usar cancelamento). Sem faturas, é seguro
 * reverter por completo a criação: devolve o stock dos equipamentos/materiais e
 * remove os filhos operacionais (child-first, foreign_keys ON).
 */
export function deleteService(db: Database, id: number): ServiceOpResult<{
  clientName: string;
  restoredStock: Array<{ catalogId: number; delta: number }>;
}> {
  const service = db.prepare(`
    SELECT s.id, c.full_name AS clientName
    FROM services s
    JOIN clients c ON c.id = s.client_id
    WHERE s.id = ?
  `).get(id) as { id: number; clientName: string } | undefined;
  if (!service) {
    return { ok: false, status: 404, error: 'Servico nao encontrado' };
  }

  // Pegada fiscal: qualquer payment (mesmo anulada) bloqueia o delete.
  const billed = db.prepare('SELECT COUNT(*) AS total FROM payments WHERE service_id = ?').get(id) as { total: number };
  if (billed.total > 0) {
    return { ok: false, status: 409, error: 'Este servico ja tem faturas emitidas. Cancele o servico em vez de o apagar.' };
  }

  // Apagar o titular de uma antena partilhada deixaria os outros clientes sem
  // equipamento e sem sinal na UI. O operador desassocia-os primeiro.
  const sharedOwned = ownedSharedAssignments(db, id);
  if (sharedOwned.length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'Este servico e titular de equipamento partilhado com outros servicos. Remova as partilhas primeiro.'
    };
  }

  // Stock líquido a repor por catálogo: Σ(saida) − Σ(devolucao) deste serviço.
  const restoreStock = db.prepare(`
    SELECT catalog_id AS catalogId,
           SUM(CASE WHEN type = 'saida' THEN quantity
                    WHEN type = 'devolucao' THEN -quantity
                    ELSE 0 END) AS delta
    FROM stock_movements
    WHERE service_id = ? AND catalog_id IS NOT NULL
    GROUP BY catalog_id
  `).all(id) as Array<{ catalogId: number; delta: number }>;

  db.transaction(() => {
    for (const row of restoreStock) {
      if (row.delta && row.delta !== 0) {
        db.prepare(`
          UPDATE equipment_catalog
          SET stock_total = stock_total + ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(row.delta, row.catalogId);
      }
    }
    db.prepare('DELETE FROM stock_movements WHERE service_id = ?').run(id);
    db.prepare('UPDATE work_orders SET service_id = NULL WHERE service_id = ?').run(id);
    db.prepare('UPDATE sms_outbox SET service_id = NULL WHERE service_id = ?').run(id);
    db.prepare('DELETE FROM service_install_costs WHERE service_id = ?').run(id);
    db.prepare('DELETE FROM service_material_lines WHERE service_id = ?').run(id);
    db.prepare('DELETE FROM service_events WHERE service_id = ?').run(id);
    // Child-first: partilhas antes das atribuições, sem depender do ON DELETE CASCADE.
    db.prepare('DELETE FROM service_device_shares WHERE service_id = ?').run(id);
    db.prepare('DELETE FROM service_device_assignments WHERE service_id = ?').run(id);
    db.prepare('DELETE FROM services WHERE id = ?').run(id);
  })();

  return { ok: true, value: { clientName: service.clientName, restoredStock: restoreStock } };
}
