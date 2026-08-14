import type { Migration } from './types';

/**
 * Segunda passagem ao pré-preenchimento dos Mbps do plano.
 *
 * A 0039 só reconhecia "20", "20M" e "20 Mbps"; o catálogo real está escrito
 * "20 Mb/s" e ficou todo a nulo. A 0039 já correu no terreno e é imutável — daí
 * uma migração nova em vez de lhe mexer.
 *
 * Continua a só tocar no que é inequívoco (`WHERE download_mbps IS NULL` e o
 * resto do texto tem de ser só dígitos depois de tirada a unidade): um plano
 * escrito "até 20 Mb/s" ou "Ilimitado" fica a nulo, e nulo significa que o ISPM
 * não escreve velocidade nenhuma no router.
 */
const CLEAN = (column: string) =>
  `TRIM(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(${column}), '/s', ''), 'mbps', ''), 'mb', ''), 'm', ''))`;

const migration: Migration = {
  version: 41,
  name: 'plan_mbps_slash_units',
  sql: `
    UPDATE internet_plans
    SET download_mbps = CAST(${CLEAN('download_speed')} AS INTEGER)
    WHERE download_mbps IS NULL
      AND ${CLEAN('download_speed')} GLOB '[0-9]*'
      AND ${CLEAN('download_speed')} NOT GLOB '*[^0-9]*';

    UPDATE internet_plans
    SET upload_mbps = CAST(${CLEAN('upload_speed')} AS INTEGER)
    WHERE upload_mbps IS NULL
      AND ${CLEAN('upload_speed')} GLOB '[0-9]*'
      AND ${CLEAN('upload_speed')} NOT GLOB '*[^0-9]*';
  `
};

export default migration;
