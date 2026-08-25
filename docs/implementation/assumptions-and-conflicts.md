# PRsystem — Assumptions, Drift Resolutions and Conflicts

**Version:** 1.1 (Phase 00 repair — affected phases realigned to the approved 23-phase structure)

Precedence used throughout (CLAUDE.md §0):

1. [docs/00-mvp-open-decisions.md](../00-mvp-open-decisions.md)
2. the relevant module document
3. [docs/18-action-level-permission-matrix.md](../18-action-level-permission-matrix.md)

Nothing in this file edits a requirement document. Where two documents describe the same rule with
different wording, the resolution below records which text is canonical and why.

Phase numbers refer to the approved namespace 01–23 fixed in [build-plan.md](build-plan.md) §3.

---

## 1. Open P0 conflicts

**None.** [docs/00-mvp-open-decisions.md](../00-mvp-open-decisions.md) §2 records
`Нээлттэй P0: байхгүй` — every P0 product, schema and API decision is closed. No item in this file
blocks Phase 01.

---

## 2. Documentation drift resolutions

These are wording differences between an earlier general document and a later canonical module
document. Each is resolved by precedence, not by choice.

### D-01 — Deposit configuration authority

- **Earlier text.** Doc 02 §3.4 and `RC-DEC-002`: "Manager эсвэл Hotel Admin … барьцааны дүнг …
  тохируулна", which reads as Hotel Admin holding the right directly.
- **Canonical text.** `DEP-DEC-008` (doc 20 §2.5) and `RBAC-DEC-013` (doc 18): deposit hotel and
  category configuration is a Manager or Manager Plus operational action; **Hotel Admin must hold the
  package-permitted Manager or Manager Plus role separately**.
- **Resolution.** Follow `DEP-DEC-008` and `RBAC-DEC-013`. Doc 02 §9.5 already states the same
  constraint, so doc 02 is internally consistent with the canonical rule; only the summary sentence in
  `RC-DEC-002` is loose. This matches the global rule `RBAC-DEC-001` — Hotel Admin never inherits
  operational roles.
- **Phases affected.** Phase 04 (permission catalog), Phase 10 (deposit configuration and folio).

### D-02 — Exceptional deposit source and exemption correction authority

- **Earlier text.** Doc 02 §3.4: "Онцгой тохиолдлын өөрчлөлтийг Manager/Hotel Admin баталж".
- **Canonical text.** Doc 02 §9.5 and `DEP-DEC-008`: pre-confirmation source and exemption correction
  is performed by Manager, or by Manager Plus on the 30 000₮ package, with a mandatory reason; Hotel
  Admin needs the separate operational role.
- **Resolution.** Follow doc 02 §9.5 and `DEP-DEC-008`.
- **Phases affected.** Phase 10.

### D-03 — Hourly duration granularity and price formula

- **Earlier text.** `STAY-DEC-002` and doc 18 §8: the hourly charge is "effective hourly price × the
  number of hours Reception selected".
- **Later canonical text.** `STAY-DEC-014` (doc 05 §24) and doc 00 §2 P0-39D: walk-in hourly stays use
  fixed 30-minute steps stored as integer `duration_minutes` and `half_hour_units`, with
  `hourly_total_mnt = ROUND_HALF_UP(effective_hourly_rate_mnt × half_hour_units / 2)`.
- **Resolution.** `STAY-DEC-014` is the canonical precision rule and is confirmed by doc 00, which has
  the highest precedence. `STAY-DEC-002` remains valid as the shape of the formula, and `STAY-DEC-006`
  confirms that no Manager-configurable minimum, maximum or increment is added. Implement
  `STAY-DEC-014`.
- **Phases affected.** Phase 06 owns the rate configuration (`STAY-DEC-002`, `STAY-DEC-006`); Phase 08
  owns the duration model and the rounding (`STAY-DEC-014`).

### D-04 — Shift approval authority phrasing

- **Earlier text.** Doc 02 §3.5 and doc 03 §2 mention "Manager/Hotel Admin" as shift reviewers in
  general prose.
