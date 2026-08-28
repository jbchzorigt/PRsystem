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

import { spawnSync } from 'node:child_process';
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
    name: 'step disabled with if: false',
    mutate: (yaml) =>
      yaml.replace(
        REGRESSION_STEP,
        `${REGRESSION_STEP.split('\n')[0]}\n        if: false\n${REGRESSION_STEP.split('\n')[1]}`,
      ),
  },
  {
    name: 'expression-based continue-on-error',
    mutate: (yaml) =>
      yaml.replace(
        REGRESSION_STEP,
        `${REGRESSION_STEP.split('\n')[0]}\n        continue-on-error: \${{ github.event_name == 'push' }}\n${REGRESSION_STEP.split('\n')[1]}`,
      ),
  },
  {
    name: 'governance loses its pnpm install',
    mutate: (yaml) =>
      yaml.replace(
        `      - name: Install (frozen lockfile)
        run: pnpm install --frozen-lockfile
      - name: Validate governance documents`,
        '      - name: Validate governance documents',
      ),
  },
  {
    name: 'governance loses its pnpm setup',
    mutate: (yaml) =>
      yaml.replace(
        `      - uses: pnpm/action-setup@v4
        with:
          version: \${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}
          cache: pnpm
      # The validators below are pnpm scripts`,
        `      - uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}
      # The validators below are pnpm scripts`,
      ),
  },
  {
    // A step-level `if:` was rejected; a job-level one was not. `jobs.gate-sec.if:
    // false` disables the entire gate, and every step inside it, without
    // touching a single step.
    name: 'required job disabled with if: false',
    expect: /job 'gate-sec' is not disabled/,
    mutate: (yaml) =>
      yaml.replace(
        '  gate-sec:\n    name: GATE-SEC',
        '  gate-sec:\n    if: false\n    name: GATE-SEC',
      ),
  },
  {
    // Installing before pnpm exists fails on a clean runner. Only
    // install-before-first-use was ordered; setup-before-install was not.
    name: 'pnpm setup after the install that needs it',
    expect: /'governance' sets pnpm up before installing/,
    mutate: (yaml) =>
      yaml.replace(
        `      - uses: pnpm/action-setup@v4
        with:
          version: \${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}
          cache: pnpm
      # The validators below are pnpm scripts`,
        `      - uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}
      - name: Install (frozen lockfile)
        run: pnpm install --frozen-lockfile
      - uses: pnpm/action-setup@v4
        with:
          version: \${{ env.PNPM_VERSION }}
      # The validators below are pnpm scripts`,
      ),
  },
  {
    // The pnpm-job list was hard-coded, so a job added later was never checked
    // at all — the exact situation the governance job was once in.
    name: 'a newly added pnpm job with no setup or install',
    expect: /'extra-checks' sets pnpm up before using it/,
    mutate: (yaml) =>
      `${yaml}
  extra-checks:
    name: extra checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Something useful
        run: pnpm run lint
`,
  },
  {
    // GitHub runs `shell: bash -c 'true' {0}` by executing `true` and never the
    // script. The `run:` line is still exactly right, so an exact-line check
    // reads it as correct and the gate never runs.
    name: 'custom shell template on a blocking gate step',
    expect: /shell/i,
    mutate: (yaml) =>
      yaml.replace(
        REGRESSION_STEP,
        `${REGRESSION_STEP.split('\n')[0]}\n        shell: bash -c 'true' {0}\n${REGRESSION_STEP.split('\n')[1]}`,
      ),
  },
  {
    // A required stage disappears while the validator stays green, because it
    // only ever required a subset of the blocking commands.
    name: 'the migration gate removed from the compose job',
    expect: /pnpm run test:migrations/,
    mutate: (yaml) =>
      yaml.replace(
        `      - name: Migration gate against real PostgreSQL
        run: pnpm run test:migrations
        env:
          DATABASE_URL: postgresql://prsystem:prsystem_local_dev@127.0.0.1:55442/prsystem
`,
        '',
      ),
  },
  {
    name: 'the E2E suite removed from its job',
    expect: /pnpm run test:e2e/,
    mutate: (yaml) =>
      yaml.replace(
        `      - name: Portal shell smoke tests
        run: pnpm run test:e2e
`,
        '',
      ),
  },
  {
    name: 'the production audit removed from verify',
    expect: /pnpm run audit:prod/,
    mutate: (yaml) =>
      yaml.replace(
        `      - name: Audit production dependencies
        run: pnpm run audit:prod
`,
        '',
      ),
  },
  {
    name: 'the compose cleanup step removed',
    expect: /docker compose down -v/,
    mutate: (yaml) =>
      yaml.replace(
        `      - name: Stop backing services
        if: always()
        run: docker compose down -v

  # A distinct job`,
        `
  # A distinct job`,
      ),
  },
  {
    // The exact command is still there, on its own line, with an `exit 0` above
    // it. The step succeeds without ever reaching the gate.
    name: 'exit 0 before the exact command',
    expect: /runs only its own command|exit 0/,
    mutate: (yaml) =>
      yaml.replace(
        '        run: pnpm run test:regression',
        '        run: |\n          exit 0\n          pnpm run test:regression',
      ),
  },
  {
    // A workflow-level default shell applies to every `run` step in every job,
    // so one line at the top of the file disables all of them.
    name: 'workflow-level default shell',
    expect: /workflow.*default shell|defaults\.run\.shell/i,
    mutate: (yaml) =>
      yaml.replace(
        'concurrency:',
        "defaults:\n  run:\n    shell: bash -c 'true' {0}\n\nconcurrency:",
      ),
  },
  {
    // The same thing scoped to one required job.
    name: 'job-level default shell on gate-sec',
    expect: /gate-sec.*default shell|defaults\.run\.shell/i,
    mutate: (yaml) =>
      yaml.replace(
        '  gate-sec:\n    name: GATE-SEC',
        "  gate-sec:\n    defaults:\n      run:\n        shell: bash -c 'true' {0}\n    name: GATE-SEC",
      ),
  },
  {
    // Teardown that only runs when everything succeeded is teardown that never
    // runs when it matters.
    name: 'compose teardown loses its if: always()',
    expect: /teardown that still runs after a failure/,
    mutate: (yaml) =>
      yaml.replace(
        `      - name: Stop backing services
        if: always()
        run: docker compose down -v

  # A distinct job`,
        `      - name: Stop backing services
        run: docker compose down -v

  # A distinct job`,
      ),
  },
  {
    // A required step that is not teardown must not carry a condition at all.
    name: 'a required gate gains an if: condition',
    expect: /must not be conditional|if:/,
    mutate: (yaml) =>
      yaml.replace(
        `      - name: Run the fail-closed security aggregator
        run: pnpm run test:security`,
        `      - name: Run the fail-closed security aggregator
        if: \${{ github.event_name == 'push' }}
        run: pnpm run test:security`,
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

/** True when the validator printed a FAIL line matching `expected`. */
function failedFor(output, expected) {
  return output
    .split('\n')
    .filter((line) => line.startsWith('[FAIL]'))
    .some((line) => expected.test(line));
}

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
    // The validator must reject the mutated workflow, and — where the fixture
    // says which check should catch it — reject it for that reason. A non-zero
    // exit alone would be satisfied by any unrelated failure.
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    const rejected = run.status !== 0;
    const diagnosed = fixture.expect === undefined ? true : failedFor(output, fixture.expect);
    results.push({
      name: fixture.name,
      ok: rejected && diagnosed,
      detail: !rejected
        ? 'ACCEPTED — the bypass was not caught'
        : diagnosed
          ? `rejected (exit ${String(run.status)})`
          : `rejected, but not by ${String(fixture.expect)}`,
    });
    if (!rejected || !diagnosed) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Root-script bypasses. The validator reads package.json from ROOT, so each of
// these is applied to a temporary copy of the repository's package.json that the
// validator is pointed at through PRSYSTEM_ROOT_PACKAGE_JSON.
const packageJsonPath = join(ROOT, 'package.json');
const originalPackageJson = readFileSync(packageJsonPath, 'utf8');

/**
 * The real `test:security` script, split into its stages.
 *
 * Every fixture below is built from *this*, not from a hand-written string. The
 * previous fixtures were hand-written and had drifted: each of them had silently
 * dropped `validate-pool-error-fixture.mjs`, so each mutated several properties
 * at once and would have been rejected even without the bypass it was named for.
 */
const REAL_SCRIPT = String(JSON.parse(originalPackageJson).scripts['test:security'] ?? '');
const REAL_STAGES = REAL_SCRIPT.split('&&')
  .map((stage) => stage.trim())
  .filter((stage) => stage.length > 0);

/** The stage each fixture mutates: the coverage validator itself. */
const TARGET = REAL_STAGES.findIndex((stage) =>
  stage.endsWith('tools/validate-regression-coverage.mjs'),
);
const POOL_STAGE = REAL_STAGES.find((stage) => stage.includes('validate-pool-error-fixture.mjs'));

const mapTarget = (fn) => REAL_STAGES.map((stage, i) => (i === TARGET ? fn(stage) : stage));

const SCRIPT_FIXTURES = [
  {
    name: 'script: echoed stage',
    build: () => mapTarget((stage) => `echo ${stage}`).join(' && '),
    expect: /contains an echoed or no-op command/,
  },
  {
    name: 'script: piped stage',
    build: () => mapTarget((stage) => `${stage} | tee out.txt`).join(' && '),
    expect: /contains a pipe/,
  },
  {
    name: 'script: || true',
    build: () => mapTarget((stage) => `${stage} || true`).join(' && '),
    expect: /contains \|\|/,
  },
  {
    name: 'script: semicolon chain',
    build: () => REAL_STAGES.join(' ; '),
    expect: /contains ;/,
  },
  {
    name: 'script: shell conditional',
    build: () => mapTarget((stage) => `if ${stage}; then true; fi`).join(' && '),
    expect: /shell conditional or loop/,
  },
  {
    name: 'script: backgrounded',
    build: () => `${REAL_STAGES.join(' && ')} &`,
    expect: /contains backgrounding/,
  },
  {
    name: 'script: dropped stage',
    build: () => REAL_STAGES.filter((_, i) => i !== TARGET).join(' && '),
    expect: /runs exactly the required stages/,
    // The one fixture that legitimately removes a stage.
    drops: TARGET,
  },
  {
    name: 'script: fake command name',
    build: () => mapTarget((stage) => `${stage}-DISABLED`).join(' && '),
    expect: /runs exactly the required stages/,
  },
];

// The fixture set is only meaningful if it is anchored to a real script.
results.push({
  name: 'script fixtures are built from the real test:security',
  ok: TARGET >= 0 && POOL_STAGE !== undefined && REAL_STAGES.length >= 5,
  detail: `${String(REAL_STAGES.length)} stage(s), target ${String(TARGET)}`,
});
if (!(TARGET >= 0 && POOL_STAGE !== undefined && REAL_STAGES.length >= 5)) failures += 1;

for (const fixture of SCRIPT_FIXTURES) {
  const value = fixture.build();

  // The mutation must have happened, and must be the only one: every stage the
  // fixture did not target — `validate-pool-error-fixture.mjs` included — is
  // still present, so the rejection cannot be blamed on collateral damage.
  const changed = value !== REAL_SCRIPT;
  const preserved = REAL_STAGES.every((stage, i) => i === fixture.drops || value.includes(stage));
  const poolStageKept = fixture.drops === undefined ? value.includes(POOL_STAGE) : true;
  if (!changed || !preserved || !poolStageKept) {
    results.push({
      name: fixture.name,
      ok: false,
      detail: !changed
        ? 'fixture did not change the script'
        : !poolStageKept
          ? 'fixture dropped the pool-error stage it was not meant to touch'
          : 'fixture disturbed a stage it was not meant to touch',
    });
    failures += 1;
    continue;
  }

  const parsed = JSON.parse(originalPackageJson);
  parsed.scripts['test:security'] = value;
  const dir = mkdtempSync(join(tmpdir(), 'prsystem-script-fixture-'));
  const path = join(dir, 'package.json');
  try {
    writeFileSync(path, JSON.stringify(parsed, null, 2));
    const run = spawnSync(
      process.execPath,
      [join(ROOT, 'tools', 'validate-regression-coverage.mjs')],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PRSYSTEM_ROOT_PACKAGE_JSON: path } },
    );
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    const rejected = run.status !== 0;
    const diagnosed = failedFor(output, fixture.expect);
    results.push({
      name: fixture.name,
      ok: rejected && diagnosed,
      detail: !rejected
        ? 'ACCEPTED — the bypass was not caught'
        : diagnosed
          ? `rejected (exit ${String(run.status)})`
          : `rejected, but not by ${String(fixture.expect)}`,
    });
    if (!rejected || !diagnosed) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

results.push({
  name: 'control: package.json is unmodified',
  ok: readFileSync(packageJsonPath, 'utf8') === originalPackageJson,
  detail:
    readFileSync(packageJsonPath, 'utf8') === originalPackageJson ? 'byte-identical' : 'MODIFIED',
});
if (readFileSync(packageJsonPath, 'utf8') !== originalPackageJson) failures += 1;

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
