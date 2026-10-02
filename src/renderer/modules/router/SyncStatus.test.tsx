/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SPIN_MS, SyncStatus, syncedAgo } from './SyncStatus';

let root: Root;
let container: HTMLDivElement;
const onSync = vi.fn();

function render(props: { syncing: boolean; syncedAt: number | null; error?: string | null }) {
  return act(async () => { root.render(<SyncStatus error={null} onSync={onSync} {...props} />); });
}

const button = () => container.querySelector('button')!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onSync.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('diz há quanto tempo sincronizou e conta sozinho', async () => {
  await render({ syncing: false, syncedAt: 98_000 });
  expect(button().textContent).toBe('Sincronizado agora mesmo');
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(button().textContent).toBe('Sincronizado há 12 s');
});

test('uma leitura rápida dá uma volta inteira e nunca desativa o botão', async () => {
  await render({ syncing: false, syncedAt: 90_000 });
  await render({ syncing: true, syncedAt: 90_000 });
  expect(button().classList.contains('is-syncing')).toBe(true);
  expect(button().textContent).toBe('A sincronizar…');

  // A leitura acabou aos 50 ms; a roda continua até completar a volta.
  await act(async () => { vi.advanceTimersByTime(50); });
  await render({ syncing: false, syncedAt: 100_050 });
  expect(button().classList.contains('is-syncing')).toBe(true);
  await act(async () => { vi.advanceTimersByTime(SPIN_MS - 51); });
  expect(button().classList.contains('is-syncing')).toBe(true);
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(button().classList.contains('is-syncing')).toBe(false);
  expect(button().textContent).toBe('Sincronizado agora mesmo');

  expect(button().disabled).toBe(false);
  expect(button().hasAttribute('aria-busy')).toBe(false);
});

test('sem ligação mostra o aviso e anuncia-o uma vez', async () => {
  await render({ syncing: false, syncedAt: 90_000, error: 'Não foi possível ler o router.' });
  expect(button().textContent).toBe('Sem ligação ao router');
  expect(button().classList.contains('is-failed')).toBe(true);
  expect(container.querySelector('[aria-live]')?.textContent).toBe('Sem ligação ao router');
});

test('um clique sincroniza já', async () => {
  await render({ syncing: false, syncedAt: 90_000 });
  await act(async () => { button().click(); });
  expect(onSync).toHaveBeenCalledTimes(1);
});

test('formato curto da hora relativa', () => {
  expect(syncedAgo(0, 4_000)).toBe('agora mesmo');
  expect(syncedAgo(0, 42_000)).toBe('há 42 s');
  expect(syncedAgo(0, 185_000)).toBe('há 3 min');
  expect(syncedAgo(0, 7_300_000)).toBe('há 2 h');
});
