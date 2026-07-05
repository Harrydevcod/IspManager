import type { Migration } from './types';

/**
 * Associação exata investimento ↔ vários clientes (ex.: antena de transmissão
 * que serve 8 clientes espalhados por 3 zonas). Complementa os mecanismos
 * existentes (client_id único, zona, global-share): a receita/OPEX passa a
 * poder ser atribuída a um conjunto explícito de clientes, com divisão quando
 * o mesmo cliente é reclamado por mais de um investimento.
 */
const migration: Migration = {
  version: 27,
  name: 'investment_clients',
  sql: `
    CREATE TABLE investment_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(investment_id, client_id)
    );
    CREATE INDEX idx_investment_clients_client ON investment_clients(client_id);
  `
};

export default migration;
