import type { Migration } from './types';

/**
 * A velocidade PPPoE sai do perfil PPP do router, não do secret.
 *
 * Medido no router real (hEX S, RouterOS 7.24.2): `PUT /ppp/secret` com
 * `rate-limit` responde 400 "unknown parameter rate-limit" — no RouterOS o
 * limite é propriedade do `/ppp/profile`. O perfil (endereços, DNS, limite) é
 * do operador e faz-se no Winbox; o plano só diz qual, e o ISPM só aponta o
 * secret para ele. Nulo = não mexer no perfil que o secret tiver.
 *
 * `service_network_state.rate_limit` nunca foi preenchido por um router real
 * (o campo não existe no secret) e passa a guardar o perfil lido.
 */
const migration: Migration = {
  version: 65,
  name: 'plan_router_profile',
  sql: `
    ALTER TABLE internet_plans ADD COLUMN router_profile TEXT;
    ALTER TABLE service_network_state RENAME COLUMN rate_limit TO profile;
  `
};

export default migration;
