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

// 4. CI must run the complete regression suite as an executable, blocking step
//    in the intended job. Searching the file with a regex proves none of that:
//    a commented-out line matches, a step in a non-blocking job matches, and a
//    step carrying `continue-on-error: true` matches. The workflow is therefore
//    parsed and inspected structurally.
const workflow = load(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));

/** Every step of one job, or [] when the job does not exist. */
function stepsOf(jobName) {
  return workflow?.jobs?.[jobName]?.steps ?? [];
}

/** The first step in `jobName` whose `run:` executes `command`. */
function findStep(jobName, command) {
  return stepsOf(jobName).find(
    (step) => typeof step?.run === 'string' && step.run.includes(command),
  );
}

/** A step is blocking unless it opts out with continue-on-error. */
function isBlocking(step) {
  const flag = step?.['continue-on-error'];
  return flag === undefined || flag === false || flag === 'false';
}

const REGRESSION_JOB = 'compose';
const REGRESSION_COMMAND = 'pnpm run test:regression';

const regressionStep = findStep(REGRESSION_JOB, REGRESSION_COMMAND);
check(
  `CI runs the complete regression suite in the '${REGRESSION_JOB}' job`,
  regressionStep !== undefined,
  regressionStep === undefined
    ? `no executable '${REGRESSION_COMMAND}' step in job '${REGRESSION_JOB}'`
    : `step: ${regressionStep.name ?? '(unnamed)'}`,
);

// A commented-out command is text inside some other step's `run`, never a step
// whose own `run` starts with it.
const regressionIsExecutable =
  regressionStep !== undefined &&
  regressionStep.run
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line.startsWith(REGRESSION_COMMAND));
check(
  'the regression step is executable, not commented text',
  regressionIsExecutable,
  regressionIsExecutable ? 'runs as a command' : 'only appears inside a comment',
);

check(
  'the regression step is blocking',
  regressionStep !== undefined && isBlocking(regressionStep),
  regressionStep === undefined
    ? 'no step'
    : `continue-on-error: ${String(regressionStep['continue-on-error'] ?? '(absent)')}`,
);

const regressionEnv = regressionStep?.env ?? {};
check(
  'the regression step is given a database',
  typeof regressionEnv.DATABASE_URL === 'string' && regressionEnv.DATABASE_URL.length > 0,
  typeof regressionEnv.DATABASE_URL === 'string' ? 'DATABASE_URL supplied' : 'no DATABASE_URL',
);

// `dist/` is ignored and several suites consume generated JavaScript, so the
// build must come first — in step order, not merely somewhere in the file.
const composeSteps = stepsOf(REGRESSION_JOB);
const buildIndex = composeSteps.findIndex(
  (step) => typeof step?.run === 'string' && step.run.includes('pnpm run build'),
);
const regressionIndex = composeSteps.indexOf(regressionStep);
check(
  'the workspace is built before the regression suite runs',
  buildIndex >= 0 && regressionIndex >= 0 && buildIndex < regressionIndex,
  buildIndex < 0
    ? 'no build step in the job'
    : `build at step ${String(buildIndex)}, regression at step ${String(regressionIndex)}`,
);

// 5. And this validator must itself be on the blocking path.
const validatorStep =
  findStep('governance', 'validate:regression-coverage') ??
  findStep('verify', 'validate:regression-coverage') ??
  findStep('compose', 'validate:regression-coverage');
check(
  'the regression coverage validator runs in CI',
  validatorStep !== undefined && isBlocking(validatorStep),
  validatorStep === undefined ? 'not present in any job' : 'present and blocking',
);

// 6. `pnpm run test:security` must run it before GATE-SEC, so a local run and a
//    CI run enforce the same thing.
const rootScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
const securityScript = rootScripts['test:security'] ?? '';
const runsValidatorFirst =
  securityScript.includes('validate-regression-coverage') &&
  securityScript.indexOf('validate-regression-coverage') < securityScript.indexOf('gate-sec.mjs');
check(
  'pnpm run test:security validates regression coverage before GATE-SEC',
  runsValidatorFirst,
  runsValidatorFirst ? securityScript : `test:security = ${securityScript || '(missing)'}`,
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
