/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth';
import { cycleLabel, UsageHistory } from './UsageHistory';

let root: Root | null = null;
let body: unknown;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const payload = url.endsWith('/api/auth/status') ? { setupRequired: false, authBypassed: true } : body;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<AuthProvider><UsageHistory serviceId={7} /></AuthProvider>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

test('mostra um ciclo por linha, o atual marcado e o estado do uso justo', async () => {
  body = {
    referenceGb: 300, bytesPerGb: 1e9,
    cycles: [
      { start: '2026-11-05', end: '2026-12-04', period: '2026-11', current: true, downBytes: 40e9, upBytes: 3e9, days: 10, percent: 14.3, fup: null },
      { start: '2026-10-05', end: '2026-11-04', period: '2026-10', current: false, downBytes: 300e9, upBytes: 20e9, days: 31, percent: 106.7, fup: 'LIMITADO' }
    ]
  };
  const view = await mount();
  expect(view.textContent).toContain('Atual');
  expect(view.textContent).toContain('43,0 GB');
  expect(view.textContent).toContain('320,0 GB');
  expect(view.textContent).toContain('107%');
  expect(view.textContent).toContain('Limitado');
});

test('o ciclo diz o ano uma vez, ou os dois quando passa a passagem de ano', () => {
  expect(cycleLabel('2026-11-05', '2026-12-04')).toBe('05-11 – 04-12-2026');
  expect(cycleLabel('2026-12-15', '2027-01-14')).toBe('15-12-2026 – 14-01-2027');
});

test('sem plafond não mostra a %; sem medição mostra o vazio', async () => {
  body = { referenceGb: 0, bytesPerGb: 1e9, cycles: [] };
  const view = await mount();
  expect(view.textContent).toContain('Sem consumo medido');
  expect(view.textContent).not.toContain('% do plafond');
});
