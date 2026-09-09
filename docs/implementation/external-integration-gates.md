# PRsystem — External Integration Gates

**Version:** 1.2 (Phase 20 — the register is code as well as a document; every adapter recorded as
enabled or still blocked, per slot, in §6)
**Source:** [docs/00-mvp-open-decisions.md](../00-mvp-open-decisions.md) §4 (EXT-01 … EXT-11), plus the
module-level production exceptions in docs 13, 14 and 16.

---

## 1. Standing rule

For every external system, if an official contract, credential, signature rule, or production
approval is missing:

1. Do not invent it.
2. Implement a typed port in `packages/ports` plus a deterministic simulator.
3. Keep the production adapter **disabled by configuration** and **fail closed** when invoked.
4. Record the blocker here.

**Full external adapter implementation belongs to Phase 20 — External adapters.** Earlier phases may
define a typed port and a deterministic simulator only where the phase cannot be built or gated
without it; the permitted set is enumerated in [build-plan.md](build-plan.md) §2. "Port phase" below
names the earliest phase permitted to define the port surface; "Adapter phase" is always 20.

**Since Phase 20 the register is read at startup, not only by people.** The same gates, with the
same statuses, are declared in `packages/ports/src/gates.ts` (`GATE_REGISTER`), and every deployment
selects its adapters through `selectAdapters`, which refuses — before a port is bound or Redis is
contacted — a simulator anywhere above test and a production adapter whose gate this register still
records as `BLOCKED`. The three copies of the register — this document, that module and the
`platform.external_gate` / `platform.internal_gate` rows Phase 03 seeds — are held to one another by
tests (`packages/ports/src/gates.test.ts`, `packages/db/src/security/sec-ext-register.test.ts`), so
clearing a gate is a document change, a code change and a migration, and cannot be one of them
alone. §6 records the per-adapter outcome of Phase 20.

A port is *development-ready* when its simulator passes the conformance suite: duplicate,
out-of-order, delayed, expired, mismatched-amount, mismatched-currency, bad-signature, and
timeout-then-late-success callbacks. Development-ready does **not** mean production-ready.

---

## 2. Gate register

| Gate | System | Blocks | Status | Port phase | Adapter phase |
| --- | --- | --- | --- | --- | --- |
| EXT-01 | XYP / ХУР | Identity verification at check-in and Wanted-record creation | **BLOCKED** | 08 | 20 |
| EXT-02 | e-Mongolia | Guest registration and login channel | **BLOCKED** | 12 — canonical port and simulator, conformance-gated | 20 |
| EXT-03 | QPay | Booking, subscription and restaurant payments | **BLOCKED** | 05 — canonical port and simulator, conformance-gated | 20 |
| EXT-04 | Khaan Bank | Booking and subscription gateway, POS | **BLOCKED** | 05 — canonical port and simulator, conformance-gated | 20 |
| EXT-05 | CallPro | Operation SMS reminders and Police Match SMS | **BLOCKED** | 18, 19 — canonical port and simulator, conformance-gated | 20 |
| EXT-06 | Google Maps | Hotel location capture, distance and nearby search | **BLOCKED** | 12 — canonical port and simulator, geocoding gated; distance is server-side and provider-free | 20 |
| EXT-07 | Platform central account | Aggregated guest payments and hotel settlement | **BLOCKED** | 14 — canonical port and simulator, execution gated | 20 |
| EXT-08 | Personal data | Privacy notice, consent, controller and processor roles | **BLOCKED** | 17 — retention policy, snapshot and legal hold implemented; the written basis is still absent | 20 |
| EXT-09 | ЦЕГ (National Police) | Wanted and check-in data sharing legal basis | **BLOCKED** | 18 — the escalation timer and the historical check-in search are configuration rows, and there are none | 20 |
| EXT-10 | Police security | Human-rights and security assessment, DR, penetration test | **BLOCKED** | 18 — the four-digit bootstrap exception and the full-RD SMS both remain unapproved | 20 |
| EXT-11 | eBarimt | Subscription tax receipts | **BLOCKED** | 05 — canonical port and simulator, conformance-gated | 20 |

All eleven gates are **production release gates**. None blocks development in Phases 01–19.

---

## 3. Gate detail

### EXT-01 — XYP / ХУР

**Required before production.** Service list, exact field list, consent and legal basis, contract,
VPN / certificate / static IP, server-location conditions, and the formal outage and manual-fallback
procedure.

