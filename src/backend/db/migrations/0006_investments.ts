import type { Migration } from './types';

/**
 * ISP investment control.
 *
 * Tracks capital and operational investment initiatives with line items
 * (equipment, materials, labour, installation and maintenance). Totals are
 * stored per investment so dashboard aggregation stays cheap and predictable.
 */
const migration: Migration = {
  version: 6,
  name: 'investments',
  sql: `
    CREATE TABLE IF NOT EXISTS investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'cliente','zona','equipamento','infraestrutura','manutencao','expansao','outro'
      )) DEFAULT 'outro',
      client_id INTEGER REFERENCES clients(id),
      zone TEXT,
      description TEXT,
      investment_date TEXT NOT NULL,
      reference_month TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'planeado','em_execucao','ativo','recuperado','cancelado'
      )) DEFAULT 'ativo',
      expected_monthly_revenue_cve REAL NOT NULL DEFAULT 0 CHECK(expected_monthly_revenue_cve >= 0),
      total_cost_cve REAL NOT NULL DEFAULT 0 CHECK(total_cost_cve >= 0),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS investment_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL CHECK(item_type IN (
        'antena','router','cpe','switch','cabo','conector','fibra','caixa',
        'poste','ups','bateria','ferramenta','material','instalacao',
        'mao_obra','manutencao','outro'
      )) DEFAULT 'outro',
      item_name TEXT NOT NULL,
      quantity REAL NOT NULL CHECK(quantity > 0),
      unit_cost_cve REAL NOT NULL CHECK(unit_cost_cve >= 0),
      total_cost_cve REAL NOT NULL CHECK(total_cost_cve >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_investments_month ON investments(reference_month);
    CREATE INDEX IF NOT EXISTS idx_investments_date ON investments(investment_date);
    CREATE INDEX IF NOT EXISTS idx_investments_type ON investments(type);
    CREATE INDEX IF NOT EXISTS idx_investments_client ON investments(client_id);
    CREATE INDEX IF NOT EXISTS idx_investments_zone ON investments(zone);
    CREATE INDEX IF NOT EXISTS idx_investment_items_investment ON investment_items(investment_id);
  `
};

export default migration;
