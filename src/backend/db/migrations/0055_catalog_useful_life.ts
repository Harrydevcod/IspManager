import type { Migration } from './types';

/**
 * Vida util do equipamento, para o parque instalado deixar de valer o preco
 * de compra para sempre.
 *
 * Um CPE colocado ha tres anos pesa hoje no capital exatamente o mesmo do dia
 * em que foi comprado, e continua a pesar muito depois de a mensalidade o ter
 * pago. Sem vida util nao ha maneira de dizer quanto vale o que esta nos
 * telhados, nem qual e o custo mensal verdadeiro de servir um cliente.
 *
 * Sessenta meses por omissao — cinco anos, a ordem de grandeza de um CPE ou de
 * uma antena de exterior. E um valor por modelo e editavel: uma bateria nao
 * dura o que dura um switch.
 *
 * Isto nao mexe no regime de caixa. A "Caixa acumulada" continua a abater o
 * capital todo no momento em que sai da conta, porque e isso que responde a
 * "quanto dinheiro tenho". A depreciacao vive ao lado, com nome proprio, e
 * responde a outra pergunta: "quanto vale o que ja montei".
 */
const migration: Migration = {
  version: 55,
  name: 'catalog_useful_life',
  sql: `
    ALTER TABLE equipment_catalog
      ADD COLUMN useful_life_months INTEGER NOT NULL DEFAULT 60;
  `
};

export default migration;
