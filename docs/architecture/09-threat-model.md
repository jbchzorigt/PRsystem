# 09 — Threat Model

STRIDE per realm and per external interface. Every threat carries a mitigation, a control id and a
verifying gate.

**Method.** STRIDE applied to the trust boundaries in [08](08-trust-boundaries.md), scoped to the
assets in [07](07-data-classification.md). Likelihood/impact use a three-point scale;
**residual** is the risk remaining after the stated mitigation.

---

## 1. Assets and what "harm" means

| Asset | Harm |
| --- | --- |
| Guest personal data (C2/C3) | Legal exposure under the Law on Protection of Personal Information; loss of trust |
| Registration numbers (C3) | Identity misuse; a named legal risk in doc 12 §13 and doc 13 §17 |
| Police wanted/match data (C3, legal) | Tipping off a subject; unlawful disclosure; human-rights impact (EXT-10) |
| Money: folio, deposit, cash, booking settlement (C3) | Direct financial loss to hotel, guest or platform |
| Entitlement (subscription/package) | Revenue loss through unpaid feature access |
| Inventory and stock ledger | Shrinkage concealed by bad accounting |
| Audit trail | Loss of accountability; inability to investigate |
| Availability of check-in/checkout | Hotels cannot operate 24/7 |

---

## 2. Cross-cutting threats

