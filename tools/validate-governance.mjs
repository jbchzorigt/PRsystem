#!/usr/bin/env node
// Governance validation for the PRsystem implementation plan.
// Standing gate: run at the end of every phase (build-plan.md §5).
//
//   node tools/validate-governance.mjs
//
// Exit code 0 = all checks pass, 1 = at least one check failed.
//
// This command takes no arguments and reads no configuration. It validates the
// repository's own documents: the root is resolved from this file's location
// and the three paths below are fixed. It used to accept PRSYSTEM_RUNBOOK,
// PRSYSTEM_PHASE_STATUS and PRSYSTEM_EVIDENCE_MANIFEST so the fixture harness
// could point it at mutated copies, and that made the gate redirectable — with
// the three set to clean decoys, the canonical `phase-status.md` could say
// anything and the gate still reported 15 of 15. The harness now calls
// `runGovernanceChecks` directly.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGovernanceChecks } from './governance-checks.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMPL = join(ROOT, 'docs', 'implementation');

const { results, failed } = runGovernanceChecks({
  root: ROOT,
  runbookPath: join(IMPL, 'database-bootstrap-runbook.md'),
  phaseStatusPath: join(IMPL, 'phase-status.md'),
  manifestPath: join(IMPL, 'phase-03-evidence.json'),
  phase05ManifestPath: join(IMPL, 'phase-05-evidence.json'),
});

const width = Math.max(...results.map((r) => r.title.length));
for (const r of results) {
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.id}. ${r.title.padEnd(width)}  ${r.detail}`);
}
console.log(
  `\n${results.length - failed}/${results.length} checks passed` +
    (failed ? `, ${failed} FAILED` : ''),
);
process.exit(failed ? 1 : 0);
