# PRsystem — Release candidate audit (Phase 23)

**Written:** 2026-09-10, on the tree that carries the Phase 22 record (`e2fc068`), as the last
phase of the approved programme ([build-plan.md](build-plan.md) §Phase 23).
**What this document is:** the audit the build plan asks for — the final reconciliation of the
traceability, the final review of every external and internal gate, the state of the three Police
production security exceptions, the P1 configuration register presented for sign-off, the
per-target non-functional report, and the release decision **returned to the customer**.
**What it is not:** a release approval, a customer acceptance, a gate cleared, or a P1 item closed.
None of those is this phase's to give (CLAUDE.md §11; build-plan §Phase 23).

---

## 0. The finding in one paragraph

Every one of the 279 canonical decisions is implemented and gated (`COVERED`), none is `PENDING`,
`PARTIAL` or `DEFERRED`, no requirement conflict is open, and the governed battery is green on the
measured tree. The candidate is nevertheless **not deployable to production as it stands**, for
reasons that are contractual and legal rather than engineering: all eleven `EXT` gates and all four
internal gates are `BLOCKED` with no artefact, so every external adapter is disabled and fails
closed; and because `INT-KMS-01` is among them, a production API or worker **refuses to start** —
there is no approved key-management adapter, and identifier storage that cannot be encrypted is not
allowed to run. The three Police security exceptions are implemented as decided and approved by
nobody; their fallbacks are not active. All 17 P1 items are pending the customer's decision. Two
non-functional targets were measured short, five could not be measured. **The release decision is
the customer's**; §9 lists exactly what would have to be true for a production release, and none of
it is a code change this programme can make on its own.

---

## 1. Traceability reconciliation

| Measure | Value | Source |
| --- | --- | --- |
| Canonical decisions | 279 across 22 families | [requirements-traceability.md](requirements-traceability.md) v1.36 |
| `COVERED` | 279 | every row carries code and test references appended by its owning phase |
| `PENDING` | 0 | governance check 3 and this audit |
| `PARTIAL` | 0 | — |
| `DEFERRED` | 0 | no decision is deferred; deferred *scope* is listed separately (below) |
| Phases owning zero decisions | 01, 02, 03, 20, 21, 22, 23 | each with obligation rows in §2.1 of the traceability |

**Method.** `node tools/validate-governance.mjs` checks 1–3, 6 and 11 (every source document
represented, every DEC unique, assigned to exactly one phase in 01..23, mapped to defined controls
and gates), plus a count of the status column of every family table (§3–§24) on this tree: 279
`COVERED`, nothing else. Each `COVERED` row was set by the phase that owns the decision, on a
battery that passed, and every one of those batteries is recorded in `phase-NN-evidence.json` and
`phase-NN-battery-log.md`.

**Explicitly deferred scope, with its source.** No DEC is marked `DEFERRED`, because the deferrals
the requirements make are scope statements rather than decisions: doc 00 §5 and the module
documents defer restaurant add-ons and limits beyond P1-06, scheduled SMS campaigns and a two-way
inbox, hotel account recovery without the registered email, Police Admin bulk export of the
check-in list, co-occupant registration, merging restaurant payments into the hotel checkout, the
nightly early-morning cutoff, retroactive Police matching (`POL-DEC-017`), any change to a
`planned_checkout_at` (`STAY-DEC-012`), package downgrade (`LIFE-DEC-001`), subscription refunds
(`SUB-DEC-009`) and relocation or compensation for hotel-caused overbooking (`BK-DEC-014`). They are
recorded in [assumptions-and-conflicts.md](assumptions-and-conflicts.md) §5 so that no phase
implements them by accident; each has the requirement document as its approver. Nothing was
deferred by a phase's own decision.

**Approver.** The reconciliation is the audit's; the *acceptance* of the coverage is the
customer's and is recorded nowhere yet: Phases 06 to 22 are `DONE` and
`AWAITING_CUSTOMER_ACCEPTANCE`, and this phase does not change that
([phase-status.md](phase-status.md) current position).

**Open requirement conflicts.** None. [assumptions-and-conflicts.md](assumptions-and-conflicts.md)
§1 records zero open P0 conflicts; §2 records the drift resolutions (D-01 to D-09) each with its
precedence reading, of which D-09 is customer-approved.

---

## 2. External gates — final review

