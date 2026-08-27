#!/usr/bin/env node
// Workspace structure validation — Phase 02 gate.
//
//   node tools/validate-workspace.mjs
//
// Exit 0 = all checks pass, 1 = at least one failed.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const EXPECTED_APPS = [
  'api',
  'worker',
  'web-public',
  'web-hotel',
  'web-restaurant',
  'web-police',
  'web-operation',
];

/** Approved shared packages (build-plan.md §1). Only these may exist under packages/. */
const APPROVED_PACKAGES = [
  'authz',
  'config',
  'contracts',
  'db',
  'money',
  'outbox',
  'ports',
  'telemetry',
  'testing',
  'time',
];

const results = [];
const check = (id, title, fn) => {
  try {
    results.push({ id, title, ok: true, detail: fn() });
  } catch (err) {
    results.push({ id, title, ok: false, detail: err.message });
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const workspaceDirs = () => {
  const apps = existsSync(join(ROOT, 'apps'))
    ? readdirSync(join(ROOT, 'apps')).filter((d) =>
        existsSync(join(ROOT, 'apps', d, 'package.json')),
      )
    : [];
  const pkgs = existsSync(join(ROOT, 'packages'))
    ? readdirSync(join(ROOT, 'packages')).filter((d) =>
        existsSync(join(ROOT, 'packages', d, 'package.json')),
      )
    : [];
  return { apps, pkgs };
};

const allManifests = () => {
  const { apps, pkgs } = workspaceDirs();
  return [
    { rel: 'package.json', json: readJson(join(ROOT, 'package.json')) },
    ...apps.map((d) => ({
      rel: `apps/${d}/package.json`,
      json: readJson(join(ROOT, 'apps', d, 'package.json')),
    })),
    ...pkgs.map((d) => ({
      rel: `packages/${d}/package.json`,
      json: readJson(join(ROOT, 'packages', d, 'package.json')),
    })),
  ];
};

check('1', 'Workspace globs cover apps and packages', () => {
  const yaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  for (const glob of ["'apps/*'", "'packages/*'"]) {
    assert(yaml.includes(glob), `pnpm-workspace.yaml is missing ${glob}`);
  }
  return 'apps/* and packages/* declared';
});

check('2', 'Every approved application exists', () => {
  const { apps } = workspaceDirs();
  const missing = EXPECTED_APPS.filter((a) => !apps.includes(a));
  assert(missing.length === 0, `missing applications: ${missing.join(', ')}`);
  const extra = apps.filter((a) => !EXPECTED_APPS.includes(a));
  assert(extra.length === 0, `unapproved applications present: ${extra.join(', ')}`);
  return `${apps.length}/${EXPECTED_APPS.length} applications`;
});

check('3', 'Only approved shared packages exist', () => {
  const { pkgs } = workspaceDirs();
  const extra = pkgs.filter((p) => !APPROVED_PACKAGES.includes(p));
  assert(extra.length === 0, `unapproved packages present: ${extra.join(', ')}`);
  return `${pkgs.length} package(s): ${pkgs.join(', ')}`;
});

check('4', 'Package names follow the @prsystem/<dir> convention', () => {
  const { apps, pkgs } = workspaceDirs();
  const bad = [];
  for (const d of apps) {
    const name = readJson(join(ROOT, 'apps', d, 'package.json')).name;
    if (name !== `@prsystem/${d}`) bad.push(`apps/${d} → ${name}`);
  }
  for (const d of pkgs) {
    const name = readJson(join(ROOT, 'packages', d, 'package.json')).name;
    if (name !== `@prsystem/${d}`) bad.push(`packages/${d} → ${name}`);
  }
  assert(bad.length === 0, `misnamed: ${bad.join('; ')}`);
  return `${apps.length + pkgs.length} names conform`;
});

check('5', 'No floating dependency ranges anywhere', () => {
  const offenders = [];
  const floating = /^[\^~]|^[><]|\*|\bx\b|\|\||^latest$|^next$/;

  for (const { rel, json } of allManifests()) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(json[field] ?? {})) {
        if (range.startsWith('workspace:')) continue;
        if (floating.test(range)) offenders.push(`${rel} → ${dep}@${range}`);
      }
    }
  }
  assert(offenders.length === 0, `floating ranges: ${offenders.join('; ')}`);
  return 'every external dependency is pinned to an exact version';
});

check('6', 'Root pins the package manager and the Node engine', () => {
  const root = readJson(join(ROOT, 'package.json'));
  assert(
    /^pnpm@\d+\.\d+\.\d+$/.test(root.packageManager ?? ''),
    'packageManager is not pinned exactly',
  );
  assert(root.engines?.node, 'engines.node is not declared');
  return `${root.packageManager}, node ${root.engines.node}`;
});

