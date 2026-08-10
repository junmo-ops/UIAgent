import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.{ts,tsx}', 'apps/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: { reporter: ['text', 'html'] }
  }
});
