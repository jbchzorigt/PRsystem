import { defineConfig } from 'vitest/config';

/**
 * Real-PostgreSQL suites each provision their own scratch database, and
 * PostgreSQL serialises `CREATE DATABASE` against the template. Running the
 * files in parallel makes them race for it, so they run one file at a time.
 * Tests *within* a file still run concurrently where they are written to.
 */
export default defineConfig({
  test: {
    // The migration runner requires an explicit ownership contract.
    setupFiles: ['../testing/src/setup-pool-errors.ts', '../testing/src/setup-migration-owners.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
  },
});
