/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BehaviourReportPanel } from './BehaviourReportPanel';
import type { PaymentBehaviourReport, PortfolioPoint } from '../../types';

/**
 * O relatório responde a três perguntas: como está a carteira por classe, para
 * onde foi nos últimos meses, e quem mudou de letra agora.
 */

const cliente = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  clientId: id,
  clientName: name,
  clientCode: `C000${id}`,
  zone: null,
  clientStatus: 'active',
  state: 'em_dia',
  overdueCve: 0,
  trend: 'flat',
  score: 95,
  letter: 'A',
  confidence: 'consolidada',
  evaluated: 7,
  onTime: 7,
  settled: 7,
  punctualityPct: 100,
  avgDelayDays: 0,
  recentEvaluated: 6,
  parts: { punctuality: 40, delay: 25, settled: 20, regularity: 15 },
  ...over
});

const report = {
  generatedAt: '2026-11-21T00:00:00.000Z',
  asOf: '2026-11-21',
  rules: { scale: 'exigente', delayLimitDays: 15 },
  totals: {
    classified: 3,
    awaiting: 1,
    avgScore: 76,
    inGoodStandingPct: 66,
    alwaysOnTimePct: 33,
    improving: 1,
    declining: 1,
    distribution: { A: 1, B: 0, C: 0, D: 1, E: 1 },
    overdueByClass: { A: 0, B: 0, C: 0, D: 2500, E: 7000 }
  },
  clients: [
    cliente(1, 'Chia', { trend: 'up' }),
    cliente(2, 'Junior Taxista', {
      letter: 'D', score: 51, trend: 'down', overdueCve: 2500, punctualityPct: 14
    }),
    cliente(3, 'Libaz', { letter: 'E', score: 30, overdueCve: 7000, punctualityPct: 0 }),
    cliente(4, 'Dalila', { letter: null, score: 0, evaluated: 0, confidence: null })
  ]
} as unknown as PaymentBehaviourReport;

const months: PortfolioPoint[] = [
  { month: '2026-10', classified: 2, avgScore: 80, distribution: { A: 1, B: 1, C: 0, D: 0, E: 0 } },
  { month: '2026-11', classified: 3, avgScore: 76, distribution: { A: 1, B: 0, C: 0, D: 1, E: 1 } }
];

const roots: Root[] = [];

async function mount(ok = true, totals = report.totals) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => (String(url).endsWith('/history') ? { months } : { ...report, totals })
  })));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(<BehaviourReportPanel />); });
  await act(async () => { await Promise.resolve(); });
  return container;
}

beforeEach(() => { document.body.innerHTML = ''; });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('comportamento da carteira em Relatórios', () => {
  test('uma linha por classe, com o vencido que cada uma tem', async () => {
    const container = await mount();
    const linhas = [...container.querySelectorAll('.behaviour-report-table')][0]
      .querySelectorAll('tbody tr');
    expect(linhas).toHaveLength(5);
    const critico = [...linhas].find((tr) => tr.textContent?.includes('Crítico'));
    expect(critico?.textContent).toContain('7.000$00');
  });

  test('a evolução traz um mês por linha, com a distribuição desse mês', async () => {
    const container = await mount();
    const evolucao = [...container.querySelectorAll('.behaviour-report-table')][1];
    expect(evolucao.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(evolucao.textContent).toContain('80');
  });

  test('separa quem piorou de quem melhorou, e nomeia-os', async () => {
    const container = await mount();
    const seccoes = [...container.querySelectorAll('.behaviour-report-moved section')];
    expect(seccoes[0].textContent).toContain('Pioraram');
    expect(seccoes[0].textContent).toContain('Junior Taxista');
    expect(seccoes[1].textContent).toContain('Melhoraram');
    expect(seccoes[1].textContent).toContain('Chia');
  });

  test('sem ninguém classificado explica-se, em vez de tabelas vazias', async () => {
    const container = await mount(true, { ...report.totals, classified: 0 });
    expect(container.textContent).toContain('Ninguém classificado ainda');
    expect(container.querySelector('.behaviour-report-table')).toBeNull();
  });

  test('um erro da API deixa tentar outra vez', async () => {
    const container = await mount(false);
    expect(container.textContent).toContain('Não foi possível carregar');
  });
});
