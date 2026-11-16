import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type PortalEnvelope = { version: 1; nonce: string; ciphertext: string; tag: string };

/** A chave pertence ao link do cliente e nunca deve ser enviada ao relé. */
export function createPortalCapability(): string {
  return randomBytes(32).toString('base64url');
}

function keyFor(capability: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error('Chave inválida');
  const key = Buffer.from(capability, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== capability) throw new Error('Chave inválida');
  return key;
}

export function encryptPortalSnapshot(capability: string, snapshot: unknown): PortalEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(capability), nonce);
  cipher.setAAD(Buffer.from('ispm-customer-portal:1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot), 'utf8'), cipher.final()]);
  return { version: 1, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

export function decryptPortalSnapshot(capability: string, envelope: PortalEnvelope): unknown {
  if (envelope.version !== 1) throw new Error('Versão inválida');
  const nonce = Buffer.from(envelope.nonce, 'base64url');
  const tag = Buffer.from(envelope.tag, 'base64url');
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('Envelope inválido');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(capability), nonce);
  decipher.setAAD(Buffer.from('ispm-customer-portal:1'));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}
