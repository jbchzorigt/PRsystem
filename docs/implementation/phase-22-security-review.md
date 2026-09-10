# Phase 22 — Security review and threat-model re-verification

**Written:** 2026-09-10, against the Phase 22 implementation tree.
**Scope:** docs/architecture/09 §10 says the threat model is re-verified in Phase 22 against the
implemented system and that each threat's gate must have executed. This document is that
re-verification, plus the `security-review` pass build-plan §Phase 22 names: what was looked at, what
was found, what was fixed, and what stays open. Every "verified by" names a suite the governed battery
executes; the Phase 22 evidence manifest carries the executions.

## 1. What the review found and fixed

Tracing the full journeys end to end — not the modules one at a time — surfaced five integration
defects no earlier gate could see, because each lived between two phases' contracts. They are
recorded as `A-P22-2`, `A-P22-3`, `A-P22-5` and `A-P22-10` in
[assumptions-and-conflicts.md](assumptions-and-conflicts.md) §3.26 and summarised here because
three of them are security-relevant:

| # | Finding | Effect before | Fix | Verified by |
| --- | --- | --- | --- | --- |
| 1 | The stay module's payment-attempt port was never wired in production: `UnprovisionedPaymentAttempts` answered `UNKNOWN` for every attempt | No minibar usage report could ever settle; every minibar checkout blocked | `BillingPaymentAttempts` answers from the folio's own `FOLIO_PAYMENT` transactions; a lock for nothing settles on its own evidence | `billing.integration` (adapter), `checkout.integration` (zero lock), journey `booking` |
| 2 | `platform.stay.booking_ref` and `booking_fulfillment_conflict.booking_ref` were `uuid`; a booking's reference is an 8–12 character code; the check-in route validated it as a UUID and used it as the rate-snapshot subject | No confirmed online booking could be fulfilled; the check-in answered `INTERNAL_ERROR` | Migration `0021` widens both columns with the booking's own shape check; the route accepts the reference; the snapshot subject is the booking's id, so the hold's snapshot is the one the check-in reads (CLAUDE.md §5) | `test:migrations` (148), journey `booking`, `stay.integration` |
| 3 | An unexpected exception became a bare `INTERNAL_ERROR` with **no log entry anywhere**; no request left a log line at all | A 500 was silent; the leakage scanner had no log to scan | `ApiErrorFilter` logs the error under its correlation id through the redacting logger; every completed request logs method, path (no query), status and duration | `health.http`, the e2e leakage scan over the log |
| 4 | Cash payments from the Hotel portal named no shift; the API requires one (doc 24) | Every cash payment through the portal failed `SHIFT_REQUIRED` | The stay page carries the Reception's open shift; the page says so when none is open | journeys `booking`, `onboarding` |
| 5 | Neither the API nor any portal sent a security header; no content security policy | Framing, sniffing and foreign-origin loading were unconstrained | `registerSecurityHeaders` on every API answer (`default-src 'none'`, `nosniff`, `DENY`, `no-store`); the five portals share one header set from the kit (`frame-ancestors 'none'`, `object-src 'none'`, `form-action 'self' https:`) | `health.http`, e2e `security-headers` |

Two things the review looked for and confirmed absent, recorded as open items rather than fixed:

- **No general request rate limiting** exists on the API (`T-X-05`, `CTL-CFG-01`). The specific
  limits the requirements name are in place where they are named — OTP attempts and lockouts,
  guest access-code attempts, Police exact-search attempts, TOTP once-per-step — but there is no
  per-IP or per-account ceiling on ordinary requests, and doc 15 §4's "Redis unavailable → rate
  limits fail closed" has nothing to fail. The concrete values are P1 configuration; the mechanism is
  Phase 23's to decide with the customer (`A-P22-6`).
- **The outbox relay has no consumer scheduled** (`A-P22-7`). `packages/outbox` provides
  `relayOnce`/`consumeOnce`, the worker names the queue, nothing runs it. Every committed event is
  durable and none is delivered; the platform's integrations today read state (the Police matcher
  sweeps stays; the settlement sweeps read payables), so nothing is lost — and the "outbox relay lag"
  target of doc 15 §2.1 cannot be measured. Scheduling it, with the recovery cut-off of the runbook
  §4, is a decision for the phase that first needs a consumer.

## 2. Threat-model re-verification

Method: each threat in docs/architecture/09 names a control and a gate. For each, the gate ran in the
Phase 22 battery (`GATE-UNIT`, `GATE-INTEG`, `GATE-CONC`, `GATE-SEC`, `GATE-E2E`, `GATE-MIGR`), and
the suite below is the one whose assertions exercise the threat's mitigation on the real system.
"Residual" repeats the threat model's own assessment; where Phase 22 measured it, the measurement is
named.

