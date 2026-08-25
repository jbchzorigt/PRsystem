# PRsystem — MVP Build Plan

**Version:** 1.0
**Created:** Phase 00
**Baseline:** `docs/00-mvp-open-decisions.md` … `docs/26-room-minibar-lifecycle.md` (immutable)
**Branch:** `claude/mvp-implementation`

---

## 1. Deployment shape

One modular-monolith **API** deployment and one **worker** deployment, plus five Next.js App Router portals.

```
apps/
  api/                 NestJS + Fastify, REST/OpenAPI, all modules
  worker/              BullMQ consumers: outbox relay, exports, reconciliation, boundary jobs
  web-public/          Public + Guest (search, booking, guest session, reviews)
  web-hotel/           Hotel Operations (Hotel Admin, Manager, Manager Plus, Reception, Cleaner)
  web-restaurant/      Restaurant Manager
  web-police/          Police Admin / Police Officer
  web-operation/       Platform Operation / Platform Super Admin
packages/
  contracts/           Cross-module application contracts + DTOs (no repositories)
  authz/               Permission catalog, entitlement gates, realm guards
  money/               MNT bigint, basis points, ROUND_HALF_UP
  time/                UTC + hotel-local timezone, [start,end) intervals, service-month math
  db/                  Drizzle schema, versioned migrations, tx + lock helpers
  outbox/              Transactional outbox, idempotency store, event envelope
  ports/               Typed external ports + deterministic simulators
  telemetry/           OpenTelemetry setup, structured logging with redaction
  testing/             Postgres testcontainer harness, concurrency helpers, synthetic identities
```

Module boundary rule (CLAUDE.md §3) is enforced by lint: a module may import another module's
`contracts` surface only — never its repository, entity, or schema file.

---

## 2. Phase decomposition

Each phase is independently committable and independently gated. Phases run strictly in order;
`STOP` after every phase.

| # | Phase | Requirement inputs | Primary DEC families |
| --- | --- | --- | --- |
| 00 | Requirement intake & governance baseline | 00–26 | all (inventory only) |
| 01 | Monorepo & toolchain foundation | 01 | — |
| 02 | Platform kernel (tenancy, authz, audit, outbox, money, time) | 18, 19, 17 | RBAC-DEC-001–017 |
| 03 | External ports & deterministic simulators | 00 §4, 08, 09, 11, 13, 14, 16 | EXT-01…EXT-11 |
| 04 | Onboarding, subscription pricing & lifecycle | 15, 16, 17 | ONB-DEC-001–008, SUB-DEC-001–009, LIFE-DEC-001–007 |
| 05 | Staff account lifecycle & RBAC enforcement | 19, 18 | STAFF-DEC-001–009, RBAC-DEC-001–017 |
| 06 | Hotel configuration: rooms, categories, tariffs, entity lifecycle | 07, 05, 26 §§2–13 | STAY-DEC-005–007, RML-DEC-001–006 |
| 07 | Minibar inventory core | 22 | INV-DEC-001–008 |
| 08 | Template versions, Publish/Default/Archive, Rollout (single + batch) | 26 §§14–39, 22 §7 | RML-DEC-007–028 |
| 09 | Cash drawer ledger & Reception shift | 24, 03 | CASH-DEC-001–010, SHIFT-DEC-001–007 |
| 10 | Stay lifecycle: check-in, actual time, readiness, checkout, overdue | 05, 06, 02 | STAY-DEC-001–014, RC-DEC-012–017, RC-DEC-044 |
| 11 | Deposit & payment correction | 20, 02 §3.4 | DEP-DEC-001–010, RC-DEC-002–006 |
| 12 | Minibar price snapshot, Cleaner reports, checkout exception & dispute | 25, 21, 04 | PRICE-DEC-001–008, CHK-DEC-001–006, RC-DEC-035 |
| 13 | Guest registry & background export | 12 | GUEST-DEC-001–008, RC-DEC-032–033 |
| 14 | Hotel Admin financial reporting | 23 | FIN-DEC-001–010, RC-DEC-037 |
| 15 | Online booking: search, auth, inventory, payment, settlement | 09, 11 | BK-DEC-001–014, PAY-DEC-001–009 |
| 16 | Ratings, reviews, moderation, official reply | 10 | RV-DEC-001–007 |
| 17 | Restaurant module | 08, 02 §§RC-DEC-019–031 | REST-DEC-001–006, RC-DEC-019–031 |
| 18 | Police monitoring system | 13 | POL-DEC-001–022 |
| 19 | Operation Dashboard & SMS reminders | 14 | OPS-DEC-001–018 |
| 20 | Portal hardening & accessibility pass | 02, 04, 06, 09, 13, 14 | — |
| 21 | Cross-cutting E2E, concurrency, security & release gate | all | all |

