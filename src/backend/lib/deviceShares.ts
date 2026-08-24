import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ServiceOpResult } from './services';

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

/**
 * Clientes servidos POR PARTILHA com id, para o operador poder escolher um deles.
 * Irmão do `SHARED_WITH_NAMES_SQL` — mesma expectativa sobre o alias `a`.
 */
export const SHARED_WITH_SQL = `(
  SELECT json_group_array(json_object('serviceId', sh.service_id, 'clientName', shc.full_name))
  FROM service_device_shares sh
  JOIN services shs ON shs.id = sh.service_id
  JOIN clients shc ON shc.id = shs.client_id
  WHERE sh.assignment_id = a.id
)`;

export const promoteOwnerSchema = z.object({
  serviceId: z.coerce.number().int().positive(),
  // O titular antigo costuma estar a sair (é esse o caso que obriga a promover
  // alguém), por isso a omissão é desligá-lo da antena.
  keepPreviousAsShare: z.coerce.boolean().default(false),
  reason: z.string().trim().max(500).optional().nullable()
});

export type PromoteOwnerInput = z.infer<typeof promoteOwnerSchema>;

export type PromoteOwnerResult = {
  assignmentId: number;
  fromServiceId: number;
  toServiceId: number;
  fromClientName: string;
  toClientName: string;
  keptPreviousAsShare: boolean;
  rentalFeeCve: number;
};

type OwnerRow = {
  id: number;
  serviceId: number;
  endDate: string | null;
  ipAddress: string | null;
  rentalFeeCve: number;
  label: string;
  clientName: string;
};

/**
 * Promove um vizinho a titular da unidade física.
 *
 * O titular é a âncora de tudo o que é físico — stock, IP, devolução, renda — por
 * isso quando ele sai a antena tem de mudar de dono em vez de ficar órfã. Aqui não
 * se mexe em stock nem em `rental_fee_cve`: a unidade é a mesma e a renda é a
 * mesma, muda só quem a paga, porque `loadServiceRentals` lê o `service_id` da
 * atribuição.
 *
 * Só se promove quem já é servido pela antena — mover uma antena para um serviço
 * qualquer seria uma reinstalação, não uma promoção.
 */
export function promoteAssignmentOwner(
  db: Database.Database,
  assignmentId: number,
  data: PromoteOwnerInput,
  actorId: number | null
): ServiceOpResult<PromoteOwnerResult> {
  const current = db.prepare(`
    SELECT a.id, a.service_id AS serviceId, a.end_date AS endDate, a.ip_address AS ipAddress,
           a.rental_fee_cve AS rentalFeeCve,
           TRIM(COALESCE(ec.brand, '') || ' ' || ec.model) AS label,
           c.full_name AS clientName
    FROM service_device_assignments a
    JOIN equipment_catalog ec ON ec.id = a.catalog_id
    JOIN services s ON s.id = a.service_id
    JOIN clients c ON c.id = s.client_id
    WHERE a.id = ?
  `).get(assignmentId) as OwnerRow | undefined;

  if (!current) {
    return { ok: false, status: 404, error: 'Atribuicao nao encontrada' };
  }
  if (current.endDate) {
    return { ok: false, status: 400, error: 'Atribuicao ja encerrada' };
  }
  if (data.serviceId === current.serviceId) {
    return { ok: false, status: 409, error: 'Este servico ja e o titular do equipamento' };
  }

  const target = db.prepare(`
    SELECT s.id, c.full_name AS clientName,
           EXISTS(SELECT 1 FROM service_device_shares sh WHERE sh.assignment_id = ? AND sh.service_id = s.id) AS isSharer
    FROM services s
    JOIN clients c ON c.id = s.client_id
    WHERE s.id = ?
  `).get(assignmentId, data.serviceId) as { id: number; clientName: string; isSharer: number } | undefined;

  if (!target) {
    return { ok: false, status: 404, error: 'Servico nao encontrado' };
  }
  if (!target.isSharer) {
    return {
      ok: false,
      status: 409,
      error: 'Este servico nao e servido por esta antena. Partilhe primeiro.'
    };
  }

  const reason = data.reason?.trim() || null;
  const notes = [
    `Titularidade da antena ${current.label} passou de ${current.clientName} para ${target.clientName}.`,
    data.keepPreviousAsShare
      ? `${current.clientName} continua a ser servido por partilha.`
      : `${current.clientName} deixa de ser servido por esta antena.`,
    reason
  ].filter(Boolean).join(' ');

  db.transaction(() => {
    db.prepare(`
      UPDATE service_device_assignments
      SET service_id = ?, updated_at = datetime('now')
      WHERE id = ? AND end_date IS NULL
    `).run(target.id, assignmentId);

    db.prepare('DELETE FROM service_device_shares WHERE assignment_id = ? AND service_id = ?')
      .run(assignmentId, target.id);

    if (data.keepPreviousAsShare) {
      db.prepare(`
        INSERT OR IGNORE INTO service_device_shares (assignment_id, service_id)
        VALUES (?, ?)
      `).run(assignmentId, current.serviceId);
    }

    // O endereço segue a unidade física: deixá-lo também no serviço antigo poria o
    // mesmo IP em dois serviços ativos.
    if (current.ipAddress) {
      db.prepare(`
        UPDATE services
        SET ip_address = NULL, updated_at = datetime('now')
        WHERE id = ? AND ip_address = ?
      `).run(current.serviceId, current.ipAddress);
    }

    const event = db.prepare(`
      INSERT INTO service_events (service_id, event_type, notes, created_by, created_at)
      VALUES (?, 'alteracao_servico', ?, ?, datetime('now'))
    `);
    event.run(current.serviceId, notes, actorId);
    event.run(target.id, notes, actorId);
  })();

  return {
    ok: true,
    value: {
      assignmentId,
      fromServiceId: current.serviceId,
      toServiceId: target.id,
      fromClientName: current.clientName,
      toClientName: target.clientName,
      keptPreviousAsShare: data.keepPreviousAsShare,
      rentalFeeCve: current.rentalFeeCve
    }
  };
}
