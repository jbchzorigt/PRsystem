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
