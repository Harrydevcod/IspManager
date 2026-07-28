import type Database from 'better-sqlite3';

/**
 * Partilha de uma unidade física por vários serviços (antena de prédio, antena com
 * várias saídas de rede). A leitura passa pela vista `assignment_services` da
 * migração 0030; aqui ficam só as guardas de escrita, que precisam de contagens e
 * nomes em TypeScript.
 */

export type SharerService = {
  serviceId: number;
  clientId: number;
  clientName: string;
};

/**
 * Serviços EXTRA servidos por esta atribuição — exclui o titular. Base dos 409 de
 * `/return` e do aviso ao operador, por isso traz o nome do cliente.
 */
export function sharerServices(db: Database.Database, assignmentId: number): SharerService[] {
  return db.prepare(`
    SELECT sh.service_id AS serviceId, s.client_id AS clientId, c.full_name AS clientName
    FROM service_device_shares sh
    JOIN services s ON s.id = sh.service_id
    JOIN clients c ON c.id = s.client_id
    WHERE sh.assignment_id = ?
    ORDER BY c.full_name
  `).all(assignmentId) as SharerService[];
}

/** Atribuições de que este serviço é TITULAR e que estão partilhadas com outros. */
export function ownedSharedAssignments(db: Database.Database, serviceId: number): number[] {
  const rows = db.prepare(`
    SELECT DISTINCT a.id
    FROM service_device_assignments a
    JOIN service_device_shares sh ON sh.assignment_id = a.id
    WHERE a.service_id = ?
  `).all(serviceId) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/**
 * Clientes servidos POR PARTILHA (não inclui o titular), como subquery escalar.
 * Espera que a query envolvente tenha `service_device_assignments` com alias `a`.
 */
export const SHARED_WITH_NAMES_SQL = `(
  SELECT group_concat(shc.full_name, ', ')
  FROM service_device_shares sh
  JOIN services shs ON shs.id = sh.service_id
  JOIN clients shc ON shc.id = shs.client_id
  WHERE sh.assignment_id = a.id
)`;
