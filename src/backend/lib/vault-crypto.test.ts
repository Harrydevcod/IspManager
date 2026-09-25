import { randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { encryptValue, decryptValue } from './vault-crypto';

test('credencial preserva bytes e só abre no contexto e chave originais', () => {
  const key = randomBytes(32);
  const plain = '  senha á com espaços  ';
  const stored = encryptValue(key, 'services.pppoe_password', plain);
  expect(stored).not.toContain(plain);
  expect(decryptValue(key, 'services.pppoe_password', stored)).toBe(plain);
  expect(encryptValue(key, 'services.pppoe_password', plain)).not.toBe(stored);
  expect(() => decryptValue(key, 'app_settings.routerosPassword', stored)).toThrow();
  expect(() => decryptValue(randomBytes(32), 'services.pppoe_password', stored)).toThrow();
});

test('rejeita envelopes adulterados, versões desconhecidas e encoding não canónico', () => {
  const key = randomBytes(32);
  const stored = encryptValue(key, 'app_settings.ultraMsgToken', 'segredo');
  for (const value of [stored.replace('v2', 'v9'), stored + ':extra', stored + '=', stored.slice(0, -3), 'x'.repeat(17000)]) {
    expect(() => decryptValue(key, 'app_settings.ultraMsgToken', value)).toThrow();
  }
  const parts = stored.split(':');
  const flipped = Buffer.from(parts[3], 'base64url');
  flipped[0] ^= 1;
  parts[3] = flipped.toString('base64url');
  expect(() => decryptValue(key, 'app_settings.ultraMsgToken', parts.join(':'))).toThrow('DECRYPT_FAILED');
  expect(() => encryptValue(key, 'app_settings.ultraMsgToken', 'x'.repeat(17000))).toThrow();
  expect(() => encryptValue(randomBytes(16), 'app_settings.ultraMsgToken', 'abc')).toThrow();
});
