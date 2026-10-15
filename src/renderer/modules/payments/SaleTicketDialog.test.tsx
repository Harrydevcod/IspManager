/** @vitest-environment jsdom */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SaleTicketDialog } from './SaleTicketDialog';
import { SaleTicketDetailDialog } from './SaleTicketDetailDialog';
import { PaymentsList } from './PaymentsList';
import { downloadAuthenticated, printAuthenticated } from '../../lib/download';
import type { PaymentRow } from '../../types';

let admin = true;
vi.mock('../../lib/auth', () => ({ authFetch: (url: string, init?: RequestInit) => fetch(url, init), useAuth: () => ({ hasRole: () => admin }) }));
vi.mock('../../lib/download', () => ({
  useAuthenticatedObjectUrl: () => ({ objectUrl: null, error: false }),
  downloadAuthenticated: vi.fn(async () => ({ saved: true })), printAuthenticated: vi.fn(async () => ({ printed: true }))
}));
let root: Root;
let issueResponse: () => Promise<Response>;
let cancelResponse: () => Promise<Response>;
const requests: Array<Record<string, unknown>> = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const ticketPayment: PaymentRow = {
  id: 45, documentType: 'sale_ticket', clientName: 'Cliente Indiferenciado', clientCode: 'CI',
  clientNif: null, clientPhone: null, referenceMonth: '2026-10', amountCve: 2500, dueDate: '2026-10-13',
  paymentDate: '2026-10-13', paymentMethod: 'numerario', status: 'paid', invoiceNumber: 'TV/45', receiptNumber: null,
  canRegenerate: 0, receivedCve: 2500, balanceCve: 0
};
async function mount(element: ReactElement) {
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(element));
}
function button(text: string) {
  const node = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
  if (!node) throw new Error(`Missing button ${text}`);
  return node;
}
function control(label: string) {
  const node = [...document.querySelectorAll('label')].find((item) => item.querySelector('.field-label')?.textContent === label)?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea');
  if (!node) throw new Error(`Missing field ${label}`);
  return node;
}
async function fill(label: string, value: string) {
  const node = control(label);
  const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function click(node: HTMLElement) { await act(async () => node.click()); }
async function submit(id = 'sale-ticket-form') {
  await act(async () => document.getElementById(id)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function freeLine() { await fill('Descrição 1', 'Assistência técnica'); await fill('Preço unitário CVE 1', '250'); }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); admin = true; requests.length = 0; vi.clearAllMocks();
  issueResponse = async () => json({ paymentId: 45, documentNumber: 'TV/45', amountCve: 2500 });
  cancelResponse = async () => json({ ok: true });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/sale-tickets')) { requests.push(JSON.parse(String(init?.body))); return issueResponse(); }
    if (url.endsWith('/sale-ticket/cancel')) { requests.push(JSON.parse(String(init?.body))); return cancelResponse(); }
    if (url.endsWith('/sale-ticket')) return json({ paymentId: 45, documentNumber: 'TV/45', amountCve: 2500, status: ticketPayment.status, paymentMethod: 'numerario', issuedOn: '2026-10-13', clientName: 'Cliente Indiferenciado', lines: [{ description: 'Router', quantity: 1, unitPriceCve: 2500, totalCve: 2500, catalogId: 1, serialNumbers: ['S1'] }] });
    if (url.endsWith('/stock/summary')) return json({ rows: [{ id: 1, active: 1, brand: 'MikroTik', model: 'Router', isSerialized: 1, sellingPriceCve: 2500, stockTotal: 5 }] });
    if (url.endsWith('/treasury/accounts')) return json([{ id: 2, name: 'Caixa principal', kind: 'caixa', isDefaultCash: true, active: true }, { id: 3, name: 'Banco', kind: 'banco', active: true }]);
    return json([]);
  }));
});
afterEach(async () => {
  await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals();
});

test('issues mixed free/catalog lines, exact serial count and chosen treasury method', async () => {
  const created = vi.fn();
  await mount(<SaleTicketDialog open onClose={() => {}} onCreated={created} />);
  await freeLine(); await fill('Quantidade 1', '2'); await click(button('Acrescentar linha'));
  await fill('Artigo 2', '1'); await fill('Quantidade 2', '2');
  await fill('Números de série 2', 'S1');
  expect(document.querySelector<HTMLButtonElement>('[form="sale-ticket-form"]')!.disabled).toBe(true);
  await fill('Números de série 2', 'S1\nS1');
  expect(document.querySelector<HTMLButtonElement>('[form="sale-ticket-form"]')!.disabled).toBe(true);
  await fill('Números de série 2', 'S1\nS2');
  await fill('Método de pagamento', 'transferencia');
  await submit();
  expect(requests[0]).toMatchObject({ paymentMethod: 'transferencia', accountId: 3, lines: [
    { description: 'Assistência técnica', quantity: 2, unitPriceCve: 250 },
    { catalogId: 1, quantity: 2, unitPriceCve: 2500, serialNumbers: ['S1', 'S2'] }
  ] });
  expect(requests[0].requestKey).toMatch(/^[0-9a-f-]{36}$/i); expect(created).toHaveBeenCalledWith(45);
});

