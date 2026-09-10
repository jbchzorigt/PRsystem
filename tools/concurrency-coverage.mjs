// The consolidated concurrency coverage check — Phase 22 (build-plan §Phase 22,
// docs/architecture/11-concurrency-strategy.md, CLAUDE.md §6).
//
// Every money- or lifecycle-changing command in the API claims an idempotency
// key under an operation name (`claim(uow, '<module>.<command>', …)`). This
// module discovers those names from the source, holds them to the manifest in
// `tools/concurrency-manifest.mjs` in both directions, and for every command the
// manifest says is raced, checks that the named concurrency suite exists, is
// part of `GATE-CONC` (`pnpm run test:concurrency`) and exercises the command's
// service method. A command the manifest lists as `duplicate-submit only`
// relies on the kernel's idempotency proof, which is checked to exist by title.
//
// The point is that "every money and lifecycle command has its concurrency
// story written down" is a build failure when it stops being true — a new
// command without a manifest entry, a suite renamed away, a race test that
// no longer calls the method it claims to race.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const KERNEL_SUITE = 'packages/db/src/concurrency/kernel.test.ts';
/** The kernel proofs every command inherits by going through `claim()`. */
export const KERNEL_IDEMPOTENCY_TITLES = [
  'produces exactly one effect for concurrent identical requests',
  'replays the stored response instead of repeating the effect',
  'is insensitive to key order in the request body',
  'rejects the same key carrying a different payload',
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Every `claim()` operation in the API's services, with the method that claims it. */
export function discoverOperations(root) {
  const modules = resolve(root, 'apps/api/src/modules');
  const found = new Map();
  for (const file of walk(modules)) {
    if (!/\/services\/[^/]+\.ts$/u.test(file) || file.endsWith('.test.ts')) continue;
    const text = readFileSync(file, 'utf8');
    const pattern = /claim\((?:uow|tx), '([a-zA-Z_.]+)'/gu;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const before = text.slice(0, match.index);
      const methods = [
        ...before.matchAll(
          /\n {2}(?:async |private async |protected async )?([a-zA-Z]+)\s*(?:<[^>]*>)?\(/gu,
        ),
      ];
      const method = methods.length > 0 ? methods[methods.length - 1][1] : undefined;
      const module = relative(modules, file).split('/')[0];
      if (!found.has(match[1]))
        found.set(match[1], { operation: match[1], module, file: relative(root, file), method });
    }
  }
  return [...found.values()].sort((a, b) => a.operation.localeCompare(b.operation));
}

/** The concurrency suites `pnpm run test:concurrency` actually runs. */
export function gateConcSuites(root) {
  const api = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));
  const script = api.scripts?.['test:concurrency'] ?? '';
  const apiSuites = script
    .split(/\s+/u)
    .filter((part) => part.endsWith('.test.ts'))
    .map((part) => `apps/api/${part}`);
  const db = JSON.parse(readFileSync(resolve(root, 'packages/db/package.json'), 'utf8'));
  const dbScript = db.scripts?.['test:concurrency'] ?? '';
  const dbSuites = dbScript.includes('src/concurrency')
    ? walk(resolve(root, 'packages/db/src/concurrency'))
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => relative(root, f))
    : [];
  return new Set([...apiSuites, ...dbSuites]);
}

export function runConcurrencyCoverage({ root, manifest }) {
  const problems = [];
  const operations = discoverOperations(root);
  const entries = new Map(manifest.map((entry) => [entry.operation, entry]));
  const suites = gateConcSuites(root);

  for (const op of operations) {
    const entry = entries.get(op.operation);
    if (entry === undefined) {
      problems.push(
        `${op.operation} (${op.file}) claims an idempotency key but has no manifest entry`,
      );
      continue;
    }
    if (entry.method !== op.method) {
      problems.push(
        `${op.operation}: the manifest names method ${String(entry.method)}, the source claims it in ${String(op.method)}`,
      );
    }
    if (entry.raced) {
      if (!Array.isArray(entry.suites) || entry.suites.length === 0) {
        problems.push(`${op.operation}: marked raced but names no suite`);
        continue;
      }
      for (const suite of entry.suites) {
        const path = resolve(root, suite);
        if (!existsSync(path)) {
          problems.push(`${op.operation}: suite ${suite} does not exist`);
          continue;
        }
        if (!suites.has(suite))
          problems.push(
            `${op.operation}: suite ${suite} is not part of GATE-CONC (test:concurrency)`,
          );
        const text = readFileSync(path, 'utf8');
        if (op.method !== undefined && !new RegExp(`\\.${op.method}\\(`, 'u').test(text)) {
          problems.push(`${op.operation}: suite ${suite} never calls .${op.method}(`);
        }
      }
    } else if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
      problems.push(`${op.operation}: not raced and no reason recorded`);
    }
  }
  for (const entry of manifest) {
    if (!operations.some((op) => op.operation === entry.operation)) {
      problems.push(`${entry.operation}: in the manifest but no service claims it`);
    }
  }
  const seen = new Set();
  for (const entry of manifest) {
    if (seen.has(entry.operation)) problems.push(`${entry.operation}: listed twice`);
    seen.add(entry.operation);
  }

  // Every module that owns a command has a suite in the gate.
  const modulesWithCommands = new Set(operations.map((op) => op.module));
  for (const module of modulesWithCommands) {
    if (![...suites].some((suite) => suite.includes(`/modules/${module}/`))) {
      problems.push(`module ${module} owns commands but has no suite in GATE-CONC`);
    }
  }

  // The kernel proofs every command inherits.
  const kernelPath = resolve(root, KERNEL_SUITE);
  if (!existsSync(kernelPath)) problems.push(`${KERNEL_SUITE} is missing`);
  else {
    const kernel = readFileSync(kernelPath, 'utf8');
    for (const title of KERNEL_IDEMPOTENCY_TITLES) {
      if (!kernel.includes(title)) problems.push(`${KERNEL_SUITE} no longer proves "${title}"`);
    }
  }

  const raced = manifest.filter((e) => e.raced).length;
  return {
    problems,
    operations: operations.length,
    raced,
    duplicateSubmitOnly: manifest.length - raced,
    suites: suites.size,
  };
}