**Port surface.** `XypIdentityPort.lookupByRegistrationNumber(normalizedRd) → { found, fields, provenance }`.
**Simulator behaviours.** found · not-found · service-unavailable · timeout · malformed response.
**Fail-closed rule.** On `not-found` or `unavailable` the system records `MANUAL` provenance and never
presents the record as XYP-verified (`RC-DEC-007`, `POL-DEC-001`). Development uses synthetic
registration numbers only (doc 13 §17).

**Consumed by.** Phase 08 (check-in identity), Phase 18 (Wanted identity).

**Implementation status (Phase 08).** `XypIdentityPort` is implemented in `@prsystem/ports`
(`identity-verification.port.ts`) with the deterministic simulator and the `DISABLED` adapter; the
check-in records `XYP_VERIFIED` only on `found` and `MANUAL` otherwise. The gate stays **BLOCKED**:
no contract, field list, consent basis or network access exists, and the production adapter is
Phase 20's once they do.

---

### EXT-02 — e-Mongolia

**Required before production.** Authentication flow, minimum field set, consent, provider subject
identifier, token lifecycle, account-linking conditions, sandbox and production access.

**Port surface.** `EMongoliaAuthPort.begin()`, `.complete(code) → { providerSubject, minimalClaims }`.
**Fail-closed rule.** Tokens and citizen data never appear in URLs, browser logs or application logs
(doc 09 §6.1). Accounts link by provider subject and are never merged automatically with a phone
account without dual-channel verification (doc 09 §6.3).

**Consumed by.** Phase 12.

**Phase 12 status.** `EMongoliaAuthPort` and `SimulatedEMongoliaAuth` ship in `@prsystem/ports`
with the simulator conformance suite; `UnavailableEMongoliaAuth` answers `DISABLED` for both
`begin()` and `complete()` before any network call, and `selectEMongoliaAuth` returns it outside
local, CI and test. The guest module translates a disabled gate and an outage alike into
"e-Mongolia is not available; register by phone", which is doc 09 §6.1's own fallback. The provider
subject is stored only as a keyed token in `lookup.guest_identity_subject`, and nothing links two
accounts without the dual-channel confirmation of doc 09 §6.3. **Still BLOCKED**: no contract,
field list, consent basis, token lifecycle or sandbox access exists, and the production adapter
stays disabled.

---

### EXT-03 — QPay

**Required before production.** Merchant ownership, invoice/payment/refund API contract, callback
verification rule, partial versus full refund capability, timeout and status-query semantics, and
written approval for centralized settlement.

**Reference recorded in the requirements.** QPay Merchant V2 exposes invoice create and cancel,
post-callback payment check, and payment cancel and refund endpoints — but production merchant type,
centralized settlement and per-payment-type refund capability must be confirmed contractually
(doc 11 §12).

**Port surface.** `PaymentGatewayPort`, shared with EXT-04: `createInvoice`, `queryStatus`, `refund`,
`verifyCallback`. The canonical contract lives in `packages/ports` (Phase 05 remediation 1): every
operation answers a typed, non-throwing `PortResult`, the port carries its `id` and `mode`, and
`createInvoice` takes a **caller-supplied idempotency key** so a retry after a lost acknowledgement
recovers the same provider invoice. The `qpay` and `khaan` simulators pass the §3 conformance suite
of the port catalog in `packages/ports/src/conformance.test.ts`; the production adapters answer
`DISABLED` and make no network call. "Port and simulator shipped" is claimed only on that evidence.
**Fail-closed rule.** No screenshot, redirect or client-reported success is ever authoritative
(`PAY-DEC-005`). Late or duplicate capture creates a refund obligation or a reconciliation case, never
an entitlement change (`PAY-DEC-006`, `ONB-DEC-008`, `LIFE-DEC-006`).

**Consumed by.** Phase 05 (subscription), Phase 14 (booking), Phase 15 (restaurant merchant).

---

### EXT-04 — Khaan Bank

**Required before production.** POS terminal registration and online gateway contracts, callback,
refund and reconciliation semantics, reference field definitions, sandbox and production credentials.

