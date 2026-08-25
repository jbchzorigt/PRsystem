# PRsystem — MVP Build Plan

**Version:** 1.1
**Created:** Phase 00 · **Revised:** Phase 00 repair (aligned to the approved 23-phase structure)
**Baseline:** [docs/00-mvp-open-decisions.md](../00-mvp-open-decisions.md) … [docs/26-room-minibar-lifecycle.md](../26-room-minibar-lifecycle.md) (immutable)
**Branch:** `claude/mvp-implementation`

Phase numbering, titles and ordering in this document are **approved and fixed**. No phase may be
dropped, merged, renumbered or reordered. Phases run strictly in order; `STOP` after every phase.

---

## 1. Deployment shape

One modular-monolith **API** deployment and one **worker** deployment, plus five Next.js App Router
portals.

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

## 2. External adapter policy

Full external adapter implementation belongs to **Phase 20 — External adapters**.

Earlier phases may define a **typed provider port plus a deterministic simulator** only where the
phase cannot be built or gated without it. Those phases must not implement production credentials,
production endpoints, signature schemes, or live network calls. Every production adapter stays
disabled by configuration and fails closed until Phase 20 (CLAUDE.md §9).

Phases permitted to define ports early, and the minimum surface each may define:

| Phase | Port | Reason it cannot be deferred |
| --- | --- | --- |
| 05 | payment gateway, eBarimt, email | Payment-gated provisioning and receipt fallback are the phase's core state machine |
| 08 | XYP identity | Check-in identity provenance (`XYP_VERIFIED` vs `MANUAL`) is a stored field |
| 10 | payment gateway, POS reference | Deposit receipt/refund channels define the deposit aggregate |
| 12 | e-Mongolia, phone OTP, geo | Guest authentication and discovery have no other entry path |
| 14 | payment gateway | Hold/capture/refund/settlement races are the phase's gates |
| 15 | payment gateway (restaurant merchant) | Restaurant order confirmation depends on provider success |
| 18 | SMS | Match alert delivery and escalation records |
| 19 | SMS, email | Reminder job and reset initiation records |

---

## 3. Approved phase table

| # | Phase | Requirement inputs | DECs |
| --- | --- | --- | ---: |
| 01 | Architecture and threat model | 00–26 | 0 |
| 02 | Monorepo scaffold | 01 | 0 |
| 03 | Platform kernel | 18, 19, 17 | 0 |
| 04 | IAM, tenancy, RBAC, and staff lifecycle | 18, 19 | 26 |
| 05 | Hotel onboarding and subscription | 15, 16, 17, 14 | 26 |
| 06 | Hotel, room, category, and tariffs | 07, 05, 26 | 11 |
| 07 | Minibar inventory and templates | 22, 26, 07 | 36 |
| 08 | Availability, guest identity, reception, and stay | 05, 06, 02, 25 | 19 |
| 09 | Cleaner and checkout coordination | 04, 21, 25, 02 | 18 |
| 10 | Folio, deposit, payment, and correction | 20, 02 | 15 |
| 11 | Shift, cash drawer, expense, and hotel finance | 03, 24, 23, 02 | 20 |
| 12 | Public discovery and Guest authentication | 09 | 2 |
| 13 | Online booking and inventory hold | 09, 11, 02 | 7 |
| 14 | Online payment, refund, commission, and settlement | 11, 09 | 11 |
| 15 | Restaurant | 08, 02 | 19 |
| 16 | Verified reviews | 10, 09 | 11 |
| 17 | Guest registry, exports, and Hotel Admin reports | 12, 23, 02 | 19 |
| 18 | Police monitoring | 13, 02 | 23 |
| 19 | Platform Operation | 14 | 16 |
| 20 | External adapters | 00 §4, 08, 09, 11, 13, 14, 16 | 0 |
| 21 | Responsive UI and accessibility | 02, 04, 06, 09, 13, 14 | 0 |
| 22 | Security, concurrency, recovery, and full E2E | all | 0 |
| 23 | Release candidate audit | all | 0 |

