import { isSystemClient, SYSTEM_CLIENT_ERROR } from './system-client';
/**
 * Stripe como mais uma via de pagamento de uma fatura do ISPM (ADR 0016).
 *
 * O Stripe não fatura nem corta ninguém: recebe. Um pagamento visto aqui entra
 * por `payPayment`, a mesma porta do numerário e da transferência, e é ela que
 * escreve o recibo, a tesouraria e a reativação do serviço. A reconciliação
 * (ADR 0007) continua a ser a única camada que escreve no router.
 *
 * Não há webhook: o ISPM corre num PC sem endereço público, por isso é ele que
 * pergunta ao Stripe pelo estado de cada link aberto.
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { centavosToEscudos, escudosToCentavos, isSettled, roundEscudos } from '../../shared/money';
import { balanceSqlExpr, payPayment, receivedTotal, voidReceipt } from './payments';
import { readSecret } from './secrets';
import { requestNetworkSync } from './network-sync';
import { getAccount, syncSourceMovement } from './treasury';
import { createStripeTransport, type StripePaymentInfo, type StripeRefund, type StripeTransport } from './stripe';

export type StripeConfig = {
  enabled: boolean;
  /** Ligado e com tudo o que precisa para cobrar. */
  ready: boolean;
  secretKey: string;
  accountId: number | null;
  currency: string;
};

export type StripeLinkStatus = 'creating' | 'open' | 'paid' | 'void' | 'review' | 'refunded' | 'refund_pending';

export type StripeLink = {
  id: number;
  paymentId: number;
  stripeInvoiceId: string | null;
  url: string | null;
  amountCve: number;
  status: StripeLinkStatus;
  receiptId: number | null;
  refundId: string | null;
  note: string | null;
  createdAt: string;
};

export type StripeOpResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const linkSelect = `
  SELECT id, payment_id AS paymentId, stripe_invoice_id AS stripeInvoiceId, url,
         amount_cve AS amountCve, status, receipt_id AS receiptId, refund_id AS refundId, note, created_at AS createdAt
  FROM stripe_payment_links
`;

// A chamada remota cede o event loop; criacao, sweep e reembolso da mesma
// fatura precisam observar as escritas finais da operacao anterior.
const paymentOperations = new WeakMap<Database.Database, Map<number, Promise<unknown>>>();
async function serializePayment<T>(db: Database.Database, paymentId: number, operation: () => Promise<T>): Promise<T> {
  let operations = paymentOperations.get(db);
  if (!operations) { operations = new Map(); paymentOperations.set(db, operations); }
  const previous = operations.get(paymentId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  operations.set(paymentId, current);
  try { return await current; }
  finally { if (operations.get(paymentId) === current) operations.delete(paymentId); }
}

function setting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() ?? '';
}

export function readStripeConfig(db: Database.Database): StripeConfig {
  const enabled = setting(db, 'stripeEnabled') === 'true';
  const secretKey = readSecret(db, 'stripeSecretKey');
  const accountId = Number(setting(db, 'stripeTreasuryAccountId')) || null;
  const account = accountId ? getAccount(db, accountId) : undefined;
  return {
    enabled,
    ready: enabled && secretKey !== '' && Boolean(account?.active),
    secretKey,
    accountId,
    // Cobra-se na moeda das faturas, nunca noutra: 1.500 CVE não são 1.500 EUR.
    // ponytail: assume moeda de duas casas (CVE, EUR, USD); uma moeda sem
    // centavos no Stripe (JPY, XOF) pede um mapa de expoentes aqui.
    currency: (setting(db, 'currencyCode') || 'CVE').toLowerCase()
  };
}

function setLinkStatus(db: Database.Database, id: number, status: StripeLinkStatus, note: string | null = null): void {
  db.prepare(`
    UPDATE stripe_payment_links
    SET status = ?, note = COALESCE(?, note), updated_at = datetime('now')
    WHERE id = ?
  `).run(status, note, id);
}

function systemAudit(db: Database.Database, action: string, paymentId: number, summary: string): void {
  try {
    db.prepare(`
      INSERT INTO audit_logs (
        actor_user_id, actor_username, actor_role, action, entity_type, entity_id, summary
      )
      VALUES (NULL, 'sistema', NULL, ?, 'payment', ?, ?)
    `).run(action, String(paymentId), summary);
  } catch {
    // A auditoria não pode fazer falhar a operação de domínio.
  }
}

