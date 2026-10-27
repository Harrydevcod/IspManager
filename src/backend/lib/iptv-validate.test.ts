import { describe, expect, test } from 'vitest';
import { cidrOverlaps, validateIptvSource } from './iptv-validate';

const leases = [{ address: '192.168.2.226', macAddress: 'BC:07:1D:5E:54:E7', hostName: null, status: 'bound' }];
const sessions: Array<{ name: string; address: string | null }> = [{ name: 'skn014', address: '10.10.0.14' }];
const arp = [{ address: '192.168.2.40', macAddress: '0C:EF:15:90:D6:40' }];

const twoSightings = [...arp, { address: '192.168.2.41', macAddress: '0C:EF:15:90:D6:40' }];

describe('validateIptvSource', () => {
  test('ok quando o MAC escolhido está numa lease', () => {
    expect(validateIptvSource({ kind: 'mac', mac: 'BC:07:1D:5E:54:E7', via: 'router' }, { antennaMac: null, sessions, leases, arp }))
      .toEqual({ state: 'ok', address: '192.168.2.226' });
  });
  test('ok com o MAC do ARP em minúsculas e com hífenes', () => {
    expect(validateIptvSource({ kind: 'mac', mac: 'AA:BB:CC:DD:EE:FF', via: 'router' }, { antennaMac: null, sessions, leases: [], arp: [{ address: '192.168.2.9', macAddress: 'aa-bb-cc-dd-ee-ff' }] }))
      .toEqual({ state: 'ok', address: '192.168.2.9' });
  });
  test('ok com a lease em waiting', () => {
    const waiting = [{ ...leases[0], status: 'waiting' }];
    expect(validateIptvSource({ kind: 'mac', mac: 'BC:07:1D:5E:54:E7', via: 'router' }, { antennaMac: null, sessions, leases: waiting, arp: [] }))
      .toEqual({ state: 'ok', address: '192.168.2.226' });
  });
  test('aviso quando o gateway vê o MAC da antena e o modo registado é de camada 2', () => {
    expect(validateIptvSource({ kind: 'mac', mac: 'BC:07:1D:5E:54:E8', via: 'router' }, { antennaMac: '0C:EF:15:90:D6:40', sessions, leases, arp: twoSightings }))
      .toEqual({ state: 'warning', reason: 'O router vê o MAC da antena: WDS desligado ou modo mal registado' });
  });
  test('not_found quando não aparece em lado nenhum', () => {
    expect(validateIptvSource({ kind: 'mac', mac: 'AA:AA:AA:AA:AA:AA', via: 'aparelho' }, { antennaMac: null, sessions, leases, arp })).toEqual({ state: 'not_found' });
  });
  test('PPPoE com sessão é ok mesmo que o legacy não case', () => {
    expect(validateIptvSource({ kind: 'pppoe', username: 'skn014', legacy: { mac: 'AA:AA:AA:AA:AA:AA', via: 'router' } }, { antennaMac: null, sessions, leases, arp }))
      .toEqual({ state: 'ok', address: '10.10.0.14', via: 'pppoe' });
  });
  test('PPPoE sem nada é not_found, nunca aviso de WDS',  () => {
    expect(validateIptvSource({ kind: 'pppoe', username: 'skn099', legacy: { mac: 'AA:AA:AA:AA:AA:AA', via: 'router' } }, { antennaMac: '0C:EF:15:90:D6:40', sessions, leases, arp: twoSightings }))
      .toEqual({ state: 'not_found' });
    expect(validateIptvSource({ kind: 'pppoe', username: 'skn099', legacy: null }, { antennaMac: '0C:EF:15:90:D6:40', sessions, leases, arp }))
      .toEqual({ state: 'not_found' });
  });
  test('antena vista só no IP de gestão é normal: not_found',  () => {
    expect(validateIptvSource({ kind: 'mac', mac: 'BC:07:1D:5E:54:E8', via: 'router' }, { antennaMac: '0C:EF:15:90:D6:40', sessions, leases, arp }))
      .toEqual({ state: 'not_found' });
  });
  test('PPPoE com sessão e sem legacy', () => {
    expect(validateIptvSource({ kind: 'pppoe', username: 'skn014', legacy: null }, { antennaMac: null, sessions, leases, arp })).toEqual({ state: 'ok', address: '10.10.0.14', via: 'pppoe' });
  });
  test('em migração prova o MAC legacy que ainda conta', () => {
    expect(validateIptvSource({ kind: 'pppoe', username: 'skn020', legacy: { mac: 'BC:07:1D:5E:54:E7', via: 'router' } }, { antennaMac: null, sessions, leases, arp }))
      .toEqual({ state: 'ok', address: '192.168.2.226', via: 'legacy' });
  });
  test('missing devolve a razão', () => {
    expect(validateIptvSource({ kind: 'missing', reason: 'sem modo' }, { antennaMac: null, sessions, leases, arp })).toEqual({ state: 'missing', reason: 'sem modo' });
  });
});

describe('cidrOverlaps', () => {
  test('a LAN do cliente em 192.168.1.0/24 colide com a gestão', () => {
    expect(cidrOverlaps('192.168.1.0/24', ['192.168.1.1/24', '192.168.2.1/24'])).toBe('192.168.1.1/24');
    expect(cidrOverlaps('192.168.0.0/24', ['192.168.1.1/24'])).toBeNull();
    expect(cidrOverlaps('lixo', ['192.168.1.1/24'])).toBeNull();
  });
});
