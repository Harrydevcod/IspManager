import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { ownedSharedAssignments } from './deviceShares';
import {
  changeServiceStatus,
  generatePppoePassword,
  pppoeUsernameFor,
  type ServiceOpResult,
  type ServiceStatus,
  type ServiceStatusChange
} from './services';

export const serviceTransferSchema = z.object({
  toClientId: z.coerce.number().int().positive(),
  // 'manter': a casa mudou de inquilino e a ligação fica onde está.
  // 'reinstalar': o técnico recolhe o equipamento e leva-o para outro local.
  mode: z.enum(['manter', 'reinstalar']).default('manter'),
  reactivateService: z.coerce.boolean().default(true),
  reason: z.string().trim().max(500).optional().nullable()
});

export type ServiceTransferInput = z.infer<typeof serviceTransferSchema>;

export type ServiceTransferResult = {
  serviceId: number;
  mode: 'manter' | 'reinstalar';
  fromClient: { id: number; name: string };
  toClient: { id: number; name: string };
  clientReactivated: boolean;
  previousStatus: ServiceStatus;
  status: ServiceStatus;
  freedIps: string[];
  pppoeRegenerated: boolean;
  warnings: string[];
};

type ServiceRow = {
  id: number;
  clientId: number;
  status: ServiceStatus;
  ipAddress: string | null;
  pppoeUsername: string | null;
};

type ClientRow = { id: number; fullName: string; status: string };

/**
 * Muda o titular de um serviço.
 *
 * O histórico de faturação NÃO se move: `payments` guarda o `client_id` copiado
 * no momento da emissão, e é assim que tem de ficar — quem foi faturado foi
 * faturado. O que se move é o serviço vivo: plano, mensalidade, aluguer de
 * equipamento e, conforme o modo, a instalação física.
 *
 * Modo 'manter': mesmo equipamento, mesmo IP, mesma antena. Não se toca no PPPoE
 * — rodar as credenciais deixaria o router do cliente offline sem ninguém no
 * local para o reconfigurar.
 *
 * Modo 'reinstalar': o equipamento vai com o serviço para outro sítio. O IP e a
 * ligação à antena do local antigo deixam de valer, por isso libertam-se aqui (é
 * o fim do registo que liberta um endereço); as credenciais PPPoE são regeradas,
 * porque o inquilino anterior conhece as antigas e o técnico está no terreno.
 */
