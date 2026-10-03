import { expect, test } from 'vitest';
import { lineDiff } from './line-diff';

const compact = (before: string, after: string) =>
  lineDiff(before, after).map((line) => `${{ same: ' ', added: '+', removed: '-' }[line.kind]}${line.text}`);

test('textos iguais não têm diferenças', () => {
  expect(compact('a\nb', 'a\nb')).toEqual([' a', ' b']);
});

test('marca o que entrou, o que saiu e mantém a ordem', () => {
  expect(compact('a\nb\nc', 'a\nx\nc\nd')).toEqual([' a', '-b', '+x', ' c', '+d']);
});

test('aplicar as diferenças reconstrói os dois lados', () => {
  const before = '/ip address\nadd address=10.0.0.1/24\n/ppp secret\nadd name=skn001';
  const after = '/ip address\nadd address=10.0.0.2/24\n/ip dns\nset servers=1.1.1.1\n/ppp secret\nadd name=skn001';
  const diff = lineDiff(before, after);
  expect(diff.filter((line) => line.kind !== 'added').map((line) => line.text).join('\n')).toBe(before);
  expect(diff.filter((line) => line.kind !== 'removed').map((line) => line.text).join('\n')).toBe(after);
});

test('fim de linha do Windows não conta como diferença', () => {
  expect(compact('a\r\nb', 'a\nb')).toEqual([' a', ' b']);
});
