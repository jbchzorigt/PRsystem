# 14 — Test Strategy and Gates

The gate catalog every later phase cites, and what each gate must prove.

---

## 1. Principles

1. **Gates are binary.** A phase commits only when every blocking gate passes. A gate that was not run
   is never reported as passing (`CLAUDE.md` §11).
2. **Real PostgreSQL for integration and concurrency.** Mocked repositories and SQLite are not
   substitutes (`CLAUDE.md` §10).
3. **Test the constraint, not the guard.** Where an invariant is a database constraint, the test must
   attempt the violation and observe the database rejecting it.
4. **Concurrency is proven with real connections**, not by reasoning about the code.
5. **Requirements are the oracle.** Assertions cite DEC ids so a failure names the decision it breaks.
6. **Synthetic data only.** No real registration number, address or case data in any environment.

---

## 2. Gate catalog

| Gate | Command | Scope | Blocking from |
| --- | --- | --- | --- |
| `GATE-TYPES` | `pnpm -w typecheck` | TypeScript strict across the workspace | Phase 02 |
| `GATE-LINT` | `pnpm -w lint` | Style plus module-boundary rules | Phase 02 |
| `GATE-UNIT` | `pnpm -w test:unit` | Pure logic: money, time, authorization matrix, state machines, event schemas | Phase 03 |
| `GATE-INTEG` | `pnpm -w test:integration` | Real Postgres: constraints, transactions, authorization end-to-end, provider ports against simulators | Phase 03 |
| `GATE-CONC` | `pnpm -w test:concurrency` | Real Postgres, multiple connections: every race in [11](11-concurrency-strategy.md) §4; from Phase 22 `tools/concurrency-manifest.mjs` names, for every idempotent command, the suite that races it or the kernel proof it relies on | Phase 03 |
| `GATE-MIGR` | `pnpm -w test:migrations` | Fresh and upgrade migration, constraint presence, append-only enforcement | Phase 02 |
| `GATE-E2E` | `pnpm -w test:e2e` | Playwright journeys through the portals | Phase 21 |
| `GATE-SEC` | `pnpm -w test:security` | Secret-leakage canary scan, dependency audit, header and CSP checks | Phase 22 |
| `GATE-GOV` | `node tools/validate-governance.mjs` | Governance and architecture document consistency | Phase 00 |

Phase 01 runs `GATE-GOV` only; no code exists yet, so no other gate is applicable and none is claimed.

---

## 3. What each gate must prove

### `GATE-UNIT`

- Money: `ROUND_HALF_UP` at `.5` boundaries, basis-point arithmetic, no float leakage.
- Time: end-of-month clamping, service-month recurrence, `[start,end)` semantics, backdate bounds.
- Authorization: a table-driven test **generated from doc 18 §§3, 5, 6**, covering every role, every
  action and every `Нэмэлт role` cell.
- State machines: every documented transition allowed, every undocumented transition rejected —
  application, subscription, booking, order, refund, configuration request, rollout batch, Wanted
  case, Match workflow and outcome.
- Event schemas: outbox payloads contain no C3/C4 field.

### `GATE-INTEG`

- Every invariant in [04](04-logical-data-model.md) is a real constraint that rejects its violation.
- The seven-condition pipeline denies at each stage, with cross-tenant denial indistinguishable from
  not-found.
- Provider ports pass the conformance suite: duplicate, out-of-order, delayed, expired,
  amount-mismatch, currency-mismatch, bad-signature, timeout-then-late-success.
- Append-only tables reject `UPDATE` and `DELETE`.
- Exports contain exactly the approved columns and no PII beyond them.
- **RLS** ([ADR-0017](adr/ADR-0017-tenant-isolation-rls.md)): a cross-tenant read is blocked with the
  repository predicate removed; a missing context returns zero rows and rejects writes; every API
  route and every worker job establishes context transactionally; no runtime role holds `BYPASSRLS`;
  `prsystem_api` cannot reach the `police` schema.
- **Audit** ([ADR-0018](adr/ADR-0018-audit-partitioning.md)): grant separation between platform and
  Police streams; partition routing by server timestamp; a simulated audit-write failure rolls back
  the money-changing effect; retention honours legal hold.
- **Projections** ([ADR-0019](adr/ADR-0019-projection-consistency.md)): with a deliberately stale
  projection, authorization, payment eligibility, refund eligibility, allocation and readiness still
  decide correctly; rebuild reproduces the projection exactly.