### Cross-cutting

| Threat | Verified by | Phase 22 note |
| --- | --- | --- |
| T-X-01 stolen session after suspension / password change | `iam.concurrency` (suspension wins against acceptance; suspended actor refused), `iam.integration` (auth epoch), GATE-SEC `SEC-ROLE` | — |
| T-X-02 client-supplied `role`, `hotel_id`, `amount`, `paid` | every `*.authorization.http` and `*.security` suite (`rejectServerOwnedFields`), `booking.http` (forged callback) | — |
| T-X-03 repudiation of a financial action | `billing.integration`, `finance.integration` (audit with actor, reason, server time), GATE-SEC `SEC-AUDIT` | — |
| T-X-04 sensitive value in a log, trace, URL or audit payload | GATE-SEC `SEC-PII-LEAK`, `SEC-ONBOARDING-ISOLATION`, `SEC-SECRETS`; **new:** the e2e leakage scan over the run's own log, every durable table and the queue, with every secret the run knew as a canary | zero findings; §3 |
| T-X-05 credential stuffing, OTP and export flooding | `guest.security` (attempt limits, lockouts), `police.security` (exact-search limits), `reporting.security` (export cap) | general rate limiting absent — open, `A-P22-6` |
| T-X-06 package gate bypassed via a higher role | `authz` unit (943), `catalog.authorization.http`, `minibar.authorization.http` | — |
| T-X-07 Hotel Admin acting without the extra role | `authz` unit, `iam.integration` | — |
| T-X-08 retry creates a second effect | `packages/db` kernel concurrency (four idempotency proofs), every module's concurrency suite; **new:** `validate-concurrency-coverage` holds all 147 commands to a race or the kernel proof | — |
| T-X-09 concurrent commands corrupt an aggregate | GATE-CONC (97 races, ×3), `SEC-LOCK-EVIDENCE` | — |
| T-X-10 cross-tenant read via a swapped id | `*.security` suites (opaque `NOT_FOUND`), GATE-SEC `SEC-RLS`, `SEC-ACL-MATRIX` | e2e: a Cleaner's URL to finance, a guest's URL to another's booking, an Officer's URL to the check-in list |
| T-X-11 unscoped query bypasses the tenant predicate | GATE-SEC `SEC-RLS` (forced RLS, zero rows without context) | — |
| T-X-12 pooled connection keeps a tenant context | kernel concurrency ("leaves no tenant context on a returned connection") | — |
| T-X-13 background job unscoped across tenants | GATE-SEC `SEC-SCHEDULER`, `SEC-MAINTENANCE`; `apps/worker` startup tests | e2e runs the worker's consumers on the worker login |
| T-X-14 effect commits while its audit is lost | GATE-SEC `SEC-AUDIT` (audit-write failure rolls back) | — |
| T-X-15 audit altered or purged | GATE-SEC `SEC-AUDIT`, `SEC-ACL-MATRIX` (no direct privilege on either stream) | — |
| T-X-16 missing audit partition | GATE-SEC `SEC-PARTITION` | — |
| T-X-17 decision from a stale projection | `booking.concurrency` (availability under lock), `stay.concurrency` | — |
| T-X-18 identifiers decrypted after key compromise | GATE-SEC `SEC-KMS` (realms never share key material), `ports` unit (envelope encryption) | — |
| T-X-19 lookup tokens reversed | `ports` unit (keyed HMAC, namespaced) | — |
| T-X-20 key material in source, config, row, log or fixture | `scan-secrets`, `SEC-SECRETS`, `SEC-PII-LEAK`, the e2e leakage scan | — |
| T-X-21 KMS outage degrades protection | GATE-SEC `SEC-KMS` (fails closed, no local fallback) | measured by fault injection where the port exists; the KMS itself is local in every environment this phase can run |

### Guest realm

| Threat | Verified by | Phase 22 note |
| --- | --- | --- |
| T-G-01 phone reuse / SIM swap | `guest.integration` (OTP proves the number only); check-in identity is the Reception's (`stay.integration`) | inherent; unchanged |
| T-G-02 e-Mongolia auto-merge | `guest.integration` (link request, no merge) | EXT-02 blocked; the portal shows it closed |
| T-G-03 login reveals registration | `guest.security` (uniform answer) | — |
| T-G-04 screenshot / redirect confirms a booking | `booking.http` (forged callback, wrong signature, unknown invoice); fault injection (provider down leaves the hold) | — |
| T-G-05 review without a stay, or twice | `review.integration`, `review.concurrency` (unique on `booking_id`); journey `booking` reviews a completed stay | — |
| T-G-06 order from a room not one's own | `restaurant.security` (session bound to hotel + room + stay) | — |
| T-G-07 access-code brute force | `restaurant.security`, `restaurant.concurrency` (attempts, block, invalidation on reissue) | values P1-17 |
| T-G-08 searcher location retained | `public.security` (coordinates transient) | the portal asks before reading the device's position |
| T-G-09 disputed cancellation fee | `booking.integration` (policy snapshot before payment) | — |

