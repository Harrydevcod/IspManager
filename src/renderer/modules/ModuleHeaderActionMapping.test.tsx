/** @vitest-environment jsdom */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import { ClientsModule } from './ClientsModule';
import { PaymentsModule } from './PaymentsModule';
import { ServicesModule } from './ServicesModule';

type HeaderCase = {
  name: string;
  render: () => ReactElement;
  ariaLabel: string;
  actions: Array<{ label: string; variant: 'primary' | 'secondary' | 'critical' }>;
};

const headerCases: HeaderCase[] = [
  {
    name: 'Clientes',
    render: () => <ClientsModule />,
    ariaLabel: 'Ações de clientes',
    actions: [
      { label: 'Importar', variant: 'secondary' },
      { label: 'Novo cliente', variant: 'primary' }
    ]
  },
  {
    name: 'Serviços',
    render: () => <ServicesModule />,
    ariaLabel: 'Ações de serviços',
    actions: [
      { label: 'Atribuir IPs', variant: 'secondary' },
      { label: 'Novo servico', variant: 'primary' }
    ]
  },
  {
    name: 'Pagamentos',
    render: () => <PaymentsModule />,
    ariaLabel: 'Ações de pagamentos',
    actions: [
      { label: 'Notificar atrasados', variant: 'secondary' },
      { label: 'Avisar suspensao', variant: 'secondary' },
      { label: 'Reverter mensalidades', variant: 'critical' },
      { label: 'Gerar mensalidades', variant: 'primary' }
    ]
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

function action(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!button) throw new Error(`Action not found: ${label}`);
  return button;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) {
      return jsonResponse({ setupRequired: false, authBypassed: true });
    }
    if (url.endsWith('/api/audiovisual-config')) return jsonResponse(null);
    if (url.endsWith('/api/settings')) return jsonResponse({});
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

describe.each(headerCases)('$name module header actions', ({ render, ariaLabel, actions }) => {
  test('maps every command to the approved semantic variant', async () => {
    const container = await mount(render());

    for (const { label, variant } of actions) {
      expect(action(container, label).classList.contains(`btn-${variant}`)).toBe(true);
    }
  });

  test('exposes one named group with no more than one primary command', async () => {
    const container = await mount(render());
    const commandGroup = container.querySelector(
      `[role="group"][aria-label="${ariaLabel}"]`
    );

    if (!(commandGroup instanceof HTMLElement)) {
      throw new Error(`Command group not found: ${ariaLabel}`);
    }
    expect(commandGroup.querySelectorAll('.btn-primary')).toHaveLength(1);
  });
});

test('keeps the payment month context outside the command group', async () => {
  const container = await mount(<PaymentsModule />);
  const monthInput = container.querySelector('input[type="month"]');
  const commandGroup = container.querySelector(
    '[role="group"][aria-label="Ações de pagamentos"]'
  );

  if (!(monthInput instanceof HTMLInputElement) || !(commandGroup instanceof HTMLElement)) {
    throw new Error('Payment header context or command group not found');
  }
  expect(commandGroup.contains(monthInput)).toBe(false);
});
