# PRsystem — External Integration Gates

**Version:** 1.0 (Phase 00 inventory)
**Source:** `docs/00-mvp-open-decisions.md` §4 (EXT-01 … EXT-11), plus module-level production
exceptions in docs 13, 14, 16.

---

## 1. Standing rule

For every external system, if an official contract, credential, signature rule, or production
approval is missing:

1. Do not invent it.
2. Implement a typed port in `packages/ports` plus a deterministic simulator.
3. Keep the production adapter **disabled by configuration** and **fail closed** when invoked.
4. Record the blocker here.

A port is "development-ready" when its simulator passes the conformance suite (duplicate,
out-of-order, delayed, expired, mismatched-amount, mismatched-currency, bad-signature, and
timeout-then-late-success callbacks). Development-ready does **not** mean production-ready.

---

## 2. Gate register

| Gate | System | Blocks | Status | Dev strategy |
| --- | --- | --- | --- | --- |
| EXT-01 | XYP / ХУР | Identity verification at check-in and Wanted-record creation | **BLOCKED** | Port + simulator; `MANUAL` provenance fallback is the approved production behaviour (RC-DEC-007) |
| EXT-02 | e-Mongolia | Guest registration/login channel | **BLOCKED** | Port + simulator; phone-OTP path is the approved fallback (BK-DEC-002) |
| EXT-03 | QPay | Booking, subscription and restaurant payments | **BLOCKED** | Port + simulator; production adapter disabled |
| EXT-04 | Khaan Bank | Booking and subscription gateway, POS | **BLOCKED** | Port + simulator; production adapter disabled |
| EXT-05 | CallPro | Operation SMS reminders, Police Match SMS | **BLOCKED** | Port + simulator; production adapter disabled |
| EXT-06 | Google Maps | Hotel location capture, distance/nearby search | **BLOCKED** | Port + simulator with fixed fixtures; manual location entry always available |
| EXT-07 | Platform central account | Aggregated guest payments and hotel settlement | **BLOCKED** | Ledger implemented; payout execution behind a disabled port |
| EXT-08 | Personal data | Privacy notice, consent, controller/processor roles | **BLOCKED** | Retention/legal-hold schema implemented; policy values are versioned configuration |
| EXT-09 | ЦЕГ (National Police) | Wanted/check-in data sharing legal basis | **BLOCKED** | Police module built; escalation timers and historical search disabled without approved config |
| EXT-10 | Police security | Human-rights/security impact assessment, DR, pentest | **BLOCKED** | Hardening implemented; release gate only |
| EXT-11 | eBarimt | Subscription tax receipts | **BLOCKED** | Port + simulator; manual-resolution queue is the approved fallback (SUB-DEC-008) |

All eleven gates are **production release gates**. None blocks Phase 01–21 development.

---

## 3. Gate detail

### EXT-01 — XYP / ХУР

**Required before production:** service list, exact field list, consent and legal basis, contract,
VPN / certificate / static IP, server-location conditions, and the formal outage & manual-fallback
procedure.

**Port surface.** `XypIdentityPort.lookupByRegistrationNumber(normalizedRd) → { found, fields, provenance }`.
**Simulator behaviours.** found · not-found · service-unavailable · timeout · malformed response.
**Fail-closed rule.** On `not-found` or `unavailable`, the system records `MANUAL` provenance and
never presents the record as XYP-verified (RC-DEC-007, POL-DEC-001). Development uses synthetic
registration numbers only (doc 13 §17).

**Dependent phases:** 10 (check-in identity), 18 (Wanted identity).

---

### EXT-02 — e-Mongolia

**Required before production:** authentication flow, minimum field set, consent, provider subject
identifier, token lifecycle, account-linking conditions, sandbox and production access.

**Port surface.** `EMongoliaAuthPort.begin()`, `.complete(code) → { providerSubject, minimalClaims }`.
**Fail-closed rule.** Tokens and citizen data never appear in URLs, browser logs, or application logs
(doc 09 §6.1). Accounts are linked by provider subject, never merged automatically with a phone
account without dual-channel verification (doc 09 §6.3).

