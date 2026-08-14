/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import { defaultPostpaidReferenceMonth } from '../../shared/billing-period';
import { PaymentsModule } from './PaymentsModule';
import type { PaymentRow } from '../types';

const referenceMonth = defaultPostpaidReferenceMonth();

function isoInDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function row(id: number, status: PaymentRow['status'], amountCve: number, dueDate: string): PaymentRow {
  return {
    id,
    clientName: `Cliente ${id}`,
    clientCode: `C00${id}`,
    clientNif: null,
    clientPhone: null,
    referenceMonth,
    amountCve,
    dueDate,
    paymentDate: status === 'paid' ? dueDate : null,
    paymentMethod: null,
    status,
    invoiceNumber: null,
    receiptNumber: null,
    canRegenerate: 0
  };
}

// O vencido é um 'pending' com a data passada — o estado 'overdue' na coluna só
// existe quando alguém marca à mão, e é isso que estes testes protegem.
const payments: PaymentRow[] = [
  row(1, 'pending', 1000, isoInDays(15)),
  row(2, 'paid', 2000, isoInDays(-20)),
  row(3, 'pending', 3000, isoInDays(-15))
];

const roots: Root[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function mount(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <PaymentsModule />
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    );
  });

  return container;
}

/** Os três valores dos chips, na ordem Pendente / Atraso / Pago. */
function chipAmounts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.payments-total-chip strong')].map(
    (node) => node.textContent?.trim() || ''
  );
}

function statusSelect(container: HTMLElement): HTMLSelectElement {
  const select = [...container.querySelectorAll('select')].find(
    (candidate) => candidate.closest('label')?.querySelector('.field-label')?.textContent === 'Estado'
  );
  if (!select) throw new Error('Estado select not found');
  return select;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) {
      return jsonResponse({ setupRequired: false, authBypassed: true });
    }
    if (url.endsWith('/api/payments')) {
      return jsonResponse(payments);
    }
    if (url.endsWith('/api/settings') || url.endsWith('/api/audiovisual-config')) {
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

describe('totais de pagamentos', () => {
  test('mostra as tres parcelas com o filtro no estado por omissao', async () => {
    const container = await mount();
    expect(statusSelect(container).value).toBe('pending');
    expect(chipAmounts(container)).toEqual(['1.000$00', '3.000$00', '2.000$00']);
  });

  test('o pendente com a data passada conta como atraso, e o filtro devolve-o', async () => {
    const container = await mount();
    const select = statusSelect(container);

    await act(async () => {
      select.value = 'overdue';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Antes: o chip Atraso e a lista ficavam sempre vazios, porque nenhuma
    // linha chega com status = 'overdue'.
    expect(chipAmounts(container)[1]).toBe('3.000$00');
    expect(container.querySelectorAll('.data-table-row')).toHaveLength(1);
  });

  test('nao mexe nos totais quando o estado muda, so na lista', async () => {
    const container = await mount();
    const before = chipAmounts(container);
    const select = statusSelect(container);

    await act(async () => {
      select.value = 'paid';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(select.value).toBe('paid');
    expect(chipAmounts(container)).toEqual(before);
    expect(container.querySelectorAll('.data-table-row')).toHaveLength(1);
  });
});
