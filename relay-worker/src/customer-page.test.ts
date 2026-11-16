/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from 'vitest';
import { customerPage, customerScript } from './customer-page';
import { createPortalCapability, encryptPortalSnapshot } from '../../src/backend/lib/customer-portal-crypto';

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

/** Monta a página, serve o envelope e espera que o script acabe de desenhar. */
async function open(hash: string, response: Response) {
  document.body.innerHTML = new DOMParser().parseFromString(customerPage, 'text/html').body.innerHTML;
  location.hash = hash;
  const fetch = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetch);
  new Function(customerScript)();
  await vi.waitFor(() => expect(document.getElementById('intro')?.textContent).not.toBe('A carregar…'));
  return fetch;
}

test('o instantâneo cifrado pelo ISPM abre no browser com a chave do fragmento', async () => {
  const key = createPortalCapability();
  const envelope = encryptPortalSnapshot(key, {
    customerName: 'Ana Lopes', customerCode: 'C001', generatedAt: '2026-11-16T12:00:00Z', creditCents: 0,
    invoices: [{ number: 'FT 2026/10', dueDate: '2026-11-20', balanceCents: 250000, services: 'Internet Standard', period: 'outubro de 2026' }],
    services: [{ plan: 'Standard', status: 'active' }]
  });
  const fetch = await open(`#${key}`, new Response(JSON.stringify({ envelope, expiresAt: Date.now() + 60_000 })));
  await vi.waitFor(() => expect(document.getElementById('content')?.hidden).toBe(false));
  const text = document.body.textContent ?? '';
  expect(text).toContain('Ana Lopes · C001');
  expect(text).toContain('Total em aberto: 2.500$00');
  expect(text).toContain('FT 2026/10 · outubro de 2026');
  expect(text).toContain('Internet Standard · vence a 20/11/2026');
  expect(text).toContain('Internet StandardAtivo');
  // A chave fica no fragmento: o pedido ao relé nunca a leva.
  expect(JSON.stringify(fetch.mock.calls)).not.toContain(key);
});

test('chave errada, link expirado e chave em falta não mostram dados', async () => {
  const envelope = encryptPortalSnapshot(createPortalCapability(), { customerName: 'Ana' });
  await open(`#${createPortalCapability()}`, new Response(JSON.stringify({ envelope, expiresAt: Date.now() + 60_000 })));
  expect(document.getElementById('error')?.textContent).toContain('Não foi possível abrir a conta');
  expect(document.body.textContent).not.toContain('Ana');

  await open(`#${createPortalCapability()}`, new Response(null, { status: 404 }));
  expect(document.getElementById('error')?.textContent).toContain('expirou');

  await open('', new Response(null, { status: 404 }));
  expect(document.getElementById('error')?.textContent).toContain('incompleto');
});