**Port surface.** The same `PaymentGatewayPort` contract as QPay (`PAY-DEC-005`, `SUB-DEC-004`), plus
a manual-POS reference capture path that is not an integration (`RC-DEC-006`, `DEP-DEC-005`).
**Fail-closed rule.** Manual POS payments and refunds require a reference or approval code, amount,
timestamp, Reception actor and — for refunds — the original payment reference.

**Consumed by.** Phase 05 (subscription), Phase 10 (deposit and POS), Phase 14 (booking).

---

### EXT-05 — CallPro

**Required before production.** Endpoint and authentication scheme, IP allowlist, callback or status
query support, Unicode segment billing rules, pricing, throughput and rate limits, retry policy,
retention, SLA and production credentials.

**Recorded constraints.** Cyrillic SMS is approximately 70 characters per segment and Latin
approximately 160; messages are sent from an eight-digit IP72 number rather than a branded sender ID
(doc 14 §5.6). The endpoint schema, authentication type and callback signature must not be invented
(doc 14 §5.6).

**Port surface.** `SmsPort.send(jobId, recipients, body) → perRecipientMessageId`,
`.queryStatus(messageId)`, `.verifyCallback(payload)`.
**Fail-closed rule.** One-way only; no inbound SMS inbox (`OPS-DEC-004`). Backend only; no client ever
holds CallPro credentials. Full SMS bodies and full registration numbers are never written to
application logs, delivery logs or provider callback records (doc 13 §10.2).
**Open configuration.** Per-job recipient cap and retry policy remain P1-07.

**Consumed by.** Phase 18 (Match alert SMS) and Phase 19 (subscription reminders, and the two
one-time codes of a subscription contact change) — canonical port `SmsPort` with a deterministic
simulator; the production adapter answers `DISABLED` and sends nothing.

**What Phase 19 leaves closed.** The **tariff** is a term of the agreement, so
`platform.sms_tariff` is empty and the estimated cost is absent rather than invented (doc 14 §5.4
shows it "боломжтой бол"). The **segment count** divides by the two capacities doc 14 §5.3
publishes and rounds up; the concatenated-message headers a real provider applies are not modelled,
and the figure is presented as an estimate everywhere (`A-P19-8`). No **callback route exists at
all**: no signature scheme is approved, so delivery status is asked for through
`queryStatus` and never accepted unsolicited. With the adapter disabled, a confirmed send records
every recipient message `FAILED` with the gate as its reason — the job exists, the audit exists, and
nothing was sent.

---

### EXT-06 — Google Maps

**Required before production.** Which of Maps, Places or Geocoding is used, billing account, API-key
and domain restrictions, and permitted storage of address and coordinates.

**Port surface.** `GeoPort.geocode(address)`, `.reverseGeocode(lat, lng)`, `.distance(a, b)`.
**Fail-closed rule.** Distance and ordering are computed server-side; client-supplied distance is
never trusted (doc 09 §4). An unauthenticated user's precise coordinates are never persisted to a
profile.
**Open configuration.** The nearby radius and default sort order remain P1-01, with an interim default
of 5 km, availability first and then distance.

**Consumed by.** Phase 05 (onboarding location capture), Phase 12 (public discovery).

**Phase 12 status.** `GeoPort` and `SimulatedGeo` ship in `@prsystem/ports` with the conformance
suite. The gate is applied to the half that needs the provider: `geocode` and `reverseGeocode`
answer `DISABLED` on the production path, while `distance` is a great-circle calculation over the
integer micro-degree coordinates the platform already stores, reaches no provider, and is available
on both paths. That split is deliberate and recorded as `A-P12-6`: doc 09 §4 requires distance and
ordering to be computed server-side, and answering `DISABLED` for arithmetic would push the
calculation to the only other place it could go — the client. The public search accepts no distance
field at all and refuses one with 400 rather than ignoring it. **Still BLOCKED** for geocoding: the
API surface, billing account, key restrictions and permitted storage of address and coordinates are
undecided. The nearby radius and sort order remain **P1-01**, running on the interim 5 km,
availability-then-distance values.

---

### EXT-07 — Platform central account

**Required before production.** The contract permitting the platform to receive guest payments and
remit net amounts to hotels, payment-service authorization, tax and accounting treatment, and refund
and chargeback liability allocation.

**Recorded constraint.** The requirements explicitly flag that receiving third-party payments through
the platform's own account and remitting onward requires professional legal, accounting and
payment-service confirmation before production (doc 09 §9.5, doc 11 §12).

