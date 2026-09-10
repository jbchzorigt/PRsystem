# PRsystem — Release runbook and rollback plan

**Written:** Phase 23, for the release candidate audited in
[release-candidate-audit.md](release-candidate-audit.md). It describes how this candidate is put
into an environment and taken back out. It does **not** describe a production release that has been
approved — none has — and a step that depends on a blocked gate says so rather than pretending.
**Companions:** [database-bootstrap-runbook.md](database-bootstrap-runbook.md) (roles, the migration
principal, forward fix), [recovery-runbook.md](recovery-runbook.md) (backup, restore, the outbox
cut-off), [docs/architecture/02-container-and-deployment.md](../architecture/02-container-and-deployment.md)
(containers, environments), [docs/architecture/12-migration-strategy.md](../architecture/12-migration-strategy.md)
(expand/contract, no down-migrations), [docs/development.md](../development.md) (commands).

---

## 1. Topology

One `api` deployment (NestJS on Fastify), one `worker` deployment (BullMQ consumers: onboarding
provisioning, Police matcher, reporting exports, settlement jobs, partition maintenance), five
portal deployments (Next.js, server-rendered, each calling the API from its server side only), one
PostgreSQL 17 cluster, one Redis, optionally an S3-compatible object store. `api` and `worker` are
stateless; PostgreSQL is the single recovery unit. No Kubernetes, no distributed broker, no
microservices (CLAUDE.md §1).

## 2. Preconditions that this candidate cannot satisfy on its own

Check these first; the runbook stops at the first one that is not met.

| Precondition | Gate | What happens if it is not met |
| --- | --- | --- |
| An approved production key-management adapter, written and conformance-tested, named by `KMS_ADAPTER` | INT-KMS-01 | `api` and `worker` refuse to start: `no approved key management adapter is configured (INT-KMS-01 is not cleared)` |
| A contracted OTP provider and its adapter | INT-OTP-01 | no guest can register and no hotel can apply |
| A contracted email provider, its adapter and approved message copy | INT-MAIL-01 | no activation, invitation, reset or receipt email is sent |
| A production bucket and credential | INT-STORAGE-01 | exports fail closed |
| Each provider gate cleared in the register, in `gates.ts` and by migration | EXT-01 … EXT-07, EXT-11 | the adapter cannot be named; `ADAPTER_<SLOT>` naming it is refused at startup |
| Written ЦЕГ basis and configuration; written exception approvals; assessment and penetration test | EXT-08, EXT-09, EXT-10 | leave `POLICE_ENABLED` unset; the escalation timer and historical search stay disabled |

Clearing a gate is a reviewed change to `docs/implementation/external-integration-gates.md`,
`packages/ports/src/gates.ts` and a migration updating `platform.external_gate` /
`platform.internal_gate`; tests fail when any two disagree. It is never a configuration edit.

## 3. Environment and configuration

Values come from a secret manager and are injected at runtime; `.env.example` documents every key
and carries local defaults only. The variables that decide the shape of a deployment:

| Variable | Production value | Notes |
| --- | --- | --- |
| `NODE_ENV` / `APP_ENV` | `production` / `production` | `APP_ENV` drives every fail-closed default below |
| `DATABASE_URL` | the restricted runtime login (`prsystem_api_login` for the API, `prsystem_worker_login` for the worker) | never the migration login; both processes refuse `MIGRATION_DATABASE_URL` |
| `MIGRATION_DATABASE_URL` | present only in the migration step | see §5 |
| `REDIS_URL`, `QUEUE_PREFIX` | the deployment's Redis; one prefix per deployment sharing a Redis | Redis is never a source of truth |
| `KMS_ADAPTER` | an approved adapter (none exists) | `none` fails closed; `local` is refused outside local, CI and test |
| `ADAPTER_<SLOT>` (`PAYMENT_QPAY`, `PAYMENT_KHAAN`, `EBARIMT`, `XYP`, `EMONGOLIA`, `SMS`, `GEO`, `PAYOUT`, `EMAIL`, `OTP`, `STORAGE`) | unset (= `disabled`) | `simulator` is refused; a production adapter is refused while its gate is blocked; an unwritten adapter cannot be named |
| `CALLBACK_ALLOWLIST_QPAY`, `CALLBACK_ALLOWLIST_KHAAN` | the provider's CIDR ranges, a term of the contract | unset in staging or production refuses every callback from that provider |
| `OBJECT_STORAGE_*` | only when `ADAPTER_STORAGE=s3` | the secret is refused when the adapter is off |
| `SCHEDULER_ENABLED`, `SCHEDULER_DATABASE_URL` | API only; enabled by default in production and then the credential is required | the worker refuses both (D-09) |
| `POLICE_ENABLED`, `POLICE_DATABASE_URL` | unset until EXT-09 and EXT-10 clear | `true` requires the separate Police credential; an API without it has no Police module |
| `SMTP_HOST`, `SMTP_PORT` | the provider's, once INT-MAIL-01 clears | validated at startup |
| `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT` | the deployment's collector | logs are redacted by field name and value shape; no secret, OTP, token or full identifier is ever logged |
| `API_HOST`, `API_PORT` | behind a TLS-terminating edge | TLS 1.2+ and HSTS are the edge's responsibility |
| `PRSYSTEM_API_URL`, `PRSYSTEM_PORTAL_ORIGIN` (each portal) | the API's internal URL; the portal's public https origin | an https origin marks the session cookie `Secure` |

