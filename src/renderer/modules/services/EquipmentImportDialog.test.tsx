/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EquipmentImportDialog } from './EquipmentImportDialog';
import { authFetch } from '../../lib/auth';
import { parseFile } from '../clients/import/parseFile';

vi.mock('../../lib/auth', () => ({ authFetch: vi.fn() }));
vi.mock('../clients/import/parseFile', async (original) => ({ ...await original<object>(), parseFile: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(authFetch).mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

async function openAndPick(onSaved = vi.fn()) {
  vi.mocked(parseFile).mockResolvedValue({ headers: ['ID', 'Código', 'IP'], rows: [
    { ID: '11', Código: 'CL-001', IP: '10.0.0.9' },
    { ID: '12', Código: 'OUTRO', IP: '10.0.0.8' }
  ] });
  await act(async () => { root.render(<EquipmentImportDialog onClose={vi.fn()} onSaved={onSaved} />); });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['csv'], 'equipamentos.csv')] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}
const rows = [11, 12].map((id) => ({ id, clientCode: 'CL-001', clientName: 'Ana', brand: null, model: 'Router', ipAddress: `10.0.0.${id}`, macAddress: null, wanMode: null, operationMode: null, lanCidr: null }));

test('aplica só as linhas válidas alteradas e mantém as recusadas no resultado', async () => {
  vi.mocked(authFetch).mockImplementation((_url, init) => init?.method === 'PATCH' ? json({ updated: 1 }) : json(rows));
  const saved = vi.fn();
  await openAndPick(saved);
  expect(document.body.textContent).toContain('10.0.0.9');
  const apply = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Aplicar 1'))!;
  await act(async () => { apply.click(); });
  const request = vi.mocked(authFetch).mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ items: [{ id: 11, ipAddress: '10.0.0.9' }] });
  expect(document.body.textContent).toContain('1 equipamento(s) atualizado(s)');
  expect(document.body.textContent).toContain('código do cliente não corresponde');
  expect(saved).toHaveBeenCalledOnce();
  expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Aplicar 1'))).toBe(false);
});

test('um conflito do servidor permanece visível e não anuncia sucesso', async () => {
  vi.mocked(authFetch).mockImplementation((_url, init) => init?.method === 'PATCH' ? json({ error: 'IP 10.0.0.9 ficaria em dois equipamentos ativos' }, 409) : json(rows));
  const saved = vi.fn();
  await openAndPick(saved);
  const apply = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Aplicar 1'))!;
  await act(async () => { apply.click(); });
  expect(document.body.textContent).toContain('IP 10.0.0.9 ficaria em dois equipamentos ativos');
  expect(saved).not.toHaveBeenCalled();
});
