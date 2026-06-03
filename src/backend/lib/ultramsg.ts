/**
 * UltraMsg WhatsApp transport. Shared by the manual notify route and the
 * automatic overdue-notices control job so the send/format logic lives in
 * exactly one place.
 */

export type UltraMsgSendResult =
  | { ok: true; result: unknown; messageId?: string }
  | { ok: false; reason: string; details?: unknown };

/** Normalize a raw phone to UltraMsg's `+<country><number>` form (Cabo Verde). */
export function normalizeUltraMsgPhone(phone: string): string {
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

async function readUltraMsgResponse(response: Response): Promise<unknown> {
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

function extractMessageId(result: unknown): string | undefined {
  if (result && typeof result === 'object') {
    const id = (result as Record<string, unknown>).id;
    if (typeof id === 'string' && id) return id;
    if (typeof id === 'number') return String(id);
  }
  return undefined;
}

async function postUltraMsg(
  instanceId: string,
  endpoint: 'chat' | 'document',
  params: Record<string, string>
): Promise<UltraMsgSendResult> {
  const payload = new URLSearchParams(params);
  try {
    const response = await fetch(`https://api.ultramsg.com/${encodeURIComponent(instanceId)}/messages/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload
    });
    const result = await readUltraMsgResponse(response);
    if (!response.ok) {
      return { ok: false, reason: 'UltraMsg recusou o envio', details: result };
    }
    return { ok: true, result, messageId: extractMessageId(result) };
  } catch (err) {
    return { ok: false, reason: 'Nao foi possivel contactar UltraMsg', details: String(err) };
  }
}

export async function sendViaUltraMsg(instanceId: string, token: string, to: string, body: string): Promise<UltraMsgSendResult> {
  return postUltraMsg(instanceId, 'chat', { token, to, body });
}

export async function sendDocumentViaUltraMsg(
  instanceId: string, token: string, to: string, documentBase64: string, filename: string, caption = ''
): Promise<UltraMsgSendResult> {
  return postUltraMsg(instanceId, 'document', { token, to, filename, document: documentBase64, caption });
}

export type UltraMsgMessage = { id: string; ack: string | number };

export async function fetchUltraMsgSentMessages(
  instanceId: string, token: string, opts: { limit?: number; page?: number } = {}
): Promise<UltraMsgMessage[]> {
  const params = new URLSearchParams({
    token, status: 'sent', sort: 'desc',
    page: String(opts.page ?? 1), limit: String(opts.limit ?? 100)
  });
  try {
    const response = await fetch(`https://api.ultramsg.com/${encodeURIComponent(instanceId)}/messages?${params.toString()}`);
    const result = await readUltraMsgResponse(response);
    if (!response.ok || !result || typeof result !== 'object') return [];
    const list = (result as Record<string, unknown>).messages;
    if (!Array.isArray(list)) return [];
    return list
      .filter((m): m is { id: unknown; ack: unknown } => !!m && typeof m === 'object')
      .map((m) => ({ id: String((m as Record<string, unknown>).id ?? ''), ack: (m as Record<string, unknown>).ack as string | number }))
      .filter((m) => m.id);
  } catch {
    return [];
  }
}

export function mapAckToStatus(ack: string | number): 'sent' | 'delivered' | 'read' {
  if (typeof ack === 'number') return ack >= 3 ? 'read' : ack === 2 ? 'delivered' : 'sent';
  const v = ack.toLowerCase();
  if (v.includes('read') || v.includes('played') || v.includes('viewed')) return 'read';
  if (v.includes('device') || v.includes('delivered')) return 'delivered';
  return 'sent';
}
