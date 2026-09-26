import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM com envelope `enc:v2:<nonce>:<tag>:<ct>` (base64url canónico).
 * O contexto entra no AAD como `v2|<tabela.coluna>`: separa domínios (um valor
 * de settings não abre como PPPoE) sem se atar à linha — ver D2 no plano.
 * Os erros nunca incluem o conteúdo.
 */
const MAX_PLAINTEXT_BYTES = 12000;
const MAX_ENVELOPE_CHARS = 16384;

function aad(context: string): Buffer {
  return Buffer.from('v2|' + context, 'utf8');
}

export function encryptValue(key: Buffer, context: string, value: string): string {
  if (key.length !== 32 || !context || Buffer.byteLength(value, 'utf8') > MAX_PLAINTEXT_BYTES) throw new Error('INVALID_SECRET');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['enc', 'v2', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export function decryptValue(key: Buffer, context: string, stored: string): string {
  if (key.length !== 32 || !context || stored.length > MAX_ENVELOPE_CHARS) throw new Error('INVALID_CIPHERTEXT');
  const parts = stored.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v2') throw new Error('INVALID_CIPHERTEXT');
  const [nonce, tag, ciphertext] = parts.slice(2).map(part => {
    const bytes = Buffer.from(part, 'base64url');
    if (!/^[A-Za-z0-9_-]*$/.test(part) || bytes.toString('base64url') !== part) throw new Error('INVALID_CIPHERTEXT');
    return bytes;
  });
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('INVALID_CIPHERTEXT');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('DECRYPT_FAILED');
  }
}
