import { afterEach, describe, expect, test, vi } from 'vitest';
import { createECDH } from 'node:crypto';
import { verifySmsSignature } from './sms-signing';
import { cancelPairingSession, confirmPairingSession, derivePairingKeys, offerMac, readPairingSession, startPairingSession, tokenHash } from './sms-pairing';

const hosts = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('./sms-outbox', () => ({ discoverCompanionHosts: async () => hosts.list }));


// Mesmo vetor em android-sms-companion/.../pairing/PairingHandshakeTest.kt.
const VECTOR = {
  desktopPriv: '2ee1981648919f3b804f650ce831ee2119e2ec2587933e44c8da121298e29e87',
  phonePriv: '1dabc4d56a5bee601f5cf6b62421750eac85b4e1702255e340d014e7de2af6fb',
  desktopPub: 'BLLDVllTSnT_zl6OMuZ5sovQc6eI-vIONr41V4AoRoYVFfHTzbX6qGfBWltHik1t2KvgRr4T2QwZiZV-GcwuBgw',
  phonePub: 'BGX00uurL4I9Lbdsp9JCHzZlQR7Al-zocrrLp6wcuO-xpejO9GZ9eDo7ZIdDF7oCSQfMQW2IHwGAWxJRhyMocHY',
  shared: '7e3f8ef013c7de7634b6e082b2484fc1f18f87fdbcead2307f45a2781d4c9e9c',
  secret: 'd5b4abba5cfad173254fb66d142e953c15a6c189c8c6c02c9d07a317fa70f059',
  sas: '063024',
  mac: 'a50e537a329533418dfcd37b1ec2be153a29604f1188b587a9e3128d2f642648',
  tokenHash: '5dfbabeedf318bf33c0927c43d7630f5'
};
const TOKEN = Buffer.from(Array.from({ length: 16 }, (_, i) => i + 1));

/** Um telemóvel de mentira que lê o QR e responde como a app 0.11. */
function fakePhone(qrPayload: string, opts: { wrongMac?: boolean; confirmStatus?: number; at?: string } = {}) {
  const params = new URL(qrPayload.replace('ispm-sms://', 'http://x/')).searchParams;
  const desktopPub = Buffer.from(params.get('k')!, 'base64url');
  const token = Buffer.from(params.get('t')!, 'base64url');
  const phone = createECDH('prime256v1');
  const phonePub = phone.generateKeys();
  const { secret, sas } = derivePairingKeys(phone.computeSecret(desktopPub), token);
  const confirmed: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.host !== (opts.at ?? '192.168.1.50:8765')) throw new Error('ninguém aqui');
    if (u.pathname === '/pair/offer') {
      if (u.searchParams.get('th') !== tokenHash(token)) return new Response('', { status: 404 });
      const mac = opts.wrongMac ? '00'.repeat(32) : offerMac(secret, desktopPub, phonePub);
      return Response.json({ pub: phonePub.toString('base64url'), mac, model: 'Samsung A15' });
    }
    if (u.pathname === '/pair/confirm') {
      const h = new Headers(init?.headers);
      const ok = verifySmsSignature({
        secret, method: 'POST', path: '/pair/confirm', body: String(init?.body),
        timestamp: h.get('x-ispm-timestamp')!, nonce: h.get('x-ispm-nonce')!, signature: h.get('x-ispm-signature')!
      });
      if (ok) confirmed.push(String(init?.body));
      return new Response('{}', { status: ok ? (opts.confirmStatus ?? 200) : 401 });
    }
    return new Response('', { status: 404 });
  });
  return { fetchMock, secret, sas, confirmed };
}

async function untilFound() {
  for (let i = 0; i < 50; i++) {
    const view = readPairingSession();
    if (view.state !== 'waiting') return view;
    await new Promise((r) => setTimeout(r, 5));
  }
  return readPairingSession();
}

