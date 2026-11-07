import { expect, test, vi } from 'vitest';
import { describeSource } from './iptv-api';

vi.mock('../../lib/auth', () => ({ authFetch: vi.fn() }));

test('curto à vista, frase completa no hover, no género do equipamento', () => {
  expect(describeSource({ kind: 'pppoe', username: 'skn014', legacy: { mac: 'E2:5F:12:4C:4C:38', via: 'antena' } }))
    .toEqual({ text: 'PPPoE skn014 · em migração', detail: 'PPPoE skn014, e o MAC da antena E2:5F:12:4C:4C:38 até migrar', tone: 'neutral' });
  expect(describeSource({ kind: 'mac', mac: 'AA:BB:CC:DD:EE:FF', via: 'router' }))
    .toEqual({ text: 'MAC AA:BB:CC:DD:EE:FF', detail: 'MAC do router do cliente AA:BB:CC:DD:EE:FF', tone: 'neutral' });
});

test('PPPoE sem MAC legacy avisa porquê: até migrar, o cliente não tem IPTV pelo túnel', () => {
  expect(describeSource({ kind: 'pppoe', username: 'skn026', legacy: null, legacyGap: 'Modo da antena por classificar' }))
    .toEqual({ text: 'PPPoE skn026 · sem MAC', detail: 'PPPoE skn026 · sem MAC até migrar: Modo da antena por classificar', tone: 'warn' });
  expect(describeSource({ kind: 'pppoe', username: 'skn014', legacy: null })).toEqual({ text: 'PPPoE skn014', detail: null, tone: 'neutral' });
});
