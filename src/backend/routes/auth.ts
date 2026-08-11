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
import { recordAudit } from '../lib/audit';
import { assessLogin, clearThrottle, loginIdentifiers, registerFailure } from '../lib/login-throttle';

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

/**
 * A mesma verificação de papel, utilizável DENTRO de um handler — para rotas
 * onde a exigência depende do estado (substituir uma licença ativa exige
 * admin; ativar numa instalação sem licença não).
 *
 * Devolve `false` já tendo respondido: quem chama só tem de sair.
 */
export function ensureRole(request: FastifyRequest, reply: FastifyReply, roles: UserRole[]): boolean {
  if (authBypassed()) return true;
  if (!request.user) {
    reply.status(401).send({ error: 'Sessao nao autenticada' });
    return false;
  }
  if (!roles.includes(request.user.role)) {
    reply.status(403).send({ error: 'Permissao insuficiente' });
    return false;
  }
  return true;
}

export function requireRole(roles: UserRole[]) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    ensureRole(request, reply, roles);
  };
}

/**
 * Reconfirmação da password do próprio utilizador da sessão.
 *
 * Uma sessão aberta prova quem entrou, não quem está ao teclado agora. Para as
 * ações que desarmam a instalação — remover ou substituir a licença — pedimos a
 * password outra vez, para que um computador deixado destrancado não baste.
 *
 * Reutiliza o mesmo travão do login: as tentativas falhadas contam para os
 * mesmos identificadores, portanto martelar aqui tranca também o login. É a
 * direção segura — é a mesma credencial.
 */
export async function confirmSessionPassword(
  request: FastifyRequest,
  reply: FastifyReply,
  password: unknown
): Promise<boolean> {
  // Sem autenticação não há password para reconfirmar. Mesmo desvio que
  // `ensureRole`, para o modo de desenvolvimento continuar utilizável.
  if (authBypassed()) return true;

  const user = request.user;
  if (!user) {
    reply.status(401).send({ error: 'Sessao nao autenticada' });
    return false;
  }

  if (typeof password !== 'string' || password.length === 0) {
    reply.status(400).send({ error: 'Confirme a sua password para continuar.' });
    return false;
  }

  const db = getSqliteDatabase();
  const identifiers = loginIdentifiers(user.username, request.ip);

  const lock = assessLogin(db, identifiers, new Date());
  if (lock.locked) {
    reply.header('Retry-After', String(lock.retryAfterSeconds));
    reply.status(429).send({
      error: 'Demasiadas tentativas falhadas. Tente novamente mais tarde.',
      retryAfterSeconds: lock.retryAfterSeconds
    });
    return false;
  }

  const row = db.prepare(`
    SELECT password_hash AS passwordHash FROM users WHERE id = ? AND active = 1
  `).get(user.id) as { passwordHash: string } | undefined;

  if (!row || !verifyPassword(password, row.passwordHash)) {
    for (const identifier of identifiers) registerFailure(db, identifier, new Date());
    recordAudit(request, {
      action: 'password_confirm_failed',
      entityType: 'auth',
      summary: user.username,
      metadata: { ip: request.ip }
    });
    reply.status(403).send({ error: 'Password incorreta.' });
    return false;
  }

  clearThrottle(db, identifiers);
  return true;
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
    const throttled = !authBypassed();
    const identifiers = loginIdentifiers(parsed.data.username, request.ip);

    // Reject before touching the password path if this account/IP is locked,
    // so a lockout costs the attacker nothing to maintain.
    if (throttled) {
      const lock = assessLogin(db, identifiers, new Date());
      if (lock.locked) {
        recordAudit(request, {
          action: 'login_locked',
          entityType: 'auth',
          summary: parsed.data.username,
          metadata: { ip: request.ip, retryAfterSeconds: lock.retryAfterSeconds }
        });
        reply.header('Retry-After', String(lock.retryAfterSeconds));
        return reply.status(429).send({
          error: 'Demasiadas tentativas falhadas. Tente novamente mais tarde.',
          retryAfterSeconds: lock.retryAfterSeconds
        });
      }
    }

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
      if (throttled) {
        for (const identifier of identifiers) registerFailure(db, identifier, new Date());
      }
      recordAudit(request, {
        action: 'login_failed',
        entityType: 'auth',
        summary: parsed.data.username,
        metadata: { ip: request.ip }
      });
      return reply.status(401).send({ error: 'Credenciais invalidas' });
    }

    if (throttled) {
      clearThrottle(db, identifiers);
    }

    const user: AuthenticatedUser = {
      id: row.id,
      username: row.username,
      fullName: row.fullName,
      role: row.role
    };
    recordAudit(request, {
      action: 'login_success',
      entityType: 'auth',
      entityId: row.id,
      summary: row.username,
      metadata: { ip: request.ip }
    });
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
