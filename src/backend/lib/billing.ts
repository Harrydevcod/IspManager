import type { Database as DatabaseType } from 'better-sqlite3';
import { allocateDocumentNumber } from './numbering';
import { loadAudiovisualConfig } from './audiovisual';

export type BillingLine = {
  kind: 'internet' | 'audiovisual' | 'instalacao' | 'aluguer' | 'equipamento';
  description: string;
  amountCve: number;
};

/** Um equipamento instalado que o ISP aluga ao cliente. */
export type RentalLine = { assignmentId: number; label: string; amountCve: number };

export type BillingPreviewRow = {
  serviceId: number;
  clientId: number;
  clientName: string;
  planName: string | null;
  amountCve: number;
  dueDate: string;
  /** Composição da fatura (1+ linhas). O `amountCve` é a soma destas linhas. */
  lines: BillingLine[];
};

const INTERNET_LINE_DESCRIPTION = 'Servico de Internet';

/**
 * Composição mensal de um serviço: linha de internet (se houver mensalidade) +
 * linha audiovisual (se a modalidade for mensal) + uma linha por equipamento
 * alugado. A anuidade NÃO entra aqui — é faturada à parte. Fonte única usada
 * pela geração mensal e pela regeneração de uma mensalidade anulada, para que o
 * total nunca divirja entre os dois caminhos.
 *
 * O aluguer vem em linhas separadas, uma por equipamento, para o cliente ver
 * porque paga o que paga — e para a linha simplesmente desaparecer da fatura
 * seguinte no dia em que ele comprar o equipamento.
 *
 * Serviço **suspenso** perde o serviço mas não o equipamento: o corte tira-lhe a
 * internet e o audiovisual, o router do ISP continua em casa dele e continua a
 * ser cobrado. Ficam só as linhas de aluguer. Quando devolver, a atribuição
 * fecha, não sobra linha nenhuma e o total a zero impede a fatura de nascer.
 */
export function buildMonthlyServiceLines(
  svc: {
    monthlyValueCve: number;
    audiovisualMode: 'none' | 'monthly' | 'annual';
    audiovisualMonthlyCve: number;
    status?: 'active' | 'suspended' | 'cancelled';
  },
  audiovisualLabel: string,
  rentals: RentalLine[] = []
): BillingLine[] {
  const lines: BillingLine[] = [];
  const suspended = svc.status === 'suspended';
  if (!suspended && svc.monthlyValueCve > 0) {
    lines.push({ kind: 'internet', description: INTERNET_LINE_DESCRIPTION, amountCve: svc.monthlyValueCve });
  }
  if (!suspended && svc.audiovisualMode === 'monthly' && svc.audiovisualMonthlyCve > 0) {
    lines.push({ kind: 'audiovisual', description: audiovisualLabel, amountCve: svc.audiovisualMonthlyCve });
  }
  for (const rental of rentals) {
    if (rental.amountCve > 0) {
      lines.push({ kind: 'aluguer', description: `${RENTAL_LINE_PREFIX} ${rental.label}`, amountCve: rental.amountCve });
    }
  }
  return lines;
}

const RENTAL_LINE_PREFIX = 'Aluguer —';

/**
 * Equipamento que gera renda, por serviço.
 *
 * Três filtros, cada um com uma razão:
 *  - `end_date IS NULL` — já foi retirado, não se cobra.
 *  - `ownership = 'isp'` — é do cliente, não se cobra. É esta a linha que
 *    desaparece da fatura quando ele compra o equipamento.
 *  - `rental_fee_cve > 0` — material e equipamento sem renda não geram linhas
 *    de 0$ a sujar a fatura.
 *
 * A partilha (`service_device_shares`, migração 0030) resolve-se por omissão: a
 * query só olha para `service_device_assignments.service_id`, portanto quem
 * entra por partilha não é faturado — paga o titular da unidade física, uma vez.
 * Há um teste a fixar isto de propósito.
 */
