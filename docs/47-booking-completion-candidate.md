# Online booking — verified mock implementation

2026-09-09. **Implementation verified within the mock scope below.**
Stage three remains accepted in its agreed mock boundary (docs/43).
The user authorized unavailable external APIs to stay mocked. New source in this
candidate was published with explicit user approval to the public feature branch
as `6f130d7d3932d388a5c1f64d608f47169f5b0096` (the same tree as local `5ea8d9b`).
Final source `5493c788eceb5a13dfa469de12597b5e570fbfee` includes two CI fixes:
unique global booker fixtures with isolated public searches, and consistent
tenant scope in initial/retried customer booking responses. It passed **506/506
backend tests without skips** on PostgreSQL in **367.685 seconds**, plus all three
browser suites, generated API request validation, design lint and token checks.
[CI evidence](https://github.com/jbchzorigt/PRsystem/actions/runs/34292660548).
The follow-up commit updates documentation only; production gates remain below.

| Workstream | Candidate implementation | Verification |
| --- | --- | --- |
| Terminal lifecycle | Unpaid cancellation; manual no-show after local cutoff; Manager hotel-caused cancellation; explicit category rank and zero-cost upgrade; paid contract preserved | PostgreSQL tests passed |
| Guest access | Independent booker realm, mock phone OTP, password login/reset, revision-revoked sessions, own bookings, keyed phone lookup and encrypted phone | PostgreSQL and production fail-closed tests passed |
| Public catalog | Manager profile/category publication, Platform listing authority, active subscription/contract, category availability, date/location search and optional one-shot distance | PostgreSQL and browser search/login/review tests passed |
| Refund review | Server cancellation preview; changed refund amount rolls back cancellation; original-payment mock reconciliation remains canonical | PostgreSQL preview and rollback tests passed |
| Settlement | Exact bank credit/refund evidence, provider fee separated from hotel net, immutable first eligibility, D+1 12:00 Ulaanbaatar maturity, immutable chargeback/net/commission adjustments | PostgreSQL tests passed |
| Payout | Fresh Platform MFA and explicit permissions, verified beneficiary revision, immutable batches, pending/unknown reconciliation, failed-only new attempts, paid-source uniqueness, authoritative unsent-batch void and rebatch | Six local bank tests and PostgreSQL tests passed |
| Interfaces | `/booking`, Reception Online destination, Manager profile/rank/publication, `/platform/booking`; shared forms, retry keys, validation, dirty guard and token privacy | Three browser suites and generated payload validation passed |

## Security and transaction boundaries

All new business services call the existing mock/runtime/isolated-database gate;
production calls fail closed. Booker sessions never grant staff or staying-guest
identity. Mock OTP proves only simulated phone possession, not XYP/e-Mongolia
identity. Phone lookups use the vault's keyed fingerprint, phone values use
purpose-bound envelopes, and passwords use the existing Argon2 hasher. OTP
5-minute/5-attempt controls and staff-configured rate windows are development
settings, not a newly approved production OTP policy. Failed PostgreSQL completion
after consuming a mock OTP requires requesting another OTP; it cannot replay proof.

Platform permissions are independent: `BOOKING_PUBLISH`, `BOOKING_FINANCE`,
`PAYOUT_EXECUTE`. Each sensitive call uses the existing five-minute MFA freshness
check. Source commands remain on the catalog lock and retain server price,
contract, amount and idempotency authority. Capture/refund confirmation records,
finance events, eligibility/adjustments and payout results are separate immutable
records. Corrections retain the original paid source. Net-negative adjustments
remain receivable/next-batch offsets. They do not reopen a paid base.

A batch records expected effective net for every source. A changed assessment
blocks first dispatch. An already-dispatched bank result is still recorded,
then a subsequent immutable adjustment reconciles the change. Void first obtains
local bank proof that all attempts cannot subsequently succeed. A successful
bank transfer cannot be voided. Database paid-source uniqueness independently
prevents a source appearing in two successful batches. No UI accepts `paid`,
commission, provider proof or payout amount from the customer as authority.

Public profile tables contain only intended public attributes; public handlers
require both publication flags and valid hotel access before projecting them.
Operational tables retain FORCE RLS. Account/session services query the separate
booker tables by authenticated account, analogous to the existing staff realm.
Public image input is limited to bounded base64 PNG/JPEG; arbitrary URL/SVG input
is rejected. Client tokens, OTP/password drafts and precise GPS are not persisted.

## Local operator controls

`python -m prsystem.development` continues to require `PRSYSTEM_ENV=development`.
New subcommands simulate only local SQLite bank evidence:

- `bank-credit TENANT QPAY|KHAAN MERCHANT PAYMENT AMOUNT FEE`
- `bank-beneficiary TENANT REFERENCE`
- `bank-dispute TENANT PAYMENT CHARGEBACK [--opened]`
- `bank-payout ATTEMPT PENDING|UNKNOWN|FAILED|SUCCEEDED`

The existing payment/refund controls remain the only way to simulate provider
success. The development app supplies `MockBankGateway`; Platform TOTP secrets
resolve from `PRSYSTEM_DEV_MFA_<key_ref>` base64 configuration. This is not a live
bank adapter, customer payment page, settlement scheduler or production secret
provisioning procedure. Application roles need minimum grants for migrations
038–042; test grants demonstrate the required new table access, including the
invoker trigger's insert/select on `booking_paid_source`.

## Verification and publication

- All 506 backend tests executed against PostgreSQL with the restricted app role;
  migration replay, tenant isolation, race and rollback checks passed.
- Publication completed after the user explicitly approved public source disclosure.
  [CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34292660548) passed
  on the authorized feature branch; the PR remains a draft. No merge or deployment.
- Local discovery had 100 executed and 406 database-dependent skipped tests;
  the remote PostgreSQL run above is the full backend acceptance evidence.

## Explicit remaining release/integration gates

- Real SMS/e-Mongolia, payment/refund/bank transport, image delivery, scheduling,
  production secret management and deployment remain external release work.
  Category inventory intentionally excludes minibar-configured rooms until the
  stage-five canonical configuration adapter (docs/44,46). Ratings/review policy
  and its service are separate (docs/10); this candidate fabricates no reviews.

Do not equate mocked browser responses, local domain tests or a static audit
with a passed PostgreSQL or live provider acceptance gate.
