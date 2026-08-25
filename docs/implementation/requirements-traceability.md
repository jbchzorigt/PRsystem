# PRsystem — Requirements Traceability

**Version:** 1.0 (Phase 00 inventory)
**Total canonical decisions:** 279 across 22 families.

Status legend: `PENDING` (not implemented) · `PARTIAL` · `COVERED` (implemented + gated) ·
`DEFERRED` (explicitly out of MVP, reason recorded).

`Code` and `Tests` columns are filled in by the phase that implements the decision. At Phase 00 every
row is `PENDING` with an assigned phase.

---

## 1. Family index

| Family | Source doc | IDs | Count | Phase |
| --- | --- | --- | ---: | --- |
| `RC-DEC` | 02 Reception scope | 001–044 | 44 | 06, 09, 10, 11, 12, 13, 14, 17 |
| `SHIFT-DEC` | 03 Shift handover | 001–007 | 7 | 09 |
| `STAY-DEC` | 05 Room stay & time | 001–014 | 14 | 06, 10 |
| `REST-DEC` | 08 Restaurant | 001–006 | 6 | 17 |
| `BK-DEC` | 09 Online booking | 001–014 | 14 | 15 |
| `RV-DEC` | 10 Ratings & reviews | 001–007 | 7 | 16 |
| `PAY-DEC` | 11 Booking payment policy | 001–009 | 9 | 15 |
| `GUEST-DEC` | 12 Guest registry | 001–008 | 8 | 13 |
| `POL-DEC` | 13 Police monitoring | 001–022 | 22 | 18 |
| `OPS-DEC` | 14 Operation dashboard | 001–018 | 18 | 19 |
| `ONB-DEC` | 15 Onboarding | 001–008 | 8 | 04 |
| `SUB-DEC` | 16 Subscription pricing | 001–009 | 9 | 04 |
| `LIFE-DEC` | 17 Subscription lifecycle | 001–007 | 7 | 04 |
| `RBAC-DEC` | 18 Permission matrix | 001–017 | 17 | 02, 05 |
| `STAFF-DEC` | 19 Staff lifecycle | 001–009 | 9 | 05 |
| `DEP-DEC` | 20 Deposit & correction | 001–010 | 10 | 11 |
| `CHK-DEC` | 21 Cleaner checkout exception | 001–006 | 6 | 12 |
| `INV-DEC` | 22 Minibar inventory | 001–008 | 8 | 07 |
| `FIN-DEC` | 23 Financial reporting | 001–010 | 10 | 14 |
| `CASH-DEC` | 24 Cash drawer ledger | 001–010 | 10 | 09 |
| `PRICE-DEC` | 25 Selling price snapshot | 001–008 | 8 | 12 |
| `RML-DEC` | 26 Room–minibar lifecycle | 001–028 | 28 | 06, 08 |

Docs `01`, `04`, `06`, `07` carry no own decision prefix; they are normative descriptive documents
whose rules resolve to the families above. Doc `00` is the precedence root.

---

