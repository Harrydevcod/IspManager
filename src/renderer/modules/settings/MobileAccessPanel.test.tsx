// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { MobileAccessPanel } from './MobileAccessPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.unstubAllGlobals());

test('ativa com password e permite desligar o acesso', async () => {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({url, init});
    const body = url.endsWith('/start') ? {running:true, host:'192.168.1.4', port:38421} : url.endsWith('/stop') ? {running:false, host:null, port:null} : {running:false, host:null, port:null, addresses:['192.168.1.4']};
    return {ok:true, json:async () => body};
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<MobileAccessPanel />));
  const password = host.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => {
    const select = host.querySelector('select') as HTMLSelectElement;
    select.value = '192.168.1.4';
    select.dispatchEvent(new Event('change', {bubbles:true}));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, 'secret');
    password.dispatchEvent(new Event('input', {bubbles:true}));
  });
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Ativar'))!.click());
  const start = calls.find(call => call.url.endsWith('/start'))!;
  expect(JSON.parse(String(start.init?.body))).toEqual({host:'192.168.1.4', port:38421, confirmPassword:'secret'});
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.textContent).toContain('Ativo');
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Desligar'))!.click());
  expect(calls.some(call => call.url.endsWith('/stop'))).toBe(true);
  expect(host.textContent).toContain('Desligado');
  expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  await act(async () => root.unmount());
  host.remove();
});