Total assigned decisions: **279**.

---

## 4. Phase detail

### Phase 01 — Architecture and threat model

**Documentation only. No application code, no scaffold, no dependencies.**

**Scope.** Produce `docs/architecture/`: module map and dependency direction for the modular
monolith; canonical data-model overview per bounded context; trust boundaries and the four
authentication realms; STRIDE threat model per realm and per external interface; the authorization
model specification (realm → account/membership → named permission → tenant/resource scope → package
entitlement → account/hotel/subscription state → step-up); money and time invariant specification;
concurrency strategy catalogue (row lock, revision CAS, partial unique index, exclusion constraint,
idempotency key); migration strategy (versioned only, fresh + upgrade); telemetry and log-redaction
policy; test strategy and gate definitions; measurable non-functional targets closing P1-10.

**Gates.** Documentation review against CLAUDE.md §§1–10; every invariant in
[requirements-traceability.md](requirements-traceability.md) §25 has a named enforcement mechanism;
every EXT gate in [external-integration-gates.md](external-integration-gates.md) has a named port
surface.

**Exit.** Architecture and threat model accepted. No code exists yet.

---

### Phase 02 — Monorepo scaffold

**Scope.** pnpm workspace + Turborepo pipeline; TypeScript strict (`strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`); NestJS + Fastify API
skeleton with OpenAPI; worker skeleton with BullMQ; five Next.js App Router shells; Drizzle plus a
versioned migration runner; Postgres and Redis via docker-compose; OpenTelemetry bootstrap with log
redaction; Playwright harness; ESLint module-boundary rule; CI gate script; pinned lockfile.

**Gates.** `pnpm -w typecheck` · `pnpm -w lint` · `pnpm -w build` · `pnpm -w test:migrations`
(fresh) · API health E2E · a boundary-lint fixture proving a cross-module repository import fails.

**Exit.** Empty but wired: every app boots, migrations run fresh, telemetry emits, CI green.

---

### Phase 03 — Platform kernel

**Scope.** Tenancy (`hotel_id` scope propagation); four authentication realms; server-side session
and auth-epoch revocation; the authorization **engine** and permission-catalog structure; package
entitlement gate (20 000₮ / 25 000₮ / 30 000₮); subscription state gate including the 48-hour grace
and hard lock; multi-role permission union; step-up MFA marker; append-only audit log; transactional
outbox plus relay; idempotency key store; `packages/money` (bigint MNT, basis points,
`ROUND_HALF_UP`); `packages/time` (UTC storage, hotel-local resolution, `[start,end)` interval type,
calendar-month and service-month arithmetic with end-of-month clamping).

The kernel provides the mechanisms; the concrete permission matrix rows are encoded in Phase 04.

**Gates.** Unit: engine semantics — union of roles, entitlement gate above role, deny on any failed
condition. Integration (real Postgres): audit append-only constraint, outbox exactly-once relay under
duplicate delivery, idempotency replay returns the prior result. Concurrency: parallel permission
revocation against an in-flight action.

---

### Phase 04 — IAM, tenancy, RBAC, and staff lifecycle

**Decisions.** `RBAC-DEC-001`–`017`, `STAFF-DEC-001`–`009` (26).

**Scope.** The complete named-permission catalog derived from doc 18 §§3, 5, 6 including every
`Нэмэлт role` cell; Hotel Admin never inheriting operational roles; package gate above role;
Operation and Platform Super Admin explicit permissions; Police base matrix; user account versus
hotel/restaurant membership; invitation token lifecycle `ACTIVE → ACCEPTED | SUPERSEDED | EXPIRED |
REVOKED`; one canonical membership per scope and at most one `ACTIVE` invitation enforced by database
constraints; `membership_revision` CAS serialising invite/accept/role-change/suspend/terminate/
reactivate; the scope-targeted session revocation matrix; `TAKEOVER_REQUIRED` Reception shift queue;
Cleaner task reassignment and linked `CONTINUATION` task; Restaurant reassignment; single Primary
Hotel Admin.

