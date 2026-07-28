import type { Migration } from './types';

/**
 * Uma antena/CPE/AP física pode servir vários serviços: num prédio instala-se uma
 * antena mais um switch e alimentam-se N apartamentos, e há antenas com várias
 * saídas de rede que servem N clientes na mesma residência.
 *
 * UMA linha em `service_device_assignments` continua a ser UMA unidade física =
 * UMA baixa de stock = UM IP. Os serviços EXTRA que essa unidade alimenta ficam
 * aqui. O `service_id` da atribuição continua a ser o TITULAR, para que o stock,
 * a devolução e o delete de serviço mantenham âncora — `stock_movements.service_id`
 * deixaria de ter dono se os serviços vivessem todos na tabela de ligação.
 *
 * Mesmo padrão de `investment_clients` (0030 ← 0027), que já resolve a partilha do
 * lado dos investimentos.
 *
 * A vista `assignment_services` é o ponto único de leitura: com zero partilhas é
 * literalmente `service_device_assignments`, por isso todas as queries que passem
 * a usá-la devolvem exatamente o mesmo que hoje.
 *
 * ATENÇÃO a migrations futuras: qualquer rebuild de `service_device_assignments`
 * tem de dropar e recriar esta vista.
 */
const migration: Migration = {
  version: 30,
  name: 'service_device_shares',
  sql: `
    CREATE TABLE service_device_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL REFERENCES service_device_assignments(id) ON DELETE CASCADE,
      service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(assignment_id, service_id)
    );
    CREATE INDEX idx_service_device_shares_service ON service_device_shares(service_id);

    CREATE VIEW assignment_services AS
      SELECT id AS assignment_id, service_id, 1 AS is_owner FROM service_device_assignments
      UNION ALL
      SELECT assignment_id, service_id, 0 AS is_owner FROM service_device_shares;
  `
};

export default migration;
