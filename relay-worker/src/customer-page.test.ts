/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from 'vitest';
import { customerPage, customerScript } from './customer-page';
import { createPortalCapability, createPortalSecret, derivePortalLink, encryptPortalSnapshot } from '../../src/backend/lib/customer-portal-crypto';

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

/** Monta a página, serve o envelope e espera que o script acabe de desenhar. */
async function open(hash: string, response: Response) {
  document.body.innerHTML = new DOMParser().parseFromString(customerPage, 'text/html').body.innerHTML;
  location.hash = hash;
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) => response);
  vi.stubGlobal('fetch', fetch);
  new Function(customerScript)();
  await vi.waitFor(() => expect(document.getElementById('intro')?.textContent).not.toBe('A carregar…'));
  return fetch;
}

test('o instantâneo cifrado pelo ISPM abre no browser com a chave do fragmento (formato antigo, sem empresa)', async () => {
  const key = createPortalCapability();
  const envelope = encryptPortalSnapshot(key, {
    customerName: 'Ana Lopes', customerCode: 'C001', generatedAt: '2026-11-16T12:00:00Z', creditCents: 0,
    invoices: [{ number: 'FT 2026/10', dueDate: '2026-11-20', balanceCents: 250000, services: 'Internet Standard', period: 'outubro de 2026' },
      { number: 'FT 2026/11', dueDate: '2026-11-25', balanceCents: 300000, services: 'instalação', period: 'novembro de 2026' }],
    services: [{ plan: 'Standard', status: 'active' }]
  });
  const fetch = await open(`#${key}`, new Response(JSON.stringify({ envelope, expiresAt: Date.now() + 60_000 })));
  await vi.waitFor(() => expect(document.getElementById('content')?.hidden).toBe(false));
  const text = document.body.textContent ?? '';
  expect(text).toContain('Ana LopesCliente C001');
  expect(text).not.toContain('Prestador');
  expect(text).toContain('Total em aberto: 5.500$00');
  expect(text).toContain('FT 2026/10 · outubro de 2026');
  expect(text).toContain('Internet Standard · vence a 20/11/2026');
  expect(text).toContain('Instalação · vence a 25/11/2026');
  expect(text).toContain('Internet StandardAtivo');
  // A chave fica no fragmento: o pedido ao relé nunca a leva.
  expect(JSON.stringify(fetch.mock.calls)).not.toContain(key);
});

const company = { name: 'NovaTech', nif: '212345678', address: 'Praia', island: 'Santiago', phone: '260 12 34', email: 'geral@novatech.cv' };
async function openSnapshot(snapshot: Record<string, unknown>) {
  const key = createPortalCapability();
  await open(`#${key}`, new Response(JSON.stringify({ envelope: encryptPortalSnapshot(key, snapshot), expiresAt: Date.now() + 60_000 })));
  await vi.waitFor(() => expect(document.getElementById('content')?.hidden).toBe(false));
}

test('a empresa aparece ao lado do cliente, e os contactos e as contas no rodapé', async () => {
  await openSnapshot({ company, customerName: 'Ana Lopes', customerCode: 'C001', customerNif: '123456789', customerAddress: 'Achada Santo António · Santiago',
    generatedAt: '2026-11-16T12:00:00Z', creditCents: 0, services: [],
    invoices: [{ number: 'FT 2026/10', dueDate: '2026-11-20', balanceCents: 250000, services: 'Internet Standard', period: 'outubro de 2026' }],
    bankAccounts: [{ bank: 'BCA', holder: 'NovaTech Lda', account: '0003 0000 12345678901 23', reference: 'C001' }] });
  const [provider, customer] = [...document.querySelectorAll('.party')].map((node) => node.textContent);
  expect(provider).toBe('PrestadorNovaTechNIF 212345678Praia · Santiago');
  expect(customer).toBe('ClienteAna LopesCliente C001NIF 123456789Achada Santo António · Santiago');
  expect(document.querySelector('a[href="tel:2601234"]')?.textContent).toBe('260 12 34');
  expect(document.querySelector('a[href="mailto:geral@novatech.cv"]')).not.toBeNull();
  expect(document.getElementById('pay')?.hidden).toBe(false);
  expect(document.getElementById('banks')?.textContent).toBe('BCA · NovaTech LdaReferência C0010003 0000 12345678901 23');
});

test('sem nada para liquidar não há bloco de pagamento, e um contacto inválido não vira link', async () => {
  await openSnapshot({ company: { ...company, phone: 'javascript:alert(1)', email: 'sem-arroba' }, customerName: 'Rui', customerCode: 'C002',
    generatedAt: '2026-11-16T12:00:00Z', creditCents: 0, services: [], invoices: [], bankAccounts: [] });
  expect(document.getElementById('pay')?.hidden).toBe(true);
  expect(document.querySelectorAll('#contact a')).toHaveLength(0);
  expect(document.getElementById('contact')?.textContent).toBe('NovaTech');
});

test('link curto: do segredo de 22 caracteres saem o id do pedido e a chave', async () => {
  const secret = createPortalSecret();
  const { id, key } = derivePortalLink(secret);
  const envelope = encryptPortalSnapshot(key, { customerName: 'Ana Lopes', customerCode: 'C001', generatedAt: '2026-11-16T12:00:00Z',
    creditCents: 0, invoices: [], services: [] });
  const fetch = await open(`#${secret}`, new Response(JSON.stringify({ envelope, expiresAt: Date.now() + 60_000 })));
  await vi.waitFor(() => expect(document.getElementById('content')?.hidden).toBe(false));
  expect(document.body.textContent).toContain('Ana Lopes');
  expect(fetch.mock.calls[0][0]).toBe(`/customer/${id}/snapshot`);
  for (const value of [secret, key]) expect(JSON.stringify(fetch.mock.calls)).not.toContain(value);
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
