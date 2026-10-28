/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RouterChoice, type RouterOptionLists, type RouterOptions } from './RouterChoice';

vi.mock('../lib/auth', () => ({ authFetch: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const lists = (pools: string[]): RouterOptions => ({
  status: 'ready', pools, profiles: [], localAddresses: [], dnsServers: [], interfaceLists: [], queues: [], addressLists: []
} satisfies { status: 'ready' } & RouterOptionLists);

function render(value: string, options: RouterOptions, onChange = vi.fn(), emptyLabel?: string) {
  act(() => {
    root.render(<RouterChoice label="Pool" value={value} onChange={onChange} options={options} list="pools" noun="pools" emptyLabel={emptyLabel} />);
  });
  return onChange;
}

const select = () => container.querySelector('select')!;
const optionValues = () => [...container.querySelectorAll('option')].map((o) => o.value);

describe('RouterChoice', () => {
  test('várias opções no router: escolhe-se de uma lista, nunca se escreve', () => {
    render('pool-b', lists(['pool-a', 'pool-b']));
    expect(container.querySelector('input')).toBeNull();
    expect(select().disabled).toBe(false);
    expect(optionValues()).toEqual(['pool-a', 'pool-b']);
  });

  test('uma só opção: vem preenchida e fica fixa', () => {
    const onChange = render('', lists(['pool-unica']));
    expect(onChange).toHaveBeenCalledWith('pool-unica');
    expect(select().disabled).toBe(true);
    expect(container.textContent).toContain('Única opção no router');
  });

  test('uma só opção mas vazio também vale: não se preenche sozinho', () => {
    const onChange = render('', lists(['perfil-lento']), vi.fn(), 'Nenhum');
    expect(onChange).not.toHaveBeenCalled();
    expect(optionValues()).toEqual(['', 'perfil-lento']);
  });

  test('valor gravado que já não existe no router: marcado, a pedir outro', () => {
    render('pool-velha', lists(['pool-a', 'pool-b']));
    expect(optionValues()).toEqual(['pool-velha', 'pool-a', 'pool-b']);
    expect(container.textContent).toContain('pool-velha não existe no router');
  });

  test('nada no router: diz que não há', () => {
    render('', lists([]));
    expect(select().disabled).toBe(true);
    expect(container.textContent).toContain('Não há pools no router');
  });

  test('router indisponível: fica o valor gravado, só para ler, com a razão', () => {
    render('pool-a', { status: 'unavailable', reason: 'Fora da rede de gestão.' });
    expect(select().disabled).toBe(true);
    expect(select().value).toBe('pool-a');
    expect(container.textContent).toContain('Fora da rede de gestão.');
    expect(container.querySelector('input')).toBeNull();
  });
});