[external-integration-gates.md](external-integration-gates.md) v1.3 is the register; the same
statuses are declared in `packages/ports/src/gates.ts` (`GATE_REGISTER`) and seeded into
`platform.external_gate` / `platform.internal_gate`, and a test fails if any two disagree. Clearing
a gate needs a named artefact — a contract, a credential or a written approval — and there is none.
**Every gate is reported as a production release blocker.**

| Gate | System | What the candidate does in production while it is blocked | Would be cleared by |
| --- | --- | --- | --- |
| EXT-01 | XYP / ХУР | check-in identity is entered manually with `MANUAL` provenance; a Wanted record cannot be ХУР-sourced | the service contract, field list, consent basis and network access |
| EXT-02 | e-Mongolia | the guest portal shows the e-Mongolia sign-in as not yet open; registration is by phone (which is itself behind INT-OTP-01) | the integration agreement and sandbox access |
| EXT-03 | QPay | no online payment can be initiated; a provider-dependent command answers `PRECONDITION_FAILED` with the payment-unavailable outcome (`PAYMENT_UNAVAILABLE … (DISABLED)`); the gate id is retained in the internal port result and is not exposed in the HTTP error message | the merchant contract, callback signature rule and credentials |
| EXT-04 | Khaan Bank | as EXT-03 for the gateway; manual POS reference capture at Reception continues (it is not an integration) | the gateway and POS contracts and credentials |
| EXT-05 | CallPro | a confirmed SMS job records every recipient `FAILED` with the gate as reason; nothing is sent; the Police Match alert is raised in-app only | the agreement: endpoint, authentication, allowlist, segment billing, tariff |
| EXT-06 | Google Maps | no geocoding; hotel coordinates must be entered; distance ordering still works server-side | the API selection, billing account and key restrictions |
| EXT-07 | Platform central account | the settlement ledger is computed; no payout batch is executed | the settlement contract, payment-service authorization, the bank transfer API |
| EXT-08 | Personal data | guest retention runs on the 365-day product default; no privacy notice or consent text exists to show | the written notice, consent, role definitions and breach procedure |
| EXT-09 | ЦЕГ | the escalation timer and the historical check-in search are disabled (no approved configuration row) | the written legal basis, the appointment procedure and the approved configuration |
| EXT-10 | Police security | see §3: three exceptions unapproved; no penetration test; no impact assessment | the assessment, the penetration test with the Police realm in scope, the written exception approvals |
| EXT-11 | eBarimt | no receipt is issued; every confirmed subscription payment lands in the manual eBarimt retry queue and stays there | the issuer contract, API credentials and tax authority approval |

**Internal gates** (`packages/ports/src/gates.ts`, register §4):

| Gate | Effect in production while blocked | Would be cleared by |
| --- | --- | --- |
| INT-KMS-01 | **the API and the worker refuse to start.** `KMS_ADAPTER` defaults to `none`, which `selectKeyManagement` answers with `no approved key management adapter is configured (INT-KMS-01 is not cleared)`; `local` is refused outside local, CI and test. This is the only gate that stops the process rather than a feature, and it is the first blocker on any deployment path | an approved production KMS, its adapter written and conformance-tested, and a `CLEARED` entry |
| INT-MAIL-01 | activation, invitation, reset and eBarimt delivery emails are not sent; the six messages have no approved wording | a contracted provider, its delivery-status semantics and approved copy |
| INT-OTP-01 | phone registration and the onboarding OTP cannot complete; no guest can register and no hotel can apply | an OTP provider contract |
| INT-STORAGE-01 | exports fail closed with a recorded reason; the `s3` adapter exists and is tested but has no production bucket or credential | a production bucket, region, credential and `ADAPTER_STORAGE=s3` |

**Consequence for a staged rollout.** Even a deployment intended to run with every provider off —
cash and manual POS at Reception, walk-in stays, minibar, cleaning, shifts, finance — needs
`INT-KMS-01` cleared first, and cannot onboard a hotel without `INT-OTP-01` and `INT-MAIL-01`.
Nothing in this candidate can be switched on by configuration alone; each gate clears through a
document change, a code change and a migration (register §5), reviewed.

---

## 3. The three Police production security exceptions

The build plan asks for confirmation that they are approved **or** that their fallbacks are active.
Neither is true, and this audit says so rather than choosing.

