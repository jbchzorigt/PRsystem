// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Module boundary rules — CLAUDE.md §3 and docs/architecture/03-module-ownership-and-dependencies.md.
 *
 * A module may import another module's `contracts` surface only. Importing another
 * module's repository, schema or entity is forbidden. These patterns are active from
 * Phase 02 so the rule exists before the first module does; the fixture in
 * tools/lint-fixtures proves the rule actually fires.
 */
export const moduleBoundaryRule = /** @type {const} */ ([
  'error',
  {
    patterns: [
      {
        group: [
          '**/modules/*/repositories/*',
          '**/modules/*/repositories',
          '**/modules/*/schema/*',
          '**/modules/*/schema',
          '**/modules/*/entities/*',
          '**/modules/*/entities',
        ],
        message:
          'Cross-module repository, schema or entity imports are forbidden (CLAUDE.md §3). Use the module contracts surface.',
      },
      {
        group: ['@prsystem/*/src/*', '@prsystem/*/dist/*'],
        message: 'Import the package entrypoint, not its internals.',
      },
    ],
  },
]);

/**
 * Web boundary rule — CLAUDE.md §3 (a web application contains no authoritative
 * business rule) and build-plan Phase 21's architecture gate.
 *
 * A portal, and the kit the portals share, reach the platform through
 * `@prsystem/contracts` types and the kit's HTTP client only. The database,
 * the authorization matrix, the ports, the configuration loader, the API and
 * the worker are not importable from web code — neither by package name nor by
 * a relative path into another workspace. `packages/testing/src/web-boundary.test.ts`
 * proves the rule fires and scans every web import besides.
 */
export const webBoundaryRule = /** @type {const} */ ([
  'error',
  {
    patterns: [
      ...moduleBoundaryRule[1].patterns,
      {
        group: [
          '@prsystem/db',
          '@prsystem/db/*',
          '@prsystem/authz',
          '@prsystem/authz/*',
          '@prsystem/ports',
          '@prsystem/ports/*',
          '@prsystem/config',
          '@prsystem/config/*',
          '@prsystem/telemetry',
          '@prsystem/telemetry/*',
          '@prsystem/testing',
          '@prsystem/testing/*',
          '@prsystem/api',
          '@prsystem/api/*',
          '@prsystem/worker',
          '@prsystem/worker/*',
          'pg',
          'pg/*',
          'drizzle-orm',
          'drizzle-orm/*',
          '@nestjs/*',
          '**/apps/api/**',
          '**/apps/worker/**',
          '**/packages/db/**',
          '**/packages/authz/**',
          '**/packages/ports/**',
          '**/packages/config/**',
          '**/modules/**',
        ],
        message:
          'Web code imports only @prsystem/contracts and @prsystem/web-kit (CLAUDE.md §3): never db, authz internals, ports, config or module services.',
      },
    ],
  },
]);

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'tools/lint-fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-imports': moduleBoundaryRule,
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // A leading underscore marks a binding that exists only to be discarded,
      // e.g. destructuring a key out of an object.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: [
      'apps/web-*/**/*.ts',
      'apps/web-*/**/*.tsx',
      'packages/web-kit/**/*.ts',
      'packages/web-kit/**/*.tsx',
    ],
    rules: {
      'no-restricted-imports': webBoundaryRule,
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
