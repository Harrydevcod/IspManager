import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    hookTimeout: 30_000,
    setupFiles: ['src/backend/test-setup.ts'],
    // As ferramentas do fornecedor em scripts/ também são código que se parte.
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)', 'scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)']
  }
});
