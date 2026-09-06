# PRsystem — Database Bootstrap and Forward-Fix Runbook

**Version:** 1.2 (Phase 03 repair — D-09 scheduler, partial/IaC logins, exact ACL grantees)

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
| `prsystem_job_scheduler` | scheduler group (D-09) | NOLOGIN, none | nothing; **no table privilege on `job_run` at all** | `prsystem_job_scheduler_login` |
| `prsystem_migrate` | DDL group | NOLOGIN, none | schemas, platform tables | `prsystem_migrate_login` |
| `prsystem_audit_writer` | function owner | NOLOGIN, none | the two audit append functions | `prsystem_migrate` only |
| `prsystem_partition_mgr` | function owner | NOLOGIN, none | the two audit streams, their partitions, the partition functions | `prsystem_migrate` only |
| `prsystem_maintenance_fn` | function owner | NOLOGIN, none | cross-tenant maintenance functions | `prsystem_migrate` only |
| `prsystem_maintenance` | **break-glass** | NOLOGIN, **BYPASSRLS** | **nothing** | **nobody, including the migration principal** |

Eleven group roles in total, and seven canonical login principals.

Every LOGIN principal is `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
NOBYPASSRLS` and is a member of **exactly one** group, with exactly the options
`ADMIN FALSE, INHERIT TRUE, SET TRUE`.

PostgreSQL 17 models MEMBER, USAGE (inheritance), SET and ADMIN as independent
capabilities, and **keeps the options a later `GRANT` does not mention**. A bare
`GRANT g TO m` therefore cannot clear an ADMIN OPTION an earlier grant set, so
bootstrap states all three explicitly and then re-reads `pg_auth_members` to
prove the result rather than assuming it. `ADMIN TRUE, INHERIT FALSE, SET FALSE`
is the case that matters most: it confers no privilege and permits no `SET ROLE`,
yet lets its holder grant the role to anybody, itself included.

### Scheduler versus Worker (D-09)

Issuing a privileged maintenance job and executing one are separate powers with
separate credentials, separate sessions and separate deployment responsibilities.

| | Scheduler | Worker |
| --- | --- | --- |
| Creates a privileged maintenance job | **yes**, through `platform.schedule_maintenance_job` only | no — holds no `INSERT` on `job_run` at all |
| Executes a privileged maintenance job | no — cannot execute `platform.maintenance_expire_idempotency_keys` | **yes**, and only a job whose executor identity equals its own `session_user` |
| Direct table privilege on `platform.job_run` | **none** | `SELECT` only — no `UPDATE` of any kind |
| Creates ordinary, non-privileged jobs | no | **yes**, through `platform.begin_worker_job`, which rejects the `platform.maintenance.%` namespace categorically |

The scheduling function is `SECURITY DEFINER` with a fixed `search_path`, owned
by `prsystem_maintenance_fn`, `REVOKE ALL ... FROM PUBLIC`, and executable only
by `prsystem_job_scheduler`. It writes the job type, hotel scope, issuer,
executor identity, initial state and start time server-side, records an
immutable scheduling audit event in the same transaction, and issues only
allow-listed job types — one, in Phase 03. A privileged job row with no issuer
cannot exist: the `job_run_privileged_has_issuer` check constraint refuses it,
and the execution function refuses it again behind that.

### Where the scheduler credential lives

Exactly two long-lived deployments remain: the API and the worker.

| | API deployment | Worker deployment |
| --- | --- | --- |
| `DATABASE_URL` | `prsystem_api_login` | `prsystem_worker_login` |
| `SCHEDULER_ENABLED` | `true` for a deployment with the capability | **never set** |
| `SCHEDULER_DATABASE_URL` | `prsystem_job_scheduler_login` | **never set** |

The worker does not merely ignore those two variables — its configuration does
not declare them, and it **refuses to start** if either is present. Ignoring
them would be worse: an operator who copied the API's environment into the
worker has broken the D-09 separation, and a worker that starts anyway leaves
them believing it still holds.

Issuance is an API control-plane capability: its own connection string, its own
pool, and its own startup principal guard.

The pool is **registered in the Nest application container** and lives for the
life of the process; Nest closes it through `OnApplicationShutdown`. The startup
guard validates *that* pool, after the container exists and before the port is
bound — not a throwaway opened and closed during startup, which would verify a
credential and then leave nothing holding it.

