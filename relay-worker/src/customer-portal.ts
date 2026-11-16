type Storage = { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<boolean>; setAlarm(time: number): Promise<void> };
type Envelope = { version: 1; nonce: string; ciphertext: string; tag: string };
type Published = { envelope: Envelope; expiresAt: number };
const maxBytes = 128 * 1024;
const maxLifetime = 7 * 24 * 60 * 60 * 1000;
const headers = { 'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' };

async function equalSecret(a: string, b: string) {
  const encode = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', encode.encode(a)), crypto.subtle.digest('SHA-256', encode.encode(b))]);
  const left = new Uint8Array(x), right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length') || 0) > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(joined);
}

export class CustomerPortal {
  constructor(private state: { storage: Storage }, private env: { RELAY_ADMIN_KEY?: string }) {}
  async fetch(request: Request): Promise<Response> {
    const storage = this.state.storage;
    if (request.method === 'GET') {
      const data = await storage.get<Published>('snapshot');
      if (!data || data.expiresAt <= Date.now()) { if (data) await storage.delete('snapshot'); return new Response(null, { status: 404, headers }); }
      return new Response(JSON.stringify(data), { headers });
    }
    if (request.method !== 'PUT' && request.method !== 'DELETE') return new Response(null, { status: 405, headers });
    const authorization = request.headers.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!this.env.RELAY_ADMIN_KEY || !(await equalSecret(token, this.env.RELAY_ADMIN_KEY))) return new Response(null, { status: 401, headers });
    if (request.method === 'DELETE') { await storage.delete('snapshot'); return new Response(null, { status: 204, headers }); }
    const text = await readBody(request);
    if (text === null) return new Response(null, { status: 413, headers });
    let value: Published;
    try { value = JSON.parse(text) as Published; } catch { return new Response(null, { status: 400, headers }); }
    const e = value?.envelope;
    if (!Number.isSafeInteger(value?.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + maxLifetime ||
      e?.version !== 1 || !/^[A-Za-z0-9_-]{16}$/.test(e.nonce) || !/^[A-Za-z0-9_-]{22}$/.test(e.tag) || !/^[A-Za-z0-9_-]+$/.test(e.ciphertext)) return new Response(null, { status: 400, headers });
    await storage.put('snapshot', { envelope: { version: 1, nonce: e.nonce, ciphertext: e.ciphertext, tag: e.tag }, expiresAt: value.expiresAt });
    await storage.setAlarm(value.expiresAt);
    return new Response(null, { status: 201, headers });
  }
  async alarm() {
    const data = await this.state.storage.get<Published>('snapshot');
    if (!data) return;
    if (data.expiresAt <= Date.now()) await this.state.storage.delete('snapshot');
    else await this.state.storage.setAlarm(data.expiresAt);
  }
}
