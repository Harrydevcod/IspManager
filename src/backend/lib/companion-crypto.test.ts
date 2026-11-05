import { describe, expect, test } from 'vitest';
import { appSupportsSealed, openPayload, payloadForApp, sealPayload, type SealedEnvelope } from './companion-crypto';
import type { CompanionSnapshot } from './companion-snapshot';

// The same vector is decrypted in android-sms-companion (SealedSnapshotTest.kt).
const VECTOR = {
  secret: 'segredo-de-teste',
  iv: 'AQIDBAUGBwgJCgsM',
  plaintext: '{"schemaVersion":1,"companyName":"Teste"}',
  data: 'g8h06HbYC4pX0lrlwBcc9ajUiTEtUMENMHyQNBUfQ2vUJJ3SKx+ARNzhFcg6xn8/smo/PdWmTWtW'
};

const snapshot = {
  schemaVersion: 1,
  companyName: 'Skynet',
  money: { paidMonthCve: 1, debtors: [{ clientName: 'Ana', phone: '+2389912233' }], cashToday: { totalCve: 5 }, monthlyReceipts: [] },
  work: { orders: [{ address: 'Rua 1' }], tickets: [] }
} as unknown as CompanionSnapshot;

describe('companion-crypto', () => {
  test('matches the vector the Android app decrypts', () => {
    expect(sealPayload(VECTOR.plaintext, VECTOR.secret, Buffer.from(VECTOR.iv, 'base64'))).toEqual({ enc: 'aes-256-gcm', iv: VECTOR.iv, data: VECTOR.data });
  });

  test('round-trips, and a fresh IV every time', () => {
    const a = sealPayload('olá', 's');
    const b = sealPayload('olá', 's');
    expect(a.iv).not.toBe(b.iv);
    expect(openPayload(a, 's')).toBe('olá');
  });

  test('another pairing secret or a tampered body cannot be opened', () => {
    const sealed = sealPayload('olá', 's');
    expect(() => openPayload(sealed, 'outro')).toThrow();
    const raw = Buffer.from(sealed.data, 'base64');
    raw[0] ^= 1;
    expect(() => openPayload({ ...sealed, data: raw.toString('base64') }, 's')).toThrow();
  });

  test('versions that can decrypt', () => {
    expect(appSupportsSealed('0.5.0')).toBe(true);
    expect(appSupportsSealed('0.10.1')).toBe(true);
    expect(appSupportsSealed('0.4.0')).toBe(false);
    expect(appSupportsSealed(null)).toBe(false);
  });

  test('0.5.0+: everything, sealed — no phone or address readable on the wire', () => {
    const payload = payloadForApp(snapshot, true, 'k') as SealedEnvelope;
    expect(payload.enc).toBe('aes-256-gcm');
    expect(JSON.stringify(payload)).not.toContain('2389912233');
    expect(JSON.parse(openPayload(payload, 'k')).work.orders[0].address).toBe('Rua 1');
  });

  test('older app: plain as before, without the new fields that carry phones and addresses', () => {
    const payload = payloadForApp(snapshot, false, 'k') as Record<string, unknown>;
    const text = JSON.stringify(payload);
    expect(text).not.toContain('2389912233');
    expect(text).not.toContain('Rua 1');
    expect(payload).not.toHaveProperty('work');
    expect(payload).toMatchObject({ companyName: 'Skynet', money: { paidMonthCve: 1 } });
  });
});
