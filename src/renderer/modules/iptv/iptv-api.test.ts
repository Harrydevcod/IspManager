import { expect, test, vi } from 'vitest';
import { describeSource } from './iptv-api';

vi.mock('../../lib/auth', () => ({ authFetch: vi.fn() }));

test('a origem concorda com o género do equipamento', () => {
  expect(describeSource({ kind: 'pppoe', username: 'skn014', legacy: { mac: 'E2:5F:12:4C:4C:38', via: 'antena' } }).text)
    .toBe('PPPoE skn014, e o MAC da antena E2:5F:12:4C:4C:38 até migrar');
  expect(describeSource({ kind: 'mac', mac: 'AA:BB:CC:DD:EE:FF', via: 'router' }).text).toBe('MAC do router do cliente AA:BB:CC:DD:EE:FF');
});
