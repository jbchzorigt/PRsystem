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
//
// And the content that matters is the content git holds. The inventory read
// each entry's blob OID and then scanned the working-tree path instead, so
// staging a credential and overwriting the file with clean text reported zero
// findings while the credential sat in the index, ready to be committed. Every
// entry is scanned from its indexed blob; the working tree is scanned as well,
// never instead.
//
// "The blob git returns" is not the same claim as "the blob the index names".
// A repository-local `git replace` ref makes `cat-file` answer with a different
// object while still printing the OID that was asked for, so a staged credential
// could be swapped for clean text and the scan reported nothing. Replacement is
// disabled explicitly, and every returned object is hashed back to a git object
// name and required to be the one the index recorded.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

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

/** A git object name: SHA-1 today, SHA-256 in a repository configured for it. */
const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** The only index stage an ordinary, fully merged entry has. */
const MERGED_STAGE = '0';

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

/** The first line of an error, for a legible one-line diagnostic. */
function messageOf(error) {
  if (!(error instanceof Error)) return String(error);
  const stderr = error.stderr;
  const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : error.message;
  return String(detail).split('\n')[0];
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

/** Every GIT_* variable removed, so a subprocess cannot be pointed elsewhere. */
export function sanitisedGitEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('GIT_')) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * Every GIT_* variable removed and replacement processing refused.
 *
 * `--no-replace-objects` and `GIT_NO_REPLACE_OBJECTS` say the same thing twice
 * on purpose: the flag is what this process asks for, and the variable is what
 * any git subprocess it spawns inherits.
 */
function gitEnv() {
  return { ...sanitisedGitEnv(), GIT_NO_REPLACE_OBJECTS: '1' };
}

function git(root, args) {
  return execFileSync('git', ['-C', root, '--no-replace-objects', ...args], {
    encoding: 'latin1',
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
  });
}

/** Node's name for the repository's git object format. */
function objectHashAlgorithm(root) {
  const format = git(root, ['rev-parse', '--show-object-format']).trim();
  if (format === 'sha1') return 'sha1';
  if (format === 'sha256') return 'sha256';
  throw new SecretScanInventoryError(
    `this repository uses the ${format} object format, which this scan cannot verify`,
  );
}