**Dependent phase:** 15.

---

### EXT-03 — QPay

**Required before production:** merchant ownership, invoice/payment/refund API contract, callback
verification rule, partial vs full refund capability, timeout and status-query semantics, and
written approval for centralized settlement.

**Reference recorded in the requirements:** QPay Merchant V2 exposes invoice create/cancel,
post-callback payment check, and payment cancel/refund endpoints — but production merchant type,
centralized settlement, and per-payment-type refund capability must be confirmed contractually
(doc 11 §12).

**Port surface.** `PaymentGatewayPort` shared with EXT-04: `createInvoice`, `queryStatus`,
`refund`, `verifyCallback`.
**Fail-closed rule.** No screenshot, redirect, or client-reported success is ever authoritative
(PAY-DEC-005). Late or duplicate capture creates a refund obligation or reconciliation case, never an
entitlement change (PAY-DEC-006, ONB-DEC-008, LIFE-DEC-006).

**Dependent phases:** 04, 15, 17.

---

### EXT-04 — Khaan Bank

**Required before production:** POS terminal registration and online gateway contracts, callback,
refund and reconciliation semantics, reference field definitions, sandbox and production credentials.

**Port surface.** Same `PaymentGatewayPort` contract as QPay (PAY-DEC-005, SUB-DEC-004), plus a
manual-POS reference capture path that is not an integration (RC-DEC-006, DEP-DEC-005).
**Fail-closed rule.** Manual POS payments and refunds require reference/approval code, amount,
timestamp, Reception actor, and — for refunds — the original payment reference.

**Dependent phases:** 04, 11, 15.

---

### EXT-05 — CallPro

**Required before production:** endpoint and authentication scheme, IP allowlist, callback or status
query support, Unicode segment billing rules, pricing, throughput and rate limits, retry policy,
retention, SLA, and production credentials.

**Recorded constraints.** Cyrillic SMS ≈ 70 characters per segment, Latin ≈ 160; messages are sent
from an 8-digit IP72 number rather than a branded sender ID (doc 14 §5.6). The endpoint schema,
authentication type, and callback signature must not be invented (doc 14 §5.6).

**Port surface.** `SmsPort.send(jobId, recipients, body) → perRecipientMessageId`,
`.queryStatus(messageId)`, `.verifyCallback(payload)`.
**Fail-closed rule.** One-way only; no inbound SMS inbox (OPS-DEC-004). Backend-only; no client ever
holds CallPro credentials. Full SMS body and full registration numbers are never written to
application logs, delivery logs, or provider callback records (doc 13 §10.2).
**Open configuration:** per-job recipient cap and retry policy remain P1-07.

**Dependent phases:** 18 (Match alert SMS), 19 (subscription reminders).

---

### EXT-06 — Google Maps

**Required before production:** which of Maps / Places / Geocoding is used, billing account, API-key
and domain restrictions, and permitted storage of address and coordinates.

**Port surface.** `GeoPort.geocode(address)`, `.reverseGeocode(lat,lng)`, `.distance(a,b)`.
**Fail-closed rule.** Distance and ordering are computed server-side; client-supplied distance is
never trusted (doc 09 §4). Unauthenticated users' precise coordinates are never persisted to a
profile.
**Open configuration:** "nearby" radius and default sort order remain P1-01 (interim default 5 km,
availability first then distance).

**Dependent phases:** 04 (onboarding location), 15 (search).

---

### EXT-07 — Platform central account

**Required before production:** the contract permitting the platform to receive guest payments and
remit net amounts to hotels, payment-service authorization, tax and accounting treatment, and
refund/chargeback liability allocation.

**Recorded constraint.** The requirements explicitly flag that receiving third-party payments through
the platform's own account and remitting onward requires professional legal, accounting, and
payment-service confirmation before production (doc 09 §9.5, doc 11 §12).

**Implementation stance.** The full ledger — payment, commission, hotel payable, provider fee,
refund, adjustment, payout batch — is built and tested (PAY-DEC-008, PAY-DEC-009). Only the payout
**execution** adapter is gated. `D+1 12:00 Asia/Ulaanbaatar` batching runs against the simulator.

