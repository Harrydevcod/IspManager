import { describe, expect, test } from 'vitest';
import { formatPtDate, formatPtMonth } from './date';

describe('pt-PT date formatting', () => {
  test('formats ISO dates as dd/mm/yyyy', () => {
    expect(formatPtDate('2026-06-10')).toBe('10/06/2026');
  });

  test('formats ISO months as mm/yyyy', () => {
    expect(formatPtMonth('2026-06')).toBe('06/2026');
  });

  test('uses stable fallback for missing or invalid values', () => {
    expect(formatPtDate(null)).toBe('-');
    expect(formatPtDate('invalid')).toBe('-');
    expect(formatPtMonth(undefined)).toBe('-');
    expect(formatPtMonth('invalid')).toBe('-');
  });
});
