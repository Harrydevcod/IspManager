import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { OperationModeSelect } from './OperationModeSelect';

const render = (props: Parameters<typeof OperationModeSelect>[0]) =>
  renderToStaticMarkup(<OperationModeSelect {...props} />);

describe('OperationModeSelect', () => {
  test('a CPE recebe os modos dela, com o Cliente à cabeça', () => {
    const html = render({ catalogType: 'cpe', value: '', onChange: () => {} });

    expect(html).toContain('Cliente (Client / Station)');
    expect(html).toContain('WISP (Cliente + Router/NAT)');
    // Os sete: o firmware da CPE também tem Router e Mesh.
    expect(html).toContain('>Router<');
    expect(html).toContain('>Mesh<');
    expect(html.indexOf('Cliente (Client')).toBeLessThan(html.indexOf('>Router<'));
  });

  test('o resto do equipamento não recebe os modos de quem capta rádio', () => {
    const html = render({ catalogType: 'router', value: '', onChange: () => {} });

    expect(html).toContain('>Router<');
    expect(html).not.toContain('Cliente (Client / Station)');
    expect(html).not.toContain('WISP');
  });

  /**
   * O caso que se perderia em silêncio: um `cliente` gravado num router não é
   * oferecido a routers, mas continua a ser um modo — aparece rotulado e o
   * campo não pode abrir em modo texto-livre, senão a primeira gravação
   * transformava o valor numa etiqueta escrita à mão.
   */
  test('um modo gravado fora da lista do tipo continua listado e rotulado', () => {
    const html = render({ catalogType: 'router', value: 'cliente', onChange: () => {} });

    expect(html).toContain('Cliente (Client / Station)');
    expect(html).toContain('<select');
    expect(html).not.toContain('mode-select-free');
  });

  /** Uma etiqueta escrita à mão continua a abrir o campo livre, como sempre. */
  test('uma etiqueta escrita à mão abre o campo livre', () => {
    const html = render({ catalogType: 'cpe', value: 'AP Router', onChange: () => {} });

    expect(html).toContain('mode-select-free');
    expect(html).toContain('ex.: AP Router');
  });

  /** Sem artigo escolhido ainda, vale o conjunto do resto. */
  test('sem tipo, oferece o conjunto do resto', () => {
    const html = render({ value: '', onChange: () => {} });

    expect(html).toContain('>Router<');
    expect(html).not.toContain('WISP');
  });
});
