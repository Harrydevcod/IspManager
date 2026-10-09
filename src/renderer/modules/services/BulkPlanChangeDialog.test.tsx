/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PlanRow } from '../../types';
import { BulkPlanChangeDialog } from './BulkPlanChangeDialog';
import { batchVerdict, nextOccurrence, type PlanChangeBatch, type PlanChangePreview } from './plan-change-api';

const authFetch = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth', () => ({ authFetch }));

let root: Root;
const onClose = vi.fn();
const onDone = vi.fn();

const plans = [
  { id: 1, name: 'Base 10', monthlyPriceCve: 2500, active: true },
  { id: 2, name: 'Mais 20', monthlyPriceCve: 3500, active: true },
  { id: 3, name: 'Antigo', monthlyPriceCve: 1500, active: false }
] as unknown as PlanRow[];

function preview(overrides: Partial<PlanChangePreview> = {}): PlanChangePreview {
  return {
    targetPlan: { id: 2, name: 'Mais 20', monthlyPriceCve: 3500, routerProfile: 'plano-20M' },
    rows: [{
      serviceId: 1, clientName: 'Joao Silva', clientCode: 'C0001', status: 'active', login: 'skn001', fromPlanName: 'Base 10',
      fromValueCve: 2500, toValueCve: 3500, rentalCve: 250, fromProfile: 'plano-10M', toProfile: 'plano-20M',
      online: true, routerChange: true, outcome: 'change'
    }],
    groups: [{ planName: 'Base 10', count: 1 }],
    toChange: 1, sessionsOnline: 1, blockers: [], dryRun: false, ...overrides
  };
}

function batch(overrides: Partial<PlanChangeBatch> = {}): PlanChangeBatch {
  return {
    id: 9, targetPlanName: 'Mais 20', reason: null, updatePrice: 1, dropMode: 'none', dropAt: null, dropStatus: null, dryRun: 0,
    status: 'done', stopReason: null, createdByName: 'ana', createdAt: '2026-10-09 09:00:00', finishedAt: '2026-10-09 09:00:05',
    counts: { queued: 0, pending: 0, applied: 1, unchanged: 0, failed: 1, not_processed: 0 },
    items: [
      { id: 1, serviceId: 1, clientName: 'Joao Silva', login: 'skn001', fromPlanName: 'Base 10', fromValueCve: 2500, toValueCve: 3500, status: 'applied', note: null, error: null, sessionDroppedAt: null, processedAt: null },
      { id: 2, serviceId: 2, clientName: 'Ana Lopes', login: 'skn002', fromPlanName: 'Base 10', fromValueCve: 2500, toValueCve: 3500, status: 'failed', note: null, error: 'input does not match any value of profile', sessionDroppedAt: null, processedAt: null }
    ],
    ...overrides
  };
}

const json = (body: unknown, ok = true) => ({ ok, json: async () => body });
const buttonNamed = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(text))!;
const click = (element: Element) => act(async () => { (element as HTMLElement).click(); });
const selectByLabel = (label: string) => [...document.querySelectorAll('select')]
  .find((item) => document.querySelector(`label[for="${item.id}"]`)?.textContent?.includes(label))!;

