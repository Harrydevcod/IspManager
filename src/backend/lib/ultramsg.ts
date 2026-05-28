/**
 * UltraMsg WhatsApp transport. Shared by the manual notify route and the
 * automatic overdue-notices control job so the send/format logic lives in
 * exactly one place.
 */

export type UltraMsgSendResult =
  | { ok: true; result: unknown }
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

export async function sendViaUltraMsg(
  instanceId: string,
  token: string,
  to: string,
  body: string
): Promise<UltraMsgSendResult> {
  const payload = new URLSearchParams({ token, to, body });
  try {
    const response = await fetch(`https://api.ultramsg.com/${encodeURIComponent(instanceId)}/messages/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload
    });
    const result = await readUltraMsgResponse(response);
    if (!response.ok) {
      return { ok: false, reason: 'UltraMsg recusou o envio', details: result };
    }
    return { ok: true, result };
  } catch {
    return { ok: false, reason: 'Nao foi possivel contactar UltraMsg' };
  }
}
