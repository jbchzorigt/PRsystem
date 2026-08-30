#!/usr/bin/env node
// Negative fixtures for the committed-secret scanner.
//
//   node tools/validate-secret-scan.fixtures.mjs
//
// Two properties, both proved here.
//
// **Allowances are exact.** The scanner carries an allow-list of synthetic
// fixture values so tests can assert a credential is redacted. An allowance must
// cover the synthetic value and nothing else — never a substring of a different
// value, and never a whole line or file.
//
// **The inventory fails closed.** These fixtures call `scanEntries` and
// `scanRepository` directly, against inventories and whole git repositories they
// build in a temporary directory. They used to drive the production CLI through
// PRSYSTEM_SCAN_ROOT and PRSYSTEM_SCAN_FILES, and that seam made the gate itself
// redirectable. The CLI now takes no configuration at all.
//
// **Git's own environment is not a way in.** GIT_INDEX_FILE alone pointed the
// enumeration at a one-entry index, and the gate reported one clean tracked file
// and exited 0 — while this harness, inheriting the same variable, computed the
// same one-file expectation and reported every fixture correct. The scanner
// strips GIT_* before enumerating, and the expectation below is computed with a
// sanitised environment so the two cannot agree on a poisoned answer.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SecretScanInventoryError,
  gitInventory,
  sanitisedGitEnv,
  scanEntries,
  scanRepository,
} from './secret-scan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The probe content is assembled rather than written literally.
//
// These fixtures exist to contain credential shapes, so spelling them out would
// make this file a finding. Exempting the whole file would be the very thing the
// exact-value rule removed, so the key names are joined at runtime instead. The
// bytes written to the probe file are unchanged.
const KEY = ['pass', 'word'].join('');
const SECRET_KEY = ['sec', 'ret'].join('');

const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}

/** Runs `body` in a fresh temporary directory and removes it afterwards. */
function inTempDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'prsystem-scan-fixture-'));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ content
const CONTENT_FIXTURES = [
  {
    name: 'an allowed literal cannot conceal another secret on the same line',
    content: `${KEY} = "this-is-a-real-looking-${KEY}" # startup-log-probe-${KEY}\n`,
    expectFinding: true,
  },
  {
    name: 'an allowed literal alone is still allowed',
    content: `const ${KEY} = "startup-log-probe-${KEY}";\n`,
    expectFinding: false,
  },
  {
    name: 'an allowed literal does not exempt an assignment later on the line',
    content:
      `const a = "super-${SECRET_KEY}-scheduler-${KEY}"; ` +
      `const ${SECRET_KEY} = "another-actual-${SECRET_KEY}-value";\n`,
    expectFinding: true,
  },
  {
    name: 'an allowed value with a suffix is a different credential',
    content: `export const one = { ${KEY}: "startup-log-probe-${KEY}X" };\n`,
    expectFinding: true,
  },
  {
    name: 'an allowed value with a prefix is a different credential',
    content: `export const two = { ${KEY}: "Xstartup-log-probe-${KEY}" };\n`,
    expectFinding: true,
  },
  {
    name: 'an allowed value with a prefix and a suffix is a different credential',
    content: `export const three = { ${KEY}: "Xstartup-log-probe-${KEY}Y" };\n`,
    expectFinding: true,
  },
  {
    name: 'an allowed value does not shadow another secret beside it',
    content:
      `export const four = { ${KEY}: "startup-log-probe-${KEY}", ` +
      `${SECRET_KEY}: "another-actual-${SECRET_KEY}-value" };\n`,
    expectFinding: true,
  },
  {
    name: 'the exact synthetic allowed credential stays clean',
    content: `export const five = { ${KEY}: "startup-log-probe-${KEY}" };\n`,
    expectFinding: false,
  },
  {
    name: 'a credential-shaped assignment on its own is still found',
    content: `const ${KEY} = "aVeryLongLookingValue123456789";\n`,
    expectFinding: true,
  },
  {
    name: 'ordinary source is still clean',
    content: 'export const limit = 10;\n',
    expectFinding: false,
  },
];

for (const fixture of CONTENT_FIXTURES) {
  inTempDir((dir) => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'probe.ts'), fixture.content);
    const { scanned, findings } = scanEntries({
      root: dir,
      entries: [{ path: 'src/probe.ts', mode: '100644' }],
    });
    const found = findings.length > 0;
    const ok = scanned === 1 && found === fixture.expectFinding;
    record(
      fixture.name,
      ok,
      ok
        ? fixture.expectFinding
          ? 'reported'
          : 'clean'
        : fixture.expectFinding
          ? 'MISSED — the secret was not reported'
          : `false positive (${String(findings.length)} finding(s))`,
    );
  });
}

