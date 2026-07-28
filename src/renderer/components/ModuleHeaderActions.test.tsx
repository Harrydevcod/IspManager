import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Button } from './Button';
import { ModuleHeaderActions } from './ModuleHeaderActions';

describe('ModuleHeaderActions', () => {
  test('keeps context outside the named command group and preserves semantic order', () => {
    const html = renderToStaticMarkup(
      <ModuleHeaderActions
        ariaLabel="Ações de pagamentos"
        context={<label>Mês<input type="month" /></label>}
        secondary={<Button variant="secondary">Notificar</Button>}
        critical={<Button variant="critical">Reverter</Button>}
        primary={<Button>Gerar</Button>}
      />
    );

    expect(html).toContain('module-header-context');
    expect(html.indexOf('module-header-context')).toBeLessThan(html.indexOf('role="group"'));
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Ações de pagamentos"');
    expect(html.indexOf('Notificar')).toBeLessThan(html.indexOf('Reverter'));
    expect(html.indexOf('Reverter')).toBeLessThan(html.indexOf('Gerar'));
  });

  test('omits empty regions instead of emitting decorative wrappers', () => {
    const html = renderToStaticMarkup(
      <ModuleHeaderActions primary={<Button>Novo plano</Button>} />
    );

    expect(html).not.toContain('module-header-context');
    expect(html).not.toContain('module-header-actions-critical');
    expect(html).toContain('Novo plano');
  });
});
