export const DEFAULT_POSTPAID_BILLING_DAY = 30;

/**
 * Chave de competência da fatura de instalação: fixa, não é `YYYY-MM`.
 *
 * Vive aqui e não no backend porque o ecrã também precisa dela: os relatórios
 * agrupam por competência e esta chave caía no `formatPtMonth`, que não sabe
 * ler um mês nela e devolvia "-". Uma linha sem nome não é um mês vazio.
 */
export const INSTALLATION_FEE_REFERENCE = 'INSTALACAO';

/** O nome legível de uma competência, mês ou chave fixa. */
export function referenceMonthLabel(
  value: string,
  formatMonth: (value: string) => string
): string {
  return value === INSTALLATION_FEE_REFERENCE ? 'Instalação' : formatMonth(value);
}

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