// ---------------------------------------------------------------- inventory
const INVENTORY_FIXTURES = [
  {
    name: 'inventory: an empty file list is refused',
    build: (dir) => ({ root: dir, entries: [] }),
    expect: /inventory is empty/,
  },
  {
    name: 'inventory: a missing file is refused',
    build: (dir) => ({ root: dir, entries: [{ path: 'src/absent.ts', mode: '100644' }] }),
    expect: /cannot read src\/absent\.ts/,
  },
  {
    name: 'inventory: an unreadable file is refused',
    build: (dir) => {
      mkdirSync(join(dir, 'src'), { recursive: true });
      const path = join(dir, 'src', 'locked.ts');
      writeFileSync(path, 'export const a = 1;\n');
      chmodSync(path, 0o000);
      return { root: dir, entries: [{ path: 'src/locked.ts', mode: '100644' }] };
    },
    expect: /cannot read src\/locked\.ts/,
  },
  {
    name: 'inventory: an absolute path is refused',
    build: (dir) => ({ root: dir, entries: [{ path: '/etc/hosts', mode: '100644' }] }),
    expect: /must be relative to the root/,
  },
  {
    name: 'inventory: a path escaping the root is refused',
    build: (dir) => ({ root: dir, entries: [{ path: '../outside.ts', mode: '100644' }] }),
    expect: /escapes the scan root/,
  },
  {
    name: 'inventory: a duplicate path is refused',
    build: (dir) => {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'probe.ts'), 'export const a = 1;\n');
      return {
        root: dir,
        entries: [
          { path: 'src/probe.ts', mode: '100644' },
          { path: 'src/probe.ts', mode: '100644' },
        ],
      };
    },
    expect: /more than once/,
  },
  {
    name: 'inventory: an empty path entry is refused',
    build: (dir) => ({ root: dir, entries: [{ path: '', mode: '100644' }] }),
    expect: /holds an empty path/,
  },
  {
    name: 'inventory: a missing root is refused',
    build: () => ({ root: undefined, entries: [{ path: 'src/probe.ts', mode: '100644' }] }),
    expect: /a scan root is required/,
  },
  {
    name: 'inventory: a relative root is refused',
    build: () => ({ root: 'tools', entries: [{ path: 'src/probe.ts', mode: '100644' }] }),
    expect: /scan root must be absolute/,
  },
  {
    name: 'inventory: a root that is not a directory is refused',
    build: (dir) => {
      const path = join(dir, 'not-a-dir');
      writeFileSync(path, '');
      return { root: path, entries: [{ path: 'probe.ts', mode: '100644' }] };
    },
    expect: /not a directory/,
  },
  {
    name: 'inventory: an entry list that is not an array is refused',
    build: (dir) => ({ root: dir, entries: 'src/probe.ts' }),
    expect: /must be an array/,
  },
  {
    name: 'inventory: an unclassified index mode is refused',
    build: (dir) => {
      writeFileSync(join(dir, 'probe.ts'), 'export const a = 1;\n');
      return { root: dir, entries: [{ path: 'probe.ts', mode: '160000' }] };
    },
    expect: /does not classify/,
  },
  {
    name: 'inventory: a regular entry that is really a symlink is refused',
    build: (dir) => {
      writeFileSync(join(dir, 'real.ts'), 'export const a = 1;\n');
      symlinkSync(join(dir, 'real.ts'), join(dir, 'link.ts'));
      return { root: dir, entries: [{ path: 'link.ts', mode: '100644' }] };
    },
    expect: /recorded as a regular file but is not one/,
  },
  {
    name: 'inventory: a symlink whose link text no longer matches is refused',
    build: (dir) => {
      symlinkSync('/dev/null', join(dir, 'link.ts'));
      return { root: dir, entries: [{ path: 'link.ts', mode: '120000', target: '/dev/urandom' }] };
    },
    expect: /points at \/dev\/null but the index records \/dev\/urandom/,
  },
];

for (const fixture of INVENTORY_FIXTURES) {
  inTempDir((dir) => {
    let raised;
    try {
      scanEntries(fixture.build(dir));
    } catch (error) {
      raised = error;
    } finally {
      // The unreadable-file fixture leaves a mode that would defeat removal.
      try {
        chmodSync(join(dir, 'src', 'locked.ts'), 0o600);
      } catch {
        /* not that fixture */
      }
    }
    const ok = raised instanceof SecretScanInventoryError && fixture.expect.test(raised.message);
    record(
      fixture.name,
      ok,
      ok ? 'refused' : `NOT REFUSED — ${raised === undefined ? 'accepted' : String(raised)}`,
    );
  });
}

