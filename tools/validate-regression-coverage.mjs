#!/usr/bin/env node
// Proves that no Phase 03 security regression suite is omitted from GATE-SEC.
//
//   node tools/validate-regression-coverage.mjs
//
// A security gate that silently stops running one of its suites is worse than
// one that never had it, because the report still says PASS. This compares three
// things that must agree: the files on disk, the manifest, and what the GATE-SEC
// sub-gate is configured to execute.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { SUB_GATES } from './gate-sec-config.mjs';
import { REQUIRED_JOBS, REQUIRED_JOB_NAMES } from './ci-manifest.mjs';
import { REGRESSION_DIR, REGRESSION_SUITES } from './regression-manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(name);
}

// 1. Every file on disk is in the manifest, and every manifest entry exists.
const dir = join(ROOT, REGRESSION_DIR);
const onDisk = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .sort()
  : [];
const listed = [...REGRESSION_SUITES].sort();

const missingFromManifest = onDisk.filter((f) => !listed.includes(f));
check(
  'every regression suite on disk is listed in the manifest',
  missingFromManifest.length === 0,
  missingFromManifest.length === 0
    ? `${String(onDisk.length)} suite(s)`
    : `not listed: ${missingFromManifest.join(', ')}`,
);

const missingFromDisk = listed.filter((f) => !onDisk.includes(f));
check(
  'every manifest entry exists on disk',
  missingFromDisk.length === 0,
  missingFromDisk.length === 0
    ? `${String(listed.length)} entr(ies)`
    : `missing: ${missingFromDisk.join(', ')}`,
);

// 2. The GATE-SEC sub-gate must execute the whole directory, not one file.
//    The real configuration object is imported, not parsed out of the source.
const subGate = SUB_GATES.find((g) => g.id === 'SEC-REGRESSION');
check(
  'GATE-SEC declares a SEC-REGRESSION sub-gate',
  subGate !== undefined,
  subGate === undefined ? 'no SEC-REGRESSION entry' : `filter ${subGate.filter}`,
);

check(
  'SEC-REGRESSION runs the whole regression directory',
  subGate?.suite === 'src/regression',
  `suite: ${subGate?.suite ?? '(none)'}`,
);

check(
  'SEC-REGRESSION cannot pass with the database unavailable',
  subGate?.needsDatabase === true,
  `needsDatabase: ${String(subGate?.needsDatabase)}`,
);

// 3. Every suite must also be a required artefact, so deleting a file fails the
//    gate rather than quietly reducing its coverage.
const artefacts = subGate?.artefacts ?? [];
for (const suite of listed) {
  const path = `${REGRESSION_DIR}/${suite}`;
  check(
    `SEC-REGRESSION requires ${suite}`,
    artefacts.includes(path),
    artefacts.includes(path) ? 'declared' : 'not in the artefact list',
  );
}

// 4. CI must run each required command as an *exact* executable line in the
//    intended blocking job.
//
//    `run.includes('pnpm run test:regression')` accepts a great deal that is not
//    the command: `pnpm run test:regression || true`, `echo pnpm run
//    test:regression`, `pnpm run test:regression &`, a pipe into something that
//    swallows the status, or a comment. Each of those leaves a workflow that
//    reports success whatever the suite did, so the line is matched exactly.
// The workflow under inspection. Overridable so the negative-fixture harness
// can point this validator at a mutated *copy* without touching the real file.
const WORKFLOW_PATH =
  process.env['PRSYSTEM_CI_WORKFLOW'] ?? join(ROOT, '.github', 'workflows', 'ci.yml');
const workflow = load(readFileSync(WORKFLOW_PATH, 'utf8'));

function stepsOf(jobName) {
  return workflow?.jobs?.[jobName]?.steps ?? [];
}

