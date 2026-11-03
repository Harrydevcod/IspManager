import type { Migration } from './types';

/**
 * Relatório de entrega do SMS (o telemóvel confirma que chegou ao destino).
 * Coluna à parte em vez de um novo `status`: mexer no CHECK de `status`
 * obrigaria a reconstruir a tabela. "Entregue" = status 'sent' com delivered_at.
 */
const migration: Migration = {
  version: 92,
  name: 'sms_delivered_at',
  sql: `
    ALTER TABLE sms_outbox ADD COLUMN delivered_at TEXT;
  `
};

export default migration;