**Implementation stance.** The full ledger — payment, commission, hotel payable, provider fee, refund,
adjustment and payout batch — is built and tested (`PAY-DEC-008`, `PAY-DEC-009`). Only the payout
**execution** adapter is gated. `D+1 12:00 Asia/Ulaanbaatar` batching runs against the simulator.

Phase 14 implements this as `HotelPayoutPort` (`packages/ports/src/hotel-payout.port.ts`): the
production adapter is `UnavailableHotelPayout`, which answers `DISABLED` and makes no network call,
and `SimulatedHotelPayout` is what local, CI and every gate in this phase run against. A failed
transfer creates a new `attempt_no` rather than rewriting the old one, so the behaviour the gate will
eventually be measured against is already the tested one.

**Consumed by.** Phase 14 — canonical port and simulator; the production adapter stays disabled.

---

### EXT-08 — Personal data protection

**Required before production.** Guest-facing privacy notice and consent, definition of the hotel,
platform and ЦЕГ roles, purpose, field list, retention, transfer conditions, data-subject request
handling and breach procedure. Legal basis under the Law on Protection of Personal Information
(doc 12 §13).

**Implementation stance.** Retention is versioned configuration, not a constant: the MVP product
default is 365 days from `actual_checkout_at`, with `retention_policy_version`, `retention_days` and
`retention_expires_at` snapshotted at checkout, plus legal-hold support (`GUEST-DEC-008`). A written
legal or ЦЕГ policy may override the default through a new configuration version recording owner,
legal basis, effective date and retroactivity.

**Consumed by.** Phase 17 (guest registry retention), Phase 18 (Police data sharing).

---

### EXT-09 — ЦЕГ (National Police Agency)

**Required before production.** Written legal basis for Wanted and check-in data sharing, Police Admin
appointment procedure, the proportionate scope of the all-hotel check-in list, retention, alert
escalation minutes and the full-RD SMS exception.

**Hard implementation consequences** (doc 13 §§4.1, 10.1):

- Escalation timer minutes are **not** hard-coded. Without an approved configuration the escalation
  timer is **not enabled in production**.
- Without an approved retention configuration, Police Admin historical (checked-out) search is **not
  enabled in production**. The active-stay view remains available.
- Historical search is capped at a 31-day window per query and requires a mandatory search reason.
- Bulk export of the check-in list is closed to every role in MVP.

**Consumed by.** Phase 18.

---

### EXT-10 — Police security

**Required before production.** Human-rights and security impact assessment for automated matching,
hosting and network design, incident response, disaster recovery, penetration test, and periodic
access and audit review.

**Carried security exceptions requiring written ЦЕГ approval:**

| Exception | Decision | Fallback if unapproved |
| --- | --- | --- |
| Four-digit activation and reset bootstrap code | `POL-DEC-022` | Six-digit or longer code, or approved SSO bootstrap |
| Full registration number in the Match SMS | `POL-DEC-009` | Alert without identifier; portal-only detail |
| Full registration number in the Police Admin check-in list | `POL-DEC-010` | Masked identifier |

**Consumed by.** Phase 18, then the Phase 22 security pass and the Phase 23 release audit.

---

### EXT-11 — eBarimt

**Required before production.** Merchant and issuer structure, API and credentials, receipt types and
breakdown, callback, status and cancel-correction semantics, sandbox and production access, and tax
authority approval.

**Port surface.** `EBarimtPort.issue({ paymentId, totalMnt, vatBreakdown, buyer, idempotencyKey })`,
`.queryStatus`, `.cancel` — the canonical contract in `packages/ports`, answering a typed
non-throwing `PortResult`. An issued receipt is returned whole (number, QR, amounts, issue time) or
not at all, so a retry has nothing to fabricate; the simulator is idempotent by the caller's key and
passes the §3 conformance suite (`packages/ports/src/conformance.test.ts`). Each confirmed onboarding,
renewal and upgrade payment opens exactly one durable issuance intent in the payment's own
transaction, consumed by the worker's issuance queue (Phase 05 remediation 1).
**Fail-closed rule.** A missing receipt never blocks or reverses a confirmed subscription activation
(`SUB-DEC-005`, `SUB-DEC-008`). Failed issuance moves the payment to a manual-resolution queue actioned
by `SUBSCRIPTION_EBARIMT_RETRY`. Operators never hand-author receipt numbers, QR codes, tax amounts or
payment references, and never mark a receipt as sent before official issuance.

