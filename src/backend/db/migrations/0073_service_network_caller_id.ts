import type { Migration } from './types';

/**
 * O MAC de quem se autentica com o utilizador PPPoE do serviço (`caller-id`). É a única coisa
 * que liga um router de cliente ao cliente sem ninguém ir lá ler a etiqueta: o modelo repete-se
 * e o endereço vem por DHCP. Fica o último conhecido, mesmo com a sessão em baixo.
 */
const migration: Migration = {
  version: 73,
  name: 'service_network_caller_id',
  sql: `
    ALTER TABLE service_network_state ADD COLUMN caller_id TEXT;
  `
};

export default migration;
