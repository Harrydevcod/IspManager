import type { Migration } from './types';

/**
 * Introduz o serviço de "Distribuição de Conteúdos Audiovisuais" e a fundação de
 * linhas de documento.
 *
 * `payment_lines` torna a fatura/recibo orientados por dados: um pagamento passa a
 * ter 1+ linhas (ex.: Internet + Audiovisual na mesma fatura mensal). O total
 * continua em `payments.amount_cve` (tesouraria/aging/recibos inalterados); as
 * linhas só descrevem a sua composição. Documentos antigos não têm linhas e o
 * renderer mantém o fallback de linha única — nunca se altera um documento emitido.
 *
 * As colunas audiovisual em `services` cobrem add-on (a par da internet) e
 * standalone (serviço sem `plan_id`). O preço é fixado no contrato (snapshot),
 * para que alterações futuras de tarifário não reescrevam serviços existentes.
 */
const migration: Migration = {
  version: 19,
  name: 'audiovisual_addon',
  sql: `
    CREATE TABLE IF NOT EXISTS payment_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      kind TEXT NOT NULL CHECK(kind IN ('internet','audiovisual')),
      description TEXT NOT NULL,
      amount_cve REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_payment_lines_payment ON payment_lines(payment_id);

    ALTER TABLE services ADD COLUMN audiovisual_mode TEXT NOT NULL DEFAULT 'none'
      CHECK(audiovisual_mode IN ('none','monthly','annual'));
    ALTER TABLE services ADD COLUMN audiovisual_monthly_cve REAL NOT NULL DEFAULT 0;
    ALTER TABLE services ADD COLUMN audiovisual_annual_cve REAL NOT NULL DEFAULT 0;
  `
};

export default migration;