| ID | STRIDE | Threat | Mitigation | Control | Gate | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| T-X-01 | Spoofing | Stolen session reused after suspension or password change | Server-side sessions, auth epoch bump, scope-targeted revocation | `CTL-SEC-03` | `GATE-CONC` | Low |
| T-X-02 | Tampering | Client sends `role`, `hotel_id`, `amount`, `paid` | Every such field discarded and recomputed | `CTL-AUTHZ-05` | `GATE-INTEG` | Low |
| T-X-03 | Repudiation | Actor denies a financial action | Append-only audit with actor, role set, reason, server time; denied attempts audited too | `CTL-AUDIT-01` | `GATE-INTEG` | Low |
| T-X-04 | Information disclosure | Sensitive value reaches a log, trace, URL or audit payload | Redacting logger, classification matrix, repo-wide scanner with planted canaries | `CTL-SEC-01` | `GATE-SEC` | Medium — needs continuous scanning |
| T-X-05 | Denial of service | Credential stuffing, OTP flooding, export flooding | Per-account/phone/device/IP rate limits, lockouts, background export with row cap | `CTL-CFG-01` | `GATE-INTEG` | Medium |
| T-X-06 | Elevation | Package gate bypassed by assigning a higher role | Entitlement evaluated above role; role assignment itself gated | `CTL-AUTHZ-03` | `GATE-INTEG` | Low |
| T-X-07 | Elevation | Hotel Admin performs an operational action without the extra role | No inheritance; matrix-driven denial | `CTL-AUTHZ-08` | `GATE-UNIT` | Low |
| T-X-08 | Tampering | Retry or duplicate submit creates a second business effect | Idempotency key on every money/lifecycle command | `CTL-CONC-03` | `GATE-CONC` | Low |
| T-X-09 | Tampering | Concurrent commands corrupt an aggregate | Row lock or revision CAS per [11](11-concurrency-strategy.md) | `CTL-CONC-01`, `CTL-CONC-02` | `GATE-CONC` | Low |
| T-X-10 | Information disclosure | Cross-tenant read via a swapped id | Five-layer tenant enforcement; denial indistinguishable from not-found | `CTL-AUTHZ-05` | `GATE-INTEG` | Low |
| T-X-11 | Information disclosure | A hand-written query or unscoped repository method bypasses the tenant predicate | Forced RLS on transaction-scoped server-derived context; missing context returns zero rows | `CTL-DATA-11` | `GATE-INTEG` | Low |
| T-X-12 | Information disclosure | A pooled connection retains a previous request's tenant context | `SET LOCAL` only, so context dies with the transaction; explicit leak test | `CTL-DATA-11` | `GATE-CONC` | Low |
| T-X-13 | Elevation | A background job runs unscoped across all tenants | Jobs carry explicit scope and set it transactionally; cross-tenant maintenance runs through named `SECURITY DEFINER` functions owned by `prsystem_maintenance_fn`, which holds **no** `BYPASSRLS` and sets scope one tenant at a time. `BYPASSRLS` belongs to the break-glass `prsystem_maintenance` alone, which nothing reaches and no maintenance job uses | `CTL-DATA-11` | `GATE-INTEG` | Low |
| T-X-14 | Repudiation | A financial effect commits while its audit record is lost | High-risk actions fail closed: an audit-write failure rolls back the effect | `CTL-DATA-12` | `GATE-INTEG` | Low |
| T-X-15 | Tampering | Audit is altered or purged to hide an action | Append-only rules, and runtime roles hold **no direct privilege on either audit stream at all**: they append only by executing the `SECURITY DEFINER` wrapper whose owner `prsystem_audit_writer` is the sole holder of `INSERT`, and they cannot read audit — scoped `SELECT` belongs to `prsystem_audit_reader` and `prsystem_police_audit_reader`. Removal only via an audited maintenance job under legal hold | `CTL-DATA-12` | `GATE-MIGR` · `GATE-INTEG` · `GATE-SEC` / `SEC-AUDIT` | Low |
| T-X-16 | Denial of service | A missing audit partition blocks high-risk actions | Partitions pre-created with a horizon alert before exhaustion | `CTL-DATA-12` | `GATE-INTEG` | Low |
| T-X-17 | Tampering | A critical decision is made from a stale projection — double allocation, double refund | Critical commands read authoritative rows under lock; projections carry `as_of`/lag | `CTL-BOUND-03` | `GATE-INTEG` | Low |
| T-X-18 | Information disclosure | Stored identifiers decrypted after key compromise | Envelope encryption, versioned DEKs wrapped by KMS, per-realm key scopes, rotation and rewrapping | `CTL-SEC-04` | `GATE-INTEG` | Low |
| T-X-19 | Information disclosure | Lookup tokens reversed by enumerating a small identifier space | Versioned **keyed** HMAC namespaced by identity type and country; unkeyed hashes prohibited | `CTL-SEC-04` | `GATE-UNIT` | Low |
| T-X-20 | Elevation | Key material read from source, config, a database row, a log or a fixture | Keys only in KMS/secret manager; `key_version` recorded, key bytes never; canary scan | `CTL-SEC-04` | `GATE-SEC` | Low |
| T-X-21 | Denial of service | KMS outage silently degrades to weaker protection | Fail closed: the operation fails, with no local-key fallback and no plaintext write | `CTL-SEC-04` | `GATE-INTEG` | Medium — availability trade accepted |

---

## 3. Guest realm

| ID | STRIDE | Threat | Mitigation | Control | Gate | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| T-G-01 | Spoofing | Account takeover by phone-number reuse or SIM swap | OTP proves control of the number only, never identity; check-in identity is verified separately by Reception | `CTL-SEC-02` | `GATE-INTEG` | Medium — inherent to SMS |
| T-G-02 | Spoofing | Automatic merge of an e-Mongolia account with an existing phone account | Merging forbidden without dual-channel verification; linkage audited | `CTL-AUTHZ-07` | `GATE-INTEG` | Low |
| T-G-03 | Information disclosure | Login error reveals whether a phone is registered | Uniform response for both cases | `CTL-SEC-01` | `GATE-INTEG` | Low |
| T-G-04 | Tampering | Guest replays a payment screenshot or a redirect to confirm a booking | Only a server-verified provider result confirms | `CTL-PROV-04` | `GATE-INTEG` | Low |
| T-G-05 | Elevation | Guest reviews a hotel without a completed stay, or reviews twice | Verified-stay eligibility; unique on `booking_id` | `CTL-DATA-07` | `GATE-INTEG` | Low |
| T-G-06 | Spoofing | Guest orders food from a room they are not in | Session bound to `hotel + room + stay`; room number never chosen by the guest | `CTL-AUTHZ-05` | `GATE-INTEG` | Low |
| T-G-07 | Denial of service | Brute force on a 4–6 digit guest access code | Hashed codes, attempt limits, temporary block per QR/IP/device, code invalidated on reissue | `CTL-SEC-02` | `GATE-INTEG` | Medium |
| T-G-08 | Information disclosure | Precise location of an anonymous searcher retained | Coordinates used transiently for ranking, never persisted to a profile | `CTL-SEC-01` | `GATE-INTEG` | Low |
| T-G-09 | Repudiation | Guest disputes a cancellation fee | Policy version, deadline and fee breakdown snapshotted on the booking before payment | `CTL-DATA-04` | `GATE-INTEG` | Low |

