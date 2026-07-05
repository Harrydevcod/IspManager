import { getSqliteDatabase } from '../db/database';

/**
 * Generates one expense row per active template per month due. Catch-up sem
 * gaps (mesmo contrato de runMonthlyBillingIfDue): se a app não abrir durante
 * um mês, os meses em falta desde last_generated_month são gerados no arranque
 * seguinte — senão o OPEX ficava subavaliado para sempre e os lucros
 * inflacionados. Template novo (nunca gerado) só gera o mês corrente, não
 * retroage. O mês corrente só gera quando day_of_month já passou. Idempotente.
 */
export type RecurringExpenseRun =
  | { skipped: true; reason: string }
  | { ran: true; generated: number; month: string };

/** Meses AAAA-MM em (last, target], ascendente. */
function monthsAfter(last: string, target: string): string[] {
  const out: string[] = [];
  let [y, m] = last.split('-').map(Number);
  const [ty, tm] = target.split('-').map(Number);
  while (y < ty || (y === ty && m < tm)) {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (out.length > 120) break; // salvaguarda: 10 anos
  }
  return out;
}

export function runRecurringExpensesIfDue(now: Date = new Date()): RecurringExpenseRun {
  const db = getSqliteDatabase();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const monthKey = `${year}-${month}`;
  const today = now.getDate();
  const todayIso = `${monthKey}-${String(today).padStart(2, '0')}`;

  const templates = db.prepare(`
    SELECT id, name, category, amount_cve AS amountCve, day_of_month AS dayOfMonth,
           supplier, notes,
           investment_id AS investmentId, zone, client_id AS clientId,
           last_generated_month AS lastGeneratedMonth
    FROM expense_templates
    WHERE active = 1
  `).all() as Array<{
    id: number; name: string; category: string; amountCve: number; dayOfMonth: number;
    supplier: string | null; notes: string | null;
    investmentId: number | null; zone: string | null; clientId: number | null;
    lastGeneratedMonth: string | null;
  }>;

  if (templates.length === 0) {
    return { skipped: true, reason: 'no active templates' };
  }

  const insertExpense = db.prepare(`
    INSERT INTO expenses (
      category, description, amount_cve, expense_date, reference_month,
      supplier, notes, investment_id, zone, client_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const markGenerated = db.prepare(`
    UPDATE expense_templates SET last_generated_month = ?, updated_at = datetime('now') WHERE id = ?
  `);

  let generated = 0;
  const run = db.transaction(() => {
    for (const t of templates) {
      if (t.lastGeneratedMonth === monthKey) continue;
      // Catch-up: todos os meses em falta desde a última geração; template
      // novo só o mês corrente (não retroagir, espelho da faturação).
      const targets = t.lastGeneratedMonth ? monthsAfter(t.lastGeneratedMonth, monthKey) : [monthKey];
      let lastDone: string | null = null;
      for (const targetMonth of targets) {
        // Mês corrente só quando o dia do template já passou; meses fechados
        // geram sempre (o dia já passou por definição).
        if (targetMonth === monthKey && t.dayOfMonth > today) continue;
        const expenseDate = `${targetMonth}-${String(t.dayOfMonth).padStart(2, '0')}`;
        const safeDate = expenseDate > todayIso ? todayIso : expenseDate;
        insertExpense.run(
          t.category,
          `${t.name} (recorrente ${targetMonth})`,
          t.amountCve,
          safeDate,
          targetMonth,
          t.supplier,
          t.notes,
          t.investmentId,
          t.zone,
          t.clientId
        );
        lastDone = targetMonth;
        generated += 1;
      }
      if (lastDone) markGenerated.run(lastDone, t.id);
    }
  });
  run();

  if (generated === 0) {
    return { skipped: true, reason: 'all templates already generated or not yet due' };
  }
  return { ran: true, generated, month: monthKey };
}
