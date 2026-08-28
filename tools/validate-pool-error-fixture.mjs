#!/usr/bin/env node
// Proves an unexpected idle-pool error fails an ordinary suite, for every pool
// a scratch-database lifecycle owns.
//
//   node tools/validate-pool-error-fixture.mjs
//
// Each fixture uses `createTestDatabase`, provokes a termination that is *not*
// an expected teardown, and never calls the assertion itself. Its own test
// passes. The run must still exit non-zero, because `drop()` asserts the whole
// logical scope — otherwise the accounting catches nothing unless a suite
// remembers to ask, which is the defect this replaced.
//
// The three fixtures cover the three places an error can arrive:
//   * a pool on the scratch database;
//   * the coordination pool the lifecycle opened, which connects elsewhere;
//   * a pool nothing can attribute to a database at all.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURES = [
  { name: 'scratch-database pool', file: 'test-fixtures/unexpected-pool-error.test.ts' },
  { name: 'coordination pool', file: 'test-fixtures/admin-pool-error.test.ts' },
  { name: 'unattributed pool', file: 'test-fixtures/unattributed-pool-error.test.ts' },
];

const checks = [];

for (const fixture of FIXTURES) {
  const run = spawnSync(
    'pnpm',
    ['--filter', '@prsystem/db', 'exec', 'vitest', 'run', fixture.file, '--reporter=dot'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;

  checks.push({
    name: `${fixture.name}: the run exits non-zero`,
    ok: run.status !== 0,
    detail: `exit ${String(run.status)}`,
  });
  checks.push({
    name: `${fixture.name}: it fails for the pool-error reason`,
    ok: /unexpected pool error/i.test(output),
    detail: /unexpected pool error/i.test(output)
      ? 'reported an unexpected pool error'
      : 'no pool-error message',
  });
  // The fixture's own test must have passed: if it failed for some other reason
  // the non-zero exit proves nothing about the pool accounting.
  checks.push({
    name: `${fixture.name}: the fixture's own test passed`,
    ok: /1 passed/.test(output),
    detail: /1 passed/.test(output) ? '1 passed' : 'the test itself did not pass',
  });
}

const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks)
  console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(width)}  ${c.detail}`);
const failures = checks.filter((c) => !c.ok).length;
console.log(
  `\npool-error fixtures: ${String(checks.length - failures)}/${String(checks.length)} checks passed`,
);
process.exit(failures ? 1 : 0);
