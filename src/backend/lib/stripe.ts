/**
 * Transporte da API do Stripe (ADR 0016).
 *
 * Só o que o ISPM usa: criar o cliente, criar uma fatura avulsa (o link de
 * pagamento é a página dela), lê-la, anulá-la, apurar a comissão e reembolsar.
 * São meia dúzia de chamadas; o SDK oficial não se justifica.
 *
 * Todo o POST leva `Idempotency-Key`: repetir um pedido cuja resposta se perdeu
 * devolve o mesmo objeto em vez de criar outro (o Stripe guarda as chaves 24 h).
 */

import { createHash } from 'node:crypto';

const API_URL = 'https://api.stripe.com/v1';

// Fixa: sem ela, a conta responde na versão que tiver por omissão e os campos
// mudam por baixo de nós. Rever ao subir.
const API_VERSION = '2025-03-31.basil';

export type StripeResult<T> = { ok: true; value: T } | { ok: false; reason: string; details?: unknown; httpStatus?: number };

export type StripeInvoice = {
  id: string;
  /** `draft` | `open` | `paid` | `uncollectible` | `void`. */
  status: string;
  url: string | null;
  /** Na unidade mínima da moeda (centavos). */
  amountPaid: number;
  /** Segundos Unix; nulo enquanto não for paga. */
  paidAt: number | null;
};

export type StripePaymentInfo = {
  /** Nulo quando a fatura foi dada como paga sem cartão (à mão, no painel). */
  paymentIntentId: string | null;
  /**
   * O que o Stripe ficou, na moeda em que liquida. Nulo enquanto a transação
   * de saldo não existir. `exchangeRate` converte da moeda cobrada para esta.
   */
  fee: { amountMinor: number; currency: string; exchangeRate: number | null } | null;
};

export type StripeRefund = {
  id: string;
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
};

export type StripeTransport = {
  /** Nulo apenas quando a conta atual confirma ausencia ou eliminacao. */
  getCustomer(id: string): Promise<StripeResult<{ id: string } | null>>;
  createCustomer(
    input: { name: string; email?: string | null; phone?: string | null; metadata: Record<string, string> },
    idempotencyKey: string
  ): Promise<StripeResult<{ id: string }>>;
  createInvoice(
    input: { customerId: string; amountMinor: number; currency: string; description: string; metadata: Record<string, string>; invoiceId?: string },
    idempotencyKey: string,
    onDraftCreated?: (invoiceId: string) => void
  ): Promise<StripeResult<StripeInvoice>>;
  getInvoice(id: string, draftKeyHash?: string | null): Promise<StripeResult<StripeInvoice>>;
  voidInvoice(id: string, recovery?: {
    draftKeyHash?: string | null;
    onDraftCancelling?: (keyHash: string) => void;
  }): Promise<StripeResult<StripeInvoice>>;
  getInvoicePayment(invoiceId: string): Promise<StripeResult<StripePaymentInfo>>;
  /** Reembolso total do pagamento. */
  refundPayment(paymentIntentId: string, idempotencyKey: string): Promise<StripeResult<StripeRefund>>;
  getRefund(id: string): Promise<StripeResult<StripeRefund>>;
};

function toRefund(raw: unknown): StripeResult<StripeRefund> {
  const record = (raw ?? {}) as { id?: unknown; status?: unknown };
  const statuses = ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'];
  if (typeof record.id !== 'string' || !record.id || typeof record.status !== 'string' || !statuses.includes(record.status)) {
    return { ok: false, reason: 'Stripe devolveu um reembolso sem identidade ou estado valido', details: raw };
  }
  return { ok: true, value: { id: record.id, status: record.status as StripeRefund['status'] } };
}

function describeStripeFailure(result: unknown): string {
  const error = result && typeof result === 'object' ? (result as Record<string, unknown>).error : null;
  const message = error && typeof error === 'object' ? (error as Record<string, unknown>).message : null;
  return typeof message === 'string' && message.trim() ? `Stripe recusou o pedido: ${message.trim()}` : 'Stripe recusou o pedido';
}

function toInvoice(raw: unknown): StripeResult<StripeInvoice> {
  const record = (raw ?? {}) as Record<string, unknown>;
  // A eliminação de um rascunho devolve uma identidade, não uma fatura.
  // Localmente tem o mesmo efeito de uma anulação: já não se pode pagar.
  if (typeof record.id === 'string' && record.id && record.deleted === true) {
    return { ok: true, value: { id: record.id, status: 'void', url: null, amountPaid: 0, paidAt: null } };
  }
  if (typeof record.id !== 'string' || typeof record.status !== 'string') {
    return { ok: false, reason: 'Stripe devolveu uma fatura sem id ou estado', details: raw };
  }
  const transitions = (record.status_transitions ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    value: {
      id: record.id,
      status: record.status,
      url: typeof record.hosted_invoice_url === 'string' ? record.hosted_invoice_url : null,
      amountPaid: typeof record.amount_paid === 'number' ? record.amount_paid : 0,
      paidAt: typeof transitions.paid_at === 'number' ? transitions.paid_at : null
    }
  };
}

