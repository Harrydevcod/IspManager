import { describe, expect, test } from 'vitest';
import { cidrOverlaps, validateIptvSource } from './iptv-validate';

const leases = [{ address: '192.168.2.226', macAddress: 'BC:07:1D:5E:54:E7', hostName: null, status: 'bound' }];
const arp = [{ address: '192.168.2.40', macAddress: '0C:EF:15:90:D6:40' }];

describe('validateIptvSource', () => {
  test('ok quando o MAC escolhido está numa lease', () => {
    expect(validateIptvSource({ kind: 'mac', mac: 'BC:07:1D:5E:54:E7', via: 'router' }, { antennaMac: null, leases, arp }))
      .toEqual({ state: 'ok', address: '192.168.2.226' });
  });
  test('ok com o MAC do ARP em minúsculas e com hífenes', () => {
    expect(validateIptvSource({ kind: 'mac', mac: 'AA:BB:CC:DD:EE:FF', via: 'router' }, { antennaMac: null, leases: [], arp: [{ address: '192.168.2.9', macAddress: 'aa-bb-cc-dd-ee-ff' }] }))
      .toEqual({ state: 'ok', address: '192.168.2.9' });
  });
  test('ok com a lease em waiting', () => {
    const waiting = [{ ...leases[0], status: 'waiting' }];
    expect(validateIptvSource({ kind: 'mac', mac: 'BC:07:1D:5E:54:E7', via: 'router' }, { antennaMac: null, leases: waiting, arp: [] }))
      .toEqual({ state: 'ok', address: '192.168.2.226' });
  });
  test('aviso quando o gateway vê o MAC da antena e o modo registado é de camada 2', () => {
    expect(validateIptvSource({ kind: 'mac', mac: 'BC:07:1D:5E:54:E8', via: 'router' }, { antennaMac: '0C:EF:15:90:D6:40', leases, arp }))
      .toEqual({ state: 'warning', reason: 'O router vê o MAC da antena: WDS desligado ou modo mal registado' });
  });
  test('not_found quando não aparece em lado nenhum', () => {
    expect(validateIptvSource({ kind: 'mac', mac: 'AA:AA:AA:AA:AA:AA', via: 'aparelho' }, { antennaMac: null, leases, arp })).toEqual({ state: 'not_found' });
  });
  test('PPPoE não se valida por MAC', () => {
    expect(validateIptvSource({ kind: 'pppoe', username: 'skn014', legacy: null }, { antennaMac: null, leases, arp })).toEqual({ state: 'ok', address: null });
  });
  test('em migração prova o MAC legacy que ainda conta', () => {
    expect(validateIptvSource({ kind: 'pppoe', username: 'skn020', legacy: { mac: 'BC:07:1D:5E:54:E7', via: 'router' } }, { antennaMac: null, leases, arp }))
      .toEqual({ state: 'ok', address: '192.168.2.226' });
  });
  test('missing devolve a razão', () => {
    expect(validateIptvSource({ kind: 'missing', reason: 'sem modo' }, { antennaMac: null, leases, arp })).toEqual({ state: 'missing', reason: 'sem modo' });
  });
});

describe('cidrOverlaps', () => {
  test('a LAN do cliente em 192.168.1.0/24 colide com a gestão', () => {
    expect(cidrOverlaps('192.168.1.0/24', ['192.168.1.1/24', '192.168.2.1/24'])).toBe('192.168.1.1/24');
    expect(cidrOverlaps('192.168.0.0/24', ['192.168.1.1/24'])).toBeNull();
    expect(cidrOverlaps('lixo', ['192.168.1.1/24'])).toBeNull();
  });
});
