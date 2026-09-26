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

  test('a chave entregue copia-se para a área de transferência e nunca para o armazenamento', async () => {
    const key = 'ISPM-TEST-RECOVERY-KEY';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => ({
      ok: true,
      json: async () => (String(input).endsWith('/recovery-key') ? { recoveryKey: key } : { status: 'recovery_pending' })
    })));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<StrictMode><VaultPanel /></StrictMode>));

    const password = host.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, 'segredo');
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(host.querySelector('.vault-recovery-key')?.textContent).toBe(key);

    const copy = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Copiar')!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith(key);
    expect(copy.textContent).toBe('Copiada');
    expect(JSON.stringify({ ...localStorage })).not.toContain(key);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(key);
    await act(async () => root.unmount());
    host.remove();
  });
});