function withMetadata(params: Record<string, string>, metadata: Record<string, string>): Record<string, string> {
  const out = { ...params };
  for (const [key, value] of Object.entries(metadata)) out[`metadata[${key}]`] = value;
  return out;
}

export function createStripeTransport(secretKey: string): StripeTransport {
  const keyHash = createHash('sha256').update(secretKey).digest('hex');
  function isMissing(result: StripeResult<unknown>): boolean {
    return !result.ok && result.httpStatus === 404
      && (result.details as { error?: { code?: unknown } } | null)?.error?.code === 'resource_missing';
  }
  async function call(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, string>, idempotencyKey?: string): Promise<StripeResult<unknown>> {
    try {
      const response = await fetch(`${API_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Stripe-Version': API_VERSION,
          ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
        },
        body: params ? new URLSearchParams(params).toString() : undefined,
        signal: AbortSignal.timeout(20_000)
      });
      const result = await response.json().catch(() => null) as unknown;
      if (!response.ok) return { ok: false, reason: describeStripeFailure(result), details: result, httpStatus: response.status };
      return { ok: true, value: result };
    } catch (err) {
      return { ok: false, reason: 'Nao foi possivel contactar o Stripe', details: String(err) };
    }
  }

  return {
    async getCustomer(id) {
      const result = await call('GET', `/customers/${encodeURIComponent(id)}`);
      if (isMissing(result)) return { ok: true, value: null };
      if (!result.ok) return result;
      const customer = result.value as { id?: unknown; deleted?: unknown } | null;
      if (customer?.id !== id || (customer.deleted !== undefined && typeof customer.deleted !== 'boolean')) {
        return { ok: false, reason: 'Stripe devolveu um cliente sem identidade valida', details: result.value };
      }
      return { ok: true, value: customer.deleted === true ? null : { id } };
    },

    async createCustomer(input, idempotencyKey) {
      const created = await call('POST', '/customers', withMetadata({
        name: input.name,
        ...(input.email ? { email: input.email } : {}),
        ...(input.phone ? { phone: input.phone } : {})
      }, input.metadata), `ispm-customer-${createHash('sha256').update(`${keyHash}:${idempotencyKey}`).digest('hex')}`);
      if (!created.ok) return created;
      const id = (created.value as { id?: unknown } | null)?.id;
      return typeof id === 'string' && id ? { ok: true, value: { id } } : { ok: false, reason: 'Stripe nao devolveu o id do cliente', details: created.value };
    },

    // Três passos, cada um com a sua chave: rascunho, linha, finalização. Só a
    // fatura finalizada tem página de pagamento.
    async createInvoice(input, idempotencyKey, onDraftCreated) {
      const draft = input.invoiceId
        ? await call('GET', `/invoices/${encodeURIComponent(input.invoiceId)}`)
        : await call('POST', '/invoices', withMetadata({
        customer: input.customerId,
        currency: input.currency,
        collection_method: 'send_invoice',
        days_until_due: '30',
        // O Stripe não cobra nem envia nada sozinho: quem manda o link é o ISPM.
        auto_advance: 'false',
        pending_invoice_items_behavior: 'exclude',
        description: input.description
      }, input.metadata), `${idempotencyKey}-inv`);
      if (!draft.ok) return draft;
      const invoiceId = (draft.value as { id?: unknown } | null)?.id;
      if (typeof invoiceId !== 'string' || !invoiceId) {
        return { ok: false, reason: 'Stripe nao devolveu o id da fatura', details: draft.value };
      }
      // A identidade fica na base antes de qualquer outro passo, permitindo
      // retomar após reinício mesmo quando a chave de idempotência já expirou.
      onDraftCreated?.(invoiceId);
      const existing = draft.value as { status?: unknown; amount_due?: unknown; currency?: unknown };
      if (input.invoiceId && existing.status !== 'draft') return toInvoice(draft.value);
      if (input.invoiceId && (existing.currency !== input.currency
        || typeof existing.amount_due !== 'number'
        || (existing.amount_due !== 0 && existing.amount_due !== input.amountMinor))) {
        return { ok: false, reason: 'O rascunho Stripe nao corresponde ao valor ou moeda da fatura', details: draft.value };
      }

      if (!input.invoiceId || existing.amount_due === 0) {
        const item = await call('POST', '/invoiceitems', {
        customer: input.customerId,
        invoice: invoiceId,
        amount: String(input.amountMinor),
        currency: input.currency,
        description: input.description
      }, `${idempotencyKey}-item`);
        if (!item.ok) return item;
      }

      const finalized = await call('POST', `/invoices/${encodeURIComponent(invoiceId)}/finalize`, { auto_advance: 'false' }, `${idempotencyKey}-fin`);
      return finalized.ok ? toInvoice(finalized.value) : finalized;
    },

    async getInvoice(id, draftKeyHash) {
      const found = await call('GET', `/invoices/${encodeURIComponent(id)}`);
      if (draftKeyHash === keyHash && isMissing(found)) return toInvoice({ id, deleted: true });
      return found.ok ? toInvoice(found.value) : found;
    },

    async voidInvoice(id, recovery) {
      const path = `/invoices/${encodeURIComponent(id)}`;
      const found = await call('GET', path);
      if (!found.ok) {
        return recovery?.draftKeyHash === keyHash && isMissing(found)
          ? toInvoice({ id, deleted: true }) : found;
      }
      const invoice = toInvoice(found.value);
      if (!invoice.ok || invoice.value.status === 'void') return invoice;
      if (invoice.value.status === 'draft') {
        // A prova fica durável antes do pedido, para uma queda do processo não
        // impedir a confirmação da ausência com a mesma chave após reinício.
        recovery?.onDraftCancelling?.(keyHash);
        // /void só aceita faturas finalizadas; um rascunho avulso elimina-se.
        const deleted = await call('DELETE', path);
        if (deleted.ok) return toInvoice(deleted.value);
        if (deleted.httpStatus === undefined || deleted.httpStatus >= 500) {
          // A resposta pode perder-se depois da eliminação. Só aceitamos a
          // ausência depois de ler ESTE rascunho com ESTA mesma chave.
          const confirmed = await call('GET', path);
          if (isMissing(confirmed)) {
            return toInvoice({ id, deleted: true });
          }
        }
        return deleted;
      }
      // Sem chave: anular já é idempotente no efeito, e uma chave fazia o
      // Stripe repetir durante 24 h a resposta de uma tentativa falhada.
      const voided = await call('POST', `${path}/void`, {});
      return voided.ok ? toInvoice(voided.value) : voided;
    },

    // Desde a versão `basil` a fatura não traz o PaymentIntent: chega-se a ele
    // pelos pagamentos da fatura, e dele à transação de saldo com a comissão.
    async getInvoicePayment(invoiceId) {
      const paidRows: Array<{ id?: string; amount_paid?: unknown; payment?: { payment_intent?: unknown } }> = [];
      let cursor: string | undefined;
      let complete = false;
      for (let page = 0; page < 5; page += 1) {
        const query = new URLSearchParams({ invoice: invoiceId, status: 'paid', limit: '100' });
        if (cursor) query.set('starting_after', cursor);
        const listed = await call('GET', `/invoice_payments?${query}`);
        if (!listed.ok) return listed;
        const data = listed.value as { data?: unknown; has_more?: unknown } | null;
        if (!Array.isArray(data?.data)) return { ok: false, reason: 'Stripe devolveu uma lista de pagamentos invalida', details: listed.value };
        for (const row of data.data) {
          if (row?.status === 'paid') paidRows.push(row);
        }
        if (paidRows.length > 1) return { ok: false, reason: 'Esta fatura tem varias cobrancas no Stripe; reveja a comissao e o reembolso no painel' };
        if (data.has_more !== true) { complete = true; break; }
        const next = data.data.at(-1)?.id;
        if (typeof next !== 'string' || !next || next === cursor) return { ok: false, reason: 'Stripe devolveu uma pagina de pagamentos sem continuacao valida' };
        cursor = next;
      }
      if (!complete) return { ok: false, reason: 'Demasiados pagamentos Stripe para apurar automaticamente esta fatura' };
      const row = paidRows[0];
      const rawId = row?.payment?.payment_intent;
      const paymentIntentId = typeof rawId === 'string' ? rawId : (rawId as { id?: unknown } | null)?.id;
      if (typeof paymentIntentId !== 'string' || !paymentIntentId) return { ok: true, value: { paymentIntentId: null, fee: null } };

      const intent = await call('GET', `/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge.balance_transaction`);
      if (!intent.ok) return intent;
      const confirmed = intent.value as { id?: unknown; status?: unknown; amount_received?: unknown; latest_charge?: unknown } | null;
      if (confirmed?.id !== paymentIntentId || confirmed.status !== 'succeeded'
        || !Number.isSafeInteger(row.amount_paid) || Number(row.amount_paid) <= 0
        || confirmed.amount_received !== row.amount_paid) {
        return { ok: false, reason: 'A cobranca Stripe nao esta concluida ou esta repartida por outras faturas', details: intent.value };
      }
      const charge = confirmed.latest_charge;
      const balance = charge && typeof charge === 'object' ? (charge as { balance_transaction?: unknown }).balance_transaction : null;
      const record = balance && typeof balance === 'object' ? balance as Record<string, unknown> : null;
      const fee = record && typeof record.fee === 'number' && typeof record.currency === 'string'
        ? { amountMinor: record.fee, currency: record.currency, exchangeRate: typeof record.exchange_rate === 'number' ? record.exchange_rate : null }
        : null;
      return { ok: true, value: { paymentIntentId, fee } };
    },

    async refundPayment(paymentIntentId, idempotencyKey) {
      const refunded = await call('POST', '/refunds', { payment_intent: paymentIntentId, reason: 'requested_by_customer' }, idempotencyKey);
      if (!refunded.ok) return refunded;
      return toRefund(refunded.value);
    },

    async getRefund(id) {
      const result = await call('GET', `/refunds/${encodeURIComponent(id)}`);
      return result.ok ? toRefund(result.value) : result;
    }
  };
}
