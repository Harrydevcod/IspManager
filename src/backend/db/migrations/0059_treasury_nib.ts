import type { Migration } from './types';

/**
 * Nº de conta e NIB em colunas próprias.
 *
 * A 0058 deu à conta bancária um só campo de identificação, `account_number`,
 * a fazer de número curto, de NIB e de IBAN. Quem tem os dois tinha de escolher
 * um, e o que ficava de fora perdia-se. O NIB é o que o cliente precisa para
 * transferir; o número curto é o que o banco usa ao balcão. São dados
 * diferentes e passam a viver em colunas diferentes.
 *
 * IBAN não entra: não se usa neste sistema.
 *
 * O que já lá está arruma-se por regra, não por adivinhação: sem separadores,
 * 21 dígitos é um NIB e muda de coluna; tudo o resto fica onde está, à vista no
 * ecrã da Tesouraria para quem quiser corrigir à mão.
 */
const STRIPPED = `replace(replace(replace(account_number,' ',''),'.',''),'-','')`;

const migration: Migration = {
  version: 59,
  name: 'treasury_nib',
  sql: `
    ALTER TABLE treasury_accounts ADD COLUMN nib TEXT;

    UPDATE treasury_accounts
       SET nib = account_number, account_number = NULL
     WHERE kind = 'banco' AND account_number IS NOT NULL
       AND length(${STRIPPED}) = 21
       AND ${STRIPPED} NOT GLOB '*[^0-9]*';
  `
};

export default migration;
