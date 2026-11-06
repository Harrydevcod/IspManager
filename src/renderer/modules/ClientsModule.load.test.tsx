/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import { ClientsModule } from './ClientsModule';

afterEach(() => { vi.unstubAllGlobals(); });

test('falha de rede ao carregar clientes é legível e permite tentar de novo', async () => {
  let attempts = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) return Response.json({ setupRequired: false, authBypassed: true });
    if (url.endsWith('/api/clients')) {
      attempts++;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return Response.json([]);
    }
    if (url.endsWith('/api/fup/usage')) return Response.json({ usage: [], thresholds: { aviso: 80, limitacao: 100 } });
    return Response.json([]);
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<AuthProvider><ToastProvider><ConfirmProvider><ClientsModule /></ConfirmProvider></ToastProvider></AuthProvider>); });
    expect(container.textContent).toContain('Não foi possível carregar os clientes.');
    expect(container.textContent).not.toContain('Failed to fetch');
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Tentar de novo'));
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    expect(attempts).toBe(2);
    expect(container.textContent).not.toContain('Não foi possível carregar os clientes.');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
