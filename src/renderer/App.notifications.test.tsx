/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App';

let root: Root | null = null;
let posted: string[] = [];

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const EMPTY_SUMMARY = {
  totalClients: 0, activeClients: 0, suspendedClients: 0, cancelledClients: 0,
  overduePayments: 0, pendingPayments: 0, lowStockModels: 0, activeServices: 0,
  openWorkOrders: 0, paidMonthCve: 0, paidPrevMonthCve: 0, pendingMonthCve: 0,
  pendingMonthCount: 0, pendingPreviousCve: 0, paidTotalCve: 0,
  revenueByMonth: [], upcomingDues: [], criticalOverdue: [], planMix: [], workQueue: []
};

const FEED = {
  now: [{ id: 'billing.critical-overdue', severity: 'danger', title: '3 faturas críticas', detail: 'há mais de 30 dias', section: 'finance', focus: 'overdue' }],
  history: [
    { id: 7, uid: 'probe:backbone:1:x', origin: 'pc', kind: 'network_down', severity: 'danger', title: 'CIBEL_AP em baixo', detail: '10.0.0.2', section: 'topology', focus: 'incidents', createdAt: '2026-11-19 08:00:00', read: false },
    { id: 6, uid: 'phone:abc', origin: 'phone', kind: 'sms_failed', severity: 'warn', title: 'SMS para Ana falhou', detail: 'sem rede', section: 'settings', focus: 'sms', createdAt: '2026-11-18 20:00:00', read: true }
  ],
  unseen: 1
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  posted = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') posted.push(url.replace('http://127.0.0.1:3001/api/notifications', ''));
    if (url.endsWith('/api/auth/status')) return json({ setupRequired: false, authBypassed: true });
    if (url.endsWith('/api/dashboard/summary')) return json(EMPTY_SUMMARY);
    if (url.endsWith('/api/notifications')) return json(FEED);
    return json({});
  }));
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function mountApp(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root?.render(<App />); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  return container;
}

function bell(container: HTMLElement): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>('.bell-trigger');
  if (!element) throw new Error('Sino não encontrado');
  return element;
}

function panel(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.bell-panel');
}

describe('sino de notificações', () => {
  test('o número soma o que está por tratar e o que está por ver', async () => {
    const container = await mountApp();
    // 1 alerta agora + 1 entrada por ver.
    expect(bell(container).getAttribute('aria-label')).toBe('Notificações, 2');
    expect(bell(container).querySelector('.nav-counter')?.textContent).toBe('2');
  });

  test('abrir o painel marca como visto e mostra as duas secções', async () => {
    const container = await mountApp();
    await act(async () => { bell(container).click(); });

    expect(posted).toContain('/seen');
    expect(panel()?.textContent).toContain('Agora');
    expect(panel()?.textContent).toContain('3 faturas críticas');
    expect(panel()?.textContent).toContain('Anteriores');
    expect(panel()?.textContent).toContain('CIBEL_AP em baixo');
    // O número desaparece, mas a entrada continua por ler.
    expect(bell(container).getAttribute('aria-label')).toBe('Notificações, 1');
    expect(panel()?.querySelectorAll('.bell-row.is-unread')).toHaveLength(1);
  });

  test('tocar numa entrada marca-a como lida e muda de secção', async () => {
    const container = await mountApp();
    await act(async () => { bell(container).click(); });
    const rows = panel()?.querySelectorAll<HTMLButtonElement>('.bell-row') ?? [];
    // A primeira é o alerta de "Agora"; a segunda é a entrada do histórico.
    await act(async () => { rows[1].click(); });

    expect(posted).toContain('/7/read');
    expect(panel()).toBeNull();
    expect(container.querySelector('.nav-list button[aria-current="page"]')?.textContent).toContain('Topologia');
  });

  test('Esc fecha e devolve o foco ao sino', async () => {
    const container = await mountApp();
    await act(async () => { bell(container).click(); });
    expect(panel()).not.toBeNull();

    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(bell(container));
  });

  test('"Marcar como lidas" limpa o por ler de uma vez', async () => {
    const container = await mountApp();
    await act(async () => { bell(container).click(); });
    const link = panel()?.querySelector<HTMLButtonElement>('.bell-link');
    await act(async () => { link?.click(); });

    expect(posted).toContain('/read-all');
    expect(panel()?.querySelectorAll('.bell-row.is-unread')).toHaveLength(0);
  });

  test('com o menu recolhido, a legenda diz o número', async () => {
    const container = await mountApp();
    await act(async () => { container.querySelector<HTMLButtonElement>('.brand-toggle')?.click(); });
    await act(async () => { bell(container).focus(); });
    expect(container.querySelector('.nav-rail-tip')?.textContent).toBe('Notificações · 2');
  });
});
