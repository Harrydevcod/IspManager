/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ClientUsage } from './ClientUsage';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

test('ordena pelo total do mês e mostra a ausência de medição', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<ClientUsage rows={[
    { serviceId: 1, clientCode: 'C001', clientName: 'Ana', plan: '20M', todayDownBytes: 0, todayUpBytes: 0, monthDownBytes: 0, monthUpBytes: 0, measured: 0 },
    { serviceId: 2, clientCode: 'C002', clientName: 'Bruno', plan: '50M', todayDownBytes: 2_000_000_000, todayUpBytes: 1_000_000_000, monthDownBytes: 4_000_000_000, monthUpBytes: 1_000_000_000, measured: 1 }
  ]} onInstalled={() => {}} />));
  const rows = [...host.querySelectorAll('[role="row"]')].slice(1);
  expect(rows[0].textContent).toContain('Bruno');
  expect(rows[1].textContent).toContain('Sem medição');
  expect(host.querySelectorAll('[role="columnheader"]')).toHaveLength(7);
  await act(async () => root.unmount());
  host.remove();
});
