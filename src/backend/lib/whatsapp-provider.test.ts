import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getCredentialVault, setCredentialVault, writeSecret } from './secrets';
import { configuredWhatsappProviderLabel, normalizeWhatsappPhone, resolveWhatsappProvider } from './whatsapp-provider';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

const setSetting = (key: string, value: string) =>
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-wa-provider-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM app_settings').run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

function stubFetch(body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }));
  return calls;
}

describe('resolveWhatsappProvider', () => {
  test('nothing configured: no provider, and the label says which one is missing', () => {
    expect(resolveWhatsappProvider(db)).toBeNull();
    expect(configuredWhatsappProviderLabel(db)).toBe('UltraMsg');
  });

  test('UltraMsg is the default and sends with the opened token', async () => {
    setSetting('ultraMsgInstanceId', 'instance9');
    writeSecret(db, 'ultraMsgToken', 'token-aberto');
    const calls = stubFetch({ sent: 'true', id: 'm1' });

    const provider = resolveWhatsappProvider(db);
    expect(provider?.id).toBe('ultramsg');
    expect(provider?.fetchStatuses).toBeTypeOf('function');

    const result = await provider!.sendText({ to: '+2389912233', body: 'ola' });
    expect(result).toMatchObject({ ok: true, messageId: 'm1' });
    expect(calls[0].url).toBe('https://api.ultramsg.com/instance9/messages/chat');
    expect(String(calls[0].init?.body)).toContain('token=token-aberto');
  });

  test('UltraMsg receives the PDF as base64', async () => {
    setSetting('ultraMsgInstanceId', 'instance9');
    writeSecret(db, 'ultraMsgToken', 'token-aberto');
    const calls = stubFetch({ sent: 'true', id: 'd1' });

    await resolveWhatsappProvider(db)!.sendDocument({ to: '+2389912233', document: Buffer.from('PDF'), filename: 'f.pdf', caption: '' });

    expect(calls[0].url).toBe('https://api.ultramsg.com/instance9/messages/document');
    expect(new URLSearchParams(String(calls[0].init?.body)).get('document')).toBe(Buffer.from('PDF').toString('base64'));
  });

  test('whatsappProvider = meta-cloud picks the Meta transport', async () => {
    setSetting('whatsappProvider', 'meta-cloud');
    setSetting('metaPhoneNumberId', '1055');
    writeSecret(db, 'metaAccessToken', 'meta-token');
    const calls = stubFetch({ messages: [{ id: 'wamid.1' }] });

    const provider = resolveWhatsappProvider(db);
    expect(provider?.id).toBe('meta-cloud');
    // A Meta so entrega estados por webhook: nao ha o que sondar.
    expect(provider?.fetchStatuses).toBeUndefined();

    const result = await provider!.sendText({ to: '+2389912233', body: 'ola' });
    expect(result).toEqual({ ok: true, messageId: 'wamid.1' });
    expect(calls[0].url).toContain('graph.facebook.com');
  });

  test('the chosen provider is not replaced by the other one when its credentials are missing', () => {
    setSetting('whatsappProvider', 'meta-cloud');
    setSetting('ultraMsgInstanceId', 'instance9');
    writeSecret(db, 'ultraMsgToken', 'token-aberto');

    expect(resolveWhatsappProvider(db)).toBeNull();
    expect(configuredWhatsappProviderLabel(db)).toBe('Meta Cloud API');
  });

  test('an unknown stored value falls back to UltraMsg', () => {
    setSetting('whatsappProvider', 'telegram');
    expect(configuredWhatsappProviderLabel(db)).toBe('UltraMsg');
  });

  test('with the vault locked the token does not open, so there is no provider', () => {
    setSetting('ultraMsgInstanceId', 'instance9');
    writeSecret(db, 'ultraMsgToken', 'token-aberto');
    const vault = getCredentialVault();
    setCredentialVault(null);
    try {
      expect(resolveWhatsappProvider(db)).toBeNull();
    } finally {
      setCredentialVault(vault);
    }
  });
});

describe('normalizeWhatsappPhone', () => {
  test.each([
    ['9912233', '+2389912233'],
    ['238 991 22 33', '+2389912233'],
    ['+351 912 345 678', '+351912345678'],
    ['', ''],
    ['abc', '']
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeWhatsappPhone(raw)).toBe(expected);
  });
});
