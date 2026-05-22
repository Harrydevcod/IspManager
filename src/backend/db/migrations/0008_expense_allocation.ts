import type { Migration } from './types';

/**
 * Expense allocation columns.
 *
 * An OPEX entry may be directly tied to an investment, a zone, or a single
 * client. When set, the amount is attributed 100% to that target instead of
 * entering the company-wide pro-rata pool. SQLite ALTER TABLE accepts the
 * FOREIGN KEY clause syntactically but does not enforce it — that is fine,
 * the route handlers validate ids before insert.
 */
const migration: Migration = {
  version: 8,
  name: 'expense_allocation',
  sql: `
    ALTER TABLE expenses ADD COLUMN investment_id INTEGER REFERENCES investments(id);
    ALTER TABLE expenses ADD COLUMN zone TEXT;
    ALTER TABLE expenses ADD COLUMN client_id INTEGER REFERENCES clients(id);

    CREATE INDEX IF NOT EXISTS idx_expenses_investment ON expenses(investment_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_zone ON expenses(zone);
    CREATE INDEX IF NOT EXISTS idx_expenses_client ON expenses(client_id);
  `
};

export default migration;
