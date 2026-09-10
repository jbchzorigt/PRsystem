# PRsystem — Dependency Security Risk Register

**Version:** 1.2 (Phase 22 — the mandatory reviews of `DSR-01` and `DSR-02`; both still `OPEN — contained`)

Advisories that cannot be closed by upgrading to a compatible stable version are recorded here with
their containment, their evidence, and the phase that must revisit them. An entry in this register is
**not** a waiver: it is a constraint that a gate enforces.

Nothing in this file suppresses an audit. No advisory is ignored, allow-listed or silenced, and no
dependency is pinned to a pre-release to make a scanner quiet.

## Standing audit policy

| Audit | Command | Threshold | CI behaviour |
| --- | --- | --- | --- |
| Production dependency tree | `pnpm run audit:prod` | moderate and above | **Blocking** — a failure fails CI |
| Full dependency tree | `pnpm run audit:tree` | high and above | Enabled and **blocking**; `continue-on-error` was removed |

The production audit is the release-relevant one: it covers exactly what a production install ships.
The full-tree audit additionally covers build and test tooling that no runtime ever loads.

**This register does not claim the development dependency tree is free of advisories.** It is not.
The two open entries below are the reason, and they are reported, not hidden.

---

## DSR-01 — GHSA-67mh-4wv8-2f99 (esbuild development server)

| Field | Value |
| --- | --- |
| Advisory | `GHSA-67mh-4wv8-2f99` |
| Severity | **Moderate** |
| Summary | esbuild's development server responds to any website's cross-origin request, allowing a malicious page to read the served source while that server is running |
| Vulnerable versions | `esbuild <= 0.24.2` |
| Patched versions | `esbuild >= 0.25.0` |
| Status | **OPEN — contained** |
| Opened | Phase 02 |
| Review owner | Implementation owner for `packages/db` |
| Mandatory review | **Phase 20** (external adapters) and **Phase 22** (security, concurrency, recovery) |

### Affected transitive path

```
packages/db  (devDependencies)
└── drizzle-kit@0.31.10
    └── @esbuild-kit/esm-loader@2.6.5
        └── @esbuild-kit/core-utils@3.3.2
            └── esbuild@0.18.20        <-- vulnerable
```

`drizzle-kit`'s own direct `esbuild` is `0.25.12`, which is patched. Only the deprecated
`@esbuild-kit/*` chain still pins `0.18.20`. Every other `esbuild` in the workspace — via `tsx`,
`vite` and `vitest` — resolves to `0.28.2`.

### Scope

Development-only. `drizzle-kit` is the Drizzle **migration-generation CLI**. It generates versioned
SQL files that a human reviews and commits (ADR-0004). It is never imported by application code, never
executed by the API or worker, and never installed by a production install.

The runtime migration path does not involve it at all: `packages/db/src/migrate.ts` applies the journal
using `drizzle-orm`, which is a separate, unaffected package.

### Exploit condition

The advisory requires **the esbuild development server to be running** (`esbuild --serve` /
`--servedir`) and a developer to visit a malicious page in the same browser session. This repository
starts no esbuild development server anywhere — not in a package script, not in a workflow, not in a
tool. Absent serve mode the vulnerable code path is never reached.

### Mitigation

| # | Control | Enforced by |
| --- | --- | --- |
| 1 | `drizzle-kit` is a `devDependency` of `packages/db` and of nothing else; it appears in no `dependencies`, `optionalDependencies` or `peerDependencies` | `validate-workspace` check 12 |
| 2 | No application or package source imports `drizzle-kit`; `drizzle.config.ts` sits outside every `tsconfig` include and outside `dist`, so it reaches no build output | `validate-workspace` check 13 |
| 3 | No script or workflow invokes esbuild serve mode | `validate-workspace` check 14 |
| 4 | CI blocks moderate-and-above **production** advisories and keeps the full-tree high audit enabled | `validate-workspace` check 15, `.github/workflows/ci.yml` |
| 5 | Production install ships neither `drizzle-kit` nor the vulnerable `esbuild` | `pnpm run audit:prod` |

