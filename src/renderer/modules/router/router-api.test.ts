import { describe, expect, test } from 'vitest';
import { formatBytes, profileRows, SESSION_STATE } from './router-api';

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
