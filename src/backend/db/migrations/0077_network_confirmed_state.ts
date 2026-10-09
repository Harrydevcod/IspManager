import type { Migration } from './types';

/**
 * O último ponto em que o ISPM e o router concordaram, por serviço (ADR 0014).
 *
 * Sem isto a reconciliação não distingue "o plano mudou no ISPM" de "alguém mexeu no Winbox": as
 * duas são só router ≠ ISPM, e a passagem sobrepunha a segunda em silêncio. Com o confirmado,
 * intenção igual à confirmada e router diferente quer dizer que foi o router que mudou — fica
 * retido à espera de decisão.
 *
 * Tudo nulo = ainda não houve acordo: a passagem empurra o ISPM, como antes desta migração.
 */
const migration: Migration = {
  version: 77,
  name: 'network_confirmed_state',
  sql: `
    ALTER TABLE service_network_state ADD COLUMN confirmed_secret_id TEXT;
    ALTER TABLE service_network_state ADD COLUMN confirmed_username TEXT;
    ALTER TABLE service_network_state ADD COLUMN confirmed_profile TEXT;
    ALTER TABLE service_network_state ADD COLUMN confirmed_enabled INTEGER;
  `
};

export default migration;
