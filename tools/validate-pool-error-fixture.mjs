#!/usr/bin/env node
// Proves an unexpected idle-pool error fails an ordinary suite.
//
//   node tools/validate-pool-error-fixture.mjs
//
// The fixture uses `createTestDatabase`, opens a pool, provokes a termination
// that is *not* an expected teardown, and never calls the assertion itself. Its
// own test passes. The run must still exit non-zero, because `drop()` checks the
// database's own account — otherwise the accounting catches nothing unless a
// suite remembers to ask, which is the defect this replaced.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'test-fixtures/unexpected-pool-error.test.ts';

const run = spawnSync(
  'pnpm',
  ['--filter', '@prsystem/db', 'exec', 'vitest', 'run', FIXTURE, '--reporter=dot'],
  { cwd: ROOT, encoding: 'utf8' },
);

const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
const failedForTheRightReason = /unexpected pool error/i.test(output);
const exitedNonZero = run.status !== 0;

// The fixture's own test must have passed: if it failed for some other reason
// the non-zero exit proves nothing about the pool accounting.
const ownTestPassed = /1 passed/.test(output);

const checks = [
  {
    name: 'the fixture run exits non-zero',
    ok: exitedNonZero,
    detail: `exit ${String(run.status)}`,
  },
  {
    name: 'it fails for the pool-error reason',
    ok: failedForTheRightReason,
    detail: failedForTheRightReason ? 'reported an unexpected pool error' : 'no pool-error message',
  },
  {
    name: "the fixture's own test passed",
    ok: ownTestPassed,
    detail: ownTestPassed ? '1 passed' : 'the test itself did not pass',
  },
];

const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks)
  console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(width)}  ${c.detail}`);
const failures = checks.filter((c) => !c.ok).length;
console.log(
  `\npool-error fixture: ${String(checks.length - failures)}/${String(checks.length)} checks passed`,
);
process.exit(failures ? 1 : 0);
