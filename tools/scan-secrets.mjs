#!/usr/bin/env node
// Secret scan over git-tracked files — Phase 02 gate, precursor to GATE-SEC.
//
//   node tools/scan-secrets.mjs
//
// Scans for credential shapes that must never be committed (CLAUDE.md §8).
// Local-development placeholders in .env.example and docker-compose.yml are
// allowed by an explicit allowlist, not by skipping the files.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `value` is the capture group holding the credential itself. An allowance is
// compared against that value, so `generic-assignment` captures what is inside
// the quotes rather than the whole assignment.
const PATTERNS = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, value: 0 },
  { id: 'private-key', re: /-{5}BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-{5}/g, value: 0 },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, value: 0 },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, value: 0 },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, value: 0 },
  { id: 'stripe-key', re: /\bsk_live_[A-Za-z0-9]{16,}\b/g, value: 0 },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, value: 0 },
  {
    id: 'generic-assignment',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]([^'"\s]{12,})['"]/gi,
    value: 1,
  },
];

/**
 * Local-development placeholders that are non-secret by construction.
 *
 * An entry suppresses a finding only when the detected credential value is
 * **exactly** that string. It is not a substring allowance and not a line or
 * file exemption: `startup-log-probe-passwordX` is a different credential that
 * happens to begin with an allowed one, and removing every occurrence of the
 * allowed text before scanning made all three of prefix, suffix and both report
 * nothing at all.
 *
 * Each value must therefore be spelled as the scanner detects it — the quoted
 * value for `generic-assignment`, the matched token for every shape pattern.
 */
const ALLOWED_VALUES = [
  'prsystem_local_dev',
  'prsystem_local',
  'local-access-key',
  'local-secret-key',
  'test-access-key',
  'test-secret-key',
  'changeme',
  'placeholder',
  'hunter2', // fixture value asserted to be redacted in telemetry tests

  // Synthetic fixtures that exist precisely so a test can assert the value is
  // rejected or redacted. Each is allow-listed as an exact literal, never as a
  // whole-file exemption, so the scanner stays strict everywhere else. None is a
  // real credential and none was issued by any provider.
  'super-secret-value-should-not-appear', // packages/config — asserts the error never echoes a secret
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4', // packages/telemetry — logger value-shape test
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K', // packages/telemetry — redaction test
  'must-never-be-recorded', // packages/db — audit payload the constraint must refuse
  'super-secret-scheduler-password', // packages/config — asserts the scheduler credential is never echoed
  'startup-log-probe-password', // apps/api — asserts no credential reaches the startup logger
];

const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
]);

// Overridable so the negative-fixture harness can scan a probe tree without
// touching the repository. Both must be supplied together; neither has a
// default that could quietly narrow a real scan.
const SCAN_ROOT = process.env['PRSYSTEM_SCAN_ROOT'];
const SCAN_FILES = process.env['PRSYSTEM_SCAN_FILES'];

// Tracked files only, enumerated by git. If git metadata is unavailable the scan
// cannot know what is tracked, so it fails closed with a legible message rather
// than dying on an unhandled exception — or, worse, scanning nothing and
// reporting a clean result.
let tracked;
try {
  tracked =
    SCAN_ROOT !== undefined && SCAN_FILES !== undefined
      ? SCAN_FILES.split(',').join('\0')
      : execFileSync('git', ['ls-files', '-z'], {
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

const files = tracked
  .split('\0')
  .filter(Boolean)
  .filter((f) => !BINARY_EXT.has(extname(f)))
  .filter((f) => f !== 'tools/scan-secrets.mjs'); // this file defines the patterns

const findings = [];
let scanned = 0;

const scanRoot = SCAN_ROOT ?? ROOT;

for (const rel of files) {
  const abs = resolve(scanRoot, rel);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 2_000_000) continue;

  const text = readFileSync(abs, 'utf8');
  scanned += 1;

  text.split('\n').forEach((line, index) => {
    // Detect first, then compare each detected value against the allow-list.
    //
    // Removing the allowed spans and scanning the remainder let an allowance
    // suppress a *different* credential that merely contained it: with
    // `startup-log-probe-password` allowed,
    //
    //     { password: "startup-log-probe-passwordX" }
    //
    // lost its allowed span and what was left was too short for the pattern, so
    // it reported nothing — and so did the prefix and prefix-and-suffix forms.
    // Matching first and requiring exact equality makes an allowance cover its
    // own value and only its own value.
    //
    // Every match on the line is examined, not just the first: an allowed value
    // must not shadow a real credential sitting beside it.
    for (const { id, re, value } of PATTERNS) {
      for (const match of line.matchAll(re)) {
        const detected = match[value] ?? match[0];
        if (ALLOWED_VALUES.includes(detected)) continue;
        findings.push({ rel, line: index + 1, id });
      }
    }
  });
}

if (findings.length > 0) {
  console.error(`[FAIL] secret scan — ${findings.length} finding(s):`);
  for (const f of findings) console.error(`  ${f.rel}:${f.line}  ${f.id}`);
  process.exit(1);
}

console.log(`[PASS] secret scan — ${scanned} tracked text files, 0 findings`);