---

## 4. Hotel realm

| ID | STRIDE | Threat | Mitigation | Control | Gate | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| T-H-01 | Tampering | Reception edits a Cleaner minibar report to reduce a charge | Reception cannot edit report content; only return-for-correction; versions immutable | `CTL-DATA-03` | `GATE-INTEG` | Low |
| T-H-02 | Tampering | Charging a product that was never in the room | A charge line references a price-book line; absent products are unrepresentable | `CTL-DATA-04` | `GATE-INTEG` | Low |
| T-H-03 | Tampering | Reception invents or overrides a unit price | Server-authoritative tariff resolution and price book; no override path exists | `CTL-DATA-04` | `GATE-INTEG` | Low |
| T-H-04 | Tampering | Backdating a check-in to shift cash into a closed shift | Backdate bounded to 120 min, current open shift and hotel-local day; cash always posts to the current shift at server time | `CTL-DATA-02` | `GATE-INTEG` | Low |
| T-H-05 | Tampering | Editing a closed shift to hide a variance | Closed shift immutable; corrections are new effective-dated movements | `CTL-DATA-03` | `GATE-INTEG` | Low |
| T-H-06 | Tampering | Cash theft concealed by an unrecorded drawer transfer | Transfers lock both shifts, require recipient confirmation, and block shift close while pending | `CTL-CONC-01` | `GATE-CONC` | Low |
| T-H-07 | Tampering | Inventory shrinkage concealed as a positive adjustment | Adjustments require a reason and audit; positive adjustment never increases billable quantity | `CTL-AUDIT-01` | `GATE-INTEG` | Medium — detective, not preventive |
| T-H-08 | Elevation | Suspended employee finishes open work using a stale token | Suspension revokes permission and session immediately; unfinished work moves to a takeover queue | `CTL-SEC-03` | `GATE-CONC` | Low |
| T-H-09 | Elevation | Manager Plus created on a 25 000₮ hotel to reach 30 000₮ actions | Both the role grant and the action are package-gated | `CTL-AUTHZ-03` | `GATE-INTEG` | Low |
| T-H-10 | Information disclosure | Reception or Cleaner bulk-exports the guest registry | Bulk list and export restricted to Hotel Admin/Manager, and Manager Plus only on 30 000₮ | `CTL-AUTHZ-02` | `GATE-INTEG` | Low |
| T-H-11 | Information disclosure | Cleaner sees guest identity or prices | Task payloads carry product, quantity and room only | `CTL-AUTHZ-05` | `GATE-INTEG` | Low |
| T-H-12 | Tampering | Double check-in into an occupied or pending-configuration room | Exclusion constraint plus readiness and blocker re-check under lock | `CTL-DATA-06` | `GATE-CONC` | Low |
| T-H-13 | Repudiation | Disputed deposit deduction | Allocation records line, amount, actor, stay and time automatically | `CTL-AUDIT-01` | `GATE-INTEG` | Low |
| T-H-14 | Elevation | Hotel Admin self-approves an expense to extract cash | Permitted by `FIN-DEC-005` for small hotels, but `self_approved` and executor are recorded distinctly | `CTL-AUDIT-01` | `GATE-INTEG` | **Medium — accepted business risk** |
| T-H-15 | Denial of service | Configuration change left pending blocks a room indefinitely | Pending change is visible with a blocker badge; cancel and rollback paths are explicit | `CTL-CFG-01` | `GATE-INTEG` | Low |

