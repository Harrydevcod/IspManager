import { describe, expect, test } from 'vitest';
import { formatBitrate, formatBytes, profileRows, SESSION_STATE, trafficRates, type RouterWan } from './router-api';

describe('formatBytes', () => {
  test('usa unidades binárias com vírgula decimal (pt-PT)', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1,5 KiB');
    expect(formatBytes(268435456)).toBe('256 MiB');
    expect(formatBytes(5 * 1024 ** 4)).toBe('5 TiB');
  });

  test('o que o router não deu fica em branco, não zero', () => {
    expect(formatBytes(null)).toBe('—');
  });
});

describe('profileRows', () => {
  const plans = [
    { id: 1, name: 'Standard', routerProfile: 'ispm-plano-1', routerSyncStatus: 'synced' as const },
    { id: 2, name: 'Empresas', routerProfile: 'PLANO-40-20', routerSyncStatus: 'external' as const },
    { id: 3, name: 'Promo', routerProfile: 'PLANO-40-20', routerSyncStatus: 'external' as const },
    { id: 4, name: 'Antigo', routerProfile: 'desaparecido', routerSyncStatus: 'error' as const }
  ];

  test('cada perfil do router com os planos que apontam para ele', () => {
    const rows = profileRows(
      [
        { name: 'default', rateLimit: null, ownerPlanId: null },
        { name: 'ispm-plano-1', rateLimit: '20M/20M', ownerPlanId: 1 },
        { name: 'PLANO-40-20', rateLimit: '20M/40M', ownerPlanId: null }
      ],
      plans
    );
    expect(rows.map((row) => [row.name, row.plans.map((plan) => plan.name), row.managedByIspm, row.missing])).toEqual([
      ['default', [], false, false],
      ['ispm-plano-1', ['Standard'], true, false],
      ['PLANO-40-20', ['Empresas', 'Promo'], false, false],
      ['desaparecido', ['Antigo'], false, true]
    ]);
  });
});

describe('SESSION_STATE', () => {
  test('tem rótulo pt-PT para cada estado do servidor', () => {
    expect(Object.keys(SESSION_STATE).sort()).toEqual(['desativado', 'offline', 'online', 'sem_secret', 'sem_servico']);
    expect(SESSION_STATE.sem_servico.label).toBe('Sem serviço no ISPM');
  });
});

describe('trafficRates', () => {
  const sample = (sampledAt: number, rx: number | null, tx: number | null): RouterWan => ({
    sampledAt,
    interfaces: [{ name: 'WAN1-STARLINK', running: true, rxBytes: rx, txBytes: tx }]
  });

  test('bits por segundo entre duas leituras: RX é download, TX é upload', () => {
    // 3 s, 3 750 000 bytes recebidos = 10 Mbit/s; 375 000 enviados = 1 Mbit/s.
    expect(trafficRates(sample(0, 1_000_000, 500_000), sample(3000, 4_750_000, 875_000))).toEqual([
      { name: 'WAN1-STARLINK', running: true, downBps: 10_000_000, upBps: 1_000_000 }
    ]);
  });

  test('a primeira leitura ainda não tem taxa', () => {
    expect(trafficRates(null, sample(0, 1, 1))[0]).toMatchObject({ downBps: null, upBps: null });
  });

  test('contador que desce (router reiniciado) não dá taxa negativa', () => {
    expect(trafficRates(sample(0, 9_000, 9_000), sample(3000, 100, 100))[0]).toMatchObject({ downBps: null, upBps: null });
  });

  test('uma interface que aparece de novo começa sem taxa', () => {
    const next: RouterWan = { sampledAt: 3000, interfaces: [{ name: 'WAN2-STARLINK', running: true, rxBytes: 10, txBytes: 10 }] };
    expect(trafficRates(sample(0, 1, 1), next)[0]).toMatchObject({ name: 'WAN2-STARLINK', downBps: null });
  });
});

describe('formatBitrate', () => {
  test('unidades decimais, como a velocidade dos planos, com vírgula pt-PT', () => {
    expect(formatBitrate(0)).toBe('0 bit/s');
    expect(formatBitrate(950)).toBe('950 bit/s');
    expect(formatBitrate(12_400_000)).toBe('12,4 Mbit/s');
    expect(formatBitrate(1_500_000_000)).toBe('1,5 Gbit/s');
    expect(formatBitrate(null)).toBe('—');
  });
});