## 2. RC-DEC — Reception system scope (doc 02)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| RC-DEC-001 | One consolidated bill per stay | 10 | PENDING |
| RC-DEC-002 | Deposit amount 50 000–100 000₮, hotel/category config | 06, 11 | PENDING |
| RC-DEC-003 | Deposit driven by booking source (walk-in vs online) | 10, 11 | PENDING |
| RC-DEC-004 | Deposit channels and deduction without extra approval | 11 | PENDING |
| RC-DEC-005 | Online booking source is the platform's own registry | 15 | PENDING |
| RC-DEC-006 | Manual POS vs integrated gateway card payment | 11 | PENDING |
| RC-DEC-007 | XYP unavailable → manual entry with provenance | 10 | PENDING |
| RC-DEC-008 | Cleaning status authority by package | 06, 10 | PENDING |
| RC-DEC-009 | Shift close authority | 09 | PENDING |
| RC-DEC-010 | Cleaner dashboard & minibar report | 12 | PENDING |
| RC-DEC-011 | Cleaner/minibar restricted to 25 000/30 000₮ | 02, 07 | PENDING |
| RC-DEC-012 | Hourly vs nightly stay model | 10 | PENDING |
| RC-DEC-013 | No automatic overdue fee | 10 | PENDING |
| RC-DEC-014 | Cleaning buffer between bookings | 06, 10 | PENDING |
| RC-DEC-015 | Separate room state axes / badges | 10, 20 | PENDING |
| RC-DEC-016 | Cleaner minibar refill from warehouse | 07, 12 | PENDING |
| RC-DEC-017 | Room readiness conditions | 10 | PENDING |
| RC-DEC-018 | Minibar optional per room; template required when ON | 08 | PENDING |
| RC-DEC-019 | Restaurant registration & access | 17 | PENDING |
| RC-DEC-020 | Food order confirmed only on QPay success | 17 | PENDING |
| RC-DEC-021 | Restaurant's own QPay merchant | 17 | PENDING |
| RC-DEC-022 | Restaurant ordering schedule | 17 | PENDING |
| RC-DEC-023 | Invoice validity vs closing time; late payment refund | 17 | PENDING |
| RC-DEC-024 | Restaurant-initiated refund authority | 17 | PENDING |
| RC-DEC-025 | Restaurant contact number visibility | 17 | PENDING |
| RC-DEC-026 | Room QR + one-time guest access code | 10, 17 | PENDING |
| RC-DEC-027 | ≤5 concurrent guest sessions per stay | 10, 17 | PENDING |
| RC-DEC-028 | Checkout with unfinished restaurant order | 10, 17 | PENDING |
| RC-DEC-029 | Checkout handoff option per order | 17 | PENDING |
| RC-DEC-030 | Restaurant acceptance 5/10-minute SLA | 17 | PENDING |
| RC-DEC-031 | Refund request resolution SLA | 17 | PENDING |
| RC-DEC-032 | Guest list & Excel export columns | 13 | PENDING |
| RC-DEC-033 | One primary guest per stay | 10, 13 | PENDING |
| RC-DEC-034 | Primary guest Police match boundary | 10, 18 | PENDING |
| RC-DEC-035 | Cleaner checkout exception & minibar dispute | 12 | PENDING |
| RC-DEC-036 | Minibar stock, cost and shortage override | 07 | PENDING |
| RC-DEC-037 | Hotel Admin financial reporting | 14 | PENDING |
| RC-DEC-038 | Cash drawer & physical cash ledger | 09 | PENDING |
| RC-DEC-039 | Minibar selling price snapshot | 12 | PENDING |
| RC-DEC-040 | Room/minibar entity lifecycle | 06, 08 | PENDING |
| RC-DEC-041 | Room minibar configuration change | 08 | PENDING |
| RC-DEC-042 | Explicit exact-version Rollout | 08 | PENDING |
| RC-DEC-043 | Multi-room Rollout batch | 08 | PENDING |
| RC-DEC-044 | MN/foreign/no-document primary guest identity | 10 | PENDING |

## 3. SHIFT-DEC — Reception shift handover (doc 03)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| SHIFT-DEC-001 | Operational and financial review states separate | 09 | PENDING |
| SHIFT-DEC-002 | Opening balance from actual counted cash | 09 | PENDING |
| SHIFT-DEC-003 | `Өөрөө хаасан` is operational terminal | 09 | PENDING |
| SHIFT-DEC-004 | Hotel Admin self-review fallback | 09 | PENDING |
| SHIFT-DEC-005 | Rejection never reopens a closed shift | 09 | PENDING |
| SHIFT-DEC-006 | Immutable opening + linked correction | 09 | PENDING |
| SHIFT-DEC-007 | Shift audit requirements | 09 | PENDING |

