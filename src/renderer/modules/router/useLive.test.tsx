/** @vitest-environment jsdom */

import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { useLive } from './useLive';

function Probe() {
  useLive('/api/network/router/wan', true, 1_000);
  return null;
}

let reloadProbe = () => {};

function SyncProbe() {
  const { syncing, syncedAt, error, reload } = useLive('/api/network/router/wan', true, 1_000);
  reloadProbe = reload;
  return <>{`${syncing ? 'sync' : 'idle'}|${syncedAt ?? '-'}|${error ? 'erro' : 'ok'}`}</>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('não inicia outra leitura enquanto a anterior está pendente', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<StrictMode><Probe /></StrictMode>); });
    const initialReads = fetch.mock.calls.length;
    expect(initialReads).toBe(2);
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(fetch).toHaveBeenCalledTimes(initialReads);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('syncing acompanha cada leitura; syncedAt só avança quando corre bem', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(10_000);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const resolvers: Array<(response: Response) => void> = [];
  const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolvers.push(resolve); }));
  vi.stubGlobal('fetch', fetch);
  const ok = () => new Response(JSON.stringify({ available: true }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<SyncProbe />); });
    expect(container.textContent).toBe('sync|-|ok');
    await act(async () => { resolvers.shift()!(ok()); });
    expect(container.textContent).toBe('idle|10000|ok');

    // Leitura automática: mostra que sincroniza, sem mexer na hora até acabar.
    vi.setSystemTime(11_000);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(container.textContent).toBe('sync|10000|ok');
    await act(async () => { resolvers.shift()!(new Response('', { status: 500 })); });
    expect(container.textContent).toBe('idle|10000|erro');

    // Pedida pelo utilizador: o mesmo estado, e a hora avança quando corre bem.
    vi.setSystemTime(12_500);
    await act(async () => { reloadProbe(); });
    expect(container.textContent).toBe('sync|10000|erro');
    await act(async () => { resolvers.shift()!(ok()); });
    expect(container.textContent).toBe('idle|12500|ok');
  } finally {
    await act(async () => { root.unmount(); });
  }
});
