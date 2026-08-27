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

/*
 * Checks 12-15 contain the dependency-security risk recorded in
 * docs/implementation/dependency-security-register.md. The mitigation for
 * GHSA-67mh-4wv8-2f99 is containment, not a version bump, so containment is
 * asserted by a gate rather than trusted to reviewer memory.
 */

/** Tooling that must never reach a production dependency tree or runtime import. */
const DEV_ONLY_TOOLING = ['drizzle-kit'];

check('12', 'Development-only tooling never appears as a production dependency', () => {
  const offenders = [];
  for (const { rel, json } of allManifests()) {
    for (const name of DEV_ONLY_TOOLING) {
      if (json.dependencies?.[name]) offenders.push(`${rel} → dependencies.${name}`);
      if (json.optionalDependencies?.[name])
        offenders.push(`${rel} → optionalDependencies.${name}`);
      if (json.peerDependencies?.[name]) offenders.push(`${rel} → peerDependencies.${name}`);
    }
  }
  assert(offenders.length === 0, `production-scoped dev tooling: ${offenders.join('; ')}`);

  const declaring = allManifests().filter(({ json }) =>
    DEV_ONLY_TOOLING.some((name) => json.devDependencies?.[name]),
  );
  assert(declaring.length > 0, `${DEV_ONLY_TOOLING.join(', ')} is declared nowhere`);
  return `${DEV_ONLY_TOOLING.join(', ')} confined to devDependencies of ${declaring
    .map((d) => d.rel)
    .join(', ')}`;
});

check('13', 'No application or package source imports development-only tooling', () => {
  const { apps, pkgs } = workspaceDirs();
  const roots = [
    ...apps.map((d) => join(ROOT, 'apps', d)),
    ...pkgs.map((d) => join(ROOT, 'packages', d)),
    join(ROOT, 'e2e'),
  ];

  const sources = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next')
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) sources.push(full);
    }
  };
  // Only compiled/served source counts. drizzle.config.ts sits outside src/ and
  // outside every tsconfig `include`, so it never reaches a build output.
  for (const root of roots) {
    walk(join(root, 'src'));
    walk(join(root, 'app'));
  }
  walk(join(ROOT, 'e2e'));

  const offenders = [];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const name of DEV_ONLY_TOOLING) {
      // Covers `from 'x'`, bare `import 'x'`, `import('x')`, `require('x')` and
      // any subpath of them. A side-effect import is still an import.
      const imported = new RegExp(
        `(?:from|import|require)\\s*\\(?\\s*['"]${name}(?:/[^'"]*)?['"]`,
      ).test(text);
      if (imported) offenders.push(`${file.slice(ROOT.length + 1)} → ${name}`);
    }
  }
  assert(offenders.length === 0, `runtime imports of dev tooling: ${offenders.join('; ')}`);
  return `${sources.length} source files, none imports ${DEV_ONLY_TOOLING.join(' or ')}`;
});

check('14', 'No script or workflow starts the esbuild development server', () => {
  // GHSA-67mh-4wv8-2f99 is only exploitable while `esbuild --serve` is running.
  const serveMode = /--serve\b|--servedir\b|esbuild\s+serve\b/;
  const offenders = [];

  for (const { rel, json } of allManifests()) {
    for (const [name, body] of Object.entries(json.scripts ?? {})) {
      if (serveMode.test(body)) offenders.push(`${rel} → ${name}`);
    }
  }

  const workflowDir = join(ROOT, '.github', 'workflows');
  const workflows = existsSync(workflowDir)
    ? readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    : [];
  for (const file of workflows) {
    const text = readFileSync(join(workflowDir, file), 'utf8');
    if (serveMode.test(text)) offenders.push(`.github/workflows/${file}`);
  }

  assert(offenders.length === 0, `esbuild serve mode invoked in: ${offenders.join('; ')}`);
  return `no serve mode in any script or in ${workflows.length} workflow(s)`;
});

check('15', 'CI enforces the production and full-tree audit thresholds', () => {
  const root = readJson(join(ROOT, 'package.json'));
  const expected = {
    'audit:prod': 'pnpm audit --prod --audit-level moderate',
    'audit:tree': 'pnpm audit --audit-level high',
  };
  for (const [name, body] of Object.entries(expected)) {
    assert(root.scripts?.[name] === body, `root script ${name} must be exactly \`${body}\``);
  }

  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const name of Object.keys(expected)) {
    assert(ci.includes(`pnpm run ${name}`), `ci.yml never runs pnpm run ${name}`);
  }

  // The production audit must be able to fail the build; a dev-tree advisory
  // must not. Anything else would either hide a shipped vulnerability or block
  // every phase on tooling the runtime never loads.
  const prodStep = ci.slice(ci.indexOf('pnpm run audit:prod'));
  const nextStep = prodStep.indexOf('\n      - name:');
  assert(
    !/continue-on-error:\s*true/.test(prodStep.slice(0, nextStep === -1 ? undefined : nextStep)),
    'the production audit step is marked continue-on-error and cannot block',
  );
  return 'audit:prod blocking at moderate, audit:tree enabled at high';
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
