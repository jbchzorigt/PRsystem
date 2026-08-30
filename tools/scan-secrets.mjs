#!/usr/bin/env node
// Secret scan over git-tracked files — Phase 02 gate, precursor to GATE-SEC.
//
//   node tools/scan-secrets.mjs
//
// Scans for credential shapes that must never be committed (CLAUDE.md §8).
// Local-development placeholders in .env.example and docker-compose.yml are
// allowed by an exact-value allowlist, not by skipping the files.
//
// This command takes no arguments and reads no configuration. It scans the
// repository it lives in: the root is resolved from this file's own location and
// nothing outside the process can influence it. The inventory comes from git
// with every GIT_* variable stripped, and git's answer is required to be the
// same repository — GIT_INDEX_FILE alone once pointed the enumeration at another
// index, and the gate reported one clean tracked file and exited 0.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretScanInventoryError, scanRepository } from './secret-scan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let result;
try {
  result = scanRepository(ROOT);
} catch (error) {
  if (error instanceof SecretScanInventoryError) {
    console.error(`[FAIL] secret scan — ${error.message}`);
    process.exit(2);
  }
  throw error;
}

if (result.findings.length > 0) {
  console.error(`[FAIL] secret scan — ${result.findings.length} finding(s):`);
  for (const f of result.findings) console.error(`  ${f.rel}:${f.line}  ${f.id}`);
  process.exit(1);
}

console.log(`[PASS] secret scan — ${result.scanned} tracked files, 0 findings`);
