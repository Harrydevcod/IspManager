import { describe, expect, test } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createPortalCapability, createPortalSecret, derivePortalLink, encryptPortalSnapshot, decryptPortalSnapshot } from './customer-portal-crypto';

describe('customer portal snapshot encryption', () => {
  test('a fresh capability decrypts its snapshot and another cannot', () => {
    const capability = createPortalCapability();
    const other = createPortalCapability();
    const snapshot = { balanceCents: 12345, generatedAt: '2026-11-16T12:00:00Z' };
    const envelope = encryptPortalSnapshot(capability, snapshot);
    expect(JSON.stringify(envelope)).not.toContain('12345');
    expect(decryptPortalSnapshot(capability, envelope)).toEqual(snapshot);
    expect(() => decryptPortalSnapshot(other, envelope)).toThrow();
  });

  test('rejects an altered ciphertext and never reuses a nonce', () => {
    const capability = createPortalCapability();
    const a = encryptPortalSnapshot(capability, { balanceCents: 1 });
    const b = encryptPortalSnapshot(capability, { balanceCents: 1 });
    expect(a.nonce).not.toBe(b.nonce);
    const bytes = Buffer.from(a.ciphertext, 'base64url');
    bytes[0] ^= 1;
    expect(() => decryptPortalSnapshot(capability, { ...a, ciphertext: bytes.toString('base64url') })).toThrow();
  });
  test('o link curto: o browser deriva o mesmo id e a mesma chave do segredo de 22 caracteres', async () => {
    const secret = createPortalSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const { id, key } = derivePortalLink(secret);
    expect(derivePortalLink(secret)).toEqual({ id, key });
    expect(derivePortalLink(createPortalSecret()).id).not.toBe(id);
    const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`ispm-portal-id:${secret}`))).toString('hex');
    const ikm = await webcrypto.subtle.importKey('raw', Buffer.from(secret, 'base64url'), 'HKDF', false, ['deriveBits']);
    const bits = await webcrypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('ispm-portal-key') }, ikm, 256);
    expect(digest).toBe(id);
    expect(Buffer.from(bits).toString('base64url')).toBe(key);
    for (const bad of ['', 'curto', `${secret}x`, `${secret.slice(0, 21)}=`]) expect(() => derivePortalLink(bad)).toThrow();
  });

  test('the browser Web Crypto API can open the desktop envelope', async () => {
    const capability = createPortalCapability();
    const envelope = encryptPortalSnapshot(capability, { customerName: 'Ana' });
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(capability, 'base64url'), 'AES-GCM', false, ['decrypt']);
    const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.nonce, 'base64url'),
      additionalData: Buffer.from('ispm-customer-portal:1'), tagLength: 128 }, key,
      Buffer.concat([Buffer.from(envelope.ciphertext, 'base64url'), Buffer.from(envelope.tag, 'base64url')]));
    expect(JSON.parse(Buffer.from(plain).toString('utf8'))).toEqual({ customerName: 'Ana' });
  });
});
