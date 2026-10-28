/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RouterProfileField } from './RouterProfileField';
import { authFetch } from '../../lib/auth';

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

const profiles = {
  available: true,
  baseProfile: 'default',
  profiles: [
    { name: 'default', rateLimit: null, ownerPlanId: null },
    { name: 'plano-20M', rateLimit: '20M/20M', ownerPlanId: 1 },
    { name: 'feito-no-winbox', rateLimit: '5M/5M', ownerPlanId: null }
  ]
};

async function render(value: string, routerProfile: string | null = value) {
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify(profiles)));
  await act(async () => {
    root.render(
      <RouterProfileField value={value} onChange={() => {}} savedPlan={{ id: 1, routerProfile }} canWriteRouter />
    );
  });
}

const buttonText = () => [...container.querySelectorAll('button')].map((b) => b.textContent);

describe('RouterProfileField', () => {
  test('escolhe-se dos perfis do router, ou o perfil próprio do ISPM; nunca texto livre', async () => {
    await render('');
    const options = [...container.querySelectorAll('select option')].map((o) => o.getAttribute('value'));
    expect(options).toEqual(['', 'default', 'plano-20M', 'feito-no-winbox']);
    expect(container.querySelector('input')).toBeNull();
  });

  test('router indisponível: fica o valor gravado, só para ler', async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ available: false, reason: 'Fora da rede de gestão', baseProfile: 'default', profiles: [] })));
    await act(async () => {
      root.render(<RouterProfileField value="plano-20M" onChange={() => {}} savedPlan={{ id: 1, routerProfile: 'plano-20M' }} canWriteRouter />);
    });
    const select = container.querySelector('select')!;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('plano-20M');
    expect(container.textContent).toContain('Fora da rede de gestão');
  });

  test('nome que não existe no router: oferece criar', async () => {
    await render('plano-50M');
    expect(buttonText()).toEqual(['Criar no router']);
    expect(container.textContent).toContain('com os campos de rede das Definições');
  });

  test('perfil criado pelo ISPM para este plano: oferece atualizar', async () => {
    await render('plano-20M');
    expect(buttonText()).toEqual(['Atualizar no router']);
  });

  // O perfil do operador é dele: escolhê-lo não dá ao ISPM licença para lhe mexer.
  test('perfil feito no router: sem botão de escrita', async () => {
    await render('feito-no-winbox');
    expect(buttonText()).toEqual([]);
    expect(container.textContent).toContain('o ISPM não lhe mexe');
  });

  test('nome por gravar: o botão fica parado até se gravar o plano', async () => {
    await render('plano-50M', null);
    const button = container.querySelector('button');
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain('Grave o plano primeiro');
  });
});
