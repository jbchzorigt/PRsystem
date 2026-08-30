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
// **The inventory fails closed.** These fixtures call `scanFiles` directly, with
// an explicit temporary inventory. They used to drive the production CLI through
// PRSYSTEM_SCAN_ROOT and PRSYSTEM_SCAN_FILES, and that seam made the gate itself
// redirectable: setting the root alone pointed the repository's file list at
// another directory, read nothing, and exited 0. The CLI now takes no
// configuration at all, and a fixture below proves those variables no longer
// change what it scans.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINARY_EXT, SecretScanInventoryError, scanFiles } from './secret-scan.mjs';

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
    const { scanned, findings } = scanFiles({ root: dir, files: ['src/probe.ts'] });
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
    build: (dir) => ({ root: dir, files: [] }),
    expect: /inventory is empty/,
  },
  {
    name: 'inventory: a missing file is refused',
    build: (dir) => ({ root: dir, files: ['src/absent.ts'] }),
    expect: /cannot read src\/absent\.ts/,
  },
  {
    name: 'inventory: an unreadable file is refused',
    build: (dir) => {
      mkdirSync(join(dir, 'src'), { recursive: true });
      const path = join(dir, 'src', 'locked.ts');
      writeFileSync(path, 'export const a = 1;\n');
      chmodSync(path, 0o000);
      return { root: dir, files: ['src/locked.ts'] };
    },
    expect: /cannot read src\/locked\.ts/,
  },
  {
    name: 'inventory: an absolute path is refused',
    build: (dir) => ({ root: dir, files: ['/etc/hosts'] }),
    expect: /must be relative to the root/,
  },
  {
    name: 'inventory: a path escaping the root is refused',
    build: (dir) => ({ root: dir, files: ['../outside.ts'] }),
    expect: /escapes the scan root/,
  },
  {
    name: 'inventory: a duplicate path is refused',
    build: (dir) => {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'probe.ts'), 'export const a = 1;\n');
      return { root: dir, files: ['src/probe.ts', 'src/probe.ts'] };
    },
    expect: /more than once/,
  },
  {
    name: 'inventory: an empty path entry is refused',
    build: (dir) => ({ root: dir, files: [''] }),
    expect: /holds an empty path/,
  },
  {
    name: 'inventory: a missing root is refused',
    build: () => ({ root: undefined, files: ['src/probe.ts'] }),
    expect: /a scan root is required/,
  },
  {
    name: 'inventory: a relative root is refused',
    build: () => ({ root: 'tools', files: ['src/probe.ts'] }),
    expect: /scan root must be absolute/,
  },
  {
    name: 'inventory: a root that is not a directory is refused',
    build: (dir) => {
      const path = join(dir, 'not-a-dir');
      writeFileSync(path, '');
      return { root: path, files: ['probe.ts'] };
    },
    expect: /not a directory/,
  },
  {
    name: 'inventory: a file list that is not an array is refused',
    build: (dir) => ({ root: dir, files: 'src/probe.ts' }),
    expect: /must be an array/,
  },
];

for (const fixture of INVENTORY_FIXTURES) {
  inTempDir((dir) => {
    let raised;
    try {
      scanFiles(fixture.build(dir));
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
  const { scanned, findings } = scanFiles({ root: dir, files: ['src/a.ts', 'src/b.ts'] });
  const ok = scanned === 2 && findings.length === 0;
  record(
    'inventory: a valid two-file inventory is scanned',
    ok,
    ok ? 'scanned 2' : `scanned ${String(scanned)}, ${String(findings.length)} finding(s)`,
  );
});

// ---------------------------------------------------------------------- CLI
/** Every tracked text file the CLI is required to scan. */
function trackedTextFiles() {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error('git ls-files failed');
  return listed.stdout
    .split('\0')
    .filter(Boolean)
    .filter((f) => !BINARY_EXT.has(extname(f)));
}

const expectedInventory = trackedTextFiles().length;

function runCli(env) {
  return spawnSync(process.execPath, [join(ROOT, 'tools', 'scan-secrets.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const control = runCli({});
const reported = /secret scan — (\d+) tracked text files/.exec(control.stdout)?.[1];
record(
  'control: the CLI scans every tracked text file and the repository is clean',
  control.status === 0 && Number(reported) === expectedInventory,
  control.status === 0
    ? `scanned ${String(reported)} of ${String(expectedInventory)} tracked text files`
    : `reported (exit ${String(control.status)})`,
);

// The override variables the CLI used to honour. Each of these once produced a
// zero-file scan that exited 0.
const IGNORED_OVERRIDES = [
  { PRSYSTEM_SCAN_ROOT: tmpdir() },
  { PRSYSTEM_SCAN_ROOT: tmpdir(), PRSYSTEM_SCAN_FILES: '' },
  { PRSYSTEM_SCAN_ROOT: tmpdir(), PRSYSTEM_SCAN_FILES: 'does/not/exist.ts' },
  { PRSYSTEM_SCAN_FILES: '/etc/hosts' },
];
for (const env of IGNORED_OVERRIDES) {
  const run = runCli(env);
  const scanned = /secret scan — (\d+) tracked text files/.exec(run.stdout)?.[1];
  const ok = run.status === 0 && Number(scanned) === expectedInventory;
  record(
    `CLI: ${Object.keys(env).join(' + ')} does not redirect the scan`,
    ok,
    ok
      ? `still scanned ${String(scanned)}`
      : `scanned ${String(scanned)} (exit ${String(run.status)})`,
  );
}

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name.padEnd(width)}  ${r.detail}`);
}
console.log(
  `\nsecret-scan fixtures: ${String(results.length - failures)}/${String(results.length)} correct` +
    (failures ? `, ${String(failures)} WRONG` : ''),
);
process.exit(failures ? 1 : 0);
