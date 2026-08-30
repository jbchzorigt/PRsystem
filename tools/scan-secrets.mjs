#!/usr/bin/env node
// Secret scan over git-tracked files — Phase 02 gate, precursor to GATE-SEC.
//
//   node tools/scan-secrets.mjs
//
// Scans for credential shapes that must never be committed (CLAUDE.md §8).
// Local-development placeholders in .env.example and docker-compose.yml are
// allowed by an exact-value allowlist, not by skipping the files.
//
// This command takes no arguments and reads no configuration. It scanned
// whatever PRSYSTEM_SCAN_ROOT and PRSYSTEM_SCAN_FILES named so a fixture harness
// could reuse it, and that made the gate redirectable: setting the root alone
// pointed the repository's own file list at another directory, found nothing,
// and exited 0. The harness now calls `scanFiles` in tools/secret-scan.mjs
// directly, and the production path has no seam to aim at.

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINARY_EXT, SecretScanInventoryError, scanFiles } from './secret-scan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 2_000_000;

// Tracked files only, enumerated by git. If git metadata is unavailable the scan
// cannot know what is tracked, so it fails closed with a legible message rather
// than dying on an unhandled exception — or, worse, scanning nothing and
// reporting a clean result.
let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  console.error(
    'scan-secrets: cannot enumerate tracked files. This gate needs a git working tree ' +
      '(CI uses actions/checkout, which provides one); a `git archive` extraction does not have ' +
      'the metadata to tell tracked files from stray ones.',
  );
  console.error(`  ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  process.exit(2);
}

const trackedFiles = tracked.split('\0').filter(Boolean);
const textFiles = trackedFiles.filter((f) => !BINARY_EXT.has(extname(f)));

// Anything excluded for size is named, never dropped quietly.
const oversized = textFiles.filter((f) => {
  try {
    return statSync(resolve(ROOT, f)).size > MAX_BYTES;
  } catch {
    // Left in the inventory so `scanFiles` fails closed on it rather than here.
    return false;
  }
});
for (const f of oversized) {
  console.error(`scan-secrets: skipping ${f}, larger than ${String(MAX_BYTES)} bytes`);
}
const inventory = textFiles.filter((f) => !oversized.includes(f));

let result;
try {
  result = scanFiles({ root: ROOT, files: inventory });
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

console.log(`[PASS] secret scan — ${result.scanned} tracked text files, 0 findings`);
