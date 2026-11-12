/** Regras do acordo de pagamento partilhadas pelo servidor e pela pré-visualização no ecrã. */

export const MIN_INSTALLMENTS = 2;
export const MAX_INSTALLMENTS = 12;
/** Dias depois do vencimento de uma prestação antes de o acordo cair em atraso (decisão do utilizador, 2026-11-12). */
export const PLAN_GRACE_DAYS = 3;

/** Prestações em escudos inteiros; a última absorve o resto (e os centavos), para somar o total exato. */
export function splitInstallments(totalCve: number, count: number): number[] {
  const totalCentavos = Math.round(totalCve * 100);
  const base = Math.floor(totalCentavos / count / 100) * 100;
  const amounts = Array.from({ length: count }, () => base / 100);
  amounts[count - 1] = (totalCentavos - base * (count - 1)) / 100;
  return amounts;
}

/** Mesmo dia nos meses seguintes; num mês mais curto, o último dia dele (31/01 → 28/02). */
export function monthlyDueDates(firstDueDate: string, count: number): string[] {
  const [y, m, d] = firstDueDate.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const month = m - 1 + i;
    const year = y + Math.floor(month / 12);
    const monthIndex = ((month % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
  });
}
