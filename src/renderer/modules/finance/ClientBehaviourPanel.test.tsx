/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ClientBehaviourPanel } from './ClientBehaviourPanel';
import type { ClientBehaviourDetail } from '../../types';

/**
 * O painel existe para uma letra se poder discutir ao telefone: tem de mostrar
 * as contas por baixo dela e como ela se moveu.
 */

const detail: ClientBehaviourDetail = {
  clientId: 3,
  clientName: 'Junior Taxista',
  clientCode: 'C0007',
  zone: 'Espia',
  clientStatus: 'active',
  state: 'vencido',
  overdueCve: 2500,
  trend: 'down',
  score: 51,
  letter: 'D',
  confidence: 'consolidada',
  evaluated: 7,
  onTime: 1,
  settled: 6,
  punctualityPct: 14,
  avgDelayDays: 12,
  recentEvaluated: 5,
  parts: { punctuality: 16, delay: 5, settled: 17.1, regularity: 6 },
  history: [
    { month: '2026-10', score: 55, letter: 'D', evaluated: 6 },
    { month: '2026-11', score: 51, letter: 'D', evaluated: 7 }
  ]
};

const roots: Root[] = [];

async function mount(body: unknown = detail, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok, status: ok ? 200 : 500, json: async () => body
  })));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(<ClientBehaviourPanel clientId={3} />); });
  await act(async () => { await Promise.resolve(); });
  return container;
}

beforeEach(() => { document.body.innerHTML = ''; });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('comportamento na ficha financeira', () => {
  test('mostra a letra, a pontuação e quanto histórico a sustenta', async () => {
    const container = await mount();
    const texto = container.textContent || '';
    expect(texto).toContain('Irregular');
    expect(texto).toContain('51');
    expect(texto).toContain('Confiança consolidada');
    expect(texto).toContain('7 mensalidades avaliadas');
  });

  test('abre as contas: cada critério com os pontos que deu e os que podia dar', async () => {
    const container = await mount();
    const linhas = [...container.querySelectorAll('.client-behaviour-parts tbody tr')]
      .map((tr) => tr.textContent?.replace(/\s+/g, ' ').trim());
    expect(linhas).toHaveLength(4);
    expect(linhas[0]).toContain('Pontualidade');
    // 16 pontos de 40 possíveis: é a diferença que explica a classe.
    expect(linhas[0]).toContain('16');
    expect(linhas[0]).toContain('40');
  });

  test('a acção recomendada aparece, porque é o que se faz a seguir', async () => {
    const container = await mount();
    expect(container.textContent).toContain('Acompanhar a cobrança de perto');
  });

  test('a evolução traz um quadrado por mês, com a letra desse mês', async () => {
    const container = await mount();
    const meses = [...container.querySelectorAll('.client-behaviour-history li')];
    expect(meses).toHaveLength(2);
    expect(meses[1].textContent).toContain('D');
    expect(meses[1].className).toContain('is-d');
  });

  test('sem nada para julgar explica-se, em vez de mostrar zeros', async () => {
    const container = await mount({
      ...detail, letter: null, confidence: null, score: 0, evaluated: 0, history: []
    });
    expect(container.textContent).toContain('Por avaliar');
    expect(container.textContent).toContain('Sem mensalidade vencida nem paga');
    expect(container.querySelector('.client-behaviour-parts')).toBeNull();
  });

  test('um erro da API deixa tentar outra vez em vez de um painel vazio', async () => {
    const container = await mount(detail, false);
    expect(container.textContent).toContain('Não foi possível carregar');
  });
});
