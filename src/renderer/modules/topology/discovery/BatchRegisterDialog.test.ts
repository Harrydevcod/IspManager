/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { candidatesFor } from './BatchRegisterDialog';
import type { DiscoveryCategory, DiscoveryRow } from './discovery-api';

const row = (over: Partial<DiscoveryRow> & { category?: DiscoveryCategory } = {}): DiscoveryRow => ({
  ip: '192.168.1.80',
  mac: '50:C7:BF:AA:BB:CC',
  hostname: null,
  vendor: 'TP-Link',
  category: 'desconhecido',
  alive: true,
  rttMs: 4,
  source: 'ping',
  registeredAs: [],
  firstSeenAt: null,
  lastSeenAt: null,
  model: 'CPE510',
  modelSource: 'http',
  modelMismatch: false,
  probedModel: 'CPE510',
  ...over
});

describe('candidatesFor', () => {
  test('entra quem está vivo, sem registo e disse o modelo', () => {
    expect(candidatesFor([row()])).toHaveLength(1);
  });

  /**
   * O filtro mais importante. Nesta rede a maioria dos desconhecidos são
   * telemóveis: sem modelo não há como saber que equipamento é, e listá-los
   * aqui era convidar a encher o inventário de coisas que não são nossas.
   */
  test('fabricante sem modelo não chega — é o telemóvel de alguém', () => {
    expect(candidatesFor([row({ model: null, probedModel: null })])).toEqual([]);
  });

  test('quem já está registado não se regista outra vez', () => {
    expect(candidatesFor([row({ category: 'registado' })])).toEqual([]);
  });

  test('quem não respondeu fica de fora — registar um fantasma é pior que nada', () => {
    expect(candidatesFor([row({ alive: false })])).toEqual([]);
  });

  test('o modelo sondado serve mesmo quando a coluna mostra outra coisa', () => {
    expect(candidatesFor([row({ model: null, probedModel: 'TL-S5-5KM' })])).toHaveLength(1);
  });
});