**Consumed by.** Phase 05 (issuance), Phase 19 (manual retry queue).

---

## 4. Additional non-EXT production gates

| Gate | Source | Nature | Owning phase |
| --- | --- | --- | --- |
| Email delivery provider (`INT-MAIL-01`) | `ONB-DEC-003`, `STAFF-DEC-001`, `OPS-DEC-008` | Activation, invitation, reset and eBarimt delivery all use email; provider, delivery-status semantics and TTLs are P1-15 configuration. **Still BLOCKED at Phase 20**: no provider is contracted, and the approved wording of the six messages the port carries does not exist either, so an SMTP adapter would have had to invent both a delivery-status model and user-facing copy | 20 |
| S3-compatible object storage (`INT-STORAGE-01`) | `GUEST-DEC-007`, doc 13 §12.3 | Private buckets, one-hour export TTL, five-minute signed URLs, encrypted temporary Police export files. Phase 17 ships the typed `ObjectStoragePort` with a deterministic simulator; the production adapter answers `DISABLED` behind this gate, so an export outside local, CI and test fails closed with a recorded reason rather than writing a file nowhere | 20 |
| Tax and VAT treatment | P1-11 | The ledger carries tax fields; official accounting treatment awaits an accountant or tax adviser. Phase 05 stamps a `taxConfigVersion` of `p1-provisional-tax-2026-08` onto every quote and payment, so the rate a figure was computed under is recorded rather than assumed | 23 |
| Phone one-time-password provider (`INT-OTP-01`) | `ONB-DEC-004`, doc 15 §2.1 | doc 15 requires the citizen's or representative's phone to be OTP-verified before an invoice exists, and **no OTP provider is contracted**. CallPro is EXT-05 and is an SMS *send* contract, not an OTP service, so reading it as covering this would be inventing an approved capability. Phase 05 ships the typed port and a deterministic simulator; the production adapter does not exist and the port fails closed outside local, CI and test | 20 |

---

## 5. Gate review protocol

- Every phase that introduces a port updates this file with the port surface and simulator coverage.
- Phase 20 records, per adapter, whether the gate is cleared and which artefact cleared it (§6).
- No phase may mark a gate `CLEARED` without the named artefact — contract, credential or written
  approval — recorded here. Since Phase 20 the same status is declared in
  `packages/ports/src/gates.ts`, whose type refuses `cleared: true` without an `artefact` and a
  `clearedOn` date, and in `platform.external_gate` / `platform.internal_gate`; a test fails when
  any two of the three disagree. Clearing a gate is therefore always a reviewed change to code, to
  this document and to a migration.
- Phase 23 performs the final gate review. Any gate still `BLOCKED` is reported as a production
  release blocker, not as a development defect, and the release decision is returned to the customer.

---

## 6. Phase 20 adapter record

Phase 20's exit condition is that every adapter is *either* enabled with its gate cleared *or*
explicitly recorded as still blocked. **No gate cleared during Phase 20** — no contract, credential,
signature rule or written approval was supplied — so every production adapter remains disabled in
staging and production, and the table below is the honest record of what exists behind each gate.

Three things were built for every slot regardless of its gate, because they need no contract:

- **selection by configuration** (`ADAPTER_<SLOT>` = `simulator` | `disabled` | adapter name), refused
  at startup when it names a simulator above test, a production adapter behind a `BLOCKED` gate, or an
  adapter nobody has written — by both the API and the worker, before a port is bound or Redis is
  contacted;
- **the fail-closed conformance**, measured by the `SEC-ADAPTERS` sub-gate of `GATE-SEC`: with
  production defaults, every operation of every port answers `DISABLED` naming its gate and the
  process makes no network call — `fetch` is replaced with a tripwire for the duration and never
  fires;
- **the shared adapter infrastructure** a real adapter runs on: an outbound HTTP client with a hard
  timeout, a token-bucket throughput limit and status mapping into the port vocabulary; a `Secret`
  wrapper that redacts itself under string coercion, JSON and `util.inspect`; HMAC / SHA-256 /
  constant-time primitives; and IPv4 / IPv6 CIDR allowlisting, applied as a guard on the four
  provider callback routes (`CALLBACK_ALLOWLIST_<PROVIDER>`; an unconfigured provider has every
  callback refused at and above staging).

