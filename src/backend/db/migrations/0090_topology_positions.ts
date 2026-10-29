import type { Migration } from './types';

/**
 * Onde o operador arrumou cada nó do mapa da Topologia.
 *
 * Sem linha, o nó fica onde o dagre o pôs — por isso a tabela só guarda o que
 * alguém mexeu, e apagá-la inteira devolve o mapa ao desenho automático. A chave
 * leva a direção do desenho: o mesmo nó num mapa de cima para baixo e num da
 * esquerda para a direita está em sítios diferentes. `node_key` é o id do nó no
 * grafo (`backbone:3`, `root:isp`, …), não uma FK: um nó que deixa de existir
 * fica com uma linha órfã inofensiva, que o mapa simplesmente não usa.
 */
const migration: Migration = {
  version: 90,
  name: 'topology_positions',
  sql: `
    CREATE TABLE topology_positions (
      direction TEXT NOT NULL CHECK (direction IN ('TB', 'LR')),
      node_key TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (direction, node_key)
    );
  `
};

export default migration;