export function loadServiceRentals(db: DatabaseType): Map<number, RentalLine[]> {
  const rows = db.prepare(`
    SELECT a.id AS assignmentId, a.service_id AS serviceId,
           a.rental_fee_cve AS amountCve,
           TRIM(COALESCE(ec.brand, '') || ' ' || ec.model) AS label
    FROM service_device_assignments a
    JOIN equipment_catalog ec ON ec.id = a.catalog_id
    WHERE a.end_date IS NULL
      AND a.ownership = 'isp'
      AND a.rental_fee_cve > 0
    ORDER BY a.service_id, a.id
  `).all() as Array<{ assignmentId: number; serviceId: number; amountCve: number; label: string }>;

  const byService = new Map<number, RentalLine[]>();
  for (const row of rows) {
    const list = byService.get(row.serviceId) ?? [];
    list.push({ assignmentId: row.assignmentId, label: row.label, amountCve: row.amountCve });
    byService.set(row.serviceId, list);
  }
  return byService;
}

export function sumLines(lines: BillingLine[]): number {
  return lines.reduce((total, line) => total + line.amountCve, 0);
}

/**
 * Chave de competência da fatura de instalação: fixa (não é `YYYY-MM` nem
 * `AV-...`), porque a instalação acontece uma única vez por serviço. Torna a
 * geração idempotente via o mesmo padrão de `UNIQUE(service_id, reference_month)`.
 */
export const INSTALLATION_FEE_REFERENCE = 'INSTALACAO';
const INSTALLATION_LINE_DESCRIPTION = 'Instalacao';

/**
 * Preço de instalação configurável (Configurações › Faturação), lido de
 * `app_settings`. É o valor por defeito usado quando o plano não define um
 * override próprio — para que mudar as condições comerciais seja uma edição
 * num único sítio, sem tocar em cada plano.
 */
