// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { UpdateStatus as UpdateReading } from '../../shared/update-status';
import { UpdateStatus } from './UpdateStatus';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;

/** O preload falso: devolve `initial` e deixa o teste emitir estados novos. */
function stubBridge(initial: UpdateReading) {
  let listener: ((status: UpdateReading) => void) | null = null;
  const installUpdate = vi.fn(async () => true);
  window.ispm = {
    platform: 'win32',
    getUpdateStatus: async () => initial,
    onUpdateStatus: (callback) => {
      listener = callback;
      return () => { listener = null; };
    },
    installUpdate
  };
  return { emit: (status: UpdateReading) => act(() => listener?.(status)), installUpdate };
}

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<UpdateStatus />));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  delete window.ispm;
});

describe('UpdateStatus', () => {
  test('sem atualização, ou fora do Electron, não ocupa espaço', async () => {
    stubBridge({ state: 'idle' });
    expect((await mount()).innerHTML).toBe('');
    act(() => root?.unmount());
    delete window.ispm;
    expect((await mount()).innerHTML).toBe('');
  });

  test('a descarga mostra a versão, a percentagem e os MB, e acompanha o progresso', async () => {
    const bridge = stubBridge({ state: 'downloading', version: '2.38.0', percent: 45.7, transferred: 54_000_000, total: 120_000_000 });
    const container = await mount();
    expect(container.textContent).toContain('A descarregar 2.38.0 · 45 % · 54 de 120 MB');
    expect(container.querySelector('progress')?.value).toBe(45);

    bridge.emit({ state: 'downloading', version: '2.38.0', percent: 90, transferred: 108_000_000, total: 120_000_000 });
    expect(container.querySelector('progress')?.value).toBe(90);
  });

  test('descarregada, o botão reinicia e instala', async () => {
    const bridge = stubBridge({ state: 'idle' });
    const container = await mount();
    bridge.emit({ state: 'downloaded', version: '2.38.0' });
    expect(container.textContent).toContain('ISPM 2.38.0 pronto a instalar');
    act(() => container.querySelector('button')!.click());
    expect(bridge.installUpdate).toHaveBeenCalledOnce();
  });

  test('uma falha diz quando volta a tentar', async () => {
    stubBridge({ state: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });
    expect((await mount()).textContent).toContain('volta a tentar daqui a 6 h');
  });
});