## 4. STAY-DEC — Room stay & time (doc 05)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| STAY-DEC-001 | Nightly stay uses fixed hotel checkout time | 06, 10 | PENDING |
| STAY-DEC-002 | Hourly base price formula | 10 | PENDING |
| STAY-DEC-003 | No automatic overdue charge | 10 | PENDING |
| STAY-DEC-004 | Cleaning duration + actual clean state | 06, 10 | PENDING |
| STAY-DEC-005 | Tariff precedence, snapshot, permission | 06 | PENDING |
| STAY-DEC-006 | No configurable hourly min/max/increment | 06 | PENDING |
| STAY-DEC-007 | Nightly calendar, price, early-arrival rule | 10 | PENDING |
| STAY-DEC-008 | Exclusive-end interval + planned/actual readiness | 10 | PENDING |
| STAY-DEC-009 | Initial actual check-in + 120-minute backdate | 10 | PENDING |
| STAY-DEC-010 | Active-stay actual-time immutable correction | 10 | PENDING |
| STAY-DEC-011 | Planned-checkout direct-overwrite guard | 10 | PENDING |
| STAY-DEC-012 | No planned-checkout change in MVP | 10 | PENDING |
| STAY-DEC-013 | Overdue conflict blocker + deterministic remedy | 10 | PENDING |
| STAY-DEC-014 | Half-hour fractional hourly stay precision | 10 | PENDING |

## 5. REST-DEC — Restaurant (doc 08)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| REST-DEC-001 | Separate order/fulfillment/payment/refund/handoff axes | 17 | PENDING |
| REST-DEC-002 | Acceptance vs refund-request race | 17 | PENDING |
| REST-DEC-003 | Fulfillment ETA 15/30/45/60 | 17 | PENDING |
| REST-DEC-004 | Checkout handoff terminal events | 17 | PENDING |
| REST-DEC-005 | Closing / late payment mandatory refund | 17 | PENDING |
| REST-DEC-006 | Actor boundaries and unresolved-SLA link pause | 17 | PENDING |

## 6. BK-DEC — Online booking (doc 09)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| BK-DEC-001 | Public search by date/location/current position | 15 | PENDING |
| BK-DEC-002 | e-Mongolia or phone-OTP booking authentication | 15 | PENDING |
| BK-DEC-003 | Booking payment routed through the platform | 15 | PENDING |
| BK-DEC-004 | Hotel ratings and reviews on listings | 16 | PENDING |
| BK-DEC-005 | Verified-stay review eligibility | 16 | PENDING |
| BK-DEC-006 | Review input rules and 30-day window | 16 | PENDING |
| BK-DEC-007 | Review edit and soft-delete | 16 | PENDING |
| BK-DEC-008 | Contract-specific commission rate | 15 | PENDING |
| BK-DEC-009 | 10-minute payment hold | 15 | PENDING |
| BK-DEC-010 | Cancellation and no-show framework | 15 | PENDING |
| BK-DEC-011 | Gateway fee is a platform cost | 15 | PENDING |
| BK-DEC-012 | MVP booking shape; booker vs staying guest | 15 | PENDING |
| BK-DEC-013 | Category inventory + physical room at check-in | 15 | PENDING |
| BK-DEC-014 | Hotel-caused fulfilment failure remedies | 15 | PENDING |

## 7. RV-DEC — Ratings & reviews (doc 10)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| RV-DEC-001 | Authenticated-user reviews only | 16 | PENDING |
| RV-DEC-002 | Verified-stay eligibility | 16 | PENDING |
| RV-DEC-003 | Rating, comment and review window | 16 | PENDING |
| RV-DEC-004 | Review edit and soft-delete | 16 | PENDING |
| RV-DEC-005 | Authenticated report + Platform moderation | 16 | PENDING |
| RV-DEC-006 | Hidden review restore | 16 | PENDING |
| RV-DEC-007 | One official hotel reply | 16 | PENDING |