async function choose(label: string, value: string) {
  const select = selectByLabel(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const bodyOf = (call: number) => JSON.parse(authFetch.mock.calls[call][1].body);
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  authFetch.mockReset();
  onClose.mockReset();
  onDone.mockReset();
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<BulkPlanChangeDialog serviceIds={[1, 2]} plans={plans} onClose={onClose} onDone={onDone} />);
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('só oferece planos ativos e não avança sem destino', () => {
  expect([...selectByLabel('Plano de destino').options].map((option) => option.textContent))
    .toEqual(['Escolher…', 'Base 10 · 2.500$00', 'Mais 20 · 3.500$00']);
  expect(buttonNamed('Pré-visualizar').disabled).toBe(true);
});

test('por omissão não derruba ninguém, e nada é executado sem a pré-visualização', async () => {
  authFetch.mockResolvedValueOnce(json(preview())).mockResolvedValueOnce(json({ batchId: 9 })).mockResolvedValue(json(batch()));
  expect(selectByLabel('Sessões ativas').value).toBe('none');

  await choose('Plano de destino', '2');
  await click(buttonNamed('Pré-visualizar'));

  expect(authFetch).toHaveBeenCalledTimes(1);
  expect(authFetch.mock.calls[0][0]).toMatch(/bulk-change\/preview$/);
  expect(bodyOf(0)).toEqual({ serviceIds: [1, 2], targetPlanId: 2, updatePrice: true });
  // Antes → depois, com a renda: 2.750$00 → 3.750$00.
  expect(document.body.textContent).toContain('2.750$00');
  expect(document.body.textContent).toContain('3.750$00');
  expect(document.body.textContent).toContain('ninguém é derrubado');

  await click(buttonNamed('Mudar 1 cliente de plano'));
  expect(authFetch.mock.calls[1][0]).toMatch(/bulk-change$/);
  expect(bodyOf(1)).toMatchObject({ dropMode: 'none', dropAt: null, reason: null });
});

test('um bloqueio impede a execução e fica à vista', async () => {
  authFetch.mockResolvedValueOnce(json(preview({ blockers: ['O perfil plano-20M do plano Mais 20 não existe no router.'] })));
  await choose('Plano de destino', '2');
  await click(buttonNamed('Pré-visualizar'));
  expect(document.body.textContent).toContain('não existe no router');
  expect(buttonNamed('Mudar 1 cliente de plano').disabled).toBe(true);
});

test('derrubar agora avisa, antes de executar, quantas sessões caem', async () => {
  authFetch.mockResolvedValueOnce(json(preview()));
  await choose('Plano de destino', '2');
  await choose('Sessões ativas', 'now');
  await click(buttonNamed('Pré-visualizar'));
  expect(document.body.textContent).toContain('1 cliente está ligado e a sessão vai ser derrubada agora');
});

test('o resumo final mostra falhas e nunca dá por concluído o que falhou', async () => {
  authFetch.mockResolvedValueOnce(json(preview())).mockResolvedValueOnce(json({ batchId: 9 })).mockResolvedValue(json(batch()));
  await choose('Plano de destino', '2');
  await click(buttonNamed('Pré-visualizar'));
  await click(buttonNamed('Mudar 1 cliente de plano'));
  await settle();

  expect(document.body.textContent).toContain('Concluído com falhas');
  expect(document.body.textContent).toContain('input does not match any value of profile');
  await click(buttonNamed('Fechar'));
  expect(onDone).toHaveBeenCalled();
});

test('a meio pode cancelar-se o que falta', async () => {
  const running = batch({ status: 'running', counts: { queued: 1, pending: 0, applied: 1, unchanged: 0, failed: 0, not_processed: 0 } });
  authFetch.mockResolvedValueOnce(json(preview())).mockResolvedValueOnce(json({ batchId: 9 })).mockResolvedValue(json(running));
  await choose('Plano de destino', '2');
  await click(buttonNamed('Pré-visualizar'));
  await click(buttonNamed('Mudar 1 cliente de plano'));
  await settle();

  expect(document.body.textContent).toContain('1 de 2');
  await click(buttonNamed('Cancelar o que falta'));
  expect(authFetch.mock.calls.some((call) => /bulk-change\/9\/cancel$/.test(call[0]) && call[1]?.method === 'POST')).toBe(true);
});

test('veredicto do lote e próxima ocorrência da hora', () => {
  const counts = { queued: 0, pending: 0, applied: 3, unchanged: 0, failed: 0, not_processed: 0 };
  expect(batchVerdict({ status: 'done', counts }).label).toBe('Concluído');
  expect(batchVerdict({ status: 'done', counts: { ...counts, not_processed: 1 } }).label).toBe('Concluído com falhas');
  expect(batchVerdict({ status: 'stopped', counts }).label).toBe('Parado');

  const evening = new Date(2026, 9, 9, 22, 0, 0);
  expect(new Date(nextOccurrence('04:00', evening)!).getDate()).toBe(10);
  expect(new Date(nextOccurrence('23:30', evening)!).getDate()).toBe(9);
  expect(nextOccurrence('', evening)).toBeNull();
});
