/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../../components';
import { AuthProvider } from '../../lib/auth';
import type { ClientBehaviour, PaymentBehaviourReport } from '../../types';
import { PaymentBehaviourTab } from './PaymentBehaviourTab';

/**
 * O que este ecrã tem de acertar: a letra vem do histórico, o estado é o de
 * hoje, e os dois não se confundem. Um cliente de classe A com uma fatura
 * vencida continua classe A — é a distinção que justifica o ecrã existir.
 */
const client = (over: Partial<ClientBehaviour>): ClientBehaviour => ({
  clientId: 1,
  clientName: 'Cliente',
  clientCode: 'C0001',
  zone: null,
  clientStatus: 'active',
  state: 'em_dia',
  overdueCve: 0,
  trend: 'flat',
  score: 100,
  letter: 'A',
  confidence: 'elevada',
  evaluated: 12,
  onTime: 12,
  settled: 12,
  punctualityPct: 100,
  avgDelayDays: 0,
  recentEvaluated: 6,
  parts: { punctuality: 40, delay: 25, settled: 20, regularity: 15 },
  ...over
});

const report: PaymentBehaviourReport = {
  generatedAt: '2026-11-20T00:00:00.000Z',
  asOf: '2026-11-20',
  rules: { scale: 'exigente', delayLimitDays: 15 },
  totals: {
    classified: 3,
    awaiting: 1,
    avgScore: 74,
    inGoodStandingPct: 33,
    alwaysOnTimePct: 33,
    improving: 1,
    declining: 1,
    distribution: { A: 1, B: 1, C: 0, D: 0, E: 1 },
    overdueByClass: { A: 0, B: 0, C: 0, D: 0, E: 15000 }
  },
  clients: [
    client({
      clientId: 1, clientName: 'Jaqueline Restaurante', clientCode: 'C0012',
      state: 'vencido', overdueCve: 2500, trend: 'down'
    }),
    client({
      clientId: 2, clientName: 'Antonio Silva', clientCode: 'C0031', letter: 'B', score: 82,
      evaluated: 9, onTime: 7, settled: 9, punctualityPct: 78, avgDelayDays: 3, trend: 'up'
    }),
    client({
      clientId: 3, clientName: 'Mario Gomes', clientCode: 'C0044', letter: 'E', score: 18,
      evaluated: 6, onTime: 0, settled: 0, punctualityPct: 0, avgDelayDays: 64,
      state: 'suspenso', overdueCve: 15000
    }),
    client({
      clientId: 4, clientName: 'Acabou de Entrar', clientCode: 'C0050', letter: null,
      score: 0, confidence: null, evaluated: 0, onTime: 0, settled: 0, punctualityPct: 0
    })
  ]
};

const roots: Root[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function mount(onOpenClient?: (id: number) => void): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <PaymentBehaviourTab onOpenClient={onOpenClient} />
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    );
  });
  return container;
}

const metricValues = (container: HTMLElement) =>
  [...container.querySelectorAll('.metric-card strong')].map((n) => n.textContent?.trim() || '');

const rowNames = (container: HTMLElement) =>
  [...container.querySelectorAll('.data-table-cell strong')].map((n) => n.textContent?.trim() || '');

const clickButton = async (container: HTMLElement, text: string) => {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`botao "${text}" nao encontrado`);
  await act(async () => { button.click(); });
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) return jsonResponse({ setupRequired: false, authBypassed: true });
    if (url.endsWith('/api/finance/payment-behaviour')) return jsonResponse(report);
    return jsonResponse([]);
  }));
});

