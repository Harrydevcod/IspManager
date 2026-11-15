import { describe, expect, test } from 'vitest';
import { Mailbox } from './mailbox';

class MemoryStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> { return this.data.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.data.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.data.delete(key); }
  async transaction<T>(fn: (storage: MemoryStorage) => Promise<T>): Promise<T> { return fn(this); }
  async setAlarm(time: number): Promise<void> { this.alarm = time; }
}

const desktop = 'a'.repeat(64), phone = 'b'.repeat(64);
const id = '00000000-0000-4000-8000-000000000001';
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const request = (path: string, method: string, token: string, body?: unknown) => new Request(`https://relay.test${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('mailbox', () => {
  test('requires registration and role-specific capabilities; repeats return the same response', async () => {
    const storage = new MemoryStorage();
    const box = new Mailbox({ storage }, { RELAY_ADMIN_KEY: 'c'.repeat(64) });
    const register = { desktopHash: await hash(desktop), phoneHash: await hash(phone) };
    expect((await box.fetch(request('/register', 'POST', 'wrong', register))).status).toBe(401);
    expect((await box.fetch(request('/register', 'POST', 'c'.repeat(64), register))).status).toBe(201);
    const envelope = { version: 1, expiresAt: Date.now() + 60_000, nonce: 'AAECAwQFBgcICQoL', ciphertext: 'YQ', tag: 'AAAAAAAAAAAAAAAAAAAAAA' };
    expect((await box.fetch(request(`/requests/${id}`, 'POST', phone, envelope))).status).toBe(401);
    expect((await box.fetch(request(`/requests/${id}`, 'POST', desktop, envelope))).status).toBe(201);
    expect((await box.fetch(request(`/requests/${id}`, 'POST', desktop, envelope))).status).toBe(200);
    const list = await box.fetch(request('/requests', 'GET', phone));
    expect(await list.json()).toMatchObject({ requests: [{ id, envelope }] });
    expect((await box.fetch(request(`/responses/${id}`, 'POST', phone, envelope))).status).toBe(201);
    const response = await box.fetch(request(`/responses/${id}`, 'GET', desktop));
    expect(await response.json()).toEqual({ envelope });
    expect((await box.fetch(request(`/responses/${id}`, 'DELETE', desktop))).status).toBe(204);
    expect((await box.fetch(request(`/requests/${id}`, 'POST', desktop, envelope))).status).toBe(410);
  });

  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const fresh = (ms = 60_000) => ({ version: 1, expiresAt: Date.now() + ms, nonce: 'AAECAwQFBgcICQoL', ciphertext: 'YQ', tag: 'AAAAAAAAAAAAAAAAAAAAAA' });
  async function registered() {
    const storage = new MemoryStorage();
    const box = new Mailbox({ storage }, { RELAY_ADMIN_KEY: 'c'.repeat(64) });
    await box.fetch(request('/register', 'POST', 'c'.repeat(64), { desktopHash: await hash(desktop), phoneHash: await hash(phone) }));
    return { storage, box };
  }

  test('an unregistered mailbox answers nothing, and a second pairing cannot take it over', async () => {
    const box = new Mailbox({ storage: new MemoryStorage() }, { RELAY_ADMIN_KEY: 'c'.repeat(64) });
    expect((await box.fetch(request('/requests', 'GET', phone))).status).toBe(404);
    const mine = { desktopHash: await hash(desktop), phoneHash: await hash(phone) };
    expect((await box.fetch(request('/register', 'POST', 'c'.repeat(64), mine))).status).toBe(201);
    expect((await box.fetch(request('/register', 'POST', 'c'.repeat(64), mine))).status).toBe(200);
    expect((await box.fetch(request('/register', 'POST', 'c'.repeat(64), { ...mine, phoneHash: await hash('x') }))).status).toBe(409);
    expect((await new Mailbox({ storage: new MemoryStorage() }, {}).fetch(request('/register', 'POST', '', mine))).status).toBe(401);
  });

  test('rejects malformed, expired and far-future envelopes and oversized bodies', async () => {
    const { box } = await registered();
    const post = (body: unknown) => box.fetch(request(`/requests/${id}`, 'POST', desktop, body));
    expect((await post({ ...fresh(), version: 2 })).status).toBe(400);
    expect((await post(fresh(-1))).status).toBe(400);
    expect((await post(fresh(7 * 60_000))).status).toBe(400);
    expect((await post({ ...fresh(), nonce: 'short' })).status).toBe(400);
    expect((await post({ ...fresh(), ciphertext: 'a'.repeat(1_400_001) })).status).toBe(400);
    expect((await post({ ...fresh(), ciphertext: 'a'.repeat(1_402_000) })).status).toBe(413);
    expect((await box.fetch(request('/requests/not-a-uuid', 'POST', desktop, fresh()))).status).toBe(404);
  });

  test('each side only does its own half of the exchange', async () => {
    const { box } = await registered();
    await box.fetch(request(`/requests/${id}`, 'POST', desktop, fresh()));
    expect((await box.fetch(request('/requests', 'GET', desktop))).status).toBe(404);
    expect((await box.fetch(request(`/responses/${id}`, 'POST', desktop, fresh()))).status).toBe(401);
    expect((await box.fetch(request(`/responses/${id}`, 'GET', phone))).status).toBe(405);
    expect((await box.fetch(request(`/responses/${id}`, 'GET', desktop))).status).toBe(204);
    expect((await box.fetch(request(`/responses/${uuid(9)}`, 'POST', phone, fresh()))).status).toBe(404);
  });

  test('a request the desktop gave up on is never handed to the phone', async () => {
    const { box } = await registered();
    await box.fetch(request(`/requests/${id}`, 'POST', desktop, fresh()));
    expect((await box.fetch(request(`/responses/${id}`, 'DELETE', desktop))).status).toBe(204);
    expect(await (await box.fetch(request('/requests', 'GET', phone))).json()).toEqual({ requests: [] });
    expect((await box.fetch(request(`/responses/${id}`, 'POST', phone, fresh()))).status).toBe(410);
  });

  test('caps the mailbox, and expired messages leave no trace', async () => {
    const { box, storage } = await registered();
    for (let n = 1; n <= 64; n++) expect((await box.fetch(request(`/requests/${uuid(n)}`, 'POST', desktop, fresh(1000 + n)))).status).toBe(201);
    expect((await box.fetch(request(`/requests/${uuid(65)}`, 'POST', desktop, fresh()))).status).toBe(429);
    expect(storage.alarm).toBeLessThan(Date.now() + 2000);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await box.alarm();
    expect([...storage.data.keys()].sort()).toEqual(['auth', 'index']);
    expect(storage.data.get('index')).toEqual([]);
    // Sem mensagens, o alarme passa a vigiar a caixa parada.
    expect(storage.alarm).toBeGreaterThan(Date.now() + 80 * 86_400_000);
  });

  test('a mailbox idle for 90 days deletes itself', async () => {
    const { box, storage } = await registered();
    const deleteAll = async () => storage.data.clear();
    const idle = new Mailbox({ storage: Object.assign(storage, { deleteAll }) }, {});
    storage.data.set('auth', { ...(storage.data.get('auth') as object), usedDay: Math.floor(Date.now() / 86_400_000) - 90 });
    await idle.alarm();
    expect(storage.data.size).toBe(0);
    expect((await box.fetch(request('/requests', 'GET', phone))).status).toBe(404);
  });
});

describe('worker routing', () => {
  test('only /m/<64 hex>/... reaches a mailbox', async () => {
    const { mailboxRoute } = await import('./index');
    expect(mailboxRoute(`/m/${'a'.repeat(64)}/requests/${id}`)).toEqual({ mailbox: 'a'.repeat(64), path: `/requests/${id}` });
    expect(mailboxRoute(`/m/${'A'.repeat(64)}/requests`)).toBeNull();
    expect(mailboxRoute(`/m/${'a'.repeat(63)}/requests`)).toBeNull();
    expect(mailboxRoute('/register')).toBeNull();
  });
});
