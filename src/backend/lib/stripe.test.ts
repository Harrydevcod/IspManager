import { afterEach, expect, test, vi } from 'vitest';
import { createStripeTransport } from './stripe';

afterEach(() => { vi.unstubAllGlobals(); });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const paid = (id = 'ip_paid', intent = 'pi_paid') => ({ id, status: 'paid', amount_paid: 250000, payment: { type: 'payment_intent', payment_intent: intent } });
const input = { customerId: 'cus_1', amountMinor: 250000, currency: 'cve', description: 'FT-1', metadata: { ispmPaymentId: '1' } };

test('seleciona apenas a cobrança paga, nunca uma tentativa incompleta', async () => {
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes('/invoice_payments?')) return json({ data: [
      { id: 'ip_failed', status: 'open', amount_paid: null, payment: { payment_intent: 'pi_failed' } }, paid()
    ], has_more: false });
    expect(String(url)).toContain('/payment_intents/pi_paid?');
    return json({ id: 'pi_paid', status: 'succeeded', amount_received: 250000, latest_charge: {
      balance_transaction: { fee: 7500, currency: 'cve', exchange_rate: null }
    } });
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await createStripeTransport('sk_test_placeholder').getInvoicePayment('in_1')).toMatchObject({
    ok: true, value: { paymentIntentId: 'pi_paid', fee: { amountMinor: 7500 } }
  });
  expect(String(fetcher.mock.calls[0][0])).toContain('status=paid');
});

test('não usa um PaymentIntent que não recebeu a cobrança', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('/invoice_payments?')
    ? json({ data: [paid()], has_more: false })
    : json({ id: 'pi_paid', status: 'requires_payment_method', amount_received: 0, latest_charge: null })));
  expect(await createStripeTransport('sk_test_placeholder').getInvoicePayment('in_1')).toMatchObject({ ok: false });
});

test('recusa reembolso integral de uma cobrança repartida por outras faturas', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('/invoice_payments?')
    ? json({ data: [paid()], has_more: false })
    : json({ id: 'pi_paid', status: 'succeeded', amount_received: 300000, latest_charge: null })));
  expect(await createStripeTransport('sk_test_placeholder').getInvoicePayment('in_1')).toMatchObject({ ok: false });
});

test('deteta múltiplas cobranças também numa segunda página, sem escolher uma ao acaso', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('starting_after=')
    ? json({ data: [paid('ip_second', 'pi_second')], has_more: false })
    : json({ data: [paid()], has_more: true })));
  expect(await createStripeTransport('sk_test_placeholder').getInvoicePayment('in_1')).toMatchObject({ ok: false });
});

test('um reembolso pendente preserva esse estado, e pode ser consultado depois', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => json({ id: 're_1', status: String(url).endsWith('/refunds') ? 'pending' : 'succeeded' })));
  const stripe = createStripeTransport('sk_test_placeholder');
  expect(await stripe.refundPayment('pi_paid', 'refund-1')).toEqual({ ok: true, value: { id: 're_1', status: 'pending' } });
  expect(await stripe.getRefund('re_1')).toEqual({ ok: true, value: { id: 're_1', status: 'succeeded' } });
});

test('um estado de reembolso desconhecido nunca é tratado como sucesso', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ id: 're_1', status: 'unknown' })));
  expect(await createStripeTransport('sk_test_placeholder').refundPayment('pi_paid', 'refund-1')).toMatchObject({ ok: false });
});

test('guarda a identidade do rascunho antes da linha e finalização e fixa versão/idempotência', async () => {
  const calls: string[] = [];
  let saved = false;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    expect(options.headers['Stripe-Version']).toBe('2025-03-31.basil');
    expect(options.headers['Idempotency-Key']).toBeTruthy();
    if (path.endsWith('/finalize')) return json({ id: 'in_1', status: 'open', hosted_invoice_url: 'https://invoice.stripe.com/i/1' });
    return json({ id: path.endsWith('/invoices') ? 'in_1' : 'ii_1', status: 'draft' });
  }));
  expect(await createStripeTransport('sk_test_placeholder').createInvoice(input, 'link-1', (id) => {
    saved = true;
    expect(id).toBe('in_1');
    expect(calls).toEqual(['/v1/invoices']);
  })).toMatchObject({ ok: true });
  expect(saved).toBe(true);
});