## 8. PAY-DEC — Booking payment policy (doc 11)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| PAY-DEC-001 | Contract-specific commission, no 5% default | 15 | PENDING |
| PAY-DEC-002 | 10-minute inventory/payment hold | 15 | PENDING |
| PAY-DEC-003 | Cancellation/no-show framework | 15 | PENDING |
| PAY-DEC-004 | Gateway fee borne by platform | 15 | PENDING |
| PAY-DEC-005 | QPay and Khaan Bank gateway authority | 03, 15 | PENDING |
| PAY-DEC-006 | Hold expiry vs late/duplicate capture | 15 | PENDING |
| PAY-DEC-007 | Cancellation/no-show numeric rules | 15 | PENDING |
| PAY-DEC-008 | Commission base and rounding | 15 | PENDING |
| PAY-DEC-009 | Settlement lifecycle and D+1 payout | 15 | PENDING |

## 9. GUEST-DEC — Guest registry (doc 12)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| GUEST-DEC-001 | Admin/Manager guest registry access | 13 | PENDING |
| GUEST-DEC-002 | Six approved columns | 13 | PENDING |
| GUEST-DEC-003 | DOB-derived age snapshot | 13 | PENDING |
| GUEST-DEC-004 | Primary guest only | 13 | PENDING |
| GUEST-DEC-005 | Filters and server-side pagination | 13 | PENDING |
| GUEST-DEC-006 | 10 000-row background Excel job | 13 | PENDING |
| GUEST-DEC-007 | Private temporary export file | 13 | PENDING |
| GUEST-DEC-008 | 365-day retention and legal hold | 13 | PENDING |

## 10. POL-DEC — Police monitoring (doc 13)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| POL-DEC-001 | Wanted record creation via XYP or manual | 18 | PENDING |
| POL-DEC-002 | Match information and alert | 18 | PENDING |
| POL-DEC-003 | Police dashboard and Excel | 18 | PENDING |
| POL-DEC-004 | Police account activation | 18 | PENDING |
| POL-DEC-005 | Admin vs Officer visibility | 18 | PENDING |
| POL-DEC-006 | Match vs Found distinction | 18 | PENDING |
| POL-DEC-007 | Match concealed from hotel users | 18 | PENDING |
| POL-DEC-008 | Alert recipients and district routing | 18 | PENDING |
| POL-DEC-009 | Match SMS content | 18 | PENDING |
| POL-DEC-010 | All-hotel check-in list authority | 18 | PENDING |
| POL-DEC-011 | Alert acknowledgement and escalation | 18 | PENDING |
| POL-DEC-012 | Flexible Found confirmation by own account | 18 | PENDING |
| POL-DEC-013 | Scope of a Found outcome | 18 | PENDING |
| POL-DEC-014 | Found quick form | 18 | PENDING |
| POL-DEC-015 | Erroneous Found correction | 18 | PENDING |
| POL-DEC-016 | No Match ownership transfer | 18 | PENDING |
| POL-DEC-017 | Person–Case–Match model, exact identity boundary | 18 | PENDING |
| POL-DEC-018 | Manual identity approval and case lifecycle | 18 | PENDING |
| POL-DEC-019 | False Match two-person workflow | 18 | PENDING |
| POL-DEC-020 | No-exclusive-owner responsibility model | 18 | PENDING |
| POL-DEC-021 | Police permission and export boundary | 18 | PENDING |
| POL-DEC-022 | 4-digit bootstrap code + Police authentication | 18 | PENDING |

