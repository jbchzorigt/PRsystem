# PRsystem — Dependency Security Risk Register

**Version:** 1.0 (Phase 02 — dev-only dependency risk constrained)

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
The open entry below is the reason, and it is reported, not hidden.

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

## Closed entries

None.
