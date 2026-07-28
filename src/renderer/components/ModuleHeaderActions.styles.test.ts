import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('module header action styles', () => {
  test('does not contextually promote every module-header button', () => {
    expect(css).not.toMatch(/\.module-header button\s*,/);
    expect(css).not.toMatch(/\.module-header button:hover/);
    expect(css).not.toMatch(/\.module-header button:active/);
  });

  test('defines action-specific theme tokens and semantic variants', () => {
    expect(css).toContain('--action-primary-start:');
    expect(css).toContain('--action-primary-end:');
    expect(css).toContain('.btn-critical');
    expect(css).toContain('.module-header-actions');
    expect(css).toContain('.module-header-actions-critical');
  });

  test('respects reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.btn/);
  });
});