test('blocks fractional quantity, nonpositive price and serial reuse across lines', async () => {
  await mount(<SaleTicketDialog open onClose={() => {}} onCreated={() => {}} />);
  await freeLine(); await fill('Quantidade 1', '1.5'); await submit(); expect(requests).toHaveLength(0);
  await fill('Quantidade 1', '1'); await fill('Preço unitário CVE 1', '0'); await submit(); expect(requests).toHaveLength(0);
  await fill('Artigo 1', '1'); await fill('Números de série 1', 'S1');
  await click(button('Acrescentar linha')); await fill('Artigo 2', '1'); await fill('Números de série 2', 's1');
  await submit(); expect(requests).toHaveLength(0); expect(document.body.textContent).toContain('repetido entre linhas');
});

test('validates aggregate stock across repeated product lines before emission', async () => {
  await mount(<SaleTicketDialog open onClose={() => {}} onCreated={() => {}} />);
  await fill('Artigo 1', '1'); await fill('Quantidade 1', '3'); await fill('Números de série 1', 'A1\nA2\nA3');
  await click(button('Acrescentar linha')); await fill('Artigo 2', '1'); await fill('Quantidade 2', '3');
  await fill('Números de série 2', 'B1\nB2\nB3');
  await submit(); expect(requests).toHaveLength(0);
  expect(document.body.textContent).toContain('Stock disponível: 5');
});

test('searches catalog and calculates the displayed total in centavos', async () => {
  await mount(<SaleTicketDialog open onClose={() => {}} onCreated={() => {}} />);
  await fill('Pesquisar produtos', 'não existe');
  expect([...control('Artigo 1').querySelectorAll('option')]).toHaveLength(1);
  await fill('Pesquisar produtos', 'mikrotik');
  expect([...control('Artigo 1').querySelectorAll('option')]).toHaveLength(2);
  await freeLine(); await fill('Preço unitário CVE 1', '0.335'); await fill('Quantidade 1', '3');
  expect(document.querySelector('.manual-invoice-total strong')?.textContent).toContain('1$02');
});

test('prevents double submission and closing while delayed issuance is pending', async () => {
  let resolve!: (response: Response) => void; issueResponse = () => new Promise((done) => { resolve = done; });
  const close = vi.fn(); const created = vi.fn();
  await mount(<SaleTicketDialog open onClose={close} onCreated={created} />); await freeLine();
  await submit(); await submit(); await click(document.querySelector('[aria-label="Fechar"]')!);
  expect(requests).toHaveLength(1); expect(close).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
  await act(async () => resolve(json({ paymentId: 45 }))); expect(created).toHaveBeenCalledWith(45);
});

test('retries an uncertain network result with exactly the same request and prevents editing', async () => {
  issueResponse = async () => { throw new Error('offline'); };
  await mount(<SaleTicketDialog open onClose={() => {}} onCreated={() => {}} />); await freeLine(); await submit();
  expect(control('Descrição 1').disabled).toBe(true); expect(button('Confirmar emissão').disabled).toBe(false);
  issueResponse = async () => json({ paymentId: 45 }); await submit();
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
});

test('shows rejected request errors and allows corrections', async () => {
  issueResponse = async () => json({ error: 'Stock insuficiente' }, 409);
  await mount(<SaleTicketDialog open onClose={() => {}} onCreated={() => {}} />); await freeLine(); await submit();
  expect(document.body.textContent).toContain('Stock insuficiente'); expect(control('Descrição 1').disabled).toBe(false);
  await fill('Preço unitário CVE 1', '350'); issueResponse = async () => json({ paymentId: 45 }); await submit();
  expect(requests[1].requestKey).not.toBe(requests[0].requestKey);
});

