import { getSqliteDatabase } from '../db/database';
import { generateMonthlyBilling } from './billing';
import { DEFAULT_POSTPAID_BILLING_DAY, defaultPostpaidReferenceMonth } from '../../shared/billing-period';

const LAST_RUN_KEY = 'lastAutoBillingMonth';
// Dia do mês a partir do qual o mês é considerado fechado e faturável.
// A fatura emitida no fecho do mês (ou início do mês seguinte) tem como
// competência o mês que terminou — modelo pós-pago (arrears).
const DEFAULT_BILLING_DAY = DEFAULT_POSTPAID_BILLING_DAY;

function monthKey(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}`;
}

/**
 * O mês fechado mais recente faturável à data `now`:
 *  - se já chegámos ao `billingDay` deste mês → este mês está fechado;
 *  - caso contrário → o último mês fechado é o anterior (ex.: emitir a 3 de Julho
 *    fecha Junho, nunca Julho — "emitida no início do mês seguinte refere-se ao
 *    mês anterior").
 * Cobre Fevereiro (sem dia 30): a 27/Fev o alvo recai em Janeiro; Fevereiro é
 * faturado já em Março (mês anterior a Março).
 */
const latestClosedBillableMonth = defaultPostpaidReferenceMonth;

/** Meses estritamente após `last` até `target` (inclusive), por ordem ascendente. */
function monthsAfter(last: string, target: string): string[] {
  const months: string[] = [];
  const [ly, lm] = last.split('-').map(Number);
  let year = ly;
  let month0 = lm - 1; // 0-based; começamos no mês de `last` e avançamos antes de incluir
  // Avança um mês de cada vez até alcançar `target`.
  for (let guard = 0; guard < 600; guard += 1) {
    month0 += 1;
    if (month0 > 11) {
      month0 = 0;
      year += 1;
    }
    const key = monthKey(year, month0);
    months.push(key);
    if (key === target) return months;
    if (key > target) break; // ultrapassou (last já estava à frente do alvo)
  }
  return [];
}

function readSetting(key: string): string | null {
  const db = getSqliteDatabase();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(key: string, value: string): void {
  const db = getSqliteDatabase();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

export type AutoBillingResult =
  | { skipped: true; reason: string }
  | { ran: true; months: string[]; created: number; activeServices: number };

/**
 * Gera automaticamente, no fecho do mês, as faturas do(s) mês(es) já fechado(s):
 *  - calcula o mês fechado mais recente (`latestClosedBillableMonth`) a partir de
 *    `autoBillingDay` (default 30);
 *  - fatura todos os meses por faturar entre `lastAutoBillingMonth` e esse alvo,
 *    por ordem ascendente — recupera meses perdidos (app desktop pode não abrir no
 *    dia 30) sem deixar gaps;
 *  - numa instalação nova (`lastAutoBillingMonth` nulo) fatura só o alvo, não
 *    retroage histórico.
 *
 * Idempotente: usa o mesmo caminho de inserção do endpoint manual, idempotente por
 * `(service_id, reference_month)`. Seguro em cada arranque do backend.
 */
export function runMonthlyBillingIfDue(now: Date = new Date()): AutoBillingResult {
  const billingDayRaw = readSetting('autoBillingDay');
  const billingDay = Number(billingDayRaw) > 0 ? Number(billingDayRaw) : DEFAULT_BILLING_DAY;

  const target = latestClosedBillableMonth(now, billingDay);
  const lastRun = readSetting(LAST_RUN_KEY);

  if (lastRun === target) {
    return { skipped: true, reason: `faturacao automatica ja executada ate ${target}` };
  }

  // Instalação nova: fatura apenas o alvo. Caso contrário, recupera o intervalo
  // (last, target]. Se `last` já estiver à frente do alvo, `monthsAfter` devolve [].
  const months = lastRun ? monthsAfter(lastRun, target) : [target];
  if (months.length === 0) {
    return { skipped: true, reason: `ultimo mes faturado (${lastRun}) ja a frente do alvo ${target}` };
  }

  const db = getSqliteDatabase();
  let created = 0;
  let activeServices = 0;
  for (const month of months) {
    const result = generateMonthlyBilling(db, month);
    created += result.created;
    activeServices = result.activeServices;
  }
  writeSetting(LAST_RUN_KEY, target);

  return { ran: true, months, created, activeServices };
}