- **Keys** ([ADR-0020](adr/ADR-0020-key-management.md)): rotation preserves readability; rewrapping is
  resumable; a Police-scope unwrap from a Hotel-scope context is refused; KMS unavailability fails
  closed with no plaintext write.

### `GATE-CONC`

Every race in [11](11-concurrency-strategy.md) §4 has a test that opens multiple real connections,
synchronises at a barrier inside the critical section, and asserts exactly one business effect, a
deterministic winner, a coherent loser state, and an audit trail of both attempts.

**A race without a `GATE-CONC` test is not mitigated**, whatever the code looks like.

### `GATE-MIGR`

Fresh and upgrade runs converge to an identical normalised schema dump; the journal is idempotent;
introspection confirms every named constraint exists.

### `GATE-E2E`

Journeys, not pages: onboarding → activation → configuration → check-in → minibar → checkout → shift
close; search → book → pay → check-in → review; check-in → Police alert → acknowledge → Found;
subscription expiry → grace → hard lock → renewal. Run at mobile, tablet and desktop viewports.

Phase 21 stands the gate up on the real API: `e2e/api-server.mjs` provisions a scratch database
through the API's own harness, seeds synthetic people, starts `createApp` in the `ci` environment
(every external port its simulator) and serves the five portals as production builds; Playwright
drives each portal's flows at a phone, a tablet and a desktop profile, and `e2e/accessibility.spec.ts`
runs axe-core's WCAG 2.0/2.1 A and AA rules over every primary screen. The segments that reach a
provider page or run a full checkout to settlement are Phase 22's full pass.

### `GATE-SEC`

Canary scan across logs, traces, audit rows, outbox payloads, fixtures and seeds; dependency
vulnerability audit; security-header and CSP verification; the `security-review` pass.

Phase 22 completes the gate's four parts: the committed-content scan (`tools/scan-secrets.mjs`,
`SEC-SECRETS`, `SEC-PII-LEAK`) is joined by the runtime scan the e2e run ends with
(`e2e/leakage.spec.ts`: the API's own log, every durable table including `bytea`, the queue, with
every secret the run knew as a canary); the audits are `audit:prod` and `audit:tree`; the headers
and policies are asserted on every API answer (`health.http`) and every portal page
(`e2e/security-headers.spec.ts`); and the review is
[docs/implementation/phase-22-security-review.md](../implementation/phase-22-security-review.md),
which re-verifies the threat model gate by gate.

### `GATE-GOV`

Source-document coverage, DEC uniqueness and count, single-phase assignment, phase-namespace agreement
across governance documents, EXT uniqueness, markdown link resolution, and — from Phase 01 — the
architecture checks in §5.

---

## 4. Test data

- `packages/testing` provides a Postgres harness (container per suite, migrated fresh), a concurrency
  barrier helper, a deterministic clock, and a synthetic identity factory producing structurally valid
  but reserved-range identifiers.
- Fixtures are built through public application contracts, not by inserting rows, so a fixture cannot
  create a state the domain forbids.
- Every suite is order-independent and runs against its own schema or database.

---

## 5. Phase 01 architecture gates

Added to `GATE-GOV` by this phase:

| Check | Assertion |
| --- | --- |
| 8 | Every document listed in the architecture index exists; ADR numbering is contiguous |
| 9 | Every invariant in traceability §25 is named in the architecture control mapping |
| 10 | Every `EXT-01` … `EXT-11` has a named port surface or an explicit no-port rationale |
| 11 | Every one of the 279 DECs has a control and gate mapping row, and every cited control and gate is defined in its catalog |
| 12 | Every architecture design question `DM-01` … `DM-04` is resolved and cites the ADR that closed it |
| 13 | P1 accounting is internally consistent: the pending count agrees across governance documents, and no P1 item is described as closed without an approved DEC |

---

## 6. Definition of done for a phase

A phase is `DONE` when:

1. every blocking gate for that phase passes on a clean checkout;
2. every DEC owned by the phase is `COVERED` in traceability, with the control and gate that prove it;
3. every new race has a `GATE-CONC` test;
4. every new external interaction goes through a typed port with a simulator;
5. no new `Medium` or higher residual risk is introduced without an entry in
   [09](09-threat-model.md) §9;
6. `phase-status.md` records the exact commands run and their results;
7. nothing is claimed that was not executed.
