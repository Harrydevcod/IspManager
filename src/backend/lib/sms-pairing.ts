import { createECDH, createHash, createHmac, hkdfSync, randomBytes, randomUUID, type ECDH } from 'node:crypto';
import os from 'node:os';
import { createSmsSignature, timingSafeEqualString } from './sms-signing';
import { discoverCompanionHosts } from './sms-outbox';

/**
 * Pareamento v2 (ADR 0023): o QR leva só material público e de uso único. O
 * segredo HMAC sai de ECDH P-256 + HKDF nos dois lados e nunca viaja; um código
 * de 6 dígitos igual nos dois ecrãs apanha quem fotografou o QR. O mesmo vetor
 * de teste vive em PairingHandshakeTest.kt.
 */

export const PAIRING_TTL_MS = 120_000;
const FULL_SWEEP_EVERY_MS = 15_000;
const PROBE_TIMEOUT_MS = 700;

const b64url = (buf: Buffer) => buf.toString('base64url');

/** S (hex, como o segredo v1) e o código de confirmação, a partir do ECDH. */
export function derivePairingKeys(shared: Buffer, token: Buffer): { secret: string; sas: string } {
  const secret = Buffer.from(hkdfSync('sha256', shared, token, 'ispm-pair-v2/hmac', 32)).toString('hex');
  const sasBytes = Buffer.from(hkdfSync('sha256', shared, token, 'ispm-pair-v2/sas', 4));
  return { secret, sas: String(sasBytes.readUInt32BE(0) % 1_000_000).padStart(6, '0') };
}

/** Prova do telemóvel de que leu ESTE QR: só quem tem S a calcula. */
export function offerMac(secret: string, desktopPub: Buffer, phonePub: Buffer): string {
  return createHmac('sha256', secret).update(`offer\n${b64url(desktopPub)}\n${b64url(phonePub)}`).digest('hex');
}

export function tokenHash(token: Buffer): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

type Found = { baseUrl: string; secret: string; sas: string; model: string };

type Session = {
  ecdh: ECDH;
  desktopPub: Buffer;
  token: Buffer;
  expiresAt: number;
  found: Found | null;
  knownHosts: string[];
  lastSweepAt: number;
  probing: boolean;
};

let session: Session | null = null;

export function startPairingSession(now = Date.now()): { qrPayload: string; expiresAt: string } {
  const ecdh = createECDH('prime256v1');
  const desktopPub = ecdh.generateKeys();
  const token = randomBytes(16);
  session = { ecdh, desktopPub, token, expiresAt: now + PAIRING_TTL_MS, found: null, knownHosts: [], lastSweepAt: 0, probing: false };
  const qrPayload = `ispm-sms://pair?v=2&k=${b64url(desktopPub)}&t=${b64url(token)}&n=${encodeURIComponent(os.hostname())}`;
  return { qrPayload, expiresAt: new Date(session.expiresAt).toISOString() };
}

export function cancelPairingSession() {
  session = null;
}

export type PairingSessionView =
  | { state: 'idle' }
  | { state: 'waiting' | 'expired'; expiresAt: string }
  | { state: 'found'; sas: string; model: string; expiresAt: string };

/** O estado para o ecrã; enquanto espera, lança (sem esperar) mais uma procura na rede. */
export function readPairingSession(now = Date.now()): PairingSessionView {
  if (!session) return { state: 'idle' };
  const expiresAt = new Date(session.expiresAt).toISOString();
  if (session.found) return { state: 'found', sas: session.found.sas, model: session.found.model, expiresAt };
  if (now >= session.expiresAt) return { state: 'expired', expiresAt };
  if (!session.probing) void probeOnce(session);
  return { state: 'waiting', expiresAt };
}

async function probeOnce(current: Session) {
  current.probing = true;
  try {
    const sweep = current.knownHosts.length === 0 || Date.now() - current.lastSweepAt > FULL_SWEEP_EVERY_MS;
    if (sweep) {
      current.knownHosts = await discoverCompanionHosts({ timeoutMs: PROBE_TIMEOUT_MS });
      current.lastSweepAt = Date.now();
    }
    for (const baseUrl of current.knownHosts) {
      const found = await askForOffer(current, baseUrl);
      if (found && session === current) {
        current.found = found;
        return;
      }
    }
  } finally {
    current.probing = false;
  }
}

async function askForOffer(current: Session, baseUrl: string): Promise<Found | null> {
  try {
    const response = await fetch(`${baseUrl}/pair/offer?th=${tokenHash(current.token)}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return null;
    const offer = (await response.json()) as { pub?: unknown; mac?: unknown; model?: unknown };
    if (typeof offer.pub !== 'string' || typeof offer.mac !== 'string') return null;
    const phonePub = Buffer.from(offer.pub, 'base64url');
    const shared = current.ecdh.computeSecret(phonePub);
    const { secret, sas } = derivePairingKeys(shared, current.token);
    // Quem respondeu sem ter lido este QR não sabe calcular o MAC: ignora-se.
    if (!timingSafeEqualString(offerMac(secret, current.desktopPub, phonePub), offer.mac)) return null;
    const model = typeof offer.model === 'string' && offer.model.trim() ? offer.model.trim().slice(0, 80) : 'Telemóvel';
    return { baseUrl, secret, sas, model };
  } catch {
    return null;
  }
}

/**
 * O operador viu o mesmo código nos dois ecrãs: o telemóvel grava S (pedido
 * assinado com ele) e só depois o desktop o devolve para gravar.
 */
export async function confirmPairingSession(): Promise<{ ok: true; found: Found } | { ok: false; error: string; status: number }> {
  const current = session;
  if (!current?.found) return { ok: false, status: 409, error: 'Nenhum telemóvel à espera de confirmação.' };
  const { baseUrl, secret } = current.found;
  const path = '/pair/confirm';
  const body = JSON.stringify({ th: tokenHash(current.token), desktop: os.hostname() });
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-ispm-timestamp': timestamp,
        'x-ispm-nonce': nonce,
        'x-ispm-signature': createSmsSignature({ secret, method: 'POST', path, timestamp, nonce, body })
      },
      body,
      signal: AbortSignal.timeout(3500)
    });
    // Os dois ecrãs têm de concordar: o telemóvel só grava depois do "Coincide" lá.
    if (response.status === 409) return { ok: false, status: 409, error: 'Toque em "Coincide" no telemóvel e confirme de novo.' };
    if (!response.ok) return { ok: false, status: 502, error: 'O telemóvel recusou a confirmação. Leia um QR novo.' };
  } catch {
    return { ok: false, status: 502, error: 'O telemóvel deixou de responder. Confirme que a app está aberta e tente de novo.' };
  }
  session = null;
  return { ok: true, found: current.found };
}
