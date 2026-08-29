import type { Migration } from './types';

/**
 * As unidades de backbone já instaladas nunca deram baixa do armazém.
 *
 * `equipment_catalog.stock_total` é um saldo mutável: quem tira uma unidade do
 * armazém desconta-a explicitamente. Todos os caminhos de cliente o faziam; o
 * registo de backbone não — inseria a linha em `backbone_devices` e mais nada.
 * A migração 33 agravou-o ao converter o contador `backbone_qty` em linhas reais
 * sem movimento compensatório. Resultado: equipamento num poste continuava a
 * contar como disponível.
 *
 * A partir daqui o código desconta na criação e devolve ao retirar. Esta
 * migração acerta o que ficou para trás, e deixa o acerto visível no histórico
 * do artigo em vez de mexer no número em silêncio.
 *
 * O `max(0, ...)` protege instalações onde o operador já tenha corrigido o stock
 * à mão: acertar duas vezes daria saldo negativo.
 */
const migration: Migration = {
  version: 50,
  name: 'backbone_consome_stock',
  sql: `
    INSERT INTO stock_movements (catalog_id, type, quantity, reference, notes)
      SELECT
        catalog_id,
        'saida',
        COUNT(*),
        'Regularizacao backbone',
        'Unidades ja instaladas no backbone que nunca deram baixa do armazem'
      FROM backbone_devices
      WHERE status <> 'retired'
      GROUP BY catalog_id;

    UPDATE equipment_catalog SET
      stock_total = max(0, stock_total - (
        SELECT COUNT(*) FROM backbone_devices b
        WHERE b.catalog_id = equipment_catalog.id AND b.status <> 'retired'
      )),
      updated_at = datetime('now')
    WHERE EXISTS (
      SELECT 1 FROM backbone_devices b
      WHERE b.catalog_id = equipment_catalog.id AND b.status <> 'retired'
    );
  `
};

export default migration;