## 11. OPS-DEC — Operation dashboard (doc 14)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| OPS-DEC-001 | Dashboard purpose | 19 | PENDING |
| OPS-DEC-002 | SMS reminder tab | 19 | PENDING |
| OPS-DEC-003 | CallPro as SMS provider | 03, 19 | PENDING |
| OPS-DEC-004 | One-way SMS | 19 | PENDING |
| OPS-DEC-005 | 7-day expiring-soon threshold | 19 | PENDING |
| OPS-DEC-006 | Subscription start and expiry computation | 04 | PENDING |
| OPS-DEC-007 | Renewal period computation with grace | 04 | PENDING |
| OPS-DEC-008 | Operation-initiated password reset | 19 | PENDING |
| OPS-DEC-009 | Inaccessible-email recovery boundary | 19 | PENDING |
| OPS-DEC-010 | Manual-only SMS sending | 19 | PENDING |
| OPS-DEC-011 | Subscription list columns and default order | 19 | PENDING |
| OPS-DEC-012 | Subscription list filters and search | 19 | PENDING |
| OPS-DEC-013 | Application vs Hotel KPI boundary | 19 | PENDING |
| OPS-DEC-014 | KPI formulas and card filters | 19 | PENDING |
| OPS-DEC-015 | Operation security and contact change | 19 | PENDING |
| OPS-DEC-016 | Subscription state and suspension | 04, 19 | PENDING |
| OPS-DEC-017 | Paid reconciliation permission and outcomes | 19 | PENDING |
| OPS-DEC-018 | Provisioning retry and recovery permissions | 19 | PENDING |

## 12. ONB-DEC — Onboarding (doc 15)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| ONB-DEC-001 | Payment-gated activation | 04 | PENDING |
| ONB-DEC-002 | Citizen vs organization registration type | 04 | PENDING |
| ONB-DEC-003 | Initial Hotel Admin activation link | 04 | PENDING |
| ONB-DEC-004 | Mandatory registration fields | 04 | PENDING |
| ONB-DEC-005 | Ownership and duplication rules | 04 | PENDING |
| ONB-DEC-006 | Durable idempotent provisioning | 04 | PENDING |
| ONB-DEC-007 | Existing account/owner proof + canonical state | 04 | PENDING |
| ONB-DEC-008 | Payment retry, late/duplicate success | 04 | PENDING |

## 13. SUB-DEC — Subscription pricing (doc 16)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| SUB-DEC-001 | Monthly base price | 04 | PENDING |
| SUB-DEC-002 | Term total = monthly × months | 04 | PENDING |
| SUB-DEC-003 | No MVP discounts | 04 | PENDING |
| SUB-DEC-004 | QPay / Khaan Bank subscription gateways | 04 | PENDING |
| SUB-DEC-005 | eBarimt per confirmed payment | 04 | PENDING |
| SUB-DEC-006 | VAT-inclusive final price | 04 | PENDING |
| SUB-DEC-007 | Gateway provider fee borne by platform | 04 | PENDING |
| SUB-DEC-008 | Operator flow when eBarimt fails | 04, 19 | PENDING |
| SUB-DEC-009 | Subscription payments non-refundable | 04 | PENDING |

## 14. LIFE-DEC — Subscription lifecycle (doc 17)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| LIFE-DEC-001 | Upgrade-only, no downgrade | 04 | PENDING |
| LIFE-DEC-002 | Upgrade price and effective moment | 04 | PENDING |
| LIFE-DEC-003 | Expiry hard lock after 48h grace | 04 | PENDING |
| LIFE-DEC-004 | Public listing hidden after grace | 04, 15 | PENDING |
| LIFE-DEC-005 | Renewal inside grace period | 04 | PENDING |
| LIFE-DEC-006 | Paid pending upgrade + renewal serialization | 04 | PENDING |
| LIFE-DEC-007 | Higher renewal, boundary race, reconciliation owner | 04 | PENDING |

