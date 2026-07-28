import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  test('renders the restrained critical variant explicitly', () => {
    const html = renderToStaticMarkup(<Button variant="critical">Reverter</Button>);

    expect(html).toContain('btn btn-critical');
    expect(html).not.toContain('btn-danger');
  });

  test('keeps loading state native, accessible and dimensionally stable', () => {
    const html = renderToStaticMarkup(<Button loading>Guardar</Button>);

    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('btn-loading');
    expect(html).toContain('btn-content');
    expect(html).toContain('btn-spinner');
    expect(html).toContain('Guardar');
  });

  test('keeps the default header-compatible size free of a size modifier', () => {
    const html = renderToStaticMarkup(<Button>Novo cliente</Button>);

    expect(html).toContain('class="btn btn-primary"');
    expect(html).not.toContain('btn-sm');
  });
});
