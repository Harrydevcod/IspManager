/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ClientUsage, type ClientUsageFup, type ClientUsageRow } from './ClientUsage';
import type { FupUsage } from '../fup/fup-api';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

const ROWS: ClientUsageRow[] = [
  { serviceId: 1, clientCode: 'C001', clientName: 'Ana', plan: '20M', todayDownBytes: 0, todayUpBytes: 0, monthDownBytes: 0, monthUpBytes: 0, measured: 0 },
  { serviceId: 2, clientCode: 'C002', clientName: 'Bruno', plan: '50M', todayDownBytes: 2_000_000_000, todayUpBytes: 1_000_000_000, monthDownBytes: 4_000_000_000, monthUpBytes: 1_000_000_000, measured: 1 }
];

const usage = (serviceId: number, referenceGb: number, percent: number, totalBytes: number): FupUsage => ({
  serviceId, clientId: serviceId, username: `u${serviceId}`, planName: 'P', referenceGb, peakPercent: 50,
  cycleStart: '2026-11-01', cycleEnd: '2026-11-30', period: '2026-11',
  downloadBytes: totalBytes, uploadBytes: 0, totalBytes, percent, state: percent >= 100 ? 'LIMITADO' : 'NORMAL', limitedNow: false
});

async function render(fup: ClientUsageFup | null) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<ClientUsage rows={ROWS} fup={fup} onInstalled={() => {}} />));
  const rows = [...host.querySelectorAll('[role="row"]')].slice(1);
  return { host, rows, done: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test('ordena pelo total do mês e mostra a ausência de medição', async () => {
  const { host, rows, done } = await render(null);
  expect(rows[0].textContent).toContain('Bruno');
  expect(rows[1].textContent).toContain('Sem medição');
  expect(host.querySelectorAll('[role="columnheader"]')).toHaveLength(8);
  expect(rows[0].textContent).toContain('—');
  await done();
});

test('mostra a barra de uso justo por serviço e o GB de quem não tem referência', async () => {
  const { host, rows, done } = await render({
    usage: [usage(2, 50, 92, 46 * 1024 ** 3), usage(1, 0, 0, 3 * 1024 ** 3)],
    thresholds: { aviso: 80, limitacao: 100 }
  });
  const meters = host.querySelectorAll('[role="meter"]');
  expect(meters).toHaveLength(1);
  expect(meters[0].getAttribute('aria-valuenow')).toBe('92');
  expect(rows[0].textContent).toContain('92%');
  expect(rows[1].textContent).toContain('3,0 GB');
  await done();
});
