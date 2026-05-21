import type { Migration } from './types';

/**
 * Profitability layer for ISP investments.
 *
 * Keeps the operational registration from v6 and adds the inputs needed to
 * calculate cost per client, recommended plan price, accumulated profit and
 * ROI without rewriting the original migration.
 */
const migration: Migration = {
  version: 7,
  name: 'investment_profitability',
  sql: `
    ALTER TABLE investments ADD COLUMN supplier TEXT;
    ALTER TABLE investments ADD COLUMN target_clients INTEGER NOT NULL DEFAULT 1 CHECK(target_clients > 0);
    ALTER TABLE investments ADD COLUMN installed_clients INTEGER NOT NULL DEFAULT 0 CHECK(installed_clients >= 0);
    ALTER TABLE investments ADD COLUMN desired_payback_months INTEGER NOT NULL DEFAULT 6 CHECK(desired_payback_months > 0);
    ALTER TABLE investments ADD COLUMN desired_margin_pct REAL NOT NULL DEFAULT 30 CHECK(desired_margin_pct >= 0);
    ALTER TABLE investments ADD COLUMN monthly_operational_cost_cve REAL NOT NULL DEFAULT 0 CHECK(monthly_operational_cost_cve >= 0);
    ALTER TABLE investments ADD COLUMN accumulated_revenue_cve REAL NOT NULL DEFAULT 0 CHECK(accumulated_revenue_cve >= 0);

    ALTER TABLE investment_items ADD COLUMN quantity_used REAL NOT NULL DEFAULT 0 CHECK(quantity_used >= 0);

    CREATE INDEX IF NOT EXISTS idx_investments_profitability_zone ON investments(zone, reference_month);
  `
};

export default migration;
