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
    ispm: 'Base 10 · plano-10M', router: 'plano-20M', held: true, managed: true, online: false, routerAccess: true, takenBy: null,
    planOptions: [{ id: 2, name: 'Mais 20' }], ...overrides
  };
}

function render(rows: ReconRow[], dryRun = false) {
  return act(async () => {
    root.render(<Reconciliation data={{ rows, unlinkedServices: [] }} dryRun={dryRun} onChanged={onChanged} />);
  });
}

const buttonNamed = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(text))!;

/** O botão com esse efeito, na linha desse utilizador. */
const side = (login: string, label: string) =>
  [...document.querySelector(`[aria-label="Decisão para ${login}"]`)!.querySelectorAll('button')].find((item) => item.textContent === label)!;

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
});

test('a decisão passa por uma revisão antes de ser enviada, e o resultado fica à vista', async () => {
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [{ key: 'plan:1', status: 'applied', message: 'Trouxe do router o plano' }] }) });
  await render([row({})]);

  await click(side('skn001', 'Mudar o plano no ISPM'));
  expect(authFetch).not.toHaveBeenCalled();
  await click(buttonNamed('Rever'));
  expect(document.body.textContent).toContain('Mudar o plano no ISPM');
  await click(buttonNamed('Aplicar 1 decisão'));

  expect(authFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(authFetch.mock.calls[0][1].body)).toEqual({ items: [{ key: 'plan:1', direction: 'router' }] });
  expect(document.body.textContent).toContain('Trouxe do router o plano');
  await click(buttonNamed('Fechar'));
  expect(onChanged).toHaveBeenCalled();
});

test('desativar um utilizador feito à mão só avança com o nome escrito', async () => {
  await render([row({ key: 'only_router:*A', kind: 'only_router', serviceId: null, secretId: '*A', clientName: null, login: 'torre-norte', ispm: 'Não existe', router: 'Ativo · default', managed: false, online: true, planOptions: [] })]);

  await click(side('torre-norte', 'Desativar no router'));
  await click(buttonNamed('Rever'));
  expect(document.body.textContent).toContain('a sessão vai ser derrubada');
  expect(buttonNamed('Aplicar 1 decisão').disabled).toBe(true);

  await type([...document.querySelectorAll('input')].find((item) => item.type === 'text' || !item.type)!, 'torre-norte');
  expect(buttonNamed('Aplicar 1 decisão').disabled).toBe(false);
});

test('em ensaio o botão diz que é ensaio', async () => {
  await render([row({})], true);
  await click(side('skn001', 'Repor o plano no router'));
  await click(buttonNamed('Rever'));
  expect(buttonNamed('Ensaiar 1 decisão')).toBeTruthy();
});

test('clicar no lado já escolhido retira a decisão', async () => {
  await render([row({})]);
  await click(side('skn001', 'Mudar o plano no ISPM'));
  expect(side('skn001', 'Mudar o plano no ISPM').getAttribute('aria-pressed')).toBe('true');
  expect(buttonNamed('Rever').textContent).toBe('Rever 1 decisão');
  await click(side('skn001', 'Mudar o plano no ISPM'));
  expect(side('skn001', 'Mudar o plano no ISPM').getAttribute('aria-pressed')).toBe('false');
  expect(buttonNamed('Rever').disabled).toBe(true);
});

test('um utilizador feito à mão lê-se como diferença própria', async () => {
  await render([row({ key: 'only_router:*A', kind: 'only_router', serviceId: null, clientName: null, login: 'torre-norte', managed: false, planOptions: [] })]);
  expect(container.textContent).toContain('Feito à mão');
});

test('numa diferença de estado, cada botão diz o que faz e onde', async () => {
  const state = { key: 'state:1', kind: 'state' as const, planOptions: [] };
  await render([row({ ...state, ispm: 'Ativo', router: 'Desativado', routerAccess: false })]);
  expect(side('skn001', 'Reativar no router')).toBeTruthy();
  expect(side('skn001', 'Suspender no ISPM')).toBeTruthy();

  await render([row({ ...state, ispm: 'Suspenso', router: 'Com serviço (plano-10M)', routerAccess: true })]);
  expect(side('skn001', 'Cortar no router')).toBeTruthy();
  expect(side('skn001', 'Reativar no ISPM')).toBeTruthy();
});

test('o nome que no router é de outro serviço não se pode criar', async () => {
  await render([row({ key: 'only_ispm:1', kind: 'only_ispm', secretId: null, router: 'É de Ana', takenBy: 'Ana', planOptions: [] })]);
  expect(side('skn001', 'Criar no router').disabled).toBe(true);
  expect(side('skn001', 'Tirar do serviço').disabled).toBe(false);
});