/** Non-empty, non-comment lines of a step's `run` block. */
function commandLines(step) {
  if (typeof step?.run !== 'string') return [];
  return step.run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Constructs that let a failing command report success anyway. */
const BYPASS_PATTERNS = [
  { re: /\|\|\s*true\b/, why: '|| true' },
  { re: /;\s*true\b/, why: '; true' },
  { re: /\|\|\s*:/, why: '|| :' },
  { re: /\|/, why: 'a pipe, which reports the last command status' },
  { re: /&\s*$/, why: 'backgrounding' },
  { re: /^\s*(echo|printf|true|:)\b/, why: 'an echoed or no-op command' },
  { re: /^\s*set\s+\+e\b/, why: 'set +e' },
];

/**
 * True when the step's executable lines are *exactly* `[command]`.
 *
 * "Some line is the command" accepted a block whose other lines did the damage:
 *
 *     run: |
 *       exit 0
 *       pnpm run test:regression
 *
 * The exact line is present and the gate never runs. A required step does one
 * thing, so its non-comment lines must be that one thing and nothing else.
 */
function runsExactly(step, command) {
  const lines = commandLines(step);
  if (lines.length !== 1 || lines[0] !== command) return false;
  return !BYPASS_PATTERNS.some((pattern) => pattern.re.test(lines[0]));
}

/**
 * True when some line of the step is `command`, whatever else the step does.
 *
 * Used only to locate a step that was *meant* to be the required one, so the
 * diagnostic can say what is wrong with it rather than "no such step".
 */
function mentionsExactly(step, command) {
  return commandLines(step).some((line) => line === command);
}

/** Any bypass construct anywhere in the step, even on another line. */
function bypassIn(step) {
  for (const line of commandLines(step)) {
    for (const pattern of BYPASS_PATTERNS) {
      if (pattern.re.test(line)) return `${pattern.why} in "${line}"`;
    }
  }
  return undefined;
}

function isBlocking(step) {
  const flag = step?.['continue-on-error'];
  return flag === undefined || flag === false || flag === 'false';
}

/**
 * A step must not carry a custom shell template.
 *
 * `shell: bash -c 'true' {0}` executes `true` and never the script, so an
 * exact-line check reads the step as correct while the command never runs.
 * There is no allow-list here on purpose: none of these steps needs a shell
 * other than the runner's default, and an allow-list would be one more thing to
 * keep exact.
 */
function customShell(step) {
  const shell = step?.shell;
  return typeof shell === 'string' && shell.trim().length > 0 ? shell : undefined;
}

/** A `defaults.run.shell` on the workflow or on a job. */
function defaultShell(node) {
  const shell = node?.defaults?.run?.shell;
  return typeof shell === 'string' && shell.trim().length > 0 ? shell : undefined;
}

/**
 * A `working-directory` on a step, or a `defaults.run.working-directory`.
 *
 * Every required command is a root script. Run from a package directory,
 * `pnpm run test:security` is that package's own script rather than the root
 * GATE-SEC aggregator — the step still reads as exactly right and executes
 * something else entirely.
 */
function workingDirectory(node) {
  const direct = node?.['working-directory'];
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;
  const fromDefaults = node?.defaults?.run?.['working-directory'];
  return typeof fromDefaults === 'string' && fromDefaults.trim().length > 0
    ? fromDefaults
    : undefined;
}

// A workflow-level default shell applies to every `run` step in every job, so
// one line at the top of the file disables all of them while every step still
// reads as correct.
const workflowShell = defaultShell(workflow);
check(
  'the workflow declares no default shell',
  workflowShell === undefined,
  workflowShell === undefined ? 'no defaults.run.shell' : `defaults.run.shell: ${workflowShell}`,
);

const workflowDirectory = workingDirectory(workflow);
check(
  'the workflow declares no default working-directory',
  workflowDirectory === undefined,
  workflowDirectory === undefined
    ? 'no defaults.run.working-directory'
    : `defaults.run.working-directory: ${workflowDirectory}`,
);

for (const required of REQUIRED_JOBS) {
  const steps = stepsOf(required.job);
  let previousIndex = -1;

  // The same rule as the workflow default, scoped to one required job.
  const job = workflow?.jobs?.[required.job];
  const jobShell = defaultShell(job);
  check(
    `the '${required.job}' job declares no default shell`,
    jobShell === undefined,
    jobShell === undefined ? 'no defaults.run.shell' : `defaults.run.shell: ${jobShell}`,
  );

  const jobDirectory = workingDirectory(job);
  check(
    `the '${required.job}' job declares no default working-directory`,
    jobDirectory === undefined,
    jobDirectory === undefined
      ? 'no defaults.run.working-directory'
      : `defaults.run.working-directory: ${jobDirectory}`,
  );

  // GitHub skips a job whose dependency was skipped, so one `if: false` on an
  // upstream job silently removes the required one from the run while the
  // required job itself still reads as correct. Validating the whole dependency
  // closure would mean reasoning about every upstream condition; refusing
  // `needs` on a required job is the property that actually has to hold, and it
  // is checkable exactly.
  const needs = job?.needs;
  const declaredNeeds = needs === undefined ? [] : Array.isArray(needs) ? needs : [String(needs)];
  check(
    `the '${required.job}' job depends on no other job`,
    declaredNeeds.length === 0,
    declaredNeeds.length === 0 ? 'no needs' : `needs: ${declaredNeeds.join(', ')}`,
  );

  for (const spec of required.steps) {
    const index = steps.findIndex(
      (candidate, at) => at > previousIndex && runsExactly(candidate, spec.run),
    );
    const step = index >= 0 ? steps[index] : undefined;
    const label = `CI runs '${spec.run}' exactly, in the '${required.job}' job`;

    // When a step mentions the command but is not exactly it, say so: "no such
    // step" would send a reader looking for a missing step rather than at the
    // extra line that disabled the one they have.
    const impostor =
      step === undefined
        ? steps.find((candidate, at) => at > previousIndex && mentionsExactly(candidate, spec.run))
        : undefined;
    check(
      label,
      step !== undefined,
      step !== undefined
        ? `step ${String(index)}: ${step.name ?? '(unnamed)'}`
        : impostor !== undefined
          ? `the step named '${impostor.name ?? '(unnamed)'}' runs more than its own command: ` +
            commandLines(impostor).join(' ; ')
          : `no step whose run line is exactly '${spec.run}'` +
            (previousIndex >= 0 ? ' after the preceding required step' : ''),
    );
    if (step === undefined) continue;
    previousIndex = index;

    const bypass = bypassIn(step);
    check(
      `'${spec.run}' cannot discard its exit status`,
      bypass === undefined,
      bypass ?? 'no bypass construct',
    );

    check(
      `'${spec.run}' is blocking`,
      isBlocking(step),
      `continue-on-error: ${String(step['continue-on-error'] ?? '(absent)')}`,
    );

    const shell = customShell(step);
    check(
      `'${spec.run}' runs under the default shell`,
      shell === undefined,
      shell === undefined ? 'no custom shell' : `shell: ${shell}`,
    );

    const directory = workingDirectory(step);
    check(
      `'${spec.run}' runs from the repository root`,
      directory === undefined,
      directory === undefined ? 'no working-directory' : `working-directory: ${directory}`,
    );

    // `cleanup: true` is consumed, not decorative. Teardown must be
    // unconditional-on-failure — `if: always()` — or it stops running exactly
    // when it matters. Everything else must carry no condition at all.
    const condition = step.if === undefined ? undefined : String(step.if).trim();
    if (spec.cleanup === true) {
      const isAlways = condition === 'always()' || condition === '${{ always() }}';
      check(
        `'${spec.run}' is teardown that still runs after a failure`,
        isAlways,
        isAlways ? `if: ${String(condition)}` : `if: ${String(condition ?? '(absent)')}`,
      );
    } else {
      check(
        `'${spec.run}' must not be conditional`,
        condition === undefined,
        condition === undefined ? 'no if:' : `if: ${condition}`,
      );
    }

    if (spec.needsDatabase === true) {
      const url = step.env?.DATABASE_URL;
      check(
        `'${spec.run}' is given a database`,
        typeof url === 'string' && url.length > 0,
        typeof url === 'string' ? 'DATABASE_URL supplied' : 'no DATABASE_URL',
      );
    }
  }
}

// 4a. No required job may be disabled by a job-level condition.
//
//     Step-level `if:` was rejected and job-level `if:` was not, so
//     `jobs.gate-sec.if: false` switched the whole gate off — every step inside
//     it included — without touching a single step.
for (const jobName of REQUIRED_JOB_NAMES) {
  const job = workflow?.jobs?.[jobName];
  check(
    `the '${jobName}' job exists`,
    job !== undefined,
    job === undefined ? 'not defined in the workflow' : 'defined',
  );
  if (job === undefined) continue;

  const condition = job.if === undefined ? undefined : String(job.if).trim();
  check(
    `job '${jobName}' is not disabled by an if: condition`,
    condition === undefined,
    condition === undefined ? 'no job-level if:' : `if: ${condition}`,
  );
}

// 4b. A job that runs `pnpm` must set pnpm up and install first.
//
//     The governance job ran `pnpm run validate:regression-coverage` — which
//     imports js-yaml — with no pnpm setup and no install at all. It passed
//     locally because a developer's node_modules is already there, and would
//     have failed on a clean runner. A CI job must be self-contained.
//
//     Jobs are discovered from the workflow rather than listed here. A hard-coded
//     list only covers the jobs somebody remembered to add to it, which is how
//     the governance job went unchecked in the first place.
for (const job of Object.keys(workflow?.jobs ?? {})) {
  const steps = stepsOf(job);
  if (steps.length === 0) continue;

  const usesPnpm = steps.some((step) =>
    commandLines(step).some((line) => line.startsWith('pnpm ')),
  );
  if (!usesPnpm) continue;

  const setupIndex = steps.findIndex((step) =>
    typeof step?.uses === 'string' ? step.uses.startsWith('pnpm/action-setup') : false,
  );
  check(
    `'${job}' sets pnpm up before using it`,
    setupIndex >= 0,
    setupIndex >= 0
      ? `pnpm/action-setup at step ${String(setupIndex)}`
      : 'no pnpm/action-setup step',
  );

  const installIndex = steps.findIndex((step) =>
    runsExactly(step, 'pnpm install --frozen-lockfile'),
  );
  check(
    `'${job}' installs with a frozen lockfile`,
    installIndex >= 0,
    installIndex >= 0 ? `install at step ${String(installIndex)}` : 'no frozen-lockfile install',
  );

  // pnpm has to exist before the install that uses it. Only
  // install-before-first-use was ordered, so a setup placed after the install
  // read as correct and would fail on a clean runner.
  check(
    `'${job}' sets pnpm up before installing`,
    setupIndex >= 0 && installIndex >= 0 && setupIndex < installIndex,
    `setup ${String(setupIndex)}, install ${String(installIndex)}`,
  );

  const firstPnpmIndex = steps.findIndex((step) =>
    commandLines(step).some((line) => line.startsWith('pnpm ') && !line.startsWith('pnpm install')),
  );
  check(
    `'${job}' installs before its first pnpm command`,
    setupIndex >= 0 && installIndex >= 0 && installIndex < firstPnpmIndex,
    `setup ${String(setupIndex)}, install ${String(installIndex)}, first pnpm ${String(firstPnpmIndex)}`,
  );
}

// 4c. Steps must not be disabled by an `if:` condition, and continuation must
//     not be smuggled in through an expression.
for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
  for (const step of job?.steps ?? []) {
    const lines = commandLines(step);
    if (lines.length === 0) continue;
    const label = `${jobName}/${step.name ?? lines[0].slice(0, 40)}`;

    if (step.if !== undefined) {
      const condition = String(step.if).trim();
      // `if: always()` on a cleanup step is legitimate; a falsey literal or an
      // arbitrary expression on a gate step is a disabled gate.
      const benign = condition === 'always()' || condition === '${{ always() }}';
      check(
        `step '${label}' is not disabled by an if: condition`,
        benign,
        benign ? `if: ${condition}` : `if: ${condition}`,
      );
    }

    const coe = step['continue-on-error'];
    if (coe !== undefined && coe !== false && coe !== 'false') {
      check(
        `step '${label}' does not continue on error`,
        false,
        `continue-on-error: ${String(coe)}`,
      );
    }
  }
}

