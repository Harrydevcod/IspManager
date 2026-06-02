import { describe, expect, test } from 'vitest';
import { computeIncompleteFlags, findDuplicateGroups, normalizeNameKey, normalizePhoneKey, type DqClient } from './data-quality';

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

function client(over: Partial<DqClient>): DqClient {
  return {
    id: 1, clientCode: 'CLT-0001', fullName: 'Ana Lima',
    phone: '9912233', nif: '123456789', address: 'Rua A',
    island: 'Santiago', zone: 'Praia', status: 'active',
    hasActiveService: 1, ...over
  };
}

describe('computeIncompleteFlags', () => {
  test('flags missing phone', () => {
    expect(computeIncompleteFlags(client({ phone: null }))).toContain('noPhone');
  });
  test('flags active client with no active service', () => {
    expect(computeIncompleteFlags(client({ hasActiveService: 0 }))).toContain('noActiveService');
  });
  test('does NOT flag cancelled client with no active service', () => {
    expect(computeIncompleteFlags(client({ status: 'cancelled', hasActiveService: 0 })))
      .not.toContain('noActiveService');
  });
  test('flags missing address when zone is empty', () => {
    expect(computeIncompleteFlags(client({ zone: '' }))).toContain('noAddress');
  });
  test('flags missing nif', () => {
    expect(computeIncompleteFlags(client({ nif: null }))).toContain('noNif');
  });
  test('complete client has no flags', () => {
    expect(computeIncompleteFlags(client({}))).toEqual([]);
  });
});

describe('findDuplicateGroups', () => {
  test('groups by normalized phone', () => {
    const groups = findDuplicateGroups([
      client({ id: 1, phone: '991 22 33' }),
      client({ id: 2, fullName: 'Outro Nome', phone: '+238 9912233' })
    ], new Set());
    const phoneGroup = groups.find((g) => g.reason === 'phone');
    expect(phoneGroup?.clients.map((c) => c.id).sort()).toEqual([1, 2]);
  });
  test('groups by normalized name regardless of token order/accents', () => {
    const groups = findDuplicateGroups([
      client({ id: 1, fullName: 'João Silva', phone: '111' }),
      client({ id: 2, fullName: 'Silva, joao', phone: '222' })
    ], new Set());
    const nameGroup = groups.find((g) => g.reason === 'name');
    expect(nameGroup?.clients.map((c) => c.id).sort()).toEqual([1, 2]);
  });
  test('excludes a dismissed pair (2-client group disappears)', () => {
    const groups = findDuplicateGroups([
      client({ id: 1, phone: '991 22 33' }),
      client({ id: 2, fullName: 'Outro', phone: '+238 9912233' })
    ], new Set(['1-2']));
    expect(groups.find((g) => g.reason === 'phone')).toBeUndefined();
  });
  test('ignores clients with no key', () => {
    const groups = findDuplicateGroups([
      client({ id: 1, phone: null, fullName: '' }),
      client({ id: 2, phone: null, fullName: '' })
    ], new Set());
    expect(groups).toEqual([]);
  });
  test('keeps a 3-member group when only one pair is dismissed', () => {
    const groups = findDuplicateGroups([
      client({ id: 1, fullName: 'Joao Silva', phone: '111' }),
      client({ id: 2, fullName: 'Silva Joao', phone: '222' }),
      client({ id: 3, fullName: 'silva, joao', phone: '333' })
    ], new Set(['1-2']));
    const nameGroup = groups.find((g) => g.reason === 'name');
    // pair (1,2) dismissed, but (1,3) and (2,3) are not → all three remain
    expect(nameGroup?.clients.map((c) => c.id).sort()).toEqual([1, 2, 3]);
  });
});