type PayableHead = {
  id: number;
  clientId: number;
  serviceId: number | null;
  status: string;
  amountCve: number;
  invoiceNumber: string | null;
  referenceMonth: string;
};

/** A fatura e quanto falta receber dela; `balanceCve` 0 quando já não há nada a cobrar. */
function loadPayable(db: Database.Database, paymentId: number): (PayableHead & { balanceCve: number }) | undefined {
  const head = db.prepare(`
    SELECT id, client_id AS clientId, service_id AS serviceId, status, amount_cve AS amountCve,
           invoice_number AS invoiceNumber, reference_month AS referenceMonth
    FROM payments WHERE id = ?
  `).get(paymentId) as PayableHead | undefined;
  if (!head) return undefined;
  const balance = roundEscudos(head.amountCve - receivedTotal(db, paymentId));
  return { ...head, balanceCve: head.status === 'cancelled' || isSettled(balance) ? 0 : balance };
}

function sameAmount(a: number, b: number): boolean {
  return escudosToCentavos(a) === escudosToCentavos(b);
}

/**
 * O link a pôr num aviso, em SQL: o URL do link aberto cujo valor ainda é o
 * saldo da fatura, ou NULL. Um link de valor antigo cobrava o montante errado,
 * por isso não se manda. Só lê a base: os avisos não falam com o Stripe.
 */
export function openStripeLinkSql(alias: string): string {
  return `(SELECT l.url FROM stripe_payment_links l`
    + ` WHERE l.payment_id = ${alias}.id AND l.status = 'open'`
    + ` AND ABS(l.amount_cve - ${balanceSqlExpr(alias)}) < 0.005)`;
}

