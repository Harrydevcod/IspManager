import { describe, expect, test } from 'vitest';
import { canonicalNib } from './nib';

describe('canonicalNib', () => {
  test('tira os separadores com que o NIB foi escrito ou colado', () => {
    expect(canonicalNib('0003 0000 1234 5678 9012 3')).toBe('000300001234567890123');
    expect(canonicalNib('0003.0000.1234.5678.9012.3')).toBe('000300001234567890123');
    expect(canonicalNib('0003-0000-1234-5678-9012-3')).toBe('000300001234567890123');
  });

  test('o que ja e so digitos fica igual', () => {
    expect(canonicalNib('000300001234567890123')).toBe('000300001234567890123');
  });

  test('sem digitos nao ha NIB', () => {
    expect(canonicalNib('')).toBeNull();
    expect(canonicalNib('   ')).toBeNull();
    expect(canonicalNib(null)).toBeNull();
    expect(canonicalNib(undefined)).toBeNull();
  });
});
