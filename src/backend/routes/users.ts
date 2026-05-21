import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { hashPassword, type UserRole } from '../lib/auth';
import { recordAudit } from '../lib/audit';
import { requireRole } from './auth';

const ROLES = ['admin', 'operator', 'technician'] as const;

const createSchema = z.object({
  username: z.string().trim().min(2).max(80),
  password: z.string().min(8).max(200),
  fullName: z.string().trim().min(1).max(180),
  role: z.enum(ROLES),
  active: z.coerce.boolean().default(true)
});

const updateSchema = z.object({
  fullName: z.string().trim().min(1).max(180).optional(),
  role: z.enum(ROLES).optional(),
  active: z.coerce.boolean().optional(),
  password: z.string().min(8).max(200).optional()
});

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(200)
});

type UserRow = {
  id: number;
  username: string;
  fullName: string;
  role: UserRole;
  active: number;
  createdAt: string;
  updatedAt: string;
};

function serializeUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    fullName: row.fullName,
    role: row.role,
    active: row.active === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function registerUserRoutes(app: FastifyInstance) {
  const adminOnly = { preHandler: requireRole(['admin']) };

  app.get('/api/users', adminOnly, async () => {
    const db = getSqliteDatabase();
    const rows = db.prepare(`
      SELECT id, username, full_name AS fullName, role, active,
             created_at AS createdAt, updated_at AS updatedAt
      FROM users
      ORDER BY active DESC, full_name ASC
    `).all() as UserRow[];
    return rows.map(serializeUser);
  });

  app.post('/api/users', adminOnly, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de utilizador invalidos' });
    }
    const db = getSqliteDatabase();
    const exists = db.prepare(`SELECT id FROM users WHERE lower(username) = lower(?)`).get(parsed.data.username);
    if (exists) {
      return reply.status(409).send({ error: 'Username ja existe' });
    }
    let passwordHash: string;
    try {
      passwordHash = hashPassword(parsed.data.password);
    } catch {
      return reply.status(400).send({ error: 'Password invalida' });
    }
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, role, full_name, active)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      parsed.data.username,
      passwordHash,
      parsed.data.role,
      parsed.data.fullName,
      parsed.data.active ? 1 : 0
    );
    const row = db.prepare(`
      SELECT id, username, full_name AS fullName, role, active,
             created_at AS createdAt, updated_at AS updatedAt
      FROM users WHERE id = ?
    `).get(result.lastInsertRowid) as UserRow;
    recordAudit(request, {
      action: 'create',
      entityType: 'user',
      entityId: row.id,
      summary: `Criou utilizador @${row.username}`,
      metadata: { role: row.role, active: row.active === 1 }
    });
    return reply.status(201).send(serializeUser(row));
  });

  app.patch('/api/users/:id', adminOnly, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Utilizador invalido' });
    }
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados invalidos' });
    }

    const db = getSqliteDatabase();
    const current = db.prepare(`
      SELECT id, username, full_name AS fullName, role, active,
             created_at AS createdAt, updated_at AS updatedAt
      FROM users WHERE id = ?
    `).get(id) as UserRow | undefined;
    if (!current) {
      return reply.status(404).send({ error: 'Utilizador nao encontrado' });
    }

    // Guard: do not allow demoting/deactivating the last active admin.
    const willDeactivate = parsed.data.active === false && current.active === 1;
    const willChangeRoleFromAdmin =
      parsed.data.role !== undefined && current.role === 'admin' && parsed.data.role !== 'admin';
    if ((willDeactivate || willChangeRoleFromAdmin) && current.role === 'admin') {
      const otherAdmins = db.prepare(`
        SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?
      `).get(id) as { n: number };
      if (otherAdmins.n === 0) {
        return reply.status(400).send({ error: 'Tem de existir pelo menos um admin ativo' });
      }
    }

    const nextFullName = parsed.data.fullName ?? current.fullName;
    const nextRole = parsed.data.role ?? current.role;
    const nextActive = parsed.data.active === undefined ? current.active : parsed.data.active ? 1 : 0;
    let nextPasswordHash: string | null = null;
    if (parsed.data.password) {
      try {
        nextPasswordHash = hashPassword(parsed.data.password);
      } catch {
        return reply.status(400).send({ error: 'Password invalida' });
      }
    }

    if (nextPasswordHash) {
      db.prepare(`
        UPDATE users
        SET full_name = ?, role = ?, active = ?, password_hash = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(nextFullName, nextRole, nextActive, nextPasswordHash, id);
    } else {
      db.prepare(`
        UPDATE users
        SET full_name = ?, role = ?, active = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(nextFullName, nextRole, nextActive, id);
    }

    const row = db.prepare(`
      SELECT id, username, full_name AS fullName, role, active,
             created_at AS createdAt, updated_at AS updatedAt
      FROM users WHERE id = ?
    `).get(id) as UserRow;
    recordAudit(request, {
      action: nextPasswordHash ? 'update_with_password' : 'update',
      entityType: 'user',
      entityId: id,
      summary: `Atualizou utilizador @${row.username}`,
      metadata: { role: row.role, active: row.active === 1 }
    });
    return serializeUser(row);
  });

  app.post('/api/users/:id/reset-password', adminOnly, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Utilizador invalido' });
    }
    const parsed = resetPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Password invalida' });
    }

    const db = getSqliteDatabase();
    const current = db.prepare(`
      SELECT id, username, active FROM users WHERE id = ?
    `).get(id) as { id: number; username: string; active: number } | undefined;
    if (!current) {
      return reply.status(404).send({ error: 'Utilizador nao encontrado' });
    }

    let passwordHash: string;
    try {
      passwordHash = hashPassword(parsed.data.password);
    } catch {
      return reply.status(400).send({ error: 'Password invalida' });
    }

    db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
    `).run(passwordHash, id);

    recordAudit(request, {
      action: 'reset_password',
      entityType: 'user',
      entityId: id,
      summary: `Reiniciou password de @${current.username}`,
      metadata: { active: current.active === 1 }
    });

    return { ok: true };
  });

  app.delete('/api/users/:id', adminOnly, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Utilizador invalido' });
    }
    const db = getSqliteDatabase();
    const current = db.prepare(`SELECT role, active FROM users WHERE id = ?`).get(id) as
      | { role: UserRole; active: number }
      | undefined;
    if (!current) {
      return reply.status(404).send({ error: 'Utilizador nao encontrado' });
    }
    if (current.role === 'admin' && current.active === 1) {
      const otherAdmins = db.prepare(`
        SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?
      `).get(id) as { n: number };
      if (otherAdmins.n === 0) {
        return reply.status(400).send({ error: 'Tem de existir pelo menos um admin ativo' });
      }
    }
    const deleted = db.prepare(`SELECT username, role, active FROM users WHERE id = ?`).get(id) as
      | { username: string; role: UserRole; active: number }
      | undefined;
    db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
    recordAudit(request, {
      action: 'delete',
      entityType: 'user',
      entityId: id,
      summary: deleted ? `Eliminou utilizador @${deleted.username}` : 'Eliminou utilizador',
      metadata: deleted ? { role: deleted.role, active: deleted.active === 1 } : undefined
    });
    return reply.status(204).send();
  });
}
