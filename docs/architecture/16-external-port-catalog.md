# 16 — External Port Catalog

The typed port surface for every EXT gate. Ports are defined in `packages/ports`; production adapters
are implemented in **Phase 20** and stay disabled until the gate clears
([external-integration-gates.md](../implementation/external-integration-gates.md)).

---

## 1. Port contract

Every port obeys the same shape.

```ts
interface Port<Cmd, Res> {
  readonly id: PortId;              // 'qpay' | 'khaan' | 'xyp' | ...
  readonly mode: 'simulator' | 'adapter';
  execute(cmd: Cmd, ctx: PortContext): Promise<Result<Res, PortError>>;
}

type PortError =
  | { kind: 'DISABLED'; gate: ExtGateId }        // fail closed
  | { kind: 'UNAVAILABLE'; retryable: true }
  | { kind: 'TIMEOUT'; retryable: true }
  | { kind: 'REJECTED'; providerCode: string }
  | { kind: 'INVALID_SIGNATURE' }
  | { kind: 'MISMATCH'; field: 'reference'|'amount'|'currency'|'merchant' };
```

Rules that hold for all ports:

1. **Never throws across the boundary.** A port returns a typed result; the domain decides.
2. **Fail closed.** `mode: 'adapter'` with an uncleared gate returns `DISABLED` and performs no
   network call.
3. **No domain logic.** A port translates; it never decides a business outcome.
4. **No secrets in the result.** Errors carry codes, never provider payloads.
5. **Deterministic simulator.** Every port ships a simulator that passes the conformance suite in §3.
6. **Idempotency is the caller's.** The domain supplies the key; the port forwards it.

---

## 2. Port surfaces

### EXT-01 — `XypIdentityPort`

```ts
lookupByRegistrationNumber(rd: NormalizedMnRegNo)
  → { found: true; surname; givenName; dateOfBirth; nationality; address }
  | { found: false; reason: 'NOT_FOUND' | 'UNAVAILABLE' }
```

Provenance is set by the **caller** from the result: `XYP_VERIFIED` only on `found: true`, otherwise
`MANUAL`. The port never asserts verification (`RC-DEC-007`, `POL-DEC-001`).

### EXT-02 — `EMongoliaAuthPort`

```ts
begin(state: OpaqueState) → { authorizeUrl }
complete(code: string, state: OpaqueState)
  → { providerSubject: string; minimalClaims: { givenName?; surname?; dateOfBirth? } }
```

Server-to-server exchange only. The redirect is never proof. Tokens never leave the port
(doc 09 §6.1).

### EXT-03 / EXT-04 — `PaymentGatewayPort`

One interface, two implementations (`qpay`, `khaan`), so the domain is provider-agnostic
(`PAY-DEC-005`, `SUB-DEC-004`).

```ts
createInvoice({ intentId, amountMnt, currency: 'MNT', merchantRef, expiresAt, idempotencyKey })
  → { providerInvoiceId; payUrl?; qr? }

queryStatus({ providerInvoiceId })
  → { state: 'PENDING'|'PAID'|'FAILED'|'EXPIRED';
      providerPaymentId?; paidAmountMnt?; currency?; paidAt? }

refund({ providerPaymentId, amountMnt, reason, idempotencyKey })
  → { providerRefundId; state: 'PENDING'|'REFUNDED'|'FAILED' }

verifyCallback(raw) → { valid: boolean; providerEventId; payload }
```

The domain always calls `queryStatus` where the requirements demand re-query — hold expiry, uncertain
payment, reconciliation (`PAY-DEC-006`, `ONB-DEC-008`).

### EXT-04 — `PosReferencePort` (non-integrated)

Not a network port. A typed capture of a manual POS transaction: approval code, amount, timestamp,
terminal id, Reception actor, and for a refund the original payment reference. Required fields are
enforced before the transaction commits (`DEP-DEC-005`).

### EXT-05 — `SmsPort`

```ts
send({ jobId, recipients: PhoneE164[], body, idempotencyKey })
  → { perRecipient: Array<{ phoneHash; providerMessageId; accepted: boolean }> }

queryStatus({ providerMessageId })
  → { state: 'PENDING'|'SENT'|'DELIVERED'|'FAILED' }

verifyCallback(raw) → { valid; providerEventId; providerMessageId; state }

estimateSegments(body) → { segments: number; encoding: 'GSM7'|'UCS2' }
```

One-way only; no inbound message API exists (`OPS-DEC-004`). The body is never logged; recipients are
recorded by hash plus a masked display value (doc 13 §10.2).