/**
 * The tracked inventory of `root`: path, index mode, blob name and index stage.
 *
 * The mode is part of the inventory because it decides how the entry may be
 * read. `git ls-files` alone gave paths, and a path says nothing about whether
 * the thing behind it is a regular file, a symlink or a submodule.
 *
 * The blob name is part of it because the blob *is* the tracked content. Reading
 * the OID and then scanning the working-tree path let a staged credential be
 * masked by a clean file on disk.
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

  // Two sources, both mandatory: the commit that is checked out and the index.
  //
  // The index alone was the inventory, so committing a credential and then
  // staging clean content over it reported nothing — the secret was already in
  // history, named by `HEAD:<path>`, while `:<path>` named the replacement.
  // Neither source may stand in for the other; where they name the same blob for
  // the same path there is nothing to scan twice, and that is the only case
  // deduplicated.
  const entries = [];
  const byIdentity = new Map();
  const add = (entry, source) => {
    // Path, object *and* mode. The mode is what decides how the entry is read,
    // and it belongs to the source that recorded it: with the mode left out of
    // the key, a regular file in HEAD and a symlink in the index naming the same
    // blob collapsed into one entry carrying HEAD's mode, and the working-tree
    // symlink was then skipped as "not a regular file" without ever being read.
    const key = JSON.stringify([entry.path, entry.object, entry.mode]);
    const seenEntry = byIdentity.get(key);
    if (seenEntry !== undefined) {
      if (!seenEntry.sources.includes(source)) seenEntry.sources.push(source);
      return;
    }
    const recorded = { ...entry, sources: [source] };
    byIdentity.set(key, recorded);
    entries.push(recorded);
  };

  const classify = (path, mode, object, stage, where) => {
    if (mode === GITLINK_MODE) {
      throw new SecretScanInventoryError(
        `${path} is a gitlink (submodule) in ${where}. Its content lives in another repository ` +
          'and this scan does not reach it: handle it deliberately rather than passing over it',
      );
    }
    if (mode !== SYMLINK_MODE && !REGULAR_MODES.has(mode)) {
      throw new SecretScanInventoryError(
        `${path} has ${where} mode ${String(mode)}, which this scan does not classify`,
      );
    }
    if (!OBJECT_ID.test(object ?? '')) {
      throw new SecretScanInventoryError(
        `${path} has ${where} object ${String(object)}, which is not a git object name`,
      );
    }
    if (stage !== MERGED_STAGE) {
      throw new SecretScanInventoryError(
        `${path} is at index stage ${String(stage)}, not ${MERGED_STAGE}: an unmerged path has ` +
          'no single indexed content, so this scan refuses it rather than picking a side',
      );
    }
  };

  // ------------------------------------------------------------------- HEAD
  let headCommit;
  try {
    headCommit = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim();
  } catch (error) {
    throw new SecretScanInventoryError(
      'cannot resolve HEAD to a commit. The checked-out commit is one of the two mandatory ' +
        'sources this scan reads, so an unborn, detached-to-a-non-commit or unreadable HEAD is ' +
        `refused rather than skipped. ${messageOf(error)}`,
    );
  }
  if (!OBJECT_ID.test(headCommit)) {
    throw new SecretScanInventoryError(
      `HEAD resolved to ${JSON.stringify(headCommit)}, which is not a git object name`,
    );
  }

  const tree = git(root, ['ls-tree', '-r', '-z', headCommit]);
  const headPaths = new Set();
  for (const record of tree.split('\0')) {
    if (record === '') continue;
    // `<mode> <type> <object>\t<path>`
    const tab = record.indexOf('\t');
    if (tab < 0) {
      throw new SecretScanInventoryError(
        `cannot parse the HEAD tree record ${JSON.stringify(record)}`,
      );
    }
    const [mode, type, object] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (headPaths.has(path)) {
      throw new SecretScanInventoryError(`the HEAD tree lists ${path} more than once`);
    }
    headPaths.add(path);
    if (type !== 'blob') {
      throw new SecretScanInventoryError(
        `${path} is a ${String(type)} in the HEAD tree, which this scan does not classify`,
      );
    }
    classify(path, mode, object, MERGED_STAGE, 'HEAD');
    add({ path, mode, object, stage: MERGED_STAGE }, 'HEAD');
  }

  // ------------------------------------------------------------------ index
  const listed = git(root, ['ls-files', '-s', '-z']);
  const seen = new Set();
  for (const record of listed.split('\0')) {
    if (record === '') continue;
    // `<mode> <object> <stage>\t<path>`
    const tab = record.indexOf('\t');
    if (tab < 0) {
      throw new SecretScanInventoryError(`cannot parse the index record ${JSON.stringify(record)}`);
    }
    const [mode, object, stage] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (seen.has(path)) {
      throw new SecretScanInventoryError(`the index lists ${path} more than once`);
    }
    seen.add(path);

    // The blob name and the index stage are the entry, not decoration. The OID
    // was read and thrown away, and the working-tree path was scanned in its
    // place — so a staged credential overwritten with clean text reported
    // nothing. A non-zero stage means an unmerged path, whose content is a
    // conflict rather than one blob, and is refused rather than guessed at.
    classify(path, mode, object, stage, 'index');
    add({ path, mode, object, stage }, 'index');
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
 * A sequential reader over one descriptor, in bounded chunks.
 *
 * `git cat-file --batch` emits every requested object into one stream as
 * `<oid> <type> <size>` and then exactly `size` bytes. Reading it needs a header
 * line and then an exact byte count, so the reader has to keep its own position
 * — and it must never hold more than a chunk, because the whole point of reading
 * blobs rather than files is that size decides nothing.
 */