// A valid inventory still scans, so the refusals above are not blanket.
inTempDir((dir) => {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
  const { scanned, findings } = scanEntries({
    root: dir,
    entries: [
      { path: 'src/a.ts', mode: '100644' },
      { path: 'src/b.ts', mode: '100644' },
    ],
  });
  const ok = scanned === 2 && findings.length === 0;
  record(
    'inventory: a valid two-file inventory is scanned',
    ok,
    ok ? 'scanned 2' : `scanned ${String(scanned)}, ${String(findings.length)} finding(s)`,
  );
});

// ------------------------------------------------------ whole-repository
/** Builds a throwaway git repository and returns its root. */
function repository(dir, build) {
  const run = (args) =>
    execFileSync('git', ['-C', dir, ...args], { env: sanitisedGitEnv(), stdio: 'ignore' });
  run(['init', '-q']);
  run(['config', 'user.email', 'fixture@example.invalid']);
  run(['config', 'user.name', 'fixture']);
  build(dir);
  run(['add', '-A']);
  return dir;
}

/** A credential shape, assembled so this file is not itself a finding. */
const LEAK = `const ${KEY} = "an-actual-looking-credential-1234";\n`;

const REPOSITORY_FIXTURES = [
  {
    name: 'repository: a plaintext credential in leak.png is still reported',
    build: (dir) => writeFileSync(join(dir, 'leak.png'), LEAK),
    expectFindings: 1,
  },
  {
    name: 'repository: a credential in an oversized text file is still reported',
    // Larger than the 2,000,000-byte limit that used to skip the file whole,
    // with the credential on the first line the old scan never read.
    build: (dir) => writeFileSync(join(dir, 'big.ts'), LEAK + 'a'.repeat(2_100_000) + '\n'),
    expectFindings: 1,
  },
  {
    name: 'repository: a symlink to /dev/null is scanned as its link text',
    build: (dir) => symlinkSync('/dev/null', join(dir, 'devnull.ts')),
    expectFindings: 0,
    expectScanned: 1,
  },
  {
    name: 'repository: a symlink to /dev/zero terminates instead of hanging',
    build: (dir) => symlinkSync('/dev/zero', join(dir, 'zero.ts')),
    expectFindings: 0,
    expectScanned: 1,
    maxMillis: 10_000,
  },
  {
    name: 'repository: a symlink out of the tree does not pull in outside content',
    build: (dir) => {
      const outside = join(dir, '..', 'outside-secret.ts');
      writeFileSync(outside, LEAK);
      symlinkSync(outside, join(dir, 'outside.ts'));
    },
    expectFindings: 0,
    expectScanned: 1,
  },
  {
    name: 'repository: an ordinary clean repository scans every tracked file',
    build: (dir) => {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
    },
    expectFindings: 0,
    expectScanned: 3,
  },
];

for (const fixture of REPOSITORY_FIXTURES) {
  inTempDir((dir) => {
    const root = repository(join(dir, 'repo'), fixture.build, mkdirSync(join(dir, 'repo')));
    const started = Date.now();
    let result;
    let raised;
    try {
      result = scanRepository(root);
    } catch (error) {
      raised = error;
    }
    const elapsed = Date.now() - started;
    const findings = result?.findings.length ?? -1;
    const scannedOk =
      fixture.expectScanned === undefined || result?.scanned === fixture.expectScanned;
    const timeOk = fixture.maxMillis === undefined || elapsed < fixture.maxMillis;
    const ok = raised === undefined && findings === fixture.expectFindings && scannedOk && timeOk;
    record(
      fixture.name,
      ok,
      raised !== undefined
        ? `raised ${String(raised)}`
        : `scanned ${String(result?.scanned)}, ${String(findings)} finding(s), ${String(elapsed)}ms`,
    );
  });
}

// A submodule is content this scan cannot reach, and is refused rather than
// passed over.
inTempDir((dir) => {
  mkdirSync(join(dir, 'inner'), { recursive: true });
  const inner = repository(join(dir, 'inner'), (at) =>
    writeFileSync(join(at, 'a.ts'), 'export const a = 1;\n'),
  );
  execFileSync('git', ['-C', inner, 'commit', '-qm', 'inner'], {
    env: sanitisedGitEnv(),
    stdio: 'ignore',
  });
  mkdirSync(join(dir, 'outer'), { recursive: true });
  const outer = join(dir, 'outer');
  const run = (args) =>
    execFileSync('git', ['-C', outer, ...args], { env: sanitisedGitEnv(), stdio: 'ignore' });
  run(['init', '-q']);
  run(['config', 'user.email', 'fixture@example.invalid']);
  run(['config', 'user.name', 'fixture']);
  run(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'vendor']);
  let raised;
  try {
    scanRepository(outer);
  } catch (error) {
    raised = error;
  }
  const ok =
    raised instanceof SecretScanInventoryError && /gitlink \(submodule\)/.test(raised.message);
  record(
    'repository: a submodule gitlink is refused, not passed over',
    ok,
    ok ? 'refused' : `NOT REFUSED — ${raised === undefined ? 'accepted' : String(raised)}`,
  );
});