### EXT-06 — `GeoPort`

```ts
geocode(address) → { lat; lng; confidence }
reverseGeocode({ lat, lng }) → { formattedAddress; district? }
distanceMeters(a, b) → number
```

Ranking is computed server-side; a client-supplied distance is ignored (doc 09 §4).

### EXT-07 — `PayoutPort`

```ts
submitBatch({ batchId, lines: Array<{ hotelId; payableMnt; bankRef }>, idempotencyKey })
  → { providerBatchId; state: 'SUBMITTED'|'REJECTED' }

queryBatch({ providerBatchId })
  → { state: 'SUBMITTED'|'PAID'|'FAILED'; perLine: Array<{ hotelId; state; bankTxnRef? }> }
```

Disabled until EXT-07 clears. Ledger and batching run against the simulator meanwhile
(`PAY-DEC-009`).

### EXT-11 — `EBarimtPort`

```ts
issue({ paymentId, totalMnt, vatBreakdown, buyer, idempotencyKey })
  → { receiptId; receiptNumber; qr; issuedAt }

queryStatus({ receiptId }) → { state: 'ISSUED'|'PENDING'|'FAILED' }
cancel({ receiptId, reason }) → { state: 'CANCELLED'|'FAILED' }
```

A failure never reverses an activated subscription; it routes to the manual queue
(`SUB-DEC-005`, `SUB-DEC-008`). Operators can never author receipt fields. The idempotency key
covers every material input — payment, total, VAT amount, VAT rate, buyer reference and buyer
type — so the same key with any of them changed is a reuse the issuer refuses, never a receipt
answered from the earlier request (Phase 05 remediation 2).

### Email — `EmailPort`

```ts
send({ eventId, to, template, model, idempotencyKey })
  → { providerMessageId }
queryStatus({ providerMessageId }) → { state: 'SENT'|'DELIVERED'|'BOUNCED'|'FAILED' }
```

Bodies are server-side templates. Tokens are single-use and never logged. Delivery failure never rolls
back a committed provisioning transaction (`ONB-DEC-006`).

### Key management — `KeyManagementPort`

Not an EXT gate — no requirement names a KMS vendor — but it follows the same port discipline
([ADR-0020](adr/ADR-0020-key-management.md), closing DM-04).

```ts
type KeyScope  = 'pii.hotel_guest' | 'pii.police';
type HmacScope = 'lookup.identity' | 'lookup.police_identity';

wrap(scope: KeyScope, dek: Uint8Array)       → { wrapped; keyVersion }
unwrap(scope: KeyScope, wrapped, keyVersion) → dek
currentVersion(scope: KeyScope)              → keyVersion
hmac(scope: HmacScope, input: Uint8Array)    → { mac; keyVersion }
```

Envelope encryption with versioned data-encryption keys; `key_version` stored beside every ciphertext;
Hotel/Guest and Police key scopes separated; lookup tokens are versioned keyed HMACs, never unkeyed
hashes. Development uses a deterministic simulator with synthetic data only. **Production fails
closed**: with the approved KMS or a required key version unavailable, the operation fails rather than
falling back to a local key or writing plaintext.

### Object storage — `ObjectStoragePort`

```ts
put({ key, bytes, contentType, ttlSeconds }) → { etag }
signedUrl({ key, expiresInSeconds }) → { url }
delete({ key }) → void
```

Private buckets; keys include `hotel_id` and a random component; one-hour object TTL and five-minute
URLs for guest exports (`GUEST-DEC-007`).

---

## 3. Simulator conformance suite

Every port's simulator, and later every adapter, must pass the same eight scenarios. This is what
"development-ready" means.

| # | Scenario | Required outcome |
| --- | --- | --- |
| 1 | Duplicate callback, same `provider_event_id` | Second is a no-op; one business effect |
| 2 | Out-of-order callbacks | Final state matches the authoritative provider status |
| 3 | Delayed callback after entity expiry | Terminal state preserved; refund obligation or reconciliation case raised |
| 4 | Unknown reference | Rejected, audited, no domain effect |
| 5 | Amount mismatch | `MISMATCH`; no domain effect |
| 6 | Currency mismatch | `MISMATCH`; no domain effect |
| 7 | Invalid signature | `INVALID_SIGNATURE`; no parsing of the payload beyond verification |
| 8 | Timeout then late success | No duplicate effect; reconciled through status re-query |

Plus, for every port: invoking an adapter whose gate is uncleared returns `DISABLED` and makes no
network call.