**Gates.** Table-driven test asserting every row of doc 18 §§3, 5, 6. Concurrency: suspension
committing against a concurrent invitation accept; two Managers claiming one takeover item; two
Cleaners claiming one task. Integration: password reset revokes all sessions across all memberships;
a package-forbidden role invitation is rejected at the API.

---

### Phase 05 — Hotel onboarding and subscription

**Decisions.** `ONB-DEC-001`–`008`, `SUB-DEC-001`–`009`, `LIFE-DEC-001`–`007`, `OPS-DEC-006`,
`OPS-DEC-007` (26).

**Scope.** Application state machine `DRAFT → OWNER_VERIFICATION_REQUIRED → PENDING_PAYMENT →
PAYMENT_UNCERTAIN/FAILED/EXPIRED → PAID_OWNER_VERIFICATION_REQUIRED → PAID_PENDING_PROVISIONING →
PROVISIONING → PROVISIONED | PROVISIONING_FAILED`; citizen and organization owner types; existing
owner/account proof; payment-gated activation; durable all-or-nothing provisioning transaction
(hotel + owner link + subscription + Primary Hotel Admin membership) with at most five backoff
retries then manual `ONBOARDING_PROVISION_RETRY`; activation link via outbox; the default
`Үндсэн касс` drawer created inside the provisioning transaction; subscription pricing
(monthly × 1/3/7/12, VAT-inclusive, no discounts); subscription start and expiry arithmetic with
end-of-month clamping; renewal inside and after grace; eBarimt issuance plus manual retry queue;
upgrade-only package floor with service-month boundary, incremental second upgrade and
`billing_revision` CAS serialisation; 48-hour grace, hard lock, public listing hide;
`PAID_REQUIRES_RECONCILIATION` queue.

**Ports (simulator only).** payment gateway, eBarimt, email.

**Gates.** Concurrency: duplicate payment callback; two providers paying one intent; late capture on
an expired attempt; boundary worker racing an upgrade callback on one `billing_revision`.
Integration: provisioning failure leaves zero partial entities; email failure does not roll back
provisioning; renewal inside grace extends from the original `expires_at`; renewal after grace starts
at payment confirmation.

---

### Phase 06 — Hotel, room, category, and tariffs

**Decisions.** `RML-DEC-001`–`006`, `STAY-DEC-002`, `STAY-DEC-004`, `STAY-DEC-005`, `STAY-DEC-006`,
`RC-DEC-040` (11).

**Scope.** Room categories; physical rooms with a hotel-scoped unique room number; hourly and nightly
tariff levels (hotel default → category override → room override) resolved independently per stay
type; hotel fixed check-out time; cleaning buffer configuration (hotel default plus category
override); `ACTIVE → RETIRING → INACTIVE` lifecycle for room, category, product and template
entities; hard-delete only for never-used entities; reactivation dependency validation.

**Invariants.** Walk-in resolves `room → category → hotel`; online quote resolves
`category → hotel` and never uses a room override. Server-authoritative rate resolution. The
confirmation snapshot stores unit price, source level, source entity ID and configuration version.
Later tariff edits never reprice a confirmed booking or an active stay. No configurable hourly
minimum, maximum or increment is introduced.

**Gates.** Table-driven precedence and inheritance tests for both stay types; audit assertions on
every tariff create/update/unset; lifecycle blocker tests (active stay, confirmed future booking,
inventory movement); hard-delete rejection for any referenced entity.

---

### Phase 07 — Minibar inventory and templates

**Decisions.** `INV-DEC-001`–`008`, `RML-DEC-007`–`028`, `RC-DEC-011`, `RC-DEC-018`, `RC-DEC-036`,
`RC-DEC-041`, `RC-DEC-042`, `RC-DEC-043` (36).