/** Recibos desta fatura que entraram por Stripe e ainda se podem reembolsar. */
export function refundableReceiptIds(db: Database.Database, paymentId: number): number[] {
  const rows = db.prepare(`
    SELECT receipt_id AS id FROM stripe_payment_links
    WHERE payment_id = ? AND status = 'paid' AND receipt_id IS NOT NULL
  `).all(paymentId) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/** Todos os recibos ligados ao Stripe, incluindo os que exigem revisao. */
export function stripeReceiptIds(db: Database.Database, paymentId: number): number[] {
  const rows = db.prepare(`SELECT receipt_id AS id FROM stripe_payment_links
    WHERE payment_id = ? AND receipt_id IS NOT NULL`).all(paymentId) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/** O link mais recente de uma fatura, para a ficha dela. */
export function latestStripeLink(db: Database.Database, paymentId: number): StripeLink | null {
  return (db.prepare(`${linkSelect} WHERE payment_id = ? ORDER BY id DESC LIMIT 1`).get(paymentId) as StripeLink | undefined) ?? null;
}

/** Guarda a prova antes de eliminar: a confirmação sobrevive ao processo. */
function cancelRemoteInvoice(db: Database.Database, stripe: StripeTransport, linkId: number, invoiceId: string) {
  const proof = db.prepare(`SELECT draft_cancel_key_hash AS keyHash FROM stripe_payment_links
    WHERE id = ? AND stripe_invoice_id = ?`).get(linkId, invoiceId) as { keyHash: string | null } | undefined;
  return stripe.voidInvoice(invoiceId, {
    draftKeyHash: proof?.keyHash,
    onDraftCancelling: (keyHash) => {
      const saved = db.prepare(`UPDATE stripe_payment_links SET draft_cancel_key_hash = ?
        WHERE id = ? AND stripe_invoice_id = ?`).run(keyHash, linkId, invoiceId);
      if (saved.changes !== 1) throw new Error('O rascunho Stripe mudou antes do cancelamento');
    }
  });
}

/**
 * O Customer nasce na primeira fatura por Stripe, não no registo do cliente:
 * criar um cliente tem de funcionar sem Internet, como o secret PPPoE nasce na
 * reconciliação e não dentro da escrita local.
 */
async function ensureCustomer(db: Database.Database, transport: StripeTransport, clientId: number, pppoeUsername: string | null): Promise<StripeOpResult<string>> {
  const client = db.prepare(`
    SELECT full_name AS name, email, phone, client_code AS code, stripe_customer_id AS stripeCustomerId
    FROM clients WHERE id = ?
  `).get(clientId) as { name: string; email: string | null; phone: string | null; code: string; stripeCustomerId: string | null } | undefined;
  if (!client) return { ok: false, status: 404, error: 'Cliente nao encontrado' };
  if (client.stripeCustomerId) {
    const existing = await transport.getCustomer(client.stripeCustomerId);
    if (!existing.ok) return { ok: false, status: 502, error: existing.reason };
    if (existing.value) return { ok: true, value: existing.value.id };
  }

  // Uma eliminacao nao pode repetir a criacao original ainda em cache.
  // O transporte inclui tambem a credencial atual na chave de idempotencia.
  const created = await transport.createCustomer({
    name: client.name,
    email: client.email?.trim() || null,
    phone: client.phone,
    metadata: { ispmClientId: String(clientId), ispmClientCode: client.code, ...(pppoeUsername ? { pppoeUsername } : {}) }
  }, `ispm-customer-${clientId}-${client.stripeCustomerId || 'new'}`);
  if (!created.ok) return { ok: false, status: 502, error: created.reason };

  db.prepare(`UPDATE clients SET stripe_customer_id = ?, updated_at = datetime('now') WHERE id = ?`).run(created.value.id, clientId);
  return { ok: true, value: created.value.id };
}

/**
 * Devolve o link de pagamento de uma fatura, criando-o se for preciso.
 *
 * A linha local nasce antes da chamada ao Stripe e o id dela é a chave de
 * idempotência: uma queda a meio repete o mesmo pedido em vez de criar uma
 * segunda fatura no Stripe para a mesma dívida.
 */
export async function ensurePaymentLink(
  db: Database.Database,
  paymentId: number,
  transport?: StripeTransport
): Promise<StripeOpResult<StripeLink>> {
  return serializePayment(db, paymentId, () => createPaymentLink(db, paymentId, transport));
}

async function createPaymentLink(db: Database.Database, paymentId: number, transport?: StripeTransport): Promise<StripeOpResult<StripeLink>> {
  const config = readStripeConfig(db);
  if (!config.enabled) return { ok: false, status: 409, error: 'Pagamentos por Stripe desligados nas Configuracoes' };
  if (!config.ready) return { ok: false, status: 409, error: 'Stripe por configurar: falta a chave ou a conta de destino' };
  const stripe = transport ?? createStripeTransport(config.secretKey);

  const payable = loadPayable(db, paymentId);
  if (!payable) return { ok: false, status: 404, error: 'Pagamento nao encontrado' };
  if (isSystemClient(db, payable.clientId)) return { ok: false, status: 409, error: SYSTEM_CLIENT_ERROR };
  const document = db.prepare('SELECT document_type AS documentType FROM payments WHERE id = ?').get(paymentId) as { documentType: string };
  if (document.documentType === 'sale_ticket') return { ok: false, status: 409, error: 'Taloes de venda nao admitem cobranca Stripe' };
  if (payable.balanceCve <= 0) return { ok: false, status: 400, error: 'Esta fatura ja nao tem saldo a cobrar' };

  let live = db.prepare(`${linkSelect} WHERE payment_id = ? AND status IN ('creating', 'open')`).get(paymentId) as StripeLink | undefined;
  if (live?.status === 'open' && sameAmount(live.amountCve, payable.balanceCve)) {
    return { ok: true, value: live };
  }
  const contact = db.prepare('SELECT email FROM clients WHERE id = ?').get(payable.clientId) as { email: string | null } | undefined;
  if (!contact) return { ok: false, status: 404, error: 'Cliente nao encontrado' };
  // send_invoice exige email mesmo quando o link e enviado por WhatsApp.
  // Recusa antes de criar um Customer ou uma tentativa remota que fique em cache.
  if (!z.string().email().safeParse(contact.email?.trim()).success) {
    return { ok: false, status: 400, error: 'Preencha um e-mail valido na ficha do cliente para gerar o link Stripe.' };
  }
  // O saldo mudou (um recibo parcial entrou): o link antigo cobrava o valor errado.
  if (live && !sameAmount(live.amountCve, payable.balanceCve)) {
    if (live.stripeInvoiceId) {
      const voided = await cancelRemoteInvoice(db, stripe, live.id, live.stripeInvoiceId);
      if (!voided.ok) return { ok: false, status: 502, error: voided.reason };
    }
    setLinkStatus(db, live.id, 'void', 'Saldo da fatura mudou');
    live = undefined;
  }

  let linkId = live?.id;
  if (!linkId) {
    try {
      linkId = Number(db.prepare('INSERT INTO stripe_payment_links (payment_id, amount_cve) VALUES (?, ?)')
        .run(paymentId, payable.balanceCve).lastInsertRowid);
    } catch {
      // O índice único recusou: outro pedido está a criar este mesmo link.
      return { ok: false, status: 409, error: 'O link desta fatura ja esta a ser criado' };
    }
  }

  // Fatura manual sem serviço: não há PPPoE para pôr no metadata.
  const service = payable.serviceId === null ? undefined
    : db.prepare('SELECT pppoe_username AS username FROM services WHERE id = ?').get(payable.serviceId) as { username: string | null } | undefined;
  const pppoeUsername = service?.username?.trim() || null;

  const customer = await ensureCustomer(db, stripe, payable.clientId, pppoeUsername);
  if (!customer.ok) return customer;

  const currentPayable = loadPayable(db, paymentId);
  const currentLink = db.prepare(`${linkSelect} WHERE id = ?`).get(linkId) as StripeLink | undefined;
  if (!currentPayable || currentPayable.balanceCve <= 0 || !sameAmount(currentPayable.balanceCve, payable.balanceCve) || currentLink?.status !== 'creating') {
    // Um draft conhecido deve continuar localmente visivel ate a compensacao.
    if (currentLink?.stripeInvoiceId) {
      const voided = await cancelRemoteInvoice(db, stripe, linkId, currentLink.stripeInvoiceId);
      if (!voided.ok) return { ok: false, status: 502, error: voided.reason };
    }
    setLinkStatus(db, linkId, 'void', 'Saldo ou estado mudou durante a criacao');
    return { ok: false, status: 409, error: 'O saldo da fatura mudou durante a criacao. Peça um novo link.' };
  }

  const label = payable.invoiceNumber || payable.referenceMonth;
  const created = await stripe.createInvoice({
    ...(currentLink.stripeInvoiceId ? { invoiceId: currentLink.stripeInvoiceId } : {}),
    customerId: customer.value,
    amountMinor: escudosToCentavos(payable.balanceCve),
    currency: config.currency,
    description: `Fatura ${label}`,
    metadata: {
      ispmPaymentId: String(paymentId),
      ispmClientId: String(payable.clientId),
      ...(payable.serviceId === null ? {} : { ispmServiceId: String(payable.serviceId) }),
      ...(payable.invoiceNumber ? { invoiceNumber: payable.invoiceNumber } : {}),
      ...(pppoeUsername ? { pppoeUsername } : {})
    }
  }, `ispm-link-${linkId}`, (invoiceId) => {
    db.prepare(`UPDATE stripe_payment_links SET
      draft_cancel_key_hash = CASE WHEN stripe_invoice_id = ? THEN draft_cancel_key_hash ELSE NULL END,
      stripe_invoice_id = ?, updated_at = datetime('now') WHERE id = ?`).run(invoiceId, invoiceId, linkId);
  });
  // A linha fica `creating`: o próximo pedido repete com a mesma chave.
  if (!created.ok) return { ok: false, status: 502, error: created.reason };
  const latestPayable = loadPayable(db, paymentId);
  const latestLink = db.prepare(`${linkSelect} WHERE id = ?`).get(linkId) as StripeLink | undefined;
  if (!latestPayable || latestPayable.balanceCve <= 0 || !sameAmount(latestPayable.balanceCve, payable.balanceCve) || latestLink?.status !== 'creating') {
    const voided = await cancelRemoteInvoice(db, stripe, linkId, created.value.id);
    if (!voided.ok) return { ok: false, status: 502, error: voided.reason };
    setLinkStatus(db, linkId, 'void', 'Saldo ou estado mudou durante a criacao');
    return { ok: false, status: 409, error: 'O saldo da fatura mudou durante a criacao. Peça um novo link.' };
  }
  if (!created.value.url) return { ok: false, status: 502, error: 'Stripe nao devolveu a pagina de pagamento' };

  db.prepare(`
    UPDATE stripe_payment_links
    SET stripe_invoice_id = ?, url = ?, status = 'open', draft_cancel_key_hash = NULL, updated_at = datetime('now')
    WHERE id = ? AND status = 'creating'
  `).run(created.value.id, created.value.url, linkId);

  return { ok: true, value: db.prepare(`${linkSelect} WHERE id = ?`).get(linkId) as StripeLink };
}

function localDate(unixSeconds: number | null): string {
  const d = unixSeconds ? new Date(unixSeconds * 1000) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `payPayment` recusou o recibo: desfaz a transação sem perder a razão. */
class StripeReceiptError extends Error {}

export type StripeSweepRun = {
  skipped?: true;
  reason?: string;
  checked: number;
  paid: number;
  voided: number;
  review: number;
  /** Comissões apuradas nesta passagem. */
  fees: number;
  errors: number;
};

/**
 * Uma passagem pelos links vivos: regista o que o Stripe recebeu e anula os
 * links de faturas que entretanto foram pagas de outra forma, anuladas ou
 * mudaram de saldo — para a mesma dívida nunca ter dois sítios onde ser paga.
 *
 * Lê-se o Stripe ANTES de decidir anular: uma fatura paga em numerário cujo
 * link também foi pago não se pode anular lá, e esse dinheiro tem de aparecer.
 *
 * ponytail: um GET por link vivo por passagem. Com centenas de links abertos,
 * trocar por `GET /v1/events` com cursor (teto de 30 dias, daí não ser já).
 */
export async function runStripeSweep(
  db: Database.Database = getSqliteDatabase(),
  transport?: StripeTransport
): Promise<StripeSweepRun> {
  const run: StripeSweepRun = { checked: 0, paid: 0, voided: 0, review: 0, fees: 0, errors: 0 };
  const config = readStripeConfig(db);
  if (!config.enabled) return { ...run, skipped: true, reason: 'Pagamentos por Stripe desligados' };
  if (!config.ready) return { ...run, skipped: true, reason: 'Stripe por configurar' };

  const links = db.prepare(`${linkSelect} WHERE status IN ('creating', 'open', 'refund_pending') ORDER BY id`).all() as StripeLink[];
  const stripe = transport ?? createStripeTransport(config.secretKey);
  let settledAny = false;

  for (const snapshot of links) {
    await serializePayment(db, snapshot.paymentId, async () => {
    const link = db.prepare(`${linkSelect} WHERE id = ?`).get(snapshot.id) as StripeLink;
    if (!['creating', 'open', 'refund_pending'].includes(link.status)) return;
    if (link.status === 'refund_pending') {
      if (!link.refundId || !link.receiptId) { run.errors += 1; return; }
      run.checked += 1;
      const refund = await stripe.getRefund(link.refundId);
      if (!refund.ok) { run.errors += 1; return; }
      if (refund.value.status === 'pending' || refund.value.status === 'requires_action') return;
      const result = applyRefundOutcome(db, link.id, link.receiptId, link.paymentId, refund.value, link.note ?? 'Reembolso pedido no Stripe', null);
      if (!result.ok || refund.value.status !== 'succeeded') run.review += 1;
      return;
    }
    const payable = loadPayable(db, link.paymentId);
    const stale = !payable || payable.balanceCve <= 0 || !sameAmount(payable.balanceCve, link.amountCve);

    // Nunca chegou a existir no Stripe: não há nada para ler nem para anular.
    if (!link.stripeInvoiceId) {
      if (stale) { setLinkStatus(db, link.id, 'void', 'Fatura deixou de ter este saldo'); run.voided += 1; }
      return;
    }

    run.checked += 1;
    const proof = db.prepare('SELECT draft_cancel_key_hash AS keyHash FROM stripe_payment_links WHERE id = ?')
      .get(link.id) as { keyHash: string | null };
    const remote = await stripe.getInvoice(link.stripeInvoiceId, proof.keyHash);
    if (!remote.ok) { run.errors += 1; return; }

    // O pagamento local pode mudar enquanto se espera pelo GET remoto.
    const refreshedPayable = loadPayable(db, link.paymentId);

    if (remote.value.status === 'paid') {
      const amountCve = centavosToEscudos(remote.value.amountPaid);
      if (!refreshedPayable || refreshedPayable.balanceCve <= 0) {
        // O dinheiro está no Stripe mas a fatura já não o pede. Não se aplica
        // por adivinhação a outra fatura: decide uma pessoa (crédito ou reembolso).
        setLinkStatus(db, link.id, 'review', `Stripe recebeu ${amountCve} mas a fatura ja estava liquidada ou anulada`);
        systemAudit(db, 'stripe_payment_needs_review', link.paymentId, `Pagamento Stripe ${link.stripeInvoiceId} de ${amountCve} sem fatura em aberto`);
        run.review += 1;
        return;
      }

      // O link passa a `paid` na mesma transação do recibo: uma segunda
      // passagem já não o encontra aberto e não há recibo a dobrar.
      const outcome = db.transaction(() => {
        const claimed = db.prepare(`
          UPDATE stripe_payment_links SET status = 'paid', updated_at = datetime('now')
          WHERE id = ? AND status IN ('open', 'creating')
        `).run(link.id);
        if (claimed.changes === 0) return null;
        const result = payPayment(db, link.paymentId, {
          paymentMethod: 'outro',
          accountId: config.accountId,
          amountCve,
          paymentDate: localDate(remote.value.paidAt),
          notes: `Stripe ${link.stripeInvoiceId}`
        });
        // Desfaz o `paid`: a conta de destino pode ter sido desativada, e isso
        // corrige-se nas Configurações — a passagem seguinte volta a tentar.
        if (!result.ok) throw new StripeReceiptError(result.error);
        db.prepare('UPDATE stripe_payment_links SET receipt_id = ? WHERE id = ?').run(result.value.receipt.id, link.id);
        return result.value;
      });

      try {
        const paid = outcome();
        if (paid) {
          run.paid += 1;
          settledAny ||= paid.settled;
          systemAudit(db, 'stripe_payment_received', link.paymentId, `Recebeu ${amountCve} por Stripe (recibo ${paid.receipt.receiptNumber})`);
        }
      } catch (error) {
        if (!(error instanceof StripeReceiptError)) throw error;
        db.prepare(`UPDATE stripe_payment_links SET note = ?, updated_at = datetime('now') WHERE id = ?`).run(error.message, link.id);
        run.errors += 1;
      }
      return;
    }

    // Anulada à mão no painel do Stripe.
    if (remote.value.status === 'void' || remote.value.status === 'uncollectible') {
      setLinkStatus(db, link.id, 'void', 'Anulada no Stripe');
      run.voided += 1;
      return;
    }

    if (!refreshedPayable || refreshedPayable.balanceCve <= 0 || !sameAmount(refreshedPayable.balanceCve, link.amountCve)) {
      const voided = await cancelRemoteInvoice(db, stripe, link.id, link.stripeInvoiceId);
      if (!voided.ok) { run.errors += 1; return; }
      setLinkStatus(db, link.id, 'void', 'Fatura paga por outra via, anulada ou com outro saldo');
      run.voided += 1;
    }
    });
  }

  await recordPendingFees(db, stripe, config, run);

  // O recibo já mudou a intenção para ativo; isto só encurta a espera do cliente.
  if (settledAny) requestNetworkSync();
  return run;
}

/** A comissão em escudos; `null` quando ainda não dá para a calcular. */
function feeInCve(fee: NonNullable<StripePaymentInfo['fee']>, chargeCurrency: string): number | null {
  if (fee.currency.toLowerCase() === chargeCurrency) return centavosToEscudos(fee.amountMinor);
  // O Stripe liquida noutra moeda: a comissão vem nela, e o câmbio é o da
  // cobrança (moeda cobrada → moeda de liquidação).
  if (!fee.exchangeRate || fee.exchangeRate <= 0) return null;
  return roundEscudos(centavosToEscudos(fee.amountMinor) / fee.exchangeRate);
}

/**
 * A comissão do Stripe vira despesa, paga pela conta do Stripe: o saldo dela na
 * Tesouraria fica o líquido, como no extrato do Stripe.
 *
 * A transação de saldo pode não existir no segundo em que o pagamento cai, por
 * isso apura-se numa passagem à parte e repete-se até haver valor.
 *
 * ponytail: desiste ao fim de 7 dias (a comissão fica por apurar, sem despesa).
 * Se aparecerem casos, um botão "apurar comissão" na ficha resolve.
 */
async function recordPendingFees(db: Database.Database, stripe: StripeTransport, config: StripeConfig, run: StripeSweepRun): Promise<void> {
  const pending = db.prepare(`
    SELECT l.id, l.stripe_invoice_id AS stripeInvoiceId, l.payment_id AS paymentId,
           p.client_id AS clientId, p.invoice_number AS invoiceNumber, p.reference_month AS referenceMonth,
           r.payment_date AS paymentDate, r.account_id AS accountId
    FROM stripe_payment_links l
    JOIN payments p ON p.id = l.payment_id
    JOIN payment_receipts r ON r.id = l.receipt_id
    WHERE l.status IN ('paid', 'refunded', 'refund_pending') AND l.fee_cve IS NULL
      AND l.stripe_invoice_id IS NOT NULL
      AND l.updated_at >= datetime('now', '-7 days')
    ORDER BY l.id
  `).all() as Array<{
    id: number; stripeInvoiceId: string; paymentId: number; clientId: number;
    invoiceNumber: string | null; referenceMonth: string; paymentDate: string; accountId: number | null;
  }>;

  for (const link of pending) {
    const info = await stripe.getInvoicePayment(link.stripeInvoiceId);
    if (!info.ok) { run.errors += 1; continue; }
    if (info.value.paymentIntentId) {
      db.prepare('UPDATE stripe_payment_links SET payment_intent_id = ? WHERE id = ?').run(info.value.paymentIntentId, link.id);
    }
    // Dada como paga sem cartão: não houve cobrança, logo não há comissão.
    const feeCve = info.value.paymentIntentId === null ? 0 : info.value.fee ? feeInCve(info.value.fee, config.currency) : null;
    if (feeCve === null) continue;

    db.transaction(() => {
      // Outra passagem pode ter chegado primeiro: a despesa nunca dobra.
      const claimed = db.prepare('UPDATE stripe_payment_links SET fee_cve = ? WHERE id = ? AND fee_cve IS NULL').run(feeCve, link.id);
      if (claimed.changes === 0 || escudosToCentavos(feeCve) <= 0) return;

      const description = `Comissão Stripe · ${link.invoiceNumber || link.referenceMonth}`;
      const expenseId = Number(db.prepare(`
        INSERT INTO expenses (
          category, description, amount_cve, expense_date, reference_month,
          supplier, invoice_reference, client_id, account_id
        ) VALUES ('outros', ?, ?, ?, ?, 'Stripe', ?, ?, ?)
      `).run(description, feeCve, link.paymentDate, link.paymentDate.slice(0, 7), link.stripeInvoiceId, link.clientId, link.accountId).lastInsertRowid);
      syncSourceMovement(db, {
        kind: 'despesa',
        sourceId: expenseId,
        accountId: link.accountId,
        amountCve: feeCve,
        movementDate: link.paymentDate,
        description: `Despesa: ${description} · Stripe`,
        reason: 'comissão do Stripe apurada'
      });
      db.prepare('UPDATE stripe_payment_links SET fee_expense_id = ? WHERE id = ?').run(expenseId, link.id);
    })();
    run.fees += 1;
  }
}

/**
 * Reembolsa no Stripe um pagamento e anula o recibo que ele gerou.
 *
 * A ordem é o que interessa: primeiro o Stripe, depois a base. Tudo o que
 * `voidReceipt` recusaria é verificado ANTES de pedir o reembolso, porque um
 * reembolso feito não se desfaz. A comissão não volta: a despesa fica.
 */
type RefundOutcome = { refundId: string; status: StripeRefund['status']; receiptNumber: string; paymentId: number; amountCve: number };

function applyRefundOutcome(db: Database.Database, linkId: number, receiptId: number, paymentId: number, refund: StripeRefund, reason: string, userId: number | null): StripeOpResult<RefundOutcome> {
  return db.transaction((): StripeOpResult<RefundOutcome> => {
    const receipt = db.prepare('SELECT receipt_number AS receiptNumber, amount_cve AS amountCve FROM payment_receipts WHERE id = ?').get(receiptId) as { receiptNumber: string; amountCve: number };
    db.prepare("UPDATE stripe_payment_links SET refund_id = ?, note = ?, updated_at = datetime('now') WHERE id = ?").run(refund.id, reason, linkId);
    if (refund.status === 'pending' || refund.status === 'requires_action') {
      setLinkStatus(db, linkId, 'refund_pending');
    } else if (refund.status === 'failed' || refund.status === 'canceled') {
      setLinkStatus(db, linkId, 'review', `Reembolso ${refund.id} ${refund.status}: ${reason}`);
      systemAudit(db, 'stripe_refund_needs_review', paymentId, `Reembolso ${refund.id} ${refund.status}; recibo ${receipt.receiptNumber} continua valido`);
    } else {
      const voided = voidReceipt(db, receiptId, `Reembolso Stripe ${refund.id}: ${reason}`, userId, { confirmedStripeRefundId: refund.id });
      if (!voided.ok) {
        setLinkStatus(db, linkId, 'review', `Reembolsado no Stripe (${refund.id}) mas o recibo nao foi anulado: ${voided.error}`);
        systemAudit(db, 'stripe_refund_needs_review', paymentId, `Reembolso ${refund.id} feito, recibo ${receipt.receiptNumber} por anular`);
        return { ok: false, status: 500, error: `Reembolso feito no Stripe, mas o recibo nao foi anulado: ${voided.error}. Requer revisao do reembolso e do recibo.` };
      }
      setLinkStatus(db, linkId, 'refunded');
      systemAudit(db, 'stripe_refund_completed', paymentId, `Reembolso ${refund.id} concluido; recibo ${receipt.receiptNumber} anulado`);
    }
    return { ok: true, value: { refundId: refund.id, status: refund.status, receiptNumber: receipt.receiptNumber, paymentId, amountCve: receipt.amountCve } };
  })();
}

export async function refundStripeReceipt(
  db: Database.Database,
  receiptId: number,
  rawReason: string | null | undefined,
  userId: number | null,
  transport?: StripeTransport
): Promise<StripeOpResult<RefundOutcome>> {
  const receipt = db.prepare('SELECT payment_id AS paymentId FROM payment_receipts WHERE id = ?').get(receiptId) as { paymentId: number } | undefined;
  if (!receipt) return { ok: false, status: 404, error: 'Recibo nao encontrado' };
  return serializePayment(db, receipt.paymentId, () => requestRefund(db, receiptId, rawReason, userId, transport));
}

async function requestRefund(db: Database.Database, receiptId: number, rawReason: string | null | undefined, userId: number | null, transport?: StripeTransport): Promise<StripeOpResult<RefundOutcome>> {
  const reason = rawReason?.trim() || '';
  if (reason.length < 10) return { ok: false, status: 400, error: 'O reembolso exige um motivo detalhado (minimo 10 caracteres).' };

  const link = db.prepare(`
    SELECT l.id, l.stripe_invoice_id AS stripeInvoiceId, l.payment_intent_id AS paymentIntentId,
           l.payment_id AS paymentId, r.voided_at AS voidedAt, r.receipt_number AS receiptNumber,
           r.amount_cve AS amountCve, p.status AS paymentStatus
    FROM stripe_payment_links l
    JOIN payment_receipts r ON r.id = l.receipt_id
    JOIN payments p ON p.id = l.payment_id
    WHERE l.receipt_id = ? AND l.status = 'paid'
  `).get(receiptId) as {
    id: number; stripeInvoiceId: string; paymentIntentId: string | null; paymentId: number;
    voidedAt: string | null; receiptNumber: string; amountCve: number; paymentStatus: string;
  } | undefined;
  if (!link) return { ok: false, status: 404, error: 'Este recibo nao e de um pagamento Stripe por reembolsar' };
  if (link.voidedAt) return { ok: false, status: 409, error: 'Recibo ja anulado: se o dinheiro ainda esta no Stripe, reembolse no painel dele' };
  if (link.paymentStatus === 'cancelled') return { ok: false, status: 409, error: 'Fatura anulada: o recibo ja nao pode ser mexido' };

  const config = readStripeConfig(db);
  if (config.secretKey === '') return { ok: false, status: 409, error: 'Stripe por configurar: falta a chave' };
  const stripe = transport ?? createStripeTransport(config.secretKey);

  let paymentIntentId = link.paymentIntentId;
  if (!paymentIntentId) {
    const info = await stripe.getInvoicePayment(link.stripeInvoiceId);
    if (!info.ok) return { ok: false, status: 502, error: info.reason };
    paymentIntentId = info.value.paymentIntentId;
    if (!paymentIntentId) return { ok: false, status: 409, error: 'O Stripe nao tem um pagamento por cartao nesta fatura para reembolsar' };
    db.prepare('UPDATE stripe_payment_links SET payment_intent_id = ? WHERE id = ?').run(paymentIntentId, link.id);
  }

  const refunded = await stripe.refundPayment(paymentIntentId, `ispm-refund-${link.id}`);
  if (!refunded.ok) return { ok: false, status: 502, error: refunded.reason };
  return applyRefundOutcome(db, link.id, receiptId, link.paymentId, refunded.value, reason, userId);
}
