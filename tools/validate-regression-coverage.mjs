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
 * True when some line of the step *is* `command`, alone, with nothing appended
 * that could discard its exit status.
 */
function runsExactly(step, command) {
  return commandLines(step).some((line) => {
    if (line !== command) return false;
    return !BYPASS_PATTERNS.some((pattern) => pattern.re.test(line));
  });
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

/** Steps that must exist, exactly, in a named blocking job. */
const REQUIRED_STEPS = [
  { job: 'compose', command: 'pnpm run test:regression', needsDatabase: true },
  { job: 'compose', command: 'pnpm run build', needsDatabase: false },
  { job: 'gate-sec', command: 'pnpm run test:security', needsDatabase: true },
  { job: 'gate-sec', command: 'pnpm run build', needsDatabase: false },
  { job: 'governance', command: 'pnpm run validate:regression-coverage', needsDatabase: false },
  { job: 'governance', command: 'pnpm run validate:ci-bypass-fixtures', needsDatabase: false },
];

for (const required of REQUIRED_STEPS) {
  const step = stepsOf(required.job).find((candidate) => runsExactly(candidate, required.command));
  const label = `CI runs '${required.command}' exactly, in the '${required.job}' job`;

  check(
    label,
    step !== undefined,
    step === undefined
      ? `no step whose run line is exactly '${required.command}'`
      : `step: ${step.name ?? '(unnamed)'}`,
  );
  if (step === undefined) continue;

  const bypass = bypassIn(step);
  check(
    `'${required.command}' cannot discard its exit status`,
    bypass === undefined,
    bypass ?? 'no bypass construct',
  );

  check(
    `'${required.command}' is blocking`,
    isBlocking(step),
    `continue-on-error: ${String(step['continue-on-error'] ?? '(absent)')}`,
  );

  if (required.needsDatabase) {
    const url = step.env?.DATABASE_URL;
    check(
      `'${required.command}' is given a database`,
      typeof url === 'string' && url.length > 0,
      typeof url === 'string' ? 'DATABASE_URL supplied' : 'no DATABASE_URL',
    );
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

// 6. And the root script must run the validator before GATE-SEC, with no
//    bypass of its own.
const rootScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
const securityScript = rootScripts['test:security'] ?? '';
const scriptBypass = BYPASS_PATTERNS.filter(
  (p) => p.why !== 'a pipe, which reports the last command status',
).find((pattern) => pattern.re.test(securityScript));
const runsValidatorFirst =
  securityScript.includes('validate-regression-coverage') &&
  securityScript.indexOf('validate-regression-coverage') < securityScript.indexOf('gate-sec.mjs') &&
  scriptBypass === undefined;
check(
  'pnpm run test:security validates regression coverage before GATE-SEC, without a bypass',
  runsValidatorFirst,
  scriptBypass ? `bypass: ${scriptBypass.why}` : securityScript || '(missing)',
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