The capability and its credential are one decision. `SCHEDULER_ENABLED=true`
**requires** `SCHEDULER_DATABASE_URL` in every environment, not only production;
`SCHEDULER_ENABLED=false` **forbids** it, because a scheduler credential in a
deployment that will never use it is a live credential nobody is accounting for.
Both combinations fail environment validation before anything is constructed.
Unset defaults to enabled for `APP_ENV=production` — the production API is the
deployment that has the capability, so a missing credential there is a
misconfiguration rather than a quiet opt-out — and disabled everywhere else. That
default lives only in the API-specific configuration path, so no other
deployment can inherit it.

When the capability is disabled there is **no scheduler pool and no scheduler
service**: the module registers neither, so there is nothing to resolve and
nothing holding a privileged connection. OpenAPI generation constructs the
application with the capability explicitly disabled for the same reason.
Phase 03 exposes **no route** for it — a public endpoint would need the Phase 04
authorization pipeline in front of it, and shipping the credential without those
checks would be worse than not shipping the capability.

What this does and does not buy, stated plainly: a compromised **worker**
credential can execute a job somebody else issued and cannot issue one — it
holds no `INSERT` on `job_run`, cannot execute the scheduling function, and its
own job path refuses the `platform.maintenance.%` namespace. A compromised
**API** credential *can* issue jobs. That is the power the control plane has,
and the separation is between issuance and execution, not a claim that both are
unreachable.

### Validated at call time, not at bootstrap

Bootstrap normalises memberships, and nothing stops an operator granting a second
group afterwards. `platform.assert_exact_role_closure` therefore re-validates a
principal whenever a privileged function is *called*: LOGIN, no privileged
attribute, exactly one direct membership in the expected group with exactly
`ADMIN FALSE, INHERIT TRUE, SET TRUE`, nothing else reachable — a second project
group or a predefined role alike — and no ADMIN OPTION.

The check covers the **group** as well as the login. PostgreSQL does not inherit
role attributes, so altering `prsystem_worker` or `prsystem_job_scheduler` itself
changes what every member can do while leaving each member's own catalogue row
untouched; the expected group must therefore be NOLOGIN, NOSUPERUSER, NOCREATEDB,
NOCREATEROLE, NOREPLICATION and NOBYPASSRLS, and no role reachable from the
principal may hold a privileged attribute.

The scheduler validates itself and its named executor; the maintenance function
validates the executing principal. A login that has become both Scheduler and
Worker can do neither.

### One login per runtime group

Phase 03 supports **exactly one login per runtime group** — for the Worker,
`prsystem_worker_login`. Horizontal worker processes **share that one
credential**; they do not each get their own. Multiple deployment-managed Worker
logins are **not** supported, and the platform no longer implies otherwise:
nothing bootstraps, rotates, audits or validates a second one.

This is enforced in both directions, so bootstrap cannot provision what
execution refuses:

- `platform.assert_exact_role_closure` requires the calling principal to be the
  canonical login for the expected group. `platform.schedule_maintenance_job`
  therefore issues only to `prsystem_worker_login`, and
  `platform.begin_worker_job` and the maintenance functions accept only it.
- Bootstrap **fails closed** when any non-canonical login is a member of a group
  role, naming the login. A group with no canonical login — the owner roles and
  the break-glass role — may have no login member at all.

Tests that need a job belonging to a different identity write a controlled
`job_run` row directly. That exercises "assigned to somebody else" without
implying a second Worker login is a supported arrangement.

### Invocation-time guards, per entry point

Every `SECURITY DEFINER` function a Worker or Scheduler credential can execute,
and what it checks when it is called. Three of the seven deliberately do not run
the role-closure check; saying which, and what they check instead, is the point
of the table. `sec-scheduler.test.ts` holds the live grants and the live function
bodies to it, so a definer added later — or a grant widened later — fails the
gate rather than arriving unguarded.

