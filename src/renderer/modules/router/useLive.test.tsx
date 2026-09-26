/** @vitest-environment jsdom */

import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { useLive } from './useLive';

function Probe() {
  useLive('/api/network/router/wan', true, 1_000);
  return null;
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
