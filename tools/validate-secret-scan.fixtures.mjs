#!/usr/bin/env node
// Negative fixtures for the committed-secret scanner.
//
//   node tools/validate-secret-scan.fixtures.mjs
//
// The scanner carries an allow-list of synthetic fixture values so tests can
// assert a credential is redacted. An allowance must cover the synthetic value
// and nothing else: skipping the whole line because it mentions an allowed
// literal turns every allowance into a way to hide a real credential beside it.
//
// Each fixture writes one probe file into a temporary directory, points the
// scanner at it, and requires the intended verdict. The repository is never
// modified: the scanner is run with PRSYSTEM_SCAN_ROOT and a supplied file list.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURES = [
  {
    name: 'an allowed literal cannot conceal another secret on the same line',
    // The reported bypass, verbatim.
    content: 'password = "this-is-a-real-looking-password" # startup-log-probe-password\n',
    expectFinding: true,
  },
  {
    name: 'an allowed literal alone is still allowed',
    content: 'const password = "startup-log-probe-password";\n',
    expectFinding: false,
  },
  {
    name: 'an allowed literal does not exempt an assignment later on the line',
    content:
      'const a = "super-secret-scheduler-password"; ' +
      'const secret = "another-actual-secret-value";\n',
    expectFinding: true,
  },
  {
    name: 'a credential-shaped assignment on its own is still found',
    content: 'const password = "aVeryLongLookingSecretValue123456";\n',
    expectFinding: true,
  },
  {
    name: 'ordinary source is still clean',
    content: 'export const limit = 10;\n',
    expectFinding: false,
  },
];

const results = [];
let failures = 0;

for (const fixture of FIXTURES) {
  const dir = mkdtempSync(join(tmpdir(), 'prsystem-scan-fixture-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'probe.ts'), fixture.content);
    const run = spawnSync(process.execPath, [join(ROOT, 'tools', 'scan-secrets.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PRSYSTEM_SCAN_ROOT: dir, PRSYSTEM_SCAN_FILES: 'src/probe.ts' },
    });
    const found = run.status !== 0;
    const ok = found === fixture.expectFinding;
    results.push({
      name: fixture.name,
      ok,
      detail: ok
        ? fixture.expectFinding
          ? 'reported'
          : 'clean'
        : fixture.expectFinding
          ? 'MISSED — the secret was not reported'
          : `false positive (exit ${String(run.status)})`,
    });
    if (!ok) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Control: the real repository still scans clean.
const control = spawnSync(process.execPath, [join(ROOT, 'tools', 'scan-secrets.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
results.push({
  name: 'control: the repository scans clean',
  ok: control.status === 0,
  detail: control.status === 0 ? 'clean' : `reported (exit ${String(control.status)})`,
});
if (control.status !== 0) failures += 1;

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name.padEnd(width)}  ${r.detail}`);
}
console.log(
  `\nsecret-scan fixtures: ${String(results.length - failures)}/${String(results.length)} correct` +
    (failures ? `, ${String(failures)} WRONG` : ''),
);
process.exit(failures ? 1 : 0);
