import { expect, test } from 'vitest';
import { isMacAddress, normalizeMacAddress } from './mac';

test('canonicalizes whatever separator the equipment or the person used', () => {
  expect(normalizeMacAddress('9c:47:82:30:34:9b')).toBe('9C:47:82:30:34:9B');
  expect(normalizeMacAddress('9C-47-82-30-34-9B')).toBe('9C:47:82:30:34:9B');
  expect(normalizeMacAddress('9c47.8230.349b')).toBe('9C:47:82:30:34:9B');
  expect(normalizeMacAddress('  9c47 8230 349b  '.replace(/ /g, ''))).toBe('9C:47:82:30:34:9B');
});

test('empty is nothing, and nonsense comes back untouched for the validator to refuse', () => {
  expect(normalizeMacAddress('')).toBeNull();
  expect(normalizeMacAddress('   ')).toBeNull();
  expect(normalizeMacAddress(null)).toBeNull();

  // Curto de mais, longo de mais, e o que nem hexadecimal é.
  expect(isMacAddress(normalizeMacAddress('9C:47:82:30:34') as string)).toBe(false);
  expect(isMacAddress(normalizeMacAddress('9C:47:82:30:34:9B:CD') as string)).toBe(false);
  expect(isMacAddress(normalizeMacAddress('bananeira') as string)).toBe(false);
});