check('7', 'Every workspace project declares the required scripts', () => {
  const { apps, pkgs } = workspaceDirs();
  const required = ['lint', 'typecheck', 'build'];
  const missing = [];

  for (const [base, dirs] of [
    ['apps', apps],
    ['packages', pkgs],
  ]) {
    for (const d of dirs) {
      const json = readJson(join(ROOT, base, d, 'package.json'));
      for (const script of required) {
        if (!json.scripts?.[script]) missing.push(`${base}/${d} → ${script}`);
      }
    }
  }
  assert(missing.length === 0, `missing scripts: ${missing.join('; ')}`);
  return `lint, typecheck, build present in ${apps.length + pkgs.length} projects`;
});

check('8', 'No script is a no-op that always reports success', () => {
  const noop = /^(echo\b|true$|exit 0$|:\s*$)/;
  const offenders = [];
  for (const { rel, json } of allManifests()) {
    for (const [name, body] of Object.entries(json.scripts ?? {})) {
      if (noop.test(body.trim())) offenders.push(`${rel} → ${name}: ${body}`);
    }
  }
  assert(offenders.length === 0, `placeholder scripts: ${offenders.join('; ')}`);
  return 'every script performs real work';
});

check('9', 'Every project extends the shared strict TypeScript base', () => {
  const { apps, pkgs } = workspaceDirs();
  const base = readJson(join(ROOT, 'tsconfig.base.json'));
  for (const flag of [
    'strict',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noImplicitOverride',
  ]) {
    assert(base.compilerOptions?.[flag] === true, `tsconfig.base.json does not set ${flag}`);
  }

  const bad = [];
  for (const [dirBase, dirs] of [
    ['apps', apps],
    ['packages', pkgs],
  ]) {
    for (const d of dirs) {
      const p = join(ROOT, dirBase, d, 'tsconfig.json');
      assert(existsSync(p), `${dirBase}/${d} has no tsconfig.json`);
      const cfg = readJson(p);
      if (!String(cfg.extends ?? '').includes('tsconfig.base.json')) {
        bad.push(`${dirBase}/${d}`);
      }
    }
  }
  assert(bad.length === 0, `does not extend the strict base: ${bad.join(', ')}`);
  return 'four strict flags enforced from one base config';
});

check('10', 'Environment example exists, is complete, and carries no real secret', () => {
  const p = join(ROOT, '.env.example');
  assert(existsSync(p), '.env.example is missing');
  const text = readFileSync(p, 'utf8');

  const required = [
    'DATABASE_URL',
    'REDIS_URL',
    'OBJECT_STORAGE_ENDPOINT',
    'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_ACCESS_KEY_ID',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    'SMTP_HOST',
    'SMTP_PORT',
    'API_PORT',
    'LOG_LEVEL',
  ];
  const missing = required.filter((k) => !new RegExp(`^${k}=`, 'm').test(text));
  assert(missing.length === 0, `.env.example is missing keys: ${missing.join(', ')}`);

  // Values must be recognisably local placeholders, never a real credential.
  for (const [, key, value] of text.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) {
    if (!/(SECRET|PASSWORD|KEY|TOKEN)/.test(key)) continue;
    assert(
      /local|example|changeme|placeholder/i.test(value) || value === '',
      `.env.example ${key} does not look like a local placeholder`,
    );
  }

  assert(
    readFileSync(join(ROOT, '.gitignore'), 'utf8').includes('.env'),
    '.gitignore does not ignore .env',
  );
  return `${required.length} required keys present, all secret-shaped values are local placeholders`;
});

check('11', 'Compose provides the four local backing services', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  for (const service of ['postgres:', 'redis:', 'minio:', 'mailpit:']) {
    assert(compose.includes(`  ${service}`), `docker-compose.yml has no ${service} service`);
  }
  const healthchecks = compose.match(/healthcheck:/g) ?? [];
  assert(healthchecks.length >= 4, `only ${healthchecks.length} healthchecks defined, expected 4`);
  const images = [...compose.matchAll(/^\s+image:\s*(\S+)$/gm)].map((m) => m[1]);
  const unpinned = images.filter((i) => i.endsWith(':latest') || !i.includes(':'));
  assert(unpinned.length === 0, `unpinned images: ${unpinned.join(', ')}`);
  return `${images.length} pinned images, ${healthchecks.length} healthchecks`;
});

let failed = 0;
const width = Math.max(...results.map((r) => r.title.length));
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.id}. ${r.title.padEnd(width)}  ${r.detail}`);
}
console.log(
  `\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`,
);
process.exit(failed ? 1 : 0);
