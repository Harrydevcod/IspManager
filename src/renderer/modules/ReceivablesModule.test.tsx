/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import { ReceivablesModule } from './ReceivablesModule';
import type { ReceivablesReport } from '../types';

/**
 * A vista de cobranca mostra o SALDO, nao o valor da fatura. E a unica coisa
 * que este ecra tem mesmo de acertar: quem ja entregou 40.000 de 50.000 deve
 * 10.000, e ligar-lhe a pedir 50.000 e o defeito que se esta a evitar.
 */
const report: ReceivablesReport = {
  generatedAt: '2026-08-29T00:00:00.000Z',
  totals: { openCve: 52500, overdueCve: 50000, notDueCve: 2500, clients: 2, invoices: 3, creditCve: 1500 },
  aging: {
    current: { invoices: 1, amountCve: 2500 },
    d30: { invoices: 0, amountCve: 0 },
    d60: { invoices: 0, amountCve: 0 },
    d90: { invoices: 1, amountCve: 10000 },
    d90plus: { invoices: 1, amountCve: 40000 }
  },
  clients: [
    {
      clientId: 1,
      clientName: 'Jaqueline Restaurante',
      clientCode: 'C0012',
      phone: '9911111',
      zone: 'Achada',
      clientStatus: 'active',
      invoices: 2,
      openCve: 42500,
      overdueCve: 40000,
      creditCve: 0,
      oldestDueDate: '2026-04-10',
      maxDaysOverdue: 141,
      bucket: 'd90plus'
    },
    {
      clientId: 2,
      clientName: 'Antonio Silva',
      clientCode: 'C0031',
      phone: null,
      zone: null,
      clientStatus: 'active',
      invoices: 1,
      openCve: 10000,
      overdueCve: 10000,
      creditCve: 1500,
      oldestDueDate: '2026-06-10',
      maxDaysOverdue: 80,
      bucket: 'd90'
    }
  ]
};

const roots: Root[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function mount(onOpenClient?: (id: number) => void): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <ReceivablesModule onOpenClient={onOpenClient} />
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    );
  });

  return container;
}

const metricValues = (container: HTMLElement) =>
  [...container.querySelectorAll('.metric-card strong')].map((n) => n.textContent?.trim() || '');

const rowNames = (container: HTMLElement) =>
  [...container.querySelectorAll('.data-table-cell strong')].map((n) => n.textContent?.trim() || '');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) return jsonResponse({ setupRequired: false, authBypassed: true });
    if (url.endsWith('/api/receivables')) return jsonResponse(report);
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

describe('Pendentes', () => {
  test('mostra em aberto, vencido, clientes e credito em circulacao', async () => {
    const container = await mount();
    expect(metricValues(container)).toEqual(['52.500$00', '50.000$00', '2', '1.500$00']);
  });

  test('lista os devedores com o saldo, nao o valor da fatura', async () => {
    const container = await mount();
    expect(rowNames(container)).toEqual(['Jaqueline Restaurante', 'Antonio Silva']);
    expect(container.textContent).toContain('42.500$00');
    expect(container.textContent).toContain('Mais de 90 dias');
  });

  test('o credito do cliente aparece na linha dele', async () => {
    const container = await mount();
    expect(container.textContent).toContain('crédito 1.500$00');
  });

  test('filtrar por antiguidade reduz a lista', async () => {
    const container = await mount();
    const button = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('61-90 dias'));
    if (!button) throw new Error('filtro 61-90 nao encontrado');

    await act(async () => { button.click(); });

    expect(rowNames(container)).toEqual(['Antonio Silva']);
  });

  test('clicar numa linha abre a ficha do cliente', async () => {
    const onOpenClient = vi.fn();
    const container = await mount(onOpenClient);
    const row = container.querySelector('.data-table-row') as HTMLElement | null;
    if (!row) throw new Error('linha nao encontrada');

    await act(async () => { row.click(); });

    expect(onOpenClient).toHaveBeenCalledWith(1);
  });
});
