/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test } from 'vitest';
import { TabList } from './TabList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const TABS = [
  { id: 'a', label: 'Alfa' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gama' }
] as const;

function Harness() {
  const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
  return <TabList idPrefix="t" label="Vistas" tabs={TABS} value={value} onChange={setValue} />;
}

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Harness />));
}

const tab = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) => el.textContent === name)!;
const press = (key: string) => act(async () => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
});

test('liga cada aba ao seu painel e só a escolhida entra no Tab', () => {
  mount();
  expect(document.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Vistas');
  expect(tab('Alfa').id).toBe('t-tab-a');
  expect(tab('Alfa').getAttribute('aria-controls')).toBe('t-panel-a');
  expect(tab('Alfa').getAttribute('aria-selected')).toBe('true');
  expect(tab('Alfa').tabIndex).toBe(0);
  expect(tab('Beta').tabIndex).toBe(-1);
});

test('as setas, Home e End escolhem a aba e levam o foco, dando a volta nas pontas', async () => {
  mount();
  tab('Alfa').focus();
  await press('ArrowLeft');
  expect(tab('Gama').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(tab('Gama'));
  await press('ArrowRight');
  expect(document.activeElement).toBe(tab('Alfa'));
  await press('End');
  expect(document.activeElement).toBe(tab('Gama'));
  await press('Home');
  expect(tab('Alfa').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(tab('Alfa'));
});

test('a classe de cada aba pode vir de fora e a escolhida leva is-active', () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<TabList segmented tabClassName="settings-tab" idPrefix="t" label="Vistas" tabs={TABS} value="b" onChange={() => {}} />));
  expect(tab('Alfa').className).toContain('settings-tab');
  expect(tab('Alfa').className).not.toContain('segmented-tab');
  expect(tab('Beta').className).toContain('settings-tab is-active');
});
