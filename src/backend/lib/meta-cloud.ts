/**
 * Transporte da WhatsApp Cloud API oficial da Meta (Graph API).
 *
 * Limite a ter presente: a Meta só aceita texto livre até 24 h depois de o
 * cliente escrever à empresa. Fora dessa janela exige um modelo aprovado;
 * o erro 131047 diz isso mesmo.
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

export async function sendMetaCloudTemplate(
  phoneNumberId: string, accessToken: string, to: string,
  template: { name: string; language: string; params: string[] }
): Promise<WhatsappSendResult> {
  return sendMessage(phoneNumberId, accessToken, to, {
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      ...(template.params.length ? { components: [{ type: 'body', parameters: template.params.map((text) => ({ type: 'text', text })) }] } : {})
    }
  });
}

export async function listMetaCloudTemplates(
  businessAccountId: string, accessToken: string
): Promise<{ ok: true; templates: Array<{ name: string; language: string; body: string }> } | { ok: false; reason: string }> {
  const templates: Array<{ name: string; language: string; body: string }> = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  try {
    do {
      const query = new URLSearchParams({ fields: 'name,language,status,components', limit: '100' });
      if (cursor) query.set('after', cursor);
      const response = await fetch(`${GRAPH_URL}/${encodeURIComponent(businessAccountId)}/message_templates?${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000)
      });
      const result = await readJson(response);
      if (!response.ok) return { ok: false, reason: describeMetaFailure(result) };
      if (!result || typeof result !== 'object' || !Array.isArray((result as { data?: unknown }).data)) return { ok: false, reason: 'Resposta invalida da Meta' };
      const data = result as { data: Array<{ name?: unknown; language?: unknown; status?: unknown; components?: Array<{ type?: unknown; text?: unknown }> }>; paging?: { next?: unknown; cursors?: { after?: unknown } } };
      for (const item of data.data) {
        const body = Array.isArray(item.components) ? item.components.find((c) => c.type === 'BODY')?.text : undefined;
        const supported = Array.isArray(item.components) && item.components.every((c) => c && (c.type === 'BODY' || c.type === 'FOOTER'));
        if (supported && item.status === 'APPROVED' && typeof item.name === 'string' && typeof item.language === 'string' && typeof body === 'string') templates.push({ name: item.name, language: item.language, body });
      }
      const next = data.paging?.next && data.paging.cursors?.after;
      if (data.paging?.next && (typeof next !== 'string' || !next)) return { ok: false, reason: 'Paginacao invalida da Meta' };
      cursor = typeof next === 'string' ? next : undefined;
      if (cursor && seen.has(cursor)) return { ok: false, reason: 'Paginacao invalida da Meta' };
      if (cursor) seen.add(cursor);
      if (seen.size > 100) return { ok: false, reason: 'Demasiadas paginas de modelos da Meta' };
    } while (cursor);
    return { ok: true, templates };
  } catch {
    return { ok: false, reason: 'Nao foi possivel contactar a Meta' };
  }
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