test('retoma um rascunho com linha existente sem criar outra cobrança nem outra linha', async () => {
  const fetcher = vi.fn(async (url, options) => {
    expect(new URL(String(url)).pathname).not.toBe('/v1/invoices');
    expect(new URL(String(url)).pathname).not.toBe('/v1/invoiceitems');
    return options.method === 'GET'
      ? json({ id: 'in_saved', status: 'draft', amount_due: 250000, currency: 'cve' })
      : json({ id: 'in_saved', status: 'open', hosted_invoice_url: 'https://invoice.stripe.com/i/saved' });
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await createStripeTransport('sk_test_placeholder').createInvoice({ ...input, invoiceId: 'in_saved' }, 'link-1')).toMatchObject({ ok: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('cancela um rascunho por eliminar, sem tentar anular uma fatura não finalizada', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/invoices/in_draft' && options.method === 'GET') {
      return json({ id: 'in_draft', status: 'draft', amount_paid: 0 });
    }
    if (path === '/v1/invoices/in_draft' && options.method === 'DELETE') {
      return json({ id: 'in_draft', object: 'invoice', deleted: true });
    }
    return new Response(JSON.stringify({ error: { message: 'Only finalized invoices can be voided' } }), { status: 400 });
  }));

  expect(await createStripeTransport('sk_test_placeholder').voidInvoice('in_draft')).toEqual({
    ok: true, value: { id: 'in_draft', status: 'void', url: null, amountPaid: 0, paidAt: null }
  });
});

test('reconhece uma fatura já anulada sem voltar a mutar o Stripe', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => options.method === 'GET'
    ? json({ id: 'in_void', status: 'void', amount_paid: 0 })
    : new Response(null, { status: 400 })));

  const stripe = createStripeTransport('sk_test_placeholder');
  expect(await stripe.getInvoice('in_void')).toMatchObject({ ok: true, value: { status: 'void' } });
  expect(await stripe.voidInvoice('in_void')).toMatchObject({ ok: true, value: { status: 'void' } });
});

test('uma recusa de eliminação nunca confirma o cancelamento do rascunho', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => options.method === 'GET'
    ? json({ id: 'in_draft', status: 'draft', amount_paid: 0 })
    : new Response(JSON.stringify({ error: { message: 'Permission denied' } }), { status: 403 })));
  expect(await createStripeTransport('sk_test_placeholder').voidInvoice('in_draft')).toMatchObject({ ok: false });
});

test('uma fatura finalizada continua a ser anulada, preservando o histórico remoto', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/invoices/in_open' && options.method === 'GET') {
      return json({ id: 'in_open', status: 'open', amount_paid: 0 });
    }
    if (path === '/v1/invoices/in_open/void' && options.method === 'POST') {
      return json({ id: 'in_open', status: 'void', amount_paid: 0 });
    }
    return new Response(null, { status: 400 });
  }));
  expect(await createStripeTransport('sk_test_placeholder').voidInvoice('in_open')).toMatchObject({
    ok: true, value: { id: 'in_open', status: 'void' }
  });
});

test('confirma o cancelamento quando o DELETE termina mas a resposta se perde', async () => {
  let exists = true;
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    if (options.method === 'DELETE') {
      exists = false;
      throw new TypeError('Connection lost after deleting invoice');
    }
    return exists
      ? json({ id: 'in_draft', status: 'draft', amount_paid: 0 })
      : new Response(JSON.stringify({ error: { code: 'resource_missing', param: 'id' } }), { status: 404 });
  }));
  expect(await createStripeTransport('sk_test_placeholder').voidInvoice('in_draft')).toMatchObject({
    ok: true, value: { id: 'in_draft', status: 'void' }
  });
});

