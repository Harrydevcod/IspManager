import { getSqliteDatabase } from '../db/database';

/**
 * Generates one expense row per active template for the current month if
 * today's day-of-month is >= the template's day_of_month and the template
 * hasn't already been generated this month. Idempotent.
 *
 * Mirrors the contract of runMonthlyBillingIfDue: safe to call on every
 * backend boot, called once per app start. Returns a summary for logging.
 */
export type RecurringExpenseRun =
  | { skipped: true; reason: string }
  | { ran: true; generated: number; month: string };

export function runRecurringExpensesIfDue(now: Date = new Date()): RecurringExpenseRun {
  const db = getSqliteDatabase();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const monthKey = `${year}-${month}`;
  const today = now.getDate();
  const todayIso = `${monthKey}-${String(today).padStart(2, '0')}`;

  const templates = db.prepare(`
    SELECT id, name, category, amount_centavos / 100.0 AS amountCve, day_of_month AS dayOfMonth,
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
      category, description, amount_centavos, expense_date, reference_month,
      supplier, notes, investment_id, zone, client_id
    ) VALUES (?, ?, CAST(ROUND(? * 100) AS INTEGER), ?, ?, ?, ?, ?, ?, ?)
  `);
  const markGenerated = db.prepare(`
    UPDATE expense_templates SET last_generated_month = ?, updated_at = datetime('now') WHERE id = ?
  `);

  let generated = 0;
  const run = db.transaction(() => {
    for (const t of templates) {
      if (t.lastGeneratedMonth === monthKey) continue;
      if (t.dayOfMonth > today) continue;
      const expenseDate = `${monthKey}-${String(t.dayOfMonth).padStart(2, '0')}`;
      const safeDate = expenseDate > todayIso ? todayIso : expenseDate;
      insertExpense.run(
        t.category,
        `${t.name} (recorrente ${monthKey})`,
        t.amountCve,
        safeDate,
        monthKey,
        t.supplier,
        t.notes,
        t.investmentId,
        t.zone,
        t.clientId
      );
      markGenerated.run(monthKey, t.id);
      generated += 1;
    }
  });
  run();

  if (generated === 0) {
    return { skipped: true, reason: 'all templates already generated or not yet due' };
  }
  return { ran: true, generated, month: monthKey };
}
