# PRsystem — Database Bootstrap and Forward-Fix Runbook

**Version:** 1.1 (Phase 03 repair — coordination lock, exact grants, ten group roles)

Cluster bootstrap and application migration are **separate operations with
separate privileges**. This document is the operator's procedure for both, and
the forward-fix path when either goes wrong.

---

## 1. Why they are separate

Roles, role attributes and role memberships live in cluster-wide catalogs
(`pg_authid`, `pg_auth_members`), not in a database. Creating or altering them
from a per-database migration has two consequences, both of which this repair
removes:

1. **It races.** Two databases migrating at once contend for the same catalog
   tuple and fail with `tuple concurrently updated`.
2. **It over-privileges the migration.** A migration that can `CREATE ROLE` or
   grant `BYPASSRLS` is a migration that can escalate. The migration principal
   must be able to build a schema and nothing else.

`packages/db/migrations/0001_kernel.sql` therefore **verifies** the role model
and refuses to run when it is missing or unsafe. It never creates it.

---

## 2. Roles

| Role | Kind | Attributes | Owns | Reachable by |
| --- | --- | --- | --- | --- |
| `prsystem_api` | runtime group | NOLOGIN, none | nothing | `prsystem_api_login` |
| `prsystem_worker` | runtime group | NOLOGIN, none | nothing | `prsystem_worker_login` |
| `prsystem_police` | runtime group | NOLOGIN, none | nothing | `prsystem_police_login` |
| `prsystem_audit_reader` | reader group | NOLOGIN, none | nothing | `prsystem_audit_reader_login` |
| `prsystem_police_audit_reader` | reader group | NOLOGIN, none | nothing | `prsystem_police_audit_reader_login` |
| `prsystem_migrate` | DDL group | NOLOGIN, none | schemas, platform tables | `prsystem_migrate_login` |
| `prsystem_audit_writer` | function owner | NOLOGIN, none | the two audit append functions | `prsystem_migrate` only |
| `prsystem_partition_mgr` | function owner | NOLOGIN, none | the two audit streams, their partitions, the partition functions | `prsystem_migrate` only |
| `prsystem_maintenance_fn` | function owner | NOLOGIN, none | cross-tenant maintenance functions | `prsystem_migrate` only |
| `prsystem_maintenance` | **break-glass** | NOLOGIN, **BYPASSRLS** | **nothing** | **nobody, including the migration principal** |

Ten group roles in total.

Every LOGIN principal is `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
NOBYPASSRLS` and is a member of **exactly one** group.

`prsystem_maintenance` is the only role holding `BYPASSRLS`. It owns no object,
holds **no standing grant of any kind** — not even `USAGE` on a schema — no
application connects as it, and no role is a member of it. It exists as a
documented break-glass identity for a DBA acting under an incident, with that
action audited outside the application. Cross-tenant maintenance in normal
operation does **not** use it: `prsystem_maintenance_fn` holds no `BYPASSRLS` and
its functions establish tenant scope one tenant at a time, exactly as ADR-0017 §7
requires of any cross-tenant job.

---

## 3. Bootstrap procedure

Run **once per PostgreSQL cluster**, by a superuser or by an operator holding
`CREATEROLE` plus the ability to grant `BYPASSRLS`.

It holds a **session-level** advisory lock on one **coordination database**
(`postgres` by default) for the *whole* operation — group roles, login
principals, memberships, target-database grants, `public` grants and the final
invariant check. A transaction-scoped lock would end at `COMMIT`, before the
grants and login changes that follow it; and a lock taken in the *target*
database would not serialise runners that each target a different database,
which is exactly the racing case. The lock is released in `finally`.

```bash
BOOTSTRAP_DATABASE_URL='postgresql://<dba>@<host>:<port>/<db>' \
BOOTSTRAP_TARGET_DATABASE='prsystem' \
PRSYSTEM_LOGIN_API_PASSWORD='…' \
PRSYSTEM_LOGIN_WORKER_PASSWORD='…' \
PRSYSTEM_LOGIN_POLICE_PASSWORD='…' \
PRSYSTEM_LOGIN_AUDIT_READER_PASSWORD='…' \
PRSYSTEM_LOGIN_POLICE_AUDIT_READER_PASSWORD='…' \
PRSYSTEM_LOGIN_MIGRATE_PASSWORD='…' \
pnpm run db:bootstrap
```

