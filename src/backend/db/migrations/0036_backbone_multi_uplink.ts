import type { Migration } from './types';

/**
 * A espinha dorsal deixa de ser uma árvore e passa a grafo: um equipamento pode
 * receber sinal de várias unidades ao mesmo tempo — o caso concreto é um router
 * multi-WAN alimentado por 2, 3 ou 4 antenas Starlink, para reforço de
 * capacidade. Uma coluna única (`upstream_device_id`, versão 35) só sabe
 * declarar um alimentador, por isso dá lugar a uma tabela de ligações.
 *
 * A semântica da raiz mantém-se: zero linhas em `backbone_links` para um
 * equipamento significa "alimentado pela Internet". Várias unidades podem estar
 * nesse estado — cada uma é uma origem de Internet própria (ilha, zona, ou o
 * segundo link do mesmo sítio).
 *
 * A coluna antiga é largada no fim: duas fontes de verdade para a mesma
 * ligação acabariam por discordar.
 */
const migration: Migration = {
  version: 36,
  name: 'backbone_multi_uplink',
  sql: `
    CREATE TABLE backbone_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL REFERENCES backbone_devices(id) ON DELETE RESTRICT,
      upstream_device_id INTEGER NOT NULL REFERENCES backbone_devices(id) ON DELETE RESTRICT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(device_id <> upstream_device_id)
    );

    CREATE UNIQUE INDEX idx_backbone_links_pair
      ON backbone_links(device_id, upstream_device_id);
    CREATE INDEX idx_backbone_links_upstream
      ON backbone_links(upstream_device_id);

    INSERT INTO backbone_links (device_id, upstream_device_id)
      SELECT id, upstream_device_id FROM backbone_devices
      WHERE upstream_device_id IS NOT NULL;

    DROP INDEX idx_backbone_devices_upstream;
    ALTER TABLE backbone_devices DROP COLUMN upstream_device_id;
  `
};

export default migration;