export function loadInstallationFeeCve(db: DatabaseType): number {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'installationFeeCve'`)
    .get() as { value: string } | undefined;
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export type BillingPreview = {
  referenceMonth: string;
  activeServices: number;
  alreadyBilled: number;
  toCreate: BillingPreviewRow[];
  totalCve: number;
};

/**
 * Política fiscal: vencimento padrão = data de emissão + 30 dias (≈ um mês).
 * Mantemos a assinatura antiga (referenceMonth, dueDay) por compatibilidade
 * mas o cálculo passou a ser independente desses argumentos.
 */
export const PAYMENT_DUE_DAYS = 30;

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function dueDateFromIssue(issueIso: string, days: number = PAYMENT_DUE_DAYS): string {
  const issue = new Date(`${issueIso}T00:00:00Z`);
  if (Number.isNaN(issue.getTime())) return issueIso;
  issue.setUTCDate(issue.getUTCDate() + days);
  return issue.toISOString().slice(0, 10);
}

// kept for back-compat with callers that still pass the old signature
export function dueDateFor(_referenceMonth: string, _dueDay: number): string {
  return dueDateFromIssue(todayIso(), PAYMENT_DUE_DAYS);
}

/**
 * Read-only diff: what `generateMonthlyBilling` would create. Used by the
 * preview endpoint and by the actual generator. No writes.
 */
export function computeMonthlyBilling(db: DatabaseType, referenceMonth: string): BillingPreview {
  const audiovisual = loadAudiovisualConfig(db);
  // Uma leitura para todos os serviços, em vez de uma por serviço dentro do
  // ciclo: 26 serviços dariam 26 queries para responder à mesma pergunta.
  const rentalsByService = loadServiceRentals(db);
  const services = db.prepare(`
    SELECT
      s.id AS serviceId,
      s.client_id AS clientId,
      c.full_name AS clientName,
      p.name AS planName,
      s.monthly_value_cve AS monthlyValueCve,
      s.audiovisual_mode AS audiovisualMode,
      s.audiovisual_monthly_cve AS audiovisualMonthlyCve,
      s.due_day AS dueDay,
      s.status AS status
    FROM services s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
    -- Suspenso entra na corrida por causa do aluguer: quem ficou com o
    -- equipamento do ISP continua a pagá-lo. buildMonthlyServiceLines corta-lhe
    -- o plano e o audiovisual; se já devolveu tudo, o total dá 0 e não há fatura.
    WHERE s.status IN ('active', 'suspended')
      -- Regra de negócio: clientes cancelados não geram mensalidades, mesmo
      -- que um serviço tenha ficado 'active'. O cancelamento do cliente não
      -- propaga automaticamente para os serviços, por isso filtramos aqui.
      AND c.status != 'cancelled'
    ORDER BY c.full_name
  `).all() as Array<{
    serviceId: number;
    clientId: number;
    clientName: string;
    planName: string | null;
    monthlyValueCve: number;
    audiovisualMode: 'none' | 'monthly' | 'annual';
    audiovisualMonthlyCve: number;
    dueDay: number;
    status: 'active' | 'suspended';
  }>;

  // Só uma cobrança *não anulada* por serviço/mês bloqueia a geração. Uma
  // cobrança anulada deixa o slot livre para reemitir a fatura corrigida — o
  // registo anulado permanece (índice único parcial em payments permite-o).
  const existsStmt = db.prepare(`SELECT 1 AS hit FROM payments WHERE service_id = ? AND reference_month = ? AND status != 'cancelled'`);
  const toCreate: BillingPreviewRow[] = [];
  let alreadyBilled = 0;

  // Vencimento = data de emissão + 30 dias (todas as faturas geradas nesta corrida
  // partilham a mesma data de emissão, hoje).
  const issueIso = todayIso();
  const dueIso = dueDateFromIssue(issueIso, PAYMENT_DUE_DAYS);

  for (const svc of services) {
    const lines = buildMonthlyServiceLines(svc, audiovisual.label, rentalsByService.get(svc.serviceId) ?? []);
    const total = sumLines(lines);
    // Serviço sem valor mensal (ex.: standalone anual) não gera fatura mensal vazia.
    if (total <= 0) continue;

    const hit = existsStmt.get(svc.serviceId, referenceMonth) as { hit: number } | undefined;
    if (hit) {
      alreadyBilled += 1;
      continue;
    }
    toCreate.push({
      serviceId: svc.serviceId,
      clientId: svc.clientId,
      clientName: svc.clientName,
      planName: svc.planName,
      amountCve: total,
      dueDate: dueIso,
      lines
    });
  }

  const totalCve = toCreate.reduce((sum, item) => sum + item.amountCve, 0);
  return {
    referenceMonth,
    // Continua a contar só os ativos: os suspensos que entram na corrida entram
    // pelo aluguer, não são serviço ativo e não devem inflacionar o número.
    activeServices: services.filter((svc) => svc.status === 'active').length,
    alreadyBilled,
    toCreate,
    totalCve
  };
}

/**
 * Idempotent generator: inserts payments for `toCreate` items, assigns the
 * next invoice number for each. Returns the count created and the preview
 * snapshot that drove the inserts.
 */
export function generateMonthlyBilling(db: DatabaseType, referenceMonth: string): {
  referenceMonth: string;
  activeServices: number;
  created: number;
  preview: BillingPreview;
} {
  const preview = computeMonthlyBilling(db, referenceMonth);

  const insert = db.prepare(`
    INSERT INTO payments (
      client_id, service_id, reference_month, amount_cve, due_date,
      status, invoice_number, invoice_date, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'pending', NULL, date('now'), datetime('now'), datetime('now'))
  `);
  const updateInvoice = db.prepare('UPDATE payments SET invoice_number = ? WHERE id = ? AND invoice_number IS NULL');
  const insertLine = db.prepare(`
    INSERT INTO payment_lines (payment_id, kind, description, amount_cve, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);

  const run = db.transaction(() => {
    for (const item of preview.toCreate) {
      const inserted = insert.run(
        item.clientId,
        item.serviceId,
        referenceMonth,
        item.amountCve,
        item.dueDate
      );
      const paymentId = Number(inserted.lastInsertRowid);
      updateInvoice.run(allocateDocumentNumber('invoice'), paymentId);
      item.lines.forEach((line, index) => {
        insertLine.run(paymentId, line.kind, line.description, line.amountCve, index);
      });
    }
  });

  run();

  return {
    referenceMonth,
    activeServices: preview.activeServices,
    created: preview.toCreate.length,
    preview
  };
}

/**
 * Emite a fatura da taxa de instalação (preço do plano) no momento em que o
 * serviço é criado. Idempotente por `(service_id, INSTALLATION_FEE_REFERENCE)` —
 * chamar duas vezes para o mesmo serviço não duplica a cobrança. MUST run inside
 * the same transaction as a criação do serviço.
 */