**Scope.** Products with separate selling price and purchase cost; two stock locations (warehouse and
per-room minibar); immutable typed movement ledger; non-negative balance constraints; continuous
hotel-level weighted average cost with a per-movement cost snapshot; shortage override; template
entity lifecycle separate from version lifecycle `DRAFT → PUBLISHED → ARCHIVED`; immutable published
product list and target quantities; Publish validation (ACTIVE parent, at least one unique same-hotel
ACTIVE product, positive integer targets); first-published-is-Default with a separate atomic
`Set default`; Archive blockers; exact-version room binding (`current_version_id`,
`pending_target_version_id`); room configuration `current + at most one pending`; ON→OFF, OFF→ON and
A→B reconciliation with Cleaner tasks; cancel versus compensating rollback; single-room Rollout;
multi-room Rollout batch with read-only Preview, partial-success Confirm, derived batch state,
`Cancel remaining` and linked `retry_of_batch_id`.

**Gates.** Real-Postgres concurrency: parallel refills against a scarce warehouse balance never go
negative and never over-transfer; a retried transfer posts once; duplicate Confirm with one
idempotency key creates one batch; two Rollouts on one room violate the one-pending invariant.
Integration: Publish, Set default and Archive produce zero pointer, stock, task or blocker side
effects; batch-state derivation table covering all five states.

---

### Phase 08 — Availability, guest identity, reception, and stay

**Decisions.** `STAY-DEC-001`, `STAY-DEC-003`, `STAY-DEC-007`–`014`, `RC-DEC-007`, `RC-DEC-012`–`015`,
`RC-DEC-017`, `RC-DEC-033`, `RC-DEC-044`, `PRICE-DEC-001` (19).

**Scope.** Primary guest identity (`MN_REG_NO`, `FOREIGN_PASSPORT`, `OTHER_GOV_ID`, `NO_DOCUMENT`)
with encrypted identifiers, keyed lookup tokens, guardian metadata and server-derived age; XYP
provenance versus manual fallback; walk-in versus online source and deposit exemption; hourly stays
in 30-minute integer units and nightly stays as `N` calendar nights against a snapshotted fixed
checkout time; `[start_at, end_at)` occupancy; snapshotted cleaning buffer; planned versus actual
readiness anchors; the composite readiness gate (buffer + `Цэвэр` + applicable minibar readiness);
initial `actual_check_in_at` with the 120-minute bounded backdate and historical readiness proof;
immutable `check_in_recorded_at`; active-stay actual-time correction request and approval with the
`self_approved` audit flag; fully locked planned checkout; overdue conflict alert, same-category
reassignment, higher-category approval and `CANCELLED_HOTEL`; minibar stay price book created
atomically at check-in from the exact current published version.

**Ports (simulator only).** XYP identity.

**Gates.** Concurrency: two Receptions checking into one room; check-in racing an overdue conflict
resolution; check-in racing a configuration apply. Integration: backdate is rejected when historical
readiness cannot be proven from immutable events; a correction changes only the effective actual start
and touches no price, payment, cash, configuration, stock or Police timestamp; no API path can mutate
a confirmed `planned_checkout_at`; a minibar-enabled stay cannot activate without a complete price
book.

---

### Phase 09 — Cleaner and checkout coordination

**Decisions.** `CHK-DEC-001`–`006`, `PRICE-DEC-002`–`008`, `RC-DEC-008`, `RC-DEC-010`, `RC-DEC-016`,
`RC-DEC-035`, `RC-DEC-039` (18).

**Scope.** Mobile-first Cleaner work queues; cleaning status authority by package; routine refill from
warehouse; minibar inspection task on checkout initiation; Cleaner report versions; Reception
return-for-correction; Manager/Manager Plus exception report; payment-attempt report-version lock and
pending/unknown reconciliation; post-payment immutable adjustment; guest dispute hold; active-stay
price isolation; the billable-quantity formula with documented refill and non-guest stock-out;
server-authoritative unit price with no override path.

**Gates.** Integration: a current price edit never reprices an active stay; a product absent from the
price book can never be charged; the payment lock is not released while provider status is pending or
unknown; one report version cannot back two successful charges. Concurrency: two Cleaners claiming one
inspection task.

