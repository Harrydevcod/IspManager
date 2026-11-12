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

export type ScheduleEntry = { dueDate: string; amountCve: number };

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * O calendário é o que se combinou com o cliente: valores e datas livres, mas tem de cobrir a dívida
 * exata (senão "cumprido" mente) e andar para a frente no tempo. Devolve o motivo da recusa, ou null.
 */
export function scheduleError(schedule: ScheduleEntry[], totalCve: number, today: string): string | null {
  if (schedule.length < MIN_INSTALLMENTS || schedule.length > MAX_INSTALLMENTS) {
    return `Entre ${MIN_INSTALLMENTS} e ${MAX_INSTALLMENTS} prestações`;
  }
  for (const [i, entry] of schedule.entries()) {
    if (!isIsoDate(entry.dueDate)) return `Data da prestação ${i + 1} inválida`;
    if (i === 0 && entry.dueDate < today) return 'A 1.ª prestação não pode ser no passado';
    if (i > 0 && entry.dueDate <= schedule[i - 1].dueDate) return 'As datas das prestações têm de ser crescentes';
    if (!(entry.amountCve > 0) || Math.abs(entry.amountCve * 100 - Math.round(entry.amountCve * 100)) > 1e-6) {
      return `Valor da prestação ${i + 1} inválido`;
    }
  }
  const sumCentavos = schedule.reduce((sum, entry) => sum + Math.round(entry.amountCve * 100), 0);
  if (sumCentavos !== Math.round(totalCve * 100)) return 'A soma das prestações tem de ser igual à dívida';
  return null;
}
