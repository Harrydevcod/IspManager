import { describe, expect, test } from 'vitest';
import { deriveRelayKeys, openRelayEnvelope, sealRelayEnvelope } from './sms-relay-crypto';

const secret = '0123456789abcdef'.repeat(4);
const id = '00000000-0000-4000-8000-000000000001';
const expiry = 1_800_000_000_000;

describe('relay envelope', () => {
  test('opens the independently generated HKDF and AES-GCM interoperability vector', () => {
    const keys = deriveRelayKeys(secret);
    expect(keys.mailbox.toString('hex')).toBe('334051549c137c0c31eca46d7f6806af84be45a4637deba355317164ddf39c82');
    expect(keys.request.toString('hex')).toBe('a23fc895d405e4f422f9a56ec44949e29531d0944a0f4ebe1fb5c74e6d0741cb');
    expect(openRelayEnvelope(secret, 'request', id, { version: 1, expiresAt: expiry, nonce: 'AAECAwQFBgcICQoL', ciphertext: 'KvLyM2B44jhXgOx1p_VbBwjz-42d', tag: 'JT6yVllBiZ5TxrFKD6KVcg' }, expiry - 1).toString()).toBe('Olá, pedido de teste');
  });
  test('derives distinct domain-separated capabilities and keys', () => {
    const keys = deriveRelayKeys(secret);
    expect(new Set(Object.values(keys).map((value) => value.toString('hex'))).size).toBe(5);
    expect(deriveRelayKeys(secret)).toEqual(keys);
    expect(() => deriveRelayKeys('v1-secret')).toThrow();
  });

  test('round trips bytes without reusing a nonce', () => {
    const payload = Buffer.from('Olá, pedido de teste');
    const one = sealRelayEnvelope(secret, 'request', id, expiry, payload);
    const two = sealRelayEnvelope(secret, 'request', id, expiry, payload);
    expect(one.nonce).not.toBe(two.nonce);
    expect(openRelayEnvelope(secret, 'request', id, one, expiry - 1)).toEqual(payload);
  });

  test('rejects altered ciphertext, direction, ID, expiry and pairing secret', () => {
    const original = sealRelayEnvelope(secret, 'request', id, expiry, Buffer.from('conteúdo'));
    const cipher = Buffer.from(original.ciphertext, 'base64url');
    cipher[0] ^= 1;
    expect(() => openRelayEnvelope(secret, 'request', id, { ...original, ciphertext: cipher.toString('base64url') }, expiry - 1)).toThrow();
    expect(() => openRelayEnvelope(secret, 'response', id, original, expiry - 1)).toThrow();
    expect(() => openRelayEnvelope(secret, 'request', '00000000-0000-4000-8000-000000000002', original, expiry - 1)).toThrow();
    expect(() => openRelayEnvelope(secret, 'request', id, { ...original, expiresAt: expiry + 1 }, expiry - 1)).toThrow();
    expect(() => openRelayEnvelope('f'.repeat(64), 'request', id, original, expiry - 1)).toThrow();
    expect(() => openRelayEnvelope(secret, 'request', id, original, expiry)).toThrow();
  });
});
