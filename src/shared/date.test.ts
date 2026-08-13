import { describe, expect, test } from 'vitest';
import { formatPtDate, formatPtDateTime, formatPtDayMonth, formatPtMonth } from './date';

describe('pt-PT date formatting', () => {
  test('formats ISO dates as dd-mm-yyyy', () => {
    expect(formatPtDate('2026-06-10')).toBe('10-06-2026');
  });

  test('formats datetime input down to the date only', () => {
    expect(formatPtDate('2026-06-10T14:30:00')).toBe('10-06-2026');
  });

  test('formats ISO months as mm-yyyy', () => {
    expect(formatPtMonth('2026-06')).toBe('06-2026');
  });

  test('formats day and month only', () => {
    expect(formatPtDayMonth('2026-06-10')).toBe('10-06');
  });

  test('formats local datetime with date and 24h time', () => {
    const formatted = formatPtDateTime('2026-06-10T14:30:00');
    expect(formatted.startsWith('10-06-2026')).toBe(true);
    expect(formatted).toContain('14:30');
  });

  test('keeps the time of a SQLite timestamp, read as UTC', () => {
    // datetime('now') escreve 'AAAA-MM-DD hh:mm:ss' em UTC; o tempo não se perde.
    const formatted = formatPtDateTime('2026-08-13 05:14:56');
    const expected = new Intl.DateTimeFormat('pt-PT', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date('2026-08-13T05:14:56Z')).replace(/\//g, '-');
    expect(formatted).toBe(expected);
    expect(formatted).not.toContain('00:00');
  });

  test('uses stable fallback for missing or invalid values', () => {
    expect(formatPtDate(null)).toBe('-');
    expect(formatPtDate('invalid')).toBe('-');
    expect(formatPtDateTime(null)).toBe('-');
    expect(formatPtDayMonth('invalid')).toBe('-');
    expect(formatPtMonth(undefined)).toBe('-');
    expect(formatPtMonth('invalid')).toBe('-');
  });
});
