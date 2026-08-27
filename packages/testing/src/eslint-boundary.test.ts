import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Proves the module-boundary rule actually fires (CLAUDE.md §3, build-plan Phase 02 gate).
 *
 * `tools/lint-fixtures/cross-module-import.ts` imports another module's repository.
 * ESLint must report `no-restricted-imports` for it. If the rule is weakened or
 * removed, this test fails.
 */

const repoRoot = resolve(__dirname, '../../..');

function lintFixture(relativePath: string): Array<{ ruleId: string | null; message: string }> {
  try {
    const stdout = execFileSync(
      'node',
      [
        resolve(repoRoot, 'node_modules/eslint/bin/eslint.js'),
        '--no-ignore',
        '--format',
        'json',
        relativePath,
      ],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(stdout)[0]?.messages ?? [];
  } catch (error) {
    // ESLint exits non-zero when it reports errors; the JSON report is still on stdout.
    const stdout = (error as { stdout?: string }).stdout ?? '';
    if (!stdout) throw error;
    return JSON.parse(stdout)[0]?.messages ?? [];
  }
}

describe('module boundary lint rule', () => {
  it('reports a cross-module repository import', () => {
    const messages = lintFixture('tools/lint-fixtures/cross-module-import.ts');
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');

    expect(restricted.length).toBeGreaterThan(0);
    expect(restricted[0]!.message).toContain('Cross-module repository');
  });
});
