import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.spec.ts', 'tests/**/*.example.test.ts'],
    reporters: ['default'],
    passWithNoTests: false,
  },
});