## 15. RBAC-DEC — Permission matrix (doc 18)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| RBAC-DEC-001 | Multi-role, explicit operational role | 02 | PENDING |
| RBAC-DEC-002 | Hotel action matrix | 02 | PENDING |
| RBAC-DEC-003 | Package entitlement gate | 02 | PENDING |
| RBAC-DEC-004 | Platform/Operation separation | 02 | PENDING |
| RBAC-DEC-005 | Police base matrix | 02, 18 | PENDING |
| RBAC-DEC-006 | Server-side enforcement | 02 | PENDING |
| RBAC-DEC-007 | Full financial report Hotel Admin only | 02, 14 | PENDING |
| RBAC-DEC-008 | Cleaner checkout exception permissions | 02, 12 | PENDING |
| RBAC-DEC-009 | Minibar inventory & shortage override permissions | 02, 07, 08 | PENDING |
| RBAC-DEC-010 | Expense lifecycle & financial report permissions | 02, 14 | PENDING |
| RBAC-DEC-011 | Shift self-close and review permissions | 02, 09 | PENDING |
| RBAC-DEC-012 | Cash drawer, transfer and payout permissions | 02, 09 | PENDING |
| RBAC-DEC-013 | Deposit config & correction permissions | 02, 11 | PENDING |
| RBAC-DEC-014 | Post-suspension unfinished work | 02, 05 | PENDING |
| RBAC-DEC-015 | Review & guest registry permissions | 02, 13, 16 | PENDING |
| RBAC-DEC-016 | Online cancellation/no-show/overbooking permissions | 02, 15 | PENDING |
| RBAC-DEC-017 | Explicit Operation permissions & takeover scope | 02, 19 | PENDING |

## 16. STAFF-DEC — Staff lifecycle (doc 19)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| STAFF-DEC-001 | Email invitation, user-created password | 05 | PENDING |
| STAFF-DEC-002 | Account vs membership | 05 | PENDING |
| STAFF-DEC-003 | Password reset and session revocation | 05 | PENDING |
| STAFF-DEC-004 | Role change and suspension effect | 05 | PENDING |
| STAFF-DEC-005 | No hard delete of staff history | 05 | PENDING |
| STAFF-DEC-006 | Single Primary Hotel Admin | 05 | PENDING |
| STAFF-DEC-007 | Post-suspension takeover / reassignment | 05 | PENDING |
| STAFF-DEC-008 | Membership revision, reactivation, takeover terminalization | 05 | PENDING |
| STAFF-DEC-009 | Invitation concurrency and one-membership invariant | 05 | PENDING |

## 17. DEP-DEC — Deposit & payment correction (doc 20)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| DEP-DEC-001 | Deposit source and amount | 11 | PENDING |
| DEP-DEC-002 | Normal deduction without extra approval | 11 | PENDING |
| DEP-DEC-003 | Original-channel refund | 11 | PENDING |
| DEP-DEC-004 | Alternate-channel refund exception | 11 | PENDING |
| DEP-DEC-005 | POS reference capture | 11 | PENDING |
| DEP-DEC-006 | Immutable financial correction | 11 | PENDING |
| DEP-DEC-007 | Reserved balance, concurrency, idempotency | 11 | PENDING |
| DEP-DEC-008 | Deposit permissions & immutable config snapshot | 11 | PENDING |
| DEP-DEC-009 | Refund release and late-success race | 11 | PENDING |
| DEP-DEC-010 | Late refund reconciliation owner & terminal posting | 11, 19 | PENDING |

## 18. CHK-DEC — Cleaner checkout exception (doc 21)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| CHK-DEC-001 | Cleaner report mandatory | 12 | PENDING |
| CHK-DEC-002 | Manager exception report | 12 | PENDING |
| CHK-DEC-003 | Pre-payment versioned correction | 12 | PENDING |
| CHK-DEC-004 | Payment lock and reconciliation | 12 | PENDING |
| CHK-DEC-005 | Post-payment immutable adjustment | 12 | PENDING |
| CHK-DEC-006 | Guest minibar dispute | 12 | PENDING |

## 19. INV-DEC — Minibar inventory (doc 22)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| INV-DEC-001 | Manager quantity is warehouse stock | 07 | PENDING |
| INV-DEC-002 | Warehouse and room balances separate | 07 | PENDING |
| INV-DEC-003 | Immutable inventory ledger | 07 | PENDING |
| INV-DEC-004 | Purchase cost and weighted average | 07 | PENDING |
| INV-DEC-005 | Negative stock prohibition | 07 | PENDING |
| INV-DEC-006 | Controlled shortage override | 07, 10 | PENDING |
| INV-DEC-007 | Minibar optional per room | 08 | PENDING |
| INV-DEC-008 | Inventory action permissions | 07, 08 | PENDING |