| Exception | Decision | How the candidate behaves | Written ЦЕГ approval | Fallback | Fallback active? |
| --- | --- | --- | --- | --- | --- |
| Four-digit activation and reset bootstrap code | `POL-DEC-022` | four digits (`randomInt(0, 10 000)`), five minutes, one use, three attempts, a thirty-minute lock, a minute between resends, three an hour and five a day, keyed digest, generic answer — every compensating control doc 13 §5.3 names | **none** | a six-digit or longer code, or an approved SSO bootstrap | **no** — the length is not configuration; changing it is a code change with its own gates |
| Full registration number in the Match SMS | `POL-DEC-009` | the body is one approved sentence and the full number; the delivery row keeps a four-digit mask; the body is dropped after the call. **Nothing is sent** while EXT-05 is blocked | **none** | an alert without the identifier; portal-only detail | **no** — and moot in production until EXT-05 clears, because the adapter is disabled |
| Full registration number in the Police Admin check-in list | `POL-DEC-010` | unmasked for the Police Admin only, masked for every other role; the historical search is disabled until EXT-09's retention row exists | **none** | a masked identifier | **no** — the Police Admin's unmasked view is the decision as written |

**What contains them today.** The Police realm is a deployment capability, off by default:
`POLICE_ENABLED` is read as `true` only when set to exactly that, and an API that does not serve
the Police portal has no Police module and no Police credential (`A-P18-8`). A production deployment
that leaves it unset carries none of the three surfaces. Enabling it is the customer's decision and
should follow, not precede, the written approvals under EXT-09 and EXT-10.

**What this audit does not do.** It does not implement the fallbacks. Each would be a behaviour
change to a decided requirement (`POL-DEC-009`, `-010`, `-022`), so it belongs to the customer's
choice between approval and fallback, and then to a change with its own battery — not to an audit
phase choosing on the customer's behalf (`A-P23-2`).

---

## 4. P1 configuration register — presented for sign-off

[assumptions-and-conflicts.md](assumptions-and-conflicts.md) §4 is the register: **17 total · 17
pending · 0 closed.** Each item runs on the interim default its owning phase implemented as
versioned configuration or code, and each stays open until the customer adopts or replaces the
default. The sheet below is what the customer signs; the audit fills in what exists and leaves the
last column empty, because a phase cannot sign for the customer (`A-P23-1`).

| P1 | Item | Interim default in the candidate | Where it lives | Customer sign-off |
| --- | --- | --- | --- | --- |
| P1-01 | Nearby radius and default sort | 5 km; availability first, then distance; distance computed server-side without a provider | `apps/api/src/modules/public` (Phase 12, `A-P12-6`) | pending |
| P1-02 | Guest OTP TTL, resend and lockout | 5-minute TTL, 60-second resend, 5 attempts, per-phone and per-IP limits | `apps/api/src/modules/guest` (Phase 12); delivery itself behind INT-OTP-01 | pending |
| P1-03 | Booking notification channels | in-app plus SMS to the verified phone; SMS behind EXT-05 | `apps/api/src/modules/booking` (Phase 13) | pending |
| P1-04 | Public listing minimum completeness | required-field checklist, preview, explicit publish action | `apps/api/src/modules/catalog`, `modules/public` (Phase 12) | pending |
| P1-05 | Platform support access to guest data | no automatic access; incident-approval flow deferred | no such route exists (Phase 17) | pending |
| P1-06 | Restaurant menu detail | item active or sold-out, quantity, note; add-ons deferred | `apps/api/src/modules/restaurant` (Phase 15) | pending |
| P1-07 | SMS job cap, retry, retention, masking | conservative cap and retry; body never stored or logged; masked recipient in history | `apps/api/src/modules/operation` (Phase 19, `A-P19-8`) | pending |
| P1-08 | Police alert escalation minutes, routing, metrics | disabled without an approved ЦЕГ configuration row (EXT-09) | `apps/api/src/modules/police` (Phase 18) | pending |
| P1-09 | Retention for non-guest data classes | guest PII 365 days from `actual_checkout_at`, versioned, with legal hold; audit, review, order, payment and SMS matrix not yet decided | `apps/api/src/modules/reporting` retention (Phase 17, `GUEST-DEC-008`) | pending |
| P1-10 | Non-functional targets | every value `PROVISIONAL_ARCHITECTURE_DEFAULT`; measured in Phase 22; reported in §6 below | [15-non-functional-targets.md](../architecture/15-non-functional-targets.md) | pending — a DEC adopting the values, or different ones |
| P1-11 | Receipt and tax beyond the subscription eBarimt | ledger tax fields present; `taxConfigVersion = p1-provisional-tax-2026-08` stamped on every quote and payment; receipts and VAT numbering not built | `apps/api/src/modules/onboarding`, `modules/billing` (Phases 05, 17) | pending |
| P1-12 | Audit viewer, filters, retention, alerts | per-module audit taxonomy in place; central viewer not built | `audit` schema; each module's audit actions (Phase 22 review) | pending |
| P1-13 | Restaurant invitation, OTP and guest access TTLs | one security configuration table with conservative values | `apps/api/src/modules/restaurant` (Phase 15) | pending |
| P1-14 | Review UX and display-name masking | review opened from the completed booking; first letter plus mask | `apps/api/src/modules/review`, `apps/web-public` (Phase 16) | pending |
| P1-15 | Operation reset token TTL and email provider | 30-minute single-use link, previous tokens invalidated; provider behind INT-MAIL-01 | `apps/api/src/modules/operation` (Phase 19) | pending |
| P1-17 | Guest access code length, TTL, lockout | six digits, valid until checkout, rate-limited, hashed | `apps/api/src/modules/restaurant` (Phase 15) | pending |
| P1-19 | Cleaner queue atomic claim and SLA | one current assignee with a version lock; automatic timeout and escalation deferred | `apps/api/src/modules/stay` cleaner queue (Phase 09) | pending |

