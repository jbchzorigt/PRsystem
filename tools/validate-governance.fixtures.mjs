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
    name: 'catalogue: the section heading removed',
    file: 'runbook',
    expect: /no "### GATE-SEC sub-gate catalogue" section/,
    mutate: (text) => text.replace('### GATE-SEC sub-gate catalogue', '### Required check detail'),
  },
  {
    // A complete, correct-looking catalogue placed earlier in the file, while
    // the real one loses an entry. Taking the first match in the document
    // accepted this.
    name: 'catalogue: a complete decoy before the real one',
    file: 'runbook',
    expect: /the catalogue omits SEC-SCHEDULER/,
    mutate: (text) => {
      const decoy = [
        '## Appendix (decoy)',
        '',
        '`GATE-SEC` aggregates **eighteen** sub-gates:',
        '',
        '`SEC-ROLE`, `SEC-RLS`, `SEC-ACL-MATRIX`, `SEC-OWNERSHIP`, `SEC-LOCK-EVIDENCE`,',
        '`SEC-POOL-ERRORS`, `SEC-BOOTSTRAP`, `SEC-SCHEDULER`, `SEC-MAINTENANCE`,',
        '`SEC-STARTUP`, `SEC-STARTUP-WORKER`, `SEC-REGRESSION`, `SEC-AUDIT`,',
        '`SEC-PARTITION`, `SEC-POLICE-ISOLATION`, `SEC-KMS`, `SEC-PII-LEAK`,',
        '`SEC-SECRETS`.',
        '',
      ].join('\n');
      return `${decoy}${text.replace('`SEC-SCHEDULER`, ', '')}`;
    },
  },
  {
    // The canonical evidence label naming a different repair from the one the
    // current position and the newest section name. The check derives both
    // ordinals from the document, so this fixture mutates the label alone and
    // does not depend on which repair happens to be current.
    name: 'evidence: the measured-on label names an older repair',
    file: 'phase-status',
    expect: /measured on the [a-z]+-repair tree"; the current position/,
    mutate: (text) => {
      const current = /Measured on the ([a-z]+)-repair tree/.exec(text)?.[1];
      if (current === undefined) throw new Error('no "Measured on the …-repair tree" label');
      const older = current === 'ninth' ? 'eighth' : 'ninth';
      return text.replace(
        `Measured on the ${current}-repair tree`,
        `Measured on the ${older}-repair tree`,
      );
    },
  },
  {
    name: 'evidence: the measured-on label removed entirely',
    file: 'phase-status',
    expect: /does not say which repair tree it was measured on/,
    mutate: (text) =>
      text.replace(/Measured on the [a-z]+-repair tree\./, 'Measured on the final tree.'),
  },
  {
    name: 'ledger: an N/N ratio restated',
    file: 'phase-status',
    expect: /ledger row restates an N\/N ratio/,
    mutate: (text) =>
      text.replace(/^(\| 03 \| Platform kernel \|[^\n]*)$/m, (row) =>
        row.replace('the full battery', 'the full battery, 15/15 checks'),
      ),
  },
  {
    name: 'ledger: a test count restated',
    file: 'phase-status',
    expect: /ledger row restates a test count/,
    mutate: (text) =>
      text.replace(/^(\| 03 \| Platform kernel \|[^\n]*)$/m, (row) =>
        row.replace('the full battery', 'the full battery, 999 tests'),
      ),
  },
  {
    name: 'gate battery: a check count restated',
    file: 'phase-status',
    // `15/15 checks` is both a ratio and a check count; the ratio pattern is
    // listed first, so that is the diagnostic.
    expect: /gate battery restates an N\/N ratio/,
    mutate: (text) =>
      text.replace(
        'node tools/validate-governance.mjs                       # GATE-GOV',
        'node tools/validate-governance.mjs                       # GATE-GOV — 15/15 checks',
      ),
  },
  {
    name: 'gate battery: moved outside its markers',
    file: 'phase-status',
    expect: /gate battery is outside the canonical evidence section/,
    mutate: (text) => {
      const open = '<!-- phase-03-gate-battery:begin -->';
      const close = '<!-- phase-03-gate-battery:end -->';
      const from = text.indexOf(open);
      const to = text.indexOf(close) + close.length;
      const block = text.slice(from, to);
      // Removed from the canonical section and dropped into the Phase 00 record,
      // which is exactly where it used to be.
      return text
        .slice(0, from)
        .replace('## Phase 00 record', `## Phase 00 record\n\n${block}\n`)
        .concat(text.slice(to));
    },
  },
  {
    name: 'gate battery: markers removed',
    file: 'phase-status',
    expect: /gate battery has no bounding markers/,
    mutate: (text) => text.replace('<!-- phase-03-gate-battery:begin -->', ''),
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
    name: 'canonical section: duplicated',
    file: 'phase-status',
    expect: /found 2/,
    mutate: (text) =>
      text.replace(
        '## Current Phase 03 evidence',
        '## Current Phase 03 evidence\n\n(placeholder)\n\n## Current Phase 03 evidence',
      ),
  },
  {
    name: 'canonical section: removed',
    file: 'phase-status',
    expect: /found 0/,
    mutate: (text) => text.replace(/^## Current Phase 03 evidence$/m, '## Evidence'),
  },
  {
    name: 'current position: a stale review number',
    file: 'phase-status',
    expect: /says "nine" reviews and "eleventh" repair/,
    mutate: (text) =>
      text.replace('eleven customer reviews completed', 'nine customer reviews completed'),
  },
  {
    name: 'current position: a stale repair ordinal',
    file: 'phase-status',
    expect: /names the ninth repair; the last section is the eleventh/,
    mutate: (text) =>
      text
        .replace('eleven customer reviews completed', 'nine customer reviews completed')
        .replace('the eleventh repair is implemented', 'the ninth repair is implemented'),
  },
  {
    name: 'a historical section reclaims the current counts',
    file: 'phase-status',
    expect: /superseded section still claims to be current/,
    mutate: (text) =>
      text.replace(
        '> **Historical snapshot.** Superseded. Current results are in',
        '> **This section holds the current counts.** Superseded. Current results are in',
      ),
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
