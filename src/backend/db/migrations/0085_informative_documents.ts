import type { Migration } from "./types";
const migration: Migration = {
  version: 85,
  name: "informative_documents",
  sql: `
ALTER TABLE proposals ADD COLUMN document_type TEXT NOT NULL DEFAULT 'proposal' CHECK(document_type IN ('proposal','quotation','proforma'));
ALTER TABLE proposals ADD COLUMN payment_request_json TEXT CHECK(payment_request_json IS NULL OR json_valid(payment_request_json));
CREATE TABLE quotation_sequences (year INTEGER PRIMARY KEY, last_number INTEGER NOT NULL CHECK(last_number > 0));
CREATE TABLE proforma_sequences (year INTEGER PRIMARY KEY, last_number INTEGER NOT NULL CHECK(last_number > 0));
CREATE INDEX proposals_type_created ON proposals(document_type, created_at, id);
`,
};
export default migration;
