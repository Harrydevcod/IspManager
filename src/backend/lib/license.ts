/**
 * Estado de licenciamento desta instalação: ficheiro em disco, impressão
 * digital da máquina e o estado corrente que o gate do backend aplica.
 *
 * A licença vive em `license.json` dentro de `resolveDataDir()`, **fora da
 * base de dados**. Deliberado: restaurar um backup noutra máquina não pode
 * transportar a licença junto com os dados.
 *
 * Disciplina de disponibilidade, igual à dos backups no arranque: um disco
 * cheio ou uma pasta sem permissões nunca podem bloquear a aplicação. Quando
 * não se consegue ler nem escrever o ficheiro, a avaliação recomeça — falhar
 * para o lado de deixar trabalhar.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { licenseStatus, toIsoDate, type LicenseClaim, type LicenseStatus } from '../../shared/license';
import { licensePublicKey, licensingEnabled } from './license-key';
import { verifyLicenseToken, type VerifiedLicense } from './license-signature';
import { resolveDataDir } from './paths';

export type LicenseFile = {
  v: 1;
  /** Primeiro arranque conhecido, `AAAA-MM-DD`. */
  trialStartedAt: string;
  /** Token assinado da licença ativa, ou `null` se ainda não há licença. */
  token: string | null;
  /** Quando a licença foi ativada nesta máquina, `AAAA-MM-DD`. */
  activatedAt: string | null;
};

export function licenseFilePath(): string {
  return path.join(resolveDataDir(), 'license.json');
}

// Verificar a assinatura implica ler o disco e correr Ed25519; o gate corre em
// TODOS os pedidos. Guardamos o resultado da verificação (a parte cara) e
// recalculamos o estado (função pura e barata) a cada pedido — assim a
// passagem da meia-noite muda o estado sem precisar de TTL nem invalidação.
let cache: { token: string | null; verified: VerifiedLicense | null } | null = null;

export function resetLicenseCache(): void {
  cache = null;
}

function readLicenseFile(): LicenseFile | null {
  const file = licenseFilePath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LicenseFile>;
    if (parsed?.v !== 1 || typeof parsed.trialStartedAt !== 'string') return null;
    return {
      v: 1,
      trialStartedAt: parsed.trialStartedAt,
      token: typeof parsed.token === 'string' ? parsed.token : null,
      activatedAt: typeof parsed.activatedAt === 'string' ? parsed.activatedAt : null
    };
  } catch {
    // Ficheiro corrompido ou ilegível: tratar como inexistente.
    return null;
  }
}

function writeLicenseFile(state: LicenseFile): boolean {
  try {
    mkdirSync(resolveDataDir(), { recursive: true });
    writeFileSync(licenseFilePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Estado em disco, criando a marca de avaliação no primeiro arranque. Se a
 * escrita falhar devolve na mesma um estado válido em memória — a avaliação
 * recomeça no próximo arranque, o que é preferível a bloquear.
 */
export function ensureLicenseFile(now: Date = new Date()): LicenseFile {
  const existing = readLicenseFile();
  if (existing) return existing;

  const fresh: LicenseFile = {
    v: 1,
    trialStartedAt: toIsoDate(now),
    token: null,
    activatedAt: null
  };
  writeLicenseFile(fresh);
  resetLicenseCache();
  return fresh;
}

/**
 * Identidade da máquina, para as licenças ligadas a uma instalação.
 *
 * Só entram atributos que não mudam no dia-a-dia: o nome do computador
 * distingue duas máquinas iguais do mesmo lote; plataforma, arquitetura e
 * modelo do CPU mudam quando a máquina muda. Memória e endereços MAC ficaram
 * de fora de propósito — aumentar RAM ou ligar um adaptador USB/VPN não pode
 * invalidar a licença de ninguém.
 *
 * ponytail: composto de atributos genéricos, sem identificador de hardware.
 * Renomear o PC ou trocar o CPU obriga a reemitir a licença (fluxo de suporte
 * já previsto). Se isso vier a acontecer com frequência, o passo seguinte é o
 * MachineGuid do registo do Windows via `reg query`.
 */
export function machineFingerprint(): string {
  const cpu = os.cpus()[0]?.model ?? 'cpu-desconhecido';
  const parts = [os.hostname(), os.platform(), os.arch(), cpu.trim()];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

function verifyCached(token: string | null): VerifiedLicense | null {
  if (!token) return null;
  if (cache && cache.token === token) return cache.verified;
  const verified = verifyLicenseToken(token, licensePublicKey());
  cache = { token, verified };
  return verified;
}

/** Estado corrente desta instalação. Barato: seguro de chamar por pedido. */
export function currentLicenseStatus(now: Date = new Date()): LicenseStatus {
  if (!licensingEnabled()) {
    return {
      state: 'active',
      canWrite: true,
      updatesAllowed: true,
      daysRemaining: null,
      reason: 'Licenciamento não configurado nesta instalação.',
      claim: null
    };
  }

  const state = ensureLicenseFile(now);
  const verified = verifyCached(state.token);

  return licenseStatus(
    {
      claim: verified?.ok ? verified.claim : null,
      signatureError: verified && !verified.ok ? verified.reason : null,
      trialStartedAt: state.trialStartedAt,
      machineFingerprint: machineFingerprint()
    },
    now
  );
}

/**
 * A instalação pode escrever? Usado pelo portão HTTP e pelas tarefas em
 * processo, para que faturar automaticamente e faturar à mão obedeçam à mesma
 * regra. As cópias de segurança são a exceção: correm sempre.
 */
export function licenseAllowsWrites(now: Date = new Date()): boolean {
  return currentLicenseStatus(now).canWrite;
}

export type ActivationResult =
  | { ok: true; status: LicenseStatus; claim: LicenseClaim }
  | { ok: false; reason: string };

/**
 * Instala um token de licença. Rejeita antes de gravar: uma licença que o
 * cliente não pode usar (assinatura errada, outra máquina, já expirada) nunca
 * deve substituir a que lá está.
 */
export function activateLicense(token: string, now: Date = new Date()): ActivationResult {
  if (!licensingEnabled()) {
    return { ok: false, reason: 'Licenciamento não está configurado nesta instalação.' };
  }

  const verified = verifyLicenseToken(token, licensePublicKey());
  if (!verified.ok) {
    return { ok: false, reason: verified.reason };
  }

  const candidate = licenseStatus(
    { claim: verified.claim, machineFingerprint: machineFingerprint() },
    now
  );
  if (!candidate.canWrite) {
    return { ok: false, reason: candidate.reason };
  }

  const state = ensureLicenseFile(now);
  const saved = writeLicenseFile({
    ...state,
    token: token.replace(/\s+/g, ''),
    activatedAt: toIsoDate(now)
  });
  if (!saved) {
    return { ok: false, reason: 'Não foi possível gravar a licença. Verifique as permissões da pasta de dados.' };
  }

  resetLicenseCache();
  return { ok: true, status: currentLicenseStatus(now), claim: verified.claim };
}

/**
 * Remove a licença desta máquina — o passo do lado do cliente quando se muda
 * de computador. Mantém a marca de avaliação: desativar não oferece 30 dias
 * grátis outra vez.
 */
export function deactivateLicense(now: Date = new Date()): LicenseStatus {
  const state = ensureLicenseFile(now);
  writeLicenseFile({ ...state, token: null, activatedAt: null });
  resetLicenseCache();
  return currentLicenseStatus(now);
}

/** Apaga o ficheiro de estado. Só para testes e diagnóstico. */
export function clearLicenseState(): void {
  rmSync(licenseFilePath(), { force: true });
  resetLicenseCache();
}