- **Canonical text.** `SHIFT-DEC-001`–`SHIFT-DEC-007` and `RBAC-DEC-011`: routine financial review is
  performed by Manager or Manager Plus; Hotel Admin is the **exception** reviewer — Manager
  unavailable, Manager worked the shift as Reception, or a self-close with a variance. A zero-variance
  self-close needs no review at all.
- **Resolution.** Follow `SHIFT-DEC-001`–`SHIFT-DEC-007` and `RBAC-DEC-011`.
- **Phases affected.** Phase 11.

---

## 3. Recorded implementation assumptions

Assumptions made where the requirements specify behaviour but not a mechanism. Each is reversible and
none reopens a closed P0 decision.

| ID | Assumption | Basis | Established in | Risk if wrong |
| --- | --- | --- | --- | --- |
| A-01 | `Asia/Ulaanbaatar` is the seed hotel timezone, stored per hotel; all timestamps persist as UTC `timestamptz` and resolve to hotel-local for business dates | doc 05 §6, doc 23 §6.1 | Phase 03 | Low — timezone is already per-hotel data |
| A-02 | Money columns are `bigint` MNT integers (₮ has no subunit in these documents); rates are `integer` basis points | `PAY-DEC-008`, doc 09 §9.2 | Phase 03 | Low |
| A-03 | Occupancy overlap is enforced by a PostgreSQL exclusion constraint over `(room_id, tstzrange(start_at, end_at, '[)'))` in addition to application checks | `STAY-DEC-008` | Phase 03 | Low — belt and braces |
| A-04 | "One non-terminal pending X" invariants are enforced by partial unique indexes, not only by application logic | `RML-DEC-007`, `DEP-DEC-007`, `STAFF-DEC-009`, `STAY-DEC-010` | Phase 04 | Low |
| A-05 | Append-only tables are protected by database rules or triggers rejecting `UPDATE` and `DELETE`, not only by repository discipline | `CASH-DEC-004`, `INV-DEC-003`, `DEP-DEC-006` | Phase 03 | Low |
| A-06 | Permission names in code use the exact identifiers from doc 18 where the document names them (`OPERATION_READ`, `SUBSCRIPTION_REMINDER_SEND`, `REVIEW_MODERATE`, `WANTED_CASE_EXPORT`, and so on); hotel-side actions receive generated stable identifiers derived from the matrix rows | doc 18 §§3, 5, 6 | Phase 04 | Low |
| A-07 | The `Үндсэн касс` default drawer is created inside the onboarding provisioning transaction | `CASH-DEC-001`, doc 24 §2.1 | Phase 05 | Low |
| A-08 | Guest access codes, OTPs, invitation tokens and reset tokens are stored only as keyed HMAC digests bound to a purpose and a subject | `POL-DEC-022`, `RC-DEC-026`, `STAFF-DEC-001` | Phase 04 | Low |
| A-09 | Outbox delivery is at-least-once with consumer-side idempotency keys; Police matching consumes a minimal check-in event containing no financial or commercial fields | CLAUDE.md §3, doc 13 §3 | Phase 03 | Low |
| A-10 | Multi-role permission evaluation is a union of granted action permissions, intersected with the package entitlement gate | `RBAC-DEC-001`, `RBAC-DEC-003` | Phase 04 | Low |
| A-11 | Cleaner task claiming uses a single-statement conditional update on `assignment_version`, satisfying the one-atomic-claim rule while P1-19's automatic SLA escalation stays deferred | doc 04 §8, `STAFF-DEC-007`, P1-19 | Phase 09 | Low |
| A-12 | Provider events are deduplicated on `(provider, provider_event_id)` with a unique constraint, and payments on `(provider, merchant, provider_payment_id)` | `PAY-DEC-005`, `ONB-DEC-008` | Phase 03 | Low |

---

## 4. P1 configuration register

[docs/00-mvp-open-decisions.md](../00-mvp-open-decisions.md) §3 lists 17 P1 items. None reopens schema
or API design; each is implemented as versioned configuration with the interim default below, surfaced
in the admin or configuration layer, and confirmed before MVP handover in Phase 23.

