import type { Migration } from './types';

/**
 * Expand the expenses category CHECK constraint.
 *
 * SQLite does not let us ALTER a CHECK constraint, so we rebuild the table
 * preserving every row + the v8 allocation columns (investment_id, zone,
 * client_id) and the v5 base columns. New categories: aluguer, energia,
 * manutencao, deslocacoes, reparacoes.
 *
 * Indexes are recreated to match v5 + v8.
 */
const migration: Migration = {
  version: 9,
  name: 'expense_categories',
  sql: `
    CREATE TABLE expenses_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK(category IN (
        'equipamento','infraestrutura','salarios','marketing',
        'impostos','licencas','combustivel','banda_internet',
        'aluguer','energia','manutencao','deslocacoes','reparacoes',
        'outros'
      )) DEFAULT 'outros',
      description TEXT NOT NULL,
      amount_cve REAL NOT NULL CHECK(amount_cve >= 0),
      expense_date TEXT NOT NULL,
      reference_month TEXT NOT NULL,
      supplier TEXT,
      invoice_reference TEXT,
      notes TEXT,
      investment_id INTEGER REFERENCES investments(id),
      zone TEXT,
      client_id INTEGER REFERENCES clients(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER REFERENCES users(id)
    );

    INSERT INTO expenses_new (
      id, category, description, amount_cve, expense_date, reference_month,
      supplier, invoice_reference, notes,
      investment_id, zone, client_id,
      created_at, updated_at, created_by
    )
    SELECT
      id, category, description, amount_cve, expense_date, reference_month,
      supplier, invoice_reference, notes,
      investment_id, zone, client_id,
      created_at, updated_at, created_by
    FROM expenses;

    DROP TABLE expenses;
    ALTER TABLE expenses_new RENAME TO expenses;

    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
    CREATE INDEX IF NOT EXISTS idx_expenses_month ON expenses(reference_month);
    CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
    CREATE INDEX IF NOT EXISTS idx_expenses_investment ON expenses(investment_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_zone ON expenses(zone);
    CREATE INDEX IF NOT EXISTS idx_expenses_client ON expenses(client_id);
  `
};

export default migration;
