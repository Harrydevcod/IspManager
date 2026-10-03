/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { formatDuration, IncidentsWorkspace, type IncidentsResponse } from './IncidentsWorkspace';

const body: IncidentsResponse = {
  probeEnabled: true,
  windowDays: 30,
  incidents: [{
    key: '1:2026-10-01 10:00:00', backboneDeviceId: 1, name: 'Antena X', zone: 'Praia', status: 'open',
    startedAt: '2026-10-01 10:00:00', endedAt: null, durationSeconds: 37 * 60, draggedDevices: ['AP Norte'],
    clients: [{ clientId: 7, clientCode: 'C007', clientName: 'Ana Lopes', zone: 'Praia' }]
  }]
};

async function mount(response: IncidentsResponse) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<IncidentsWorkspace active />));
  await act(async () => { await Promise.resolve(); });
  return { host, root };
}

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

test('lista o incidente e abre os clientes afetados ao clicar na linha', async () => {
  const { host, root } = await mount(body);
  const row = [...host.querySelectorAll<HTMLElement>('[role="row"]')][1];
  expect(row.textContent).toContain('Em curso');
  expect(row.textContent).toContain('Antena X');
  expect(row.textContent).toContain('37 min');
  expect(host.querySelectorAll('[role="columnheader"]')).toHaveLength(8);

  await act(async () => row.click());
  expect(document.body.textContent).toContain('Arrastou: AP Norte');
  expect(document.body.textContent).toContain('Ana Lopes');
  await act(async () => root.unmount());
});

test('sem incidentes distingue a sonda desligada', async () => {
  const { host, root } = await mount({ probeEnabled: false, windowDays: 30, incidents: [] });
  expect(host.textContent).toContain('Sonda de rede desligada');
  await act(async () => root.unmount());
});

test('formatDuration', () => {
  expect(formatDuration(null)).toBe('Desconhecida');
  expect(formatDuration(20)).toBe('1 min');
  expect(formatDuration(3 * 3600 + 5 * 60)).toBe('3 h 05 min');
  expect(formatDuration(26 * 3600)).toBe('1 d 2 h');
});
