import { describe, expect, test } from 'vitest';
import { iptvSource, type IptvDevice } from './iptv-source';

const cpe = (operationMode: string | null, macAddress: string | null = 'aa-bb-cc-00-00-01'): IptvDevice =>
  ({ type: 'cpe', operationMode, macAddress });
const router = (operationMode: string | null, macAddress: string | null = 'AA:BB:CC:00:00:02'): IptvDevice =>
  ({ type: 'router', operationMode, macAddress });
const tv = (macAddress: string | null = 'AA:BB:CC:00:00:03'): IptvDevice => ({ type: 'outro', operationMode: null, macAddress });

describe('iptvSource', () => {
  test('em migração leva o utilizador e o MAC legacy: o router usa o que existir', () => {
    expect(iptvSource({ pppoeUsername: 'skn014' }, [cpe('cliente'), router('router')]))
      .toEqual({ kind: 'pppoe', username: 'skn014', legacy: { mac: 'AA:BB:CC:00:00:02', via: 'router' } });
  });
  test('PPPoE sem MAC legacy calculável continua válido, só por PPPoE', () => {
    expect(iptvSource({ pppoeUsername: 'skn014' }, [cpe(null)])).toEqual({ kind: 'pppoe', username: 'skn014', legacy: null });
  });
  test.each(['router', 'wisp'])('antena em %s faz NAT: MAC da antena', (mode) => {
    expect(iptvSource({ pppoeUsername: null }, [cpe(mode), router('router')]))
      .toEqual({ kind: 'mac', mac: 'AA:BB:CC:00:00:01', via: 'antena' });
  });
  test.each(['cliente', 'ponte', 'ap', 'repetidor'])('antena em %s e router em router: MAC do router', (mode) => {
    expect(iptvSource({ pppoeUsername: null }, [cpe(mode), router('router')]))
      .toEqual({ kind: 'mac', mac: 'AA:BB:CC:00:00:02', via: 'router' });
  });
  test.each(['ap', 'ponte'])('tudo em camada 2 (router em %s): MAC do aparelho', (mode) => {
    expect(iptvSource({ pppoeUsername: null }, [cpe('cliente'), router(mode), tv()]))
      .toEqual({ kind: 'mac', mac: 'AA:BB:CC:00:00:03', via: 'aparelho' });
  });
  test('sem aparelho registado diz o que falta', () => {
    expect(iptvSource({ pppoeUsername: null }, [cpe('cliente'), router('ap')]))
      .toEqual({ kind: 'missing', reason: 'Falta o MAC do aparelho IPTV (TV ou box)' });
  });
  test('modo por classificar não adivinha', () => {
    expect(iptvSource({ pppoeUsername: null }, [cpe(null), router('router')]))
      .toEqual({ kind: 'missing', reason: 'Modo da antena por classificar' });
    expect(iptvSource({ pppoeUsername: null }, [cpe('cliente'), router(null)]))
      .toEqual({ kind: 'missing', reason: 'Modo do router do cliente por classificar' });
  });
  test('MAC em falta ou inválido', () => {
    expect(iptvSource({ pppoeUsername: null }, [cpe('wisp', null)])).toEqual({ kind: 'missing', reason: 'Falta o MAC da antena' });
    expect(iptvSource({ pppoeUsername: null }, [cpe('wisp', 'xx')])).toEqual({ kind: 'missing', reason: 'Falta o MAC da antena' });
  });
  test('sem antena nem router', () => {
    expect(iptvSource({ pppoeUsername: null }, [])).toEqual({ kind: 'missing', reason: 'Sem antena registada no serviço' });
  });
});