test('cancellation requires administrator password, reason and product-return confirmation', async () => {
  const done = vi.fn(); cancelResponse = async () => json({ error: 'Palavra-passe incorreta' }, 403);
  await mount(<SaleTicketDetailDialog payment={ticketPayment} onClose={() => {}} onCancelled={done} />);
  await click(button('Anular talão')); await fill('Motivo da anulação', 'Venda duplicada'); await fill('A sua palavra-passe de administrador', 'wrong');
  await submit('cancel-sale-ticket-form'); expect(requests).toHaveLength(0);
  await click(document.querySelector<HTMLInputElement>('.field-toggle input')!); await submit('cancel-sale-ticket-form');
  expect(document.body.textContent).toContain('Palavra-passe incorreta'); expect(done).not.toHaveBeenCalled();
  await fill('A sua palavra-passe de administrador', 'correct'); cancelResponse = async () => json({ ok: true });
  await submit('cancel-sale-ticket-form'); expect(requests[1]).toEqual({ reason: 'Venda duplicada', confirmPassword: 'correct', productsReturned: true });
  expect(done).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain('Documento anulado');
  expect(document.querySelector('input[type="password"]')).toBeNull();
});

test('A5 is initially selected and PDF download and print follow A4/A5 selection', async () => {
  await mount(<SaleTicketDetailDialog payment={ticketPayment} onClose={() => {}} onCancelled={() => {}} />);
  expect(control('Formato do PDF').value).toBe('a5');
  await click(button('Guardar PDF'));
  expect(downloadAuthenticated).toHaveBeenLastCalledWith('http://127.0.0.1:3001/api/payments/45/sale-ticket.pdf?format=a5', 'TV/45-a5.pdf');
  await fill('Formato do PDF', 'a4');
  await click(button('Imprimir'));
  expect(printAuthenticated).toHaveBeenLastCalledWith('http://127.0.0.1:3001/api/payments/45/sale-ticket.pdf?format=a4');
});

test('operators cannot cancel; authenticated download selects the 80mm endpoint', async () => {
  admin = false;
  await mount(<SaleTicketDetailDialog payment={ticketPayment} onClose={() => {}} onCancelled={() => {}} />);
  expect(document.body.textContent).not.toContain('Anular talão');
  await fill('Formato do PDF', '80mm'); await click(button('Guardar PDF'));
  expect(downloadAuthenticated).toHaveBeenCalledWith('http://127.0.0.1:3001/api/payments/45/sale-ticket.pdf?format=80mm', 'TV/45-80mm.pdf');
});

test('cancelled tickets remain readable and PDF actions remain available', async () => {
  await mount(<SaleTicketDetailDialog payment={{ ...ticketPayment, status: 'cancelled' }} onClose={() => {}} onCancelled={() => {}} />);
  expect(document.body.textContent).toContain('Documento anulado'); expect(document.body.textContent).not.toContain('Anular talão');
  expect(button('Guardar PDF').disabled).toBe(false); expect(button('Imprimir').disabled).toBe(false);
});

test('sale-ticket rows expose their own detail action without generic invoice or receipt actions', async () => {
  const preview = vi.fn(); const noop = () => {};
  await mount(<PaymentsList payments={[ticketPayment]} activeId={null} sort={{ key: 'Fatura', direction: 'asc' }} onSortChange={noop} submitting={false} isReminderSentToday={() => false} onPreview={preview} onOpenPdf={noop} onMarkOverdue={noop} onOpenPayForm={noop} onOpenWhatsappForm={noop} onSendDocumentWhatsapp={noop} onSendSms={noop} onOpenCancelForm={noop} onRevert={noop} onRegenerate={noop} />);
  await click(document.querySelector<HTMLButtonElement>('.row-actions-trigger') || document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!);
  expect(document.body.textContent).toContain('Abrir talão de venda'); expect(document.body.textContent).not.toContain('Fatura PDF'); expect(document.body.textContent).not.toContain('Recibo PDF');
});

test('a pesquisa encontra artigos e stock pelo código', async () => {
  const base = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/articles')) return json([
      { id: 7, code: 'ART0003', name: 'Cabo UTP', kind: 'product', unitPriceCve: 100, active: 1 },
      { id: 8, code: 'SRV0001', name: 'Deslocação', kind: 'service', unitPriceCve: 500, active: 1 }
    ]);
    if (url.endsWith('/stock/summary')) return json({ rows: [{ id: 1, code: 'EQP0002', active: 1, brand: 'MikroTik', model: 'Router', isSerialized: 0, sellingPriceCve: 2500, stockTotal: 5 }] });
    return base(input, init);
  }));
  await mount(<SaleTicketDialog open onClose={() => {}} onCreated={() => {}} />);
  const options = () => [...(control('Artigo 1') as HTMLSelectElement).options].map((option) => option.value);
  await fill('Pesquisar produtos', 'art0003');
  expect(options()).toEqual(['', 'a:7']);
  await fill('Pesquisar produtos', 'EQP0002');
  expect(options()).toEqual(['', '1']);
});
