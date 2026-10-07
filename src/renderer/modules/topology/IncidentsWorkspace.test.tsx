/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth';
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

/** Tudo responde `response`, menos a sessão: sem ela o ecrã deixa escrever, como com a autenticação desligada. */
const stubFetch = (response: unknown) => vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('/api/auth/')
  ? new Response('{}', { status: 401 })
  : new Response(JSON.stringify(response), { status: 200 })));

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function mount(response: IncidentsResponse) {
  stubFetch(response);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AuthProvider><IncidentsWorkspace active /></AuthProvider>));
  await settle();
  return { host, root };
}

const openView = async (host: HTMLElement, label: string) => {
  const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) => node.textContent === label)!;
  await act(async () => tab.click());
  await settle();
};

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

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

test('a vista Router lista os achados do registo, um dado por coluna', async () => {
  const { host, root } = await mount(body);
  stubFetch({
    hours: 168, tone: 'danger', probeEnabled: true, lastProbeAt: null, lastRouterReadAt: '2026-10-07T22:14:00.000Z',
    antennas: [], clients: [], downNow: [], diary: [],
    findings: [{
      kind: 'ip_duplicado', subject: 'BC:07:1D:5E:42:9E', label: 'LAN1 · 192.168.1.1', count: 74,
      firstAt: '2026-10-07 10:29:23', lastAt: '2026-10-07 13:16:00', deviceName: null, clientName: null, vendor: 'TP-Link'
    }]
  });
  await openView(host, 'Router');
  expect([...host.querySelectorAll('[role="columnheader"]')].map((node) => node.textContent))
    .toEqual(['Tipo', 'Endereço', 'Pertence a', 'Detalhe', 'Vezes', 'Desde', 'Última vez']);
  const row = [...host.querySelectorAll<HTMLElement>('[role="row"]')][1];
  expect(row.textContent).toContain('Endereço do router duplicado');
  expect(row.textContent).toContain('TP-Link');
  expect(row.textContent).toContain('07/10 13:16');
  await act(async () => root.unmount());
});

test('a vista Diário lista as ocorrências e abre a edição ao clicar na linha', async () => {
  const { host, root } = await mount(body);
  stubFetch([{
    id: 3, happenedAt: '2026-10-06T17:54', title: 'Antenas a cair em conjunto', cause: 'TL-WR850N no 192.168.1.1',
    resolution: 'Retirado da rede', status: 'resolvida', createdAt: '', updatedAt: ''
  }]);
  await openView(host, 'Diário');
  expect(host.textContent).toContain('Nova ocorrência');
  const row = [...host.querySelectorAll<HTMLElement>('[role="row"]')][1];
  expect(row.textContent).toContain('Resolvida');
  expect(row.textContent).toContain('06/10/2026 17:54');
  expect(row.textContent).toContain('Retirado da rede');
  await act(async () => row.click());
  expect(document.querySelector<HTMLInputElement>('#network-diary-form input[maxlength="140"]')!.value).toBe('Antenas a cair em conjunto');
  await act(async () => root.unmount());
});

test('formatDuration', () => {
  expect(formatDuration(null)).toBe('Desconhecida');
  expect(formatDuration(20)).toBe('1 min');
  expect(formatDuration(3 * 3600 + 5 * 60)).toBe('3 h 05 min');
  expect(formatDuration(26 * 3600)).toBe('1 d 2 h');
});