// 5. Build ordering, by step position rather than by appearance in the file.
for (const job of ['compose', 'gate-sec']) {
  const steps = stepsOf(job);
  const buildIndex = steps.findIndex((step) => runsExactly(step, 'pnpm run build'));
  const consumer = job === 'compose' ? 'pnpm run test:regression' : 'pnpm run test:security';
  const consumerIndex = steps.findIndex((step) => runsExactly(step, consumer));
  check(
    `the workspace is built before '${consumer}' in '${job}'`,
    buildIndex >= 0 && consumerIndex >= 0 && buildIndex < consumerIndex,
    buildIndex < 0
      ? 'no exact build step in the job'
      : `build at step ${String(buildIndex)}, consumer at step ${String(consumerIndex)}`,
  );
}

// 6. The root `test:security` script, parsed structurally.
//
//    A substring-and-order check accepts `echo node tools/gate-sec.mjs`,
//    `... | tee log`, `if ...; then ...; fi`, a trailing `&`, and a command
//    whose *name* merely contains the validator's filename. The script is
//    therefore split into its `&&` stages, and each stage must be an exact,
//    recognised command.
// Overridable so the negative-fixture harness can point this validator at a
// mutated *copy* of package.json without touching the real one.
const ROOT_PACKAGE_JSON = process.env['PRSYSTEM_ROOT_PACKAGE_JSON'] ?? join(ROOT, 'package.json');
const rootScripts = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')).scripts ?? {};
const securityScript = String(rootScripts['test:security'] ?? '');

