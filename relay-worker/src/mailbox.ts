/**
 * Caixa de correio de um pareamento (ADR 0024). Guarda envelopes cifrados entre
 * o ISPM e o telemóvel; não tem a chave que os abre e não escreve nada em logs.
 * Sem imports da Cloudflare, para os testes correrem em Node.
 */

export type MailboxStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(time: number): Promise<void>;
  deleteAll?(): Promise<void>;
};

export type MailboxEnv = { RELAY_ADMIN_KEY?: string };

type Envelope = { version: 1; expiresAt: number; nonce: string; ciphertext: string; tag: string };
type Entry = { id: string; expiresAt: number; bytes: number; state: 'pending' | 'answered' | 'done' };
type Auth = { desktopHash: string; phoneHash: string; usedDay: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_LIFETIME_MS = 6 * 60_000;
/** Texto cifrado em base64url: cerca de 1 MB de conteúdo, abaixo dos 2 MB por valor do Durable Object. */
const MAX_CIPHERTEXT_CHARS = 1_400_000;
const MAX_ENTRIES = 64;
const MAX_MAILBOX_BYTES = 16 * 1024 * 1024;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const IDLE_DAYS = 90;
const DAY_MS = 86_400_000;

const json = (status: number, body?: unknown) =>
  body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseEnvelope(value: unknown, now: number): Envelope | null {
  if (!value || typeof value !== 'object') return null;
  const { version, expiresAt, nonce, ciphertext, tag } = value as Record<string, unknown>;
  if (version !== 1 || !Number.isSafeInteger(expiresAt) || (expiresAt as number) <= now || (expiresAt as number) > now + MAX_LIFETIME_MS) return null;
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(nonce)) return null;
  if (typeof tag !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(tag)) return null;
  if (typeof ciphertext !== 'string' || ciphertext.length > MAX_CIPHERTEXT_CHARS || !/^[A-Za-z0-9_-]*$/.test(ciphertext)) return null;
  return { version: 1, expiresAt: expiresAt as number, nonce, ciphertext, tag };
}

export class Mailbox {
  private readonly storage: MailboxStorage;

  constructor(state: { storage: MailboxStorage }, private readonly env: MailboxEnv) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const now = Date.now();
    const path = new URL(request.url).pathname;
    const header = request.headers.get('authorization') ?? '';
    const tokenHash = header.startsWith('Bearer ') ? await sha256Hex(header.slice(7)) : '';

    if (Number(request.headers.get('content-length') ?? 0) > MAX_CIPHERTEXT_CHARS + 1024) return json(413, { error: 'too-large' });
    let body: unknown;
    if (request.method === 'POST') {
      const text = await request.text();
      if (text.length > MAX_CIPHERTEXT_CHARS + 1024) return json(413, { error: 'too-large' });
      try { body = JSON.parse(text); } catch { return json(400, { error: 'invalid' }); }
    }

    if (path === '/register' && request.method === 'POST') return this.register(tokenHash, body, now);

    const auth = await this.storage.get<Auth>('auth');
    if (!auth) return json(404, { error: 'unregistered' });
    const role = sameText(tokenHash, auth.desktopHash) ? 'desktop' : sameText(tokenHash, auth.phoneHash) ? 'phone' : null;
    if (!role) return json(401, { error: 'unauthorized' });
    const today = Math.floor(now / DAY_MS);
    if (auth.usedDay !== today) await this.storage.put('auth', { ...auth, usedDay: today });

    const entries = await this.purge(now);
    const [, kind, id, extra] = path.split('/');
    if (extra !== undefined || (kind !== 'requests' && kind !== 'responses')) return json(404, { error: 'not-found' });

    if (kind === 'requests' && id === undefined && request.method === 'GET' && role === 'phone') {
      const requests: Array<{ id: string; envelope: Envelope }> = [];
      let size = 0;
      for (const entry of entries) {
        if (entry.state !== 'pending' || size + entry.bytes > MAX_LIST_BYTES) continue;
        const envelope = await this.storage.get<Envelope>(`req:${entry.id}`);
        if (envelope) { requests.push({ id: entry.id, envelope }); size += entry.bytes; }
      }
      return json(200, { requests });
    }

    if (id === undefined || !UUID.test(id)) return json(404, { error: 'not-found' });
    const entry = entries.find((item) => item.id === id);

