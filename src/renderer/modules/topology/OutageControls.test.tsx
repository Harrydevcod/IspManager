/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PlannedRebootButton, SitePicker } from './OutageControls';

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await settle();
  return { host, root };
}

test('"Vou reiniciar" abre a janela e mostra até quando; cancelar fecha-a', async () => {
  let planned: Record<string, string> = {};
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'POST') planned = { 4: '2026-11-27 12:10:00' };
    if (init?.method === 'DELETE') planned = {};
    return new Response(JSON.stringify(url.endsWith('/planned-reboots') ? planned : { ok: true }), { status: 200 });
  }));
  const { host, root } = await render(<PlannedRebootButton deviceId={4} />);
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Vou reiniciar'))!.click());
  await settle();
  expect(calls.some((call) => call.startsWith('POST') && call.endsWith('/planned-reboots/4'))).toBe(true);
  expect(host.textContent).toContain('A reiniciar até');
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancelar')!.click());
  await settle();
  expect(calls.some((call) => call.startsWith('DELETE'))).toBe(true);
  expect(host.textContent).toContain('Vou reiniciar');
  await act(async () => root.unmount());
});

test('o local escolhe-se da lista e um novo passa a estar nela', async () => {
  const sites = [{ id: 1, name: 'Torre de Achada' }];
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === 'POST' && url.endsWith('/sites')) {
      sites.push({ id: 2, name: 'Poste da escola' });
      return new Response(JSON.stringify({ id: 2, name: 'Poste da escola' }), { status: 201 });
    }
    return new Response(JSON.stringify(url.endsWith('/sites') ? sites : { ok: true }), { status: 200 });
  }));
  const { host, root } = await render(<SitePicker deviceId={9} siteId={null} canManage />);
  const select = host.querySelector('select')!;
  expect([...select.options].map((option) => option.textContent)).toEqual(['Sem local', 'Torre de Achada', 'Novo local…']);

  await act(async () => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle();
  expect(calls.find((call) => call.method === 'PUT')).toMatchObject({ url: expect.stringContaining('/sites/device/9'), body: { siteId: 1 } });

  await act(async () => { select.value = '__novo__'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const input = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Poste da escola');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Guardar')!.click());
  await settle();
  expect(calls.filter((call) => call.method === 'PUT').at(-1)?.body).toEqual({ siteId: 2 });
  expect([...host.querySelector('select')!.options].map((option) => option.textContent)).toContain('Poste da escola');
  await act(async () => root.unmount());
});