No override, ignore rule or version force was used. `pnpm.overrides` carries one unrelated entry
(`postcss@8.5.26`), which closes real advisories by upgrading rather than by silencing.

### Production audit evidence

```
$ pnpm why drizzle-kit --prod
(empty — absent from the production tree)

$ pnpm run audit:prod          # pnpm audit --prod --audit-level moderate
No known vulnerabilities found
exit 0

$ pnpm run audit:tree          # pnpm audit --audit-level high
1 vulnerabilities found
Severity: 1 moderate
exit 0                         # below the high threshold; the moderate is DSR-01
```

Recorded at Phase 02 close. The commands are re-run by every phase gate set and by CI.

### Phase 20 review (mandatory — external adapters wired)

Re-reviewed on 2026-09-09 at the Phase 20 implementation tree, as this entry requires of the phase
that wires the external adapters. **Status unchanged: `OPEN — contained`.**

- **Phase 20 added no third-party dependency.** The one production adapter it wrote — S3-compatible
  object storage — is built on `node:crypto` and the runtime's global `fetch`; the outbound HTTP
  client, the CIDR allowlist, the `Secret` wrapper and the signature primitives have no dependency
  either. The only manifest changes are workspace links (`@prsystem/config` now depends on
  `@prsystem/ports`, and `@prsystem/ports` gained a `test:integration` script), and the lockfile
  moved by three lines for them.
- **The affected path is byte-for-byte the one recorded above.** `pnpm --filter @prsystem/db why
  esbuild` still shows `drizzle-kit@0.31.10 → @esbuild-kit/esm-loader@2.6.5 →
  @esbuild-kit/core-utils@3.3.2 → esbuild@0.18.20`, and every other path — `drizzle-kit`'s own
  `esbuild@0.25.12`, and `tsx`, `vite` and `vitest` at `esbuild@0.28.2` — is patched.
- **The production tree is clean and the containment holds.** `pnpm run audit:prod` answers `No
  known vulnerabilities found`, exit 0; `pnpm run audit:tree` answers three moderate and nothing at
  high — this entry and `DSR-02` — exit 0; `validate-workspace` checks 12–15 pass.
- **Nothing the adapters do reaches the vulnerable code.** The adapters run in the API and the
  worker, neither of which installs or imports `drizzle-kit`, and no development server was added.

Next mandatory review: **Phase 22**, unchanged.

### Phase 22 review (mandatory — security, concurrency, recovery)

Reviewed 2026-09-10 on the Phase 22 tree. The transitive path is unchanged — `drizzle-kit@0.31.10 →
@esbuild-kit/esm-loader@2.6.5 → @esbuild-kit/core-utils@3.3.2 → esbuild@0.18.20` — and every other
`esbuild` in the workspace still resolves to a patched version. No dependency was added to
`packages/db`; Phase 22's migration `0021` was written by hand like every other and applied by the
runtime journal, never by `drizzle-kit`. `validate-workspace` checks 12–15 hold (15 of 15 in the
battery), no script or workflow starts an esbuild server, and the production audit is clean.
**Status unchanged: OPEN — contained.** Next mandatory review: Phase 23.

### Removal condition

Close this entry when a **compatible stable** Drizzle Kit release drops the deprecated
`@esbuild-kit/*` chain, or otherwise resolves `esbuild >= 0.25.0` on every path. Upgrade then, confirm
`pnpm why esbuild` shows no version at or below `0.24.2`, and mark DSR-01 `CLOSED` with the version
that closed it.

Explicitly **not** acceptable as a closure:

- adopting an unstable or pre-release Drizzle Kit purely to change an audit result;
- adding an audit ignore, allow-list or suppression;
- forcing an `esbuild` override that `drizzle-kit` does not support;
- removing the migration infrastructure.

---

## DSR-02 — GHSA-82fw-gwwq-j7x9 (Vitest mocker redirect)

