import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    hookTimeout: 30_000,
    // As ferramentas do fornecedor em scripts/ também são código que se parte.
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)', 'scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)']
  }
});