afterEach(async () => {
  await act(async () => { while (roots.length > 0) roots.pop()?.unmount(); });
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Comportamento de pagamento', () => {
  test('mostra a media, os bons pagadores, os que estao em dia e os sem historico', async () => {
    const container = await mount();
    expect(metricValues(container)).toEqual(['74', '2', '33%', '1']);
  });

  test('uma coluna por dado, cada uma com o seu cabecalho', async () => {
    // Codigo, Pontualidade, Atraso medio e Avaliadas comecam escondidas: as onze
    // colunas nao cabem nos 918px que a tabela tem a 1225px de ecra.
    const container = await mount();
    const headers = [...container.querySelectorAll('[role="columnheader"]')].map((n) => n.textContent?.trim());
    expect(headers).toEqual([
      'Cliente', 'Classe', 'Pontuação', 'Confiança', 'Tendência', 'Estado', 'Vencido'
    ]);
    for (const row of container.querySelectorAll('.data-table-row')) {
      expect(row.querySelectorAll('[role="cell"]')).toHaveLength(headers.length);
    }
  });

  test('as colunas escondidas por omissao voltam em "Colunas"', async () => {
    const container = await mount();
    await clickButton(container, 'Colunas');
    const item = [...container.querySelectorAll('.column-picker-item')]
      .find((node) => node.textContent?.includes('Avaliadas'))?.querySelector('input');
    if (!item) throw new Error('coluna Avaliadas nao encontrada');
    await act(async () => { item.click(); });
    const headers = [...container.querySelectorAll('[role="columnheader"]')].map((n) => n.textContent?.trim());
    expect(headers).toContain('Avaliadas');
  });

  test('a letra e o estado de hoje sao dois dados diferentes na mesma linha', async () => {
    const container = await mount();
    const row = [...container.querySelectorAll('.data-table-row')]
      .find((r) => r.textContent?.includes('Jaqueline Restaurante'));
    expect(row?.querySelector('[data-label="Classe"]')?.textContent).toContain('Excelente');
    expect(row?.querySelector('[data-label="Estado"]')?.textContent).toBe('Vencido');
    expect(row?.querySelector('[data-label="Vencido"]')?.textContent).toBe('2.500$00');
  });

  test('quem nao tem historico bastante nao leva letra nem numeros inventados', async () => {
    const container = await mount();
    const row = [...container.querySelectorAll('.data-table-row')]
      .find((r) => r.textContent?.includes('Acabou de Entrar'));
    expect(row?.querySelector('[data-label="Classe"]')?.textContent).toBe('Por avaliar');
    expect(row?.querySelector('[data-label="Pontuação"]')?.textContent).toBe('—');
  });

  test('quem nao tem historico fica no fim da lista, nao no topo', async () => {
    // Uma mensalidade paga a horas pontua 100; ordenado por pontuacao, abria a
    // lista o cliente de quem menos se sabe.
    const container = await mount();
    expect(rowNames(container).at(-1)).toBe('Acabou de Entrar');
  });

  test('a acao recomendada esta a um hover, nao num paragrafo no ecra', async () => {
    const container = await mount();
    const pill = container.querySelector('.score-pill.is-e');
    expect(pill?.getAttribute('title')).toBe('Gerir a dívida e rever as condições.');
  });

  test('filtrar por classe reduz a lista', async () => {
    const container = await mount();
    await clickButton(container, 'B (1)');
    expect(rowNames(container)).toEqual(['Antonio Silva']);
  });

  test('filtrar por quem aguarda avaliacao mostra so esses', async () => {
    const container = await mount();
    await clickButton(container, 'Aguarda avaliação (1)');
    expect(rowNames(container)).toEqual(['Acabou de Entrar']);
  });

  test('clicar numa linha abre a ficha do cliente', async () => {
    const onOpenClient = vi.fn();
    const container = await mount(onOpenClient);
    const row = [...container.querySelectorAll('.data-table-row')]
      .find((r) => r.textContent?.includes('Mario Gomes')) as HTMLElement | undefined;
    if (!row) throw new Error('linha nao encontrada');
    await act(async () => { row.click(); });
    expect(onOpenClient).toHaveBeenCalledWith(3);
  });

  test('diz com que regras as letras foram feitas', async () => {
    const container = await mount();
    expect(container.querySelector('.behaviour-scale')?.textContent)
      .toBe('Exigente · atraso 15 d');
  });

  test('um erro da API deixa tentar outra vez em vez de um ecra vazio', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/auth/status')) return jsonResponse({ setupRequired: false, authBypassed: true });
      return new Response('nao', { status: 500 });
    }));
    const container = await mount();
    expect(container.textContent).toContain('Não foi possível carregar o comportamento de pagamento.');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Tentar'))).toBe(true);
  });
});
