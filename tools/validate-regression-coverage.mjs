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

// 4. CI must run the complete regression suite as its own step.
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
check(
  'CI runs the complete regression suite',
  /run: pnpm run test:regression/.test(ci),
  /run: pnpm run test:regression/.test(ci) ? 'present' : 'no test:regression step in ci.yml',
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
