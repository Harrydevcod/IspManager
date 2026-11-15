import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import worker from './index';
import { Mailbox, type MailboxStorage } from './mailbox';
import { closeDatabaseForTests, getSqliteDatabase } from '../../src/backend/db/database';
import { writeSecret } from '../../src/backend/lib/secrets';
import { companionTransport, enqueueSmsNotification, resetCompanionTransportForTests, runSmsOutboxIfDue, signedFetch, verifyCompanionPairing } from '../../src/backend/lib/sms-outbox';
import { normalizeRelayUrl, relayConfig, relayTiming } from '../../src/backend/lib/sms-relay';
import { deriveRelayKeys, openRelayEnvelope, sealRelayEnvelope, type RelayEnvelope } from '../../src/backend/lib/sms-relay-crypto';
import { createResponseSignature, verifyResponseSignature } from '../../src/backend/lib/sms-signing';

/**
 * PC ↔ Worker ↔ telemóvel, tudo em processo: o código real do ISPM e do Worker,
 * e um telemóvel simulado que segue o mesmo protocolo que RelayClient.kt.
 */

const SECRET = '0123456789abcdef'.repeat(4);
const ADMIN = 'c'.repeat(64);
const RELAY = 'https://relay.test';

class MemoryStorage implements MailboxStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return this.data.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async setAlarm() { /* os testes não esperam por alarmes */ }
}

type PhoneReply = { status: number; headers?: Record<string, string>; body: string };

let dataDir: string;
let db: Database.Database;
let boxes: Map<string, Mailbox>;
let lan: ((url: string, init: RequestInit) => Promise<Response>) | null;
let relayCalls: string[];
let phoneTimer: ReturnType<typeof setInterval> | null;
/** O que o telemóvel simulado faz com cada pedido aberto. */
let phoneHandler: (meta: { method: string; path: string; nonce: string }, body: string) => PhoneReply | null;
let phoneSeen: Set<string>;
let phoneExecuted: Array<{ method: string; path: string; body: string }>;

const env = {
  MAILBOX: {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = id as string;
      if (!boxes.has(name)) boxes.set(name, new Mailbox({ storage: new MemoryStorage() }, { RELAY_ADMIN_KEY: ADMIN }));
      return boxes.get(name)!;
    }
  }
};

const realFetch = async (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init), env);