---

### Phase 10 — Folio, deposit, payment, and correction

**Decisions.** `DEP-DEC-001`–`010`, `RC-DEC-001`, `RC-DEC-002`, `RC-DEC-003`, `RC-DEC-004`,
`RC-DEC-006` (15).

**Scope.** One consolidated folio per stay; walk-in-only deposit (50 000–100 000₮) with hotel and
category configuration and an immutable confirmation snapshot; versioned deposit balance aggregate
with reserved amounts; allocation to room/minibar/other lines; original-channel refund;
alternate-channel refund approval; manual POS reference capture; the refund state machine;
authoritative release; `LATE_REFUND_SUCCESS` freeze plus `DEPOSIT_REFUND_RECONCILE` terminal posting
with covered amount and shortfall; immutable financial correction as reversal plus corrected record.

**Ports (simulator only).** payment gateway, POS reference.

**Gates.** Concurrency: parallel allocation and refund reservation on one aggregate; duplicate
approval executes exactly one reversal. Integration: available balance never negative; a released
refund with a late provider success creates exactly one reconciliation case and no second refund;
deposit allocation adds no cash inflow.

---

### Phase 11 — Shift, cash drawer, expense, and hotel finance

**Decisions.** `SHIFT-DEC-001`–`007`, `CASH-DEC-001`–`010`, `FIN-DEC-005`, `RC-DEC-009`,
`RC-DEC-038` (20).

**Scope.** `DRAWER` and `SAFE` locations; one active shift per drawer and one active drawer shift per
Reception account; `INITIAL_FLOAT` from the first actual count; typed immutable movements; the
expected-cash formula and variance; separate operational and financial review states; single-staff
self-close; opening balance from the actual received or counted amount; drawer transfer with locked
source and destination shift IDs, recipient confirmation and cancel-with-recount; drawer↔safe
transfer; bank deposit and owner withdrawal approvals; cash top-up; effective-date-only corrections;
the expense lifecycle `Draft → Submitted → Approved for payment → Paid | Rejected` where approval is
not a cash outflow and only cash-method execution creates `PAID_CASH_EXPENSE`.

**Gates.** Concurrency: two shifts opening on one drawer; a transfer confirmation racing a shift
close. Integration: a shift with a pending transfer cannot close; a correction never rewrites a closed
shift; card/POS and bank/QPay expense payments produce no drawer movement; only `Paid` expenses enter
cash outflow.

---

### Phase 12 — Public discovery and Guest authentication

**Decisions.** `BK-DEC-001`, `BK-DEC-002` (2).

**Scope.** Public hotel search by date, manually chosen location and consented current position;
listing visibility conditions; server-computed distance and ordering; e-Mongolia authentication and
phone-OTP registration with user-chosen password; account, booker and staying-guest separation;
duplicate-account protection with dual-channel verification before linking.

**Ports (simulator only).** e-Mongolia, phone OTP, geo.

**Gates.** Integration: client-supplied distance is never trusted; unauthenticated precise
coordinates are never persisted to a profile; login error responses do not disclose whether a phone
number is registered; tokens never appear in URLs or logs.

---

### Phase 13 — Online booking and inventory hold

**Decisions.** `BK-DEC-009`, `BK-DEC-012`, `BK-DEC-013`, `BK-DEC-014`, `PAY-DEC-002`, `PAY-DEC-006`,
`RC-DEC-005` (7).

**Scope.** MVP booking shape (`1 booking = 1 category room = 1 primary staying guest`, nightly only);
category inventory availability derived from eligible ACTIVE rooms minus overlapping holds, confirmed
bookings and active stays; the 10-minute payment hold with `hold_expires_at`; a single active payment
attempt with `SUPERSEDED` on provider switch; hold expiry versus callback resolved under one row lock;
late and duplicate capture creating a refund obligation without reopening the booking; physical room
assignment at check-in; hotel-caused fulfilment failure remedies.

