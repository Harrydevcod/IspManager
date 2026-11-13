import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { closeDatabaseForTests, getSqliteDatabase } from '../db/database';
import { discoverCompanionHosts, enqueueSmsNotification, findPairedCompanion, pollSmsStatusIfDue, runSmsOutboxIfDue, smsDispatchIntervalMs, verifyCompanionPairing } from './sms-outbox';
import { writeSecret } from './secrets';

const oneWifiInterface = {
  wifi: [{ address: '192.168.1.220', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '', cidr: null }]
} as unknown as ReturnType<typeof os.networkInterfaces>;

let dataDir: string;
let db: Database.Database;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-sms-outbox-'));
  process.env.ISPM_DATA_DIR = dataDir;
  db = getSqliteDatabase();
});

beforeEach(() => {
  db.prepare('DELETE FROM sms_outbox').run();
  db.prepare('DELETE FROM client_credits').run();
  db.prepare('DELETE FROM payment_receipts').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare('DELETE FROM app_settings').run();
  db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsCompanionEnabled','true')`).run();
  db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsCompanionBaseUrl','http://192.168.1.50:8765')`).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

describe('SMS outbox', () => {
  test('enqueue creates pending_dispatch row', () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('SMS-1', 'Cliente SMS', 'active')`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 1000, 10, 'active')`).run(clientId).lastInsertRowid as number;
    const paymentId = db.prepare(`INSERT INTO payments (client_id, service_id, reference_month, amount_cve, due_date, status) VALUES (?, ?, '2026-06', 1000, '2026-06-10', 'pending')`).run(clientId, serviceId).lastInsertRowid as number;
    const id = enqueueSmsNotification({
      eventType: 'test',
      toPhone: '+2389912233',
      body: 'teste',
      clientId,
      paymentId,
      serviceId
    });
    const row = db.prepare('SELECT status, client_id, payment_id, service_id FROM sms_outbox WHERE id = ?').get(id) as {
      status: string;
      client_id: number;
      payment_id: number;
      service_id: number;
    };
    expect(row).toMatchObject({
      status: 'pending_dispatch',
      client_id: clientId,
      payment_id: paymentId,
      service_id: serviceId
    });
  });

  test('dispatch marks pending_approval when Android accepts', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    await runSmsOutboxIfDue(new Date(), {
      postRequest: async () => ({ ok: true, androidRequestId: 'android-1' }),
      fetchStatus: async () => ({ status: 'pending_approval' })
    });
    const row = db.prepare('SELECT status, android_request_id FROM sms_outbox WHERE id = ?').get(id) as { status: string; android_request_id: string };
    expect(row).toMatchObject({ status: 'pending_approval', android_request_id: 'android-1' });
  });

  test('an overlapping drain is skipped: the same SMS never goes to the phone twice', async () => {
    enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const postRequest = vi.fn(async () => { await gate; return { ok: true as const, androidRequestId: 'android-1' }; });
    const deps = { postRequest, fetchStatus: async () => ({ status: 'pending_approval' as const }) };
    const first = runSmsOutboxIfDue(new Date(), deps);
    expect((await runSmsOutboxIfDue(new Date(), deps)).skipped).toBeDefined();
    release();
    await first;
    expect(postRequest).toHaveBeenCalledTimes(1);
  });

  test('offline Android schedules retry', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    await runSmsOutboxIfDue(new Date('2026-06-04T12:00:00Z'), {
      postRequest: async () => ({ ok: false, error: 'offline' }),
      fetchStatus: async () => ({ status: 'pending_approval' })
    });
    const row = db.prepare('SELECT status, attempts, next_attempt_at, last_error FROM sms_outbox WHERE id = ?').get(id) as { status: string; attempts: number; next_attempt_at: string | null; last_error: string };
    expect(row.status).toBe('pending_dispatch');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBeTruthy();
    expect(row.last_error).toBe('offline');
  });

  test('retry uses the configured smsRetryGraceMinutes for next_attempt_at', async () => {
    db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsRetryGraceMinutes','10')`).run();
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    await runSmsOutboxIfDue(new Date('2026-06-04T12:00:00Z'), {
      postRequest: async () => ({ ok: false, error: 'offline' }),
      fetchStatus: async () => ({ status: 'pending_approval' })
    });
    const row = db.prepare('SELECT next_attempt_at FROM sms_outbox WHERE id = ?').get(id) as { next_attempt_at: string };
    expect(row.next_attempt_at).toBe('2026-06-04 12:10:00');
  });

  test('retry falls back to 5 minutes when smsRetryGraceMinutes is unset', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    await runSmsOutboxIfDue(new Date('2026-06-04T12:00:00Z'), {
      postRequest: async () => ({ ok: false, error: 'offline' }),
      fetchStatus: async () => ({ status: 'pending_approval' })
    });
    const row = db.prepare('SELECT next_attempt_at FROM sms_outbox WHERE id = ?').get(id) as { next_attempt_at: string };
    expect(row.next_attempt_at).toBe('2026-06-04 12:05:00');
  });

  test('smsDispatchIntervalMs honours the setting and clamps invalid values', () => {
    db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsDispatchIntervalSeconds','120')`).run();
    expect(smsDispatchIntervalMs()).toBe(120_000);
    db.prepare(`UPDATE app_settings SET value='2' WHERE key='smsDispatchIntervalSeconds'`).run();
    expect(smsDispatchIntervalMs()).toBe(60_000); // below the 15s floor → default
    db.prepare(`DELETE FROM app_settings WHERE key='smsDispatchIntervalSeconds'`).run();
    expect(smsDispatchIntervalMs()).toBe(60_000); // unset → default
  });

  test('max attempts marks failed with failure timestamp', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare('UPDATE sms_outbox SET max_attempts=1 WHERE id=?').run(id);

    await runSmsOutboxIfDue(new Date('2026-06-04T12:00:00Z'), {
      postRequest: async () => ({ ok: false, error: 'offline' }),
      fetchStatus: async () => ({ status: 'pending_approval' })
    });

    const row = db.prepare('SELECT status, failed_at FROM sms_outbox WHERE id = ?').get(id) as { status: string; failed_at: string | null };
    expect(row.status).toBe('failed');
    expect(row.failed_at).toBeTruthy();
  });

  test('telemóvel fora de alcance não gasta tentativas: o SMS espera por ele', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare('UPDATE sms_outbox SET max_attempts=1 WHERE id=?').run(id);
    const unreachable = { postRequest: async () => ({ ok: false as const, error: 'fetch failed', unreachable: true }), fetchStatus: async () => ({ status: 'pending_approval' as const }) };

    await runSmsOutboxIfDue(new Date(), unreachable);
    expect(db.prepare('SELECT status, attempts, last_error FROM sms_outbox WHERE id = ?').get(id))
      .toEqual({ status: 'pending_dispatch', attempts: 0, last_error: 'fetch failed' });

    // 24 h sem resposta: desiste, com a razão à vista.
    db.prepare('UPDATE sms_outbox SET next_attempt_at = NULL WHERE id = ?').run(id);
    await runSmsOutboxIfDue(new Date(Date.now() + 25 * 3_600_000), unreachable);
    expect(db.prepare('SELECT status, last_error FROM sms_outbox WHERE id = ?').get(id))
      .toEqual({ status: 'failed', last_error: 'Telemóvel inacessível há 24 h' });
  });

  test('poll updates final sent status', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare(`UPDATE sms_outbox SET status='pending_approval', android_request_id='android-1' WHERE id=?`).run(id);
    await pollSmsStatusIfDue(new Date(), {
      postRequest: async () => ({ ok: true, androidRequestId: 'android-1' }),
      fetchStatus: async () => ({ status: 'sent' })
    });
    const row = db.prepare('SELECT status, sent_at FROM sms_outbox WHERE id = ?').get(id) as { status: string; sent_at: string | null };
    expect(row.status).toBe('sent');
    expect(row.sent_at).toBeTruthy();
  });

  test('poll does not contact the phone while the connection is off', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare(`UPDATE sms_outbox SET status='pending_approval', android_request_id='android-1' WHERE id=?`).run(id);
    db.prepare(`UPDATE app_settings SET value='false' WHERE key='smsCompanionEnabled'`).run();
    const fetchStatus = vi.fn(async () => ({ status: 'sent' as const }));
    expect(await pollSmsStatusIfDue(new Date(), { postRequest: async () => ({ ok: true, androidRequestId: 'x' }), fetchStatus })).toEqual({ updated: 0 });
    expect(fetchStatus).not.toHaveBeenCalled();
    db.prepare(`UPDATE app_settings SET value='true' WHERE key='smsCompanionEnabled'`).run();
  });

  test('poll updates final failed status with failure timestamp', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare(`UPDATE sms_outbox SET status='pending_approval', android_request_id='android-1' WHERE id=?`).run(id);

    await pollSmsStatusIfDue(new Date(), {
      postRequest: async () => ({ ok: true, androidRequestId: 'android-1' }),
      fetchStatus: async () => ({ status: 'failed', error: 'sem permissao SMS' })
    });

    const row = db.prepare('SELECT status, last_error, failed_at FROM sms_outbox WHERE id = ?').get(id) as { status: string; last_error: string | null; failed_at: string | null };
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('sem permissao SMS');
    expect(row.failed_at).toBeTruthy();
  });

  test('poll records the delivery report on a row already sent', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare(`UPDATE sms_outbox SET status='sent', sent_at=datetime('now','-1 hours'), android_request_id='android-1' WHERE id=?`).run(id);
    const deps = {
      postRequest: async () => ({ ok: true as const, androidRequestId: 'android-1' }),
      fetchStatus: vi.fn(async () => ({ status: 'sent' as const, deliveredAt: '2026-11-03T10:15:00.000Z' }))
    };

    expect((await pollSmsStatusIfDue(new Date(), deps)).updated).toBe(1);
    const row = db.prepare('SELECT status, delivered_at FROM sms_outbox WHERE id = ?').get(id) as { status: string; delivered_at: string | null };
    expect(row).toEqual({ status: 'sent', delivered_at: '2026-11-03 10:15:00' });

    // Já entregue: deixa de ser consultado.
    deps.fetchStatus.mockClear();
    await pollSmsStatusIfDue(new Date(), deps);
    expect(deps.fetchStatus).not.toHaveBeenCalled();
  });

  test('poll stops waiting for delivery after 48 hours', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare(`UPDATE sms_outbox SET status='sent', sent_at=datetime('now','-49 hours'), android_request_id='android-1' WHERE id=?`).run(id);
    const fetchStatus = vi.fn(async () => ({ status: 'sent' as const }));
    await pollSmsStatusIfDue(new Date(), { postRequest: async () => ({ ok: true, androidRequestId: 'x' }), fetchStatus });
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  test('poll keeps the first approved_at instead of rewriting it every tick', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare(`UPDATE sms_outbox SET status='pending_approval', android_request_id='android-1' WHERE id=?`).run(id);
    const deps = { postRequest: async () => ({ ok: true as const, androidRequestId: 'x' }), fetchStatus: async () => ({ status: 'approved' as const }) };
    await pollSmsStatusIfDue(new Date(), deps);
    db.prepare(`UPDATE sms_outbox SET approved_at='2026-01-01 00:00:00' WHERE id=?`).run(id);
    expect((await pollSmsStatusIfDue(new Date(), deps)).updated).toBe(0);
    const row = db.prepare('SELECT approved_at FROM sms_outbox WHERE id = ?').get(id) as { approved_at: string };
    expect(row.approved_at).toBe('2026-01-01 00:00:00');
  });

  test('sent and delivered in the same poll', async () => {
    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare(`UPDATE sms_outbox SET status='approved', android_request_id='android-1' WHERE id=?`).run(id);
    await pollSmsStatusIfDue(new Date(), {
      postRequest: async () => ({ ok: true, androidRequestId: 'x' }),
      fetchStatus: async () => ({ status: 'sent', deliveredAt: '2026-11-03T10:15:00Z' })
    });
    const row = db.prepare('SELECT status, sent_at, delivered_at FROM sms_outbox WHERE id = ?').get(id) as { status: string; sent_at: string | null; delivered_at: string | null };
    expect(row.status).toBe('sent');
    expect(row.sent_at).toBeTruthy();
    expect(row.delivered_at).toBe('2026-11-03 10:15:00');
  });

  test('default transport posts signed request to Android companion', async () => {
    writeSecret(db, 'smsCompanionPairingKey', 'secret');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'android-1' }) };
    }));

    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    await runSmsOutboxIfDue(new Date());

    expect(calls[0].url).toBe('http://192.168.1.50:8765/requests');
    expect((calls[0].init.headers as Record<string, string>)['x-ispm-signature']).toBeTruthy();
    const row = db.prepare('SELECT status FROM sms_outbox WHERE id=?').get(id) as { status: string };
    expect(row.status).toBe('pending_approval');
  });

  test('status poll calls the signed Android status endpoint', async () => {
    writeSecret(db, 'smsCompanionPairingKey', 'secret');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'sent' }) };
    }));

    const id = enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste' });
    db.prepare(`UPDATE sms_outbox SET status='pending_approval', android_request_id='android-9' WHERE id=?`).run(id);
    await pollSmsStatusIfDue(new Date());

    expect(calls[0].url).toBe('http://192.168.1.50:8765/requests/android-9');
    expect((calls[0].init.headers as Record<string, string>)['x-ispm-signature']).toBeTruthy();
    const row = db.prepare('SELECT status, sent_at FROM sms_outbox WHERE id=?').get(id) as { status: string; sent_at: string | null };
    expect(row.status).toBe('sent');
    expect(row.sent_at).toBeTruthy();
  });

  test('default transport includes clientName resolved from the client', async () => {
    writeSecret(db, 'smsCompanionPairingKey', 'secret');
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('SMS-N','Ana Lopes','active')`).run().lastInsertRowid as number;
    let body: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'android-1' }) };
    }));
    enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste', clientId });
    await runSmsOutboxIfDue(new Date());
    expect(body.clientName).toBe('Ana Lopes');
  });

  test('verifyCompanionPairing reports paired when the phone accepts the signature', async () => {
    writeSecret(db, 'smsCompanionPairingKey', 'secret');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })));
    expect(await verifyCompanionPairing()).toEqual({ reachable: true, paired: true });
  });

  test('verifyCompanionPairing reports not paired when the phone rejects the signature (401)', async () => {
    writeSecret(db, 'smsCompanionPairingKey', 'secret');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: async () => '{}' })));
    expect(await verifyCompanionPairing()).toEqual({ reachable: true, paired: false });
  });

  test('verifyCompanionPairing reports unreachable when the phone is offline', async () => {
    writeSecret(db, 'smsCompanionPairingKey', 'secret');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await verifyCompanionPairing()).toEqual({ reachable: false, paired: false });
  });
});

describe('SMS companion discovery', () => {
  test('discoverCompanionHosts returns only hosts that answer on the companion port', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue(oneWifiInterface);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('http://192.168.1.55:8765')) return { status: 401 } as Response;
      throw new Error('offline');
    }));
    const hosts = await discoverCompanionHosts({ timeoutMs: 50 });
    expect(hosts).toEqual(['http://192.168.1.55:8765']);
  });

  test('findPairedCompanion picks the host that accepts our signed ping', async () => {
    writeSecret(db, 'smsCompanionPairingKey', 'secret');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      // Only .77 accepts our secret (non-401); .55 is some other server on :8765.
      if (url.startsWith('http://192.168.1.77:8765')) return { status: 200 } as Response;
      return { status: 401 } as Response;
    }));
    const found = await findPairedCompanion(['http://192.168.1.55:8765', 'http://192.168.1.77:8765'], 50);
    expect(found).toBe('http://192.168.1.77:8765');
  });

  test('findPairedCompanion returns null when nothing holds the secret', async () => {
    writeSecret(db, 'smsCompanionPairingKey', 'secret');
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401 } as Response)));
    expect(await findPairedCompanion(['http://192.168.1.55:8765'], 50)).toBeNull();
  });
});
