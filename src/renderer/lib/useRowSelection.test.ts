import { describe, expect, test } from 'vitest';
import { selectAllState } from './useRowSelection';

describe('selectAllState', () => {
  test('reports none when nothing on the page is selected', () => {
    expect(selectAllState(new Set<number>(), [1, 2, 3])).toBe('none');
    expect(selectAllState(new Set([9]), [1, 2, 3])).toBe('none');
  });

  test('reports some for a partial page selection', () => {
    expect(selectAllState(new Set([2]), [1, 2, 3])).toBe('some');
  });

  test('reports all only when every visible key is selected', () => {
    expect(selectAllState(new Set([1, 2, 3, 4]), [1, 2, 3])).toBe('all');
  });

  test('treats an empty page as none', () => {
    expect(selectAllState(new Set([1, 2]), [])).toBe('none');
  });
});
