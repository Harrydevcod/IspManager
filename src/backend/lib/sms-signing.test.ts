import { describe, expect, test } from 'vitest';
import { createResponseSignature, createSmsSignature, timingSafeEqualString, verifyResponseSignature, verifySmsSignature } from './sms-signing';

describe('sms signing', () => {
  test('verifies a valid signature', () => {
    const input = {
      secret: 'super-secret',
      method: 'POST',
      path: '/requests',
      timestamp: '2026-06-04T12:00:00.000Z',
      nonce: 'nonce-1',
      body: '{"hello":"world"}'
    };
    const signature = createSmsSignature(input);
    expect(verifySmsSignature({ ...input, signature, now: new Date('2026-06-04T12:00:30.000Z') })).toBe(true);
  });

  test('rejects expired timestamps', () => {
    const input = {
      secret: 'super-secret',
      method: 'POST',
      path: '/requests',
      timestamp: '2026-06-04T12:00:00.000Z',
      nonce: 'nonce-1',
      body: '{}'
    };
    const signature = createSmsSignature(input);
    expect(verifySmsSignature({ ...input, signature, now: new Date('2026-06-04T12:06:00.000Z') })).toBe(false);
  });

  test('rejects future timestamps outside the skew window', () => {
    const input = {
      secret: 'super-secret',
      method: 'POST',
      path: '/requests',
      timestamp: '2026-06-04T12:06:00.000Z',
      nonce: 'nonce-1',
      body: '{}'
    };
    const signature = createSmsSignature(input);
    expect(verifySmsSignature({ ...input, signature, now: new Date('2026-06-04T12:00:00.000Z') })).toBe(false);
  });

  test('accepts the exact skew boundary', () => {
    const input = {
      secret: 'super-secret',
      method: 'POST',
      path: '/requests',
      timestamp: '2026-06-04T12:00:00.000Z',
      nonce: 'nonce-1',
      body: '{}'
    };
    const signature = createSmsSignature(input);
    expect(verifySmsSignature({ ...input, signature, now: new Date('2026-06-04T12:05:00.000Z') })).toBe(true);
  });

  test('rejects tampered signed fields', () => {
    const input = {
      secret: 'super-secret',
      method: 'POST',
      path: '/requests',
      timestamp: '2026-06-04T12:00:00.000Z',
      nonce: 'nonce-1',
      body: '{"hello":"world"}'
    };
    const signature = createSmsSignature(input);
    const now = new Date('2026-06-04T12:00:30.000Z');

    expect(verifySmsSignature({ ...input, method: 'GET', signature, now })).toBe(false);
    expect(verifySmsSignature({ ...input, path: '/requests/1', signature, now })).toBe(false);
    expect(verifySmsSignature({ ...input, nonce: 'nonce-2', signature, now })).toBe(false);
    expect(verifySmsSignature({ ...input, body: '{"hello":"tampered"}', signature, now })).toBe(false);
  });

  test('rejects malformed signatures and non-canonical timestamps', () => {
    const input = {
      secret: 'super-secret',
      method: 'POST',
      path: '/requests',
      timestamp: '2026-06-04T12:00:00.000Z',
      nonce: 'nonce-1',
      body: '{}'
    };
    const now = new Date('2026-06-04T12:00:30.000Z');

    expect(verifySmsSignature({ ...input, signature: 'abc', now })).toBe(false);
    expect(verifySmsSignature({ ...input, signature: 'z'.repeat(64), now })).toBe(false);
    expect(verifySmsSignature({ ...input, timestamp: '2026-06-04 12:00:00', signature: createSmsSignature({ ...input, timestamp: '2026-06-04 12:00:00' }), now })).toBe(false);
  });

  test('rejects ISO-shaped impossible timestamps', () => {
    const input = {
      secret: 'super-secret',
      method: 'POST',
      path: '/requests',
      timestamp: '2026-02-31T00:00:00.000Z',
      nonce: 'nonce-1',
      body: '{}'
    };
    const signature = createSmsSignature(input);

    expect(verifySmsSignature({ ...input, signature, now: new Date('2026-03-03T00:00:00.000Z') })).toBe(false);
  });

  test('rejects invalid verification timing inputs', () => {
    const input = {
      secret: 'super-secret',
      method: 'POST',
      path: '/requests',
      timestamp: '2026-06-04T12:00:00.000Z',
      nonce: 'nonce-1',
      body: '{}'
    };
    const signature = createSmsSignature(input);

    expect(verifySmsSignature({ ...input, signature, now: new Date(Number.NaN) })).toBe(false);
    expect(verifySmsSignature({ ...input, signature, now: new Date('2026-06-04T12:00:00.000Z'), maxSkewMs: Number.NaN })).toBe(false);
    expect(verifySmsSignature({ ...input, signature, now: new Date('2026-06-04T12:00:00.000Z'), maxSkewMs: Number.POSITIVE_INFINITY })).toBe(false);
    expect(verifySmsSignature({ ...input, signature, now: new Date('2026-06-04T12:00:00.000Z'), maxSkewMs: -1 })).toBe(false);
  });

  test('rejects nonce replay when a nonce claim callback is provided', () => {
    const input = {
      secret: 'super-secret',
      method: 'POST',
      path: '/requests',
      timestamp: '2026-06-04T12:00:00.000Z',
      nonce: 'nonce-1',
      body: '{}'
    };
    const signature = createSmsSignature(input);
    const seen = new Set<string>();
    const claimNonce = (nonce: string) => {
      if (seen.has(nonce)) return false;
      seen.add(nonce);
      return true;
    };
    const now = new Date('2026-06-04T12:00:30.000Z');

    expect(verifySmsSignature({ ...input, signature, now, claimNonce })).toBe(true);
    expect(verifySmsSignature({ ...input, signature, now, claimNonce })).toBe(false);
  });

  test('uses constant-time comparison for equal strings', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
  });
});

describe('response signature (phone → desktop, /events and /media)', () => {
  // Same vector as android-sms-companion ResponseSignatureTest: both sides must agree.
  const VECTOR = { secret: 'segredo-de-teste', nonce: 'nonce-1234', body: '{"events":[]}', signature: 'f9ab63dd1cc695c7658ace95303eafc636a131ebd6c5d126b2d34c8b40537eb3' };

  test('matches the vector shared with the Android app', () => {
    expect(createResponseSignature(VECTOR.secret, VECTOR.nonce, Buffer.from(VECTOR.body))).toBe(VECTOR.signature);
  });

  test('rejects a missing signature, another nonce, another body or another secret', () => {
    const body = Buffer.from(VECTOR.body);
    expect(verifyResponseSignature(VECTOR.secret, VECTOR.nonce, body, VECTOR.signature)).toBe(true);
    expect(verifyResponseSignature(VECTOR.secret, VECTOR.nonce, body, null)).toBe(false);
    expect(verifyResponseSignature(VECTOR.secret, 'outro-nonce', body, VECTOR.signature)).toBe(false);
    expect(verifyResponseSignature(VECTOR.secret, VECTOR.nonce, Buffer.from('{"events":[{}]}'), VECTOR.signature)).toBe(false);
    expect(verifyResponseSignature('outro-segredo', VECTOR.nonce, body, VECTOR.signature)).toBe(false);
  });
});