Signing a row adopts its interim default as the product value or names the replacement; the
replacement is then a configuration change for the items held as configuration and a gated change
for the rest. **P1-10 is different in kind:** it is not a default to adopt but a set of targets, and
§6 reports which the candidate meets.

---

## 5. Security posture at the candidate

- **The battery.** Twenty `GATE-SEC` sub-gates, three runs each, green on every phase's measured
  tree; the last on `4575f8d` (Phase 22). `SEC-ADAPTERS` proves every production adapter answers
  `DISABLED` and makes no network call.
- **Secret leakage.** `tools/scan-secrets.mjs` over the tree: 0 findings. The runtime scan
  (`e2e/leakage.spec.ts`): 81 canaries across every platform, police and audit table, the API log
  and every Redis key of a full run — 0 findings.
- **Threat model.** Re-verified in Phase 22 realm by realm against the code
  ([phase-22-security-review.md](phase-22-security-review.md)); every boundary tested over real HTTP
  and real PostgreSQL.
- **Dependencies.** `pnpm run audit:prod` clean; `pnpm run audit:tree` three moderate, all `DSR-01`
  and `DSR-02` — dev-only, contained, reviewed on their due phase, still open
  ([dependency-security-register.md](dependency-security-register.md) v1.2). Zero Critical or High
  — the doc 15 §8 target is met.
- **Headers.** Every API answer and every portal page carries the security headers and a content
  security policy; the portal policy still admits inline script until a nonce is threaded through
  the shell (`A-P22-9`) — a hardening item, not a leak.
- **Not done, and named:** no general request rate limiter (`A-P22-6`); no penetration test
  (EXT-10); TLS and HSTS are the edge's and were not measured; Chromium profiles only.

---

## 6. Non-functional targets — achieved or not, per target

Every value in [15-non-functional-targets.md](../architecture/15-non-functional-targets.md) keeps
its `PROVISIONAL_ARCHITECTURE_DEFAULT` status. This section reports, per target, whether the
Phase 22 measurement ([phase-22-measurements.md](phase-22-measurements.md)) achieved it. **A
measurement does not adopt a value: P1-10 stays open until a DEC adopts these numbers or others.**
Conditions: one developer machine, one API process, the compose stack, every provider a
simulator, no network.

### 6.1 Latency (doc 15 §2)

| Class | Target p50 / p95 / p99 (ms) | Measured p50 / p95 / p99 (ms) | Achieved |
| --- | --- | --- | --- |
| Read, indexed (room board) | 50 / 200 / 500 | 77.6 / 100.9 / 106.8 | **no — p50** (p95, p99 yes) |
| Read, paginated search | 100 / 400 / 800 | 22.4 / 38.3 / 40.8 | yes |
| Public search | 150 / 600 / 1 200 | 17.6 / 32.3 / 33.6 | yes |
| Command, simple | 100 / 300 / 700 | 26.3 / 34.9 / 40.6 | yes |
| Command, transactional | 200 / 800 / 1 500 | 26.4 / 34.7 / 75.1 | yes |
| Command, provider-dependent (simulator) | 300 / 1 500 / 3 000 | 26.9 / 34.2 / 36.1 | yes — against a simulator; a real provider adds its own latency inside the port's hard timeout |

### 6.2 Asynchronous latency (doc 15 §2.1)

