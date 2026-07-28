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

  test('keeps header action surfaces and text cool-neutral instead of warm brown', () => {
    expect(css).toContain('--action-secondary-fg: oklch(93% 0.006 251);');
    expect(css).toContain('--action-secondary-shadow:');
    expect(css).toContain('--action-secondary-bg: oklch(98.7% 0.003 255);');
    expect(css).toContain('--action-secondary-hover: oklch(96.2% 0.006 255);');
    expect(css).toContain('--action-secondary-border: oklch(82% 0.012 255);');
    expect(css).toContain('--action-secondary-border-hover: oklch(69% 0.018 255);');
    expect(css).toContain('--action-secondary-fg: oklch(28% 0.015 255);');
    expect(css).toMatch(/\.btn-secondary\s*\{[^}]*color:\s*var\(--action-secondary-fg\);/);
    expect(css).toMatch(/\.btn-secondary:hover:not\(:disabled\)\s*\{[^}]*box-shadow:\s*var\(--action-secondary-shadow\);/);
    expect(css).toMatch(/\.btn-critical:hover:not\(:disabled\),[\s\S]*?background:\s*color-mix\(in oklch, var\(--danger-bg\) 72%, var\(--action-secondary-hover\)\);/);
  });

  test('respects reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.btn/);
    expect(css).toContain('.btn:hover:not(:disabled),\n  .btn:active:not(:disabled)');
  });

  test('lets wrapped action rows align context with the module edge', () => {
    expect(css).toMatch(/\.module-header-actions\s*\{[^}]*flex:\s*1 1 auto;/);
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.module-header-context\s*\{[^}]*flex:\s*1 1 100%;/);
  });
});