---

## 5. Restaurant scope

| ID | STRIDE | Threat | Mitigation | Control | Gate | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| T-R-01 | Tampering | Order total manipulated client-side | Server recomputes from active menu items, prices and quantities | `CTL-AUTHZ-05` | `GATE-INTEG` | Low |
| T-R-02 | Tampering | Restaurant marks a refund complete without moving money | Only a verified provider result sets the refund axis to `REFUNDED` | `CTL-PROV-04` | `GATE-INTEG` | Low |
| T-R-03 | Tampering | Accept and refund-request race produces contradictory state | Row lock; first valid transition wins; axes remain independent | `CTL-CONC-01` | `GATE-CONC` | Low |
| T-R-04 | Information disclosure | Restaurant sees guest identity | Order payload carries room number and items only | `CTL-AUTHZ-05` | `GATE-INTEG` | Low |
| T-R-05 | Tampering | Order paid after closing enters production | Late payment forces `CANCELLED` + `PAID` + mandatory refund; never re-queued | `CTL-PROV-05` | `GATE-INTEG` | Low |
| T-R-06 | Information disclosure | Restaurant contact number harvested by non-customers | Number released only to a guest session owning that order | `CTL-AUTHZ-05` | `GATE-INTEG` | Low |

---

## 6. Police realm

| ID | STRIDE | Threat | Mitigation | Control | Gate | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| T-POL-01 | Information disclosure | Hotel staff learn a guest is wanted | Match data confined to the Police realm; no hotel-facing field, notification or API exposes it | `CTL-AUTHZ-01` | `GATE-INTEG` | Low |
| T-POL-02 | Information disclosure | Match existence inferred from response shape or latency | Hotel-facing responses, error text and observable latency identical under match/no-match | `CTL-AUTHZ-01` | `GATE-INTEG` | **Medium — needs an explicit timing test** |
| T-POL-03 | Elevation | Police Officer reaches the all-hotel check-in list | Admin-only, enforced at API and export, not merely in the UI | `CTL-AUTHZ-02` | `GATE-INTEG` | Low |
| T-POL-04 | Elevation | Police Admin performs Officer mutations by role name | Every mutation needs an explicit named permission | `CTL-AUTHZ-02` | `GATE-UNIT` | Low |
| T-POL-05 | Tampering | One officer self-approves their own False Match or Found correction | Backend compares immutable account ids; no bypass when no other approver exists | `CTL-AUTHZ-07` | `GATE-INTEG` | Low |
| T-POL-06 | Spoofing | 4-digit activation code brute-forced (10 000 space) | 5-minute TTL, single use, 3 attempts, 30-minute lock, 60-second resend, issue caps, keyed HMAC storage; unapproved exception falls back to ≥6 digits or SSO | `CTL-SEC-02` | `GATE-INTEG` | **Medium — accepted only with written ЦЕГ approval (EXT-10)** |
| T-POL-07 | Information disclosure | Full registration number leaks via SMS to a wrong or forwarded number | Only Police-Admin-verified official numbers; number changes require permission and re-verification; body never logged | `CTL-SEC-01` | `GATE-SEC` | **Medium — accepted risk recorded in doc 13 §10.2** |
| T-POL-08 | Tampering | Wanted identity altered to redirect matching | Identity revisions append-only; a material edit suspends dependent active cases until re-approved by a different actor | `CTL-DATA-03` | `GATE-INTEG` | Low |
| T-POL-09 | Repudiation | Officer denies confirming Found | Immutable account id, unit and server time recorded; correction is a separate two-person flow | `CTL-AUDIT-01` | `GATE-INTEG` | Low |
| T-POL-10 | Information disclosure | Bulk extraction via repeated exact searches | Exact-match only, rate-limited per account and device/IP, every search audited | `CTL-CFG-01` | `GATE-INTEG` | Medium |
| T-POL-11 | Elevation | Platform support reads Police data during an incident | No automatic access; separate schema and `prsystem_police` role ungranted to other runtimes; break-glass only under an approved ЦЕГ procedure | `CTL-AUTHZ-01` · `CTL-DATA-11` | `GATE-INTEG` | Low |
| T-POL-13 | Information disclosure | Police audit read by a platform operator | `police_audit` is a separate stream with separate grants, reachable only by `prsystem_police` | `CTL-DATA-12` | `GATE-INTEG` | Low |
| T-POL-14 | Information disclosure | Police identifiers decrypted using Hotel-realm key material | Distinct `pii.police` and `lookup.police_identity` key scopes with distinct grants | `CTL-SEC-04` | `GATE-INTEG` | Low |
| T-POL-12 | Denial of service | Escalation storm from duplicate matching runs | One Match per `(stay, wanted_person)`; alerts idempotent | `CTL-DATA-07` | `GATE-CONC` | Low |

