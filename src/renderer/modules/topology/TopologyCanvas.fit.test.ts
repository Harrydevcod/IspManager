/** @vitest-environment jsdom */
import { expect, test } from 'vitest';
import { fitPadding } from './TopologyCanvas';

const box = (top: number, bottom: number) => () => ({ top, bottom } as DOMRect);

test('o enquadramento reserva no fundo a altura da legenda ou do mini-mapa, o que for mais alto', () => {
  const section = document.createElement('section');
  section.getBoundingClientRect = box(338, 831);
  const legend = Object.assign(document.createElement('div'), { className: 'topology-legend' });
  legend.getBoundingClientRect = box(709, 815);
  const minimap = Object.assign(document.createElement('div'), { className: 'topology-minimap' });
  minimap.getBoundingClientRect = box(696, 816);
  section.append(legend, minimap);

  // 831 - 696 = 135px tapados, mais 12 de folga.
  expect(fitPadding(section, 0.2)).toEqual({ x: 0.2, top: 0.2, bottom: '147px' });
});

test('sem nada pousado no fundo fica a margem de sempre', () => {
  const section = document.createElement('section');
  expect(fitPadding(section, 0.18)).toBe(0.18);
  expect(fitPadding(null, 0.18)).toBe(0.18);
});