**Dependent phase:** 15.

---

### EXT-08 — Personal data protection

**Required before production:** guest-facing privacy notice and consent, definition of
hotel / platform / ЦЕГ roles, purpose, field list, retention, transfer conditions, data-subject
request handling, and breach procedure. Legal basis under the Law on Protection of Personal
Information (doc 12 §13).

**Implementation stance.** Retention is a versioned configuration, not a constant: MVP product
default is 365 days from `actual_checkout_at`, with `retention_policy_version`, `retention_days`, and
`retention_expires_at` snapshotted at checkout, plus legal-hold support (GUEST-DEC-008). A written
legal or ЦЕГ policy may override the default through a new configuration version with owner, legal
basis, effective date, and retroactivity recorded.

**Dependent phases:** 13, 18.

---

### EXT-09 — ЦЕГ (National Police Agency)

**Required before production:** written legal basis for Wanted/check-in data sharing, Police Admin
appointment procedure, the proportionate scope of the all-hotel check-in list, retention, alert
escalation minutes, and the full-RD SMS exception.

**Hard implementation consequences (doc 13 §§4.1, 10.1):**

- Escalation timer minutes are **not** hard-coded. Without an approved configuration, the escalation
  timer is **not enabled in production**.
- Without an approved retention configuration, Police Admin historical (checked-out) search is **not
  enabled in production**. Active-stay view remains available.
- Historical search is capped at a 31-day window per query and requires a mandatory search reason.
- Bulk export of the check-in list is closed to every role in MVP.

**Dependent phase:** 18.

---

### EXT-10 — Police security

**Required before production:** human-rights and security impact assessment for automated matching,
hosting and network design, incident response, disaster recovery, penetration test, and periodic
access/audit review.

**Carried security exceptions requiring written ЦЕГ approval:**

| Exception | Decision | Fallback if unapproved |
| --- | --- | --- |
| 4-digit activation/reset bootstrap code | POL-DEC-022 | ≥6-digit code or approved SSO bootstrap |
| Full registration number in Match SMS | POL-DEC-009 | Alert without identifier; portal-only detail |
| Full registration number in the Police Admin check-in list | POL-DEC-010 | Masked identifier |

**Dependent phase:** 18, plus the Phase 21 release gate.

---

### EXT-11 — eBarimt

**Required before production:** merchant/issuer structure, API and credentials, receipt types and
breakdown, callback/status/cancel-correction semantics, sandbox and production access, and tax
authority approval.

**Port surface.** `EBarimtPort.issue(paymentId, amount, breakdown)`, `.queryStatus`, `.cancel`.
**Fail-closed rule.** A missing receipt never blocks or reverses a confirmed subscription activation
(SUB-DEC-005, SUB-DEC-008). Failed issuance moves the payment to a manual-resolution queue actioned
by `SUBSCRIPTION_EBARIMT_RETRY`. Operators never hand-author receipt numbers, QR codes, tax amounts,
or payment references, and never mark a receipt as sent before official issuance.

**Dependent phases:** 04, 19.

---

## 4. Additional non-EXT production gates

| Gate | Source | Nature |
| --- | --- | --- |
| Email delivery provider | ONB-DEC-003, STAFF-DEC-001, OPS-DEC-008 | Activation, invitation, reset, and eBarimt delivery all use email; provider, delivery-status semantics, and TTLs are P1-15 configuration |
| S3-compatible object storage | GUEST-DEC-007, doc 13 §12.3 | Private buckets, 1-hour export TTL, 5-minute signed URLs, encrypted temporary Police export files |
| Tax / VAT treatment | P1-11 | Ledger carries tax fields; official accounting treatment awaits an accountant/tax adviser |

---

## 5. Gate review protocol

- Every phase that introduces a port updates this file with the port surface and simulator coverage.
- No phase may mark a gate `CLEARED` without the named artefact (contract, credential, written
  approval) recorded here.
- Phase 21 performs a full gate review; any gate still `BLOCKED` is reported as a production release
  blocker, not as a development defect.