---

## 3. Phase detail

### Phase 01 — Monorepo & toolchain foundation

**Scope.** pnpm workspace + Turborepo pipeline; TypeScript strict (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`); NestJS+Fastify API skeleton with OpenAPI;
worker skeleton with BullMQ; five Next.js App Router shells; Drizzle + versioned migration runner;
Postgres + Redis via docker-compose; OpenTelemetry bootstrap with log redaction; Playwright harness;
ESLint boundary rule; CI gate script; pinned lockfile.

**Gates.** `pnpm -w typecheck` · `pnpm -w lint` · `pnpm -w build` · fresh-migration test ·
API health E2E · boundary-lint fixture proving a cross-module repository import fails.

**Exit.** Empty but wired: every app boots, migrations run fresh, telemetry emits, CI green.

---

### Phase 02 — Platform kernel

**Scope.** Tenancy (`hotel_id` scope propagation); four authentication realms; server-side session
and auth-epoch revocation; the named-permission catalog derived from doc 18 §§3, 5, 6; package
entitlement gate (20 000₮ / 25 000₮ / 30 000₮); subscription state gate incl. 48h grace and hard
lock; multi-role permission union; step-up MFA marker; append-only audit log; transactional outbox +
relay; idempotency key store; `packages/money` (bigint MNT, basis points, `ROUND_HALF_UP`);
`packages/time` (UTC storage, hotel-local resolution, `[start,end)` interval type, calendar-month and
service-month arithmetic incl. end-of-month clamping).

**Invariants.** Every action passes realm → account/membership → named permission → tenant/resource
scope → package entitlement → account/hotel/subscription state → step-up. Role name alone grants
nothing. Client-supplied role/scope/amount/status is discarded.

**Gates.** Unit: permission matrix table-driven test asserting every row of doc 18 §3/§5/§6 including
every `Нэмэлт role` cell. Integration (real Postgres): audit append-only constraint, outbox
exactly-once relay under duplicate delivery, idempotency replay returns prior result.
Concurrency: parallel permission revocation vs in-flight action.

---

### Phase 03 — External ports & deterministic simulators

**Scope.** Typed ports + deterministic simulators for QPay, Khaan Bank gateway, manual/integrated
POS, XYP/HUR, e-Mongolia, eBarimt, CallPro SMS, Google Maps/Geocoding, email, S3-compatible storage.
Each port: signature verification hook, provider event dedup store, reference/amount/currency match,
status re-query, canonical idempotent transition. Production adapters compiled but **disabled by
config and fail closed**.

**Gates.** Simulator conformance suite per port: duplicate callback, out-of-order callback, delayed
callback after expiry, unknown reference, amount mismatch, currency mismatch, signature failure,
timeout-then-late-success. Assert: no second business effect; disabled production adapter refuses to
run and emits a gate error.

---

### Phase 04 — Onboarding, subscription pricing & lifecycle

**Scope.** Application state machine `DRAFT → OWNER_VERIFICATION_REQUIRED → PENDING_PAYMENT →
PAYMENT_UNCERTAIN/FAILED/EXPIRED → PAID_OWNER_VERIFICATION_REQUIRED → PAID_PENDING_PROVISIONING →
PROVISIONING → PROVISIONED | PROVISIONING_FAILED`; citizen/organization owner types; existing
owner/account proof; payment-gated activation; durable all-or-nothing provisioning transaction
(hotel + owner link + subscription + Primary Hotel Admin membership) with ≤5 backoff retries then
manual `ONBOARDING_PROVISION_RETRY`; activation link via outbox; default cash drawer created at
activation; subscription pricing (`monthly × 1/3/7/12`, VAT-inclusive, no discounts); eBarimt
generation + manual retry queue; upgrade-only package floor with service-month boundary,
incremental second upgrade, `billing_revision` CAS serialization; 48h grace, hard lock, public
listing hide; `PAID_REQUIRES_RECONCILIATION` queue.

**Gates.** Concurrency: duplicate payment callback, two providers paying one intent, late capture on
expired attempt, boundary worker vs upgrade callback racing on the same `billing_revision`.
Integration: provisioning failure leaves zero partial entities; email failure does not roll back
provisioning; renewal inside grace extends from original `expires_at`; renewal after grace starts at
payment confirmation.

---

### Phase 05 — Staff account lifecycle & RBAC enforcement

**Scope.** User account vs hotel/restaurant membership; invitation token lifecycle
`ACTIVE → ACCEPTED | SUPERSEDED | EXPIRED | REVOKED`; one canonical membership per scope + at most
one `ACTIVE` invitation (DB unique constraints); `membership_revision` CAS serializing
invite/accept/role-change/suspend/terminate/reactivate; scope-targeted session revocation matrix;
`TAKEOVER_REQUIRED` Reception shift queue; Cleaner task reassignment and linked `CONTINUATION` task;
Restaurant reassignment; single Primary Hotel Admin.

**Gates.** Concurrency: suspension committing against a concurrent invitation accept; two Managers
claiming one takeover item; two Cleaners claiming one task. Integration: password reset revokes all
sessions across all memberships; package-forbidden role invitation rejected at API.

---

### Phase 06 — Hotel configuration

**Scope.** Room categories, physical rooms (hotel-scoped unique room number), hourly/nightly tariff
levels (hotel default → category override → room override) with independent resolution;
`ACTIVE → RETIRING → INACTIVE` lifecycle for room/category/product/template entities; hard-delete
only for never-used entities; reactivation dependency validation; cleaning buffer configuration;
fixed hotel check-out time; deposit amount configuration (hotel + category override).

**Invariants.** Walk-in `room → category → hotel`; online quote `category → hotel`, room override
never used. Server-authoritative rate resolution; confirmation snapshot stores unit price, source
level, source entity ID, config version. Later tariff edits never reprice confirmed bookings or
active stays.

**Gates.** Table-driven precedence and inheritance tests for both stay types; audit assertions on
every tariff create/update/unset; lifecycle blocker tests (active stay, confirmed future booking,
inventory movement); hard-delete rejection for any referenced entity.

---

### Phase 07 — Minibar inventory core

**Scope.** Products with separate selling price and purchase cost; two stock locations (warehouse,
per-room minibar); immutable typed movement ledger (`OPENING`, `PURCHASE`, `TRANSFER_TO_ROOM`,
`RETURN_TO_WAREHOUSE`, `GUEST_CONSUMPTION`, `WASTE`, `ADJUSTMENT_IN/OUT`); non-negative balance
constraints; continuous hotel-level weighted average cost with per-movement cost snapshot;
active-stay refill request → Cleaner task → atomic warehouse→room transfer; stay-scoped non-guest
stock-out.

**Gates.** Real-Postgres concurrency: parallel refills against a scarce warehouse balance never go
negative and never over-transfer; retry of one transfer posts once. Weighted-average unit tests
including zero-balance receipt and adjustment-in without established cost.

---

### Phase 08 — Template versions & Rollout

**Scope.** Template entity lifecycle separate from version lifecycle `DRAFT → PUBLISHED → ARCHIVED`;
immutable published product list/target quantities; Publish validation (ACTIVE parent, ≥1 unique
same-hotel ACTIVE product, positive integer targets); first-published-is-Default, subsequent publish
does not change Default; separate atomic `Set default`; Archive blockers; exact-version room binding
(`current_version_id`, `pending_target_version_id`); room configuration `current + ≤1 pending`;
ON→OFF / OFF→ON / A→B reconciliation with Cleaner tasks; shortage override; cancel vs compensating
rollback; single-room Rollout; multi-room Rollout batch with read-only Preview, partial-success
Confirm, derived batch state, `Cancel remaining`, linked `retry_of_batch_id`.

**Gates.** Concurrency: duplicate Confirm with one idempotency key creates one batch; two Rollouts on
one room violate the one-pending invariant; check-in racing configuration apply. Integration:
Publish/Set default/Archive produce zero pointer, stock, task, or blocker side effects; batch state
derivation table covering all five states.

---

### Phase 09 — Cash drawer ledger & Reception shift

**Scope.** `DRAWER` / `SAFE` locations; default `Үндсэн касс` at activation; one active shift per
drawer, one active drawer shift per Reception account; `INITIAL_FLOAT` from first actual count;
typed immutable movements; expected-cash formula; variance; separate operational and financial review
states; self-close mode; opening balance from actual received/counted amount; transfer with locked
source/destination shift IDs, recipient confirmation, cancel-with-recount; drawer↔safe; bank deposit
and owner withdrawal approvals; effective-date-only corrections; expense payment execution
(`PAID_CASH_EXPENSE`).

**Gates.** Concurrency: two shifts opening on one drawer; transfer confirm racing shift close.
Integration: shift with a pending transfer cannot close; correction never rewrites a closed shift;
card/POS/QPay expense produces no drawer movement.

---

### Phase 10 — Stay lifecycle

**Scope.** Primary guest identity (`MN_REG_NO`, `FOREIGN_PASSPORT`, `OTHER_GOV_ID`, `NO_DOCUMENT`),
encrypted identifiers with keyed lookup tokens, guardian metadata, server-derived age; walk-in vs
online source and deposit exemption; hourly (30-minute units) and nightly (`N` calendar nights +
snapshotted fixed checkout time) stays; `[start_at, end_at)` occupancy; snapshotted cleaning buffer;
planned vs actual readiness anchors; composite readiness gate (buffer + `Цэвэр` + minibar readiness);
initial `actual_check_in_at` with 120-minute bounded backdate and historical readiness proof;
immutable `check_in_recorded_at`; active-stay actual-time correction request/approval with
`self_approved` audit; fully locked planned checkout; overdue conflict alert, reassignment,
higher-category approval, `CANCELLED_HOTEL`; guest access codes and multi-device sessions (30 000₮).

**Gates.** Concurrency: two Receptions checking into one room; check-in racing an overdue conflict
resolution. Integration: backdate rejected when historical readiness cannot be proven from immutable
events; correction changes only effective actual start and touches no price, payment, cash, config,
stock, or Police timestamp; no API path can mutate a confirmed `planned_checkout_at`.

---

### Phase 11 — Deposit & payment correction

**Scope.** Walk-in-only deposit (50 000–100 000₮), versioned deposit balance aggregate with reserved
amounts, original-channel refund, alternate-channel refund approval, POS reference capture, refund
state machine, authoritative release, `LATE_REFUND_SUCCESS` freeze + `DEPOSIT_REFUND_RECONCILE`
terminal posting (covered + shortfall), immutable financial correction (reversal + corrected record).

**Gates.** Concurrency: parallel allocation and refund reservation on one aggregate; duplicate
approval executes one reversal. Integration: available balance never negative; released refund with
late provider success creates exactly one reconciliation case and no second refund.

---

### Phase 12 — Price snapshot, Cleaner reports, exception & dispute

**Scope.** Stay price book created atomically at check-in from the exact current published version
(including zero-opening rows); active-stay price isolation; Cleaner report versions; Reception
return-for-correction; Manager exception report; payment-attempt report-version lock; post-payment
immutable adjustment; guest dispute hold; billable-quantity formula with documented refill and
non-guest stock-out.

**Gates.** Integration: current price edits never reprice an active stay; a product absent from the
price book can never be charged; payment lock is not released while provider status is pending or
unknown; one report version cannot back two successful charges.

---

### Phase 13 — Guest registry & export

**Scope.** Six approved columns; server-side pagination (20/50/100); mandatory effective-check-in date
range defaulting to 30 days; stay-status/room/name filters; DOB-derived age snapshot; background
export job (`QUEUED/RUNNING/COMPLETED/FAILED/EXPIRED`) capped at 10 000 rows with no partial file;
private storage with 1-hour file TTL and 5-minute signed URL; 365-day product retention with
`retention_policy_version` snapshot and legal hold.

**Gates.** Authorization: Reception/Cleaner/Restaurant and cross-hotel IDs denied on list, job create,
and download. Integration: >10 000 result set refuses to start; expired file returns `EXPIRED`;
re-issued URL does not extend file TTL.

---

### Phase 14 — Hotel Admin financial reporting

**Scope.** Separate confirmed sales, received payments, receivables, held deposits, refunds, paid
expenses; minibar gross profit on weighted-average COGS; inventory purchase vs COGS not double
deducted; expense lifecycle with approval separate from payment execution; 11 KPI cards; 7-day /
this-month / custom ranges with per-metric date basis; top-5 rooms by demand and by revenue; four
Excel exports.

**Gates.** Golden-dataset assertions per KPI and per export column set; authorization tests proving
Manager/Manager Plus/Reception/Cleaner cannot reach the dashboard or exports; PII-absence assertion
on every financial export.

---

### Phase 15 — Online booking

**Scope.** Public search (date, location, current-location radius), listing visibility conditions,
category inventory availability, e-Mongolia and phone-OTP guest auth (ports), booker vs staying
guest separation, 10-minute payment hold, single active payment attempt, QPay/Khaan provider parity,
`CONSUMED`/`EXPIRED` race resolution under row lock, late/duplicate capture refund obligation,
cancellation (24h boundary) and no-show (arrival-date 23:59:59 cutoff), first-night fee retention,
contract commission in basis points with `ROUND_HALF_UP`, provider fee as platform expense,
`D+1 12:00 Asia/Ulaanbaatar` payout batch, `ADJUSTMENT_DUE`, hotel-caused overbooking remedies.

**Gates.** Concurrency: two guests paying for the last unit of a category; expiry racing a paid
callback. Integration: expired booking never reopens; commission base is zero on full refund; payout
ledger reconciles gross/commission/refund/net per batch.

---

### Phase 16 — Ratings, reviews, moderation

**Scope.** Verified-stay eligibility (one review per completed booking), 1–5 integer rating, 10–1000
character comment, 30-day window from `actual_checkout_at`, owner edit/soft-delete, authenticated
guest report with one open report per account/review, `REVIEW_MODERATE` hide/restore with mandatory
reason, one official hotel reply per review with package rules, aggregate recomputation.

**Gates.** DB uniqueness on `booking_id` review and `review_id` reply; aggregate correctness after
hide/restore/soft-delete; authorization proving no hotel/Operation/Police role name grants moderation.

---

### Phase 17 — Restaurant module

**Scope.** 30 000₮-only registration by Manager Plus; per-hotel-link active state; weekly and
overnight schedules; menu management; room QR + one-time guest access code (≤5 sessions per stay);
seven separate state axes (order, fulfillment, payment, refund policy, refund request, refund,
handoff); own-merchant QPay; acceptance/refund-request race under row lock; 5/10/30-minute SLAs;
15/30/45/60-minute ETA; checkout handoff options; closing/late-payment mandatory refund queue.

**Gates.** Race test: accept vs refund request committing simultaneously — first valid transition
wins. Integration: restaurant payments never enter hotel checkout, deposit, cash, or shift totals;
invoice validity never exceeds the day's ordering close.

---

### Phase 18 — Police monitoring system

**Scope.** Wanted Person (immutable identity revisions) / Wanted Case (lifecycle) / Match
(`unique(stay_id, wanted_person_id)`) / append-only `MatchCaseLink`; exact normalized `MN_REG_NO`
matching only, triggered at `check_in_recorded_at`; no retroactive matching of checked-out stays;
manual identity two-person approval; case lifecycle permissions; acknowledgement without ownership;
`Found` by any active officer; two-person Found correction and False Match workflows; alert routing
by hotel district with Police Admin fallback; SMS containing only the full RD; Police Admin
check-in list with 31-day historical window and no bulk export; Wanted Case Excel with masked RD by
default; 4-digit bootstrap code hardening; step-up MFA for high-risk actions.

**Gates.** Isolation: no hotel-facing response, error text, or timing differs based on match
existence. Separation-of-duties: requester ≠ approver enforced in the backend for identity approval,
Found correction, and False Match. Integration: duplicate matching runs create one Match and one
alert; approved actual-time correction creates no duplicate alert and shifts no timestamp.

---

### Phase 19 — Operation Dashboard & SMS

**Scope.** Explicit Operation permissions; mutually exclusive KPI partition over provisioned hotels;
separate `Идэвхжээгүй` application queue; 13-column subscription list with masked email; combined
server-side filters; password-reset initiation without token visibility; offline ownership recovery
handoff; subscription contact change with old+new phone OTP and Platform Super Admin exception;
subscription suspension without pausing expiry; paid reconciliation queue; provisioning and eBarimt
retry; manual-only SMS with preview, dedup, segment/cost estimate, one-way delivery status.

**Gates.** KPI partition sums to total; package counts sum to total; card click applies the exact
filter. Integration: no scheduler or state transition can auto-send SMS; duplicate confirm sends one
message per number.

---

### Phase 20 — Portal hardening

**Scope.** Five portals wired to real APIs, server-enforced navigation, Mongolian copy from the
requirement docs, responsive Cleaner dashboard (mobile-first), grace-period banners, hard-lock
screens, no business rules in web code.

**Gates.** Playwright per-portal flows; a lint/architecture test asserting web packages import only
`contracts` types and never `db`, `authz` internals, or module services.

---

### Phase 21 — Cross-cutting E2E, concurrency, security & release gate

**Scope.** Full-journey Playwright suites; fresh-migration and upgrade-migration verification;
concurrency suite consolidation; secret-leakage scanner over logs/traces/audit/outbox/fixtures;
`security-review` pass; external gate review; final traceability reconciliation.

**Gates.** All prior phase gates re-run green; upgrade migration from Phase 01 baseline to head;
zero findings in the secret-leakage scan; every DEC ID in traceability marked covered or explicitly
deferred with a recorded reason.

---

## 4. Standing test-gate policy

Every phase from 02 onward runs, at minimum:

| Gate | Command |
| --- | --- |
| Types | `pnpm -w typecheck` |
| Lint + boundaries | `pnpm -w lint` |
| Unit | `pnpm -w test:unit` |
| Integration (real Postgres) | `pnpm -w test:integration` |
| Concurrency (real Postgres) | `pnpm -w test:concurrency` |
| Migrations fresh + upgrade | `pnpm -w test:migrations` |
| E2E (portal phases) | `pnpm -w test:e2e` |

Mocked repositories and SQLite are not acceptable substitutes for integration or concurrency gates.

---

## 5. Sequencing constraints

- Phase 02 must precede every domain phase: no module ships its own authorization, audit, outbox,
  money, or time logic.
- Phase 03 must precede any phase touching money or messaging: no domain code may call a provider
  SDK directly.
- Phase 09 (cash/shift) must precede Phase 11 (deposit) and Phase 14 (financial reporting).
- Phase 07 must precede Phase 08; Phase 08 must precede Phase 12.
- Phase 10 must precede Phases 12, 13, 15, and 18.
- Phase 18 consumes only minimal check-in events emitted by Phase 10 through the outbox.
