// The committed-secret scanner's core — patterns, allowances and the scan
// itself, with no I/O policy of its own.
//
// Split out from the CLI so the negative-fixture harness can call it directly
// with an explicit inventory. The CLI used to accept PRSYSTEM_SCAN_ROOT and
// PRSYSTEM_SCAN_FILES so the harness could point it at a probe tree, and that
// made the production gate redirectable: one variable alone made it scan the
// repository's file list against a different root, find nothing, and exit 0.
// A test seam must not be reachable from the command the gate runs.

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

// `value` is the capture group holding the credential itself. An allowance is
// compared against that value, so `generic-assignment` captures what is inside
// the quotes rather than the whole assignment.
export const PATTERNS = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, value: 0 },
  { id: 'private-key', re: /-{5}BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-{5}/g, value: 0 },
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    value: 0,
  },
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
 * happens to begin with an allowed one.
 *
 * Each value must therefore be spelled as the scanner detects it — the quoted
 * value for `generic-assignment`, the matched token for every shape pattern.
 */
export const ALLOWED_VALUES = [
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

/** File extensions whose bytes are not text and cannot carry a credential line. */
export const BINARY_EXT = new Set([
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

/** Raised when the inventory itself is unusable. Never a silent empty scan. */
export class SecretScanInventoryError extends Error {
  name = 'SecretScanInventoryError';
}

/** Finds every credential a single line carries, minus the exact allowances. */
export function findingsInLine(line) {
  const found = [];
  for (const { id, re, value } of PATTERNS) {
    for (const match of line.matchAll(re)) {
      const detected = match[value] ?? match[0];
      if (ALLOWED_VALUES.includes(detected)) continue;
      found.push(id);
    }
  }
  return found;
}

/**
 * Scans an explicit inventory of repository-relative paths under `root`.
 *
 * Every failure mode of the inventory is an error, never a quieter scan. A scan
 * that reports zero findings because it read zero files is indistinguishable
 * from a clean tree in its exit status, and that is exactly how the overridable
 * CLI passed while scanning nothing.
 */
export function scanFiles({ root, files }) {
  if (typeof root !== 'string' || root === '') {
    throw new SecretScanInventoryError('a scan root is required');
  }
  if (!isAbsolute(root)) {
    throw new SecretScanInventoryError(`the scan root must be absolute: ${root}`);
  }
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    throw new SecretScanInventoryError(`the scan root does not exist: ${root}`);
  }
  if (!rootStat.isDirectory()) {
    throw new SecretScanInventoryError(`the scan root is not a directory: ${root}`);
  }
  if (!Array.isArray(files)) {
    throw new SecretScanInventoryError('the file inventory must be an array');
  }
  if (files.length === 0) {
    throw new SecretScanInventoryError(
      'the file inventory is empty. A scan of no files reports no findings and exits 0, which ' +
        'is indistinguishable from a clean tree',
    );
  }

  const seen = new Set();
  for (const rel of files) {
    if (typeof rel !== 'string' || rel === '') {
      throw new SecretScanInventoryError(
        `the inventory holds an empty path: ${JSON.stringify(rel)}`,
      );
    }
    if (isAbsolute(rel)) {
      throw new SecretScanInventoryError(`inventory paths must be relative to the root: ${rel}`);
    }
    const abs = resolve(root, rel);
    const inside = relative(root, abs);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw new SecretScanInventoryError(`inventory path escapes the scan root: ${rel}`);
    }
    if (seen.has(inside)) {
      throw new SecretScanInventoryError(`the inventory lists ${rel} more than once`);
    }
    seen.add(inside);
  }

  const findings = [];
  let scanned = 0;
  for (const rel of files) {
    const abs = resolve(root, rel);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (error) {
      throw new SecretScanInventoryError(
        `cannot read ${rel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    }
    scanned += 1;
    text.split('\n').forEach((line, index) => {
      // Detect first, then compare each detected value against the allow-list.
      // Removing the allowed spans and scanning the remainder let an allowance
      // suppress a different credential that merely contained it.
      for (const id of findingsInLine(line)) findings.push({ rel, line: index + 1, id });
    });
  }

  return { scanned, findings };
}
