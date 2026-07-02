import { describe, expect, test } from 'vitest';
import { defaultPostpaidReferenceMonth } from './billing-period';

describe('defaultPostpaidReferenceMonth', () => {
  test('uses the previous month before the billing day', () => {
    expect(defaultPostpaidReferenceMonth(new Date(2026, 6, 1), 30)).toBe('2026-06');
    expect(defaultPostpaidReferenceMonth(new Date(2026, 5, 29), 30)).toBe('2026-05');
  });

  test('uses the current month on and after the billing day', () => {
    expect(defaultPostpaidReferenceMonth(new Date(2026, 5, 30), 30)).toBe('2026-06');
    expect(defaultPostpaidReferenceMonth(new Date(2026, 6, 30), 30)).toBe('2026-07');
  });
});