- **No credential is committed anywhere.** Passwords come from the environment,
  are quoted server-side by `format(%L)`, and are never logged or echoed.
- A password variable that is unset means that principal is **not** created, so a
  production run can leave login management entirely to IaC and still use this
  step for the group roles.
- Re-running is safe: attributes are written only when the current state differs,
  and a concurrent creator is tolerated.

Grants are **exact, not additive**: stale privileges are revoked before the
approved ones are granted, so a role that once held `CREATE` does not keep it
because nobody remembered to take it away.

The bootstrap is idempotent and asserts, on every run:

- exact safe attributes on all ten group roles;
- every reachable role checked for `SUPERUSER`, `CREATEROLE`, `CREATEDB`,
  `REPLICATION` and `BYPASSRLS`;
- each runtime login holding exactly its approved membership closure;
- `prsystem_maintenance` having zero members;
- no runtime role is a member of a function-owner, the DDL group, or the
  break-glass role;
- `PUBLIC` holds nothing on `public` or on the target database;
- `CONNECT` is granted per role; `CREATE` on the database only to
  `prsystem_migrate`.

---

## 4. Migration procedure

```bash
MIGRATION_DATABASE_URL='postgresql://prsystem_migrate_login:…@<host>:<port>/prsystem' \
pnpm run migrate
```

`MIGRATION_DATABASE_URL` is **required** and there is deliberately no fallback to
`DATABASE_URL`: that variable holds a runtime principal, and a migration must not
run as one. A missing or malformed value fails before any connection is opened,
and the value is never printed.

Everything then happens on **one physical session**: verify the principal, take a
database advisory lock, `SET ROLE prsystem_migrate`, apply the journal, reset. The
lock makes two runners against an empty database safe — one applies, the other
observes the completed journal. The `SET ROLE` is what makes every object owned by
the group rather than by whichever login ran the deploy.

The runner verifies its own principal before touching the schema and refuses:

| Refusal | Reason |
| --- | --- |
| `is a superuser` | a migration must not be able to bypass RLS or alter roles |
| `holds CREATEROLE / CREATEDB / REPLICATION / BYPASSRLS` | over-privileged principal |
| `is not a member of prsystem_migrate` | wrong credential |
| `must not be able to reach prsystem_maintenance` | the DDL principal is not break-glass |

The API and worker apply the mirror-image check at startup and refuse to serve if
handed a migration, owner, maintenance or DBA credential.

Journal application is **atomic across the whole journal**: a failure anywhere
rolls back every file in the run, so a forward fix always starts from a known
state. This is asserted by `packages/db/src/migrate.test.ts`.

---

## 5. Forward fix

There are no down-migrations (ADR-0004). Recovery is always forward.

| Situation | Action |
| --- | --- |
| A migration failed | Nothing was applied. Fix the file and re-run. |
| A migration succeeded but is wrong | Write a **new** migration correcting it. Never edit an applied file. |
| A grant is wrong | New migration adjusting the grant; `validateClassification` proves the result. |
| A role attribute drifted | Re-run the bootstrap. It re-asserts exact attributes and removes escalation memberships. |
| A role is missing | Re-run the bootstrap, then re-run the migration; `0001` refuses until the role model is correct. |
| A partition is missing | `platform.ensure_month_partitions` through the worker; the horizon alert should have fired first. |

**Local scratch databases only.** Every test database this repository creates
carries the `prsystem_test_` prefix and is dropped by the harness that made it.
No procedure here removes an unrelated container, database or volume.

---

## 6. Required check

`GATE-SEC` (`pnpm run test:security`) aggregates `SEC-ROLE`, `SEC-RLS`,
`SEC-AUDIT`, `SEC-PARTITION`, `SEC-POLICE-ISOLATION`, `SEC-KMS`, `SEC-PII-LEAK`
and `SEC-SECRETS`. It fails closed on an unavailable database, a skipped suite, a
sub-gate that ran zero tests, or a missing artefact.

It runs as its **own GitHub Actions job** named exactly `GATE-SEC`, because only a
job name is selectable as a required check — a step inside another job is not.

**Selecting it as a required status check remains pending**: the job must run on
GitHub at least once before it can be chosen, and branch protection is a
repository setting deliberately **not** configured by this phase.

Phase 03 covers the kernel security subset. Phase 22 expands the same gate with
headers, CSP, the penetration/security-review pass and the release checks.
