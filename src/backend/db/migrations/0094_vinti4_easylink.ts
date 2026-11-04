import type { Migration } from './types';

/**
 * Link EasyLink do Vinti4 colado na fatura (ADR 0019). O valor guarda-se com
 * o URL: o EasyLink cobra um montante fixo, e um link de valor antigo nunca
 * segue num aviso. Colunas na própria fatura, não tabela: há um link por
 * fatura e o ISPM não fala com o SISP, por isso não há estados a seguir.
 */
const migration: Migration = {
  version: 94,
  name: 'vinti4_easylink',
  sql: `
    ALTER TABLE payments ADD COLUMN vinti4_link_url TEXT;
    ALTER TABLE payments ADD COLUMN vinti4_link_amount_cve REAL;
  `
};

export default migration;
