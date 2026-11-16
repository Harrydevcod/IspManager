import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export type PortalEnvelope = { version: 1; nonce: string; ciphertext: string; tag: string };

/** A chave pertence ao link do cliente e nunca deve ser enviada ao relé. */
export function createPortalCapability(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * O segredo do link curto: 128 bits, 22 caracteres. Vai no fragmento (`/c#<segredo>`) e dele
 * saem o id que o relé conhece e a chave AES que só o browser usa. O browser faz a mesma
 * derivação (relay-worker/src/customer-page.ts).
 */
export function createPortalSecret(): string {
  return randomBytes(16).toString('base64url');
}

export function derivePortalLink(secret: string): { id: string; key: string } {
  if (!/^[A-Za-z0-9_-]{22}$/.test(secret)) throw new Error('Segredo inválido');
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 16 || bytes.toString('base64url') !== secret) throw new Error('Segredo inválido');
  // Rótulos diferentes e funções de sentido único: quem tem o id não chega à chave.
  const id = createHash('sha256').update(`ispm-portal-id:${secret}`).digest('hex');
  const key = Buffer.from(hkdfSync('sha256', bytes, Buffer.alloc(0), 'ispm-portal-key', 32)).toString('base64url');
  return { id, key };
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
