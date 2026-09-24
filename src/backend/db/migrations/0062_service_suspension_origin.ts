import type { Migration } from './types';

/**
 * Origem da suspensão do serviço.
 *
 * Antes havia apenas status=suspended. Isso não chega para reativação automática:
 * pagar uma dívida pode repor uma suspensão por falta de pagamento, mas nunca
 * uma suspensão manual feita pelo operador. Linhas antigas ficam com origem NULL
 * e, por segurança, são tratadas como manuais.
 */
const migration: Migration = {
  version: 62,
  name: 'service_suspension_origin',
  sql: `
    ALTER TABLE services ADD COLUMN suspension_source TEXT;
    ALTER TABLE services ADD COLUMN suspended_at TEXT;

    CREATE INDEX IF NOT EXISTS idx_services_suspension_source
      ON services(suspension_source) WHERE suspension_source IS NOT NULL;
  `
};

export default migration;
