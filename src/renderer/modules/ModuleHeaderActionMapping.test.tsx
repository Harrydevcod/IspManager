/** @vitest-environment jsdom */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import { AuditModule } from './AuditModule';
import { ClientsModule } from './ClientsModule';
import { ExpensesModule } from './ExpensesModule';
import { InvestmentsModule } from './InvestmentsModule';
import { PaymentsModule } from './PaymentsModule';
import { PlansModule } from './PlansModule';
import { ProfitModule } from './ProfitModule';
import { ReportsModule } from './ReportsModule';
import { ServicesModule } from './ServicesModule';
import { StockModule } from './StockModule';
import { UsersModule } from './UsersModule';
import { WorkOrdersModule } from './WorkOrdersModule';

type HeaderCase = {
  name: string;
  render: () => ReactElement;
  ariaLabel: string;
  primaryCount: 0 | 1;
  actions: Array<{ label: string; variant: 'primary' | 'secondary' | 'critical' }>;
};

const headerCases: HeaderCase[] = [
  {
    name: 'Clientes',
    render: () => <ClientsModule />,
    ariaLabel: 'Ações de clientes',
    primaryCount: 1,
    actions: [
      { label: 'Importar', variant: 'secondary' },
      { label: 'Novo cliente', variant: 'primary' }
    ]
  },
  {
    name: 'Serviços',
    render: () => <ServicesModule />,
    ariaLabel: 'Ações de serviços',
    primaryCount: 1,
    actions: [
      { label: 'Atribuir IPs', variant: 'secondary' },
      { label: 'Novo servico', variant: 'primary' }
    ]
  },
  {
    name: 'Pagamentos',
    render: () => <PaymentsModule />,
    ariaLabel: 'Ações de pagamentos',
    primaryCount: 1,
    actions: [
      { label: 'Notificar atrasados', variant: 'secondary' },
      { label: 'Avisar suspensao', variant: 'secondary' },
      { label: 'Reverter mensalidades', variant: 'critical' },
      { label: 'Gerar mensalidades', variant: 'primary' }
    ]
  },
  {
    name: 'Planos',
    render: () => <PlansModule />,
    ariaLabel: 'Ações de planos',
    primaryCount: 1,
    actions: [{ label: 'Novo plano', variant: 'primary' }]
  },
  {
    name: 'Utilizadores',
    render: () => <UsersModule />,
    ariaLabel: 'Ações de utilizadores',
    primaryCount: 1,
    actions: [{ label: 'Novo utilizador', variant: 'primary' }]
  },
  {
    name: 'Ordens de serviço',
    render: () => <WorkOrdersModule />,
    ariaLabel: 'Ações de ordens de serviço',
    primaryCount: 1,
    actions: [{ label: 'Nova OS', variant: 'primary' }]
  },
  {
    name: 'Stock',
    render: () => <StockModule />,
    ariaLabel: 'Ações de stock',
    primaryCount: 1,
    actions: [{ label: 'Novo equipamento', variant: 'primary' }]
  },
  {
    name: 'Despesas',
    render: () => <ExpensesModule />,
    ariaLabel: 'Ações de despesas',
    primaryCount: 1,
    actions: [
      { label: 'Recorrentes', variant: 'secondary' },
      { label: 'Nova despesa', variant: 'primary' }
    ]
  },
  {
    name: 'Investimentos',
    render: () => <InvestmentsModule />,
    ariaLabel: 'Ações de investimentos',
    primaryCount: 1,
    actions: [{ label: 'Novo investimento', variant: 'primary' }]
  },
  {
    name: 'Auditoria',
    render: () => <AuditModule />,
    ariaLabel: 'Ações de auditoria',
    primaryCount: 0,
    actions: [{ label: 'Atualizar', variant: 'secondary' }]
  },
  {
    name: 'Relatórios',
    render: () => <ReportsModule />,
    ariaLabel: 'Ações de relatórios',
    primaryCount: 0,
    actions: [{ label: 'Exportar CSV', variant: 'secondary' }]
  },
  {
    name: 'Lucro',
    render: () => <ProfitModule />,
    ariaLabel: 'Ações de lucro',
    primaryCount: 0,
    actions: [
      { label: 'PDF', variant: 'secondary' },
      { label: 'Excel', variant: 'secondary' }
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
    return new Promise<Response>(() => {});
  }));
});

afterEach(async () => {
  await act(async () => {
    while (roots.length > 0) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe.each(headerCases)('$name module header actions', ({ render, ariaLabel, primaryCount, actions }) => {
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
    expect(commandGroup.querySelectorAll('.btn-primary')).toHaveLength(primaryCount);
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
