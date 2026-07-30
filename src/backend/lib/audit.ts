import type { FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import type { AuthenticatedUser } from './auth';

type AuditRequest = FastifyRequest & { user?: AuthenticatedUser };

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | number | null;
  summary?: string | null;
  metadata?: unknown;
};

function insertAudit(db: Database.Database, request: AuditRequest, entry: AuditEntry): void {
  const actor = request.user;
  db.prepare(`
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
}

export function recordAudit(request: AuditRequest, entry: AuditEntry): void {
  try {
    insertAudit(getSqliteDatabase(), request, entry);
  } catch {
    // Audit must not make the operational action fail.
  }
}

/**
 * Inserts an audit entry into a caller-owned transaction. Unlike `recordAudit`,
 * this is intentionally strict: callers with mandatory audit requirements must
 * receive an insertion failure so the enclosing operational write rolls back.
 */
export function recordAuditStrict(db: Database.Database, request: AuditRequest, entry: AuditEntry): void {
  insertAudit(db, request, entry);
}
