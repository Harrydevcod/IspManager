/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import type { RevenuePoint } from '../types';
import { RevenueBars, revenueLayout, revenueTicks } from './RevenueBars';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function point(month: number, values: Partial<RevenuePoint> = {}): RevenuePoint {
  return {
    referenceMonth: `2026-${String(month).padStart(2, '0')}`,
    paidCve: 0,
    pendingCve: 0,
    expenseCve: 0,
    opexCve: 0,
    ...values
  };
}

function mount(points: RevenuePoint[], onSelectMonth?: (month: string) => void): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<RevenueBars points={points} onSelectMonth={onSelectMonth} />));
  return container;
}

test('a escala é a da receita: um investimento enorme não encolhe as barras e fica preso no topo', () => {
  const points = [point(1, { paidCve: 3_000, expenseCve: 250_000 }), point(2, { paidCve: 60_000, pendingCve: 10_000 })];
  const semCusto = revenueLayout(points.map((p) => ({ ...p, expenseCve: 0 })), 800);
  const layout = revenueLayout(points, 800);

  expect(layout.maxValue).toBe(semCusto.maxValue);
  expect(layout.bars[1].paidH).toBe(semCusto.bars[1].paidH);
  expect(layout.bars[0].expense?.over).toBe(true);
  // Preso acima da barra mais alta, nunca fora do gráfico.
  expect(layout.bars[0].expense!.y).toBeLessThan(layout.bars[1].topY);
  expect(layout.bars[0].expense!.y).toBeGreaterThan(0);
});

test('os escalões do eixo são redondos e nunca mais de cinco', () => {
  expect(revenueTicks(80_000)).toEqual([20_000, 40_000, 60_000, 80_000]);
  expect(revenueTicks(300_000)).toEqual([100_000, 200_000, 300_000]);
  expect(revenueTicks(7_300)).toEqual([2_000, 4_000, 6_000]);
  expect(revenueTicks(0)).toEqual([]);
  for (const max of [1, 9, 999, 12_345, 99_999, 1_000_000]) expect(revenueTicks(max, max * 1.12).length).toBeLessThanOrEqual(5);

  // Um máximo logo abaixo do escalão ainda mostra a linha de cima: cabe na folga da escala.
  const host = mount([point(1, { paidCve: 79_500 })]);
  expect([...host.querySelectorAll('.bar-tick')].map((node) => node.textContent)).toEqual(['20.000', '40.000', '60.000', '80.000']);
});

test('sem receita nenhuma, os custos ficam com a escala e nada rebenta', () => {
  const layout = revenueLayout([point(1, { opexCve: 5_000 }), point(2, { expenseCve: 20_000 })], 800);

  expect(layout.bars[1].expense?.over).toBe(false);
  expect(layout.bars[0].opex!.y).toBeGreaterThan(layout.bars[1].expense!.y);
});

test('escreve o valor de cada mês com receita e o custo que passa do topo', () => {
  const host = mount([
    point(1, { paidCve: 3_000, expenseCve: 250_000 }),
    point(2, { paidCve: 60_000, pendingCve: 10_000, opexCve: 4_000 }),
    point(3)
  ]);

  const values = [...host.querySelectorAll('.bar-value')].map((node) => node.textContent);
  expect(values).toHaveLength(3);
  expect(values.filter((text) => text?.startsWith('↑'))).toHaveLength(1);
  expect(host.querySelectorAll('.bar-mark-expense')).toHaveLength(1);
  expect(host.querySelectorAll('.bar-mark-opex')).toHaveLength(1);
  expect(host.querySelector('.sparkline-legend')?.textContent).toBe('PagoPendenteInvestimentosDespesas');
  expect(host.querySelector('svg')?.getAttribute('preserveAspectRatio')).toBeNull();
});

test('cada mês abre os pagamentos com o rato e com o teclado', () => {
  const onSelectMonth = vi.fn();
  const host = mount([point(1, { paidCve: 3_000 }), point(2, { paidCve: 60_000 })], onSelectMonth);
  const months = host.querySelectorAll<SVGGElement>('.bar[role="button"]');

  expect(months).toHaveLength(2);
  expect(months[1].getAttribute('tabindex')).toBe('0');
  act(() => months[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  act(() => months[0].dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(onSelectMonth.mock.calls).toEqual([['2026-02'], ['2026-01']]);

  act(() => months[1].dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
  expect(host.querySelector('.bar-tooltip')?.textContent).toContain('fevereiro');
});

test('sem movimentos mostra o estado vazio em vez de um gráfico em branco', () => {
  const host = mount([point(1), point(2)]);

  expect(host.querySelector('svg')).toBeNull();
  expect(host.textContent).toBe('Sem registos de receita em 2026.');
});
