/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IptvSection } from './IptvSection';
import { authFetch } from '../../lib/auth';
import type { ServiceRow } from '../../types';

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

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

function serve(routes: Record<string, () => Promise<Response>>) {
  vi.mocked(authFetch).mockImplementation((url: string) => {
    const key = Object.keys(routes).find((path) => url.endsWith(path));
    return key ? routes[key]() : json({ error: 'sem rota' }, 404);
  });
}

const service = (fields: Partial<ServiceRow>) => ({ id: 7, status: 'active', iptvVpn: true, iptvProviderId: null, ...fields }) as ServiceRow;

async function render(row: ServiceRow, onChanged = vi.fn()) {
  await act(async () => { root.render(<IptvSection service={row} canManage onChanged={onChanged} />); });
  return onChanged;
}

describe('IptvSection', () => {
  test('mostra a origem em falta com a razão, sem ler o router', async () => {
    serve({
      '/api/iptv/providers': () => json([]),
      '/api/iptv/status': () => json({ targets: [{ serviceId: 7, source: { kind: 'missing', reason: 'Modo da antena por classificar' } }], last: null })
    });
    await render(service({}));
    expect(container.textContent).toContain('Modo da antena por classificar');
    expect(vi.mocked(authFetch).mock.calls.some(([url]) => String(url).includes('/validate'))).toBe(false);
  });

  test('em migração diz o utilizador e o MAC legacy que ainda conta', async () => {
    serve({
      '/api/iptv/providers': () => json([]),
      '/api/iptv/status': () => json({ targets: [{ serviceId: 7, source: { kind: 'pppoe', username: 'skn020', legacy: { mac: 'BC:07:1D:5E:54:E7', via: 'router' } } }], last: null })
    });
    await render(service({}));
    expect(container.textContent).toContain('PPPoE skn020, e o MAC do router do cliente BC:07:1D:5E:54:E7 até migrar');
  });

  test('ligar a marca grava e pede para recarregar', async () => {
    serve({
      '/api/iptv/providers': () => json([]),
      '/api/services/7/iptv': () => json({ serviceId: 7, iptvVpn: 1, iptvProviderId: null })
    });
    const onChanged = await render(service({ iptvVpn: false }));
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { toggle.click(); });
    const put = vi.mocked(authFetch).mock.calls.find(([url]) => String(url).endsWith('/api/services/7/iptv'));
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ iptvVpn: true, iptvProviderId: null });
    expect(onChanged).toHaveBeenCalledOnce();
  });

  test('fora da rede de gestão, "Validar" mostra a razão do servidor', async () => {
    serve({
      '/api/iptv/providers': () => json([]),
      '/api/iptv/status': () => json({ targets: [{ serviceId: 7, source: { kind: 'pppoe', username: 'skn014', legacy: null } }], last: null }),
      '/api/iptv/validate': () => json({ error: 'Fora da rede de gestão: o ISPM não fala com o router daqui.' }, 409)
    });
    await render(service({}));
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Validar no router')!;
    await act(async () => { button.click(); });
    expect(container.textContent).toContain('Fora da rede de gestão: o ISPM não fala com o router daqui.');
  });
});
