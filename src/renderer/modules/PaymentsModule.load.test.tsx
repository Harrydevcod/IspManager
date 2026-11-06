/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import { PaymentsModule } from './PaymentsModule';

afterEach(() => { vi.unstubAllGlobals(); });

test('erro HTTP ao carregar pagamentos mantém a página e permite tentar de novo', async () => {
  let attempts = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) return Response.json({ setupRequired: false, authBypassed: true });
    if (url.endsWith('/api/payments')) {
      attempts++;
      return attempts === 1 ? Response.json({ error: 'erro' }, { status: 500 }) : Response.json([]);
    }
    if (url.endsWith('/api/settings')) return Response.json({});
    return Response.json([]);
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<AuthProvider><ToastProvider><ConfirmProvider><PaymentsModule /></ConfirmProvider></ToastProvider></AuthProvider>); });
    expect(container.textContent).toContain('Não foi possível carregar os pagamentos.');
    expect(container.querySelector('.payments-totals')).toBeNull();
    expect(container.textContent).not.toContain('Nenhuma cobrança encontrada');
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Tentar de novo'));
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    expect(attempts).toBe(2);
    expect(container.textContent).not.toContain('Não foi possível carregar os pagamentos.');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
