import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    hookTimeout: 30_000,
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)']
  }
});
