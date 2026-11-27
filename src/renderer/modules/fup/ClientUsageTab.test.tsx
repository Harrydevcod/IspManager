/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth';
import { ClientUsageTab, cycleLabel } from './ClientUsageTab';

let root: Root | null = null;
const bodies = new Map<number, unknown>();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const id = Number(url.match(/services\/(\d+)\/usage-cycles/)?.[1]);
    const payload = url.endsWith('/api/auth/status') ? { setupRequired: false, authBypassed: true } : bodies.get(id);
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  bodies.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount(services: Array<{ serviceId: number; label: string }>) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<AuthProvider><ClientUsageTab services={services} /></AuthProvider>); });
  await flush();
  return container;
}

const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find((b) => b.textContent === label)!;

const history = {
  referenceGb: 300, bytesPerGb: 1e9,
  cycles: [
    { start: '2026-11-01', end: '2026-11-30', period: '2026-11', current: true, downBytes: 40e9, upBytes: 3e9, days: 2, percent: 14.3, fup: null },
    { start: '2026-10-01', end: '2026-10-31', period: '2026-10', current: false, downBytes: 300e9, upBytes: 20e9, days: 2, percent: 106.7, fup: 'LIMITADO' }
  ],
  daily: [
    { day: '2025-12-31', downBytes: 5e9, upBytes: 0 },
    { day: '2026-10-10', downBytes: 150e9, upBytes: 10e9 },
    { day: '2026-10-11', downBytes: 150e9, upBytes: 10e9 },
    { day: '2026-11-01', downBytes: 20e9, upBytes: 1e9 },
    { day: '2026-11-02', downBytes: 20e9, upBytes: 2e9 }
  ],
  profile: { avgDailyBytes: 9e9, percentile: 83, klass: 'INTENSO', peers: 30, overPlafond: true }
};

test('por ciclo, por mês e por ano, com o perfil do cliente', async () => {
  bodies.set(7, history);
  const view = await mount([{ serviceId: 7, label: 'ana · Standard' }]);
  expect(view.textContent).toContain('Intenso');
  expect(view.textContent).toContain('P83');
  expect(view.textContent).toContain('Acima do plafond');
  expect(view.textContent).toContain('Limitado');
  expect(view.textContent).toContain('% do plafond');

  await act(async () => { tab('Por mês').click(); });
  expect(view.textContent).toContain('outubro de 2026');
  expect(view.textContent).toContain('320,0 GB');
  expect(view.textContent).not.toContain('% do plafond');

  await act(async () => { tab('Por ano').click(); });
  const years = [...view.querySelectorAll('tbody th')].map((th) => th.textContent);
  expect(years[0]).toContain('2026');
  expect(years[1]).toContain('2025');
});

test('mais de um serviço: escolhe-se o serviço', async () => {
  bodies.set(7, history);
  bodies.set(8, { ...history, cycles: [], daily: [], profile: null });
  const view = await mount([{ serviceId: 7, label: 'ana' }, { serviceId: 8, label: 'ana-2' }]);
  const select = view.querySelector('select')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, '8');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
  expect(view.textContent).toContain('Sem consumo medido');
});

test('o ciclo diz o ano uma vez, ou os dois quando passa a passagem de ano', () => {
  expect(cycleLabel('2026-11-05', '2026-12-04')).toBe('05-11 – 04-12-2026');
  expect(cycleLabel('2026-12-15', '2027-01-14')).toBe('15-12-2026 – 14-01-2027');
});
