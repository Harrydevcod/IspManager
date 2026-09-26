// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthProvider } from '../lib/auth';
import { announceVaultChanged, VaultBanner } from './VaultBanner';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** `role: null` = autenticação desligada (o sistema entra como admin). */
function stubBackend(role: 'admin' | 'operator' | null, vault: () => unknown) {
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) return json({ setupRequired: false, authBypassed: role === null });
    if (url.endsWith('/api/auth/me')) return json({ user: { id: 1, username: 'u', fullName: 'Utilizador', role } });
    if (url.endsWith('/api/vault/status')) return json(vault());
    return json({});
  });
  vi.stubGlobal('fetch', fetcher);
  if (role) localStorage.setItem('ispm:auth-token', 'token');
  return fetcher;
}

async function mount(onOpen = vi.fn()) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<StrictMode><AuthProvider><VaultBanner onOpen={onOpen} /></AuthProvider></StrictMode>));
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  localStorage.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('VaultBanner', () => {
  test('pede ao admin que guarde a chave enquanto a recuperação está pendente, e abre o cofre', async () => {
    stubBackend('admin', () => ({ status: 'recovery_pending' }));
    const onOpen = vi.fn();
    const host = await mount(onOpen);
    expect(host.querySelector('.shell-banner-warn')?.textContent).toContain('Guarde a chave de recuperação do cofre');
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('cofre trancado ou credenciais por converter é aviso de erro', async () => {
    stubBackend(null, () => ({ status: 'locked' }));
    const host = await mount();
    expect(host.querySelector('.shell-banner-danger')?.textContent).toContain('O cofre está trancado');
    expect(host.querySelector('button')?.textContent).toBe('Desbloquear');
  });

  test('cofre pronto ou ausente não mostra nada', async () => {
    let status = 'ready';
    stubBackend('admin', () => ({ status }));
    const host = await mount();
    expect(host.querySelector('.shell-banner')).toBeNull();
    status = 'absent';
    await act(async () => announceVaultChanged());
    expect(host.querySelector('.shell-banner')).toBeNull();
  });

  test('quem não é admin não vê o aviso nem consulta o cofre', async () => {
    const fetcher = stubBackend('operator', () => ({ status: 'recovery_pending' }));
    const host = await mount();
    expect(host.querySelector('.shell-banner')).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/api/vault/status'))).toBe(false);
  });

  test('volta a ler quando o painel do cofre muda o estado', async () => {
    let status = 'recovery_pending';
    stubBackend('admin', () => ({ status }));
    const host = await mount();
    expect(host.querySelector('.shell-banner')).not.toBeNull();
    status = 'ready';
    await act(async () => announceVaultChanged());
    expect(host.querySelector('.shell-banner')).toBeNull();
  });
});
