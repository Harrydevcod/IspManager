import type { Migration } from './types';

/**
 * Money storage migrates from `*_cve REAL` (floating point) to integer
 * `*_centavos` (1 escudo CVE = 100 centavos). Float money drifts in sums, VAT,
 * proportional allocations and ROI; integer centavos are exact. See the money
 * toolkit in src/shared/money.ts and the PR description.
 *
 * Conversion is `ROUND(value * 100)` — historical amounts are whole escudos so
 * this is lossless, and any stray fractional REAL is rounded to the centavo.
 *
 * Two techniques:
 *  - Tables WITHOUT a CHECK on the money column use surgical ADD → UPDATE →
 *    DROP COLUMN (SQLite 3.35+). The new column lands at the end of the table;
 *    every reader/writer uses explicit column names, so order is irrelevant.
 *  - Tables WITH a `CHECK(col >= 0)` on the money column (investments,
 *    investment_items, expenses, expense_templates) cannot DROP that column —
 *    SQLite refuses while a CHECK references it — so they are rebuilt with the
 *    standard create → copy → drop → rename pattern, the CHECK re-pointed at the
 *    new `*_centavos` column. The migration runner disables foreign_keys for the
 *    duration and runs `PRAGMA foreign_key_check` before COMMIT, and ids are
 *    copied verbatim, so child references (investment_items, expenses,
 *    expense_templates → investments) stay valid.
 *
 * The API contract stays in escudos: routes convert at the boundary
 * (`*_centavos / 100.0 AS *Cve` on read, `ROUND(? * 100)` on write), so the
 * renderer and the existing test assertions are unchanged.
 */
