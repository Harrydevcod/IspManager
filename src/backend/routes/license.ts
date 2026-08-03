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
import { requireRole } from './auth';

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
  token: z.string().trim().min(1).max(8192)
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
   * Ativar está aberto a qualquer utilizador, por decisão de produto: quem
   * estiver ao computador quando a licença caduca deve poder desbloquear a
   * operação com o ficheiro que o dono recebeu, sem esperar pelo admin.
   *
   * O risco é baixo e limitado: só entra uma licença com assinatura válida,
   * dentro da validade e desta máquina, e nunca substitui a que lá está por
   * uma pior. A auditoria regista quem ativou. Remover, essa sim, continua
   * reservada ao admin — é a ação que põe a instalação em leitura-apenas.
   */
  app.post('/api/license', async (request, reply) => {
    const parsed = activateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Pedido inválido' });
    }

    const result = activateLicense(parsed.data.token);
    if (!result.ok) {
      return reply.status(400).send({ error: result.reason });
    }

    recordAudit(request, {
      action: 'activate',
      entityType: 'license',
      entityId: result.claim.id,
      summary: `Licença ${result.claim.kind} ativada para ${result.claim.customer}`,
      metadata: {
        kind: result.claim.kind,
        bind: result.claim.bind,
        expiresAt: result.claim.expiresAt ?? null,
        maintenanceUntil: result.claim.maintenanceUntil ?? null
      }
    });

    return publicStatus(result.status);
  });

  app.delete('/api/license', { preHandler: requireRole(['admin']) }, async (request) => {
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
