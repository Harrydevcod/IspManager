/**
 * Estado da licença e o portão que a aplica.
 *
 * O portão é `onRequest` global: corre antes do body parsing, por isso um
 * pedido bloqueado custa quase nada. A regra é uma só — **quem não pode
 * escrever, não escreve** — com uma lista curta de prefixos sempre isentos.
 *
 * A lista de isentos é a parte que não pode estar errada. Ela existe para
 * garantir a promessa do produto: uma licença caducada nunca tranca o ISP
 * fora dos dados dos clientes dele.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../lib/audit';
import { activateLicense, currentLicenseStatus, deactivateLicense, machineFingerprint } from '../lib/license';
import { licensingEnabled } from '../lib/license-key';
import type { LicenseStatus } from '../../shared/license';
import { confirmSessionPassword, ensureRole, requireRole } from './auth';

/**
 * Prefixos que o portão nunca bloqueia, e porquê:
 *
 *  - `/health`        — diagnóstico do processo.
 *  - `/api/license`   — sem isto não há como ativar a licença que desbloqueia.
 *  - `/api/auth`      — o login é um POST. Bloqueá-lo trancava o utilizador
 *                       fora da própria aplicação, sem sequer poder consultar.
 *  - `/api/backups`   — todo o subsistema de cópias, incluindo criar, importar
 *                       e restaurar. Os dados são do cliente: levá-los ou
 *                       recuperá-los nunca depende de estar em dia connosco.
 */
const EXEMPT_PREFIXES = ['/health', '/api/license', '/api/auth', '/api/backups'];

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isExempt(url: string): boolean {
  // `url` traz a query string; comparar só o caminho.
  const path = url.split('?')[0];
  return EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Bloqueia escritas quando a licença não as permite. Leituras passam sempre:
 * consultar, imprimir documentos e exportar continuam disponíveis em qualquer
 * estado.
 */
export function licenseGateHook() {
  return async function licenseGate(request: FastifyRequest, reply: FastifyReply) {
    if (!WRITE_METHODS.has(request.method)) return;
    if (isExempt(request.url)) return;

    const status = currentLicenseStatus();
    if (status.canWrite) return;

    return reply.status(402).send({
      error: status.reason,
      license: { state: status.state, reason: status.reason }
    });
  };
}

const activateSchema = z.object({
  token: z.string().trim().min(1).max(8192),
  /** Só exigida quando já existe uma licença ativa a ser substituída. */
  password: z.string().min(1).max(200).optional()
});

const deactivateSchema = z.object({
  password: z.string().min(1).max(200).optional()
});

function publicStatus(status: LicenseStatus) {
  return {
    state: status.state,
    canWrite: status.canWrite,
    updatesAllowed: status.updatesAllowed,
    daysRemaining: status.daysRemaining,
    reason: status.reason,
    enabled: licensingEnabled(),
    // O cliente precisa de a ler para pedir uma licença ligada a esta máquina.
    fingerprint: machineFingerprint(),
    license: status.claim
      ? {
          id: status.claim.id,
          customer: status.claim.customer,
          kind: status.claim.kind,
          bind: status.claim.bind,
          issuedAt: status.claim.issuedAt,
          expiresAt: status.claim.expiresAt ?? null,
          maintenanceUntil: status.claim.maintenanceUntil ?? null,
          graceDays: status.claim.graceDays,
          entitlements: status.claim.entitlements
        }
      : null
  };
}

export async function registerLicenseRoutes(app: FastifyInstance) {
  // Sem sessão: o ecrã de licença aparece antes do login.
  app.get('/api/license', async () => publicStatus(currentLicenseStatus()));

  /**
   * Ativar numa instalação SEM licença está aberto a qualquer utilizador, por
   * decisão de produto: quem estiver ao computador quando a avaliação termina
   * deve poder desbloquear a operação com o ficheiro que o dono recebeu, sem
   * esperar pelo admin. Só entra uma licença com assinatura válida e desta
   * máquina, e a auditoria regista quem ativou.
   *
   * **Substituir uma licença ativa é outra coisa.** Troca a licença legítima
   * desta instalação por outra e é indistinguível de a roubar para uma máquina
   * alheia, por isso exige admin E a password dele outra vez — uma sessão
   * aberta prova quem entrou, não quem está ao teclado agora.
   */
  app.post('/api/license', async (request, reply) => {
    const parsed = activateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Pedido inválido' });
    }

    const previous = currentLicenseStatus().claim;
    if (previous) {
      if (!ensureRole(request, reply, ['admin'])) return reply;
      if (!(await confirmSessionPassword(request, reply, parsed.data.password))) return reply;
    }

    const result = activateLicense(parsed.data.token);
    if (!result.ok) {
      return reply.status(400).send({ error: result.reason });
    }

    recordAudit(request, {
      action: previous ? 'replace' : 'activate',
      entityType: 'license',
      entityId: result.claim.id,
      summary: previous
        ? `Licença ${previous.id} substituída por ${result.claim.id} (${result.claim.customer})`
        : `Licença ${result.claim.kind} ativada para ${result.claim.customer}`,
      metadata: {
        replacedId: previous?.id ?? null,
        kind: result.claim.kind,
        bind: result.claim.bind,
        expiresAt: result.claim.expiresAt ?? null,
        maintenanceUntil: result.claim.maintenanceUntil ?? null
      }
    });

    return publicStatus(result.status);
  });

  /**
   * Remover põe a instalação em leitura-apenas. Admin, e password outra vez —
   * a mesma barra de substituir, porque o estrago é o mesmo.
   */
  app.delete('/api/license', { preHandler: requireRole(['admin']) }, async (request, reply) => {
    const parsed = deactivateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Pedido inválido' });
    }
    if (!(await confirmSessionPassword(request, reply, parsed.data.password))) return reply;

    const previous = currentLicenseStatus().claim;
    const status = deactivateLicense();

    recordAudit(request, {
      action: 'deactivate',
      entityType: 'license',
      entityId: previous?.id ?? null,
      summary: previous
        ? `Licença ${previous.id} removida desta máquina`
        : 'Pedido de remoção de licença sem licença ativa'
    });

    return publicStatus(status);
  });
}
