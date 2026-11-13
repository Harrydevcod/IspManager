/**
 * O dia do negócio é o de Cabo Verde, onde o ISP trabalha: um recibo das 23:30 é desse dia, não
 * do seguinte. Antes cada sítio escolhia — `todayIso()` em UTC, o SQLite com `date('now')` (UTC),
 * o Stripe e alguns meses no relógio do PC — e entre as 23:00 e a meia-noite discordavam.
 *
 * Cabo Verde está em UTC−1 o ano inteiro (sem hora de verão), por isso basta um desvio fixo, que
 * serve igual ao JS e ao SQLite e não depende do fuso configurado no PC nem no CI.
 * Exceção: o consumo das WAN conta em UTC porque a conta Starlink conta assim (`wan-usage.ts`).
 */
export const CAPE_VERDE_UTC_OFFSET_HOURS = -1;

const OFFSET_MS = CAPE_VERDE_UTC_OFFSET_HOURS * 3_600_000;

/** `AAAA-MM-DD` do dia em Cabo Verde no instante dado (por omissão, agora). */
export function businessDay(at: Date | number = new Date()): string {
  return new Date(new Date(at).getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** `AAAA-MM` do mês em Cabo Verde no instante dado. */
export function businessMonth(at: Date | number = new Date()): string {
  return businessDay(at).slice(0, 7);
}

/** Ano em Cabo Verde no instante dado. */
export function businessYear(at: Date | number = new Date()): number {
  return Number(businessDay(at).slice(0, 4));
}

/**
 * O mesmo dia em SQL: `date('now', '-1 hours', …modificadores)`. O SQLite lê o relógio em UTC;
 * o desvio põe-no em Cabo Verde antes de cortar ao dia.
 */
export function sqlBusinessDate(...modifiers: string[]): string {
  return `date(${["'now'", `'${CAPE_VERDE_UTC_OFFSET_HOURS} hours'`, ...modifiers].join(', ')})`;
}

/** `date('now', '-1 hours')`: hoje em Cabo Verde, para comparar com colunas de data. */
export const SQL_BUSINESS_TODAY = sqlBusinessDate();

/** Hora (0–23) em Cabo Verde no instante dado. */
export function businessHour(at: Date | number = new Date()): number {
  return new Date(new Date(at).getTime() + OFFSET_MS).getUTCHours();
}

/** Os avisos automáticos ao cliente só saem a partir desta hora de Cabo Verde, nunca de madrugada. */
export const NOTICE_SEND_FROM_HOUR = 8;

/**
 * O dia do corte automático: o job suspende quando `vencimento + tolerância < hoje`, ou seja, a
 * partir de vencimento + tolerância + 1. Um corte já vencido (o router adiou) é hoje, nunca uma
 * data passada.
 */
export function cutDate(dueDate: string, graceDays: number, today: string = businessDay()): string {
  const [y, m, d] = dueDate.slice(0, 10).split('-').map(Number);
  const cut = new Date(Date.UTC(y, m - 1, d + graceDays + 1)).toISOString().slice(0, 10);
  return cut < today ? today : cut;
}
