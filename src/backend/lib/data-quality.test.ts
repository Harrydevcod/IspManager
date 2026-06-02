import { describe, expect, test } from 'vitest';
import { normalizeNameKey, normalizePhoneKey } from './data-quality';

describe('normalizePhoneKey', () => {
  test('keeps only digits', () => {
    expect(normalizePhoneKey('991 22 33')).toBe('9912233');
  });
  test('strips the 238 country prefix', () => {
    expect(normalizePhoneKey('+238 9912233')).toBe('9912233');
  });
  test('returns null for empty input', () => {
    expect(normalizePhoneKey('')).toBeNull();
    expect(normalizePhoneKey(null)).toBeNull();
  });
});

describe('normalizeNameKey', () => {
  test('strips accents, lowercases, collapses spaces', () => {
    expect(normalizeNameKey('João  Silva')).toBe('joao silva');
  });
  test('sorts tokens so order does not matter', () => {
    expect(normalizeNameKey('Silva, João')).toBe('joao silva');
  });
  test('returns null for empty input', () => {
    expect(normalizeNameKey('   ')).toBeNull();
    expect(normalizeNameKey(null)).toBeNull();
  });
});