## 20. FIN-DEC — Financial reporting (doc 23)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| FIN-DEC-001 | Sales vs received money separate | 14 | PENDING |
| FIN-DEC-002 | Deposit and Restaurant exclusion | 14 | PENDING |
| FIN-DEC-003 | Minibar weighted-average COGS | 14 | PENDING |
| FIN-DEC-004 | No double deduction of inventory purchase | 14 | PENDING |
| FIN-DEC-005 | Expense submission, approval, payment execution | 14 | PENDING |
| FIN-DEC-006 | 7-day / month / custom ranges | 14 | PENDING |
| FIN-DEC-007 | Top-5 rooms | 14 | PENDING |
| FIN-DEC-008 | Four financial Excel exports | 14 | PENDING |
| FIN-DEC-009 | Effective-date correction | 14 | PENDING |
| FIN-DEC-010 | Full financial access Hotel Admin only | 14 | PENDING |

## 21. CASH-DEC — Cash drawer ledger (doc 24)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| CASH-DEC-001 | Default and multiple drawers | 04, 09 | PENDING |
| CASH-DEC-002 | Optional safe | 09 | PENDING |
| CASH-DEC-003 | Actual initial opening balance | 09 | PENDING |
| CASH-DEC-004 | Typed immutable ledger | 09 | PENDING |
| CASH-DEC-005 | Paid expense execution | 09, 14 | PENDING |
| CASH-DEC-006 | Drawer and safe transfers | 09 | PENDING |
| CASH-DEC-007 | Bank deposit and owner withdrawal | 09 | PENDING |
| CASH-DEC-008 | Cash top-up | 09 | PENDING |
| CASH-DEC-009 | Effective-date correction | 09 | PENDING |
| CASH-DEC-010 | Cash permissions and reporting | 09 | PENDING |

## 22. PRICE-DEC — Selling price snapshot (doc 25)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| PRICE-DEC-001 | Check-in stay price book | 12 | PENDING |
| PRICE-DEC-002 | Active-stay price isolation | 12 | PENDING |
| PRICE-DEC-003 | Normal and exception report pricing | 12 | PENDING |
| PRICE-DEC-004 | Report version and correction pricing | 12 | PENDING |
| PRICE-DEC-005 | Zero opening quantity and refill | 12 | PENDING |
| PRICE-DEC-006 | Products absent from the snapshot | 12 | PENDING |
| PRICE-DEC-007 | Server-authoritative price | 12 | PENDING |
| PRICE-DEC-008 | Selling price and cost kept separate | 12 | PENDING |

## 23. RML-DEC — Room–minibar lifecycle (doc 26)