| Slot | Gate | Production adapter | Status at Phase 20 | Why it stays disabled | What would enable it |
| --- | --- | --- | --- | --- | --- |
| `payment.qpay` | EXT-03 | **none written** | **BLOCKED** | doc 11 §12 records only that Merchant V2 endpoints exist; the callback verification rule, the merchant type and the refund capability are contractual. An adapter written from memory of a public API would be an invented one | The merchant contract, the callback signature rule and sandbox credentials; then the adapter, its conformance run and a `CLEARED` entry naming the contract |
| `payment.khaan` | EXT-04 | **none written** | **BLOCKED** | No gateway or POS contract, callback, refund or reconciliation semantics, or reference field definitions exist | The gateway and POS contracts and credentials; then the adapter and its conformance run |
| `ebarimt` | EXT-11 | **none written** | **BLOCKED** | The issuer structure, receipt breakdown, correction semantics and credentials are contractual and unapproved by the tax authority | The issuer contract, API credentials and tax authority approval |
| `xyp` | EXT-01 | **none written** | **BLOCKED** | The service list, field list, consent basis, VPN / certificate and outage procedure are all absent; there is no endpoint to write against | The XYP contract, field list, consent basis and network access |
| `emongolia` | EXT-02 | **none written** | **BLOCKED** | No authentication flow, field set, subject identifier, token lifecycle or sandbox is defined | The e-Mongolia integration agreement and sandbox access |
| `sms` | EXT-05 | **none written** | **BLOCKED** | doc 14 §5.6 forbids inventing the endpoint schema, authentication type and callback signature, and none is approved. The delivery-status refresh stays an Operation-realm command (see below) | The CallPro agreement: endpoint, authentication, IP allowlist, segment billing, tariff and credentials |
| `geo` | EXT-06 | **none written** | **BLOCKED** | Which of Maps, Places or Geocoding is used is undecided, as are the billing account, key restrictions and permitted storage; writing the Geocoding adapter would decide the first of these. `distance` remains provider-free on both paths (`A-P12-6`) | The API selection, billing account and key restrictions |
| `payout` | EXT-07 | **none written** | **BLOCKED** | The contract permitting the platform to receive guest money and remit net amounts, and the liability allocation, are absent; there is no bank facility to write against | The settlement contract, payment-service authorization and the bank's transfer API |
| `email` | INT-MAIL-01 | **none written** | **BLOCKED** | No provider is contracted (P1-15), and an adapter would also have had to invent the delivery-status model and the wording of six user-facing messages | The provider, its delivery-status semantics, and approved message copy |
| `otp` | INT-OTP-01 | **none written** | **BLOCKED** | No OTP provider is contracted; CallPro is a send contract, not an OTP service | An OTP provider contract |
| `storage` | INT-STORAGE-01 | **`s3` — written, tested, disabled in production** | **BLOCKED** | AWS Signature Version 4 is a published standard, so an S3-compatible adapter can be written without inventing anything: path-style requests signed with SigV4, presigned `GET` URLs for the five-minute link, `HEAD`-before-sign so a key that is gone cannot be signed. It is verified against the three AWS-published signature vectors and against the compose stack's MinIO (put, presigned fetch, delete, `NoSuchKey`, `SignatureDoesNotMatch`). What is missing is the production bucket, its credential and its retention configuration — a term of the agreement, not a line of code | A production bucket, region and credential; a `CLEARED` entry naming them; `ADAPTER_STORAGE=s3` |

Three policy gates (EXT-08, EXT-09, EXT-10) govern no adapter and are unchanged: their absence
disables the dependent feature in production rather than defaulting it.

**Provider status reconciliation jobs.** The two Phase 14 provider jobs — the refund executor and
the payout runner — now run on the worker deployment (`settlement.refund.execute`,
`settlement.payout.run`), each scheduled only when its adapter is not `DISABLED` and each treating
`DISABLED` as *no decision* rather than as a provider's failure: a release gate must not mark a refund
`FAILED` or a payout batch `FAILED`. With every gate blocked, neither sweep is scheduled in production
and the worker records once at startup which gate kept it off. The Phase 19 SMS delivery-status
refresh stays an Operation-realm route, because the worker's login holds no privilege on any
Operation-realm table by Phase 19's own classification rule and Phase 20 did not widen it
(`A-P20-5`).
