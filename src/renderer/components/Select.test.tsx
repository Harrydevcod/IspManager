import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Select } from './Select';

// O estilo base vivia só no `.field` do rótulo: um Select só com aria-label (um filtro numa
// barra) saía com a borda branca e o fundo do browser.
test('sem rótulo, o select leva a classe do estilo base', () => {
  const html = renderToStaticMarkup(<Select aria-label="Filtrar por estado"><option>Todos</option></Select>);
  expect(html).toMatch(/^<select[^>]*class="select-control"/);
});

test('com rótulo, a classe vai no select e a do chamador fica no rótulo', () => {
  const html = renderToStaticMarkup(<Select label="Estado" className="extra"><option>Todos</option></Select>);
  expect(html).toContain('class="field extra"');
  expect(html).toMatch(/<select[^>]*class="select-control"/);
});

test('sem rótulo, a classe do chamador junta-se à do estilo base', () => {
  const html = renderToStaticMarkup(<Select aria-label="Zona" className="compact"><option>Todas</option></Select>);
  expect(html).toMatch(/<select[^>]*class="select-control compact"/);
});
