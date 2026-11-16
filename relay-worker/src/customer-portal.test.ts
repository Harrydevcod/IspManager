import { describe, expect, test, vi } from 'vitest';
import { CustomerPortal } from './customer-portal';

class Storage {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return this.data.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async setAlarm(_time: number) {}
}
const admin = 'a'.repeat(64);
function req(method: string, body?: unknown, key = admin) {
  return new Request('https://example.test/', { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const envelope = { version: 1, nonce: 'AAECAwQFBgcICQoL', ciphertext: 'YWJj', tag: 'AAAAAAAAAAAAAAAAAAAAAA' };

describe('customer portal relay', () => {
  test('publishes ciphertext only with admin authority and supports revocation', async () => {
    const store = new Storage();
    const portal = new CustomerPortal({ storage: store }, { RELAY_ADMIN_KEY: admin });
    const payload = { envelope, expiresAt: Date.now() + 60_000 };
    expect((await portal.fetch(req('PUT', payload, 'wrong'))).status).toBe(401);
    expect((await portal.fetch(req('PUT', payload))).status).toBe(201);
    const response = await portal.fetch(new Request('https://example.test/'));
    expect(await response.json()).toEqual(payload);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await portal.fetch(req('DELETE', undefined, 'wrong'))).status).toBe(401);
    expect((await portal.fetch(req('DELETE'))).status).toBe(204);
    expect((await portal.fetch(new Request('https://example.test/'))).status).toBe(404);
  });
  test('rejects expired, oversized and malformed snapshots', async () => {
    const portal = new CustomerPortal({ storage: new Storage() }, { RELAY_ADMIN_KEY: admin });
    expect((await portal.fetch(req('PUT', { envelope, expiresAt: Date.now() - 1 }))).status).toBe(400);
    expect((await portal.fetch(req('PUT', { envelope: { ...envelope, nonce: 'bad' }, expiresAt: Date.now() + 60000 }))).status).toBe(400);
    expect((await portal.fetch(req('PUT', { envelope: { ...envelope, ciphertext: 'a'.repeat(150000) }, expiresAt: Date.now() + 60000 }))).status).toBe(413);
  });
  test('an expired snapshot is inaccessible and removed', async () => {
    vi.useFakeTimers();
    try {
      const store = new Storage();
      const portal = new CustomerPortal({ storage: store }, { RELAY_ADMIN_KEY: admin });
      expect((await portal.fetch(req('PUT', { envelope, expiresAt: Date.now() + 1000 }))).status).toBe(201);
      vi.advanceTimersByTime(1001);
      expect((await portal.fetch(new Request('https://example.test/'))).status).toBe(404);
      expect(store.data.has('snapshot')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
