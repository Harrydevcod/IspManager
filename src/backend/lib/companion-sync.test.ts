import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CompanionSnapshot } from './companion-snapshot';
import type { CompanionDeviceStatus, CompanionSyncDeps } from './companion-sync';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let sync: typeof import('./companion-sync');
let snapshot: typeof import('./companion-snapshot');
let writeSecret: typeof import('./secrets').writeSecret;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-companion-sync-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  sync = await import('./companion-sync');
  snapshot = await import('./companion-snapshot');
  ({ writeSecret } = await import('./secrets'));
});

beforeEach(() => {
  db.prepare('DELETE FROM sms_outbox').run();
  db.prepare('DELETE FROM app_settings').run();
  sync.resetCompanionSyncForTests();
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

function setSetting(key: string, value: string) {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

function pair() {
  setSetting('smsCompanionEnabled', 'true');
  setSetting('smsCompanionBaseUrl', 'http://192.168.1.50:8765');
  writeSecret(db, 'smsCompanionPairingKey', 'secret');
}

const device: CompanionDeviceStatus = {
  appVersion: '0.3.0', battery: 82, charging: true, signalLevel: 3, simOperators: ['CVMóvel'], pending: 0, uptimeSec: 120
};

function deps(over: Partial<CompanionSyncDeps> = {}) {
  return {
    fetchStatus: vi.fn(async () => ({ reachable: true, status: device })),
    pushSnapshot: vi.fn(async (_s: CompanionSnapshot) => ({ ok: true }) as const),
    buildSnapshot: vi.fn(async () => ({ schemaVersion: 1 }) as CompanionSnapshot),
    selfHeal: vi.fn(async () => undefined),
    ...over
  };
}

describe('runCompanionSyncIfDue', () => {
  test('does nothing until the phone is paired', async () => {
    const d = deps();
    expect(await sync.runCompanionSyncIfDue(new Date(), d)).toMatchObject({ skipped: true });
    expect(d.fetchStatus).not.toHaveBeenCalled();
  });

  test('online: records last seen + device and pushes the snapshot right away', async () => {
    pair();
    const d = deps();
    const now = new Date('2026-11-03T12:00:00Z');
    expect(await sync.runCompanionSyncIfDue(now, d)).toEqual({ online: true, pushed: true });
    expect(d.pushSnapshot).toHaveBeenCalledTimes(1);
    expect(sync.readCompanionPresence()).toEqual({ lastSeen: now.toISOString(), device, lastPush: { at: now.toISOString(), ok: true, reason: null } });
  });

  test('sealing is sticky: once the pairing saw a 0.5.0 app, an older /status never brings plain text back', async () => {
    pair();
    setSetting('smsCompanionSnapshotMinutes', '5');
    const t0 = Date.parse('2026-11-03T12:00:00Z');
    const old = deps();
    await sync.runCompanionSyncIfDue(new Date(t0), old);
    expect(old.pushSnapshot).toHaveBeenLastCalledWith(expect.anything(), false); // 0.3.0: can't decrypt

    const current = deps({ fetchStatus: vi.fn(async () => ({ reachable: true, status: { ...device, appVersion: '0.5.0' } })) });
    await sync.runCompanionSyncIfDue(new Date(t0 + 5 * 60_000), current);
    expect(current.pushSnapshot).toHaveBeenLastCalledWith(expect.anything(), true);

    // A host posing as the phone claims 0.4.0 (the version in /status is not signed).
    await sync.runCompanionSyncIfDue(new Date(t0 + 10 * 60_000), old);
    expect(old.pushSnapshot).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  test('pushes again only after the interval', async () => {
    pair();
    setSetting('smsCompanionSnapshotMinutes', '5');
    const d = deps();
    const t0 = Date.parse('2026-11-03T12:00:00Z');
    await sync.runCompanionSyncIfDue(new Date(t0), d);
    await sync.runCompanionSyncIfDue(new Date(t0 + 60_000), d);
    expect(d.pushSnapshot).toHaveBeenCalledTimes(1);
    await sync.runCompanionSyncIfDue(new Date(t0 + 5 * 60_000), d);
    expect(d.pushSnapshot).toHaveBeenCalledTimes(2);
  });

  test('offline: hunts for the phone at once, then pushes when it comes back', async () => {
    pair();
    const offline = deps({ fetchStatus: vi.fn(async () => ({ reachable: false, status: null })) });
    expect(await sync.runCompanionSyncIfDue(new Date('2026-11-03T12:00:00Z'), offline)).toEqual({ online: false, pushed: false });
    expect(offline.selfHeal).toHaveBeenCalledTimes(1);
    expect(offline.fetchStatus).toHaveBeenCalledTimes(2); // antes e depois de procurar
    expect(sync.readCompanionPresence().lastSeen).toBeNull();

    // Voltou ao fim de 1 min: o intervalo de 5 min não se aplica, envia logo.
    const back = deps();
    expect(await sync.runCompanionSyncIfDue(new Date('2026-11-03T12:01:00Z'), back)).toEqual({ online: true, pushed: true });
  });

  test('a phone without /status (app 0.2.0) still counts as seen', async () => {
    pair();
    await sync.runCompanionSyncIfDue(new Date('2026-11-03T12:00:00Z'), deps({ fetchStatus: vi.fn(async () => ({ reachable: true, status: null })) }));
    expect(sync.readCompanionPresence()).toMatchObject({ lastSeen: '2026-11-03T12:00:00.000Z', device: null });
  });

  test('a failed push is retried on the next tick', async () => {
    pair();
    const d = deps({ pushSnapshot: vi.fn(async () => ({ ok: false, reason: 'falha de rede' }) as const) });
    await sync.runCompanionSyncIfDue(new Date('2026-11-03T12:00:00Z'), d);
    await sync.runCompanionSyncIfDue(new Date('2026-11-03T12:01:00Z'), d);
    expect(d.pushSnapshot).toHaveBeenCalledTimes(2);
  });

  test('a refused push is recorded with its reason, and a later success replaces it', async () => {
    pair();
    const refused = deps({ pushSnapshot: vi.fn(async () => ({ ok: false, reason: sync.describePushFailure(401) }) as const) });
    await sync.runCompanionSyncIfDue(new Date('2026-11-03T12:00:00Z'), refused);
    expect(sync.readCompanionPresence().lastPush).toEqual({
      at: '2026-11-03T12:00:00.000Z', ok: false, reason: 'o telemóvel recusou a assinatura (401)'
    });

    await sync.runCompanionSyncIfDue(new Date('2026-11-03T12:01:00Z'), deps());
    expect(sync.readCompanionPresence().lastPush).toEqual({ at: '2026-11-03T12:01:00.000Z', ok: true, reason: null });
  });
});

describe('parseDeviceStatus', () => {
  test('keeps known fields and nulls anything malformed', () => {
    expect(sync.parseDeviceStatus({ appVersion: 3, battery: '80', charging: 'yes', simOperators: ['A', 4, 'B'], pending: 2 })).toEqual({
      appVersion: null, battery: null, charging: null, signalLevel: null, simOperators: ['A', 'B'], pending: 2, uptimeSec: null
    });
  });
});

describe('buildCompanionSnapshot', () => {
  test('has the contract shape, cut lists and SMS counts, without touching the router', async () => {
    setSetting('companyName', 'Skynet');
    db.prepare(`INSERT INTO sms_outbox (event_type, to_phone, body, status, delivered_at) VALUES ('test', '+2389911111', 'a', 'sent', datetime('now'))`).run();
    db.prepare(`INSERT INTO sms_outbox (event_type, to_phone, body, status) VALUES ('test', '+2389911111', 'b', 'failed')`).run();
    db.prepare(`INSERT INTO sms_outbox (event_type, to_phone, body, status) VALUES ('test', '+2389911111', 'c', 'pending_approval')`).run();
    const wanReader = vi.fn(async () => ({ wans: [{ name: 'ether1', running: true, downBps: 1000, upBps: 200 }], wanReason: null }));

    const s = await snapshot.buildCompanionSnapshot(db, new Date(), wanReader);

    expect(s.schemaVersion).toBe(1);
    expect(s.companyName).toBe('Skynet');
    expect(['green', 'amber', 'red']).toContain(s.operation.severity);
    expect(s.operation.risks.length).toBeLessThanOrEqual(5);
    expect(s.money.criticalOverdue.length).toBeLessThanOrEqual(5);
    expect(s.network.wans).toEqual([{ name: 'ether1', running: true, downBps: 1000, upBps: 200 }]);
    expect(s.sms.month).toEqual({ sent: 1, delivered: 1, failed: 1, pending: 1 });
    expect(Object.keys(s).sort()).toEqual(['clients', 'companyName', 'customers', 'generatedAt', 'money', 'network', 'operation', 'schemaVersion', 'sms', 'work']);
  });

  test('a router error becomes wanReason, not a failed snapshot', async () => {
    const s = await snapshot.buildCompanionSnapshot(db, new Date(), async () => { throw new Error('timeout'); });
    expect(s.network.wans).toBeNull();
    expect(s.network.wanReason).toBe('timeout');
  });
});