const migration: Migration = {
  version: 21,
  name: 'money_centavos',
  sql: `
    -- ---- simple tables: ADD → UPDATE → DROP per money column ----------------

    ALTER TABLE internet_plans ADD COLUMN monthly_price_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE internet_plans SET monthly_price_centavos = CAST(ROUND(monthly_price_cve * 100) AS INTEGER);
    ALTER TABLE internet_plans DROP COLUMN monthly_price_cve;
    ALTER TABLE internet_plans ADD COLUMN installation_fee_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE internet_plans SET installation_fee_centavos = CAST(ROUND(installation_fee_cve * 100) AS INTEGER);
    ALTER TABLE internet_plans DROP COLUMN installation_fee_cve;

    ALTER TABLE services ADD COLUMN monthly_value_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE services SET monthly_value_centavos = CAST(ROUND(monthly_value_cve * 100) AS INTEGER);
    ALTER TABLE services DROP COLUMN monthly_value_cve;
    ALTER TABLE services ADD COLUMN audiovisual_monthly_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE services SET audiovisual_monthly_centavos = CAST(ROUND(audiovisual_monthly_cve * 100) AS INTEGER);
    ALTER TABLE services DROP COLUMN audiovisual_monthly_cve;
    ALTER TABLE services ADD COLUMN audiovisual_annual_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE services SET audiovisual_annual_centavos = CAST(ROUND(audiovisual_annual_cve * 100) AS INTEGER);
    ALTER TABLE services DROP COLUMN audiovisual_annual_cve;

    ALTER TABLE stock_movements ADD COLUMN unit_cost_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE stock_movements SET unit_cost_centavos = CAST(ROUND(unit_cost_cve * 100) AS INTEGER);
    ALTER TABLE stock_movements DROP COLUMN unit_cost_cve;

    ALTER TABLE payments ADD COLUMN amount_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE payments SET amount_centavos = CAST(ROUND(amount_cve * 100) AS INTEGER);
    ALTER TABLE payments DROP COLUMN amount_cve;

    ALTER TABLE equipment_catalog ADD COLUMN purchase_price_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE equipment_catalog SET purchase_price_centavos = CAST(ROUND(purchase_price_cve * 100) AS INTEGER);
    ALTER TABLE equipment_catalog DROP COLUMN purchase_price_cve;
    ALTER TABLE equipment_catalog ADD COLUMN shipping_cost_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE equipment_catalog SET shipping_cost_centavos = CAST(ROUND(shipping_cost_cve * 100) AS INTEGER);
    ALTER TABLE equipment_catalog DROP COLUMN shipping_cost_cve;
    ALTER TABLE equipment_catalog ADD COLUMN customs_duty_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE equipment_catalog SET customs_duty_centavos = CAST(ROUND(customs_duty_cve * 100) AS INTEGER);
    ALTER TABLE equipment_catalog DROP COLUMN customs_duty_cve;
    ALTER TABLE equipment_catalog ADD COLUMN other_costs_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE equipment_catalog SET other_costs_centavos = CAST(ROUND(other_costs_cve * 100) AS INTEGER);
    ALTER TABLE equipment_catalog DROP COLUMN other_costs_cve;
    ALTER TABLE equipment_catalog ADD COLUMN selling_price_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE equipment_catalog SET selling_price_centavos = CAST(ROUND(selling_price_cve * 100) AS INTEGER);
    ALTER TABLE equipment_catalog DROP COLUMN selling_price_cve;
    ALTER TABLE equipment_catalog ADD COLUMN rental_fee_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE equipment_catalog SET rental_fee_centavos = CAST(ROUND(rental_fee_cve * 100) AS INTEGER);
    ALTER TABLE equipment_catalog DROP COLUMN rental_fee_cve;

    ALTER TABLE service_material_lines ADD COLUMN unit_cost_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE service_material_lines SET unit_cost_centavos = CAST(ROUND(unit_cost_cve * 100) AS INTEGER);
    ALTER TABLE service_material_lines DROP COLUMN unit_cost_cve;

    ALTER TABLE service_install_costs ADD COLUMN amount_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE service_install_costs SET amount_centavos = CAST(ROUND(amount_cve * 100) AS INTEGER);
    ALTER TABLE service_install_costs DROP COLUMN amount_cve;

    ALTER TABLE payment_lines ADD COLUMN amount_centavos INTEGER NOT NULL DEFAULT 0;
    UPDATE payment_lines SET amount_centavos = CAST(ROUND(amount_cve * 100) AS INTEGER);
    ALTER TABLE payment_lines DROP COLUMN amount_cve;

    -- ---- CHECK tables: full rebuild (CHECK blocks DROP COLUMN) ---------------

    CREATE TABLE investments_new (
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
      expected_monthly_revenue_centavos INTEGER NOT NULL DEFAULT 0 CHECK(expected_monthly_revenue_centavos >= 0),
      total_cost_centavos INTEGER NOT NULL DEFAULT 0 CHECK(total_cost_centavos >= 0),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER REFERENCES users(id),
      supplier TEXT,
      target_clients INTEGER NOT NULL DEFAULT 1 CHECK(target_clients > 0),
      installed_clients INTEGER NOT NULL DEFAULT 0 CHECK(installed_clients >= 0),
      desired_payback_months INTEGER NOT NULL DEFAULT 6 CHECK(desired_payback_months > 0),
      desired_margin_pct REAL NOT NULL DEFAULT 30 CHECK(desired_margin_pct >= 0),
      monthly_operational_cost_centavos INTEGER NOT NULL DEFAULT 0 CHECK(monthly_operational_cost_centavos >= 0),
      accumulated_revenue_centavos INTEGER NOT NULL DEFAULT 0 CHECK(accumulated_revenue_centavos >= 0)
    );
    INSERT INTO investments_new (
      id, name, type, client_id, zone, description, investment_date, reference_month, status,
      expected_monthly_revenue_centavos, total_cost_centavos, notes, created_at, updated_at, created_by,
      supplier, target_clients, installed_clients, desired_payback_months, desired_margin_pct,
      monthly_operational_cost_centavos, accumulated_revenue_centavos
    )
    SELECT
      id, name, type, client_id, zone, description, investment_date, reference_month, status,
      CAST(ROUND(expected_monthly_revenue_cve * 100) AS INTEGER),
      CAST(ROUND(total_cost_cve * 100) AS INTEGER),
      notes, created_at, updated_at, created_by,
      supplier, target_clients, installed_clients, desired_payback_months, desired_margin_pct,
      CAST(ROUND(monthly_operational_cost_cve * 100) AS INTEGER),
      CAST(ROUND(accumulated_revenue_cve * 100) AS INTEGER)
    FROM investments;
    DROP TABLE investments;
    ALTER TABLE investments_new RENAME TO investments;
    CREATE INDEX idx_investments_month ON investments(reference_month);
    CREATE INDEX idx_investments_date ON investments(investment_date);
    CREATE INDEX idx_investments_type ON investments(type);
    CREATE INDEX idx_investments_client ON investments(client_id);
    CREATE INDEX idx_investments_zone ON investments(zone);
    CREATE INDEX idx_investments_profitability_zone ON investments(zone, reference_month);

    CREATE TABLE investment_items_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL CHECK(item_type IN (
        'antena','router','cpe','switch','cabo','conector','fibra','caixa',
        'poste','ups','bateria','ferramenta','material','instalacao',
        'mao_obra','manutencao','outro'
      )) DEFAULT 'outro',
      item_name TEXT NOT NULL,
      quantity REAL NOT NULL CHECK(quantity > 0),
      unit_cost_centavos INTEGER NOT NULL CHECK(unit_cost_centavos >= 0),
      total_cost_centavos INTEGER NOT NULL CHECK(total_cost_centavos >= 0),
      quantity_used REAL NOT NULL DEFAULT 0 CHECK(quantity_used >= 0)
    );
    INSERT INTO investment_items_new (
      id, investment_id, item_type, item_name, quantity, unit_cost_centavos, total_cost_centavos, quantity_used
    )
    SELECT
      id, investment_id, item_type, item_name, quantity,
      CAST(ROUND(unit_cost_cve * 100) AS INTEGER),
      CAST(ROUND(total_cost_cve * 100) AS INTEGER),
      quantity_used
    FROM investment_items;
    DROP TABLE investment_items;
    ALTER TABLE investment_items_new RENAME TO investment_items;
    CREATE INDEX idx_investment_items_investment ON investment_items(investment_id);

    CREATE TABLE expenses_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK(category IN (
        'equipamento','infraestrutura','salarios','marketing',
        'impostos','licencas','combustivel','banda_internet',
        'aluguer','energia','manutencao','deslocacoes','reparacoes',
        'outros'
      )) DEFAULT 'outros',
      description TEXT NOT NULL,
      amount_centavos INTEGER NOT NULL CHECK(amount_centavos >= 0),
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
      id, category, description, amount_centavos, expense_date, reference_month, supplier,
      invoice_reference, notes, investment_id, zone, client_id, created_at, updated_at, created_by
    )
    SELECT
      id, category, description, CAST(ROUND(amount_cve * 100) AS INTEGER), expense_date, reference_month, supplier,
      invoice_reference, notes, investment_id, zone, client_id, created_at, updated_at, created_by
    FROM expenses;
    DROP TABLE expenses;
    ALTER TABLE expenses_new RENAME TO expenses;
    CREATE INDEX idx_expenses_date ON expenses(expense_date);
    CREATE INDEX idx_expenses_month ON expenses(reference_month);
    CREATE INDEX idx_expenses_category ON expenses(category);
    CREATE INDEX idx_expenses_investment ON expenses(investment_id);
    CREATE INDEX idx_expenses_zone ON expenses(zone);
    CREATE INDEX idx_expenses_client ON expenses(client_id);

    CREATE TABLE expense_templates_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN (
        'equipamento','infraestrutura','salarios','marketing',
        'impostos','licencas','combustivel','banda_internet',
        'aluguer','energia','manutencao','deslocacoes','reparacoes',
        'outros'
      )) DEFAULT 'outros',
      amount_centavos INTEGER NOT NULL CHECK(amount_centavos >= 0),
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
    INSERT INTO expense_templates_new (
      id, name, category, amount_centavos, day_of_month, supplier, notes, investment_id, zone,
      client_id, active, last_generated_month, created_at, updated_at, created_by
    )
    SELECT
      id, name, category, CAST(ROUND(amount_cve * 100) AS INTEGER), day_of_month, supplier, notes, investment_id, zone,
      client_id, active, last_generated_month, created_at, updated_at, created_by
    FROM expense_templates;
    DROP TABLE expense_templates;
    ALTER TABLE expense_templates_new RENAME TO expense_templates;
    CREATE INDEX idx_expense_templates_active ON expense_templates(active);
  `
};

export default migration;
