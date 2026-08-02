/**
 * Assinatura e verificação das licenças do ISPM (Ed25519, `node:crypto`).
 *
 * Formato do token: `base64url(claimJson).base64url(assinatura)` — a mesma
 * forma do token de sessão em `./auth`, para haver um só formato de credencial
 * no produto. Um token completo cabe num ficheiro `.ispmlic` que se envia por
 * email; `verifyLicenseToken` ignora espaços e quebras de linha, por isso
 * colar o conteúdo à mão também funciona.
 *
 * A chave PRIVADA nunca entra no repositório nem no bundle: vive na máquina de
 * quem emite as licenças (ver `scripts/issue-license.cjs`). Só a pública é
 * embutida na aplicação, e é passada por parâmetro para este módulo se manter
 * puro e testável.
 */
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { licenseClaimSchema, type LicenseClaim } from '../../shared/license';

export type VerifiedLicense =
  | { ok: true; claim: LicenseClaim }
  | { ok: false; reason: string };

export type LicenseKeyPair = { publicKey: string; privateKey: string };

/** Par de chaves Ed25519 em PEM. Corre uma vez, na emissão do produto. */
export function generateLicenseKeyPair(): LicenseKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKey, privateKey };
}

/**
 * Assina um claim já validado e devolve o token. Valida antes de assinar: um
 * claim malformado assinado é uma licença partida que só se descobre no
 * cliente.
 */
export function signLicense(claim: LicenseClaim, privateKeyPem: string): string {
  const parsed = licenseClaimSchema.parse(claim);
  const payload = Buffer.from(JSON.stringify(parsed), 'utf8');
  // Ed25519 assina a mensagem inteira: o algoritmo de digest é `null`.
  const signature = sign(null, payload, privateKeyPem);
  return `${payload.toString('base64url')}.${signature.toString('base64url')}`;
}

export function verifyLicenseToken(token: string, publicKeyPem: string): VerifiedLicense {
  if (typeof token !== 'string' || token.trim() === '') {
    return { ok: false, reason: 'Licença vazia.' };
  }

  // Tolerar quebras de linha e espaços de um copiar-colar.
  const compact = token.replace(/\s+/g, '');
  const dot = compact.indexOf('.');
  if (dot < 1 || dot === compact.length - 1) {
    return { ok: false, reason: 'Ficheiro de licença inválido.' };
  }

  const payload = Buffer.from(compact.slice(0, dot), 'base64url');
  const signature = Buffer.from(compact.slice(dot + 1), 'base64url');
  if (payload.length === 0 || signature.length === 0) {
    return { ok: false, reason: 'Ficheiro de licença inválido.' };
  }

  let signatureOk: boolean;
  try {
    signatureOk = verify(null, payload, publicKeyPem, signature);
  } catch {
    // Chave pública malformada ou assinatura de tamanho impossível.
    return { ok: false, reason: 'Não foi possível verificar a assinatura da licença.' };
  }
  if (!signatureOk) {
    return { ok: false, reason: 'A assinatura da licença não confere. Peça um novo ficheiro ao suporte.' };
  }

  let json: unknown;
  try {
    json = JSON.parse(payload.toString('utf8'));
  } catch {
    return { ok: false, reason: 'Conteúdo da licença ilegível.' };
  }

  const parsed = licenseClaimSchema.safeParse(json);
  if (!parsed.success) {
    // A assinatura confere mas o conteúdo não cumpre as regras — licença
    // emitida por uma versão mais recente, ou erro do emissor.
    return { ok: false, reason: 'Licença não reconhecida por esta versão do ISPM.' };
  }

  return { ok: true, claim: parsed.data };
}
