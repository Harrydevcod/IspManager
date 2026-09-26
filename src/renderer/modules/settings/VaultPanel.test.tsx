// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { VaultPanel } from './VaultPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => vi.unstubAllGlobals());

describe('VaultPanel', () => {
  test('consulta apenas o estado ao montar em StrictMode', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'recovery_pending' }) });
    vi.stubGlobal('fetch', fetcher);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<StrictMode><VaultPanel /></StrictMode>));
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/api/vault/status'))).toBe(true);
    expect(host.textContent).not.toContain('ISPM-');
    await act(async () => root.unmount());
  });
});