| Function | Held by | Invocation-time guard |
| --- | --- | --- |
| `platform.schedule_maintenance_job` | Scheduler | role closure for `prsystem_job_scheduler`, a closure check on the **named executor**, and `p_hotel_id = current_hotel_id()` |
| `platform.begin_worker_job` | Worker | role closure for `prsystem_worker`; refuses the `platform.maintenance.%` namespace |
| `platform.finish_worker_job` | Worker | role closure for `prsystem_worker`, then `job_identity = session_user`, the privileged namespace refused, and the job still running |
| `platform.maintenance_expire_idempotency_keys` | Worker | role closure for `prsystem_worker`, then the exact job name, the assigned identity, the established tenant, and a running job locked `FOR UPDATE` |
| `audit.append_platform_audit_event` | Worker, API, Police | **no role closure, by design.** The shared audit wrapper takes no identity or tenant argument and derives realm, actor and hotel from the transaction context server-side. It can only append |
| `platform.ensure_month_partitions` | Worker | **no role closure.** An allow-list of exactly the two audit streams, so it cannot become a general `CREATE TABLE` primitive, plus a bounded month count and a per-stream advisory lock |
| `platform.check_partition_horizon` | Worker | **no role closure.** Reads the horizon of the two audit streams and raises an operational alert; writes nothing else and takes only a bounded threshold |
| `platform.lapsed_booking_holds` | Worker | **no role closure.** Reads only bookings whose ten-minute hold has already lapsed and answers two identifiers per row. It writes nothing; the settling it feeds happens in the hotel's own scope, on the booking's own lock (`BK-DEC-009`) |

`finish_worker_job` was the gap this table exists to close: it checked the realm
and `job_identity = session_user` and validated no closure at all. Identity is
not authorisation — a non-canonical login that had created a row naming itself,
and a canonical login that had acquired extra reach since its job began, both
satisfied that comparison.

### How a job finishes

The Worker holds `SELECT` on `platform.job_run` and nothing else. Ordinary jobs
transition through `platform.finish_worker_job`, which requires
`job_identity = session_user`, refuses the `platform.maintenance.%` namespace,
and refuses a job that is not running. A privileged maintenance job becomes
`succeeded` only inside its own audited maintenance function, after the business
effect and the audit record have both succeeded in that transaction.

### Identity versus claim

`issuer_ref` and `job_identity` are taken from `session_user` — the principal
PostgreSQL authenticated — never from `app.actor_ref`. A custom GUC is writable
by the connection that holds it, so a value read from one records whatever the
caller last claimed. `app.actor_ref` remains useful as correlation metadata and
is audited as exactly that.

### Login policy: all, some, or none

Supplying credentials is optional and partial supply is a supported mode.

| Situation | Behaviour |
| --- | --- |
| No credentials, no login roles present | Group-role bootstrap succeeds. Nothing is created. |
| Some credentials supplied | Only those principals are created or re-passworded, and normalised to exact attributes and exact membership options. |
| A canonical principal omitted and absent | Not an error, and not created. `GRANT ... TO` is never issued against a role that does not exist. |
| A canonical principal omitted but existing (IaC-managed) | Never re-passworded. Validated: safe attributes, and exactly one membership in its own group with `ADMIN FALSE, INHERIT TRUE, SET TRUE`. |
| An omitted existing principal with unsafe drift | The bootstrap **fails closed** naming the principal and the drift. |

Group-to-group ownership edges are reconciled on every run, whatever the login
policy. The deterministic policy for unexpected membership involving a project
owner or runtime role is **revoke**: reconciliation removes it, then re-reads
`pg_auth_members` and fails if anything unapproved survived.

### Exact database and schema ACLs

The claim of exact final grants covers **every grantee**, not only `PUBLIC` and
the roles this runbook names. Bootstrap enumerates the actual grantees of the
target database and of schema `public`, revokes any outside the allow-list, and
then asserts the surviving set exactly. The allow-list is: the database owner,
the owner of schema `public` (`pg_database_owner` on PostgreSQL 15+), the DDL
owner `prsystem_migrate`, and the runtime, reader and scheduler roles. Those two
owner entries are the documented operator exceptions — revoking from them would
leave a database or schema nobody can administer.

`prsystem_maintenance` is the only role holding `BYPASSRLS`. It is **break-glass
only** and owns nothing: the cross-tenant maintenance *functions* are owned by
`prsystem_maintenance_fn`, a separate role that holds no `BYPASSRLS` and
establishes tenant scope one tenant at a time. The two are easy to confuse
because their names differ by three characters; nothing in normal operation uses
the break-glass role. It owns no object,
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
PRSYSTEM_LOGIN_JOB_SCHEDULER_PASSWORD='…' \
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

