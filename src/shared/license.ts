/**
 * Licenciamento do ISPM — o claim e os estados dele derivados.
 *
 * Uma licença é um JSON assinado (Ed25519) emitido fora da aplicação. Este
 * módulo é PURO e partilhado com o renderer: define a forma do claim, valida-a
 * e transforma-a no estado que a UI e o backend aplicam. Não sabe verificar
 * assinaturas (isso exige `node:crypto`, que não existe no bundle do browser —
 * ver `src/backend/lib/license-signature.ts`) nem ler ficheiros.
 *
 * Duas ofertas, uma mecânica:
 *  - `subscricao` — tem `expiresAt`. Expirada, a app entra em tolerância e
 *    depois em leitura-apenas.
 *  - `perpetua`  — nunca expira. O que caduca é `maintenanceUntil`, que só
 *    corta o direito a atualizações. Quem comprou uma licença perpétua
 *    continua a trabalhar para sempre: isso está no contrato e tem de estar
 *    no código.
 *
 * Regra que atravessa tudo: uma licença caducada NUNCA tranca o ISP fora dos
 * dados dos clientes dele. O pior estado possível é `readonly` — leitura,
 * documentos e backups continuam a funcionar; só a escrita é bloqueada.
 */
import { z } from 'zod';
import { parseDate } from './date';

/** Dias de avaliação a contar do primeiro arranque, sem qualquer licença. */
export const TRIAL_DAYS = 30;

/** Tolerância por omissão depois de uma subscrição expirar. */
export const DEFAULT_GRACE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** `AAAA-MM-DD` que corresponde a uma data real (rejeita 2026-02-31). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato AAAA-MM-DD')
  .refine((value) => {
    const date = parseDate(value);
    return date !== null && value === toIsoDate(date);
  }, 'Data inexistente');

export const licenseClaimSchema = z
  .object({
    /** Versão do formato. Um claim de versão desconhecida é rejeitado. */
    v: z.literal(1),
    /** Referência da licença, citada no suporte (ex.: `LIC-2026-0007`). */
    id: z.string().trim().min(1).max(64),
    customer: z.string().trim().min(1).max(180),
    /** NIF cabo-verdiano: 9 dígitos começados por 1 (singular) ou 2 (coletiva). */
    nif: z.string().regex(/^[12]\d{8}$/).optional(),
    kind: z.enum(['subscricao', 'perpetua']),
    /**
     * `machine` liga a licença a uma instalação (impressão digital da máquina);
     * `none` é a chave simples de desbloqueio, sem ligação a hardware.
     */
    bind: z.enum(['machine', 'none']),
    fingerprint: z.string().trim().min(1).max(128).optional(),
    issuedAt: isoDate,
    /** Só em `subscricao`: último dia de direito de uso (inclusive). */
    expiresAt: isoDate.optional(),
    /** Só em `perpetua`: último dia com direito a atualizações (inclusive). */
    maintenanceUntil: isoDate.optional(),
    graceDays: z.number().int().min(0).max(365).default(DEFAULT_GRACE_DAYS),
    /** Add-ons pagos (cloud, etc.). Vazio hoje — o preço é único. */
    entitlements: z.array(z.string().trim().min(1)).default([])
  })
  .superRefine((claim, ctx) => {
    if (claim.bind === 'machine' && !claim.fingerprint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fingerprint'],
        message: 'Licença ligada à máquina exige fingerprint'
      });
    }
    if (claim.kind === 'subscricao' && !claim.expiresAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Subscrição exige data de validade'
      });
    }
    // Uma perpétua com `expiresAt` seria um engano do emissor a matar uma
    // licença vitalícia paga. Rejeitar na origem, nunca honrar.
    if (claim.kind === 'perpetua' && claim.expiresAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Licença perpétua não pode ter data de validade'
      });
    }
  });

export type LicenseClaim = z.infer<typeof licenseClaimSchema>;

export type LicenseState =
  /** Sem licença, dentro dos 30 dias de avaliação. */
  | 'trial'
  /** Licença válida. */
  | 'active'
  /** Subscrição expirada, ainda dentro da tolerância. */
  | 'grace'
  /** Sem direito de escrita: avaliação terminada ou tolerância esgotada. */
  | 'readonly'
  /** Assinatura inválida, adulterada ou noutra máquina. */
  | 'invalid';

export type LicenseStatus = {
  state: LicenseState;
  /** A app aceita escritas? Falso só em `readonly` e `invalid`. */
  canWrite: boolean;
  /** A instalação tem direito a atualizações? */
  updatesAllowed: boolean;
  /**
   * Dias até `expiresAt` (subscrição) ou até ao fim da avaliação. Negativo
   * depois de passar. `null` quando não há prazo — caso das perpétuas.
   * A UI calcula os dias de tolerância restantes com `claim.graceDays`.
   */
  daysRemaining: number | null;
  /** Mensagem pt-PT pronta a mostrar no banner/ecrã de licença. */
  reason: string;
  claim: LicenseClaim | null;
};

