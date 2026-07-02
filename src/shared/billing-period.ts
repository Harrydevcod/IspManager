export const DEFAULT_POSTPAID_BILLING_DAY = 30;

function monthKey(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}`;
}

export function defaultPostpaidReferenceMonth(
  now: Date = new Date(),
  billingDay: number = DEFAULT_POSTPAID_BILLING_DAY
): string {
  if (now.getDate() >= billingDay) {
    return monthKey(now.getFullYear(), now.getMonth());
  }
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return monthKey(previous.getFullYear(), previous.getMonth());
}
