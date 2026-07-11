export const SMS_REPORT_TIMEZONE = 'Atlantic/Cape_Verde';

export type SmsReportMonthRange = {
  startUtc: string;
  endUtc: string;
};

function formatSqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function capeVerdeMonthBoundary(year: number, monthIndex: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, 1);
  date.setUTCHours(1, 0, 0, 0);
  return date;
}

export function smsReportMonthUtcRange(month: string): SmsReportMonthRange | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return {
    startUtc: formatSqliteUtc(capeVerdeMonthBoundary(year, monthIndex)),
    endUtc: formatSqliteUtc(capeVerdeMonthBoundary(year, monthIndex + 1))
  };
}

export function currentSmsReportMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SMS_REPORT_TIMEZONE,
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Cape Verde month is unavailable');
  return `${year}-${month}`;
}
