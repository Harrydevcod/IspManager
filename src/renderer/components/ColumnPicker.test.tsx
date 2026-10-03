/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { ColumnPicker } from './ColumnPicker';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

test('mostra quantas se veem, liga e desliga, e não deixa tirar a última', () => {
  const onToggle = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <ColumnPicker headers={['IP', 'Nome']} hidden={new Set(['Nome'])} onToggle={onToggle} onReset={() => {}} />
    );
  });

  const trigger = container.querySelector('button')!;
  expect(trigger.textContent).toContain('1/2');
  act(() => trigger.click());

  const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes.map((box) => box.checked)).toEqual([true, false]);
  // IP é a única visível: desligá-la deixava a tabela vazia.
  expect(boxes[0].disabled).toBe(true);

  act(() => boxes[1].click());
  expect(onToggle).toHaveBeenCalledWith('Nome');

  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(container.querySelector('[role="group"]')).toBeNull();
});
