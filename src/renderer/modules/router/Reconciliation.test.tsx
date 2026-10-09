/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Reconciliation } from './Reconciliation';
import type { ReconRow } from './router-api';

const authFetch = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth', () => ({ authFetch }));

let root: Root;
let container: HTMLDivElement;
const onChanged = vi.fn();

function row(overrides: Partial<ReconRow>): ReconRow {
  return {
    key: 'plan:1', kind: 'plan', serviceId: 1, secretId: '*1', clientName: 'Joao Silva', login: 'skn001',
    ispm: 'Base 10 · plano-10M', router: 'plano-20M', held: true, managed: true, online: false,
    planOptions: [{ id: 2, name: 'Mais 20' }], ...overrides
  };
}

function render(rows: ReconRow[], dryRun = false) {
  return act(async () => {
    root.render(<Reconciliation data={{ rows, unlinkedServices: [] }} dryRun={dryRun} onChanged={onChanged} />);
  });
}

const buttonNamed = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(text))!;

async function choose(label: string, value: string) {
  const select = [...document.querySelectorAll('select')].find((item) => document.querySelector(`label[for="${item.id}"]`)?.textContent?.includes(label))!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = (element: Element) => act(async () => { (element as HTMLElement).click(); });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  authFetch.mockReset();
  onChanged.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('sem decisão não há nada para aplicar', async () => {
  await render([row({})]);
  expect(buttonNamed('Rever').disabled).toBe(true);
  expect(container.textContent).toContain('À espera de decisão');
});

test('a decisão passa por uma revisão antes de ser enviada, e o resultado fica à vista', async () => {
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [{ key: 'plan:1', status: 'applied', message: 'Trouxe do router o plano' }] }) });
  await render([row({})]);

  await choose('Decisão para skn001', 'router');
  expect(authFetch).not.toHaveBeenCalled();
  await click(buttonNamed('Rever'));
  expect(document.body.textContent).toContain('Passar o serviço ao plano do router');
  await click(buttonNamed('Aplicar 1 decisão'));

  expect(authFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(authFetch.mock.calls[0][1].body)).toEqual({ items: [{ key: 'plan:1', direction: 'router' }] });
  expect(document.body.textContent).toContain('Trouxe do router o plano');
  await click(buttonNamed('Fechar'));
  expect(onChanged).toHaveBeenCalled();
});

test('desativar um utilizador feito à mão só avança com o nome escrito', async () => {
  await render([row({ key: 'only_router:*A', kind: 'only_router', serviceId: null, secretId: '*A', clientName: null, login: 'torre-norte', ispm: 'Não existe', router: 'Ativo · default', managed: false, online: true, planOptions: [] })]);

  await choose('Decisão para torre-norte', 'ispm');
  await click(buttonNamed('Rever'));
  expect(document.body.textContent).toContain('a sessão vai ser derrubada');
  expect(buttonNamed('Aplicar 1 decisão').disabled).toBe(true);

  await type([...document.querySelectorAll('input')].find((item) => item.type === 'text' || !item.type)!, 'torre-norte');
  expect(buttonNamed('Aplicar 1 decisão').disabled).toBe(false);
});

test('em ensaio o botão diz que é ensaio', async () => {
  await render([row({})], true);
  await choose('Decisão para skn001', 'ispm');
  await click(buttonNamed('Rever'));
  expect(buttonNamed('Ensaiar 1 decisão')).toBeTruthy();
});
