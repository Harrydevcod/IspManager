import type { Migration } from './types';

/**
 * Recurring expense templates.
 *
 * A row generates one expense per month on `day_of_month`, idempotent — the
 * recurring cron checks `last_generated_month` before inserting to avoid
 * duplicates. Templates can carry the same allocation hint columns as
 * expenses so a salary template can pin itself to a zone if useful.
 *
 * Set `active = 0` to pause without losing history.
 */
const migration: Migration = {
  version: 10,
  name: 'expense_templates',
  sql: `
    CREATE TABLE IF NOT EXISTS expense_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN (
        'equipamento','infraestrutura','salarios','marketing',
        'impostos','licencas','combustivel','banda_internet',
        'aluguer','energia','manutencao','deslocacoes','reparacoes',
        'outros'
      )) DEFAULT 'outros',
      amount_cve REAL NOT NULL CHECK(amount_cve >= 0),
      day_of_month INTEGER NOT NULL CHECK(day_of_month BETWEEN 1 AND 28) DEFAULT 1,
      supplier TEXT,
      notes TEXT,
      investment_id INTEGER REFERENCES investments(id),
      zone TEXT,
      client_id INTEGER REFERENCES clients(id),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      last_generated_month TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_expense_templates_active ON expense_templates(active);
  `
};

export default migration;
