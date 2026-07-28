/** @vitest-environment jsdom */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import { ClientsModule } from './ClientsModule';
import { PaymentsModule } from './PaymentsModule';
import { ServicesModule } from './ServicesModule';

type ModuleCase = {
  name: string;
  render: () => ReactElement;
  defaultStatus: string;
  statuses: string[];
};

const modules: ModuleCase[] = [
  {
    name: 'Clientes',
    render: () => <ClientsModule />,
    defaultStatus: 'active',
    statuses: ['all', 'active', 'suspended', 'cancelled']
  },
  {
    name: 'Serviços',
    render: () => <ServicesModule />,
    defaultStatus: 'active',
    statuses: ['all', 'active', 'suspended', 'cancelled']
  },
  {
    name: 'Pagamentos',
    render: () => <PaymentsModule />,
    defaultStatus: 'pending',
    statuses: ['all', 'pending', 'overdue', 'paid', 'cancelled']
  }
];

const roots: Root[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function mount(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>{element}</ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    );
  });

  return container;
}

function statusSelect(container: HTMLElement): HTMLSelectElement {
  const select = [...container.querySelectorAll('select')].find(
    (candidate) => candidate.closest('label')?.querySelector('.field-label')?.textContent === 'Estado'
  );
  if (!select) throw new Error('Estado select not found');
  return select;
}

function clearFiltersButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === 'Limpar filtros'
  );
  if (!button) throw new Error('Limpar filtros button not found');
  return button;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) {
      return jsonResponse({ setupRequired: false, authBypassed: true });
    }
    if (url.endsWith('/api/audiovisual-config')) {
      return jsonResponse(null);
    }
    return jsonResponse([]);
  }));
});

afterEach(async () => {
  await act(async () => {
    while (roots.length > 0) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe.each(modules)('$name operational status filter', ({ render, defaultStatus, statuses }) => {
  test(`opens with ${defaultStatus} selected`, async () => {
    const select = statusSelect(await mount(render()));
    expect(select.value).toBe(defaultStatus);
  });

  test('keeps every status manually available', async () => {
    const select = statusSelect(await mount(render()));
    expect([...select.options].map((option) => option.value)).toEqual(statuses);
  });

  test(`restores ${defaultStatus} when filters are cleared`, async () => {
    const container = await mount(render());
    const select = statusSelect(container);

    await act(async () => {
      select.value = 'all';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('all');

    await act(async () => {
      clearFiltersButton(container).click();
    });
    expect(select.value).toBe(defaultStatus);
  });
});

test('an explicit payment focus overrides the pending default', async () => {
  const select = statusSelect(await mount(<PaymentsModule focusStatus="overdue" />));
  expect(select.value).toBe('overdue');
});