export type LicenseStatusInput = {
  /** Claim já verificado criptograficamente, ou `null` se não há licença. */
  claim?: LicenseClaim | null;
  /** Porquê a verificação da assinatura falhou. Presente ⇒ estado `invalid`. */
  signatureError?: string | null;
  /** Primeiro arranque conhecido (`AAAA-MM-DD`), para contar a avaliação. */
  trialStartedAt?: string | null;
  /** Impressão digital desta máquina, comparada quando `bind === 'machine'`. */
  machineFingerprint?: string | null;
};

/** `Date` → `AAAA-MM-DD` em data local (não UTC: o dia é o do operador). */
export function toIsoDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Dias inteiros de `from` até `to`, à meia-noite local. Positivo quando `to` é
 * posterior. `Math.round` absorve saltos horários (Cabo Verde não os tem, mas
 * a app pode correr noutro fuso).
 */
function daysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / MS_PER_DAY);
}

function plural(days: number, singular: string, pluralWord: string): string {
  return `${days} ${days === 1 ? singular : pluralWord}`;
}

function invalid(reason: string, claim: LicenseClaim | null = null): LicenseStatus {
  return { state: 'invalid', canWrite: false, updatesAllowed: false, daysRemaining: null, reason, claim };
}

/**
 * Analisa um claim (opcional) e devolve o estado que backend e UI aplicam.
 * Função pura: recebe o "agora" para ser determinista nos testes.
 */
export function licenseStatus(input: LicenseStatusInput, now: Date = new Date()): LicenseStatus {
  if (input.signatureError) {
    return invalid(input.signatureError);
  }

  const claim = input.claim ?? null;

  if (!claim) {
    return trialStatus(input.trialStartedAt ?? null, now);
  }

  if (claim.bind === 'machine' && claim.fingerprint !== (input.machineFingerprint ?? null)) {
    return invalid(
      `A licença ${claim.id} está registada noutra máquina. Contacte o suporte para a transferir.`,
      claim
    );
  }

  return claim.kind === 'perpetua' ? perpetualStatus(claim, now) : subscriptionStatus(claim, now);
}

function trialStatus(trialStartedAt: string | null, now: Date): LicenseStatus {
  const started = parseDate(trialStartedAt);
  // Sem marca de início a avaliação começa agora — nunca punir por um ficheiro
  // de estado ausente ou ilegível.
  const used = started ? daysBetween(started, now) : 0;
  const daysRemaining = TRIAL_DAYS - used;

  if (daysRemaining <= 0) {
    return {
      state: 'readonly',
      canWrite: false,
      updatesAllowed: false,
      daysRemaining,
      reason: 'O período de avaliação de 30 dias terminou. Os dados continuam acessíveis para consulta, exportação e cópia de segurança — ative uma licença para voltar a registar.',
      claim: null
    };
  }

  return {
    state: 'trial',
    canWrite: true,
    updatesAllowed: true,
    daysRemaining,
    reason: `Avaliação: ${plural(daysRemaining, 'dia restante', 'dias restantes')}.`,
    claim: null
  };
}

function perpetualStatus(claim: LicenseClaim, now: Date): LicenseStatus {
  const maintenanceEnd = parseDate(claim.maintenanceUntil);
  const updatesAllowed = !maintenanceEnd || daysBetween(now, maintenanceEnd) >= 0;

  return {
    state: 'active',
    canWrite: true,
    updatesAllowed,
    daysRemaining: null,
    reason: updatesAllowed
      ? `Licença perpétua ativa — ${claim.customer}.`
      : `Licença perpétua ativa — ${claim.customer}. A manutenção terminou: a aplicação continua a funcionar, mas deixa de receber atualizações.`,
    claim
  };
}

function subscriptionStatus(claim: LicenseClaim, now: Date): LicenseStatus {
  // O schema garante `expiresAt` nas subscrições; o fallback é só para o
  // compilador não assumir `undefined`.
  const expiry = parseDate(claim.expiresAt);
  if (!expiry) {
    return invalid('Licença de subscrição sem data de validade.', claim);
  }

  const daysRemaining = daysBetween(now, expiry);

  if (daysRemaining >= 0) {
    return {
      state: 'active',
      canWrite: true,
      updatesAllowed: true,
      daysRemaining,
      reason: `Subscrição ativa — ${claim.customer}. Renova em ${plural(daysRemaining, 'dia', 'dias')}.`,
      claim
    };
  }

  const daysOverdue = -daysRemaining;
  const graceLeft = claim.graceDays - daysOverdue;

  if (graceLeft >= 0) {
    return {
      state: 'grace',
      canWrite: true,
      updatesAllowed: true,
      daysRemaining,
      reason: `A subscrição expirou há ${plural(daysOverdue, 'dia', 'dias')}. Renove nos próximos ${plural(graceLeft, 'dia', 'dias')} para não perder o registo de novos dados.`,
      claim
    };
  }

  return {
    state: 'readonly',
    canWrite: false,
    updatesAllowed: false,
    daysRemaining,
    reason: `A subscrição expirou há ${plural(daysOverdue, 'dia', 'dias')}. Os dados continuam acessíveis para consulta, exportação e cópia de segurança — renove para voltar a registar.`,
    claim
  };
}
