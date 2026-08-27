# CLAUDE.md — PRsystem Permanent Engineering Rules

**Status:** Authoritative. These rules apply to every phase, every module, every commit.
**Scope:** Multi-tenant hotel booking and operations platform (Hotel, Online Booking, Police, Platform Operation).

Read this file at the start of every phase, before any edit.

---

## 0. Requirement authority

Requirement precedence, highest first:

1. Approved decisions in `docs/00-mvp-open-decisions.md`.
2. The relevant module document (`docs/01` … `docs/26`).
3. `docs/18-action-level-permission-matrix.md`.

`docs/00-*.md` … `docs/26-*.md` are **immutable source requirements**. Do not edit them unless explicitly instructed.

Never silently resolve a real conflict. Record it in `docs/implementation/assumptions-and-conflicts.md` and stop if the conflict materially changes the design.

Implementation-owned documents live under `docs/implementation/` and are updated every phase:

- `build-plan.md` — phase decomposition, scope, gates.
- `phase-status.md` — current phase, completion state, commit SHAs.
- `requirements-traceability.md` — DEC ID → module → code → test mapping.
- `external-integration-gates.md` — external provider blockers.
- `assumptions-and-conflicts.md` — assumptions, resolved drift, open conflicts.
- `dependency-security-register.md` — advisories that cannot be closed by a compatible stable upgrade, with their containment, evidence and mandatory review phase.
- `database-bootstrap-runbook.md` — cluster role bootstrap, the restricted migration principal, and the forward-fix procedure.

---

## 1. Architecture

- TypeScript strict monorepo.
- pnpm workspaces + Turborepo.
- NestJS with Fastify for REST/OpenAPI APIs.
- PostgreSQL is the authoritative database.
- Drizzle ORM plus reviewed SQL where locks or advanced constraints require it.
- Redis and BullMQ only for jobs, retries, and queues.
- Redis must never be the financial source of truth or an authoritative lock.
- Next.js App Router for the web portals.
- S3-compatible private object storage.
- Playwright for end-to-end tests.
- OpenTelemetry-compatible structured telemetry.
- Pin compatible stable dependency versions in the lockfile.
- Modular monolith: **one API deployment and one worker deployment**.
- Do not introduce microservices, Kubernetes, or a distributed broker for the MVP.

---

## 2. Portals

- Public and Guest
- Hotel Operations
- Restaurant
- Police
- Platform Operation

---

## 3. Module boundaries

- A module must not directly use another module's repository.
- Cross-module access goes through application contracts, query services, projections, or outbox events.
- Hotel modules must never query Police tables.
- Police matching consumes minimal check-in events.
- Operation dashboards consume projections and reconciliation views.
- Web applications contain no authoritative business rules.

---

## 4. Authorization

Every backend action must validate:

- authentication realm;
- active account and membership;
- named action permission;
- tenant and resource scope;
- package entitlement;
- account, hotel, and subscription state;
- step-up authentication when required.

Never trust client-supplied `role`, `hotel_id`, `restaurant_id`, `amount`, `balance`, provider status, or payment success.

Realm separation is absolute: Hotel, Guest, Operation/Platform, and Police realms do not merge accounts or permissions. A role *name* never grants data or action rights — every high-risk action requires an explicitly named permission.

Hotel Admin does not inherit Manager / Manager Plus / Reception operational rights. Package entitlement is a hard gate above role permission; both are checked on every backend action.

UI hiding or disabling is never authorization.

---

## 5. Hard data rules

- Store MNT amounts as integer/bigint, never floating point.
- Store percentage rates as integer basis points.
- Use UTC timestamps and explicit hotel-local timezone rules (`Asia/Ulaanbaatar` for Ulaanbaatar hotels).
- Keep booking, payment, refund, fulfillment, and settlement states separate — never collapsed into one status field.
- Financial and lifecycle history is append-only.
- Correct errors through reversal, correction, or amendment records.
- Never edit or delete original ledger events.

Durations are stored as integer minutes / integer half-hour units — never as floating-point hours. Occupancy intervals are `[start_at, end_at)` (end-exclusive).

Snapshots are authoritative: confirmed prices, tariff source level/ID, configuration version, cleaning buffer, and price books are captured at confirmation and are never re-resolved from current configuration.

---

## 6. Reliability

Every money-changing or lifecycle-changing command requires:

- a database transaction;
- idempotency;
- server-side state revalidation;
- immutable audit;
- transactional outbox;
- database constraint, row lock, or revision/CAS where concurrency matters.

Assume HTTP requests, callbacks, jobs, and event deliveries can be duplicated, delayed, reordered, or retried.

**A retry must never create a second business effect.**

---

## 7. Provider callbacks

Before applying a callback:

1. Verify authenticity or signature.
2. Deduplicate the provider event.
3. Match provider, merchant, reference, amount, and currency.
4. Re-query provider status when required.
5. Apply the canonical domain transition idempotently.

A late callback must not silently reopen an expired booking or entitlement. Late or duplicate captures create a refund obligation or a reconciliation case owned by an explicitly permissioned account — never an automatic entitlement change.

---

## 8. Security

Never expose or record plaintext:

- passwords;
- OTPs;
- activation/reset/session tokens;
- provider secrets;
- full registration numbers or passports;
- PAN/CVV or full card payloads;
- sensitive SMS bodies.

Do not put sensitive values in URLs, logs, traces, analytics, errors, audit payloads, fixtures, seeds, or outbox payloads.

Raw identifiers are stored encrypted; exact lookup uses a keyed token namespaced by identity type and country. One-time codes are stored as keyed HMAC/hash, never plaintext.

Use synthetic identities in development and tests. Never use real production registration numbers, addresses, or case data in test/dev environments.

---

## 9. External systems

External systems include **QPay, Khaan Bank, POS, XYP/HUR, eMongolia, eBarimt, CallPro, Google Maps, email, and object storage**.

If an official contract, credential, signature rule, or production approval is missing:

- do not invent it;
- implement a typed port and a deterministic simulator;
- keep the production adapter disabled;
- fail closed;
- record the blocker in `docs/implementation/external-integration-gates.md`.

---

## 10. Database

- Use versioned migrations only.
- Do not use schema push as the migration strategy.
- Test both fresh migration and upgrade migration.
- Use database constraints for critical invariants.
- Use real PostgreSQL for integration and concurrency tests.
- Do not replace PostgreSQL tests with mocked repositories or SQLite.

---

## 11. Phase protocol

Before editing in each phase:

1. Read `CLAUDE.md`.
2. Read `docs/implementation/phase-status.md` and `docs/implementation/requirements-traceability.md`.
3. Read only the requirement files assigned to the phase.
4. List the relevant DEC IDs.
5. List schema, authorization, state, concurrency, audit, and external-gate invariants.
6. Stop if an unresolved requirement conflict changes the design materially.

After implementation:

1. Run the phase's real test gates.
2. Update traceability and phase status.
3. Commit only when the phase passes.
4. Report:
   - scope completed;
   - changed file groups;
   - migrations;
   - DEC coverage;
   - exact test commands and result counts;
   - security or concurrency evidence;
   - remaining blockers;
   - commit SHA.
5. **STOP. Never start the next phase automatically.**

Do not claim PASS for a command that was not run.

Never force-push, delete user work, push, merge, or deploy without explicit authorization.

---

## 12. Token and output control

- Do not repeat accepted architecture decisions.
- Do not quote entire requirement documents.
- Do not paste complete source files or successful command logs.
- Use concise test reporters.
- Show detailed output only for failures.
- Keep normal phase reports under 100 lines.
