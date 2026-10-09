/** @vitest-environment jsdom */

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../../components';
import { AuthProvider } from '../../lib/auth';
import RouterModule from './RouterModule';
import { formatDataVolume } from './router-api';

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
    if (url.endsWith('/router/wan/usage')) return json({
      since: '2026-09-25T12:00:00.000Z',
      today: [
        { interface: 'WAN1-STARLINK', rxBytes: 2_000_000_000, txBytes: 100_000_000 },
        { interface: 'WAN2-STARLINK', rxBytes: 1_000_000_000, txBytes: 50_000_000 }
      ],
      month: [
        { interface: 'WAN1-STARLINK', rxBytes: 5_000_000_000, txBytes: 200_000_000 },
        { interface: 'WAN2-STARLINK', rxBytes: 3_000_000_000, txBytes: 100_000_000 }
      ],
      days: []
    });
    if (url.endsWith('/router/wan')) {
      // Cada resposta traz as taxas que o router mediu para as duas WAN.
      wanReads += 1;
      const t = wanReads * 1000;
      return json({
        available: true,
        dryRun: true,
        sampledAt: t,
        interfaces: [
          { name: 'WAN1-STARLINK', running: true, downBps: 10_000_000, upBps: 1_000_000 },
          { name: 'WAN2-STARLINK', running: false, downBps: 5_000_000, upBps: 500_000 }
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
      'Visão geral', 'Sessões PPPoE', 'Reconciliação', 'Perfis PPP', 'Interfaces', 'Consumo', 'Cópias', 'Registo', 'Configuração'
    ]);
    expect(container.querySelector('.router-subtitle')?.textContent).toBe('ISP-Gestao · 192.168.88.1 · hEX S · RouterOS 7.24.2');
    expect(container.textContent).toContain('Em ensaio');
    expect(container.textContent).toContain('31');
    expect(container.textContent).toContain('50%');
    expect(container.textContent).toContain('/ip service disable www');
  });

  test('a visão geral mostra o download e o upload de cada WAN na primeira leitura', async () => {
    const container = await mount();
    expect(container.textContent).toContain('Tráfego das WAN');
    const cards = [...container.querySelectorAll('.router-wan-card')];
    expect(cards.map((card) => card.querySelector('strong')?.textContent)).toEqual(['WAN1-STARLINK', 'WAN2-STARLINK', 'Total']);
    expect(cards[0].textContent).toContain('10 Mbit/s');
    expect(cards[0].textContent).toContain('1 Mbit/s');
    expect(cards[1].textContent).toContain('5 Mbit/s');
    expect(cards[1].textContent).toContain('Sem ligação');
  });

  test('o cartão Total, ao lado das WAN, soma as duas e mostra a repartição', async () => {
    const container = await mount();
    const total = container.querySelector('.router-wan-grid.has-total > .router-wan-card.is-total');
    const [down, up] = [...(total?.querySelectorAll('.router-wan-rates strong') ?? [])].map((node) => node.textContent);
    expect(down).toBe('15 Mbit/s');
    expect(up).toBe('1,5 Mbit/s');
    expect(total?.textContent).toContain('1 de 2 ligadas');
    expect(total?.querySelector('.router-wan-split')?.textContent).toBe('WAN1-STARLINK 67% · WAN2-STARLINK 33%');
  });

  test('com uma só WAN não há cartão Total', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const response = await original(input);
      if (!String(input).endsWith('/router/wan')) return response;
      const body = await response.json();
      return json({ ...body, interfaces: body.interfaces.slice(0, 1) });
    });
    const container = await mount();
    expect(container.querySelectorAll('.router-wan-card')).toHaveLength(1);
    expect(container.querySelector('.is-total')).toBeNull();
  });

  test('cada cartão mostra o consumo de hoje e do mês; o Total soma as WAN', async () => {
    const container = await mount();
    const ledgers = [...container.querySelectorAll('.router-wan-card .router-wan-ledger')].map((ledger) =>
      [...ledger.querySelectorAll(':scope > div')].map((row) => [...row.children].map((cell) => cell.textContent?.trim())));
    expect(ledgers).toEqual([
      [['Hoje', '2 GB', '100 MB'], ['Mês', '5 GB', '200 MB']],
      [['Hoje', '1 GB', '50 MB'], ['Mês', '3 GB', '100 MB']],
      [['Hoje', '3 GB', '150 MB'], ['Mês', '8 GB', '300 MB']]
    ]);
    // Os mosaicos repetiam os mesmos números: a secção do acumulado ficou só com o histórico.
    expect(container.querySelector('.router-usage-period')).toBeNull();
    expect(container.textContent).toContain('Consumo diário das WAN');
  });

  test('o histórico mostra o total diário das WAN no tooltip e na última barra', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    const firstRx = 2_000_000_000;
    const secondRx = 1_000_000_000;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const response = await original(input);
      if (!String(input).endsWith('/router/wan/usage')) return response;
      const body = await response.json();
      return json({ ...body, days: [
        { day: '2026-09-24', perInterface: [{ interface: 'WAN2-STARLINK', rxBytes: 500_000_000, txBytes: 50_000_000 }] },
        { day: '2026-09-25', perInterface: [
          { interface: 'WAN1-STARLINK', rxBytes: firstRx, txBytes: 100_000_000 },
          { interface: 'WAN2-STARLINK', rxBytes: secondRx, txBytes: 50_000_000 }
        ] }
      ] });
    });
    const container = await mount();
    const history = container.querySelector('.router-usage-history');
    const lastDay = history?.querySelector('.router-usage-day:last-child');
    expect(lastDay?.getAttribute('title')).toContain(`soma das WAN ${formatDataVolume(firstRx + 100_000_000 + secondRx + 50_000_000)}`);
    expect(lastDay?.getAttribute('title')).toContain(`↓ ${formatDataVolume(firstRx)} · ↑ ${formatDataVolume(100_000_000)} · total ${formatDataVolume(firstRx + 100_000_000)}`);
    // Cada dia com tráfego mostra a soma das WAN em GB; hoje e o pico em destaque.
    expect([...history!.querySelectorAll('.router-usage-total')].map((label) => label.textContent)).toEqual(['0,6', '3,2']);
    expect(lastDay?.querySelector('.router-usage-total')?.classList.contains('is-key')).toBe(true);
    expect(lastDay?.querySelector('.router-usage-total')?.classList.contains('is-end')).toBe(true);
    expect(history?.querySelector('.router-usage-day:first-child i')?.classList.contains('is-second')).toBe(true);
  });

  test('dias anteriores à contagem no router ficam esbatidos e não ditam a escala', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const response = await original(input);
      if (!String(input).endsWith('/router/wan/usage')) return response;
      const body = await response.json();
      return json({ ...body, exactSince: '2026-09-30', days: [
        { day: '2026-09-29', perInterface: [{ interface: 'WAN1-STARLINK', rxBytes: 4_000_000_000, txBytes: 0 }] },
        { day: '2026-09-30', perInterface: [{ interface: 'WAN1-STARLINK', rxBytes: 1_000_000_000, txBytes: 0 }] }
      ] });
    });
    const container = await mount();
    const [old, exact] = [...container.querySelectorAll('.router-usage-history .router-usage-day')];
    expect(old.classList.contains('is-estimated')).toBe(true);
    expect(old.getAttribute('title')).toContain('não comparável com a Starlink');
    expect(exact.classList.contains('is-estimated')).toBe(false);
    expect((exact.querySelector('i') as HTMLElement).style.height).toBe('100%');
    expect((old.querySelector('i') as HTMLElement).style.height).toBe('100%');
  });

  test('dia copiado da conta Starlink não fica esbatido, conta para a escala e mostra só o total', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const response = await original(input);
      if (!String(input).endsWith('/router/wan/usage')) return response;
      const body = await response.json();
      return json({ ...body, exactSince: '2026-09-30', days: [
        { day: '2026-09-29', perInterface: [{ interface: 'WAN1-STARLINK', rxBytes: 2_000_000_000, txBytes: 0, source: 'starlink' }] },
        { day: '2026-09-30', perInterface: [{ interface: 'WAN1-STARLINK', rxBytes: 1_000_000_000, txBytes: 0, source: 'counted' }] }
      ] });
    });
    const container = await mount();
    const [copied, exact] = [...container.querySelectorAll('.router-usage-history .router-usage-day')];
    expect(copied.classList.contains('is-estimated')).toBe(false);
    expect(copied.getAttribute('title')).toContain(`WAN1-STARLINK: total ${formatDataVolume(2_000_000_000)} (conta Starlink)`);
    expect(copied.getAttribute('title')).not.toContain('↓');
    expect((copied.querySelector('i') as HTMLElement).style.height).toBe('100%');
    expect((exact.querySelector('i') as HTMLElement).style.height).toBe('50%');
  });

  test('instala o contador pelo botão e mostra o estado após a importação', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    let active = false;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/router/wan/usage/counter') && init?.method === 'POST') {
        active = true;
        return json({ source: 'router', rows: 1 });
      }
      const response = await original(input);
      if (!String(input).endsWith('/router/wan/usage')) return response;
      const body = await response.json();
      return json({ ...body, routerImportedAt: active ? new Date().toISOString() : null });
    });
    const container = await mount();
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === 'Contar no router');
    expect(button).toBeTruthy();
    await click(button);
    expect(container.textContent).toContain('A contar no router');
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/router/wan/usage/counter') && (init as RequestInit)?.method === 'POST')).toBe(true);
  });

  test('sem registo do acumulado, os cartões mostram "—" e mantêm a linha', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request) =>
      String(input).endsWith('/router/wan/usage')
        ? json({ since: null, today: [], month: [], days: [] })
        : original(input));
    const container = await mount();
    const first = container.querySelector('.router-wan-card .router-wan-ledger');
    expect([...(first?.querySelectorAll('dd') ?? [])].map((cell) => cell.textContent?.trim())).toEqual(['—', '—', '—', '—']);
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

  test('criar utilizadores em falta mostra o plano antes de gravar', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    const sent: boolean[] = [];
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith('/pppoe/backfill')) return original(input);
      const { apply } = JSON.parse(String(init?.body)) as { apply: boolean };
      sent.push(apply);
      return json({
        create: [{ serviceId: 4, clientCode: 'C0002', clientName: 'Ana Lima', username: 'skn002' }],
        skipped: [{ serviceId: 3, clientCode: 'C0001', clientName: 'Isa Rafe', username: 'skn001', reason: 'nome já existe no router' }],
        ...(apply ? { applied: 1 } : {})
      });
    });
    const container = await mount();
    await click(container.querySelector('#router-tab-sessions'));
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Criar utilizadores em falta'));
    expect(sent).toEqual([false]);
    expect(document.body.textContent).toContain('1 a criar · 1 saltados');
    expect(document.body.textContent).toContain('skn002');
    expect(document.body.textContent).toContain('nome já existe no router');
    await click([...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Confirmar criação'));
    expect(sent).toEqual([false, true]);
    expect(document.body.textContent).toContain('1 utilizadores PPPoE preparados.');
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

  test('o registo guardado lê-se por dia, filtra-se e exporta o dia inteiro', async () => {
    const stored: Record<string, Array<{ id: string; time: string; topics: string; message: string }>> = {
      '2026-10-08': [
        { id: '*1', time: '2026-10-08 20:06:54', topics: 'bridge,warning', message: 'LAN1: received DHCP server message on untrusted port from source IP 192.168.1.1, MAC 04:f4:1c:45:fd:96' },
        { id: '*2', time: '2026-10-08 20:07:07', topics: 'netwatch,info', message: 'event down [ type: simple, host: 192.168.1.110 ]' }
      ],
      '2026-10-07': [{ id: '*3', time: '2026-10-07 18:19:05', topics: 'netwatch,info', message: 'event down [ type: simple, host: 192.168.1.251 ]' }]
    };
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/router/log/days')) return json([{ day: '2026-10-08', lines: 2 }, { day: '2026-10-07', lines: 1 }]);
      const day = url.split('/router/log/history?day=')[1];
      return day ? json({ day, entries: stored[day] ?? [] }) : original(input);
    });
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:registo'; }, revokeObjectURL: () => undefined }));
    const container = await mount();
    await click(container.querySelector('#router-tab-log'));
    const views = [...container.querySelectorAll('.router-log-views [role="tab"]')];
    expect(views.map((node) => node.textContent)).toEqual(['Ao vivo', 'Guardado']);
    await click(views[1]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const panel = container.querySelector('#router-panel-log')!;
    const select = panel.querySelector('select')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(['08/10/2026 · 2 linhas', '07/10/2026 · 1 linhas']);
    expect(panel.querySelectorAll('.data-table-row')).toHaveLength(2);
    // Com o dia escolhido, a coluna mostra só a hora.
    expect(panel.textContent).toContain('20:06:54');
    expect(panel.textContent).not.toContain('2026-10-08 20:06:54');

    const type = async (element: HTMLInputElement | HTMLSelectElement, value: string, event: string) => {
      const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event(event, { bubbles: true }));
      });
    };
    await type(panel.querySelector<HTMLInputElement>('input[type="search"]')!, 'NETWATCH', 'input');
    expect(panel.querySelectorAll('.data-table-row')).toHaveLength(1);

    // O ficheiro leva o dia inteiro, não o que o filtro deixa à vista.
    await click([...panel.querySelectorAll('button')].find((button) => button.textContent?.includes('Exportar .txt')));
    expect((await blobs[0].text()).split('\n').filter(Boolean)).toHaveLength(2);
    expect(await blobs[0].text()).toContain('2026-10-08 20:07:07 netwatch,info event down');

    await type(select, '2026-10-07', 'change');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(panel.textContent).toContain('192.168.1.251');
    expect(panel.textContent).not.toContain('192.168.1.110');
  });

  test('router por configurar é um estado vazio que leva à configuração, não um erro', async () => {
    routerAvailable = false;
    const container = await mount();
    expect(container.querySelector('.empty-state-title')?.textContent).toBe('Router de gestão do ISP indisponível');
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
