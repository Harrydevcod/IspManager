import type { Migration } from './types';

/**
 * O item de investimento passa a poder apontar para o catalogo.
 *
 * `investments` e `stock_movements` sao dois livros de custo que nunca se
 * falavam: `investment_items.item_name` e texto livre e nao referenciava
 * modelo nenhum. Comprar seis CPE alimentava o stock; registar o investimento
 * "Expansao Achada — seis CPE e uma antena" alimentava a tabela de
 * investimentos. O mesmo dinheiro contava duas vezes no "Total investido" e
 * nada no sistema o detetava.
 *
 * Com `catalog_id` preenchido, o item deixa de somar capital e passa a
 * reclama-lo: o equipamento ja foi contado no stock quando deu entrada, e o
 * investimento apenas o agrupa sob uma intencao — zona, alvo de clientes,
 * payback desejado. Um item sem `catalog_id` continua a ser custo externo
 * (mao de obra, poste, licenca, aluguer de grua) e soma como sempre somou.
 *
 * Anulavel de proposito: todo o historico ja escrito fica como custo externo,
 * que e como sempre foi contado. Quem quiser reconciliar um investimento
 * antigo com o catalogo edita-o.
 */
const migration: Migration = {
  version: 54,
  name: 'investment_item_catalog',
  sql: `
    ALTER TABLE investment_items
      ADD COLUMN catalog_id INTEGER REFERENCES equipment_catalog(id);

    CREATE INDEX IF NOT EXISTS idx_investment_items_catalog
      ON investment_items(catalog_id);
  `
};

export default migration;