| ID | Subject | Phase | Status |
| --- | --- | --- | --- |
| RML-DEC-001 | Unified `ACTIVE → RETIRING → INACTIVE` lifecycle | 06 | PENDING |
| RML-DEC-002 | Active stay and future booking protection | 06 | PENDING |
| RML-DEC-003 | Entity-specific deactivation blockers | 06 | PENDING |
| RML-DEC-004 | Historical snapshot protection | 06 | PENDING |
| RML-DEC-005 | Hard-delete limits | 06 | PENDING |
| RML-DEC-006 | Reactivation, permission, audit | 06 | PENDING |
| RML-DEC-007 | Current configuration + one pending change | 08 | PENDING |
| RML-DEC-008 | Active stay safe point | 08 | PENDING |
| RML-DEC-009 | ON → OFF reconciliation | 08 | PENDING |
| RML-DEC-010 | OFF → ON and shortage | 08 | PENDING |
| RML-DEC-011 | Template A → B delta reconciliation | 08 | PENDING |
| RML-DEC-012 | Future booking and effective config | 08 | PENDING |
| RML-DEC-013 | Action permission and task boundary | 08 | PENDING |
| RML-DEC-014 | Cancel, rollback, atomic apply, audit | 08 | PENDING |
| RML-DEC-015 | Entity, version and room configuration separate | 08 | PENDING |
| RML-DEC-016 | Draft, immutable Published, Archived history | 08 | PENDING |
| RML-DEC-017 | Multiple Published, Default, exact binding | 08 | PENDING |
| RML-DEC-018 | Publish validation | 08 | PENDING |
| RML-DEC-019 | First and subsequent Default | 08 | PENDING |
| RML-DEC-020 | Publish/Default isolation, entitlement, Rollout separation | 08 | PENDING |
| RML-DEC-021 | Version Archive blockers, history, permission | 08 | PENDING |
| RML-DEC-022 | Rollout target and eligible room | 08 | PENDING |
| RML-DEC-023 | Pending, blocker, safe-point task trigger | 08 | PENDING |
| RML-DEC-024 | Rollout isolation, apply, permission, batch boundary | 08 | PENDING |
| RML-DEC-025 | Batch parent, exact target, read-only preview | 08 | PENDING |
| RML-DEC-026 | Partial success, independent child, derived progress | 08 | PENDING |
| RML-DEC-027 | Cancel remaining, rollback, linked retry | 08 | PENDING |
| RML-DEC-028 | Target/Archive, concurrency, permission, audit | 08 | PENDING |

---

## 24. Cross-cutting invariant register

These invariants span families and must be re-asserted by every phase that touches them.

| Invariant | Sources | Enforced by |
| --- | --- | --- |
| MNT stored as bigint; rates as basis points; `ROUND_HALF_UP` once | PAY-DEC-008, STAY-DEC-014 | `packages/money`, DB column types |
| Occupancy interval `[start_at, end_at)` | STAY-DEC-008 | `packages/time`, exclusion constraint |
| Confirmation snapshots never repriced | STAY-DEC-005/007, PRICE-DEC-001/002 | immutable snapshot tables |
| Append-only financial and lifecycle history | DEP-DEC-006, CASH-DEC-004, INV-DEC-003, FIN-DEC-009 | DB triggers/constraints + repository policy |
| One non-terminal pending per scope | RML-DEC-007, DEP-DEC-007, STAY-DEC-010, STAFF-DEC-009 | partial unique indexes |
| Idempotency on every money/lifecycle command | ONB-DEC-006/008, PAY-DEC-005/006, REST-DEC-001 | `packages/outbox` idempotency store |
| Row lock / revision CAS where concurrency matters | LIFE-DEC-006/007, STAFF-DEC-008, RML-DEC-028 | `SELECT … FOR UPDATE`, `expected_revision` |
| Provider result is the only payment/refund authority | PAY-DEC-005, REST-DEC-001, DEP-DEC-003 | `packages/ports` |
| Late callback never reopens a terminal entity | PAY-DEC-006, REST-DEC-005, LIFE-DEC-006 | reconciliation queues |
| Package entitlement gates above role permission | RBAC-DEC-003, INV-DEC-008, RML-DEC-020 | `packages/authz` |
| Hotel Admin never inherits operational roles | RBAC-DEC-001 | `packages/authz` |
| Realm isolation Hotel / Guest / Operation / Police | RBAC-DEC-004, POL-DEC-007 | realm guards, separate schemas |
| No plaintext secrets in logs/audit/outbox/fixtures | POL-DEC-022, STAFF-DEC-001, OPS-DEC-008 | telemetry redaction + scanner (Phase 21) |
| Exact-RD-only Police matching, no fuzzy matching | POL-DEC-017, RC-DEC-044 | matching service |
| Restaurant money never enters hotel ledgers | RC-DEC-020, FIN-DEC-002, CASH-DEC-004 | ledger boundary tests |
