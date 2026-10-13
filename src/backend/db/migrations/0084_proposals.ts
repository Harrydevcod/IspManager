import type { Migration } from './types';
const migration: Migration = { version: 84, name: 'proposals', sql: `
CREATE TABLE proposals (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 number TEXT UNIQUE,
 client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
 recipient_json TEXT NOT NULL,
 title TEXT NOT NULL,
 valid_until TEXT NOT NULL,
 conditions TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','accepted','refused','cancelled','superseded')),
 version INTEGER NOT NULL DEFAULT 1,
 once_total_centavos INTEGER NOT NULL CHECK(once_total_centavos >= 0),
 monthly_total_centavos INTEGER NOT NULL CHECK(monthly_total_centavos >= 0),
 snapshot_json TEXT,
 previous_id INTEGER REFERENCES proposals(id),
 chain_id INTEGER REFERENCES proposals(id),
 created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 issued_at TEXT,
 decision_at TEXT,
 accepted_by TEXT,
 decision_note TEXT,
 cancellation_reason TEXT
);
CREATE UNIQUE INDEX proposal_pending_revision ON proposals(chain_id) WHERE status = 'draft' AND previous_id IS NOT NULL;
CREATE INDEX proposals_client ON proposals(client_id);
CREATE INDEX proposals_chain ON proposals(chain_id);
CREATE TABLE proposal_lines (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 proposal_id INTEGER NOT NULL REFERENCES proposals(id),
 sort_order INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('plan','installation','product','free')),
 description TEXT NOT NULL,
 period TEXT NOT NULL CHECK(period IN ('once','monthly')),
 quantity REAL NOT NULL CHECK(quantity > 0),
 unit_price_centavos INTEGER NOT NULL CHECK(unit_price_centavos >= 0),
 total_centavos INTEGER NOT NULL CHECK(total_centavos >= 0),
 plan_id INTEGER REFERENCES internet_plans(id) ON DELETE SET NULL,
 catalog_id INTEGER REFERENCES equipment_catalog(id) ON DELETE SET NULL,
 UNIQUE(proposal_id,sort_order)
);
CREATE TABLE proposal_deliveries (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 proposal_id INTEGER NOT NULL REFERENCES proposals(id),
 delivered_at TEXT NOT NULL,
 channel TEXT NOT NULL,
 note TEXT NOT NULL,
 actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX proposal_deliveries_proposal ON proposal_deliveries(proposal_id);
CREATE TABLE proposal_sequences (year INTEGER PRIMARY KEY, last_number INTEGER NOT NULL);
` };
export default migration;
