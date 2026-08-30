// The committed-secret scanner's core — patterns, allowances and the scan
// itself, with no I/O policy of its own.
//
// Split out from the CLI so the negative-fixture harness can call it directly,
// against a repository it built itself. The CLI used to accept
// PRSYSTEM_SCAN_ROOT and PRSYSTEM_SCAN_FILES so the harness could point it at a
// probe tree, and that made the production gate redirectable. The seam is now a
// function parameter — the root — and the CLI passes the one it resolves from
// its own location, which nothing outside the process can influence.
//
// The inventory comes from git, and git reads its own environment: GIT_INDEX_FILE
// alone pointed `git ls-files` at another index, so the gate scanned one
// innocuous file and exited 0. Every GIT_* variable is stripped before the
// subprocess runs, and the repository git resolves must be the root that was
// asked for.
//
// Paths are not the whole inventory. A file's *mode* decides how it can be read:
// a tracked symlink is stored as its link text, and following it read
// /dev/null as an empty scanned file and hung on /dev/zero. Nothing is omitted
// for its filename either — a credential in `leak.png` is still a credential.

import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from 'node:fs';
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

/** Raised when the inventory itself is unusable. Never a silent empty scan. */
export class SecretScanInventoryError extends Error {
  name = 'SecretScanInventoryError';
}

/** Git index modes this scanner knows how to read. */
const REGULAR_MODES = new Set(['100644', '100755']);
const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';

/** Read in bounded chunks, so file size never decides whether content is seen. */
const CHUNK_BYTES = 1 << 20;

/**
 * A single line longer than this fails the gate.
 *
 * Streaming keeps memory bounded per chunk, but a line is the unit the patterns
 * match, so one unbroken line still has to be held. Refusing is the honest
 * outcome: skipping the file is exactly the silent omission that let a
 * credential on line 1 of an oversized file through.
 */
const MAX_LINE_BYTES = 8 << 20;

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

/** Every GIT_* variable removed, so a subprocess cannot be pointed elsewhere. */
export function sanitisedGitEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('GIT_')) continue;
    clean[key] = value;
  }
  return clean;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'latin1',
    env: sanitisedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
  });
}

/**
 * The tracked inventory of `root`: repository-relative path plus index mode.
 *
 * The mode is part of the inventory because it decides how the entry may be
 * read. `git ls-files` alone gave paths, and a path says nothing about whether
 * the thing behind it is a regular file, a symlink or a submodule.
 */
export function gitInventory(root) {
  if (typeof root !== 'string' || root === '' || !isAbsolute(root)) {
    throw new SecretScanInventoryError(`the scan root must be an absolute path: ${String(root)}`);
  }

  let toplevel;
  try {
    toplevel = git(root, ['rev-parse', '--show-toplevel']).trim();
  } catch (error) {
    throw new SecretScanInventoryError(
      'cannot enumerate tracked files. This gate needs a git working tree (CI uses ' +
        'actions/checkout, which provides one); a `git archive` extraction does not have the ' +
        'metadata to tell tracked files from stray ones. ' +
        (error instanceof Error ? error.message.split('\n')[0] : String(error)),
    );
  }

  // The repository git resolved must be the one that was asked for. Without
  // this, a `.git` file or a stray configuration pointing elsewhere would supply
  // a different inventory for the same root.
  const resolvedRoot = realpathSync(root);
  const resolvedTop = realpathSync(toplevel);
  if (resolvedTop !== resolvedRoot) {
    throw new SecretScanInventoryError(
      `git resolved the repository to ${resolvedTop}, not the scan root ${resolvedRoot}`,
    );
  }

  const listed = git(root, ['ls-files', '-s', '-z']);
  const entries = [];
  const seen = new Set();
  for (const record of listed.split('\0')) {
    if (record === '') continue;
    // `<mode> <object> <stage>\t<path>`
    const tab = record.indexOf('\t');
    if (tab < 0) {
      throw new SecretScanInventoryError(`cannot parse the index record ${JSON.stringify(record)}`);
    }
    const [mode, object] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (seen.has(path)) {
      throw new SecretScanInventoryError(`the index lists ${path} more than once`);
    }
    seen.add(path);

    if (mode === GITLINK_MODE) {
      throw new SecretScanInventoryError(
        `${path} is a gitlink (submodule). Its content lives in another repository and this ` +
          'scan does not reach it: handle it deliberately rather than passing over it',
      );
    }
    if (mode === SYMLINK_MODE) {
      // The stored link text, read from the object rather than through the link.
      // Following it read /dev/null as an empty file that counted as scanned and
      // hung on /dev/zero, and pulled content from outside the repository.
      entries.push({ path, mode, target: git(root, ['cat-file', 'blob', object]) });
      continue;
    }
    if (!REGULAR_MODES.has(mode)) {
      throw new SecretScanInventoryError(
        `${path} has index mode ${mode}, which this scan does not classify`,
      );
    }
    entries.push({ path, mode });
  }
  return entries;
}

