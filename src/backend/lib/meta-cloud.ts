/**
 * Transporte da WhatsApp Cloud API oficial da Meta (Graph API).
 *
 * Limite a ter presente: a Meta só aceita texto livre até 24 h depois de o
 * cliente escrever à empresa. Fora dessa janela exige um modelo aprovado, que
 * o ISPM ainda não envia (ver ADR 0013); o erro 131047 diz isso mesmo.
 */

import type { WhatsappSendResult } from './whatsapp-provider';

// As versões da Graph API vivem cerca de dois anos: rever ao subir.
const GRAPH_URL = 'https://graph.facebook.com/v24.0';

const OUTSIDE_WINDOW_CODE = 131047;

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function describeMetaFailure(result: unknown): string {
  const error = result && typeof result === 'object' ? (result as Record<string, unknown>).error : null;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (record.code === OUTSIDE_WINDOW_CODE) {
      return 'A Meta so aceita texto livre ate 24 h depois de o cliente escrever; este envio precisa de um modelo aprovado';
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return `Meta recusou o envio: ${record.message.trim()}`;
    }
  }
  return 'Meta recusou o envio';
}

type GraphResult = { ok: true; result: unknown } | { ok: false; reason: string; details?: unknown };

async function postGraph(phoneNumberId: string, accessToken: string, endpoint: 'messages' | 'media', init: RequestInit): Promise<GraphResult> {
  try {
    const response = await fetch(`${GRAPH_URL}/${encodeURIComponent(phoneNumberId)}/${endpoint}`, {
      ...init,
      method: 'POST',
      headers: { ...init.headers, Authorization: `Bearer ${accessToken}` }
    });
    const result = await readJson(response);
    if (!response.ok) {
      return { ok: false, reason: describeMetaFailure(result), details: result };
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, reason: 'Nao foi possivel contactar a Meta', details: String(err) };
  }
}

async function sendMessage(phoneNumberId: string, accessToken: string, to: string, content: Record<string, unknown>): Promise<WhatsappSendResult> {
  const sent = await postGraph(phoneNumberId, accessToken, 'messages', {
    headers: { 'Content-Type': 'application/json' },
    // A Meta quer o numero so com digitos; o outbox guarda-o com `+`.
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/\D/g, ''), ...content })
  });
  if (!sent.ok) return sent;
  const messages = (sent.result as { messages?: Array<{ id?: unknown }> } | null)?.messages;
  const id = Array.isArray(messages) ? messages[0]?.id : undefined;
  return { ok: true, messageId: typeof id === 'string' && id ? id : undefined };
}

export async function sendMetaCloudText(phoneNumberId: string, accessToken: string, to: string, body: string): Promise<WhatsappSendResult> {
  return sendMessage(phoneNumberId, accessToken, to, { type: 'text', text: { preview_url: false, body } });
}

/** Dois passos: a Meta não aceita o ficheiro na mensagem, só o id de um carregamento. */
export async function sendMetaCloudDocument(
  phoneNumberId: string, accessToken: string, to: string, document: Buffer, filename: string, caption = ''
): Promise<WhatsappSendResult> {
  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', 'application/pdf');
  form.set('file', new Blob([new Uint8Array(document)], { type: 'application/pdf' }), filename);
  const uploaded = await postGraph(phoneNumberId, accessToken, 'media', { body: form });
  if (!uploaded.ok) return uploaded;
  const mediaId = (uploaded.result as { id?: unknown } | null)?.id;
  if (typeof mediaId !== 'string' || !mediaId) {
    return { ok: false, reason: 'Meta nao devolveu o id do documento', details: uploaded.result };
  }
  return sendMessage(phoneNumberId, accessToken, to, {
    type: 'document',
    document: { id: mediaId, filename, ...(caption ? { caption } : {}) }
  });
}
