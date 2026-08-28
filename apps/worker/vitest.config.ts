import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The migration runner requires an explicit ownership contract.
    setupFiles: ['../../packages/testing/src/setup-migration-owners.ts'],
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