| Path | Target | Measured | Achieved |
| --- | --- | --- | --- |
| Outbox relay lag | p95 < 5 s | not measurable — no consumer runs the relay (`A-P22-7`) | **not measured** |
| Police Match alert, check-in → alert row | p95 < 10 s | 1.1 s, 1.1 s, 1.7 s with a 2 s sweep; the worker default is now 5 s (`A-P22-11`) | yes, at a sweep ≤ 5 s |
| Notification dispatch after commit | p95 < 30 s | within the worker's 2 s sweep in the onboarding journey | yes, at the e2e cadence |
| Guest registry export, 10 000 rows | < 5 min | no 10 000-row fixture | **not measured** |
| Service-month boundary processing | ≤ 15 min | exercised, not timed | **not measured** |

### 6.3 Throughput and capacity (doc 15 §3)

| Metric | Target | Measured | Achieved |
| --- | --- | --- | --- |
| Sustained API requests | 200 rps, headroom to 500 | 145.5 rps on the heaviest read, one process, 0 errors | **no** — one instance; two behind a balancer or the board query tuned is what would meet it (`A-P22-8`) |
| Concurrent authenticated sessions | 1 000 | not measured as such; 32 in flight sustained | **not measured** |
| Worker jobs | 100 / min sustained | not measured | **not measured** |
| Concurrent check-ins on one room | exactly one succeeds | `GATE-CONC`, 97 races × 3 runs on every tree since Phase 08 | yes |
| Export jobs in parallel per hotel | 1 | `reporting.concurrency` | yes |

### 6.4 Availability and degraded modes (doc 15 §4)

| Target | Measured | Achieved |
| --- | --- | --- |
| API 99.5 % / worker 99.0 % monthly | needs a month of a hosted deployment | **not measured** |
| Provider unavailable → fail closed with a clear state | injected: invoice 412, hold intact, retry succeeds | yes |
| XYP unavailable → `MANUAL` provenance | injected: check-in 201, `MANUAL` | yes |
| SMS unavailable → alert raised, delivery retried, failure recorded | injected: job persists with failed and pending deliveries | yes |
| Redis unavailable → limits fail closed, queues stall, effects preserved | injected: ready 503, live 200, reads 200, provisioning waits for the sweep | partly — there is no request rate limiter to fail closed (`A-P22-6`) |
| Object storage unavailable → exports fail cleanly | injected: no `READY` job, nothing downloadable | yes |
| KMS unavailable → fail closed | `SEC-KMS`; and §2 above: the process does not start without one | yes |

### 6.5 Durability and recovery (doc 15 §5) — including RPO and RTO explicitly

| Target | Provisional value | Measured (Phase 22 rehearsal, [recovery-runbook.md](recovery-runbook.md) §2) | Achieved |
| --- | --- | --- | --- |
| **RPO** | ≤ 5 minutes | exposure 25.2 s, bounded by a 30 s archive cadence; restore to end-of-archive and to a point in time both verified row for row | **yes, on one machine** — a hosted deployment must repeat it with its own archive cadence |
| **RTO** | ≤ 4 hours for full service restoration | 1.6 s for the restore itself from a local archive; the runbook budgets the whole procedure inside 4 h but the whole procedure was not timed end to end on hosted infrastructure | **yes for the measured part; the full procedure not measured** |
| Backup retention | 30 days PITR + monthly | the deployment's; not exercised | **not measured** |
| Restore rehearsal | every release cycle | performed once, Phase 22 | yes for this cycle |
| Backup encryption | at rest and in transit | the deployment's; not exercised | **not measured** |

### 6.6 Client support and front-end budgets (doc 15 §6)

| Target | Measured | Achieved |
| --- | --- | --- |
| Last two majors of Chrome, Edge, Firefox, Safari | Chromium only (Desktop Chrome, Pixel 7, Galaxy Tab S4) | **not demonstrated** for Firefox, Safari, Edge |
| Cleaner dashboard on 360 px, no horizontal scroll | 412 px and 768 px with no document overflow; layout fluid below 768 px | **not measured at 360 px** |
| Initial JS, public pages < 250 kB gzipped | 102 kB shared first-load, uncompressed | yes |
| LCP < 2.5 s (4G), INP < 200 ms, CLS < 0.1 | no throttled profile | **not measured** |
| WCAG 2.1 AA | axe-core over every primary screen at three viewports, serious and critical = fail; manual keyboard traversal not repeated | yes for the automated scan |

### 6.7 Localisation and security posture (doc 15 §7, §8)

