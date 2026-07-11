import { describe, expect, test } from 'vitest';
import { currentSmsReportMonth, smsReportMonthUtcRange } from './sms-report';

describe('smsReportMonthUtcRange', () => {
  test('converts a Cape Verde month to UTC boundaries', () => {
    expect(smsReportMonthUtcRange('2026-07')).toEqual({
      startUtc: '2026-07-01 01:00:00',
      endUtc: '2026-08-01 01:00:00'
    });
  });

  test('rolls December into the next year', () => {
    expect(smsReportMonthUtcRange('2026-12')).toEqual({
      startUtc: '2026-12-01 01:00:00',
      endUtc: '2027-01-01 01:00:00'
    });
  });

  test.each(['', '2026-00', '2026-13', '26-07', '2026-7'])(
    'rejects invalid month %j',
    (month) => expect(smsReportMonthUtcRange(month)).toBeNull()
  );
});

describe('currentSmsReportMonth', () => {
  test('uses the Cape Verde month at a UTC month boundary', () => {
    expect(currentSmsReportMonth(new Date('2026-07-01T00:30:00Z'))).toBe('2026-06');
  });
});