/** Scans one open file descriptor line by line, without holding the whole file. */
function scanDescriptor(fd, onLine) {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let carry = '';
  let line = 1;
  for (;;) {
    const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
    if (read === 0) break;
    const text = carry + buffer.toString('latin1', 0, read);
    const parts = text.split('\n');
    carry = parts.pop() ?? '';
    for (const part of parts) onLine(part, line++);
    if (carry.length > MAX_LINE_BYTES) {
      throw new SecretScanInventoryError(
        `a single line exceeds ${String(MAX_LINE_BYTES)} bytes and cannot be scanned as one unit`,
      );
    }
  }
  if (carry !== '') onLine(carry, line);
}

/**
 * Scans an explicit inventory of entries under `root`.
 *
 * Every failure mode of the inventory is an error, never a quieter scan. A scan
 * that reports zero findings because it read zero files is indistinguishable
 * from a clean tree in its exit status, and that is exactly how the overridable
 * CLI passed while scanning nothing.
 *
 * Content is read as latin1, so every byte maps to one character and the
 * patterns match over the actual bytes. Nothing is skipped for its extension:
 * a credential written in plain text into `leak.png` is a committed credential.
 */
export function scanEntries({ root, entries }) {
  if (typeof root !== 'string' || root === '') {
    throw new SecretScanInventoryError('a scan root is required');
  }
  if (!isAbsolute(root)) {
    throw new SecretScanInventoryError(`the scan root must be absolute: ${root}`);
  }
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new SecretScanInventoryError(`the scan root does not exist: ${root}`);
  }
  if (!rootStat.isDirectory()) {
    throw new SecretScanInventoryError(`the scan root is not a directory: ${root}`);
  }
  if (!Array.isArray(entries)) {
    throw new SecretScanInventoryError('the file inventory must be an array');
  }
  if (entries.length === 0) {
    throw new SecretScanInventoryError(
      'the file inventory is empty. A scan of no files reports no findings and exits 0, which ' +
        'is indistinguishable from a clean tree',
    );
  }

  const seen = new Set();
  for (const entry of entries) {
    const rel = entry?.path;
    if (typeof rel !== 'string' || rel === '') {
      throw new SecretScanInventoryError(
        `the inventory holds an empty path: ${JSON.stringify(rel)}`,
      );
    }
    if (isAbsolute(rel)) {
      throw new SecretScanInventoryError(`inventory paths must be relative to the root: ${rel}`);
    }
    const inside = relative(root, resolve(root, rel));
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
  for (const entry of entries) {
    const rel = entry.path;
    const abs = resolve(root, rel);
    const report = (line, number) => {
      for (const id of findingsInLine(line)) findings.push({ rel, line: number, id });
    };

    // `lstat`, never `stat`: the question is what the tracked entry *is*, not
    // what it points at.
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (error) {
      throw new SecretScanInventoryError(
        `cannot read ${rel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    }

    if (entry.mode === SYMLINK_MODE) {
      if (!stat.isSymbolicLink()) {
        throw new SecretScanInventoryError(`${rel} is recorded as a symlink but is not one`);
      }
      const onDisk = readlinkSync(abs);
      if (typeof entry.target !== 'string') {
        throw new SecretScanInventoryError(`${rel} is a symlink with no recorded link text`);
      }
      if (onDisk !== entry.target) {
        throw new SecretScanInventoryError(
          `${rel} points at ${onDisk} but the index records ${entry.target}`,
        );
      }
      // The link text is the tracked content. The target is never opened.
      scanned += 1;
      report(entry.target, 1);
      continue;
    }

    if (!REGULAR_MODES.has(entry.mode)) {
      throw new SecretScanInventoryError(
        `${rel} has inventory mode ${String(entry.mode)}, which this scan does not classify`,
      );
    }
    if (!stat.isFile()) {
      throw new SecretScanInventoryError(`${rel} is recorded as a regular file but is not one`);
    }

    let fd;
    try {
      fd = openSync(abs, 'r');
    } catch (error) {
      throw new SecretScanInventoryError(
        `cannot read ${rel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    }
    try {
      scanDescriptor(fd, report);
    } catch (error) {
      if (error instanceof SecretScanInventoryError) {
        throw new SecretScanInventoryError(`${rel}: ${error.message}`);
      }
      throw error;
    } finally {
      closeSync(fd);
    }
    scanned += 1;
  }

  return { scanned, findings };
}

/** The whole gate for one repository: its tracked inventory, then the scan. */
export function scanRepository(root) {
  return scanEntries({ root, entries: gitInventory(root) });
}
