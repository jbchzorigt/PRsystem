#!/usr/bin/env node
// Automated negative fixtures for `validate-regression-coverage`.
//
//   node tools/validate-regression-coverage.fixtures.mjs
//
// A validator nobody has watched fail is a validator nobody knows works. Each
// fixture applies one bypass to a *copy* of the workflow, runs the validator
// against it, and requires a non-zero exit. The real `ci.yml` is never modified:
// the copy is written to a temporary directory and the validator is pointed at
// it through PRSYSTEM_CI_WORKFLOW.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');
const original = readFileSync(WORKFLOW, 'utf8');

const REGRESSION_STEP = `      - name: Complete regression suite against real PostgreSQL
        run: pnpm run test:regression`;

/** Each fixture returns a mutated workflow, and names the bypass it introduces. */
const FIXTURES = [
  {
    name: 'commented-out command',
    mutate: (yaml) =>
      yaml.replace(
        '        run: pnpm run test:regression',
        '        run: |\n          # pnpm run test:regression',
      ),
  },
  {
    name: 'continue-on-error: true',
    mutate: (yaml) =>
      yaml.replace(
        REGRESSION_STEP,
        `${REGRESSION_STEP.split('\n')[0]}\n        continue-on-error: true\n${REGRESSION_STEP.split('\n')[1]}`,
      ),
  },
  {
    name: 'command in the wrong job',
    mutate: (yaml) =>
      yaml.replace('        run: pnpm run test:regression', '        run: pnpm run test:unit'),
  },
  {
    name: 'missing database environment',
    mutate: (yaml) =>
      yaml.replace(
        `${REGRESSION_STEP}
        env:
          DATABASE_URL: postgresql://prsystem:prsystem_local_dev@127.0.0.1:55442/prsystem`,
        REGRESSION_STEP,
      ),
  },
  {
    name: 'missing build dependency',
    mutate: (yaml) =>
      yaml.replace(
        `      - name: Build workspace packages from this checkout
        run: pnpm run build
      # GATE-MIGR`,
        '      # GATE-MIGR',
      ),
  },
  {
    name: '|| true appended',
    mutate: (yaml) =>
      yaml.replace(
        '        run: pnpm run test:regression',
        '        run: pnpm run test:regression || true',
      ),
  },
  {
    name: '; true appended',
    mutate: (yaml) =>
      yaml.replace(
        '        run: pnpm run test:regression',
        '        run: pnpm run test:regression ; true',
      ),
  },
  {
    name: 'piped into a status swallower',
    mutate: (yaml) =>
      yaml.replace(
        '        run: pnpm run test:regression',
        '        run: pnpm run test:regression | tee out.txt',
      ),
  },
  {
    name: 'backgrounded',
    mutate: (yaml) =>
      yaml.replace(
        '        run: pnpm run test:regression',
        '        run: pnpm run test:regression &',
      ),
  },
  {
    name: 'echoed instead of run',
    mutate: (yaml) =>
      yaml.replace(
        '        run: pnpm run test:regression',
        '        run: echo pnpm run test:regression',
      ),
  },
  {
    name: 'build after the suite it must precede',
    mutate: (yaml) => {
      const build = `      - name: Build workspace packages from this checkout
        run: pnpm run build
`;
      return yaml
        .replace(build, '')
        .replace(
          `      - name: Report service state`,
          `${build}      - name: Report service state`,
        );
    },
  },
];

let failures = 0;
const results = [];

for (const fixture of FIXTURES) {
  const mutated = fixture.mutate(original);
  if (mutated === original) {
    results.push({ name: fixture.name, ok: false, detail: 'fixture did not change the workflow' });
    failures += 1;
    continue;
  }

  const dir = mkdtempSync(join(tmpdir(), 'prsystem-ci-fixture-'));
  const path = join(dir, 'ci.yml');
  try {
    writeFileSync(path, mutated);
    const run = spawnSync(
      process.execPath,
      [join(ROOT, 'tools', 'validate-regression-coverage.mjs')],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, PRSYSTEM_CI_WORKFLOW: path },
      },
    );
    // The validator must reject the mutated workflow.
    const rejected = run.status !== 0;
    results.push({
      name: fixture.name,
      ok: rejected,
      detail: rejected
        ? `rejected (exit ${String(run.status)})`
        : 'ACCEPTED — the bypass was not caught',
    });
    if (!rejected) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// And the unmodified workflow must still pass, or the fixtures prove nothing.
const control = spawnSync(
  process.execPath,
  [join(ROOT, 'tools', 'validate-regression-coverage.mjs')],
  {
    cwd: ROOT,
    encoding: 'utf8',
  },
);
results.push({
  name: 'control: the real workflow passes',
  ok: control.status === 0,
  detail: control.status === 0 ? 'accepted' : `rejected (exit ${String(control.status)})`,
});
if (control.status !== 0) failures += 1;

// The real workflow must be untouched by this run.
const unchanged = readFileSync(WORKFLOW, 'utf8') === original;
results.push({
  name: 'control: ci.yml is unmodified',
  ok: unchanged,
  detail: unchanged ? 'byte-identical' : 'THE WORKFLOW WAS MODIFIED',
});
if (!unchanged) failures += 1;

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name.padEnd(width)}  ${r.detail}`);
}
console.log(
  `\nCI bypass fixtures: ${String(results.length - failures)}/${String(results.length)} caught` +
    (failures ? `, ${String(failures)} NOT CAUGHT` : ''),
);
process.exit(failures ? 1 : 0);
