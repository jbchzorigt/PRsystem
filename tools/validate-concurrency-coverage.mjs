#!/usr/bin/env node
// Consolidated concurrency coverage — Phase 22 gate (see tools/concurrency-coverage.mjs).
//
//   node tools/validate-concurrency-coverage.mjs
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONCURRENCY_MANIFEST } from './concurrency-manifest.mjs';
import { runConcurrencyCoverage } from './concurrency-coverage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = runConcurrencyCoverage({ root: ROOT, manifest: CONCURRENCY_MANIFEST });
if (result.problems.length > 0) {
  console.error(`[FAIL] concurrency coverage — ${String(result.problems.length)} problem(s):`);
  for (const problem of result.problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `[PASS] concurrency coverage — ${String(result.operations)} idempotent commands: ${String(result.raced)} raced by ${String(result.suites)} GATE-CONC suites, ${String(result.duplicateSubmitOnly)} duplicate-submit only under the kernel proof`,
);
