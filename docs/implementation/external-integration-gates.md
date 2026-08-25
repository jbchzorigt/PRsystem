# PRsystem — External Integration Gates

**Version:** 1.1 (Phase 00 repair — dependent phases realigned to the approved 23-phase structure)
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

A port is *development-ready* when its simulator passes the conformance suite: duplicate,
out-of-order, delayed, expired, mismatched-amount, mismatched-currency, bad-signature, and
timeout-then-late-success callbacks. Development-ready does **not** mean production-ready.

---

## 2. Gate register

| Gate | System | Blocks | Status | Port phase | Adapter phase |
| --- | --- | --- | --- | --- | --- |
| EXT-01 | XYP / ХУР | Identity verification at check-in and Wanted-record creation | **BLOCKED** | 08 | 20 |
| EXT-02 | e-Mongolia | Guest registration and login channel | **BLOCKED** | 12 | 20 |
| EXT-03 | QPay | Booking, subscription and restaurant payments | **BLOCKED** | 05 | 20 |
| EXT-04 | Khaan Bank | Booking and subscription gateway, POS | **BLOCKED** | 05 | 20 |
| EXT-05 | CallPro | Operation SMS reminders and Police Match SMS | **BLOCKED** | 18 | 20 |
| EXT-06 | Google Maps | Hotel location capture, distance and nearby search | **BLOCKED** | 12 | 20 |
| EXT-07 | Platform central account | Aggregated guest payments and hotel settlement | **BLOCKED** | 14 | 20 |
| EXT-08 | Personal data | Privacy notice, consent, controller and processor roles | **BLOCKED** | 17 | 20 |
| EXT-09 | ЦЕГ (National Police) | Wanted and check-in data sharing legal basis | **BLOCKED** | 18 | 20 |
| EXT-10 | Police security | Human-rights and security assessment, DR, penetration test | **BLOCKED** | 18 | 20 |
| EXT-11 | eBarimt | Subscription tax receipts | **BLOCKED** | 05 | 20 |

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

---

### EXT-02 — e-Mongolia

**Required before production.** Authentication flow, minimum field set, consent, provider subject
identifier, token lifecycle, account-linking conditions, sandbox and production access.

**Port surface.** `EMongoliaAuthPort.begin()`, `.complete(code) → { providerSubject, minimalClaims }`.
**Fail-closed rule.** Tokens and citizen data never appear in URLs, browser logs or application logs
(doc 09 §6.1). Accounts link by provider subject and are never merged automatically with a phone
account without dual-channel verification (doc 09 §6.3).

**Consumed by.** Phase 12.

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
`verifyCallback`.
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

**Consumed by.** Phase 18 (Match alert SMS), Phase 19 (subscription reminders).

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

**Consumed by.** Phase 14.

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

**Port surface.** `EBarimtPort.issue(paymentId, amount, breakdown)`, `.queryStatus`, `.cancel`.
**Fail-closed rule.** A missing receipt never blocks or reverses a confirmed subscription activation
(`SUB-DEC-005`, `SUB-DEC-008`). Failed issuance moves the payment to a manual-resolution queue actioned
by `SUBSCRIPTION_EBARIMT_RETRY`. Operators never hand-author receipt numbers, QR codes, tax amounts or
payment references, and never mark a receipt as sent before official issuance.

**Consumed by.** Phase 05 (issuance), Phase 19 (manual retry queue).

---

## 4. Additional non-EXT production gates

| Gate | Source | Nature | Owning phase |
| --- | --- | --- | --- |
| Email delivery provider | `ONB-DEC-003`, `STAFF-DEC-001`, `OPS-DEC-008` | Activation, invitation, reset and eBarimt delivery all use email; provider, delivery-status semantics and TTLs are P1-15 configuration | 20 |
| S3-compatible object storage | `GUEST-DEC-007`, doc 13 §12.3 | Private buckets, one-hour export TTL, five-minute signed URLs, encrypted temporary Police export files | 20 |
| Tax and VAT treatment | P1-11 | The ledger carries tax fields; official accounting treatment awaits an accountant or tax adviser | 23 |

---

## 5. Gate review protocol

- Every phase that introduces a port updates this file with the port surface and simulator coverage.
- Phase 20 records, per adapter, whether the gate is cleared and which artefact cleared it.
- No phase may mark a gate `CLEARED` without the named artefact — contract, credential or written
  approval — recorded here.
- Phase 23 performs the final gate review. Any gate still `BLOCKED` is reported as a production
  release blocker, not as a development defect, and the release decision is returned to the customer.
