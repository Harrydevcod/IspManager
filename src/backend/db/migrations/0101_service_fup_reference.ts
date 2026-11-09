import type { Migration } from './types';

const OLD_MESSAGE = 'Caro cliente {nome}, já usou {percent}% do consumo de referência do seu plano ({gb} de {referencia} GB) neste ciclo. Ao chegar aos 100%, a velocidade entre as {inicio} e as {fim} passa a {pico}% da contratada até ao próximo ciclo.';
const NEW_MESSAGE = 'Caro cliente {nome}, já usou {percent}% do consumo de referência do seu plano ({gb} de {referencia} GB) neste ciclo. Ao chegar aos 100%, {acao} até ao próximo ciclo.';

/**
 * Plafond FUP por serviço (pacote extra ou exceção). Nulo = herda o do plano
 * ou, se o plano estiver a 0, o predefinido das Definições; 0 = isento.
 *
 * A mensagem de aviso de origem passa a usar {acao}, que diz a verdade tanto a
 * reduzir como a bloquear. Uma mensagem já personalizada não se toca.
 */
const migration: Migration = {
  version: 101,
  name: 'service_fup_reference',
  sql: `
    ALTER TABLE services ADD COLUMN fup_reference_gb INTEGER CHECK (fup_reference_gb IS NULL OR fup_reference_gb >= 0);

    INSERT INTO fup_settings_history (key, old_value, new_value, changed_by, reason)
      SELECT 'mensagem_aviso', value, '${NEW_MESSAGE}', 'sistema', 'Mensagem de origem passa a usar {acao}'
      FROM fup_settings WHERE key = 'mensagem_aviso' AND value = '${OLD_MESSAGE}';
    UPDATE fup_settings SET value = '${NEW_MESSAGE}' WHERE key = 'mensagem_aviso' AND value = '${OLD_MESSAGE}';
  `
};

export default migration;