/** The exact stages `test:security` must run, in this order. */
const REQUIRED_SECURITY_STAGES = [
  'turbo run build',
  'node tools/validate-regression-coverage.mjs',
  'node tools/validate-regression-coverage.fixtures.mjs',
  'node tools/validate-governance.fixtures.mjs',
  'node tools/validate-secret-scan.fixtures.mjs',
  'node tools/validate-pool-error-fixture.mjs',
  'node tools/gate-sec.mjs',
];

/**
 * Shell constructs that would let a stage fail without failing the script.
 *
 * Ordered so the most specific construct is reported: `||` before the bare pipe
 * it also matches, and a conditional before the `;` its own syntax requires.
 * Otherwise the diagnostic names an incidental character instead of the thing
 * that was actually done.
 */
const SCRIPT_BYPASSES = [
  { re: /\|\|/, why: '||' },
  { re: /\b(if|then|else|fi|for|while|case|do|done)\b/, why: 'a shell conditional or loop' },
  { re: /;/, why: ';' },
  { re: /\|(?!\|)/, why: 'a pipe' },
  // A lone `&`: not part of the `&&` chain that legitimately joins the stages.
  { re: /(?<!&)&(?!&)/, why: 'backgrounding' },
  { re: /\$\(|`/, why: 'command substitution' },
];

/**
 * Constructs that only make sense at the start of a stage.
 *
 * Applied per stage rather than to the whole script: anchored at the start of
 * the *script*, `^\s*echo` never matched `... && echo node tools/...`, so the
 * leading-echo rule was dead for every stage but the first.
 */
const STAGE_BYPASSES = [{ re: /^(echo|printf|true|:)\b/, why: 'an echoed or no-op command' }];

const stages = securityScript
  .split('&&')
  .map((stage) => stage.trim())
  .filter((stage) => stage.length > 0);

const stageBypass = stages
  .map((stage) => STAGE_BYPASSES.find((pattern) => pattern.re.test(stage)))
  .find((found) => found !== undefined);

const scriptBypass =
  SCRIPT_BYPASSES.find((pattern) => pattern.re.test(securityScript)) ?? stageBypass;
check(
  'test:security contains no shell construct that could discard a failure',
  scriptBypass === undefined,
  scriptBypass ? `contains ${scriptBypass.why}` : 'plain && chain',
);

check(
  'test:security runs exactly the required stages, in order',
  stages.length === REQUIRED_SECURITY_STAGES.length &&
    stages.every((stage, index) => stage === REQUIRED_SECURITY_STAGES[index]),
  stages.length === 0 ? '(missing)' : stages.join(' && '),
);

const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) {
  console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(width)}  ${c.detail}`);
}
console.log(
  `\nregression coverage: ${String(checks.length - failures.length)}/${String(checks.length)} checks passed` +
    (failures.length > 0 ? `, ${String(failures.length)} FAILED` : ''),
);
process.exit(failures.length > 0 ? 1 : 0);