### Hotel realm

| Threat | Verified by | Phase 22 note |
| --- | --- | --- |
| T-H-01 Reception edits a report | `checkout.integration` (return for correction; versions immutable) | — |
| T-H-02 charging an absent product | `checkout.integration` (line references the price book) | — |
| T-H-03 price override | `checkout.integration`, `minibar.integration` (server tariff) | — |
| T-H-04 backdating to shift cash | `stay.integration` (120-minute bound, open shift, hotel-local day) | — |
| T-H-05 editing a closed shift | `stay.integration` (closed shift immutable) | — |
| T-H-06 unrecorded drawer transfer | `finance.concurrency` (transfers lock both shifts) | — |
| T-H-07 shrinkage as adjustment | `minibar.integration` (reason, audit; adjustment never increases billable quantity) | detective; unchanged |
| T-H-08 suspended employee finishes work | `iam.concurrency` (takeover queue) | — |
| T-H-09 Manager Plus on a 25 000₮ hotel | `authz` unit, `iam.integration` (role grant package-gated) | — |
| T-H-10 Reception / Cleaner exports the registry | `reporting.security` | — |
| T-H-11 Cleaner sees identity or prices | `stay.security`, `minibar.authorization.http`; e2e: the Cleaner's dashboard carries product, quantity, room | — |
| T-H-12 double check-in | `stay.concurrency` (exclusion constraint, readiness under lock) | — |
| T-H-13 disputed deposit deduction | `billing.integration` (allocation records line, amount, actor, stay, time) | — |
| T-H-14 Admin self-approves an expense | `finance.integration` (`self_approved` recorded) | accepted (`FIN-DEC-005`) |
| T-H-15 pending change blocks a room | `minibar.integration` (blocker badge, cancel and rollback paths) | — |

### Restaurant scope

| Threat | Verified by | Phase 22 note |
| --- | --- | --- |
| T-R-01 order total from the client | `restaurant.integration` (server recomputes) | — |
| T-R-02 refund marked complete without money | `restaurant.integration` (provider result only) | — |
| T-R-03 accept / refund race | `restaurant.concurrency` (first valid transition wins) | — |
| T-R-04 restaurant sees guest identity | `restaurant.security` | — |
| T-R-05 late payment after closing | `restaurant.integration` (`CANCELLED` + `PAID` + refund) | — |
| T-R-06 contact number harvested | `restaurant.security` (released to the ordering session only) | — |

### Police realm

| Threat | Verified by | Phase 22 note |
| --- | --- | --- |
| T-POL-01 hotel staff learn a guest is wanted | `police.security`, GATE-SEC `SEC-POLICE-ISOLATION` | — |
| T-POL-02 match inferred from response shape or timing | `police.security` (timing-parity test) | re-verified: the suite ran ×3 in the battery |
| T-POL-03 Officer reaches the all-hotel list | `police.security`; e2e: the Officer's URL to the list is refused | — |
| T-POL-04 Admin acting by role name | `authz` unit (every mutation needs a named permission) | — |
| T-POL-05 self-approval of False Match / Found correction | `police.integration`, `police.concurrency` (separation on immutable account ids) | — |
| T-POL-06 4-digit bootstrap brute force | `police.security` (TTL, attempts, lock, resend, caps) | needs written approval (EXT-10) |
| T-POL-07 full number in SMS to a wrong number | `police.security` (verified official numbers only; body never logged); the e2e leakage scan | needs written approval + provider DPA |
| T-POL-08 identity altered to redirect matching | `police.integration` (append-only revisions; dependent cases suspended) | — |
| T-POL-09 Officer denies confirming Found | `police.integration` (immutable id, unit, server time) | — |
| T-POL-10 bulk extraction by repeated exact search | `police.security` (rate limit per account and device/IP; every search audited) | — |
| T-POL-11 platform support reads Police data | GATE-SEC `SEC-ACL-MATRIX`, `SEC-POLICE-ISOLATION` (`prsystem_police` ungranted elsewhere) | — |
| T-POL-12 escalation storm | `police.concurrency` (one match per stay and person; alerts idempotent) | — |
| T-POL-13 Police audit read by an operator | GATE-SEC `SEC-ACL-MATRIX` (`police_audit` separate stream) | — |
| T-POL-14 Police identifiers under Hotel keys | GATE-SEC `SEC-KMS` (distinct scopes) | — |

