import type { Migration } from './types';

/**
 * Pausa a pedido do cliente: uma ausência temporária (férias, viagem) é uma
 * suspensão com `suspension_source = 'client_request'` e esta data de regresso.
 * No dia (de Cabo Verde) o serviço volta sozinho a ativo. Nula = sem data.
 */
const migration: Migration = {
  version: 100,
  name: 'service_pause_until',
  sql: `
    ALTER TABLE services ADD COLUMN pause_until TEXT;
  `
};

export default migration;
