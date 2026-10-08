import type Database from 'better-sqlite3';
import { sendMetaCloudDocument, sendMetaCloudText } from './meta-cloud';
import { readSecret } from './secrets';
import { fetchUltraMsgSentMessages, mapAckToStatus, sendDocumentViaUltraMsg, sendViaUltraMsg } from './ultramsg';

/**
 * Quem leva a mensagem ao WhatsApp. O outbox, as rotas e o trabalho dos avisos
 * falam só com esta interface; qual é o fornecedor decide-o a configuração
 * (`app_settings.whatsappProvider`). Ver ADR 0013.
 */

export type WhatsappSendResult =
  | { ok: true; messageId?: string }
  | { ok: false; reason: string; details?: unknown };

export type WhatsappDeliveryStatus = 'sent' | 'delivered' | 'read';

export const WHATSAPP_PROVIDER_IDS = ['ultramsg', 'meta-cloud'] as const;
export type WhatsappProviderId = (typeof WHATSAPP_PROVIDER_IDS)[number];

const LABELS: Record<WhatsappProviderId, string> = {
  ultramsg: 'UltraMsg',
  'meta-cloud': 'Meta Cloud API'
};

export interface WhatsappProvider {
  readonly id: WhatsappProviderId;
  readonly label: string;
  sendText(message: { to: string; body: string }): Promise<WhatsappSendResult>;
  sendDocument(message: { to: string; document: Buffer; filename: string; caption: string }): Promise<WhatsappSendResult>;
  /**
   * Estado de entrega das mensagens recentes, por id do fornecedor. Só existe
   * em quem o deixa consultar: a Meta só o entrega por webhook, e o ISPM corre
   * num PC sem endereço público.
   */
  fetchStatuses?(): Promise<Map<string, WhatsappDeliveryStatus>>;
}

/** Telefone no formato `+<país><número>`; 7 dígitos são de Cabo Verde. */
export function normalizeWhatsappPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) {
    return '';
  }
  if (digits.startsWith('238')) {
    return `+${digits}`;
  }
  if (digits.length === 7) {
    return `+238${digits}`;
  }
  return `+${digits}`;
}

function setting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value.trim() || '';
}

function configuredProviderId(db: Database.Database): WhatsappProviderId {
  return setting(db, 'whatsappProvider') === 'meta-cloud' ? 'meta-cloud' : 'ultramsg';
}

/** Nome do fornecedor escolhido, para dizer "X nao configurado". */
export function configuredWhatsappProviderLabel(db: Database.Database): string {
  return LABELS[configuredProviderId(db)];
}

/**
 * O fornecedor escolhido, pronto a enviar. `null` quando lhe falta alguma
 * credencial ou o cofre não a abre aqui: quem chama trata isso como "não
 * configurado" e não contacta ninguém.
 */
export function resolveWhatsappProvider(db: Database.Database): WhatsappProvider | null {
  const id = configuredProviderId(db);

  if (id === 'meta-cloud') {
    const phoneNumberId = setting(db, 'metaPhoneNumberId');
    const accessToken = readSecret(db, 'metaAccessToken');
    if (!phoneNumberId || !accessToken) return null;
    return {
      id,
      label: LABELS[id],
      sendText: ({ to, body }) => sendMetaCloudText(phoneNumberId, accessToken, to, body),
      sendDocument: ({ to, document, filename, caption }) =>
        sendMetaCloudDocument(phoneNumberId, accessToken, to, document, filename, caption)
    };
  }

  const instanceId = setting(db, 'ultraMsgInstanceId');
  const token = readSecret(db, 'ultraMsgToken');
  if (!instanceId || !token) return null;
  return {
    id,
    label: LABELS[id],
    sendText: ({ to, body }) => sendViaUltraMsg(instanceId, token, to, body),
    sendDocument: ({ to, document, filename, caption }) =>
      sendDocumentViaUltraMsg(instanceId, token, to, document.toString('base64'), filename, caption),
    fetchStatuses: async () => {
      const messages = await fetchUltraMsgSentMessages(instanceId, token, { limit: 100 });
      return new Map(messages.map((message) => [message.id, mapAckToStatus(message.ack)]));
    }
  };
}
