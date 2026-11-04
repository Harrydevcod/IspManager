import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { TemplateField } from './TemplateField';

const render = (value: string) => renderToStaticMarkup(
  <TemplateField field="whatsappOverdueTemplate" label="Fatura em atraso" value={value} recommended="Caro cliente," onUpdate={() => undefined} />
);

test('um modelo personalizado oferece o texto recomendado; o recomendado não', () => {
  expect(render('Ola {nome}')).toContain('Usar texto recomendado');
  expect(render('Caro cliente,')).not.toContain('Usar texto recomendado');
});
