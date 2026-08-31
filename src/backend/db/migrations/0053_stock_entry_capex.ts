import type { Migration } from './types';

/**
 * O capital de stock passa a somar compras, e nao um saldo.
 *
 * Ate aqui o "Total investido" derivava do saldo atual mais as saidas
 * historicas: `SUM(stock_total * landed) + SUM(saida * unit_cost)`. A conta
 * parte do principio de que uma unidade que saiu do armazem nunca la volta —
 * e desde a devolucao (0044), a transferencia de titular (0045), a troca e a
 * retirada de backbone, volta muitas vezes. Uma devolucao em bom estado repoe
 * `stock_total` mas nao anula a `saida` que lhe deu origem, e a mesma unidade
 * passa a contar duas vezes. Cada ciclo devolucao-reinstalacao acrescentava
 * para sempre o custo de um equipamento que nunca foi comprado.
 *
 * A partir daqui o capital de stock e `SUM(quantity * unit_cost_cve)` sobre os
 * movimentos de `entrada`. Uma devolucao deixa de contar porque nunca foi uma
 * compra — o erro morre por construcao, e cada escudo passa a ter data, o que
 * poe o stock no grafico por ano ao lado do resto do CAPEX.
 *
 * Falta a essa soma o stock que entrou pelo formulario do catalogo, que
 * escrevia `stock_total` sem gerar movimento nenhum. Esta migracao lanca a
 * abertura de inventario que falta. A identidade do saldo e
 *
 *     stock_total = SUM(entrada) - SUM(saida) + SUM(devolucao) + SUM(ajuste)
 *
 * logo as unidades adquiridas e ainda por registar sao o que sobra ao isolar
 * `SUM(entrada)`. O `max(0, ...)` protege os modelos onde os movimentos ja
 * cobrem o saldo — acertar duas vezes daria uma entrada fantasma. Pela mesma
 * razao a migracao e idempotente: a segunda passagem encontra a diferenca a
 * zero e nao insere nada.
 *
 * O custo usado e o aterrado de hoje, o unico que existe para stock que nunca
 * teve movimento. As unidades que ja tinham `entrada` mantem o custo com que
 * foram registadas.
 */
const migration: Migration = {
  version: 53,
  name: 'stock_entry_capex',
  sql: `
    INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve, reference, notes)
      SELECT
        ec.id,
        'entrada',
        ec.stock_total + saldo.saidas - saldo.devolucoes - saldo.ajustes - saldo.entradas,
        (ec.purchase_price_cve + ec.shipping_cost_cve + ec.customs_duty_cve + ec.other_costs_cve),
        'Abertura de inventario',
        'Unidades adquiridas antes de a compra gerar movimento de entrada'
      FROM equipment_catalog ec
      JOIN (
        SELECT
          ec2.id AS catalog_id,
          COALESCE((SELECT SUM(quantity) FROM stock_movements m
                    WHERE m.catalog_id = ec2.id AND m.type = 'entrada'), 0) AS entradas,
          COALESCE((SELECT SUM(abs(quantity)) FROM stock_movements m
                    WHERE m.catalog_id = ec2.id AND m.type = 'saida'), 0) AS saidas,
          COALESCE((SELECT SUM(quantity) FROM stock_movements m
                    WHERE m.catalog_id = ec2.id AND m.type = 'devolucao'), 0) AS devolucoes,
          COALESCE((SELECT SUM(quantity) FROM stock_movements m
                    WHERE m.catalog_id = ec2.id AND m.type = 'ajuste'), 0) AS ajustes
        FROM equipment_catalog ec2
      ) saldo ON saldo.catalog_id = ec.id
      WHERE ec.stock_total + saldo.saidas - saldo.devolucoes - saldo.ajustes - saldo.entradas > 0;

    CREATE INDEX IF NOT EXISTS idx_stock_mov_type ON stock_movements(type);
  `
};

export default migration;
