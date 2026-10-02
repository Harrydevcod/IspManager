/** @vitest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SecretField, ToastProvider } from '../../components';
import { AuthProvider } from '../../lib/auth';
import { CreatePppoeButton, RevealPppoePassword } from './PppoeCredentials';

const roots: Root[] = [];
const calls: Array<{ url: string; body: unknown }> = [];
let answer: { status: number; body: unknown };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) return json({ setupRequired: false, authBypassed: true });
    calls.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
    return json(answer.body, answer.status);
  }));
});

afterEach(async () => {
  await act(async () => { while (roots.length) roots.pop()?.unmount(); });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(<AuthProvider><ToastProvider>{node}</ToastProvider></AuthProvider>); });
  return container;
}

const button = (label: string) => [...document.body.querySelectorAll('button')].find((item) => item.textContent === label);

async function click(label: string) {
  await act(async () => { button(label)!.click(); });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(formId: string) {
  await act(async () => {
    document.getElementById(formId)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('RevealPppoePassword', () => {
  test('pede a password, mostra a senha e esquece-a ao fechar', async () => {
    answer = { status: 200, body: { username: 'skn002', password: 'senha-do-cliente' } };
    await mount(<RevealPppoePassword serviceId={4} />);
    await click('Mostrar');

    await submit('pppoe-reveal-form');
    expect(calls).toHaveLength(0);
    expect(document.body.textContent).toContain('Confirme a sua password');

    await type(document.querySelector('input[type="password"]')!, 'supersecret');
    await submit('pppoe-reveal-form');
    expect(calls).toEqual([{ url: 'http://127.0.0.1:3001/api/services/4/pppoe-password/reveal', body: { password: 'supersecret' } }]);
    expect(document.body.textContent).toContain('senha-do-cliente');
    expect(document.querySelector('input[type="password"]')).toBeNull();

    await click('Fechar');
    await click('Mostrar');
    expect(document.body.textContent).not.toContain('senha-do-cliente');
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  });

  test('uma recusa fica no campo e não mostra nada', async () => {
    answer = { status: 401, body: { error: 'Password incorreta.' } };
    await mount(<RevealPppoePassword serviceId={4} />);
    await click('Mostrar');
    await type(document.querySelector('input[type="password"]')!, 'errada');
    await submit('pppoe-reveal-form');
    expect(document.body.textContent).toContain('Password incorreta.');
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  });
});

describe('CreatePppoeButton', () => {
  test('sem nome pede o automático e avisa quem o chamou', async () => {
    answer = { status: 200, body: { username: 'skn007' } };
    const onCreated = vi.fn();
    await mount(<CreatePppoeButton serviceId={8} clientName="Ana Lima" onCreated={onCreated} />);
    await click('Criar PPPoE');
    await submit('pppoe-create-form');
    expect(calls).toEqual([{ url: 'http://127.0.0.1:3001/api/services/8/pppoe', body: { username: null } }]);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('skn007');
  });

  test('um nome recusado fica no campo e o diálogo não fecha', async () => {
    answer = { status: 409, body: { error: 'O utilizador PPPoE skn001 ja pertence a outro servico' } };
    const onCreated = vi.fn();
    await mount(<CreatePppoeButton serviceId={3} clientName="Isa Rafe" onCreated={onCreated} />);
    await click('Criar PPPoE');
    await type(document.querySelector('#pppoe-create-form input')!, 'skn001');
    await submit('pppoe-create-form');
    expect(calls[0].body).toEqual({ username: 'skn001' });
    expect(document.body.textContent).toContain('ja pertence a outro servico');
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe('SecretField dentro de um diálogo', () => {
  test('mostra a ajuda por baixo e deixa o Cancelar para o rodapé', async () => {
    const container = await mount(
      <SecretField label="Nova senha PPPoE" configured draft={{ editing: true, value: '' }} onDraftChange={() => {}}
        wide hint="Entre 8 e 64 caracteres." cancellable={false} />
    );
    expect(container.querySelector('.secret-field.wide-field .field-hint')?.textContent).toBe('Entre 8 e 64 caracteres.');
    expect([...container.querySelectorAll('button')].map((item) => item.textContent)).toEqual(['Mostrar']);
  });
});
