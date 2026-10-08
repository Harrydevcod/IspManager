/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth';
import { NetworkHealthCard } from './NetworkHealthCard';
import { antennaDrops, formatLocalStamp, healthSituations, type HealthFinding, type NetworkHealth } from './network-health';

const finding = (row: Partial<HealthFinding> & Pick<HealthFinding, 'kind' | 'subject' | 'count'>): HealthFinding => ({
  label: '', firstAt: '2026-10-07 10:29:23', lastAt: '2026-10-07 13:16:00', deviceName: null, clientName: null, vendor: null, ...row
});

const calm: NetworkHealth = {
  hours: 72, tone: 'ok', probeEnabled: true, lastProbeAt: '2026-10-07 22:15:06', lastRouterReadAt: '2026-10-07T22:14:00.000Z', routerJournal: false,
  antennas: [], clients: [], downNow: [], findings: [], diary: []
};

const conflict: NetworkHealth = {
  ...calm,
  tone: 'danger',
  antennas: [
    { id: 2, name: 'TL-S5 Espia', ipAddress: '192.168.1.251', downs: 21, downSeconds: 6322, longestSeconds: 1439 },
    { id: 1, name: 'CPE710 Cruz', ipAddress: '192.168.1.140', downs: 14, downSeconds: 4296, longestSeconds: 1019 }
  ],
  downNow: [{ kind: 'backbone', id: 5, name: 'CPE710 Espia', ipAddress: '192.168.1.110', since: '2026-10-07 13:10:34' }],
  findings: [
    finding({ kind: 'ip_duplicado', subject: 'BC:07:1D:5E:42:9E', count: 74, label: 'LAN1 · 192.168.1.1', vendor: 'TP-Link' }),
    finding({ kind: 'antena_em_baixo', subject: '192.168.1.251', count: 38, deviceName: 'TL-S5 Espia' }),
    finding({ kind: 'dhcp_intruso', subject: '30:16:9D:AA:53:8B', count: 174, label: 'LAN1 · 192.168.0.1', vendor: 'MERCUSYS' })
  ],
  diary: [{ id: 1, happenedAt: '2026-10-06T17:54', title: 'Antenas a cair', cause: '', resolution: '', status: 'aberta', createdAt: '', updatedAt: '' }]
};

async function mount(response: NetworkHealth | null, onOpenNetwork = vi.fn()) {
  // Sem sessão (401) o ecrã trata o utilizador como o da aplicação sem autenticação: pode escrever.
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => String(input).includes('/api/auth/')
    ? new Response('{}', { status: 401 })
    : response ? new Response(JSON.stringify(response), { status: 200 }) : new Response('{}', { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AuthProvider><NetworkHealthCard onOpenNetwork={onOpenNetwork} /></AuthProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { host, root, onOpenNetwork, fetchMock };
}

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('rede estável: diz que não há nada a assinalar e até onde viu', async () => {
  const { host, root } = await mount(calm);
  expect(host.textContent).toContain('Estável');
  expect(host.textContent).toContain('Sem nada a assinalar');
  expect(host.textContent).toContain('Sonda:');
  expect(host.querySelectorAll('.dashboard-list li')).toHaveLength(0);
  expect(host.textContent).not.toContain('registo contínuo no cartão');
  await act(async () => root.unmount());
});

test('com o diário em disco, o cartão diz que o registo do router é contínuo', async () => {
  const { host, root } = await mount({ ...calm, routerJournal: true });
  expect(host.querySelector('.network-health-seen')!.textContent).toContain('registo contínuo no cartão');
  await act(async () => root.unmount());
});

test('rede crítica: mostra as três situações mais graves, os números e abre o detalhe', async () => {
  const { host, root, onOpenNetwork } = await mount(conflict);
  expect(host.textContent).toContain('Crítico');
  const figures = [...host.querySelectorAll('.network-health-figures dd')].map((node) => node.textContent);
  // 38 vistas pelo router na TL-S5 (mais do que as 21 da sonda) + 14 da CPE710 que só a sonda viu.
  expect(figures).toEqual(['52', '1', '1']);
  const items = [...host.querySelectorAll('.dashboard-list li')].map((node) => node.textContent);
  expect(items).toHaveLength(3);
  expect(items[0]).toContain('CPE710 Espia em baixo');
  expect(items[1]).toContain('Endereço do router duplicado');
  expect(items[1]).toContain('TP-Link · BC:07:1D:5E:42:9E · LAN1 · 192.168.1.1');
  expect(items[1]).toContain('74×');
  expect(items[2]).toContain('TL-S5 Espia caiu');

  const detail = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Ver detalhe'))!;
  expect(detail.textContent).toContain('(5)');
  await act(async () => detail.click());
  expect(onOpenNetwork).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

test('registar ocorrência grava no diário e volta a ler a saúde da rede', async () => {
  const { host, root, fetchMock } = await mount(calm);
  const register = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Registar ocorrência'))!;
  await act(async () => register.click());
  const title = document.querySelector<HTMLInputElement>('#network-diary-form input[maxlength="140"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Antenas a cair em conjunto');
    title.dispatchEvent(new Event('input', { bubbles: true }));
  });
  fetchMock.mockClear();
  await act(async () => {
    document.querySelector<HTMLFormElement>('#network-diary-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toContain('/api/network/diary');
  expect(init.method).toBe('POST');
  expect(JSON.parse(String(init.body))).toMatchObject({ title: 'Antenas a cair em conjunto', status: 'aberta' });
  expect(fetchMock.mock.calls.some(([next]) => String(next).endsWith('/api/network/health'))).toBe(true);
  await act(async () => root.unmount());
});

test('falha a ler: pede para tentar outra vez em vez de mostrar zeros', async () => {
  const { host, root } = await mount(null);
  expect(host.textContent).toContain('Não foi possível ler a saúde da rede.');
  expect(host.querySelector('.network-health-figures')).toBeNull();
  await act(async () => root.unmount());
});

test('situações: o que o router já contou não se repete pela sonda', () => {
  expect(healthSituations(conflict).map((row) => row.key)).toEqual([
    'down:5', 'ip_duplicado:BC:07:1D:5E:42:9E', 'antena_em_baixo:192.168.1.251', 'dhcp_intruso:30:16:9D:AA:53:8B', 'probe:1'
  ]);
  expect(antennaDrops(calm)).toBe(0);
});

test('as horas locais do router e do diário não passam pelo fuso', () => {
  expect(formatLocalStamp('2026-10-07 13:16:00')).toBe('07/10/2026 13:16');
  expect(formatLocalStamp('2026-10-06T17:54')).toBe('06/10/2026 17:54');
  expect(formatLocalStamp('2026-10-07 13:16:00', false)).toBe('07/10 13:16');
  expect(formatLocalStamp('ontem')).toBe('ontem');
});

test('uma resposta que não é a saúde da rede não deita o painel abaixo', async () => {
  const { host, root } = await mount({} as NetworkHealth);
  expect(host.textContent).toContain('Não foi possível ler a saúde da rede.');
  await act(async () => root.unmount());
});
