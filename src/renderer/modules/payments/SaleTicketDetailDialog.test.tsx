/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { SaleTicketDetailDialog } from './SaleTicketDetailDialog';
import type { PaymentRow } from '../../types';

vi.mock('../../lib/auth', () => ({ authFetch: (url: string, init?: RequestInit) => fetch(url, init), useAuth: () => ({ hasRole: () => true }) }));

test('anulação recarrega o PDF real do preview e descarta o documento pago', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let status = 'paid'; let objectId = 0;
  const documents: string[] = [];
  const urls: string[] = [];
  const revoked: string[] = [];
  const NativeUrl = URL;
  vi.stubGlobal('URL', class extends NativeUrl {
    static createObjectURL() { return `blob:tv-${++objectId}`; }
    static revokeObjectURL(value: string) { revoked.push(value); }
  });
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (input.includes('/sale-ticket.pdf')) { urls.push(input); documents.push(status); return new Response(status, { headers: { 'Content-Type': 'application/pdf' } }); }
    if (init?.method === 'POST') { status = 'cancelled'; return new Response(JSON.stringify({ status })); }
    return new Response(JSON.stringify({ paymentId: 1, documentNumber: 'TV-2026-00001', amountCve: 100, clientName: 'Cliente Indiferenciado',
      status, issuedOn: '2026-10-13', paymentMethod: 'numerario', accountId: 1, lines: [] }));
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const payment: PaymentRow = { id: 1, clientName: 'Cliente Indiferenciado', clientCode: 'INDIF', clientNif: null, clientPhone: null,
    documentType: 'sale_ticket', referenceMonth: 'AVULSA-1', amountCve: 100, dueDate: '2026-10-13', paymentDate: '2026-10-13',
    paymentMethod: 'numerario', status: 'paid', invoiceNumber: 'TV-2026-00001', receiptNumber: null, receivedCve: 100, balanceCve: 0, canRegenerate: 0 };
  const field = (label: string) => [...document.querySelectorAll('label')].find((item) => item.querySelector('.field-label')?.textContent === label)!.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!;
  async function fill(label: string, value: string) {
    const control = field(label); const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value); control.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  try {
    await act(async () => root.render(<SaleTicketDetailDialog payment={payment} onClose={() => {}} onCancelled={() => {}} />));
    const original = document.querySelector('iframe')!.getAttribute('src')!.split('#')[0];
    expect(documents).toEqual(['paid']);
    expect(urls[0]).toContain('format=a5');
    const select = document.querySelector('select')!;
    await act(async () => { select.value = 'a4'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(urls.at(-1)).toContain('format=a4');
    expect(revoked).toContain(original);
    await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Anular talão'))!.click());
    await fill('Motivo da anulação', 'Venda emitida por engano'); await fill('A sua palavra-passe de administrador', 'password-teste');
    await act(async () => document.querySelector<HTMLInputElement>('.field-toggle input')!.click());
    await act(async () => document.getElementById('cancel-sale-ticket-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(document.body.textContent).toContain('Documento anulado');
    expect(documents).toEqual(['paid', 'paid', 'cancelled']);
    expect(urls.at(-1)).toContain('format=a4');
    expect(document.querySelector('iframe')!.getAttribute('src')).not.toBe(original);
    expect(revoked).toContain(original);
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
