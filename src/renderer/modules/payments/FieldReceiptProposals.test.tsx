/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth';
import { FieldReceiptProposals, type ReceiptProposal } from './FieldReceiptProposals';

/**
 * O recebimento do terreno só vira recibo com uma conta: sem ela, uma
 * transferência era recusada pelo servidor e a proposta ficava pendente para
 * sempre. O que o terreno indicou aparece escolhido, e quem confirma manda.
 */

afterEach(() => { vi.unstubAllGlobals(); });

const ACCOUNTS = [
  { id: 1, kind: 'caixa', name: 'Caixa loja', isDefaultCash: true, active: true },
  { id: 3, kind: 'banco', name: 'BCA', isDefaultCash: false, active: true }
];

const base: ReceiptProposal = {
  id: 'evt-1', occurredAt: '2026-11-05T09:15:00.000Z', clientId: 1, clientCode: 'C1', clientName: 'Ana Lopes',
  amountCve: 2500, method: 'numerario', note: null, accountId: null,
  target: { paymentId: 7, dueDate: '2026-10-10', balanceCve: 2500 }
};

async function render(proposals: ReceiptProposal[], accounts = ACCOUNTS) {
  const confirms: Array<Record<string, unknown>> = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) return Response.json({ setupRequired: false, authBypassed: true });
    if (url.endsWith('/api/treasury/accounts')) return Response.json(accounts);
    if (url.includes('/receipt-proposals/') && url.endsWith('/confirm')) {
      confirms.push(JSON.parse(String(init?.body ?? '{}')));
      return Response.json({ ok: true });
    }
    if (url.endsWith('/api/companion/receipt-proposals')) return Response.json(proposals);
    return Response.json([]);
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<AuthProvider><FieldReceiptProposals onConfirmed={() => {}} /></AuthProvider>); });
  const confirm = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Confirmar'));
  return { container, root, confirms, confirm };
}

test('o numerário vai para a caixa predefinida sem ninguém escolher nada', async () => {
  const { root, confirms, confirm } = await render([base]);
  try {
    expect(confirm()?.disabled).toBe(false);
    await act(async () => { confirm()!.click(); });
    expect(confirms).toEqual([{ accountId: 1 }]);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('a transferência leva o banco que o terreno indicou', async () => {
  const { root, confirms } = await render([{ ...base, method: 'transferencia', accountId: 3 }]);
  try {
    const select = document.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('3');
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Confirmar'));
    await act(async () => { confirm!.click(); });
    expect(confirms).toEqual([{ accountId: 3 }]);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('sem nenhum banco, a transferência não se confirma: o botão não deixa, em vez de o servidor recusar', async () => {
  const semBancos = ACCOUNTS.filter((a) => a.kind !== 'banco');
  const { root, container, confirm } = await render([{ ...base, method: 'transferencia' }], semBancos);
  try {
    expect(confirm()?.disabled).toBe(true);
    expect(container.textContent).toContain('Não há contas bancárias ativas');
  } finally {
    await act(async () => { root.unmount(); });
  }
});
