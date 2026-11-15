import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export type RelayDirection = 'request' | 'response';
export type RelayEnvelope = { version: 1; expiresAt: number; nonce: string; ciphertext: string; tag: string };
const DOMAIN = 'ispm-sms-relay/v1';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LIFETIME_MS = 6 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** v2 stores a 32-byte secret as hexadecimal; each purpose gets a distinct key. */
export function deriveRelayKeys(secret: string) {
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('Pareamento v2 invalido');
  const ikm = Buffer.from(secret, 'hex');
  const derive = (purpose: string) => Buffer.from(hkdfSync('sha256', ikm, Buffer.from(DOMAIN), Buffer.from(`${DOMAIN}/${purpose}`), 32));
  return { mailbox: derive('mailbox'), desktop: derive('desktop-access'), phone: derive('phone-access'), request: derive('request-key'), response: derive('response-key') };
}

function aad(mailbox: Buffer, direction: RelayDirection, id: string, expiresAt: number): Buffer {
  if (!UUID.test(id) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !['request', 'response'].includes(direction)) throw new Error('Envelope invalido');
  return Buffer.from(`${DOMAIN}\n${mailbox.toString('hex')}\n${direction}\n${id}\n${expiresAt}`, 'utf8');
}

function decode(value: string, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Envelope invalido');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length > maxBytes || decoded.toString('base64url') !== value) throw new Error('Envelope invalido');
  return decoded;
}

export function sealRelayEnvelope(secret: string, direction: RelayDirection, id: string, expiresAt: number, plaintext: Buffer): RelayEnvelope {
  if (plaintext.length > MAX_BYTES) throw new Error('Mensagem demasiado grande');
  const keys = deriveRelayKeys(secret);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys[direction], nonce);
  cipher.setAAD(aad(keys.mailbox, direction, id, expiresAt));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { version: 1, expiresAt, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

export function openRelayEnvelope(secret: string, direction: RelayDirection, id: string, envelope: RelayEnvelope, now = Date.now()): Buffer {
  if (!envelope || envelope.version !== 1 || !Number.isSafeInteger(now) || !Number.isSafeInteger(envelope.expiresAt) || envelope.expiresAt <= now || envelope.expiresAt > now + MAX_LIFETIME_MS) throw new Error('Envelope expirado ou invalido');
  const keys = deriveRelayKeys(secret);
  const nonce = decode(envelope.nonce, 12);
  const tag = decode(envelope.tag, 16);
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('Envelope invalido');
  const ciphertext = decode(envelope.ciphertext, MAX_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', keys[direction], nonce);
  decipher.setAAD(aad(keys.mailbox, direction, id, envelope.expiresAt));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
