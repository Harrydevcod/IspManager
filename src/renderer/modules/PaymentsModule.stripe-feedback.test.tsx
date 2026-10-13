/** @vitest-environment jsdom */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../components';
import { PaymentsModule } from './PaymentsModule';
import { ManualInvoiceDialog } from './payments/ManualInvoiceDialog';
import type { PaymentRow, PaymentReceipt } from '../types';

vi.mock('../lib/download', () => ({
  useAuthenticatedObjectUrl: () => ({ objectUrl: null, loading: false, error: null }),
  downloadAuthenticated: vi.fn(), printAuthenticated: vi.fn()
}));

const payment: PaymentRow = {
  id: 41, clientName: 'Cliente teste', clientCode: 'C0041', clientNif: null, clientPhone: null,
  referenceMonth: '2026-09', amountCve: 2500, dueDate: '2026-10-01', paymentDate: '2026-09-30',
  paymentMethod: 'stripe', status: 'paid', invoiceNumber: 'FT41', receiptNumber: 'RC41',
  canRegenerate: 0, receivedCve: 2500, balanceCve: 0
};
const receipt: PaymentReceipt = {
  id: 7, paymentId: 41, amountCve: 2500, paymentDate: '2026-09-30', paymentMethod: 'stripe',
  source: 'cash', receiptNumber: 'RC41', receiptDate: '2026-09-30', voidedAt: null,
  voidReason: null, notes: null, accountId: null, accountName: null
};
let root: Root;
let stripeResponse: () => Promise<Response>;
let clientEmail: string | null;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

async function mount(element: ReactElement) {
  const node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root.render(<ToastProvider><ConfirmProvider>{element}</ConfirmProvider></ToastProvider>));
}
const button = (text: string) => {
  const node = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
  if (!node) throw new Error(`Missing button ${text}`);
  return node;
};
const toggle = () => document.querySelectorAll<HTMLInputElement>('.field-toggle input')[1];
async function click(node: HTMLElement) { await act(async () => node.click()); }
async function fill(selector: string, value: string) {
  const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function prepareManual() {
  await click(document.querySelector<HTMLButtonElement>('[aria-label="Cliente"]')!);
  await act(async () => document.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await fill('.manual-invoice-line input:not([type="number"])', 'Instalacao');
  await fill('input[type="number"]', '2500');
  await click(toggle());
}
async function issue() {
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function prepareRefund() {
  await mount(<PaymentsModule focusStatus="overdue" />);
  const select = [...document.querySelectorAll('select')].find((node) => [...node.options].some((option) => option.value === 'paid'))!;
  await act(async () => { select.value = 'all'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click(document.querySelector<HTMLElement>('.data-table-row')!);
  await click(button('Reembolsar'));
  await fill('textarea', 'Pedido do cliente');
  await fill('input[type="password"]', 'secret');
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  clientEmail = 'teste@example.com';
  stripeResponse = async () => json({ status: 'pending' });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/stripe-link') || url.endsWith('/stripe-refund')) return stripeResponse();
    if (url.endsWith('/payments/manual')) return json({ paymentId: 41 });
    if (url.endsWith('/clients')) return json([{ id: 1, clientCode: 'C1', fullName: 'Cliente teste', email: clientEmail }]);
    if (url.endsWith('/stripe/status')) return json({ enabled: true });
    if (url.endsWith('/receipts')) return json({ receipts: [receipt], clientCreditCve: 0, stripe: { enabled: true, link: null, refundableReceiptIds: [7] } });
    if (url.endsWith('/payments')) return json([payment]);
    return json([]);
  }));
  window.localStorage.clear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test.each(['http', 'network'])('issued invoice remains accessible with actionable warning after %s link failure', async (failure) => {
  stripeResponse = failure === 'http'
    ? async () => json({ error: 'Stripe indisponivel' }, 502)
    : async () => { throw new Error('offline'); };
  let createdId: number | undefined;
  let warning: string | undefined;
  await mount(<ManualInvoiceDialog open onClose={() => {}} onCreated={(id, message?: string) => { createdId = id; warning = message; }} />);
  await prepareManual();
  await issue();
  expect(createdId).toBe(41);
  expect(warning).toMatch(/fatura.*emitida/i);
  expect(warning).toMatch(/link/i);
  expect(warning).toMatch(/ficha/i);
});

test('waits for delayed Stripe response and prevents a second issue', async () => {
  let resolve!: (response: Response) => void;
  stripeResponse = () => new Promise((done) => { resolve = done; });
  let created = false;
  await mount(<ManualInvoiceDialog open onClose={() => {}} onCreated={() => { created = true; }} />);
  await prepareManual();
  await issue();
  expect(button('A emitir...').disabled).toBe(true);
  expect(created).toBe(false);
  await act(async () => resolve(json({ url: 'https://pay.example.com' })));
  expect(created).toBe(true);
});

test.each(['new', 'no-email'])('explains Stripe email prerequisite for %s recipient', async (mode) => {
  clientEmail = null;
  await mount(<ManualInvoiceDialog open onClose={() => {}} onCreated={() => {}} />);
  if (mode === 'new') await click(document.querySelector<HTMLInputElement>('.field-toggle input')!);
  else {
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Cliente"]')!);
    await act(async () => document.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  }
  expect(toggle().disabled).toBe(true);
  expect(toggle().closest('label')!.textContent).toMatch(/email/i);
});

test.each([
  ['pending', 'info', /aguarda.*confirma/i],
  ['requires_action', 'info', /ação.*Stripe/i],
  ['succeeded', 'success', /Reembolsado.*recibo anulado/i],
  ['failed', 'error', /falhou/i],
  ['canceled', 'error', /cancelado/i]
])('refund %s reports actual status', async (status, tone, message) => {
  stripeResponse = async () => json({ status });
  await prepareRefund();
  await click(button('Reembolsar e anular'));
  const notification = document.querySelector(`.toast-${tone}`);
  expect(notification?.textContent).toMatch(message);
  if (status !== 'succeeded') {
    expect(notification?.textContent).not.toMatch(/recibo anulado|voltou a ficar em aberto/i);
    expect(document.querySelector('.receipts-row--voided')).toBeNull();
  }
});

test('network refund failure keeps the dialog available and advises checking Stripe before retry', async () => {
  stripeResponse = async () => { throw new Error('offline'); };
  await prepareRefund();
  await click(button('Reembolsar e anular'));
  expect(document.querySelector('.toast-error')?.textContent).toMatch(/rede.*Consulte o Stripe.*novamente/i);
  expect(button('Reembolsar e anular').disabled).toBe(false);
});

test('delayed refund cannot be submitted twice and does not announce completion early', async () => {
  let resolve!: (response: Response) => void;
  stripeResponse = () => new Promise((done) => { resolve = done; });
  await prepareRefund();
  await click(button('Reembolsar e anular'));
  expect(button('A reembolsar...').disabled).toBe(true);
  expect(document.querySelector('.toast')).toBeNull();
  await act(async () => resolve(json({ status: 'pending' })));
  expect(document.querySelector('.toast-info')?.textContent).toMatch(/aguarda.*confirma/i);
});

test('manual invoice link failure is visible after issued invoice detail opens', async () => {
  stripeResponse = async () => json({ error: 'Stripe indisponivel' }, 502);
  await mount(<PaymentsModule />);
  await click(button('Nova fatura'));
  await prepareManual();
  await issue();
  expect(document.querySelector('#manual-invoice-form')).toBeNull();
  expect(document.querySelector('.toast-error')?.textContent).toMatch(/Fatura emitida.*link.*Stripe indisponivel.*ficha/i);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('FT41');
});
