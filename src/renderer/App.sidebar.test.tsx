/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App';

let root: Root | null = null;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Resumo a zeros: o Dashboard monta, sem contadores na navegação. */
const EMPTY_SUMMARY = {
  totalClients: 0,
  activeClients: 0,
  suspendedClients: 0,
  cancelledClients: 0,
  overduePayments: 0,
  pendingPayments: 0,
  lowStockModels: 0,
  activeServices: 0,
  openWorkOrders: 0,
  paidMonthCve: 0,
  paidPrevMonthCve: 0,
  pendingMonthCve: 0,
  pendingMonthCount: 0,
  pendingPreviousCve: 0,
  paidTotalCve: 0,
  revenueByMonth: [],
  upcomingDues: [],
  criticalOverdue: [],
  planMix: [],
  workQueue: []
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })));
  // O shell só precisa do estado de autenticação e de um resumo sem alertas.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) {
      return json({ setupRequired: false, authBypassed: true });
    }
    if (url.endsWith('/api/dashboard/summary')) return json(EMPTY_SUMMARY);
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
  await act(async () => {
    root?.render(<App />);
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); });
  return container;
}

function shell(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('.app-shell');
  if (!element) throw new Error('App shell not found');
  return element;
}

function toggle(container: HTMLElement): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>('.brand-toggle');
  if (!element) throw new Error('Sidebar toggle not found');
  return element;
}

describe('sidebar collapse', () => {
  test('collapses to the rail and back from the brand toggle', async () => {
    const container = await mountApp();
    expect(shell(container).dataset.nav).toBeUndefined();
    expect(toggle(container).getAttribute('aria-expanded')).toBe('true');

    await act(async () => { toggle(container).click(); });
    expect(shell(container).dataset.nav).toBe('rail');
    expect(toggle(container).getAttribute('aria-expanded')).toBe('false');
    expect(toggle(container).getAttribute('aria-label')).toBe('Expandir menu');

    await act(async () => { toggle(container).click(); });
    expect(shell(container).dataset.nav).toBeUndefined();
  });

  test('toggles with Ctrl+B and remembers the choice', async () => {
    const container = await mountApp();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
    });
    expect(shell(container).dataset.nav).toBe('rail');
    expect(localStorage.getItem('ispm-sidebar')).toBe('rail');

    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();

    expect(shell(await mountApp()).dataset.nav).toBe('rail');
  });
});