- exact safe attributes on all eleven group roles;
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
PRSYSTEM_APPROVED_OPERATOR_OWNERS='<operator-identity>[,<operator-identity>…]' \
pnpm run migrate
```

`MIGRATION_DATABASE_URL` is **required** and there is deliberately no fallback to
`DATABASE_URL`: that variable holds a runtime principal, and a migration must not
run as one. A missing or malformed value fails before any connection is opened,
and the value is never printed.

`PRSYSTEM_APPROVED_OPERATOR_OWNERS` is **also required**, and has no default. It
names the operator identities allowed to own the database and schema `public`.
There is no honest default to infer: the migration principal never owns the
database, so any value the runner could invent would either refuse every real
deployment or approve every owner. It was previously optional, which made the
check strictest exactly where somebody had configured it and silent everywhere
else. Missing or empty now stops the run **before a connection is opened**.

### The ownership manifest

Ownership is validated against an exact manifest — one expected owner per object
— before any new DDL and again afterwards. Being *one of* the kernel owner roles
was never sufficient: `prsystem_maintenance_fn` owning `platform.job_run` would
have passed that test, and would have handed the owner of the maintenance
functions the ability to rewrite the very ledger constraining them.

| Object | Expected owner |
| --- | --- |
| the database and schema `public` | an approved operator identity (or `pg_database_owner` for `public`) |
| schemas `platform`, `audit`, `police_audit`, `police`, `drizzle` | `prsystem_migrate` |
| ordinary kernel tables, views, sequences, `drizzle.__drizzle_migrations` | `prsystem_migrate` |
| `audit.platform_event`, `police_audit.security_event` and their partitions | `prsystem_partition_mgr` |
| the partition functions | `prsystem_partition_mgr` |
| the two audit append functions | `prsystem_audit_writer` |
| the scheduler and maintenance wrappers, including every `SECURITY DEFINER` one | `prsystem_maintenance_fn` |
| every other kernel function | `prsystem_migrate` |
| runtime, reader, scheduler, break-glass and every canonical login role | **nothing, anywhere in the database** |

Partitions are matched through `pg_inherits` rather than by name, and extension
members are excluded through `pg_depend` — both catalogue facts rather than name
patterns that stop being true when something is renamed.

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

### GATE-SEC sub-gate catalogue

`GATE-SEC` (`pnpm run test:security`) aggregates **nineteen** sub-gates:

`SEC-ROLE`, `SEC-RLS`, `SEC-ACL-MATRIX`, `SEC-OWNERSHIP`, `SEC-LOCK-EVIDENCE`,
`SEC-POOL-ERRORS`, `SEC-BOOTSTRAP`, `SEC-SCHEDULER`, `SEC-MAINTENANCE`,
`SEC-STARTUP`, `SEC-STARTUP-WORKER`, `SEC-REGRESSION`, `SEC-AUDIT`,
`SEC-PARTITION`, `SEC-POLICE-ISOLATION`, `SEC-KMS`, `SEC-PII-LEAK`,
`SEC-ONBOARDING-ISOLATION`, `SEC-SECRETS`.

`SEC-ONBOARDING-ISOLATION` is Phase 05's: an onboarding application exists before
any tenant does, so it is isolated by a reference rather than by `hotel_id`, and
that reference — plus the rule that no plaintext registration number, one-time
code or activation token reaches a row, an audit record or an outbox payload —
is what this sub-gate holds.

This list is the one in `tools/gate-sec-config.mjs`; `validate-governance`
compares the two and fails if they drift, because a catalogue that lists eight of
nineteen reads as a complete gate and is not one.

It fails closed on an unavailable database, a skipped suite, a sub-gate that ran
zero tests, or a missing artefact.

It runs as its **own GitHub Actions job** named exactly `GATE-SEC`, because only a
job name is selectable as a required check — a step inside another job is not.

**Selecting it as a required status check remains pending**: the job must run on
GitHub at least once before it can be chosen, and branch protection is a
repository setting deliberately **not** configured by this phase.

Phase 03 covers the kernel security subset. Phase 22 expands the same gate with
headers, CSP, the penetration/security-review pass and the release checks.
