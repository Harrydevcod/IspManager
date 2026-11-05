import { describe, expect, test } from 'vitest';
import type { SmsStatus } from '../../types';
import { describeSmsPairing, describeSmsPresence } from './smsPresence';

const now = Date.parse('2026-11-03T12:00:00Z');
const base: SmsStatus = { configured: true, paired: true, reachable: true, active: true, baseUrl: 'http://192.168.1.50:8765', deviceName: 'Loja' };
const device = { appVersion: '0.3.0', battery: 82, charging: true, signalLevel: 3, simOperators: [], pending: 0, uptimeSec: 60 };

describe('describeSmsPresence', () => {
  test('nothing to say before pairing', () => {
    expect(describeSmsPresence({ ...base, configured: false }, now)).toBeNull();
    expect(describeSmsPresence(null, now)).toBeNull();
  });

  test('online with battery, signal and version', () => {
    const p = describeSmsPresence({ ...base, lastSeen: '2026-11-03T11:59:20Z', device }, now);
    expect(p).toEqual({ tone: 'success', line: 'Online · bateria 82 % a carregar · sinal 3/4 · v0.3.0 · visto há 40 s', warnings: [] });
  });

  test('connection switched off: neutral, no offline nor warnings', () => {
    const p = describeSmsPresence({ ...base, enabled: false, lastSeen: '2026-11-03T11:00:00Z', device: { ...device, battery: 5, charging: false } }, now);
    expect(p?.tone).toBe('muted');
    expect(p?.line).toMatch(/^Ligação desligada — o pareamento está guardado · última resposta /);
    expect(p?.warnings).toEqual([]);
  });

  test('offline after three minutes of silence', () => {
    const p = describeSmsPresence({ ...base, lastSeen: '2026-11-03T11:50:00Z', device }, now);
    expect(p?.tone).toBe('warn');
    expect(p?.line).toMatch(/^Offline desde /);
  });

  test('warns on low battery not charging and on an old app', () => {
    const p = describeSmsPresence({ ...base, lastSeen: '2026-11-03T11:59:50Z', device: { ...device, battery: 12, charging: false, appVersion: '0.2.0' } }, now);
    expect(p?.tone).toBe('warn');
    expect(p?.warnings).toHaveLength(2);
  });

  test('app 0.2.0 has no /status: online but flagged as outdated', () => {
    const p = describeSmsPresence({ ...base, lastSeen: '2026-11-03T11:59:50Z', device: null }, now);
    expect(p?.line).toBe('Online · visto há 10 s');
    expect(p?.warnings[0]).toMatch(/desatualizada/);
  });

  test('never seen yet', () => {
    expect(describeSmsPresence({ ...base, lastSeen: null }, now)).toEqual({ tone: 'muted', line: 'Ainda sem notícias do telemóvel', warnings: [] });
  });
});

describe('describeSmsPairing', () => {
  const opts = { verifying: false, qrShown: false, formBaseUrl: base.baseUrl };
  const offline = { ...base, active: false, reachable: false, paired: false };

  test('unpaired asks for the first pairing', () => {
    expect(describeSmsPairing(null, opts)).toMatchObject({ state: 'unpaired', primary: 'pair', pairLabel: 'Gerar pareamento' });
  });
  test('verifying wins over any stale status', () => {
    expect(describeSmsPairing(offline, { ...opts, verifying: true, qrShown: true }).state).toBe('waiting');
  });
  test('off never claims the phone is paired', () => {
    const v = describeSmsPairing({ ...offline, enabled: false }, opts);
    expect(v.state).toBe('off');
    expect(v.line).not.toMatch(/pareado/i);
  });
  test('active only when the phone proved the secret', () => {
    expect(describeSmsPairing(base, opts).state).toBe('active');
  });
  test('a QR left after the wait expired says so instead of "lê este QR"', () => {
    expect(describeSmsPairing(offline, { ...opts, qrShown: true }).state).toBe('expired');
  });
  test('answers with another secret: mismatch, new QR', () => {
    expect(describeSmsPairing({ ...offline, reachable: true }, opts)).toMatchObject({ state: 'mismatch', primary: 'pair', pairLabel: 'Gerar novo QR' });
  });
  test('silent phone: look for it on the network before re-pairing', () => {
    expect(describeSmsPairing(offline, opts)).toMatchObject({ state: 'unreachable', primary: 'detect' });
  });
  test('flags a typed address that differs from the saved one', () => {
    expect(describeSmsPairing(offline, { ...opts, formBaseUrl: 'http://192.168.0.17:8765' }).addressChanged).toBe(true);
    expect(describeSmsPairing(offline, opts).addressChanged).toBe(false);
  });
});
