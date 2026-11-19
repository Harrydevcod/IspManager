import { describe, expect, test } from 'vitest';
import { targetForFinding } from './operations-status';

/** As secções que a app sabe abrir (`SectionId`, renderer/types.ts). */
const SECTIONS = new Set([
  'dashboard', 'clients', 'documents', 'plans', 'services', 'topology', 'router',
  'finance', 'treasury', 'support', 'work-orders', 'stock', 'reports', 'users', 'audit', 'settings'
]);

/** Os separadores das Configurações (`SettingsTab`). */
const SETTINGS_TABS = new Set(['company', 'billing', 'payments', 'whatsapp', 'sms', 'network', 'fup', 'backups', 'jobs', 'license', 'vault']);

describe('onde se trata cada achado da operação', () => {
  const codes = [
    'network.single-uplink', 'network.device-down', 'network.flapping', 'network.no-mac',
    'customers.zone-concentration', 'customers.cancelled-debt',
    'fleet.negative-stock', 'fleet.not-returned',
    'access.no-qos', 'access.divergence',
    'billing.critical-overdue', 'billing.missing-receipts', 'billing.collection-rate',
    'messaging.failures', 'messaging.no-fallback',
    'system.no-backup', 'system.stale-backup', 'system.job-errors', 'system.bus-factor',
    'compliance.no-company-nif', 'compliance.clients-without-nif'
  ];

  for (const code of codes) {
    test(`"${code}" aponta para uma secção que existe`, () => {
      const target = targetForFinding(code);
      expect(SECTIONS.has(target.section), `secção desconhecida: ${target.section}`).toBe(true);
      if (target.section === 'settings' && target.focus) {
        expect(SETTINGS_TABS.has(target.focus), `separador desconhecido: ${target.focus}`).toBe(true);
      }
    });
  }

  test('o atraso crítico abre a cobrança já no filtro certo', () => {
    expect(targetForFinding('billing.critical-overdue')).toEqual({ section: 'finance', focus: 'overdue' });
  });

  test('um código novo cai nos Relatórios em vez de rebentar', () => {
    expect(targetForFinding('coisa.nova')).toEqual({ section: 'reports' });
    expect(targetForFinding('')).toEqual({ section: 'reports' });
  });
});
