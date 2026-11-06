/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import { PlansModule } from './PlansModule';

afterEach(() => { vi.unstubAllGlobals(); });

test('erro HTTP ao carregar planos mantém a página e permite tentar de novo', async () => {
  let attempts = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith('/api/auth/status')) return Response.json({ setupRequired: false, authBypassed: true });
    if (String(input).endsWith('/api/plans')) {
      attempts++;
      return attempts === 1 ? Response.json({ error: 'erro' }, { status: 500 }) : Response.json([]);
    }
    return Response.json([]);
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<AuthProvider><ToastProvider><PlansModule /></ToastProvider></AuthProvider>); });
    expect(container.textContent).toContain('Não foi possível carregar os planos.');
    expect(container.textContent).not.toContain('Nenhum plano encontrado');
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Tentar de novo'));
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    expect(attempts).toBe(2);
    expect(container.textContent).not.toContain('Não foi possível carregar os planos.');
    expect(container.textContent).toContain('Planos de internet');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
