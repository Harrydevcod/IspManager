/** @vitest-environment jsdom */

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../../components';
import { AuthProvider } from '../../lib/auth';
import RouterModule from './RouterModule';

const overview = {
  available: true,
  dryRun: true,
  host: '192.168.88.1',
  system: { identity: 'ISP-Gestao', version: '7.24.2', boardName: 'hEX S', architecture: 'mmips', uptime: '3d4h', cpuLoad: 7, freeMemory: 134217728, totalMemory: 268435456 },
  secrets: 40,
  disabledSecrets: 2,
  activeSessions: 31,
  divergences: 3,
  findings: [{ services: ['www'], severity: 'grave', detail: 'REST em claro na porta 80.', command: '/ip service disable www' }],
  lastEnforcement: null
};

const sessions = {
  available: true,
  dryRun: true,
  sessions: [
    { serviceId: 1, clientName: 'Ana Lopes', login: 'ana-1', state: 'online', online: true, suspended: false, address: '10.0.0.5', uptime: '1h', routerProfile: 'PLANO-20-20' },
    { serviceId: null, clientName: null, login: 'vizinho', state: 'sem_servico', online: false, suspended: false, address: null, uptime: null, routerProfile: 'default' }
  ]
};

const log = {
  available: true,
  dryRun: true,
  entries: [
    { id: '*2', time: '02:40:13', topics: 'system,error,critical', message: 'login failure for user admin from 10.0.0.9 via winbox' },
    { id: '*1', time: '02:39:00', topics: 'pppoe,ppp,info', message: 'skn001 logged in, 10.20.0.10' }
  ],
  loginFailures: [{ address: '10.0.0.9', via: 'winbox', users: ['admin'], count: 1 }],
  rogueDhcp: [{ port: 'LAN1', address: '192.168.0.1', mac: '30:16:9D:AA:53:8B', count: 187, vendor: 'MERCUSYS', clientName: null }],
  pppoeDrops: [{ login: 'skn001', reasons: ['peer is not responding'], count: 4, clientName: 'Cibel Restaurante' }],
  dhcpChurn: []
};

let routerAvailable = true;
let wanReads = 0;
const roots: Root[] = [];

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  routerAvailable = true;
  wanReads = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) return json({ setupRequired: false, authBypassed: true });
    if (!routerAvailable && url.includes('/api/network/router/')) return json({ available: false, reason: 'Integração MikroTik desligada ou por configurar' });
    if (url.endsWith('/router/overview')) return json(overview);
    if (url.endsWith('/router/sessions')) return json(sessions);
    if (url.endsWith('/router/log')) return json(log);
    if (url.endsWith('/router/wan')) {
      // Cada leitura avança 3 s: 3,75 MB/0,375 MB na WAN1 = 10/1 Mbit/s; a WAN2 a metade.
      wanReads += 1;
      const t = wanReads * 3000;
      return json({
        available: true,
        dryRun: true,
        sampledAt: t,
        interfaces: [
          { name: 'WAN1-STARLINK', running: true, rxBytes: wanReads * 3_750_000, txBytes: wanReads * 375_000 },
          { name: 'WAN2-STARLINK', running: false, rxBytes: wanReads * 1_875_000, txBytes: wanReads * 187_500 }
        ]
      });
    }
    return json({});
  }));
});

afterEach(async () => {
  await act(async () => { while (roots.length) roots.pop()?.unmount(); });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<StrictMode><AuthProvider><ToastProvider><ConfirmProvider><RouterModule /></ConfirmProvider></ToastProvider></AuthProvider></StrictMode>);
  });
  return container;
}

async function click(element: Element | null | undefined) {
  await act(async () => { (element as HTMLElement).click(); });
}

describe('Router de gestão', () => {
  test('abre na visão geral com o equipamento, o modo e os serviços abertos', async () => {
    const container = await mount();
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'Visão geral', 'Sessões PPPoE', 'Perfis PPP', 'Interfaces', 'Registo', 'Configuração'
    ]);
    expect(container.querySelector('.router-subtitle')?.textContent).toBe('ISP-Gestao · 192.168.88.1 · hEX S · RouterOS 7.24.2');
    expect(container.textContent).toContain('Em ensaio');
    expect(container.textContent).toContain('31');
    expect(container.textContent).toContain('50%');
    expect(container.textContent).toContain('/ip service disable www');
  });

  test('a visão geral mede o download e o upload de cada WAN entre duas leituras', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const container = await mount();
      expect(container.textContent).toContain('Tráfego das WAN');
      await act(async () => { vi.advanceTimersByTime(3000); });
      const cards = [...container.querySelectorAll('.router-wan-card')];
      expect(cards.map((card) => card.querySelector('strong')?.textContent)).toEqual(['WAN1-STARLINK', 'WAN2-STARLINK']);
      expect(cards[0].textContent).toContain('10 Mbit/s');
      expect(cards[0].textContent).toContain('1 Mbit/s');
      expect(cards[1].textContent).toContain('5 Mbit/s');
      expect(cards[1].textContent).toContain('Sem ligação');
      expect(container.querySelector('.router-wan-total')?.textContent).toContain('67% / 33%');
    } finally {
      vi.useRealTimers();
    }
  });

  test('as sessões mostram também o secret que nenhum serviço reclama', async () => {
    const container = await mount();
    await click(container.querySelector('#router-tab-sessions'));
    const rows = container.querySelectorAll('.data-table-row');
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain('Sem serviço no ISPM');
    // Só a sessão viva de um serviço do ISPM se pode desligar.
    expect(container.querySelectorAll('[aria-label^="Desligar a sessão"]')).toHaveLength(1);
  });

  test('o registo resume o que pede ação e filtra só erros e avisos', async () => {
    const container = await mount();
    await click(container.querySelector('#router-tab-log'));
    const titles = [...container.querySelectorAll('.router-findings strong')].map((node) => node.textContent);
    expect(titles).toEqual(['DHCP intruso na porta LAN1 · MERCUSYS', 'Falhas de login de 10.0.0.9', 'PPPoE de Cibel Restaurante caiu 4 vezes']);
    expect(container.textContent).toContain('30:16:9D:AA:53:8B · 192.168.0.1 — 187 avisos');
    expect(container.textContent).toContain('1 tentativa por winbox · admin');
    expect(container.querySelectorAll('.data-table-row')).toHaveLength(2);
    await click(container.querySelector('#router-panel-log input[type="checkbox"]'));
    expect(container.querySelectorAll('.data-table-row')).toHaveLength(1);
    expect(container.textContent).not.toContain('skn001 logged in');
  });

  test('router por configurar é um estado vazio que leva à configuração, não um erro', async () => {
    routerAvailable = false;
    const container = await mount();
    expect(container.querySelector('.empty-state-title')?.textContent).toBe('Router indisponível');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Abrir configuração'));
    expect(container.querySelector('#router-tab-config')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('#router-panel-config')).not.toBeNull();
  });

  test('as setas mudam de aba e dão a volta nas pontas', async () => {
    const container = await mount();
    const first = container.querySelector<HTMLButtonElement>('#router-tab-overview')!;
    await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(container.querySelector('#router-tab-config')?.getAttribute('aria-selected')).toBe('true');
  });
});
