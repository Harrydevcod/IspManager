/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ToastProvider } from '../../components';
import { UpcomingSuspensionsCard } from './UpcomingSuspensionsCard';
import type { UpcomingSuspension } from '../../../shared/upcoming-suspension';

let root: Root | null = null;
let rows: UpcomingSuspension[];
let posted: { url: string; body: unknown } | null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  posted = null;
  rows = [{
    serviceId: 11, clientId: 10, clientName: 'Junior Taxista', clientCode: 'C0010', phone: '5915971',
    paymentId: 153, invoiceNumber: 'FT-2026-00153', dueDate: '2026-09-29', balanceCve: 1000, cutDate: '2026-11-04',
    sms: { status: 'failed', at: '2026-11-03 08:12:18' }, whatsapp: { status: 'failed', at: '2026-11-03 08:12:18' }
  }];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/payments/153/sms') && init?.method === 'POST') {
      posted = { url, body: JSON.parse(String(init.body)) };
      return json({ ok: true, id: 1, status: 'pending_dispatch' });
    }
    if (url.endsWith('/finance/upcoming-suspensions')) return json(rows);
    return json({ error: 'nope' }, 404);
  }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<ToastProvider><UpcomingSuspensionsCard onOpenPayment={() => undefined} /></ToastProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return host;
}

test('mostra quem vai ser cortado, com o estado real de cada canal', async () => {
  const host = await mount();
  expect(host.textContent).toContain('Suspensões a chegar');
  expect(host.textContent).toContain('Junior Taxista');
  expect(host.textContent).toContain('Hoje'); // corte já vencido: é hoje
  expect(host.textContent).toContain('Falhou');
});

test('"Avisar por SMS" põe o aviso de suspensão na fila do telemóvel', async () => {
  const host = await mount();
  const button = [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Avisar por SMS')!;
  await act(async () => { button.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(posted).toEqual({ url: 'http://127.0.0.1:3001/api/payments/153/sms', body: { eventType: 'suspension_notice' } });
});

test('sem ninguém a cortar, o cartão não aparece', async () => {
  rows = [];
  const host = await mount();
  expect(host.textContent).toBe('');
});
