import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit is used to GENERATE migration files only. It is never used to push
 * a schema at a database: versioned migrations are the sole migration strategy
 * (ADR-0004, CLAUDE.md §10).
 */
export default {
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
} satisfies Config;
