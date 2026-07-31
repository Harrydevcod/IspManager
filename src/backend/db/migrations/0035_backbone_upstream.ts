import type { Migration } from './types';

/**
 * A espinha dorsal deixa de ser um conjunto plano: cada unidade declara de quem
 * recebe sinal. `NULL` significa "alimentado pela Internet" — a cabeça da cadeia.
 *
 * Uma coluna e não uma tabela temporal como `backbone_assignment_links`: a
 * espinha muda quando se instala hardware, não quando um CPE circula, e uma
 * auto-FK evita um JOIN em todas as leituras de topologia.
 */
const migration: Migration = {
  version: 35,
  name: 'backbone_upstream',
  sql: `
    ALTER TABLE backbone_devices ADD COLUMN upstream_device_id INTEGER
      REFERENCES backbone_devices(id) ON DELETE RESTRICT;
    CREATE INDEX idx_backbone_devices_upstream
      ON backbone_devices(upstream_device_id);
  `
};

export default migration;