// ---------------------------------------------------------------------- CLI
/**
 * The inventory the CLI is required to scan, computed with a clean environment.
 *
 * Deliberately not `process.env`: this harness once inherited the same
 * GIT_INDEX_FILE that redirected the scanner, computed the same one-file
 * expectation, and reported every fixture correct.
 */
function trackedFileCount() {
  const listed = spawnSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: sanitisedGitEnv(),
  });
  if (listed.status !== 0) throw new Error('git ls-files failed');
  return listed.stdout.split('\0').filter(Boolean).length;
}

const expectedInventory = trackedFileCount();
record(
  'control: the inventory helper agrees with the scanner core',
  gitInventory(ROOT).length === expectedInventory,
  `${String(gitInventory(ROOT).length)} of ${String(expectedInventory)} tracked entries`,
);

function runCli(env) {
  return spawnSync(process.execPath, [join(ROOT, 'tools', 'scan-secrets.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const control = runCli({});
const reported = /secret scan — (\d+) tracked files/.exec(control.stdout)?.[1];
record(
  'control: the CLI scans every tracked file and the repository is clean',
  control.status === 0 && Number(reported) === expectedInventory,
  control.status === 0
    ? `scanned ${String(reported)} of ${String(expectedInventory)} tracked files`
    : `reported (exit ${String(control.status)})`,
);

// Every environment variable that once chose the inventory for the scanner.
// `PRSYSTEM_*` were the CLI's own; `GIT_*` are git's, and reached it through the
// subprocess it runs.
const alternateIndex = join(mkdtempSync(join(tmpdir(), 'prsystem-alt-index-')), 'alt.index');
execFileSync('git', ['-C', ROOT, 'read-tree', '--empty'], {
  env: { ...sanitisedGitEnv(), GIT_INDEX_FILE: alternateIndex },
  stdio: 'ignore',
});
execFileSync('git', ['-C', ROOT, 'add', '--', 'package.json'], {
  env: { ...sanitisedGitEnv(), GIT_INDEX_FILE: alternateIndex },
  stdio: 'ignore',
});
const decoyGitDir = join(mkdtempSync(join(tmpdir(), 'prsystem-alt-gitdir-')), 'decoy.git');
execFileSync('git', ['init', '-q', '--bare', decoyGitDir], {
  env: sanitisedGitEnv(),
  stdio: 'ignore',
});
execFileSync('git', ['add', '--', 'package.json'], {
  cwd: ROOT,
  env: { ...sanitisedGitEnv(), GIT_DIR: decoyGitDir, GIT_WORK_TREE: ROOT },
  stdio: 'ignore',
});

const IGNORED_OVERRIDES = [
  { PRSYSTEM_SCAN_ROOT: tmpdir() },
  { PRSYSTEM_SCAN_ROOT: tmpdir(), PRSYSTEM_SCAN_FILES: '' },
  { PRSYSTEM_SCAN_FILES: '/etc/hosts' },
  { GIT_INDEX_FILE: alternateIndex },
  { GIT_DIR: decoyGitDir, GIT_WORK_TREE: ROOT },
  { GIT_DIR: decoyGitDir },
  { GIT_WORK_TREE: tmpdir() },
  { GIT_CEILING_DIRECTORIES: ROOT },
];
for (const env of IGNORED_OVERRIDES) {
  const run = runCli(env);
  const scanned = /secret scan — (\d+) tracked files/.exec(run.stdout)?.[1];
  const ok = run.status === 0 && Number(scanned) === expectedInventory;
  record(
    `CLI: ${Object.keys(env).join(' + ')} does not redirect the scan`,
    ok,
    ok
      ? `still scanned ${String(scanned)}`
      : `scanned ${String(scanned)} (exit ${String(run.status)})`,
  );
}
rmSync(dirname(alternateIndex), { recursive: true, force: true });
rmSync(dirname(decoyGitDir), { recursive: true, force: true });

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name.padEnd(width)}  ${r.detail}`);
}
console.log(
  `\nsecret-scan fixtures: ${String(results.length - failures)}/${String(results.length)} correct` +
    (failures ? `, ${String(failures)} WRONG` : ''),
);
process.exit(failures ? 1 : 0);