---

## 7. Operation and Platform realm

| ID | STRIDE | Threat | Mitigation | Control | Gate | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| T-OP-01 | Elevation | Operation Admin takes over a hotel account via password reset | Reset link goes only to the pre-registered email; operator never sees token or password; email cannot be changed in this flow | `CTL-AUTHZ-02` | `GATE-INTEG` | Low |
| T-OP-02 | Elevation | Operation Admin changes the subscription contact to their own number | Contact change needs old **and** new phone OTP; the offline exception needs a distinct Platform permission plus recent MFA | `CTL-AUTHZ-07` | `GATE-INTEG` | Low |
| T-OP-03 | Tampering | Reconciliation queue used to grant entitlement without payment | Queue outcomes are terminal financial records only; they never apply package, term or expiry | `CTL-PROV-05` | `GATE-INTEG` | Low |
| T-OP-04 | Tampering | Provisioning retry mutates package, owner or term | Retry replays the immutable application/payment snapshot; unique constraints prevent duplicates | `CTL-CONC-03` | `GATE-CONC` | Low |
| T-OP-05 | Information disclosure | Mass SMS used to harvest or spam | Manual-only send with preview and explicit confirmation; no scheduler; one-way; recipients limited to subscription contacts | `CTL-CFG-01` | `GATE-INTEG` | Medium — cap remains P1-07 |
| T-OP-06 | Information disclosure | Full email or phone exposed in listings | Masked by default; exact search does not unmask | `CTL-SEC-01` | `GATE-INTEG` | Low |
| T-OP-07 | Elevation | Suspension used to extend a paid term | Suspension never pauses or extends `expires_at`; reactivation is a separate permissioned event | `CTL-CFG-01` | `GATE-INTEG` | Low |

---

## 8. External interfaces

