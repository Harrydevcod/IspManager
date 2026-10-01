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

function LoadingProbe() {
  const { loading, reload } = useLive('/api/network/router/wan', true, 1_000);
  reloadProbe = reload;
  return <>{loading ? 'A carregar' : 'Pronto'}</>;
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

test('as leituras automáticas não ativam o carregamento, mas reload ativa', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let resolveSecond!: (response: Response) => void;
  const second = new Promise<Response>((resolve) => { resolveSecond = resolve; });
  const response = () => new Response(JSON.stringify({ available: true, sampledAt: 1, interfaces: [] }));
  const fetch = vi.fn()
    .mockResolvedValueOnce(response())
    .mockReturnValueOnce(second)
    .mockImplementation(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<LoadingProbe />); });
    expect(container.textContent).toBe('Pronto');
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('Pronto');
    await act(async () => { resolveSecond(response()); });
    await act(async () => { reloadProbe(); });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(container.textContent).toBe('A carregar');
  } finally {
    await act(async () => { root.unmount(); });
  }
});