export function insertInstallationFeeIfDue(
  db: DatabaseType,
  params: { serviceId: number; clientId: number; amountCve: number }
): { paymentId: number } | null {
  if (params.amountCve <= 0) return null;

  const exists = db.prepare(`
    SELECT 1 FROM payments WHERE service_id = ? AND reference_month = ? AND status != 'cancelled'
  `).get(params.serviceId, INSTALLATION_FEE_REFERENCE);
  if (exists) return null;

  const dueIso = dueDateFromIssue(todayIso());
  const inserted = db.prepare(`
    INSERT INTO payments (
      client_id, service_id, reference_month, amount_cve, due_date,
      status, invoice_number, invoice_date, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'pending', NULL, date('now'), datetime('now'), datetime('now'))
  `).run(params.clientId, params.serviceId, INSTALLATION_FEE_REFERENCE, params.amountCve, dueIso);
  const paymentId = Number(inserted.lastInsertRowid);

  db.prepare('UPDATE payments SET invoice_number = ? WHERE id = ? AND invoice_number IS NULL')
    .run(allocateDocumentNumber('invoice'), paymentId);
  db.prepare(`
    INSERT INTO payment_lines (payment_id, kind, description, amount_cve, sort_order)
    VALUES (?, 'instalacao', ?, ?, 0)
  `).run(paymentId, INSTALLATION_LINE_DESCRIPTION, params.amountCve);

  return { paymentId };
}

/**
 * Chave de competência da compra de equipamento: uma por **atribuição**, não uma
 * constante por serviço como a instalação. A instalação acontece uma vez na vida
 * do serviço; a compra de equipamento pode acontecer várias vezes — o cliente
 * compra o router este mês e a antena para o ano. A chave por atribuição mantém
 * a idempotência que o índice `(service_id, reference_month)` garante, sem
 * bloquear a segunda compra.
 */
export function equipmentPurchaseReference(assignmentId: number): string {
  return `EQUIP-${assignmentId}`;
}

export type EquipmentPurchaseInput = {
  assignmentId: number;
  serviceId: number;
  clientId: number;
  amountCve: number;
  label: string;
};

/**
 * O cliente compra o equipamento que tinha alugado.
 *
 * Emite a cobrança única e vira a propriedade no mesmo passo — não são dois
 * atos, é um: o que faz o aluguer parar é a compra estar registada. A partir da
 * fatura seguinte a linha de aluguer deixa de existir; a mensalidade deste mês,
 * se já foi emitida, não se toca (documento numerado não se altera).
 *
 * MUST correr dentro de uma transação do chamador.
 */
export function insertEquipmentPurchase(
  db: DatabaseType,
  input: EquipmentPurchaseInput
): { paymentId: number | null; alreadyOwned: boolean } {
  const current = db.prepare(`
    SELECT ownership FROM service_device_assignments WHERE id = ?
  `).get(input.assignmentId) as { ownership: string } | undefined;
  if (current?.ownership === 'cliente') return { paymentId: null, alreadyOwned: true };

  const reference = equipmentPurchaseReference(input.assignmentId);
  const exists = db.prepare(`
    SELECT 1 FROM payments WHERE service_id = ? AND reference_month = ? AND status != 'cancelled'
  `).get(input.serviceId, reference);

  let paymentId: number | null = null;
  // Preço a zero é legítimo: equipamento oferecido ao fim de anos de contrato,
  // ou já pago por fora. Vira a propriedade na mesma, sem emitir fatura de 0$.
  if (!exists && input.amountCve > 0) {
    const inserted = db.prepare(`
      INSERT INTO payments (
        client_id, service_id, reference_month, amount_cve, due_date,
        status, invoice_number, invoice_date, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, date('now'), datetime('now'), datetime('now'))
    `).run(input.clientId, input.serviceId, reference, input.amountCve, dueDateFromIssue(todayIso()));
    paymentId = Number(inserted.lastInsertRowid);

    db.prepare('UPDATE payments SET invoice_number = ? WHERE id = ? AND invoice_number IS NULL')
      .run(allocateDocumentNumber('invoice'), paymentId);
    db.prepare(`
      INSERT INTO payment_lines (payment_id, kind, description, amount_cve, sort_order)
      VALUES (?, 'equipamento', ?, ?, 0)
    `).run(paymentId, `Compra de equipamento — ${input.label}`, input.amountCve);
  }

  db.prepare(`
    UPDATE service_device_assignments
    SET ownership = 'cliente', owned_since = date('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(input.assignmentId);

  return { paymentId, alreadyOwned: false };
}