| ID | Interface | STRIDE | Threat | Mitigation | Gate | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| T-E-01 | QPay / Khaan (EXT-03/04) | Spoofing | Forged callback credits an unpaid booking | Signature verification, dedup, field match, status re-query | `GATE-INTEG` | Low |
| T-E-02 | QPay / Khaan | Tampering | Late capture reopens an expired hold | Terminal state preserved; refund obligation raised | `GATE-CONC` | Low |
| T-E-03 | QPay / Khaan | Repudiation | Provider denies a refund the platform recorded | Refund only terminal on verified provider success; failures stay open | `GATE-INTEG` | Low |
| T-E-04 | XYP (EXT-01) | Spoofing | Fabricated identity response | Server-side call over the approved channel; provenance recorded; outage → `MANUAL` | `GATE-INTEG` | Medium until EXT-01 clears |
| T-E-05 | e-Mongolia (EXT-02) | Spoofing | Forged redirect grants a session | Server-to-server code exchange only | `GATE-INTEG` | Low |
| T-E-06 | CallPro (EXT-05) | Information disclosure | Provider or its subprocessor retains message bodies containing identifiers | Contractual data-processing terms; identifier masked in local records; body never logged | `GATE-SEC` | **Medium — EXT-05 + EXT-10** |
| T-E-07 | eBarimt (EXT-11) | Tampering | Operator hand-authors a receipt number | Operators cannot enter receipt fields; only official issuance sets them | `GATE-INTEG` | Low |
| T-E-08 | Maps (EXT-06) | Tampering | Manipulated distance changes ranking | Server-side computation; client distance ignored | `GATE-INTEG` | Low |
| T-E-09 | Object storage | Information disclosure | Export URL shared or leaked | Private bucket, five-minute signed URL, one-hour object TTL, permission re-checked at download | `GATE-INTEG` | Low |
| T-E-10 | Email | Information disclosure | Activation or reset link forwarded | Single use, short TTL, invalidated on reissue and on success | `GATE-INTEG` | Low |
| T-E-11 | Settlement bank (EXT-07) | Repudiation | Payout disputed | Per-batch reconciliation of gross, commission, refund, adjustment and payable with bank reference | `GATE-INTEG` | Medium until EXT-07 clears |

---

## 9. Residual risk register

Risks that remain **Medium** after mitigation, and who owns them.

| ID | Residual risk | Owner | Disposition |
| --- | --- | --- | --- |
| T-POL-06 | 4-digit Police bootstrap code | ЦЕГ | Requires written approval (EXT-10); otherwise ≥6 digits or SSO |
| T-POL-07 | Full registration number in Match SMS | ЦЕГ | Requires written approval and a provider data-processing agreement |
| T-POL-02 | Match existence inferable via timing | Engineering | Explicit timing-parity test in Phase 18; re-verified in Phase 22 |
| T-POL-10 | Bulk extraction via repeated exact search | ЦЕГ + Engineering | Rate limits plus periodic access-audit review (EXT-10) |
| T-H-07 | Inventory shrinkage concealed as adjustment | Hotel Admin | Detective control; visible in variance reporting |
| T-H-14 | Hotel Admin self-approved expense | Customer | Accepted business decision (`FIN-DEC-005`); audit distinguishes it |
| T-X-04 | Sensitive value reaching a log | Engineering | Continuous scanner; a finding is a release blocker in Phase 22 |
| T-X-05 | Resource-exhaustion denial of service | Engineering | Rate limits; concrete values are P1 configuration |
| T-G-01 | SIM-swap account takeover | Product | Inherent to SMS; check-in identity verified independently |
| T-G-07 | Guest access code brute force | Engineering | Attempt limits; exact values are P1-17 |
| T-OP-05 | SMS misuse | Operation | Manual-only send; per-job cap is P1-07 |
| T-E-06 | SMS provider retains identifiers | Legal | EXT-05 data-processing agreement |
| T-E-04 | XYP channel integrity | Legal + Engineering | EXT-01 contract, VPN, certificate, IP allowlist |
| T-E-11 | Settlement dispute | Finance | EXT-07 contract and reconciliation procedure |
| T-X-21 | KMS outage fails identifier flows closed | Engineering | Accepted availability trade: failing closed is preferred to weakened protection. Measured under fault injection in Phase 22 |

No residual risk is rated **High**. Every Medium either has a named external owner and a gate, or is a
decision the customer has already accepted in the requirements.

**Count:** 83 threats across §§2–8; 15 residual Medium; 0 High; 0 Critical.

---

## 10. Re-verification

The threat model is re-verified in **Phase 22** against the implemented system, and each threat's gate
must have executed. A new module, a new external interface or a new cross-realm data path requires an
ADR and a threat-model amendment before implementation.