test('um id ausente sem confirmar previamente o rascunho nunca conta como cancelamento', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    error: { code: 'resource_missing', param: 'id' }
  }), { status: 404 })));
  expect(await createStripeTransport('sk_test_placeholder').voidInvoice('in_other_account')).toMatchObject({ ok: false });
});

test.each([false, true])('a prova do rascunho recupera o cancelamento após reinício apenas com a mesma chave (mudou: %s)', async (changedKey) => {
  let draftKeyHash = '';
  let firstRead = true;
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    if (options.method === 'GET' && firstRead) {
      firstRead = false;
      return json({ id: 'in_draft', status: 'draft', amount_paid: 0 });
    }
    throw new TypeError('Connection lost');
  }));
  const failed = await createStripeTransport('sk_test_placeholder').voidInvoice('in_draft', {
    onDraftCancelling: (keyHash) => { draftKeyHash = keyHash; }
  });
  expect(failed.ok).toBe(false);
  expect(draftKeyHash).toMatch(/^[a-f0-9]{64}$/);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    error: { code: 'resource_missing', param: 'id' }
  }), { status: 404 })));
  const restarted = createStripeTransport(changedKey ? 'sk_test_other_account' : 'sk_test_placeholder');
  expect(await restarted.voidInvoice('in_draft', { draftKeyHash })).toMatchObject({ ok: !changedKey });
});

test('se a prova não pode ser gravada, o rascunho não é eliminado', async () => {
  let deleted = false;
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    if (options.method === 'DELETE') deleted = true;
    return json({ id: 'in_draft', status: 'draft', amount_paid: 0 });
  }));
  await expect(createStripeTransport('sk_test_placeholder').voidInvoice('in_draft', {
    onDraftCancelling: () => { throw new Error('Database write failed'); }
  })).rejects.toThrow('Database write failed');
  expect(deleted).toBe(false);
});


test('idempotencia de Customer separa credenciais e permanece estavel na mesma chave', async () => {
  const keys: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    keys.push(options.headers['Idempotency-Key']);
    return json({ id: 'cus_1' });
  }));
  const customer = { name: 'Cliente', metadata: { ispmClientId: '1' } };
  await createStripeTransport('sk_test_a').createCustomer(customer, 'ispm-customer-1');
  await createStripeTransport('sk_live_a').createCustomer(customer, 'ispm-customer-1');
  await createStripeTransport('sk_test_b').createCustomer(customer, 'ispm-customer-1');
  await createStripeTransport('sk_test_a').createCustomer(customer, 'ispm-customer-1');
  expect(new Set(keys.slice(0, 3)).size).toBe(3);
  expect(keys[0]).toBe(keys[3]);
  expect(keys.every((key) => !key.includes('sk_'))).toBe(true);
});


test.each([
  { body: { id: 'cus_saved' }, status: 200, want: { ok: true, value: { id: 'cus_saved' } } },
  { body: { id: 'cus_saved', deleted: true }, status: 200, want: { ok: true, value: null } },
  { body: { error: { code: 'resource_missing' } }, status: 404, want: { ok: true, value: null } },
  { body: { error: { code: 'permission_denied' } }, status: 404, want: { ok: false } },
  { body: { id: 'cus_other' }, status: 200, want: { ok: false } },
  { body: null, status: 200, want: { ok: false } },
  { body: { id: 'cus_saved', deleted: 'true' }, status: 200, want: { ok: false } }
])('verificacao de Customer preserva ausencia confirmada e recusa resposta $body', async ({ body, status, want }) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
  expect(await createStripeTransport('sk_test_a').getCustomer('cus_saved')).toMatchObject(want);
});

test('falha de rede ao verificar Customer nao confirma ausencia', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Connection lost'); }));
  expect(await createStripeTransport('sk_test_a').getCustomer('cus_saved')).toMatchObject({ ok: false });
});
