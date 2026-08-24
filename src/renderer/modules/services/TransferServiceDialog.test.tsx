/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TransferServiceDialog } from './TransferServiceDialog';
import { authFetch } from '../../lib/auth';
import type { Client, ServiceRow } from '../../types';

vi.mock('../../lib/auth', () => ({ authFetch: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(authFetch).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const client: Client = {
  id: 7,
  clientCode: 'CLT-007',
  fullName: 'Bruno Tavares',
  phone: '9911223',
  island: 'Santiago',
  zone: 'Praia',
  status: 'cancelled'
};

const service = {
  id: 42,
  clientId: 3,
  clientName: 'Ana Silva',
  planId: 1,
  planName: 'Base 10M',
  monthlyValueCve: 2500,
  dueDay: 10,
  status: 'cancelled',
  activationDate: '2025-01-10',
  technicalNotes: null,
  audiovisualMode: 'none',
  audiovisualMonthlyCve: 0,
  audiovisualAnnualCve: 0,
  deviceIps: '10.0.0.10',
  pppoeUsername: null,
  pppoePassword: null,
  routerOnline: null,
  routerEnabled: null,
  routerDivergence: null
} as ServiceRow;

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button'))
    .find((node) => node.textContent?.trim() === label);
  if (!found) throw new Error(`Botao "${label}" nao encontrado`);
  return found as HTMLButtonElement;
}

/** A opção do Combobox é uma linha que reage ao mousedown, não um botão. */
function pickOption(label: string) {
  const found = Array.from(document.body.querySelectorAll('[role="option"]'))
    .find((node) => node.textContent?.includes(label));
  if (!found) throw new Error(`Opcao "${label}" nao encontrada`);
  found.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
}

describe('TransferServiceDialog', () => {
  test('envia o titular, o modo e o motivo escolhidos', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse([client]))
      .mockResolvedValueOnce(jsonResponse({ serviceId: 42, toClient: { id: 7, name: 'Bruno Tavares' }, warnings: [] }));
    const onDone = vi.fn();

    await act(async () => {
      root.render(<TransferServiceDialog service={service} onClose={() => {}} onDone={onDone} />);
    });

    // Escolher o novo titular na combobox.
    await act(async () => { button('Selecionar cliente...').click(); });
    await act(async () => { pickOption('Bruno Tavares'); });

    const mode = document.body.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      mode.value = 'reinstalar';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => { button('Transferir').click(); });

    const call = vi.mocked(authFetch).mock.calls.at(-1);
    expect(call?.[0]).toBe('http://127.0.0.1:3001/api/services/42/transfer');
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
      toClientId: 7,
      mode: 'reinstalar',
      reactivateService: true,
      reason: null
    });
    expect(onDone).toHaveBeenCalled();
  });

  test('mostra o erro do servidor sem fechar', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse([client]))
      .mockResolvedValueOnce(jsonResponse({ error: 'Equipamento partilhado' }, false));
    const onDone = vi.fn();

    await act(async () => {
      root.render(<TransferServiceDialog service={service} onClose={() => {}} onDone={onDone} />);
    });
    await act(async () => { button('Selecionar cliente...').click(); });
    await act(async () => { pickOption('Bruno Tavares'); });
    await act(async () => { button('Transferir').click(); });

    expect(document.body.textContent).toContain('Equipamento partilhado');
    expect(onDone).not.toHaveBeenCalled();
  });
});
