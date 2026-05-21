import type { FastifyRequest } from 'fastify';
import { getSqliteDatabase } from '../db/database';
import type { AuthenticatedUser } from './auth';

type AuditRequest = FastifyRequest & { user?: AuthenticatedUser };

type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | number | null;
  summary?: string | null;
  metadata?: unknown;
};

export function recordAudit(request: AuditRequest, entry: AuditEntry): void {
  try {
    const actor = request.user;
    getSqliteDatabase().prepare(`
      INSERT INTO audit_logs (
        actor_user_id, actor_username, actor_role,
        action, entity_type, entity_id, summary, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actor?.id ?? null,
      actor?.username ?? null,
      actor?.role ?? null,
      entry.action,
      entry.entityType,
      entry.entityId == null ? null : String(entry.entityId),
      entry.summary ?? null,
      entry.metadata === undefined ? null : JSON.stringify(entry.metadata)
    );
  } catch {
    // Audit must not make the operational action fail.
  }
}
