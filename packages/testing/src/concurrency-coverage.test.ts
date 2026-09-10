import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The consolidated concurrency coverage gate (build-plan §Phase 22, CLAUDE.md §6).
 *
 * Every idempotent command the API claims is in the manifest, every raced
 * command names a GATE-CONC suite that calls its method, every unraced one
 * says why, and the kernel's idempotency proofs are still there by title.
 * Then the check is shown to fail when any of that is untrue.
 */
const repoRoot = resolve(__dirname, '../../..');

async function load() {
  const coverage = (await import(resolve(repoRoot, 'tools/concurrency-coverage.mjs'))) as {
    runConcurrencyCoverage: (input: { root: string; manifest: readonly ManifestEntry[] }) => {
      problems: string[];
      operations: number;
      raced: number;
      duplicateSubmitOnly: number;
      suites: number;
    };
  };
  const manifest = (await import(resolve(repoRoot, 'tools/concurrency-manifest.mjs'))) as {
    CONCURRENCY_MANIFEST: readonly ManifestEntry[];
  };
  return { ...coverage, manifest: manifest.CONCURRENCY_MANIFEST };
}

interface ManifestEntry {
  readonly operation: string;
  readonly method: string;
  readonly raced: boolean;
  readonly suites?: readonly string[];
  readonly reason?: string;
}

describe('concurrency coverage', () => {
  it('every idempotent command is in the manifest, raced by a GATE-CONC suite or explained', async () => {
    const { runConcurrencyCoverage, manifest } = await load();
    const result = runConcurrencyCoverage({ root: repoRoot, manifest });
    expect(result.problems).toEqual([]);
    expect(result.operations).toBeGreaterThan(140);
    expect(result.raced).toBeGreaterThan(60);
    expect(result.suites).toBeGreaterThan(15);
  });

  it('fails when a command loses its entry', async () => {
    const { runConcurrencyCoverage, manifest } = await load();
    const without = manifest.filter((entry) => entry.operation !== 'stay.check_in');
    const result = runConcurrencyCoverage({ root: repoRoot, manifest: without });
    expect(
      result.problems.some((p) => p.startsWith('stay.check_in') && p.includes('no manifest entry')),
    ).toBe(true);
  });

  it('fails when a raced command names a suite that does not call its method', async () => {
    const { runConcurrencyCoverage, manifest } = await load();
    const mutated = manifest.map((entry) =>
      entry.operation === 'stay.check_in'
        ? { ...entry, suites: ['apps/api/src/modules/review/review.concurrency.test.ts'] }
        : entry,
    );
    const result = runConcurrencyCoverage({ root: repoRoot, manifest: mutated });
    expect(result.problems.some((p) => p.includes('never calls .checkIn('))).toBe(true);
  });

  it('fails when an unraced command carries no reason, or a suite is outside GATE-CONC', async () => {
    const { runConcurrencyCoverage, manifest } = await load();
    const noReason = manifest.map((entry) =>
      entry.operation === 'catalog.finalize_retirement'
        ? { ...entry, raced: false, reason: '' }
        : entry,
    );
    expect(
      runConcurrencyCoverage({ root: repoRoot, manifest: noReason }).problems.some((p) =>
        p.includes('no reason recorded'),
      ),
    ).toBe(true);
    const outside = manifest.map((entry) =>
      entry.operation === 'stay.check_in'
        ? { ...entry, suites: ['apps/api/src/modules/stay/stay.integration.test.ts'] }
        : entry,
    );
    expect(
      runConcurrencyCoverage({ root: repoRoot, manifest: outside }).problems.some((p) =>
        p.includes('not part of GATE-CONC'),
      ),
    ).toBe(true);
  });

  it('fails when the manifest names a command nobody claims', async () => {
    const { runConcurrencyCoverage, manifest } = await load();
    const extra = [
      ...manifest,
      {
        operation: 'ghost.command',
        method: 'ghost',
        raced: false,
        reason: 'a command that was deleted',
      },
    ];
    expect(
      runConcurrencyCoverage({ root: repoRoot, manifest: extra }).problems.some((p) =>
        p.startsWith('ghost.command'),
      ),
    ).toBe(true);
  });
});
