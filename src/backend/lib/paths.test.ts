import { afterEach, describe, expect, test, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDir } from './paths';

const original = process.env.ISPM_DATA_DIR;
afterEach(() => {
  if (original === undefined) delete process.env.ISPM_DATA_DIR;
  else process.env.ISPM_DATA_DIR = original;
});

describe('resolveDataDir', () => {
  test('honours ISPM_DATA_DIR when set', () => {
    process.env.ISPM_DATA_DIR = path.join(os.tmpdir(), 'ispm-x');
    expect(resolveDataDir()).toBe(path.join(os.tmpdir(), 'ispm-x'));
  });

  test('falls back to an ISPM folder under APPDATA or home', () => {
    delete process.env.ISPM_DATA_DIR;
    // Fora dos testes: é assim que a app instalada encontra a base.
    vi.stubEnv('VITEST', '');
    try {
      expect(path.basename(resolveDataDir())).toBe('ISPM');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('num teste sem pasta própria rebenta em vez de apontar para a base real', () => {
    delete process.env.ISPM_DATA_DIR;
    expect(() => resolveDataDir()).toThrow(/ISPM_DATA_DIR/);
  });
});
