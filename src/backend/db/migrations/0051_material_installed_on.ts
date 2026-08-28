import type { Migration } from './types';

/**
 * O material passa a ter data própria.
 *
 * O equipamento sempre teve `start_date`; o material só tinha `created_at`, o
 * carimbo de quando a linha foi escrita. Com as datas do ciclo a virem do
 * formulário, o cabo instalado em Março e registado em Agosto precisa de onde
 * dizer Março — senão o consumo aparece no mês errado.
 *
 * Retroativo: `created_at` é a melhor data que existe para as linhas antigas, e
 * é a que estava a ser usada como se fosse a da instalação.
 */
const migration: Migration = {
  version: 51,
  name: 'material_installed_on',
  sql: `
    ALTER TABLE service_material_lines ADD COLUMN installed_on TEXT;
    UPDATE service_material_lines SET installed_on = date(created_at);
  `
};

export default migration;