### Operation and Platform realm

| Threat | Verified by | Phase 22 note |
| --- | --- | --- |
| T-OP-01 takeover via password reset | `operation.integration` (registered address only; operator sees queued-or-not); e2e | — |
| T-OP-02 contact changed to the operator's number | `operation.integration`, `operation.concurrency` (old and new OTP; exception needs a distinct permission and MFA) | — |
| T-OP-03 reconciliation grants entitlement | `onboarding.integration`, `subscription.integration` (terminal financial records only) | — |
| T-OP-04 provisioning retry mutates the application | `onboarding.concurrency` (immutable snapshot; unique constraints) | — |
| T-OP-05 mass SMS misuse | `operation.integration` (manual-only, preview, confirm); fault injection (provider down keeps the job) | per-job cap P1-07 |
| T-OP-06 full email / phone in listings | `operation.security` (masked; exact search does not unmask); e2e list | — |
| T-OP-07 suspension extends a paid term | `subscription.integration` (`expires_at` untouched); journey `subscription` | — |

### External interfaces

| Threat | Verified by | Phase 22 note |
| --- | --- | --- |
| T-E-01 forged callback | `booking.http`, `restaurant.http`, `onboarding.security` (signature, dedup, match, re-query) | simulators; every gate blocked |
| T-E-02 late capture reopens a hold | `booking.concurrency`, `settlement.integration` (refund obligation) | — |
| T-E-03 provider denies a refund | `settlement.integration` (terminal only on verified success) | — |
| T-E-04 fabricated identity | `stay.integration` (provenance recorded); fault injection (outage → `MANUAL`) | until EXT-01 clears |
| T-E-05 forged e-Mongolia redirect | `guest.security` (server-to-server exchange) | EXT-02 blocked |
| T-E-06 provider retains bodies | `operation.security` (masked locally, body never logged); the leakage scan | EXT-05 DPA |
| T-E-07 hand-authored receipt number | `onboarding.integration` (operators cannot enter receipt fields) | — |
| T-E-08 manipulated distance | `public.integration` (server-side) | — |
| T-E-09 export URL leaked | `reporting.security`, `police.security` (private bucket, five-minute link, TTL, re-check) | — |
| T-E-10 activation / reset link forwarded | `iam.integration`, `onboarding.integration` (single use, TTL, invalidation) | — |
| T-E-11 payout disputed | `settlement.integration` (per-batch reconciliation) | until EXT-07 clears |

**New module, interface or cross-realm data path since Phase 01:** none. The two API additions of
Phases 21 and 22 (the navigation projection on `GET /auth/session`; the billing adapter answering the
stay module) stay inside their realms and existing trust boundaries, and neither adds a data path a
threat above does not already cover.

## 3. The secret-leakage scan (zero findings)

`e2e/leakage.spec.ts`, the last Playwright project, after every flow and journey has run at three
viewports: the API's own log for the run (request lines, the startup lines, any error), every row of
every table in `platform`, `police`, `audit` and `police_audit` — including what hides in `bytea`
columns as hex — and every Redis key under the run's queue prefix, searched for every secret the run
knew: the seeded and chosen passwords, every one-time code a simulator sent, every authenticator code
the console handed out, every activation and invitation token, the session tokens the tests obtained,
the registration numbers, the access codes and QR tokens. The measured scope and the result are in
[phase-22-measurements.md](phase-22-measurements.md) §5.

`tools/scan-secrets.mjs` over every git-tracked file, and GATE-SEC's `SEC-PII-LEAK`,
`SEC-ONBOARDING-ISOLATION` and `SEC-SECRETS`, remain the committed-content half of the gate.

## 4. Dependency advisories

`DSR-01` and `DSR-02` received their mandatory Phase 22 review in
[dependency-security-register.md](dependency-security-register.md): unchanged transitive paths, no new
runtime dependency, production audit clean, both still `OPEN — contained`.

## 5. Open items carried to Phase 23

`A-P22-6` (general rate limiting), `A-P22-7` (outbox relay unscheduled), `A-P22-8` (load shortfall on
the room board), `A-P22-9` (a nonce-based script policy for the portals), the three Police items
awaiting ЦЕГ, EXT-10's penetration test, and every EXT gate.