async function phonePollOnce() {
  const keys = deriveRelayKeys(SECRET);
  const base = `${RELAY}/m/${keys.mailbox.toString('hex')}`;
  const auth = { authorization: `Bearer ${keys.phone.toString('hex')}` };
  const listed = await realFetch(`${base}/requests`, { headers: auth });
  if (!listed.ok) return;
  const { requests } = (await listed.json()) as { requests: Array<{ id: string; envelope: RelayEnvelope }> };
  for (const { id, envelope } of requests) {
    if (phoneSeen.has(id)) continue;
    const plain = openRelayEnvelope(SECRET, 'request', id, envelope);
    phoneSeen.add(id);
    const cut = plain.indexOf(10);
    const meta = JSON.parse(plain.subarray(0, cut).toString('utf8')) as { method: string; path: string; nonce: string };
    const body = plain.subarray(cut + 1).toString('utf8');
    phoneExecuted.push({ method: meta.method, path: meta.path, body });
    const reply = phoneHandler(meta, body);
    if (!reply) continue; // executou, mas a resposta perdeu-se
    const answer = Buffer.concat([Buffer.from(`${JSON.stringify({ status: reply.status, headers: reply.headers ?? {} })}\n`), Buffer.from(reply.body)]);
    await realFetch(`${base}/responses/${id}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(sealRelayEnvelope(SECRET, 'response', id, Date.now() + 120_000, answer))
    });
  }
}

function startPhone() {
  phoneTimer = setInterval(() => void phonePollOnce(), 15);
}

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-sms-relay-'));
  process.env.ISPM_DATA_DIR = dataDir;
  db = getSqliteDatabase();
});

beforeEach(() => {
  db.prepare('DELETE FROM sms_outbox').run();
  db.prepare('DELETE FROM app_settings').run();
  const set = db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?)');
  set.run('smsCompanionEnabled', 'true');
  set.run('smsCompanionBaseUrl', 'http://192.168.1.50:8765');
  set.run('smsCompanionPairingVersion', '2');
  set.run('smsRelayUrl', RELAY);
  writeSecret(db, 'smsCompanionPairingKey', SECRET);
  writeSecret(db, 'smsRelayAdminKey', ADMIN);
  resetCompanionTransportForTests();
  relayTiming.waitMs = 500;
  relayTiming.pollMs = 15;
  boxes = new Map();
  lan = null;
  relayCalls = [];
  phoneSeen = new Set();
  phoneExecuted = [];
  phoneHandler = () => ({ status: 200, body: '{}' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.startsWith(RELAY)) {
      relayCalls.push(`${init.method ?? 'GET'} ${new URL(url).pathname.replace(/^\/m\/[0-9a-f]{64}/, '')}`);
      return realFetch(url, init);
    }
    if (!lan) throw new TypeError('fetch failed');
    return lan(url, init);
  }));
});

afterEach(() => {
  if (phoneTimer) clearInterval(phoneTimer);
  phoneTimer = null;
  vi.unstubAllGlobals();
  relayTiming.waitMs = 25_000;
  relayTiming.pollMs = 1000;
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

describe('relé: rede local primeiro', () => {
  test('com a rede local a responder, o relé nem é contactado', async () => {
    lan = async () => new Response('{"ok":true}');
    const response = await signedFetch('/status', 'GET');
    expect(response.ok).toBe(true);
    expect(relayCalls).toEqual([]);
    expect(companionTransport()).toBe('lan');
  });

  test('sem rede local, o pedido segue cifrado pelo relé e a resposta volta inteira', async () => {
    phoneHandler = (meta, body) => {
      const answer = JSON.stringify({ echo: JSON.parse(body), path: meta.path });
      return { status: 200, headers: { 'content-type': 'application/json', 'x-ispm-response-signature': createResponseSignature(SECRET, meta.nonce, Buffer.from(answer)) }, body: answer };
    };
    startPhone();
    const response = await signedFetch('/dashboard', 'POST', { nome: 'José Évora' }, 3500, undefined, 'nonce-1');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(JSON.parse(bytes.toString())).toEqual({ echo: { nome: 'José Évora' }, path: '/dashboard' });
    // A assinatura da resposta, que /events e /media exigem, continua a verificar.
    expect(verifyResponseSignature(SECRET, 'nonce-1', bytes, response.headers.get('x-ispm-response-signature'))).toBe(true);
    expect(companionTransport()).toBe('relay');
    // A caixa não existia: o ISPM criou-a com a chave de administração e repetiu.
    expect(relayCalls.slice(0, 3).map((call) => call.replace(/[0-9a-f-]{36}/, ':id'))).toEqual(['POST /requests/:id', 'POST /register', 'POST /requests/:id']);
  });

  test('o relé nunca vê o conteúdo: nem o telefone nem o texto do SMS', async () => {
    startPhone();
    await signedFetch('/requests', 'POST', { requestId: 'r1', toPhone: '+2389912233', body: 'Caro cliente, a sua fatura venceu.' });
    const stored = JSON.stringify([...boxes.values()].map((box) => [...(box as unknown as { storage: MemoryStorage }).storage.data.entries()]));
    expect(stored).not.toContain('2389912233');
    expect(stored).not.toContain('fatura');
    expect(stored).not.toContain(SECRET);
  });

  test('um erro do telemóvel chega como erro, não como falha de transporte', async () => {
    phoneHandler = () => ({ status: 404, body: '{"error":"pedido nao encontrado"}' });
    startPhone();
    const response = await signedFetch('/requests/abc', 'GET');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'pedido nao encontrado' });
  });
});

describe('relé: falhas', () => {
  test('telemóvel sem responder: o pedido é retirado da caixa e as chamadas seguintes falham logo', async () => {
    await expect(signedFetch('/status', 'GET')).rejects.toThrow('não respondeu pelo relé');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(relayCalls.at(-1)).toMatch(/^DELETE \/responses\//);
    await phonePollOnce();
    expect(phoneExecuted).toEqual([]);

    const before = relayCalls.length;
    await expect(signedFetch('/status', 'GET')).rejects.toThrow('inacessível');
    expect(relayCalls.length).toBe(before);
  });

  test('resposta trocada ou alterada pelo relé é recusada', async () => {
    const keys = deriveRelayKeys(SECRET);
    const base = `${RELAY}/m/${keys.mailbox.toString('hex')}`;
    // Um relé desonesto responde com um envelope válido de outra troca.
    const other = '00000000-0000-4000-8000-000000000009';
    const forged = sealRelayEnvelope(SECRET, 'response', other, Date.now() + 60_000, Buffer.from('{"status":200,"headers":{}}\n{"status":"sent"}'));
    phoneTimer = setInterval(() => {
      void (async () => {
        const listed = await realFetch(`${base}/requests`, { headers: { authorization: `Bearer ${keys.phone.toString('hex')}` } });
        if (!listed.ok) return;
        for (const { id } of ((await listed.json()) as { requests: Array<{ id: string }> }).requests) {
          await realFetch(`${base}/responses/${id}`, { method: 'POST', headers: { authorization: `Bearer ${keys.phone.toString('hex')}`, 'content-type': 'application/json' }, body: JSON.stringify(forged) });
        }
      })();
    }, 15);
    await expect(signedFetch('/requests/abc', 'GET')).rejects.toThrow(/authenticate/);
  });

  test('resposta perdida: a repetição leva o mesmo identificador e o telemóvel não duplica o SMS', async () => {
    const stored = new Map<string, string>();
    let lose = true;
    phoneHandler = (_meta, body) => {
      const { requestId } = JSON.parse(body) as { requestId: string };
      if (!stored.has(requestId)) stored.set(requestId, 'pending_approval');
      if (lose) { lose = false; return null; }
      return { status: 200, body: JSON.stringify({ id: requestId, status: stored.get(requestId) }) };
    };
    startPhone();
    const outboxId = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'Teste' });

    expect(await runSmsOutboxIfDue(new Date())).toEqual({ dispatched: 0, retried: 1 });
    const first = db.prepare('SELECT status, android_request_id AS requestId FROM sms_outbox WHERE id=?').get(outboxId) as { status: string; requestId: string };
    expect(first.status).toBe('pending_dispatch');
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);

    resetCompanionTransportForTests();
    db.prepare('UPDATE sms_outbox SET next_attempt_at=NULL WHERE id=?').run(outboxId);
    expect(await runSmsOutboxIfDue(new Date())).toEqual({ dispatched: 1, retried: 0 });
    const second = db.prepare('SELECT status, android_request_id AS requestId FROM sms_outbox WHERE id=?').get(outboxId) as { status: string; requestId: string };
    expect(second).toEqual({ status: 'pending_approval', requestId: first.requestId });
    expect([...stored.keys()]).toEqual([first.requestId]);
  });
});

describe('relé: quando não se aplica', () => {
  test('pareamento revogado ou antigo (v1) nunca usa o relé', async () => {
    writeSecret(db, 'smsCompanionPairingKey', '');
    expect(relayConfig(db)).toBeNull();
    await expect(signedFetch('/status', 'GET')).rejects.toThrow('nao pareado');

    writeSecret(db, 'smsCompanionPairingKey', 'segredo-v1');
    db.prepare(`UPDATE app_settings SET value='' WHERE key='smsCompanionPairingVersion'`).run();
    expect(relayConfig(db)).toBeNull();
    await expect(signedFetch('/status', 'GET')).rejects.toThrow('fetch failed');
    expect(relayCalls).toEqual([]);
  });

  test('a verificação do pareamento só olha para a rede local', async () => {
    startPhone();
    expect(await verifyCompanionPairing(200)).toEqual({ reachable: false, paired: false });
    expect(relayCalls).toEqual([]);
  });

  test('o endereço do relé tem de ser HTTPS, sem credenciais nem parâmetros', () => {
    expect(normalizeRelayUrl(' https://rele.exemplo.workers.dev/ ')).toBe('https://rele.exemplo.workers.dev');
    expect(normalizeRelayUrl('http://rele.exemplo.workers.dev')).toBeNull();
    expect(normalizeRelayUrl('https://user:pass@rele.exemplo.dev')).toBeNull();
    expect(normalizeRelayUrl('https://rele.exemplo.dev/?k=1')).toBeNull();
    expect(normalizeRelayUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(normalizeRelayUrl('rele')).toBeNull();
  });
});
