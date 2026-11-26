/** @vitest-environment jsdom */

import { afterEach, expect, test, vi } from 'vitest';
import { copyText } from './clipboard';

afterEach(() => { delete (window as { ispm?: unknown }).ispm; });

function browserClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

test('usa o clipboard do Electron quando o do browser falha', async () => {
  browserClipboard(() => Promise.reject(new Error('sem foco')));
  const fallback = vi.fn().mockResolvedValue(true);
  (window as { ispm?: unknown }).ispm = { copyText: fallback };
  expect(await copyText('abc')).toBe(true);
  expect(fallback).toHaveBeenCalledWith('abc');
});

test('sem nenhum dos dois, diz que não copiou', async () => {
  browserClipboard(() => Promise.reject(new Error('sem foco')));
  expect(await copyText('abc')).toBe(false);
});
