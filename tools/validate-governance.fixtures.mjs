#!/usr/bin/env node
// Negative fixtures for the two Phase 03 governance drift checks.
//
//   node tools/validate-governance.fixtures.mjs
//
// A check nobody has watched fail is a check nobody knows works. Both of these
// exist because a document went stale silently — a GATE-SEC catalogue listing
// eight of eighteen sub-gates, and a ledger restating counts that had drifted
// from the section below it. Each fixture mutates one property of a *copy* and
// requires the validator to fail for that specific reason. The real documents
// are never modified.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNBOOK = join(ROOT, 'docs', 'implementation', 'database-bootstrap-runbook.md');
const PHASE_STATUS = join(ROOT, 'docs', 'implementation', 'phase-status.md');
const originalRunbook = readFileSync(RUNBOOK, 'utf8');
const originalPhaseStatus = readFileSync(PHASE_STATUS, 'utf8');

const FIXTURES = [
  {
    name: 'catalogue: a sub-gate removed',
    file: 'runbook',
    expect: /the catalogue omits SEC-SCHEDULER/,
    mutate: (text) => text.replace('`SEC-SCHEDULER`, ', ''),
  },
  {
    name: 'catalogue: the stated count no longer matches',
    file: 'runbook',
    expect: /says "seventeen" sub-gates, configuration has 18/,
    mutate: (text) =>
      text.replace('aggregates **eighteen** sub-gates', 'aggregates **seventeen** sub-gates'),
  },
  {
    name: 'catalogue: the section removed entirely',
    file: 'runbook',
    expect: /no GATE-SEC catalogue section/,
    mutate: (text) =>
      text.replace(/aggregates \*\*[a-z]+\*\* sub-gates:/, 'aggregates the sub-gates:'),
  },
  {
    name: 'ledger: a fake test count restated',
    file: 'phase-status',
    expect: /mutable count is restated outside the canonical section/,
    mutate: (text) =>
      text.replace(/^(\| 03 \| Platform kernel \|[^\n]*)$/m, (row) =>
        row.replace('the full battery', 'the full battery, GATE-SEC 999 tests'),
      ),
  },
  {
    name: 'gate battery: a fake test count restated',
    file: 'phase-status',
    expect: /mutable count is restated outside the canonical section/,
    mutate: (text) =>
      text.replace(
        'pnpm run test:security                                   # GATE-SEC',
        'pnpm run test:security                                   # GATE-SEC — 999 tests',
      ),
  },
  {
    name: 'ledger: the canonical link removed',
    file: 'phase-status',
    expect: /ledger row does not link/,
    mutate: (text) =>
      text.replace(/^(\| 03 \| Platform kernel \|[^\n]*)$/m, (row) =>
        row.replace(
          /\[Current Phase 03 evidence\]\(#current-phase-03-evidence\)/,
          'the evidence section',
        ),
      ),
  },
  {
    name: 'gate battery: the canonical link changed',
    file: 'phase-status',
    expect: /gate-battery block does not link/,
    mutate: (text) =>
      text.replace(
        'one place — [Current Phase 03 evidence](#current-phase-03-evidence) —',
        'one place — [Current Phase 03 evidence](#somewhere-else) —',
      ),
  },
  {
    name: 'canonical section: duplicated',
    file: 'phase-status',
    expect: /expected exactly one .* section, found 2/,
    mutate: (text) =>
      text.replace(
        '## Current Phase 03 evidence',
        '## Current Phase 03 evidence\n\n(placeholder)\n\n## Current Phase 03 evidence',
      ),
  },
  {
    name: 'canonical section: removed',
    file: 'phase-status',
    expect: /expected exactly one .* section, found 0/,
    mutate: (text) => text.replace(/^## Current Phase 03 evidence$/m, '## Evidence'),
  },
];

const results = [];
let failures = 0;

/** True when the validator printed a FAIL line matching `expected`. */
function failedFor(output, expected) {
  return output
    .split('\n')
    .filter((line) => line.startsWith('[FAIL]'))
    .some((line) => expected.test(line));
}

for (const fixture of FIXTURES) {
  const original = fixture.file === 'runbook' ? originalRunbook : originalPhaseStatus;
  const mutated = fixture.mutate(original);
  if (mutated === original) {
    results.push({ name: fixture.name, ok: false, detail: 'fixture did not change the document' });
    failures += 1;
    continue;
  }

  const dir = mkdtempSync(join(tmpdir(), 'prsystem-gov-fixture-'));
  const path = join(dir, 'doc.md');
  try {
    writeFileSync(path, mutated);
    const env = { ...process.env };
    env[fixture.file === 'runbook' ? 'PRSYSTEM_RUNBOOK' : 'PRSYSTEM_PHASE_STATUS'] = path;
    const run = spawnSync(process.execPath, [join(ROOT, 'tools', 'validate-governance.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    const rejected = run.status !== 0;
    const diagnosed = failedFor(output, fixture.expect);
    results.push({
      name: fixture.name,
      ok: rejected && diagnosed,
      detail: !rejected
        ? 'ACCEPTED — the drift was not caught'
        : diagnosed
          ? `rejected (exit ${String(run.status)})`
          : `rejected, but not by ${String(fixture.expect)}`,
    });
    if (!rejected || !diagnosed) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Controls: the real documents are untouched, and unmutated they still pass.
for (const [name, path, original] of [
  ['runbook', RUNBOOK, originalRunbook],
  ['phase-status', PHASE_STATUS, originalPhaseStatus],
]) {
  const unchanged = readFileSync(path, 'utf8') === original;
  results.push({
    name: `control: ${name} is unmodified`,
    ok: unchanged,
    detail: unchanged ? 'byte-identical' : 'THE DOCUMENT WAS MODIFIED',
  });
  if (!unchanged) failures += 1;
}

const control = spawnSync(process.execPath, [join(ROOT, 'tools', 'validate-governance.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
results.push({
  name: 'control: the real documents pass',
  ok: control.status === 0,
  detail: control.status === 0 ? 'accepted' : `rejected (exit ${String(control.status)})`,
});
if (control.status !== 0) failures += 1;

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name.padEnd(width)}  ${r.detail}`);
}
console.log(
  `\ngovernance drift fixtures: ${String(results.length - failures)}/${String(results.length)} caught` +
    (failures ? `, ${String(failures)} NOT CAUGHT` : ''),
);
process.exit(failures ? 1 : 0);