| Field | Value |
| --- | --- |
| Advisory | `GHSA-82fw-gwwq-j7x9` |
| Severity | **Moderate** |
| Summary | `@vitest/mocker`'s redirect-mock path is not confined to the project root, so a test runner serving a mocked module can be made to read a file outside it |
| Vulnerable versions | `vitest >= 2.1.0 < 4.1.11`, `@vitest/mocker >= 2.1.0 < 4.1.11` |
| Patched versions | `>= 4.1.11` |
| Status | **OPEN — contained** |
| Opened | Phase 18 (published after the Phase 17 battery of 2026-09-06, which reported one moderate) |
| Review owner | Implementation owner for the workspace test tooling |
| Mandatory review | **Phase 22** (security, concurrency, recovery) |

### Affected paths

`vitest@3.2.7` is a `devDependency` of the workspace root and of every package and application that
has tests — thirteen paths — and `@vitest/mocker@3.2.7` is its own dependency. No `dependencies`,
`optionalDependencies` or `peerDependencies` entry names either.

### Scope

Development and CI only. Vitest is the test runner; it is never imported by application code, never
executed by the API or the worker, and never installed by a production install — `pnpm run
audit:prod` reports no known vulnerabilities on the tree a production install ships.

### Exploit condition

The advisory requires a **redirect mock** — `vi.mock(path, { redirect })` or the equivalent — to be
declared, and an attacker to control the redirect target. This workspace declares no module mock at
all: `vi.mock` appears in no suite, and every test runs against real PostgreSQL, real HTTP and the
deterministic port simulators rather than against mocked modules. Absent a redirect mock the
vulnerable path is never reached.

### Why it is not simply upgraded

The patched line is `vitest >= 4.1.11`, two major versions above the pinned `3.2.7`. That is not a
compatible stable upgrade: Vitest 4 changes the configuration surface, the reporter contract and the
workspace layout this repository's thirteen test projects and their governed reporters depend on, and
CLAUDE.md §1 pins compatible stable versions rather than tracking a major to satisfy a scanner. The
upgrade is a change of its own, with its own gates, and Phase 22 is where it is due.

### Mitigation

| # | Control | Enforced by |
| --- | --- | --- |
| 1 | `vitest` and `@vitest/mocker` appear only in `devDependencies`, in every package that has them | `validate-workspace` check 12 |
| 2 | No suite declares a module mock, so the redirect path has no caller | `grep -r "vi.mock"` over `apps/` and `packages/` returns nothing |
| 3 | CI blocks moderate-and-above **production** advisories and keeps the full-tree high audit enabled | `.github/workflows/ci.yml` |
| 4 | A production install ships neither package | `pnpm run audit:prod` |

No override, ignore rule or version force was used, and the advisory is not suppressed.

### Phase 22 review (mandatory — security, concurrency, recovery)

Reviewed 2026-09-10 on the Phase 22 tree. `pnpm why vitest` and `pnpm why @vitest/mocker` resolve to
the same versions as at the entry's opening; `grep -r "vi.mock"` over `apps/` and `packages/` still
returns nothing, and the two suites Phase 22 added (`degraded-modes.http`, `concurrency-coverage`)
mock nothing either. The Phase 22 battery's `pnpm run audit:tree` reports the same three moderate
advisories and `pnpm run audit:prod` is clean. Vitest 4 remains a deliberate upgrade with its own
gate run; this phase did not make it. **Status unchanged: OPEN — contained.** Next mandatory review:
Phase 23, as a release-readiness item.

### Removal condition

Close this entry when the workspace moves to `vitest >= 4.1.11` as a deliberate upgrade with its own
gate run, or when a patched `3.x` is published. Confirm `pnpm why vitest` shows no version in the
vulnerable range, and mark DSR-02 `CLOSED` with the version that closed it.

Explicitly **not** acceptable as a closure: an audit ignore or allow-list, a pre-release pin, or
removing the test suites that report it.

---

## Closed entries

None.
