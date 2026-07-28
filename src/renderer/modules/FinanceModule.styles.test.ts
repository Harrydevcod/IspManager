import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('./FinanceModule.css', import.meta.url), 'utf8');

describe('FinanceModule responsive shell', () => {
  test('allows the financial tabs and nested module headers to shrink without page overflow', () => {
    expect(css).toMatch(/\.finance-shell\s*\{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\.finance-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
    expect(css).toMatch(/\.finance-tabs-row\s*\{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.finance-tabs-row \.segmented-tabs\s*\{[^}]*width:\s*100%;/);
  });
});
