/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConfigBackups, type ConfigSnapshots } from './ConfigBackups';

const data: ConfigSnapshots = {
  checkedAt: '2026-10-02T09:00:00.000Z',
  snapshots: [
    { id: 2, takenAt: '2026-10-02T08:00:00.000Z', routerosVersion: '7.24.2', lines: 5, addedLines: 3, removedLines: 1 },
    { id: 1, takenAt: '2026-10-01T08:00:00.000Z', routerosVersion: '7.24.2', lines: 3, addedLines: 0, removedLines: 0 }
  ]
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function mount(fetchMock: ReturnType<typeof vi.fn>, onChanged = vi.fn()) {
  vi.stubGlobal('fetch', fetchMock);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<ConfigBackups data={data} onChanged={onChanged} />));
  return { host, root, onChanged };
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('abrir uma cópia mostra só o que mudou face à anterior', async () => {
  const fetchMock = vi.fn(async () => json({
    id: 2, takenAt: '2026-10-02T08:00:00.000Z',
    content: '/ip dns\nset servers=8.8.8.8', previousContent: '/ip dns\nset servers=1.1.1.1'
  }));
  const { host, root } = await mount(fetchMock);
  expect(host.querySelectorAll('[role="columnheader"]')).toHaveLength(5);

  await act(async () => [...host.querySelectorAll<HTMLElement>('[role="row"]')][1].click());
  await flush();
  const diff = document.querySelector('[aria-label="Diferenças face à cópia anterior"]');
  expect(diff?.textContent).toContain('+ set servers=8.8.8.8');
  expect(diff?.textContent).toContain('− set servers=1.1.1.1');
  expect(diff?.textContent).not.toContain('/ip dns');
  await act(async () => root.unmount());
});

test('copiar agora diz quando não há alterações e recarrega a lista', async () => {
  const { host, root, onChanged } = await mount(vi.fn(async () => json({ stored: false })));
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Copiar agora')!;
  await act(async () => button.click());
  await flush();
  expect(host.textContent).toContain('Sem alterações desde a última cópia.');
  expect(onChanged).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

test('copiar agora mostra o erro do router', async () => {
  const { host, root } = await mount(vi.fn(async () => json({ error: 'Router inacessível.' }, 502)));
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Copiar agora')!;
  await act(async () => button.click());
  await flush();
  expect(host.textContent).toContain('Router inacessível.');
  await act(async () => root.unmount());
});