export function transferService(
  db: Database,
  serviceId: number,
  data: ServiceTransferInput,
  actorId: number | null
): ServiceOpResult<ServiceTransferResult> {
  const service = db.prepare(`
    SELECT id, client_id AS clientId, status, ip_address AS ipAddress, pppoe_username AS pppoeUsername
    FROM services WHERE id = ?
  `).get(serviceId) as ServiceRow | undefined;
  if (!service) {
    return { ok: false, status: 404, error: 'Servico nao encontrado' };
  }

  const fromClient = db.prepare('SELECT id, full_name AS fullName, status FROM clients WHERE id = ?')
    .get(service.clientId) as ClientRow | undefined;
  const toClient = db.prepare('SELECT id, full_name AS fullName, status FROM clients WHERE id = ?')
    .get(data.toClientId) as ClientRow | undefined;
  if (!toClient) {
    return { ok: false, status: 404, error: 'Cliente de destino nao encontrado' };
  }
  if (toClient.id === service.clientId) {
    return { ok: false, status: 400, error: 'O servico ja pertence a este cliente' };
  }

  // Atribuições vivas: as que seguem com o serviço e as que definem o IP em uso.
  const openAssignments = db.prepare(`
    SELECT id, ip_address AS ipAddress
    FROM service_device_assignments
    WHERE service_id = ? AND end_date IS NULL
  `).all(serviceId) as Array<{ id: number; ipAddress: string | null }>;

  // Levar daqui uma antena partilhada deixaria os outros serviços sem sinal.
  if (data.mode === 'reinstalar' && ownedSharedAssignments(db, serviceId).length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'Este servico e titular de equipamento partilhado com outros servicos. Remova as partilhas antes de o reinstalar noutro local.'
    };
  }

  const reason = data.reason?.trim() || null;
  const fromName = fromClient?.fullName ?? `cliente ${service.clientId}`;
  const eventNotes = [
    `Transferencia de titular: ${fromName} para ${toClient.fullName}.`,
    data.mode === 'reinstalar'
      ? 'Equipamento recolhido e reinstalado noutro local.'
      : 'Instalacao mantida no mesmo local.',
    reason
  ].filter(Boolean).join(' ');

  const freedIps = data.mode === 'reinstalar'
    ? [service.ipAddress, ...openAssignments.map((row) => row.ipAddress)]
      .filter((ip): ip is string => Boolean(ip && ip.trim()))
    : [];
  const pppoeRegenerated = data.mode === 'reinstalar' && Boolean(service.pppoeUsername);
  const willReactivate = data.reactivateService && service.status !== 'active';

  let statusChange: ServiceOpResult<ServiceStatusChange> | null = null;

  const run = db.transaction(() => {
    db.prepare(`UPDATE services SET client_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(toClient.id, serviceId);

    if (data.mode === 'reinstalar') {
      db.prepare(`UPDATE services SET ip_address = NULL WHERE id = ?`).run(serviceId);
      db.prepare(`
        UPDATE service_device_assignments
        SET ip_address = NULL, updated_at = datetime('now')
        WHERE service_id = ? AND end_date IS NULL
      `).run(serviceId);
      // A antena do local antigo já não serve esta instalação.
      db.prepare(`
        UPDATE backbone_assignment_links
        SET ended_at = datetime('now'),
            ended_by = ?,
            change_reason = COALESCE(change_reason, 'service_transferred'),
            updated_at = datetime('now')
        WHERE ended_at IS NULL
          AND assignment_id IN (
            SELECT id FROM service_device_assignments WHERE service_id = ? AND end_date IS NULL
          )
      `).run(actorId, serviceId);
      if (pppoeRegenerated) {
        db.prepare('UPDATE services SET pppoe_username = ?, pppoe_password = ? WHERE id = ?')
          .run(pppoeUsernameFor(toClient.fullName, serviceId), generatePppoePassword(), serviceId);
      }
    }

    db.prepare(`
      INSERT INTO service_events (service_id, event_type, notes, created_by)
      VALUES (?, 'transferencia', ?, ?)
    `).run(serviceId, eventNotes, actorId);

    // O cliente que regressa volta a ativo. Só ele: a cascata do cliente
    // (routes/clients.ts) cancela serviços, nunca os reativa.
    if (toClient.status === 'cancelled') {
      db.prepare(`UPDATE clients SET status = 'active', updated_at = datetime('now') WHERE id = ?`)
        .run(toClient.id);
    }

    if (willReactivate) {
      statusChange = changeServiceStatus(db, serviceId, 'active', {
        reason: `Transferencia de titular para ${toClient.fullName}`,
        actorId
      });
      if (!statusChange.ok) {
        throw new Error('status_change_failed');
      }
    }
  });

  run();

  const warnings: string[] = [];
  if (openAssignments.length === 0) {
    warnings.push('Este servico nao tem equipamento instalado. Instale o material antes de ligar o cliente.');
  } else if (data.mode === 'reinstalar') {
    warnings.push('Defina o novo IP e a antena que passa a servir esta instalacao.');
  }

  return {
    ok: true,
    value: {
      serviceId,
      mode: data.mode,
      fromClient: { id: service.clientId, name: fromName },
      toClient: { id: toClient.id, name: toClient.fullName },
      clientReactivated: toClient.status === 'cancelled',
      previousStatus: service.status,
      status: willReactivate ? 'active' : service.status,
      freedIps,
      pppoeRegenerated,
      warnings
    }
  };
}
