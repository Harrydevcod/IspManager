/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { ContextMenu, type RowActionGroup } from './RowActionsMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const groups: RowActionGroup[] = [
  { label: 'Equipamento', items: [{ label: 'Editar', onClick: vi.fn() }, { label: 'Duplicar', onClick: vi.fn() }] },
  { label: 'Inventário', items: [{ label: 'Retirar', danger: true, onClick: vi.fn() }] }
];

/** Abre o menu com o foco num botão de origem, como quem o abre com Shift+F10. */
function openFrom() {
  const opener = document.createElement('button');
  opener.textContent = 'Torre Norte';
  document.body.append(opener);
  opener.focus();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const onClose = vi.fn(() => act(() => root?.render(<></>)));
  act(() => root!.render(<ContextMenu x={10} y={10} groups={groups} onClose={onClose} />));
  return { opener, onClose };
}

const press = (key: string) => act(() => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
});
const focused = () => document.activeElement?.textContent;

test('as setas, Home e End andam pelos itens do menu e dão a volta', () => {
  openFrom();
  expect(focused()).toBe('Editar');
  press('ArrowDown');
  expect(focused()).toBe('Duplicar');
  press('ArrowDown');
  expect(focused()).toBe('Retirar');
  press('ArrowDown');
  expect(focused()).toBe('Editar');
  press('ArrowUp');
  expect(focused()).toBe('Retirar');
  press('Home');
  expect(focused()).toBe('Editar');
  press('End');
  expect(focused()).toBe('Retirar');
});

test('Escape fecha e devolve o foco a quem abriu o menu', () => {
  const { opener, onClose } = openFrom();
  press('Escape');
  expect(onClose).toHaveBeenCalled();
  expect(document.activeElement).toBe(opener);
});
