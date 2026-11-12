/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ToastProvider } from '../../components';
import { ClientFinanceDialog } from './ClientFinanceDialog';
import type { ClientFinance } from '../../types';

let root: Root | null = null;
let finance: ClientFinance;
let posted: { url: string; body: Record<string, unknown> } | null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const invoice = (paymentId: number, month: string, balanceCve: number) => ({
  paymentId,
  referenceMonth: month,
  invoiceNumber: `FT-${paymentId}`,
  dueDate: `${month}-10`,
  amountCve: balanceCve,
  receivedCve: 0,
  balanceCve,
  daysOverdue: 90,
  bucket: 'd90' as const,
  isOverdue: true,
  planId: null
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  posted = null;
  finance = {
    client: { id: 7, name: 'Maria Lopes', code: 'CLT-7', phone: '9912345', zone: 'Achada', status: 'active' },
    summary: { openCve: 5000, overdueCve: 5000, overdueInvoices: 2, creditCve: 0, maxDaysOverdue: 90, lastPaymentDate: '2026-06-01', lastPaymentCve: 2500 },
    invoices: [invoice(1, '2026-07', 2500), invoice(2, '2026-08', 2500)],
    receipts: [],
    notices: [{ channel: 'sms', id: 3, kind: 'payment_overdue', origin: null, status: 'sent', at: '2026-08-20 10:00:00', paymentId: 2, invoiceNumber: 'FT-2', referenceMonth: '2026-08' }],
    plans: []
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/payment-plans') && init?.method === 'POST') {
      posted = { url, body: JSON.parse(String(init.body)) };
      return json({}, 201);
    }
    if (url.endsWith('/clients/7/settle') && init?.method === 'POST') {
      posted = { url, body: JSON.parse(String(init.body)) };
      return json({ receiptNumber: 'RC-2026-00300', receiptIds: [9, 10], paymentIds: [1, 2], totalCve: 5000 });
    }
    if (url.endsWith('/treasury/accounts')) {
      return json([{ id: 4, kind: 'caixa', name: 'Caixa', active: true, isDefaultCash: true }]);
    }
    if (url.endsWith('/clients/7/finance')) return json(finance);
    return json({ error: 'nope' }, 404);
  }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount(onOpenInvoice = vi.fn()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ToastProvider><ClientFinanceDialog clientId={7} onClose={() => {}} onOpenInvoice={onOpenInvoice} /></ToastProvider>);
  });
  await act(async () => { await Promise.resolve(); });
  return onOpenInvoice;
}

const tab = (label: RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => label.test(b.textContent || ''))!;

const amountInputs = () =>
  [...document.querySelectorAll<HTMLInputElement>('.client-finance-schedule-edit input[type="number"]')];

/** O React só vê a mudança pelo setter nativo seguido do evento input. */
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

test('mostra a dívida e abre a fatura clicada', async () => {
  const onOpenInvoice = await mount();
  const text = document.body.textContent || '';
  expect(text).toContain('Maria Lopes');
  expect(text).toContain('5.000$00');
  expect(text).toContain('Faturas em aberto (2)');

  await act(async () => { (document.querySelector('[data-row-key="1"], .data-table-row') as HTMLElement).click(); });
  expect(onOpenInvoice).toHaveBeenCalledWith(1);
});

test('avisos juntam SMS e WhatsApp numa lista', async () => {
  await mount();
  await act(async () => tab(/Avisos/).click());
  expect(document.body.textContent).toContain('SMS');
  expect(document.body.textContent).toContain('Em atraso');
});

test('cria o acordo com as faturas em aberto e as prestações escolhidas', async () => {
  await mount();
  await act(async () => tab(/Acordo/).click());
  expect(amountInputs().map((input) => input.value)).toEqual(['1666', '1666', '1668']);

  const submit = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Criar acordo')!;
  await act(async () => submit.click());
  expect(posted?.url).toContain('/clients/7/payment-plans');
  expect(posted?.body).toMatchObject({ paymentIds: [1, 2], notes: null });
  expect((posted?.body as { installments: Array<{ amountCve: number }> }).installments.map((i) => i.amountCve))
    .toEqual([1666, 1666, 1668]);
});

test('prestações à medida: só cria quando a soma bate com a dívida', async () => {
  await mount();
  await act(async () => tab(/Acordo/).click());
  const submit = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Criar acordo')!;

  await act(async () => typeInto(amountInputs()[0], '2500'));
  expect(document.body.textContent).toContain('Excede 834$00');
  expect(submit().disabled).toBe(true);

  await act(async () => typeInto(amountInputs()[1], '1000'));
  await act(async () => typeInto(amountInputs()[2], '1000'));
  expect(document.body.textContent).toContain('Falta distribuir 500$00');
  expect(submit().disabled).toBe(true);

  await act(async () => typeInto(amountInputs()[0], '3000'));
  expect(submit().disabled).toBe(false);
  await act(async () => submit().click());
  expect((posted?.body as { installments: Array<{ amountCve: number }> }).installments.map((i) => i.amountCve))
    .toEqual([3000, 1000, 1000]);
});

test('repartir igual repõe a proposta', async () => {
  await mount();
  await act(async () => tab(/Acordo/).click());
  await act(async () => typeInto(amountInputs()[0], '100'));
  const reset = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Repartir igual')!;
  await act(async () => reset.click());
  expect(amountInputs().map((input) => input.value)).toEqual(['1666', '1666', '1668']);
  expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Repartir igual')).toBe(false);
});

test('liquidar todas emite um só pedido com as faturas e a conta', async () => {
  await mount();
  const selectAll = document.querySelector<HTMLInputElement>('[role="columnheader"] input[type="checkbox"], thead input[type="checkbox"], .data-table-header input[type="checkbox"]')!;
  await act(async () => selectAll.click());
  const bulk = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Liquidar todas')!;
  await act(async () => bulk.click());
  await act(async () => { await Promise.resolve(); });
  expect(document.body.textContent).toContain('2 faturas · 5.000$00');

  const emit = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Emitir recibo')!;
  await act(async () => emit.click());
  expect(posted?.url).toContain('/clients/7/settle');
  expect(posted?.body).toMatchObject({ paymentIds: [1, 2], paymentMethod: 'numerario', accountId: 4 });
});
