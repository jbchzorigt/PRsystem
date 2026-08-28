#!/usr/bin/env node
// GATE-SEC — the named, blocking security gate.
//
//   node tools/gate-sec.mjs
//
// This is the **kernel security subset** of a cumulative gate. Phase 03 covers
// roles, RLS, audit, partitions, Police isolation, key management, PII leakage
// and secrets. Phase 22 expands the same gate with headers, CSP, the
// penetration/security-review pass and the release checks. The name does not
// change; the sub-gate list grows.
//
// It fails when PostgreSQL is unavailable, when a required suite is skipped,
// when a sub-gate runs zero tests, or when an expected artefact is missing —
// because a security gate that can pass by not running is worse than none.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUB_GATES } from './gate-sec-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
let failed = 0;

function fail(id, what, detail) {
  results.push({ id, what, ok: false, detail });
  failed += 1;
}

// PostgreSQL must be reachable. A skipped database suite is a failure, not a pass.
function databaseReachable() {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `const {Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL||'postgresql://prsystem:prsystem_local_dev@127.0.0.1:55442/prsystem',connectionTimeoutMillis:5000});c.connect().then(()=>c.query('SELECT 1')).then(()=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1));`,
    ],
    // pnpm does not hoist, so the probe runs where `pg` is actually installed.
    { cwd: join(ROOT, 'packages', 'db'), encoding: 'utf8' },
  );
  return probe.status === 0;
}

const dbUp = databaseReachable();

for (const gate of SUB_GATES) {
  const missing = gate.artefacts.filter((path) => !existsSync(join(ROOT, path)));
  if (missing.length > 0) {
    fail(gate.id, gate.what, `missing artefact(s): ${missing.join(', ')}`);
    continue;
  }

  if (gate.needsDatabase && !dbUp) {
    fail(gate.id, gate.what, 'PostgreSQL is unavailable; this gate cannot be skipped');
    continue;
  }

  const reportDir = mkdtempSync(join(tmpdir(), 'prsystem-gate-sec-'));
  const reportFile = join(reportDir, 'report.json');
  try {
    const run = spawnSync(
      'pnpm',
      [
        '--filter',
        gate.filter,
        'exec',
        'vitest',
        'run',
        gate.suite,
        '--reporter=json',
        `--outputFile=${reportFile}`,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );

    if (!existsSync(reportFile)) {
      fail(gate.id, gate.what, `suite produced no report (exit ${String(run.status)})`);
      continue;
    }

    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    const total = report.numTotalTests ?? 0;
    const passed = report.numPassedTests ?? 0;
    const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);

    if (total === 0) {
      fail(gate.id, gate.what, 'sub-gate ran zero tests');
    } else if (skipped > 0) {
      fail(gate.id, gate.what, `${String(skipped)} test(s) skipped`);
    } else if (run.status !== 0 || passed !== total) {
      fail(gate.id, gate.what, `${String(total - passed)}/${String(total)} failed`);
    } else if (gate.also !== undefined) {
      const extra = spawnSync(gate.also[0], gate.also[1], { cwd: ROOT, encoding: 'utf8' });
      if (extra.status !== 0) {
        fail(gate.id, gate.what, `${gate.also[1].join(' ')} failed`);
      } else {
        results.push({
          id: gate.id,
          what: gate.what,
          ok: true,
          detail: `${String(passed)} tests + secret scan`,
        });
      }
    } else {
      results.push({ id: gate.id, what: gate.what, ok: true, detail: `${String(passed)} tests` });
    }
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

const width = Math.max(...results.map((r) => r.id.length));
for (const r of results) {
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.id.padEnd(width)}  ${r.detail}`);
  if (!r.ok) console.log(`         ${r.what}`);
}
console.log(
  `\nGATE-SEC: ${String(results.length - failed)}/${String(results.length)} sub-gates passed${failed ? `, ${String(failed)} FAILED` : ''}`,
);
process.exit(failed ? 1 : 0);
