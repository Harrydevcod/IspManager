/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth';
import { ConfirmProvider, ToastProvider } from '../../components';
import { SupportModule } from './SupportModule';
import type { TicketDetail } from './support-api';

const ticket: TicketDetail = {
  id: 7, clientId: 1, clientCode: 'C0014', clientName: 'Cibel Restaurante', serviceId: 15, pppoeUsername: 'skn001', planName: '20 Mbps',
  subject: 'Sem internet desde ontem', channel: 'telefone', category: 'sem_ligacao', priority: 'alta', status: 'aberto',
  openedByName: 'Arydson', assignedToId: null, assignedToName: null, openedAt: '2026-10-02 09:00:00',
  firstResponseAt: null, resolvedAt: null, closedAt: null,
  entries: [{ id: 1, kind: 'nota', body: 'Cliente ligou às 9h', createdAt: '2026-10-02 09:00:00', authorName: 'Arydson' }],
  workOrders: []
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let requests: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/api/tickets/assignees')) return json([{ id: 3, fullName: 'Técnico Um', role: 'technician' }]);
    if (url.endsWith('/api/tickets/7/entries')) {
      return json({ ...ticket, entries: [...ticket.entries, { id: 2, kind: 'nota', body: 'Vou passar amanhã', createdAt: '2026-10-02 10:00:00', authorName: 'Arydson' }] }, 201);
    }
    if (url.endsWith('/api/tickets/7')) return json(ticket);
    if (url.includes('/api/tickets')) return json({ items: [ticket], metrics: { open: 1, waiting: 0, resolvedThisMonth: 2, avgFirstResponseSeconds: 5400 } });
    if (url.includes('/api/auth/me')) return json({ error: 'sem sessão' }, 401);
    return json({});
  }));
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <AuthProvider><ToastProvider><ConfirmProvider><SupportModule /></ConfirmProvider></ToastProvider></AuthProvider>
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { host, root };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

test('lista os pedidos com o painel e uma coluna por dado', async () => {
  const { host, root } = await mount();
  expect(host.textContent).toContain('Resolvidos este mês');
  expect(host.textContent).toContain('1,5 h');
  expect(host.querySelectorAll('[role="columnheader"]')).toHaveLength(9);
  const row = [...host.querySelectorAll('[role="row"]')][1];
  expect(row.textContent).toContain('Cibel Restaurante');
  expect(row.textContent).toContain('Sem ligação');
  await act(async () => root.unmount());
});

test('abrir o pedido mostra a linha do tempo e acrescenta uma nota', async () => {
  const { host, root } = await mount();
  await act(async () => ([...host.querySelectorAll<HTMLElement>('[role="row"]')][1]).click());
  await flush();
  expect(document.body.textContent).toContain('Cliente ligou às 9h');
  expect(document.body.textContent).toContain('C0014 · Cibel Restaurante');

  const textarea = document.querySelector<HTMLTextAreaElement>('.support-ticket-compose textarea')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(textarea, 'Vou passar amanhã');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const add = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Acrescentar nota')!;
  await act(async () => add.click());
  await flush();
  expect(requests.find((request) => request.url.endsWith('/api/tickets/7/entries'))?.body).toEqual({ body: 'Vou passar amanhã' });
  expect(document.body.textContent).toContain('Vou passar amanhã');
  await act(async () => root.unmount());
});
