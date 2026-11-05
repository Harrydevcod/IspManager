import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { CompanionSnapshot } from './companion-snapshot';

/**
 * O resumo do Painel vai pela rede local em HTTP: a assinatura HMAC prova quem
 * o mandou, mas não o esconde. Com telefones e moradas de clientes lá dentro,
 * passa a ir cifrado (AES-256-GCM) com uma chave derivada do segredo do
 * pareamento — que só o desktop e o telemóvel pareado conhecem.
 *
 * Contrato com a app Android (dashboard/SealedSnapshot.kt): chave =
 * HMAC-SHA256(segredo, "ispm-dashboard-v1"); envelope JSON
 * `{ enc: "aes-256-gcm", iv: base64(12 bytes), data: base64(cifra || tag de 16) }`.
 */
export const SEALED_MIN_APP_VERSION = '0.5.0';
const KEY_LABEL = 'ispm-dashboard-v1';

export type SealedEnvelope = { enc: 'aes-256-gcm'; iv: string; data: string };

function dashboardKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

export function sealPayload(plaintext: string, secret: string, iv: Buffer = randomBytes(12)): SealedEnvelope {
  const cipher = createCipheriv('aes-256-gcm', dashboardKey(secret), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { enc: 'aes-256-gcm', iv: iv.toString('base64'), data: data.toString('base64') };
}

/** Só para testes e diagnóstico: o desktop nunca precisa de abrir o que mandou. */
export function openPayload(envelope: SealedEnvelope, secret: string): string {
  const raw = Buffer.from(envelope.data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', dashboardKey(secret), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8');
}

export function appSupportsSealed(appVersion: string | null | undefined): boolean {
  if (!appVersion) return false;
  const a = appVersion.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = SEALED_MIN_APP_VERSION.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/**
 * O que segue para o telemóvel. App 0.5.0+: o resumo inteiro, cifrado. App mais
 * antiga (não sabe decifrar): o resumo de antes, em claro e SEM os campos novos
 * com telefones, moradas e caixa — continua a funcionar e não expõe mais do que já expunha.
 */
export function payloadForApp(snapshot: CompanionSnapshot, sealed: boolean, secret: string): unknown {
  if (sealed) return sealPayload(JSON.stringify(snapshot), secret);
  const { work: _work, clients: _clients, ...rest } = snapshot;
  const { debtors: _debtors, cashToday: _cash, monthlyReceipts: _months, ...money } = snapshot.money;
  return { ...rest, money };
}
