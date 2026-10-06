/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BulkIpDialog } from './BulkIpDialog';
import { ToastProvider } from '../../components';
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

const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

const assignment = (id: number, clientName: string) => ({
  id, serviceId: id, clientId: id, clientName, brand: 'TP-Link', model: 'Archer C20', catalogType: 'router',
  serialNumber: null, ipAddress: null, macAddress: null, sharedWithNames: null
});

test('o MAC que a rede propõe preenche o campo e só viaja com o Gravar', async () => {
  vi.mocked(authFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/discovery/proposals')) {
      return json({
        proposals: [{ kind: 'mac_em_falta', targetKind: 'assignment', targetId: 2, proposed: 'BC:07:1D:5E:42:9F' }],
        orphans: []
      });
    }
    return json(init?.method === 'PATCH' ? { updated: 1 } : [assignment(1, 'Helen'), assignment(2, 'Lucas')]);
  });

  await act(async () => {
    root.render(<ToastProvider><BulkIpDialog onClose={() => undefined} onSaved={() => undefined} /></ToastProvider>);
  });

  const buttons = () => Array.from(document.body.querySelectorAll('button'));
  const use = buttons().filter((button) => button.textContent?.startsWith('Usar '));
  // Só o Lucas tem proposta; a Helen fica à espera de discar.
  expect(use.map((button) => button.textContent)).toEqual(['Usar BC:07:1D:5E:42:9F']);

  await act(async () => { use[0].click(); });
  expect(vi.mocked(authFetch).mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);

  await act(async () => { buttons().find((button) => button.textContent === 'Gravar')?.click(); });
  const patch = vi.mocked(authFetch).mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ items: [{ id: 2, ipAddress: '', macAddress: 'BC:07:1D:5E:42:9F' }] });
});
