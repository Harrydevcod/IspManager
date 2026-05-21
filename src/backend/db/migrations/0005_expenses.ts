import type { Migration } from './types';

/**
 * Operational expenses ledger.
 *
 * Captures non-equipment outflows (rent, salaries, bandwidth, marketing,
 * licences, taxes, fuel, ...) so the dashboard can plot net profit
 * (revenue - expenses) over the calendar year. Equipment costs already
 * live in `stock_movements.unit_cost_cve` and are not duplicated here.
 *
 * Hard-delete is allowed (these are not fiscal documents). Audit log
 * records every mutation via the standard route handlers.
 */
const migration: Migration = {
  version: 5,
  name: 'expenses',
  sql: `
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK(category IN (
        'equipamento','infraestrutura','salarios','marketing',
        'impostos','licencas','combustivel','banda_internet','outros'
      )) DEFAULT 'outros',
      description TEXT NOT NULL,
      amount_cve REAL NOT NULL CHECK(amount_cve >= 0),
      expense_date TEXT NOT NULL,
      reference_month TEXT NOT NULL,
      supplier TEXT,
      invoice_reference TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
    CREATE INDEX IF NOT EXISTS idx_expenses_month ON expenses(reference_month);
    CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
  `
};

export default migration;
