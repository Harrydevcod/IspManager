/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { CustomerPortal } from './CustomerPortal';

const id = 'a'.repeat(64);

async function mount(fetch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetch);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<CustomerPortal clientId={1} />); });
  const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  const cleanup = async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); };
  return { host, button, cleanup };
}

test('mostra o link novo para copiar só depois de publicado, e o link ativo para revogar', async () => {
  let published = false;
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') { published = true; return new Response(JSON.stringify({ url: `https://relay.example/customer/${id}#secret`, id, expiresAt: Date.now() + 10000 }), { status: 201 }); }
    if (init?.method === 'DELETE') { published = false; return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify(published ? [{ id, expiresAt: Date.now() + 10000, publishedAt: '2026-11-16 12:00:00', revokedAt: null }] : []), { status: 200 });
  });
  const { host, button, cleanup } = await mount(fetch);
  try {
    expect(host.querySelector('input')).toBeNull();
    await act(async () => { button('Criar link')?.click(); });
    expect(host.querySelector('input')?.value).toBe(`https://relay.example/customer/${id}#secret`);
    expect(host.textContent).toContain('Ativo');
    await act(async () => { button('Revogar')?.click(); });
    expect(fetch.mock.calls.some(([url, init]) => init?.method === 'DELETE' && String(url).endsWith(`/portal-links/${id}`))).toBe(true);
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).not.toContain('Revogar');
  } finally { await cleanup(); }
});

test('uma falha do relé mostra o erro e não mostra link', async () => {
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => init?.method === 'POST'
    ? new Response(JSON.stringify({ error: 'Configure o relé antes de criar o link.' }), { status: 409 })
    : new Response('[]', { status: 200 }));
  const { host, button, cleanup } = await mount(fetch);
  try {
    await act(async () => { button('Criar link')?.click(); });
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain('Configure o relé antes de criar o link.');
  } finally { await cleanup(); }
});
