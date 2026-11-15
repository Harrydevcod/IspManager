import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { readSecret } from './secrets';
import { deriveRelayKeys, openRelayEnvelope, sealRelayEnvelope, type RelayEnvelope } from './sms-relay-crypto';

/**
 * Transporte pelo relé (ADR 0024): o pedido que o ISPM faria por HTTP na rede
 * local segue cifrado para a caixa do pareamento, o telemóvel recolhe-o e
 * devolve a resposta cifrada. O relé só vê envelopes.
 */

const CALL_TIMEOUT_MS = 5000;
const EXCHANGE_LIFETIME_MS = 2 * 60_000;
// ponytail: o telemóvel consulta o relé de 15 em 15 s; long-poll se a espera incomodar.
/** Quanto se espera pela resposta do telemóvel e de quanto em quanto se pergunta por ela. */
export const relayTiming = { waitMs: 25_000, pollMs: 1000 };
/** Cabeçalhos da resposta do telemóvel que os chamadores leem. */
const RESPONSE_HEADERS = ['content-type', 'x-ispm-response-signature'];

export type RelayConfig = { url: string; secret: string };

function setting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() || '';
}

/** HTTPS, sem credenciais nem parâmetros; HTTP só para um Worker local em ensaio. */
export function normalizeRelayUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** O relé só existe com endereço guardado e pareamento v2 (segredo de 32 bytes). */
export function relayConfig(db: Database.Database): RelayConfig | null {
  const url = setting(db, 'smsRelayUrl');
  if (!url || setting(db, 'smsCompanionPairingVersion') !== '2') return null;
  const secret = readSecret(db, 'smsCompanionPairingKey');
  return /^[0-9a-f]{64}$/i.test(secret) ? { url, secret } : null;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function call(url: string, method: string, token: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
  });
}

function mailbox(config: RelayConfig) {
  const keys = deriveRelayKeys(config.secret);
  return { base: `${config.url}/m/${keys.mailbox.toString('hex')}`, desktop: keys.desktop.toString('hex'), phone: keys.phone.toString('hex') };
}

/** Cria a caixa deste pareamento. Devolve o estado HTTP do relé (200/201 = pronta). */
export async function registerRelayMailbox(config: RelayConfig, adminKey: string): Promise<number> {
  const box = mailbox(config);
  const response = await call(`${box.base}/register`, 'POST', adminKey, { desktopHash: sha256(box.desktop), phoneHash: sha256(box.phone) });
  return response.status;
}

export async function relayFetch(
  config: RelayConfig,
  adminKey: string,
  method: string,
  path: string,
  body: string,
  nonce: string
): Promise<Response> {
  const box = mailbox(config);
  const id = randomUUID();
  const plaintext = Buffer.concat([Buffer.from(`${JSON.stringify({ method, path, nonce })}\n`, 'utf8'), Buffer.from(body, 'utf8')]);
  const envelope = sealRelayEnvelope(config.secret, 'request', id, Date.now() + EXCHANGE_LIFETIME_MS, plaintext);

  let posted = await call(`${box.base}/requests/${id}`, 'POST', box.desktop, envelope);
  // Pareamento novo: a caixa ainda não existe no relé.
  if (posted.status === 404 && adminKey && [200, 201].includes(await registerRelayMailbox(config, adminKey))) {
    posted = await call(`${box.base}/requests/${id}`, 'POST', box.desktop, envelope);
  }
  if (!posted.ok) throw new Error(`O relé recusou o pedido (${posted.status})`);

  const deadline = Date.now() + relayTiming.waitMs;
  try {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, relayTiming.pollMs));
      const response = await call(`${box.base}/responses/${id}`, 'GET', box.desktop);
      if (response.status === 204) continue;
      if (!response.ok) throw new Error(`O relé falhou (${response.status})`);
      const answer = (await response.json()) as { envelope: RelayEnvelope };
      return decodeResponse(openRelayEnvelope(config.secret, 'response', id, answer.envelope));
    }
    throw new Error('O telemóvel não respondeu pelo relé');
  } finally {
    // Respondido ou abandonado, o pedido sai da caixa: o telemóvel não o executa mais tarde.
    void call(`${box.base}/responses/${id}`, 'DELETE', box.desktop).catch(() => undefined);
  }
}

/** `{status, headers}` numa linha, depois o corpo em bruto (fotografias incluídas). */
function decodeResponse(plain: Buffer): Response {
  const cut = plain.indexOf(10);
  if (cut < 0) throw new Error('Resposta do relé inválida');
  const head = JSON.parse(plain.subarray(0, cut).toString('utf8')) as { status?: unknown; headers?: unknown };
  const status = head.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) throw new Error('Resposta do relé inválida');
  const headers = new Headers();
  const given = head.headers && typeof head.headers === 'object' ? (head.headers as Record<string, unknown>) : {};
  for (const name of RESPONSE_HEADERS) {
    const value = given[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  const bodyless = status === 204 || status === 205 || status === 304;
  return new Response(bodyless ? null : new Uint8Array(plain.subarray(cut + 1)), { status, headers });
}