afterEach(() => {
  cancelPairingSession();
  vi.unstubAllGlobals();
  hosts.list = [];
});

describe('pareamento v2', () => {
  test('o vetor partilhado com a app bate', () => {
    const d = createECDH('prime256v1');
    d.setPrivateKey(Buffer.from(VECTOR.desktopPriv, 'hex'));
    const p = createECDH('prime256v1');
    p.setPrivateKey(Buffer.from(VECTOR.phonePriv, 'hex'));
    expect(d.getPublicKey().toString('base64url')).toBe(VECTOR.desktopPub);
    expect(p.getPublicKey().toString('base64url')).toBe(VECTOR.phonePub);
    const shared = d.computeSecret(p.getPublicKey());
    expect(shared.toString('hex')).toBe(VECTOR.shared);
    expect(derivePairingKeys(shared, TOKEN)).toEqual({ secret: VECTOR.secret, sas: VECTOR.sas });
    expect(offerMac(VECTOR.secret, d.getPublicKey(), p.getPublicKey())).toBe(VECTOR.mac);
    expect(tokenHash(TOKEN)).toBe(VECTOR.tokenHash);
  });

  test('o QR não leva segredo nenhum', () => {
    const { qrPayload } = startPairingSession();
    expect(qrPayload).toMatch(/^ispm-sms:\/\/pair\?v=2&k=[\w-]{87}&t=[\w-]{22}&n=/);
    expect(qrPayload).not.toContain('secret=');
  });

  test('encontra o telemóvel que leu o QR, mostra o mesmo código e confirma', async () => {
    hosts.list = ['http://192.168.1.9:8765', 'http://192.168.1.50:8765'];
    const { qrPayload } = startPairingSession();
    const phone = fakePhone(qrPayload);
    vi.stubGlobal('fetch', phone.fetchMock);

    const view = await untilFound();
    expect(view).toMatchObject({ state: 'found', sas: phone.sas, model: 'Samsung A15' });

    const result = await confirmPairingSession();
    expect(result).toMatchObject({ ok: true, found: { baseUrl: 'http://192.168.1.50:8765', secret: phone.secret } });
    expect(phone.confirmed).toHaveLength(1);
    // Uso único: a sessão acabou.
    expect(readPairingSession()).toEqual({ state: 'idle' });
  });

  test('ignora quem responde sem saber o segredo', async () => {
    hosts.list = ['http://192.168.1.50:8765'];
    const { qrPayload } = startPairingSession();
    vi.stubGlobal('fetch', fakePhone(qrPayload, { wrongMac: true }).fetchMock);
    expect((await untilFound()).state).toBe('waiting');
  });

  test('um QR antigo não serve depois de gerar outro', async () => {
    hosts.list = ['http://192.168.1.50:8765'];
    const old = startPairingSession().qrPayload;
    startPairingSession();
    vi.stubGlobal('fetch', fakePhone(old).fetchMock);
    expect((await untilFound()).state).toBe('waiting');
  });

  test('expira ao fim de 2 minutos', () => {
    const now = Date.now();
    startPairingSession(now);
    expect(readPairingSession(now + 119_000).state).toBe('waiting');
    expect(readPairingSession(now + 120_000).state).toBe('expired');
  });

  test('sem telemóvel encontrado, confirmar dá 409', async () => {
    startPairingSession();
    expect(await confirmPairingSession()).toMatchObject({ ok: false, status: 409 });
  });

  test('o telemóvel recusa a confirmação: a sessão fica para tentar outra vez', async () => {
    hosts.list = ['http://192.168.1.50:8765'];
    const { qrPayload } = startPairingSession();
    vi.stubGlobal('fetch', fakePhone(qrPayload, { confirmStatus: 404 }).fetchMock);
    await untilFound();
    expect(await confirmPairingSession()).toMatchObject({ ok: false, status: 502 });
    expect(readPairingSession().state).toBe('found');
  });
});
