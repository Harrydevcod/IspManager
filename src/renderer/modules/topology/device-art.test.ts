import { describe, expect, test } from 'vitest';
import { EQUIPMENT_PRESETS, presetInCatalog } from '../../../shared/equipment-presets';
import { deviceArtKind } from './device-art';

describe('deviceArtKind', () => {
  test('o tipo escolhe a silhueta, e o nome desempata o que o tipo não diz', () => {
    expect(deviceArtKind({ type: 'router', brand: 'MikroTik', model: 'hEX S' })).toBe('router');
    expect(deviceArtKind({ type: 'switch', brand: 'NETGEAR', model: 'GS108' })).toBe('switch');
    expect(deviceArtKind({ type: 'cpe', brand: 'TP-Link', model: 'CPE510' })).toBe('panel');
    expect(deviceArtKind({ type: 'antena', brand: 'Starlink', model: 'Kit Starlink Mini' })).toBe('starlink');
    expect(deviceArtKind({ type: 'router', brand: 'Starlink', model: 'Router Gen3' })).toBe('router');
    expect(deviceArtKind({ type: 'antena', brand: 'Ubiquiti', model: 'Rocket 5AC Prism' })).toBe('sector');
    expect(deviceArtKind({ type: 'antena', brand: 'Ubiquiti', model: 'PowerBeam 5AC Gen2' })).toBe('dish');
    expect(deviceArtKind({ type: 'repetidor', brand: 'Lwip', model: 'Wi-Fi Repeater' })).toBe('ap');
    expect(deviceArtKind({ type: 'olt', brand: null, model: 'X' })).toBe('box');
  });
});

describe('presetInCatalog', () => {
  const preset = (model: string) => EQUIPMENT_PRESETS.find((item) => item.model === model)!;

  test('o modelo do catálogo que contém o da referência conta como o mesmo', () => {
    expect(presetInCatalog(preset('hEX S'), [{ brand: 'MIKROTIK', model: 'RB760iGS hEX S' }])).toBe(true);
    expect(presetInCatalog(preset('CPE510'), [{ brand: 'TP-Link', model: 'CPE 510 Ponto de Acesso' }])).toBe(true);
  });

  test('outra marca ou outro modelo não conta', () => {
    expect(presetInCatalog(preset('hEX S'), [{ brand: 'TP-Link', model: 'hEX S' }])).toBe(false);
    expect(presetInCatalog(preset('hAP ax S'), [{ brand: 'MikroTik', model: 'hAP ac Lite' }])).toBe(false);
  });
});