| P1 | Item | Interim default used | Owning phase |
| --- | --- | --- | --- |
| P1-01 | Nearby radius and default sort | 5 km; availability first, then distance | 12 |
| P1-02 | Guest OTP TTL, resend and lockout | 5-minute TTL; 60-second resend; 5 attempts; IP and phone rate limit | 12 |
| P1-03 | Booking notification channels | In-app plus SMS to the verified phone, with SMS behind EXT-05 | 13 |
| P1-04 | Public listing minimum completeness | Required-field checklist, preview and an explicit publish action | 12 |
| P1-05 | Platform support access to guest data | **No** automatic access in MVP; the incident-approval flow is deferred | 17 |
| P1-06 | Restaurant menu detail | Item active or sold-out, quantity and note; add-ons deferred | 15 |
| P1-07 | SMS job cap, retry, retention and masking | Cap and retry configurable with a conservative default; body never logged | 19 |
| P1-08 | Police alert escalation minutes, routing and metrics | **Disabled in production without approved ЦЕГ configuration** (EXT-09) | 18 |
| P1-09 | Retention for non-guest data classes | Guest PII at 365 days confirmed; the audit, review, order, payment and SMS retention matrix is pending | 17 |
| P1-10 | Non-functional targets | Measurable acceptance targets defined in the architecture phase and re-asserted in Phase 22 | 01 |
| P1-11 | Receipt and tax beyond the subscription eBarimt | The ledger carries tax fields; room, minibar, booking receipts and VAT numbering are deferred | 17 |
| P1-12 | Audit viewer, filters, retention and alerts | The per-module audit taxonomy is built as each module lands; the central viewer is deferred | 22 |
| P1-13 | Restaurant invitation, OTP and guest access TTLs | A unified security configuration table | 15 |
| P1-14 | Review UX and display-name masking | The review is opened from the completed-stay detail; first letter plus mask | 16 |
| P1-15 | Operation reset token TTL and email provider | 30-minute single-use link; previous tokens invalidated | 19 |
| P1-17 | Guest access code length, TTL and lockout | Six digits, valid until checkout, rate-limited, hashed storage | 15 |
| P1-19 | Cleaner queue atomic claim and SLA | Atomic claim implemented per A-11; automatic timeout and escalation deferred | 09 |

---

## 5. Explicitly deferred scope

Recorded so that no phase implements it by accident (doc 00 §5, plus module-level deferrals).

- Restaurant menu add-ons, minimum order and quantity limits beyond the P1-06 minimum.
- Automatic and scheduled SMS campaigns, and a two-way SMS inbox.
- Hotel account recovery when the registered email is inaccessible — a Platform Super Admin offline
  procedure, not an Operation Dashboard feature.
- Police Admin bulk export of the all-hotel check-in list, which is closed to every role in MVP.
- Registration of additional co-occupants beyond the single primary guest per stay.
- Merging restaurant payments into hotel checkout, deposit, cash drawer or shift revenue.
- The nightly early-morning or business-day cutoff configuration (`STAY-DEC-007` deferred boundary).
- Retroactive Police matching against already-checked-out stays (`POL-DEC-017`).
- Any change to a confirmed booking's or an active stay's `planned_checkout_at` — no extension,
  shortening, amendment or hourly-to-nightly conversion exists in MVP (`STAY-DEC-012`).
  `STAY-DEC-011` is a post-MVP invariant only; no amendment instance may be created.
- Package downgrade in any form (`LIFE-DEC-001`).
- Subscription refunds (`SUB-DEC-009`); duplicate charges and chargebacks are finance exceptions, not
  product refunds.
- Relocation to a different hotel, or compensation, for hotel-caused overbooking (`BK-DEC-014`).

---

## 6. Conflict escalation protocol

If a phase discovers a genuine contradiction — not wording drift — between two documents at the same
precedence level, or between doc 00 and a module document:

1. Stop implementation of the affected area.
2. Record the exact quoted text from both sources here, with document and line references.
3. Record the design decision that each reading would force.
4. Report the conflict in the phase report and **do not** pick a reading unilaterally.

Wording drift that precedence resolves cleanly is recorded in §2 and does not stop work.
