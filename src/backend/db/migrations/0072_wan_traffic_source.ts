import type { Migration } from './types';

/**
 * De onde vem o dia: 'counted' (router ou app) ou 'starlink' (copiado da conta Starlink, só o
 * total). Um dia 'starlink' substitui uma contagem que se sabe errada e a importação do router
 * não lhe toca.
 */
const migration: Migration = {
  version: 72,
  name: 'wan_traffic_source',
  sql: `
    ALTER TABLE wan_traffic_daily ADD COLUMN source TEXT NOT NULL DEFAULT 'counted' CHECK(source IN ('counted', 'starlink'));
  `
};

export default migration;