Localisation: as specified (Phase 21 copy review, the kit's formatters). Security posture: memory-hard
KDF, session and step-up windows as specified; zero Critical or High; zero leakage findings; TLS and
HSTS are the edge's; the penetration test is EXT-10.

### 6.8 Summary for the customer's decision

| Achieved | Not achieved | Not measured |
| --- | --- | --- |
| 5 of 6 latency classes; Police alert latency; notification dispatch; every concurrency capacity rule; 4 of 5 degraded modes fully and 1 partly; RPO and the measured RTO on one machine; the JS budget; the automated accessibility scan; zero Critical/High; zero leakage | room-board p50 (77.6 ms vs 50); single-instance throughput (145.5 vs 200 rps) | outbox relay lag; 10 000-row export; service-month timing; concurrent sessions; worker jobs/min; availability; backup retention and encryption; the full RTO procedure on hosted infrastructure; Firefox/Safari/Edge; 360 px; LCP/INP/CLS |

No number was adjusted. The two shortfalls have a named engineering path (`A-P22-8`); the
unmeasured targets need either a hosted environment or a fixture this programme did not have.

---

## 7. What the governed battery says about the candidate

Every phase from 03 to 22 has a `phase-NN-evidence.json` manifest naming the commit its battery was
measured on, and governance check 17 holds each manifest, the governed state and the phase record
to one another. The last measured tree before this audit is `4575f8d` (Phase 22): 28 executions,
all exit 0 — governance 17/17, 349 drift fixtures caught, unit 1 699, migrations 148 (fresh, the
upgrade paths from the Phase 02 baseline and the accepted Phase 03, 04 and 05 databases, repeat,
schema equality), integration 621, concurrency 97 × 3, regression 51, `GATE-SEC` 20/20 × 3, e2e 130
with the leakage scan at 0, audits clean at high and above. This audit's own tree is measured by the
same battery and recorded in the Phase 23 record of [phase-status.md](phase-status.md).

---

## 8. Release notes, runbook and rollback plan

- [release-notes.md](release-notes.md) — what the candidate contains, module by module, with its
  migrations, known limitations and the deferred scope.
- [release-runbook.md](release-runbook.md) — the deployment procedure for a production environment,
  the configuration it requires, the checks that prove it is up, and the rollback plan (application
  rollback without schema rollback; forward-fix; point-in-time restore).

---

## 9. The release decision — returned to the customer

This audit takes no release decision (build-plan §Phase 23; CLAUDE.md §11). It records that the
engineering exit conditions of the programme are met and that the production entry conditions are
not, and it returns the following to the customer as decisions only they can make:

1. **Acceptance of Phases 06–22**, each `DONE` and `AWAITING_CUSTOMER_ACCEPTANCE`; and of this
   phase once recorded. Acceptance is a change to `tools/programme-state.mjs`, never a document.
2. **The gates.** Which of EXT-01 … EXT-11 and INT-KMS-01, INT-MAIL-01, INT-OTP-01,
   INT-STORAGE-01 will be pursued for a first release, and in what order. A release with none
   cleared is not possible: `INT-KMS-01` stops the process. A minimal Reception-only release needs
   at least `INT-KMS-01`, `INT-OTP-01` and `INT-MAIL-01`.
3. **The Police exceptions.** Written ЦЕГ approval of `POL-DEC-009`, `-010` and `-022` as
   implemented, or a decision to build each fallback — and until then, `POLICE_ENABLED` unset.
4. **The P1 register.** Seventeen signatures on §4, or replacement values.
5. **P1-10.** A DEC adopting the provisional non-functional values or others, in the knowledge of
   §6: two targets short on one instance, and the list of what could not be measured here.
6. **The Phase 23 items with an engineering path**, to be scheduled beyond the approved programme:
   the room-board query and a second API instance (`A-P22-8`), a general rate limiter (`A-P22-6`),
   scheduling the outbox relay (`A-P22-7`), a nonce-based portal script policy (`A-P22-9`), the API
   reads the portals still lack (`A-P21-4`), the domain sweeps (`A-P20-9`) and the SMS refresh
   (`A-P20-5`), and the Firefox and WebKit profiles.
7. **The two checkouts.** The main checkout still holds the superseded Phase 06 draft; reconciling
   it with this branch is the customer's call ([autonomous-checkpoint.md](autonomous-checkpoint.md)).

Nothing was pushed, merged, deployed or configured against a real provider in the course of this
audit or the programme it closes.
