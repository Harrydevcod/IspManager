import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import {
  authBypassed,
  hashPassword,
  isSetupComplete,
  loadUserById,
  signToken,
  verifyPassword,
  verifyToken,
  type AuthenticatedUser,
  type UserRole
} from '../lib/auth';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200)
});

const setupSchema = z.object({
  username: z.string().trim().min(2).max(80),
  password: z.string().min(8).max(200),
  fullName: z.string().trim().min(1).max(180)
});

function bearerToken(request: FastifyRequest): string | null {
  // Apenas o header Authorization. Nunca aceitar o token via query string: a URL
  // vaza para o histórico do browser/Electron e para os logs de pedidos do backend.
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice(7).trim() || null;
  }
  return null;
}

export function attachUserHook() {
  return async function attachUser(request: FastifyRequest) {
    if (authBypassed()) return;
    const token = bearerToken(request);
    if (!token) return;
    const payload = verifyToken(token);
    if (!payload) return;
    const user = loadUserById(payload.uid);
    if (!user) return;
    request.user = user;
  };
}

export function requireAuth() {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (authBypassed()) return;
    if (!request.user) {
      reply.status(401).send({ error: 'Sessao nao autenticada' });
    }
  };
}

export function requireRole(roles: UserRole[]) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (authBypassed()) return;
    if (!request.user) {
      reply.status(401).send({ error: 'Sessao nao autenticada' });
      return;
    }
    if (!roles.includes(request.user.role)) {
      reply.status(403).send({ error: 'Permissao insuficiente' });
    }
  };
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.addHook('preHandler', attachUserHook());

  app.get('/api/auth/status', async () => {
    return {
      setupRequired: !isSetupComplete(),
      authBypassed: authBypassed()
    };
  });

  app.post('/api/auth/setup', async (request, reply) => {
    if (isSetupComplete()) {
      return reply.status(409).send({ error: 'Setup ja foi concluido' });
    }
    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de setup invalidos' });
    }
    const db = getSqliteDatabase();
    let passwordHash: string;
    try {
      passwordHash = hashPassword(parsed.data.password);
    } catch {
      return reply.status(400).send({ error: 'Password invalida' });
    }
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, role, full_name, active)
      VALUES (?, ?, 'admin', ?, 1)
    `).run(parsed.data.username, passwordHash, parsed.data.fullName);

    const user: AuthenticatedUser = {
      id: Number(result.lastInsertRowid),
      username: parsed.data.username,
      fullName: parsed.data.fullName,
      role: 'admin'
    };
    const token = signToken(user);
    return reply.status(201).send({ token, user });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Credenciais invalidas' });
    }
    const db = getSqliteDatabase();
    const row = db.prepare(`
      SELECT id, username, password_hash AS passwordHash, role, full_name AS fullName, active
      FROM users
      WHERE lower(username) = lower(?)
    `).get(parsed.data.username) as
      | {
          id: number;
          username: string;
          passwordHash: string;
          role: UserRole;
          fullName: string;
          active: number;
        }
      | undefined;

    if (!row || row.active !== 1 || !verifyPassword(parsed.data.password, row.passwordHash)) {
      return reply.status(401).send({ error: 'Credenciais invalidas' });
    }

    const user: AuthenticatedUser = {
      id: row.id,
      username: row.username,
      fullName: row.fullName,
      role: row.role
    };
    const token = signToken(user);
    return reply.send({ token, user });
  });

  app.get('/api/auth/me', { preHandler: requireAuth() }, async (request, reply) => {
    if (authBypassed()) {
      return reply.send({
        user: { id: 0, username: 'system', fullName: 'System', role: 'admin' as UserRole }
      });
    }
    return reply.send({ user: request.user });
  });
}