`api` and `worker` validate the whole set at startup and refuse to start on any contradiction (a
credential present for a capability that is off, a simulator above test, an adapter behind a
blocked gate). A refused start is the intended outcome, not an incident.

## 4. Build

From a clean checkout of the candidate commit, with Node 22 and pnpm 9.15.9:

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run build
```

`pnpm run verify` is the local gate set; the governed battery recorded in the Phase 23 record is
the authoritative measurement of the candidate. Artefacts: `apps/api/dist`, `apps/worker/dist`, and
each portal's `.next` production build. The OpenAPI document (`pnpm run openapi`) is a build
artefact for the deployment's API gateway, not a committed file.

## 5. Database — first install and upgrade

1. **Bootstrap the cluster roles once** as in
   [database-bootstrap-runbook.md](database-bootstrap-runbook.md) §3: the owner, the migration
   principal, the runtime roles and logins, the scheduler and Police logins if those capabilities
   will be enabled. The API and worker logins are members of `prsystem_api` / `prsystem_worker` only.
2. **Apply the journal** with the migration principal only, from the migration step's own
   environment (`.env.migration.example`):

   ```bash
   MIGRATION_DATABASE_URL=… pnpm run migrate
   ```

   The runner is idempotent, takes the journal lock, and applies `0000` … `0021` in order; on an
   existing database it applies only what is pending. The precondition check refuses a cluster
   whose role graph is not exactly right (regression suite E3).
3. **Verify** with the migration test's own assertion in mind: the schema after upgrade equals the
   schema after a fresh install (`pnpm run test:migrations` proves it on CI; on the target, compare
   `\d` output of a scratch fresh database if a discrepancy is suspected).

**Expand/contract.** Every migration is written so the previous application version keeps working
against the new schema for the length of a deploy ([12-migration-strategy.md](../architecture/12-migration-strategy.md)
§8); migrations therefore run **before** the application is rolled, never after, and never
concurrently with a schema-reading test suite on the same cluster.

## 6. Deploy order

1. Migrate (§5) with the migration principal; confirm `SELECT count(*) FROM drizzle.__drizzle_migrations` is 22.
2. Roll `api`. Readiness is `GET /health/ready` (200 only when PostgreSQL, Redis and the key
   management adapter answer); liveness is `GET /health/live`. Every answer carries the security
   headers and the deny-all content security policy.
3. Roll `worker`. At startup it logs which provider jobs it scheduled and which gate kept each off;
   with every gate blocked, the refund executor and payout runner are not scheduled and say so.
4. Roll the five portals, each with `PRSYSTEM_API_URL` and its own `PRSYSTEM_PORTAL_ORIGIN`.
5. Smoke: the portal shells render; a Hotel sign-in succeeds; `/health/ready` stays 200 under the
   first minutes of traffic; the worker's queues drain (`QUEUE_PREFIX` keys in Redis move).

Rolling deploys need no downtime: hotels operate 24/7 and there is no maintenance window
(doc 15 §4).

## 7. Post-deploy verification

- `GET /health/ready` 200 on every API instance; `GET /health/live` 200.
- The API's startup log line lists every adapter slot as `disabled` (until a gate clears) and the
  gate that governs it; no line names a simulator.
- A walk-in quote and check-in on a synthetic room in a staging tenant; a checkout with cash on an
  open shift; the Cleaner queue shows the task. (Production tenants carry real data — do not create
  synthetic stays there.)
- The Police realm is absent from the API (`POLICE_ENABLED` unset) unless approved.
- Alerts wired per [13-telemetry-and-redaction.md](../architecture/13-telemetry-and-redaction.md)
  §6: Police alert latency, readiness, error rate.

## 8. Rollback plan

Rolling back means returning the deployment to the previous **application** version. The schema is
never rolled back.

| Situation | Action | Why it is safe |
| --- | --- | --- |
| A bad application release, schema unchanged | redeploy the previous `api`, `worker` and portal artefacts | stateless processes; in-flight requests are the only loss |
| A bad application release after a migration | redeploy the previous application version **against the new schema** | expand/contract: the previous version is required to run against the next schema for the length of a deploy, and `test:migrations` holds the schema to the declaration |
| A bad migration | do **not** run a down-migration (there are none — ADR-0004); write a new forward migration that corrects it, gate it, apply it with the migration principal ([database-bootstrap-runbook.md](database-bootstrap-runbook.md) §5) | data that has moved forward is never rolled backwards |
| Data loss or corruption | point-in-time restore per [recovery-runbook.md](recovery-runbook.md) §3, then the outbox cut-off of §4 so no already-delivered email or SMS is re-sent | rehearsed in Phase 22: RPO exposure 25.2 s, restore 1.6 s on one machine; the full procedure is budgeted inside the 4 h target and must be timed on the hosted environment |
| Redis lost | restart Redis; queues re-drive from the outbox; rate limits fail closed | Redis is never a source of truth |
| A provider gate cleared in error | revert the three-part change (document, `gates.ts`, migration) with a forward migration; the adapter is refused at the next start | the register is read at startup |

**Order of a rollback:** portals first (they only render what the API answers), then `api`, then
`worker`; confirm `/health/ready`; confirm the worker scheduled the same job set as before. Record
the rollback in the deployment log with the two commits and the reason; a rollback is an
operational event, not a change to any phase record.

## 9. What this runbook does not cover

Hosting, network design, the TLS edge, secret-manager integration, backup scheduling and
encryption, monitoring dashboards, and the incident-response procedure are the deployment's and
are part of the EXT-10 assessment that has not been performed. None of them is invented here.