    if (kind === 'requests' && request.method === 'POST') {
      if (role !== 'desktop') return json(401, { error: 'unauthorized' });
      if (entry) return json(entry.state === 'done' ? 410 : 200, { state: entry.state });
      const envelope = parseEnvelope(body, now);
      if (!envelope) return json(400, { error: 'invalid' });
      const live = entries.filter((item) => item.state !== 'done');
      const bytes = envelope.ciphertext.length;
      if (live.length >= MAX_ENTRIES || live.reduce((sum, item) => sum + item.bytes, bytes) > MAX_MAILBOX_BYTES) return json(429, { error: 'mailbox-full' });
      await this.storage.put(`req:${id}`, envelope);
      await this.save([...entries, { id, expiresAt: envelope.expiresAt, bytes, state: 'pending' }]);
      return json(201, { state: 'pending' });
    }

    if (kind === 'responses' && request.method === 'POST') {
      if (role !== 'phone') return json(401, { error: 'unauthorized' });
      if (!entry) return json(404, { error: 'not-found' });
      if (entry.state !== 'pending') return json(entry.state === 'done' ? 410 : 200, { state: entry.state });
      const envelope = parseEnvelope(body, now);
      if (!envelope) return json(400, { error: 'invalid' });
      await this.storage.put(`res:${id}`, envelope);
      await this.storage.delete(`req:${id}`);
      await this.save(entries.map((item) => (item === entry ? { ...item, bytes: envelope.ciphertext.length, state: 'answered' as const } : item)));
      return json(201, { state: 'answered' });
    }

    if (kind === 'responses' && role === 'desktop' && request.method === 'GET') {
      if (!entry || entry.state === 'done') return json(404, { error: 'not-found' });
      if (entry.state === 'pending') return json(204);
      return json(200, { envelope: await this.storage.get<Envelope>(`res:${id}`) });
    }

    // Também serve para o ISPM desistir de um pedido que o telemóvel ainda não recolheu.
    if (kind === 'responses' && role === 'desktop' && request.method === 'DELETE') {
      if (entry && entry.state !== 'done') {
        await this.storage.delete(`req:${id}`);
        await this.storage.delete(`res:${id}`);
        await this.save(entries.map((item) => (item === entry ? { ...item, bytes: 0, state: 'done' as const } : item)));
      }
      return json(204);
    }

    return json(405, { error: 'not-allowed' });
  }

  /** Limpa o que expirou; uma caixa sem uso há 90 dias apaga-se inteira. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.purge(now);
    const auth = await this.storage.get<Auth>('auth');
    if (auth && entries.length === 0 && Math.floor(now / DAY_MS) - auth.usedDay >= IDLE_DAYS) {
      await this.storage.deleteAll?.();
      return;
    }
    if (entries.length > 0) await this.storage.setAlarm(Math.min(...entries.map((entry) => entry.expiresAt)));
    else if (auth) await this.storage.setAlarm((auth.usedDay + IDLE_DAYS) * DAY_MS + DAY_MS);
  }

  private async register(tokenHash: string, body: unknown, now: number): Promise<Response> {
    const admin = this.env.RELAY_ADMIN_KEY ?? '';
    if (admin.length < 32 || !sameText(tokenHash, await sha256Hex(admin))) return json(401, { error: 'unauthorized' });
    const { desktopHash, phoneHash } = (body ?? {}) as Record<string, unknown>;
    if (typeof desktopHash !== 'string' || typeof phoneHash !== 'string' || !HASH.test(desktopHash) || !HASH.test(phoneHash) || desktopHash === phoneHash) {
      return json(400, { error: 'invalid' });
    }
    const existing = await this.storage.get<Auth>('auth');
    if (existing) return json(existing.desktopHash === desktopHash && existing.phoneHash === phoneHash ? 200 : 409, { registered: true });
    const usedDay = Math.floor(now / DAY_MS);
    await this.storage.put<Auth>('auth', { desktopHash, phoneHash, usedDay });
    await this.storage.setAlarm((usedDay + IDLE_DAYS) * DAY_MS + DAY_MS);
    return json(201, { registered: true });
  }

  private async purge(now: number): Promise<Entry[]> {
    const entries = (await this.storage.get<Entry[]>('index')) ?? [];
    const live = entries.filter((entry) => entry.expiresAt > now);
    if (live.length === entries.length) return entries;
    for (const entry of entries) {
      if (entry.expiresAt > now) continue;
      await this.storage.delete(`req:${entry.id}`);
      await this.storage.delete(`res:${entry.id}`);
    }
    await this.save(live);
    return live;
  }

  private async save(entries: Entry[]): Promise<void> {
    await this.storage.put('index', entries);
    if (entries.length > 0) await this.storage.setAlarm(Math.min(...entries.map((entry) => entry.expiresAt)));
  }
}
