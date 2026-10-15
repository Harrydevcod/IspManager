import type { Migration } from './types';

// Artigos e serviços com código; linhas livres de talões e faturas manuais passam a apontar para um,
// e as linhas dos Informativos podem escolher um.
// Equipamento e planos ganham código (EQP0001, PLN0001…). O Cliente Indiferenciado passa a VD.
const migration: Migration = {
  version: 86,
  name: 'articles_and_codes',
  sql: `
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(length(trim(code)) BETWEEN 1 AND 20),
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
      kind TEXT NOT NULL CHECK(kind IN ('product','service')),
      unit_price_centavos INTEGER NOT NULL DEFAULT 0 CHECK(unit_price_centavos >= 0),
      -- Garantia, estado do produto…: sai nas observações do documento.
      document_note TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX articles_active_name_unique ON articles(name COLLATE NOCASE) WHERE active = 1;

    ALTER TABLE payment_lines ADD COLUMN article_id INTEGER REFERENCES articles(id);
    -- Código e quantidade gravados na linha: um documento reimpresso não muda se o código for editado.
    ALTER TABLE payment_lines ADD COLUMN item_code TEXT;
    ALTER TABLE payment_lines ADD COLUMN item_note TEXT;
    ALTER TABLE payment_lines ADD COLUMN quantity REAL NOT NULL DEFAULT 1 CHECK(quantity > 0);
    -- Preço unitário escrito: o PDF não o reconstrói de valor ÷ quantidade. Nulo nas linhas antigas.
    ALTER TABLE payment_lines ADD COLUMN unit_price_centavos INTEGER CHECK(unit_price_centavos > 0);
    ALTER TABLE proposal_lines ADD COLUMN article_id INTEGER REFERENCES articles(id);
    ALTER TABLE proposal_lines ADD COLUMN item_code TEXT;
    ALTER TABLE proposal_lines ADD COLUMN item_note TEXT;

    ALTER TABLE equipment_catalog ADD COLUMN code TEXT;
    ALTER TABLE equipment_catalog ADD COLUMN document_note TEXT;
    UPDATE equipment_catalog SET code = (
      SELECT 'EQP' || printf('%04d', r.rn) FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM equipment_catalog) r
      WHERE r.id = equipment_catalog.id
    );
    CREATE UNIQUE INDEX equipment_catalog_code_unique ON equipment_catalog(code COLLATE NOCASE) WHERE code IS NOT NULL;

    ALTER TABLE internet_plans ADD COLUMN code TEXT;
    UPDATE internet_plans SET code = (
      SELECT 'PLN' || printf('%04d', r.rn) FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM internet_plans) r
      WHERE r.id = internet_plans.id
    );
    CREATE UNIQUE INDEX internet_plans_code_unique ON internet_plans(code COLLATE NOCASE) WHERE code IS NOT NULL;

    UPDATE clients SET client_code = 'VD', full_name = 'Cliente Indiferenciado'
    WHERE system_kind = 'indifferentiated' AND NOT EXISTS (SELECT 1 FROM clients WHERE client_code = 'VD');
  `
};

export default migration;