**Gates.** Concurrency: two guests paying for the last unit of a category; expiry racing a paid
callback. Integration: an expired booking never reopens and never re-occupies inventory; terminal
transitions release inventory immediately.

---

### Phase 14 — Online payment, refund, commission, and settlement

**Decisions.** `BK-DEC-003`, `BK-DEC-008`, `BK-DEC-010`, `BK-DEC-011`, `PAY-DEC-001`, `PAY-DEC-003`,
`PAY-DEC-004`, `PAY-DEC-005`, `PAY-DEC-007`, `PAY-DEC-008`, `PAY-DEC-009` (11).

**Scope.** Payments routed to the platform account; QPay and Khaan Bank behind one provider-adapter
contract; server-verified provider result as the only payment authority; cancellation at the 24-hour
boundary and no-show after the arrival-date 23:59:59 cutoff; first-night fee retention; per-contract
commission stored in integer basis points with a single `ROUND_HALF_UP`; commission base zero on full
refund and hotel-caused cancellation; provider fee as a platform expense never deducted from hotel
payout; immutable ledger events for payment, commission, hotel payable, provider fee, refund,
adjustment and payout; `D+1 12:00 Asia/Ulaanbaatar` payout batching; `HELD` on non-terminal
reconciliation; `ADJUSTMENT_DUE` negative adjustments.

**Ports (simulator only).** payment gateway.

**Gates.** Integration: commission base is zero on full refund; each payout batch reconciles gross,
retained fee, refund, commission, adjustment and hotel payable; one booking payable enters exactly one
successful payout. Concurrency: duplicate refund callback posts once.

---

### Phase 15 — Restaurant

**Decisions.** `REST-DEC-001`–`006`, `RC-DEC-019`–`031` (19).

**Scope.** 30 000₮-only restaurant registration by Manager Plus; active state held on the
hotel–restaurant link; weekly and overnight ordering schedules; menu management; room QR plus
one-time guest access code with at most five concurrent sessions per stay; seven separate state axes
(order, fulfillment, payment, refund policy, refund request, refund, handoff); the restaurant's own
QPay merchant with no platform settlement; acceptance versus refund-request race resolved under a row
lock; 5/10/30-minute SLAs; 15/30/45/60-minute ETA; checkout handoff options; closing and late-payment
mandatory refund queue.

**Ports (simulator only).** payment gateway (restaurant merchant).

**Gates.** Race test: accept and refund request committing simultaneously — the first valid
transition wins. Integration: restaurant money never enters hotel checkout, deposit, cash drawer or
shift totals; invoice validity never exceeds the day's ordering close; a code cannot create a sixth
concurrent session.

---

### Phase 16 — Verified reviews

**Decisions.** `RV-DEC-001`–`007`, `BK-DEC-004`, `BK-DEC-005`, `BK-DEC-006`, `BK-DEC-007` (11).

**Scope.** Verified-stay eligibility with one review per completed booking; 1–5 integer rating;
10–1000 character comment; a 30-day window from `actual_checkout_at`; owner edit and soft-delete;
authenticated guest report with one open report per account and review; `REVIEW_MODERATE` hide and
restore with mandatory reason; one official hotel reply per review under the package rules; aggregate
recomputation on hide, restore and soft-delete.

**Gates.** Database uniqueness on the review's `booking_id` and the reply's `review_id`; aggregate
correctness after every visibility transition; authorization proving that no hotel, Operation or
Police role name alone grants report or moderation rights.

---

### Phase 17 — Guest registry, exports, and Hotel Admin reports

**Decisions.** `GUEST-DEC-001`–`008`, `FIN-DEC-001`–`004`, `FIN-DEC-006`–`010`, `RC-DEC-032`,
`RC-DEC-037` (19).

