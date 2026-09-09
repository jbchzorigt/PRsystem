import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Phase 21 architecture gate (build-plan §Phase 21; CLAUDE.md §3).
 *
 * Web code — the five portals and the kit they share — imports only
 * `@prsystem/contracts`, `@prsystem/web-kit`, Next, React and its own files.
 * Never the database, the authorization matrix, the ports, the configuration
 * loader, or any module's services or repositories, by package name or by a
 * relative path that leaves the workspace.
 *
 * Two proofs, so neither can drift alone: every import in every web source
 * file is scanned here, and the ESLint rule that guards the same boundary is
 * shown to fire on a file that crosses it.
 */

const repoRoot = resolve(__dirname, '../../..');

const WEB_WORKSPACES = [
  'apps/web-public',
  'apps/web-hotel',
  'apps/web-restaurant',
  'apps/web-police',
  'apps/web-operation',
  'packages/web-kit',
];

const ALLOWED_PACKAGES = [
  /^@prsystem\/contracts$/u,
  /^@prsystem\/web-kit(\/.*)?$/u,
  /^next(\/.*)?$/u,
  /^react(\/.*)?$/u,
  /^react-dom(\/.*)?$/u,
];

/** `node:` built-ins are the kit's server side only — a cookie, a UUID — never a page. */
const NODE_BUILTIN_ALLOWED = /^packages\/web-kit\/src\/server\//u;

/** The kit's own unit tests import the test runner; nothing else does. */
const TEST_FILE = /\.test\.tsx?$/u;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry.startsWith('.'))
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/u.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const match of text.matchAll(
    /(?:^|\n)\s*(?:import|export)\s[^'";]*?from\s+['"]([^'"]+)['"]/gu,
  )) {
    specifiers.push(match[1]!);
  }
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/gu))
    specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/gu))
    specifiers.push(match[1]!);
  return specifiers;
}

function lintStdin(
  fileName: string,
  source: string,
): Array<{ ruleId: string | null; message: string }> {
  const args = [
    resolve(repoRoot, 'node_modules/eslint/bin/eslint.js'),
    '--no-ignore',
    '--stdin',
    '--stdin-filename',
    fileName,
    '--format',
    'json',
  ];
  try {
    const stdout = execFileSync('node', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      input: source,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout)[0]?.messages ?? [];
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? '';
    if (!stdout) throw error;
    return JSON.parse(stdout)[0]?.messages ?? [];
  }
}

describe('web boundary', () => {
  it('every web source file imports only contracts, the kit, Next, React and itself', () => {
    const offences: string[] = [];
    let scanned = 0;
    for (const workspace of WEB_WORKSPACES) {
      const base = resolve(repoRoot, workspace);
      for (const file of sourceFiles(base)) {
        scanned += 1;
        const rel = relative(repoRoot, file);
        for (const specifier of importsOf(file)) {
          if (specifier.startsWith('.')) {
            const target = resolve(dirname(file), specifier);
            if (relative(base, target).startsWith('..'))
              offences.push(`${rel} → ${specifier} leaves ${workspace}`);
            continue;
          }
          if (specifier.startsWith('node:')) {
            if (!NODE_BUILTIN_ALLOWED.test(rel))
              offences.push(`${rel} → ${specifier} (built-ins are the kit's server side only)`);
            continue;
          }
          if (specifier === 'vitest' && TEST_FILE.test(rel)) continue;
          if (!ALLOWED_PACKAGES.some((allowed) => allowed.test(specifier)))
            offences.push(`${rel} → ${specifier}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(40);
    expect(offences).toEqual([]);
  });

  it('the kit itself imports no other workspace package than contracts', () => {
    const kit = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages/web-kit/package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(kit.dependencies ?? {})).toEqual(['@prsystem/contracts']);
  });

  it.each([
    [
      'apps/web-hotel/lib/boundary-probe.ts',
      "import { migrate } from '@prsystem/db';\nexport const probe = migrate;\n",
    ],
    [
      'apps/web-public/app/boundary-probe.ts',
      "import { authorize } from '@prsystem/authz';\nexport const probe = authorize;\n",
    ],
    [
      'packages/web-kit/src/boundary-probe.ts',
      "import { selectAdapters } from '@prsystem/ports';\nexport const probe = selectAdapters;\n",
    ],
    [
      'apps/web-police/lib/boundary-probe.ts',
      "import { MatchService } from '../../api/src/modules/police/services/match.service';\nexport const probe = MatchService;\n",
    ],
  ])('the lint rule fires for %s', (fileName, source) => {
    const restricted = lintStdin(fileName, source).filter(
      (m) => m.ruleId === 'no-restricted-imports',
    );
    expect(restricted.length).toBeGreaterThan(0);
    expect(restricted[0]!.message).toContain('Web code imports only');
  });

  it('the lint rule stays quiet for the contracts and the kit', () => {
    const messages = lintStdin(
      'apps/web-hotel/lib/boundary-probe.ts',
      "import { API_PREFIX } from '@prsystem/contracts';\nimport { formatMnt } from '@prsystem/web-kit';\nexport const probe = [API_PREFIX, formatMnt];\n",
    );
    expect(messages.filter((m) => m.ruleId === 'no-restricted-imports')).toEqual([]);
  });
});