function sequentialReader(fd) {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0;
  let filled = 0;
  let exhausted = false;

  const fill = () => {
    if (position < filled) return true;
    if (exhausted) return false;
    filled = readSync(fd, buffer, 0, CHUNK_BYTES, null);
    position = 0;
    if (filled === 0) {
      exhausted = true;
      return false;
    }
    return true;
  };

  return {
    /** The next line without its terminator, or null at end of stream. */
    readLine() {
      let out = '';
      for (;;) {
        if (!fill()) return out === '' ? null : out;
        const newline = buffer.subarray(position, filled).indexOf(0x0a);
        if (newline >= 0) {
          out += buffer.toString('latin1', position, position + newline);
          position += newline + 1;
          return out;
        }
        out += buffer.toString('latin1', position, filled);
        position = filled;
        if (out.length > MAX_LINE_BYTES) {
          throw new SecretScanInventoryError(
            `a single line exceeds ${String(MAX_LINE_BYTES)} bytes and cannot be scanned as one unit`,
          );
        }
      }
    },

    /**
     * Scans exactly `size` bytes as text, line by line.
     *
     * `onBytes` sees the same bytes as raw slices, so the caller can hash the
     * object as it goes. Hashing after the fact would mean holding it.
     */
    scanBytes(size, onLine, onBytes) {
      let remaining = size;
      let carry = '';
      let line = 1;
      while (remaining > 0) {
        if (!fill()) {
          throw new SecretScanInventoryError('the object stream ended before the object did');
        }
        const take = Math.min(remaining, filled - position);
        if (onBytes !== undefined) onBytes(buffer.subarray(position, position + take));
        const text = carry + buffer.toString('latin1', position, position + take);
        position += take;
        remaining -= take;
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
    },

    /** Discards exactly `count` bytes. */
    skip(count) {
      let remaining = count;
      while (remaining > 0) {
        if (!fill()) return;
        const take = Math.min(remaining, filled - position);
        position += take;
        remaining -= take;
      }
    },
  };
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
    // Keyed on path, object *and* mode. One path legitimately appears twice when
    // HEAD and the index name different blobs for it, and again when they name
    // the same blob under different modes — a regular file replaced by a symlink
    // with the same text. Both are cases this scan exists to see. The same blob
    // at the same path under the same mode is still a duplicate.
    const identity = JSON.stringify([inside, entry.object, entry.mode]);
    if (seen.has(identity)) {
      throw new SecretScanInventoryError(
        `the inventory lists ${rel} at object ${String(entry.object)} with mode ` +
          `${String(entry.mode)} more than once`,
      );
    }
    seen.add(identity);
  }

  const findings = [];
  const seenFindings = new Set();
  const notes = [];
  let scanned = 0;

  const record = (rel, source) => (line, number) => {
    for (const id of findingsInLine(line)) {
      // The same credential seen in the index and again in an identical
      // working-tree file is one finding, reported against the index.
      const key = JSON.stringify([rel, number, id]);
      if (seenFindings.has(key)) continue;
      seenFindings.add(key);
      findings.push({ rel, line: number, id, source });
    }
  };

  for (const entry of entries) {
    if (!REGULAR_MODES.has(entry.mode) && entry.mode !== SYMLINK_MODE) {
      throw new SecretScanInventoryError(
        `${entry.path} has inventory mode ${String(entry.mode)}, which this scan does not classify`,
      );
    }
    if (entry.stage !== undefined && entry.stage !== MERGED_STAGE) {
      throw new SecretScanInventoryError(
        `${entry.path} is at index stage ${String(entry.stage)}, not ${MERGED_STAGE}`,
      );
    }
    if (!OBJECT_ID.test(String(entry.object))) {
      throw new SecretScanInventoryError(
        `${entry.path} has index object ${String(entry.object)}, which is not a git object name`,
      );
    }
  }

  // Every indexed blob, in one `git cat-file --batch`, spilled to a file and
  // read back in bounded chunks. This is the content a commit would carry, and
  // it is scanned first and unconditionally: the working-tree path used to be
  // scanned in its place, so a staged credential overwritten with clean text
  // reported nothing at all.
  const algorithm = objectHashAlgorithm(root);
  const spillDir = mkdtempSync(join(tmpdir(), 'prsystem-secret-scan-'));
  const spillPath = join(spillDir, 'objects');
  try {
    const spill = openSync(spillPath, 'w');
    try {
      execFileSync('git', ['-C', root, '--no-replace-objects', 'cat-file', '--batch'], {
        input: entries.map((entry) => String(entry.object)).join('\n') + '\n',
        env: gitEnv(),
        stdio: ['pipe', spill, 'pipe'],
      });
    } catch (error) {
      throw new SecretScanInventoryError(`cannot read the indexed objects: ${messageOf(error)}`);
    } finally {
      closeSync(spill);
    }

    const objects = openSync(spillPath, 'r');
    try {
      const reader = sequentialReader(objects);
      for (const entry of entries) {
        const header = reader.readLine();
        if (header === null) {
          throw new SecretScanInventoryError(
            `the object stream ended before ${entry.path} was read`,
          );
        }
        const [reported, type, size] = header.split(' ');
        if (reported !== String(entry.object)) {
          throw new SecretScanInventoryError(
            `the object stream answered for ${String(reported)} where ${entry.path} asked for ` +
              `${String(entry.object)}`,
          );
        }
        if (type === 'missing') {
          throw new SecretScanInventoryError(
            `${entry.path} names object ${String(entry.object)}, which this repository does not ` +
              'hold: indexed content that cannot be read is refused, never skipped',
          );
        }
        if (type !== 'blob') {
          throw new SecretScanInventoryError(
            `${entry.path} names object ${String(entry.object)}, which is a ${String(type)} and ` +
              'not a blob: indexed content that cannot be read is refused, never skipped',
          );
        }
        const length = Number(size);
        if (!Number.isInteger(length) || length < 0) {
          throw new SecretScanInventoryError(
            `${entry.path} names object ${String(entry.object)} with an unreadable size ` +
              `${String(size)}`,
          );
        }
        // The object git returned, hashed back to a git object name.
        //
        // `--no-replace-objects` already refuses the substitution, and this
        // proves it independently: a replace ref made `cat-file` answer with a
        // different object while still printing the requested OID, so the header
        // cannot be taken as evidence of what the bytes are. Hashed
        // incrementally, so the object is still never held.
        const digest = createHash(algorithm);
        digest.update(`blob ${String(length)}\0`, 'latin1');
        try {
          reader.scanBytes(
            length,
            record(entry.path, (entry.sources ?? ['index']).join('+')),
            (chunk) => digest.update(chunk),
          );
        } catch (error) {
          if (error instanceof SecretScanInventoryError) {
            throw new SecretScanInventoryError(`${entry.path}: ${error.message}`);
          }
          throw error;
        }
        const actual = digest.digest('hex');
        if (actual !== String(entry.object)) {
          throw new SecretScanInventoryError(
            `${entry.path} names object ${String(entry.object)} but the bytes returned for it ` +
              `hash to ${actual}. Indexed content that cannot be verified is refused, never ` +
              'scanned as though it were the recorded object',
          );
        }
        reader.skip(1); // the newline `--batch` writes after each object
        scanned += 1;
      }
    } finally {
      closeSync(objects);
    }
  } finally {
    rmSync(spillDir, { recursive: true, force: true });
  }

  // The working tree, additionally. It cannot mask the indexed content — that
  // has already been scanned — so an entry that is absent or of another kind is
  // noted rather than fatal. The fail-closed obligation sits on the object side
  // above, where the authoritative content is.
  for (const entry of entries) {
    // Only the index entry, and only with the index entry's own mode. A path
    // that is in HEAD and not in the index — a staged deletion — has no
    // working-tree counterpart to read, and its committed content has already
    // been scanned.
    if (entry.sources !== undefined && !entry.sources.includes('index')) continue;
    const rel = entry.path;
    const abs = resolve(root, rel);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      notes.push(`${rel}: tracked but absent from the working tree; the indexed blob was scanned`);
      continue;
    }

    // The type the working tree actually has, not the type the index records.
    //
    // Trusting the recorded mode and writing a note when they differed skipped
    // the content entirely: a clean regular file replaced by an unstaged symlink
    // whose link text was a credential, and a clean symlink replaced by an
    // unstaged regular file holding one, each reported nothing and exited 0. The
    // divergence is still reported, but it decides how to read the entry, never
    // whether to read it.
    const indexedKind = entry.mode === SYMLINK_MODE ? 'a symlink' : 'a regular file';
    const actualKind = stat.isSymbolicLink()
      ? 'a symlink'
      : stat.isFile()
        ? 'a regular file'
        : undefined;
    if (actualKind === undefined) {
      throw new SecretScanInventoryError(
        `${rel} is neither a regular file nor a symlink in the working tree; this scan does not ` +
          'classify what it is, so it refuses rather than passing over it',
      );
    }
    if (actualKind !== indexedKind) {
      notes.push(`${rel}: indexed as ${indexedKind} but is ${actualKind} in the working tree`);
    }

    if (stat.isSymbolicLink()) {
      // The link text, never the target. Following it read /dev/null as an
      // empty scanned file and hung on /dev/zero.
      record(rel, 'worktree')(readlinkSync(abs), 1);
      continue;
    }

    let fd;
    try {
      fd = openSync(abs, 'r');
    } catch (error) {
      notes.push(`${rel}: cannot be read from the working tree (${messageOf(error)})`);
      continue;
    }
    try {
      scanDescriptor(fd, record(rel, 'worktree'));
    } catch (error) {
      if (error instanceof SecretScanInventoryError) {
        throw new SecretScanInventoryError(`${rel} (working tree): ${error.message}`);
      }
      throw error;
    } finally {
      closeSync(fd);
    }
  }

  return { scanned, findings, notes };
}

/** The whole gate for one repository: its tracked inventory, then the scan. */
export function scanRepository(root) {
  return scanEntries({ root, entries: gitInventory(root) });
}