**Scope.** Guest registry with the six approved columns, server-side pagination (20/50/100), a
mandatory effective-check-in date range defaulting to 30 days, stay-status/room/name filters and a
DOB-derived age snapshot; background export job with a 10 000-row cap and no partial file; private
storage with a one-hour file TTL and five-minute signed URLs; 365-day retention with
`retention_policy_version` snapshot and legal hold. Hotel Admin financial dashboard: confirmed sales,
received payments, receivables, held deposits, refunds and paid expenses kept separate; minibar gross
profit on weighted-average COGS; inventory purchase and COGS never double deducted; the eleven KPI
cards; 7-day, this-month and custom ranges with a per-metric date basis; top-5 rooms by demand and by
revenue; the four financial Excel exports; effective-date corrections.

**Gates.** Authorization: Reception, Cleaner, Restaurant, Manager, Manager Plus and cross-hotel IDs
denied on the registry, the dashboard, job creation and download. Integration: a result set above
10 000 refuses to start; an expired file returns `EXPIRED`; a re-issued URL does not extend the file
TTL; golden-dataset assertions per KPI and per export column set; a PII-absence assertion on every
financial export.

---

### Phase 18 — Police monitoring

**Decisions.** `POL-DEC-001`–`022`, `RC-DEC-034` (23).

**Scope.** Wanted Person with immutable identity revisions, Wanted Case lifecycle, Match with
`unique(stay_id, wanted_person_id)` and append-only `MatchCaseLink`; exact normalized `MN_REG_NO`
matching only, triggered at `check_in_recorded_at`, consuming a minimal check-in event from the
outbox; no retroactive matching of checked-out stays; two-person manual identity approval; case
lifecycle permissions; acknowledgement without ownership; Found confirmation by any active officer;
two-person Found correction and False Match workflows; alert routing by hotel district with Police
Admin fallback; SMS carrying only the full registration number; the Police Admin check-in list with a
31-day historical window, mandatory search reason and no bulk export; Wanted Case Excel with masked
identifiers by default; 4-digit bootstrap hardening; step-up MFA for high-risk actions.

**Ports (simulator only).** SMS.

**Gates.** Isolation: no hotel-facing response, error text or timing differs based on match
existence. Separation of duties: requester ≠ approver enforced in the backend for identity approval,
Found correction and False Match. Integration: duplicate matching runs create one Match and one alert;
an approved actual-time correction creates no duplicate alert and shifts no timestamp; escalation
timer and historical search stay disabled without approved configuration.

---

### Phase 19 — Platform Operation

**Decisions.** `OPS-DEC-001`–`005`, `OPS-DEC-008`–`018` (16).

**Scope.** Explicit Operation permissions with named accounts and step-up MFA; the mutually exclusive
KPI partition over provisioned hotels; the separate `Идэвхжээгүй` onboarding application queue; the
13-column subscription list with masked email and expiry-ascending default order; combined
server-side filters; password-reset initiation without token visibility; offline ownership-recovery
handoff; subscription contact change with old and new phone OTP plus the Platform Super Admin
exception; subscription suspension that never pauses expiry; the paid reconciliation queue with
terminal outcomes; provisioning and eBarimt retry; manual-only SMS with preview, deduplication,
segment and cost estimation, and one-way delivery status.

**Ports (simulator only).** SMS, email.

**Gates.** The KPI partition sums to the total and the package counts sum to the total; a card click
applies the exact filter. Integration: no scheduler or state transition can auto-send SMS; a duplicate
confirm sends one message per number; Operation cannot read a token, a password or an unmasked email.

---

### Phase 20 — External adapters

**Scope.** Production adapters for all eleven external systems: QPay, Khaan Bank gateway and POS,
XYP/HUR, e-Mongolia, eBarimt, CallPro, Google Maps, email and S3-compatible object storage. Real
signature verification, credential handling through secret storage, IP allowlisting, rate and
throughput limits, provider status reconciliation jobs, and per-environment configuration. Each
adapter is enabled only when its gate in [external-integration-gates.md](external-integration-gates.md)
records the named contract, credential or written approval.

**Gates.** Adapter conformance against the same suite the simulators pass: duplicate, out-of-order,
delayed, expired, mismatched-amount, mismatched-currency, bad-signature and timeout-then-late-success.
A disabled adapter refuses to run and emits a gate error. No secret appears in logs, traces, audit or
outbox payloads.