**Phase 05 conformance (remediation 1).** The suite is code, not prose:
`packages/ports/src/conformance.test.ts` runs the eight scenarios and the `DISABLED` rule against
the canonical `packages/ports` contracts — `PaymentGatewayPort` (`qpay`, `khaan`), `EBarimtPort`,
`PhoneVerificationPort` and `StaffNotificationPort`. Every operation answers a typed
`PortResult` (`ok` or a `PortError` of kind `DISABLED | UNAVAILABLE | TIMEOUT | REJECTED |
INVALID_SIGNATURE | MISMATCH`) rather than throwing; every port carries its `id` and `mode`; and
every irreversible provider effect takes a **caller-supplied idempotency key** — the same key the
domain claims in its own idempotency table before the provider is called — so a retry after a lost
acknowledgement recovers the same invoice or receipt and never creates a second one. A gate is
recorded as "port and simulator shipped" only on that evidence. Remediation 2 added two cases to
the suite: a malformed callback amount is a typed `MISMATCH` and never a throw out of the port,
and the eBarimt simulator refuses the same key with a materially different buyer or VAT input.

---

## 4. Gate mapping

| Gate | Port(s) | Earliest port phase | Adapter phase |
| --- | --- | :---: | :---: |
| EXT-01 | `XypIdentityPort` | 08 | 20 |
| EXT-02 | `EMongoliaAuthPort` | 12 | 20 |
| EXT-03 | `PaymentGatewayPort` (qpay) | 05 | 20 |
| EXT-04 | `PaymentGatewayPort` (khaan), `PosReferencePort` | 05 | 20 |
| EXT-05 | `SmsPort` | 18 | 20 |
| EXT-06 | `GeoPort` | 12 | 20 |
| EXT-07 | `PayoutPort` | 14 | 20 |
| EXT-08 | *(no port — retention and consent are configuration and policy)* | 17 | 20 |
| EXT-09 | *(no port — legal basis and configuration for the Police module)* | 18 | 20 |
| EXT-10 | *(no port — assessment, hosting and review process)* | 18 | 20 |
| EXT-11 | `EBarimtPort` | 05 | 20 |

EXT-08, EXT-09 and EXT-10 are policy and approval gates rather than network integrations. They are
satisfied by versioned configuration and written approval, and their absence disables the dependent
feature in production rather than defaulting it.

`KeyManagementPort` and `ObjectStoragePort` are not EXT gates — the requirements name no vendor — but
they follow the same port discipline, ship simulators, and have production implementations delivered
in Phase 20.

**Phase 20 outcome.** The gate mapping above is now declared in code as well
(`packages/ports/src/gates.ts`), and every deployment selects its adapters through `selectAdapters`
from per-slot configuration (`ADAPTER_<SLOT>`), which refuses a simulator above test and a production
adapter behind a `BLOCKED` gate before a port is bound. The one production adapter that exists is
the S3-compatible `ObjectStoragePort` implementation, written against the published SigV4 standard;
every contract-bound adapter is recorded as still blocked in
[external-integration-gates.md](../implementation/external-integration-gates.md) §6. The
`SEC-ADAPTERS` sub-gate measures that, with production defaults, every operation of every port
answers `DISABLED` and the process makes no network call. `KeyManagementPort` is required from Phase 03, because identifier ciphertext and lookup
tokens exist from the first migration that stores an identifier.

Two more sit outside the EXT namespace for the same reason, both first needed in Phase 05:

| Port | Control | Earliest port phase | Adapter phase |
| --- | --- | :---: | :---: |
| `StaffNotificationPort` | `INT-MAIL-01` | 04 | 20 |
| `PhoneVerificationPort` | `INT-OTP-01` | 05 | 20 |

`PhoneVerificationPort` deserves its own note. doc 15 §2.1 requires the citizen's or
representative's phone to be OTP-verified before an invoice exists, and **no OTP provider is
contracted**. CallPro is EXT-05 and is an SMS *send* contract, not an OTP service — reading it as
covering this would be inventing an approved capability — so the control is its own,
`INT-OTP-01`, and the production adapter does not exist. The port is deliberately reusable: Phase 12
needs phone verification for Guest registration and will take this port rather than a second one.

The one-time code never reaches storage. It is minted, digested with a purpose- and subject-bound
keyed HMAC, and handed to the port in plaintext only for the duration of the delivery call — the same
discipline every other one-time secret on this platform follows (ADR-0020 §6, CLAUDE.md §8).