**Exit.** Every adapter either enabled with its gate cleared, or explicitly recorded as still blocked.

---

### Phase 21 — Responsive UI and accessibility

**Scope.** Five portals wired to real APIs with server-enforced navigation; Mongolian copy taken from
the requirement documents; mobile-first Cleaner dashboard usable without horizontal scrolling;
responsive public search and booking on phone and laptop; grace-period banners and hard-lock screens;
keyboard navigation, focus management, colour contrast and screen-reader labelling; no business rules
in web code.

**Gates.** Playwright per-portal flows at mobile, tablet and desktop viewports; automated
accessibility scan on every primary screen; an architecture test asserting that web packages import
only `contracts` types and never `db`, `authz` internals or module services.

---

### Phase 22 — Security, concurrency, recovery, and full E2E

**Scope.** Consolidated concurrency suite across every money and lifecycle command; full-journey
Playwright suites spanning onboarding through checkout, booking through settlement, and check-in
through Police alert; fresh-migration and upgrade-migration verification from the Phase 02 baseline to
head; backup, restore and disaster-recovery rehearsal; secret-leakage scanner over logs, traces,
audit records, outbox payloads, fixtures and seeds; the `security-review` pass; threat-model
re-verification against Phase 01.

**Gates.** All prior phase gates re-run green; upgrade migration succeeds; zero findings in the
secret-leakage scan; recovery rehearsal meets the Phase 01 RPO/RTO targets.

---

### Phase 23 — Release candidate audit

**Scope.** Final reconciliation of [requirements-traceability.md](requirements-traceability.md):
every one of the 279 decisions marked `COVERED` or explicitly `DEFERRED` with a recorded reason and
approver. Final review of [external-integration-gates.md](external-integration-gates.md): every EXT
gate either cleared with its named artefact or reported as a production release blocker. Confirmation
that the three Police production security exceptions are approved or that their fallbacks are active.
P1 configuration register signed off. Release notes, runbook and rollback plan.

**Gates.** Governance validation passes; traceability shows zero `PENDING`; no unresolved requirement
conflict; the release decision is reported to the customer, not taken unilaterally.

---

## 5. Standing test-gate policy

Every phase from 03 onward runs, at minimum:

| Gate | Command |
| --- | --- |
| Types | `pnpm -w typecheck` |
| Lint + boundaries | `pnpm -w lint` |
| Unit | `pnpm -w test:unit` |
| Integration (real Postgres) | `pnpm -w test:integration` |
| Concurrency (real Postgres) | `pnpm -w test:concurrency` |
| Migrations fresh + upgrade | `pnpm -w test:migrations` |
| E2E (portal-facing phases) | `pnpm -w test:e2e` |
| Governance | `node tools/validate-governance.mjs` |

Phases 01 and 02 run only the gates that exist at that point, as listed in their phase detail. Mocked
repositories and SQLite are never acceptable substitutes for the integration or concurrency gates.

---

## 6. Sequencing constraints

- Phase 01 precedes all implementation; no code is written before the architecture and threat model
  are accepted.
- Phase 03 must precede every domain phase: no module ships its own authorization, audit, outbox,
  money or time logic.
- Phase 04 must precede Phase 05: provisioning creates a Primary Hotel Admin membership.
- Phase 06 must precede Phase 07; Phase 07 must precede Phase 08.
- Phase 08 must precede Phases 09, 13, 17 and 18.
- Phase 10 must precede Phase 11 for expense payment execution, and Phase 11 must precede Phase 17.
- Phase 12 must precede Phase 13; Phase 13 must precede Phase 14.
- Phase 16 depends on completed stays from Phase 08 and bookings from Phase 13.
- Phase 18 consumes only minimal check-in events emitted by Phase 08 through the outbox.
- Phase 20 may be entered only after every dependent port and simulator exists.
- Phases 21–23 close the release and may not be reordered.
