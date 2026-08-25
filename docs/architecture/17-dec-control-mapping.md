# 17 — DEC Control and Test Mapping

Every one of the 279 canonical decisions mapped to the architectural controls that enforce it and the
gates that prove it.

- Control catalog: §2 below.
- Gate catalog: [14](14-test-strategy-and-gates.md) §2.
- Owning phase per decision:
  [requirements-traceability.md](../implementation/requirements-traceability.md).

A decision is `COVERED` only when its owning phase has implemented the listed controls **and** the
listed gates have executed against them.

---

## 1. How to read a row

`CTL-*` values are the *primary* controls — the ones whose removal would break the decision. Every
command additionally inherits the universal controls in §2.1, which are not repeated per row.

---

## 2. Control catalog

### 2.1 Universal controls

Applied to every money- or lifecycle-changing command, so they are implicit in every row:

| Control | Mechanism |
| --- | --- |
| `CTL-TXN-01` | One database transaction per command |
| `CTL-CONC-03` | Idempotency key, unique in PostgreSQL |
| `CTL-AUDIT-01` | Append-only audit event with actor, realm, scope, before/after, reason, server time |
| `CTL-AUTHZ-02` | Named-permission check inside the seven-condition pipeline |

### 2.2 Authorization

| Control | Mechanism |
| --- | --- |
| `CTL-AUTHZ-01` | Realm guard and realm isolation |
| `CTL-AUTHZ-02` | Named action permission — never a role name |
| `CTL-AUTHZ-03` | Package entitlement gate, evaluated above role |
| `CTL-AUTHZ-04` | Account, hotel and subscription state gate incl. grace and hard lock |
| `CTL-AUTHZ-05` | Tenant and resource scope binding; client-supplied scope discarded |
| `CTL-AUTHZ-06` | Recent step-up MFA |
| `CTL-AUTHZ-07` | Separation of duties — requester ≠ approver, compared by immutable account id |
| `CTL-AUTHZ-08` | No role inheritance — explicit operational role required |

### 2.3 Data

| Control | Mechanism |
| --- | --- |
| `CTL-DATA-01` | Integer MNT and basis points; `ROUND_HALF_UP` once |
| `CTL-DATA-02` | UTC storage with hotel-local business dates; integer durations |
| `CTL-DATA-03` | Append-only table (rule or trigger rejecting `UPDATE`/`DELETE`) |
| `CTL-DATA-04` | Immutable snapshot captured at confirmation |
| `CTL-DATA-05` | Separate state axes; never one collapsed status column |
| `CTL-DATA-06` | Exclusion constraint on `[start, end)` occupancy |
| `CTL-DATA-07` | Partial unique index — at most one non-terminal per scope |
| `CTL-DATA-08` | Check constraint on balance non-negativity inside the locking transaction |
| `CTL-DATA-09` | Encrypted identifier plus keyed lookup token |
| `CTL-DATA-10` | Retention policy snapshot and legal hold |

### 2.4 Concurrency and transactions

| Control | Mechanism |
| --- | --- |
| `CTL-CONC-01` | `SELECT … FOR UPDATE` row lock on the aggregate root |
| `CTL-CONC-02` | Monotonic revision compare-and-set |
| `CTL-CONC-03` | Idempotency key store |
| `CTL-CONC-04` | Single-statement conditional claim |
| `CTL-TXN-01` | Single transaction per command |
| `CTL-TXN-02` | Transactional outbox |
| `CTL-TXN-03` | Reversal, correction or compensating record — never an in-place edit |

### 2.5 Providers

| Control | Mechanism |
| --- | --- |
| `CTL-PROV-01` | Signature or authenticity verification |
| `CTL-PROV-02` | Provider event dedup, unique on `(provider, provider_event_id)` |
| `CTL-PROV-03` | Provider, merchant, reference, amount and currency match |
| `CTL-PROV-04` | Server-to-server status re-query as the only payment authority |
| `CTL-PROV-05` | Fail-closed reconciliation queue owned by an explicit permission |

### 2.6 Security, boundaries and configuration

| Control | Mechanism |
| --- | --- |
| `CTL-AUDIT-01` | Append-only audit event |
| `CTL-SEC-01` | Redaction and data-classification handling |
| `CTL-SEC-02` | Keyed-hash one-time code with attempt, resend and lockout limits |
| `CTL-SEC-03` | Server-side session and auth-epoch revocation |
| `CTL-BOUND-01` | Module contract boundary, lint-enforced |
| `CTL-BOUND-02` | Cross-module read via projection or outbox event only |
| `CTL-CFG-01` | Versioned configuration; no hard-coded policy; absent value disables the feature |

---

## 3. RC-DEC — Reception scope (44)

| DEC | Controls | Gates |
| --- | --- | --- |
| RC-DEC-001 | CTL-DATA-05 · CTL-TXN-01 | GATE-INTEG |
| RC-DEC-002 | CTL-AUTHZ-08 · CTL-DATA-04 · CTL-CFG-01 | GATE-UNIT · GATE-INTEG |
| RC-DEC-003 | CTL-DATA-04 · CTL-AUTHZ-05 | GATE-INTEG |
| RC-DEC-004 | CTL-AUDIT-01 · CTL-TXN-01 | GATE-INTEG |
| RC-DEC-005 | CTL-BOUND-02 | GATE-INTEG |
| RC-DEC-006 | CTL-PROV-03 · CTL-DATA-05 | GATE-INTEG |
| RC-DEC-007 | CTL-PROV-05 · CTL-DATA-09 | GATE-INTEG |
| RC-DEC-008 | CTL-AUTHZ-02 · CTL-AUTHZ-03 | GATE-UNIT · GATE-INTEG |
| RC-DEC-009 | CTL-AUTHZ-07 · CTL-AUTHZ-08 | GATE-UNIT · GATE-INTEG |
| RC-DEC-010 | CTL-AUTHZ-03 · CTL-DATA-03 | GATE-INTEG |
| RC-DEC-011 | CTL-AUTHZ-03 | GATE-UNIT · GATE-INTEG |
| RC-DEC-012 | CTL-DATA-01 · CTL-DATA-02 | GATE-UNIT · GATE-INTEG |
| RC-DEC-013 | CTL-DATA-05 | GATE-INTEG |
| RC-DEC-014 | CTL-DATA-04 · CTL-DATA-06 | GATE-INTEG |
| RC-DEC-015 | CTL-DATA-05 | GATE-UNIT |
| RC-DEC-016 | CTL-TXN-01 · CTL-DATA-08 | GATE-CONC |
| RC-DEC-017 | CTL-DATA-06 · CTL-DATA-02 | GATE-INTEG |
| RC-DEC-018 | CTL-DATA-04 · CTL-CFG-01 | GATE-INTEG |
| RC-DEC-019 | CTL-AUTHZ-02 · CTL-AUTHZ-03 | GATE-INTEG |
| RC-DEC-020 | CTL-PROV-04 · CTL-DATA-05 | GATE-INTEG |
| RC-DEC-021 | CTL-BOUND-02 · CTL-PROV-03 | GATE-INTEG |
| RC-DEC-022 | CTL-DATA-02 · CTL-CFG-01 | GATE-INTEG |
| RC-DEC-023 | CTL-PROV-05 · CTL-DATA-02 | GATE-INTEG |
| RC-DEC-024 | CTL-AUTHZ-02 · CTL-PROV-04 | GATE-INTEG |
| RC-DEC-025 | CTL-AUTHZ-05 · CTL-SEC-01 | GATE-INTEG |
| RC-DEC-026 | CTL-SEC-02 · CTL-AUTHZ-05 | GATE-INTEG |
| RC-DEC-027 | CTL-CONC-01 · CTL-SEC-02 | GATE-CONC |
| RC-DEC-028 | CTL-DATA-05 · CTL-AUDIT-01 | GATE-INTEG |
| RC-DEC-029 | CTL-DATA-05 · CTL-AUDIT-01 | GATE-INTEG |
| RC-DEC-030 | CTL-CONC-01 · CTL-CFG-01 | GATE-CONC |
| RC-DEC-031 | CTL-CFG-01 · CTL-PROV-05 | GATE-INTEG |
| RC-DEC-032 | CTL-AUTHZ-02 · CTL-SEC-01 | GATE-INTEG |
| RC-DEC-033 | CTL-DATA-07 | GATE-INTEG |
| RC-DEC-034 | CTL-AUTHZ-01 · CTL-DATA-09 | GATE-INTEG |
| RC-DEC-035 | CTL-AUTHZ-02 · CTL-DATA-03 | GATE-INTEG |
| RC-DEC-036 | CTL-DATA-03 · CTL-DATA-08 · CTL-AUDIT-01 | GATE-INTEG |
| RC-DEC-037 | CTL-AUTHZ-02 · CTL-SEC-01 | GATE-INTEG |
| RC-DEC-038 | CTL-DATA-03 · CTL-CONC-01 | GATE-CONC |
| RC-DEC-039 | CTL-DATA-04 | GATE-INTEG |
| RC-DEC-040 | CTL-CFG-01 · CTL-DATA-03 | GATE-INTEG |
| RC-DEC-041 | CTL-DATA-07 · CTL-TXN-01 | GATE-CONC |
| RC-DEC-042 | CTL-DATA-07 · CTL-CONC-01 | GATE-CONC |
| RC-DEC-043 | CTL-CONC-03 · CTL-DATA-07 | GATE-CONC |
| RC-DEC-044 | CTL-DATA-09 · CTL-SEC-01 | GATE-INTEG |

## 4. SHIFT-DEC — Shift handover (7)

| DEC | Controls | Gates |
| --- | --- | --- |
| SHIFT-DEC-001 | CTL-DATA-05 | GATE-UNIT · GATE-INTEG |
| SHIFT-DEC-002 | CTL-DATA-04 · CTL-DATA-03 | GATE-INTEG |
| SHIFT-DEC-003 | CTL-DATA-05 · CTL-DATA-03 | GATE-INTEG |
| SHIFT-DEC-004 | CTL-AUTHZ-07 · CTL-AUDIT-01 | GATE-INTEG |
| SHIFT-DEC-005 | CTL-DATA-03 · CTL-TXN-03 | GATE-INTEG |
| SHIFT-DEC-006 | CTL-DATA-03 · CTL-TXN-03 | GATE-INTEG |
| SHIFT-DEC-007 | CTL-AUDIT-01 | GATE-INTEG |

## 5. STAY-DEC — Stay and time (14)

| DEC | Controls | Gates |
| --- | --- | --- |
| STAY-DEC-001 | CTL-DATA-02 · CTL-DATA-04 | GATE-UNIT · GATE-INTEG |
| STAY-DEC-002 | CTL-DATA-01 | GATE-UNIT |
| STAY-DEC-003 | CTL-DATA-05 | GATE-INTEG |
| STAY-DEC-004 | CTL-CFG-01 · CTL-DATA-04 | GATE-INTEG |
| STAY-DEC-005 | CTL-DATA-04 · CTL-AUTHZ-08 · CTL-AUDIT-01 | GATE-UNIT · GATE-INTEG |
| STAY-DEC-006 | CTL-CFG-01 | GATE-UNIT |
| STAY-DEC-007 | CTL-DATA-02 · CTL-DATA-04 | GATE-UNIT · GATE-INTEG |
| STAY-DEC-008 | CTL-DATA-06 · CTL-DATA-02 · CTL-CONC-01 | GATE-INTEG · GATE-CONC |
| STAY-DEC-009 | CTL-DATA-02 · CTL-DATA-04 · CTL-AUDIT-01 | GATE-INTEG |
| STAY-DEC-010 | CTL-DATA-07 · CTL-TXN-03 · CTL-AUTHZ-07 | GATE-INTEG · GATE-CONC |
| STAY-DEC-011 | CTL-DATA-03 | GATE-INTEG |
| STAY-DEC-012 | CTL-DATA-03 · CTL-DATA-05 | GATE-INTEG |
| STAY-DEC-013 | CTL-DATA-07 · CTL-CONC-01 | GATE-CONC |
| STAY-DEC-014 | CTL-DATA-01 · CTL-DATA-02 | GATE-UNIT |

## 6. REST-DEC — Restaurant (6)

| DEC | Controls | Gates |
| --- | --- | --- |
| REST-DEC-001 | CTL-DATA-05 · CTL-PROV-04 | GATE-UNIT · GATE-INTEG |
| REST-DEC-002 | CTL-CONC-01 · CTL-DATA-05 | GATE-CONC |
| REST-DEC-003 | CTL-DATA-02 · CTL-CFG-01 | GATE-INTEG |
| REST-DEC-004 | CTL-DATA-05 · CTL-AUDIT-01 | GATE-INTEG |
| REST-DEC-005 | CTL-PROV-05 · CTL-DATA-05 | GATE-INTEG |
| REST-DEC-006 | CTL-AUTHZ-02 · CTL-AUTHZ-05 · CTL-CFG-01 | GATE-INTEG |

## 7. BK-DEC — Online booking (14)

| DEC | Controls | Gates |
| --- | --- | --- |
| BK-DEC-001 | CTL-AUTHZ-05 · CTL-CFG-01 | GATE-INTEG |
| BK-DEC-002 | CTL-AUTHZ-01 · CTL-SEC-02 | GATE-INTEG |
| BK-DEC-003 | CTL-DATA-03 · CTL-PROV-04 | GATE-INTEG |
| BK-DEC-004 | CTL-DATA-05 | GATE-INTEG |
| BK-DEC-005 | CTL-DATA-07 · CTL-AUTHZ-05 | GATE-INTEG |
| BK-DEC-006 | CTL-DATA-02 · CTL-CFG-01 | GATE-UNIT · GATE-INTEG |
| BK-DEC-007 | CTL-DATA-03 · CTL-DATA-07 | GATE-INTEG |
| BK-DEC-008 | CTL-DATA-01 · CTL-DATA-04 | GATE-UNIT · GATE-INTEG |
| BK-DEC-009 | CTL-CONC-01 · CTL-DATA-02 | GATE-CONC |
| BK-DEC-010 | CTL-DATA-04 · CTL-DATA-05 | GATE-INTEG |
| BK-DEC-011 | CTL-DATA-03 · CTL-DATA-01 | GATE-INTEG |
| BK-DEC-012 | CTL-DATA-05 · CTL-DATA-04 | GATE-INTEG |
| BK-DEC-013 | CTL-CONC-01 · CTL-DATA-08 | GATE-CONC |
| BK-DEC-014 | CTL-AUTHZ-08 · CTL-TXN-03 | GATE-INTEG |

## 8. RV-DEC — Reviews (7)

| DEC | Controls | Gates |
| --- | --- | --- |
| RV-DEC-001 | CTL-AUTHZ-01 | GATE-INTEG |
| RV-DEC-002 | CTL-DATA-07 · CTL-AUTHZ-05 | GATE-INTEG · GATE-CONC |
| RV-DEC-003 | CTL-DATA-02 · CTL-CFG-01 | GATE-UNIT · GATE-INTEG |
| RV-DEC-004 | CTL-DATA-03 · CTL-AUDIT-01 | GATE-INTEG |
| RV-DEC-005 | CTL-AUTHZ-02 · CTL-DATA-07 | GATE-INTEG |
| RV-DEC-006 | CTL-AUTHZ-02 · CTL-DATA-03 | GATE-INTEG |
| RV-DEC-007 | CTL-DATA-07 · CTL-AUTHZ-03 | GATE-INTEG |

## 9. PAY-DEC — Booking payment policy (9)

| DEC | Controls | Gates |
| --- | --- | --- |
| PAY-DEC-001 | CTL-DATA-04 · CTL-CFG-01 | GATE-INTEG |
| PAY-DEC-002 | CTL-DATA-02 · CTL-CONC-01 | GATE-CONC |
| PAY-DEC-003 | CTL-DATA-04 · CTL-DATA-05 | GATE-INTEG |
| PAY-DEC-004 | CTL-DATA-03 | GATE-INTEG |
| PAY-DEC-005 | CTL-PROV-01 · CTL-PROV-02 · CTL-PROV-03 · CTL-PROV-04 | GATE-INTEG · GATE-CONC |
| PAY-DEC-006 | CTL-CONC-01 · CTL-PROV-05 | GATE-CONC |
| PAY-DEC-007 | CTL-DATA-01 · CTL-DATA-02 · CTL-DATA-05 | GATE-UNIT · GATE-INTEG |
| PAY-DEC-008 | CTL-DATA-01 · CTL-DATA-04 | GATE-UNIT |
| PAY-DEC-009 | CTL-DATA-03 · CTL-DATA-07 · CTL-TXN-03 | GATE-INTEG |

## 10. GUEST-DEC — Guest registry (8)

| DEC | Controls | Gates |
| --- | --- | --- |
| GUEST-DEC-001 | CTL-AUTHZ-02 · CTL-AUTHZ-03 · CTL-AUTHZ-05 | GATE-INTEG |
| GUEST-DEC-002 | CTL-SEC-01 | GATE-INTEG |
| GUEST-DEC-003 | CTL-DATA-02 · CTL-DATA-04 | GATE-UNIT · GATE-INTEG |
| GUEST-DEC-004 | CTL-DATA-07 | GATE-INTEG |
| GUEST-DEC-005 | CTL-AUTHZ-05 · CTL-CFG-01 | GATE-INTEG |
| GUEST-DEC-006 | CTL-AUTHZ-05 · CTL-CFG-01 · CTL-AUDIT-01 | GATE-INTEG |
| GUEST-DEC-007 | CTL-SEC-01 · CTL-CFG-01 | GATE-INTEG |
| GUEST-DEC-008 | CTL-DATA-10 · CTL-CFG-01 | GATE-INTEG |

## 11. POL-DEC — Police monitoring (22)

| DEC | Controls | Gates |
| --- | --- | --- |
| POL-DEC-001 | CTL-DATA-09 · CTL-PROV-05 | GATE-INTEG |
| POL-DEC-002 | CTL-BOUND-02 · CTL-DATA-04 · CTL-TXN-02 | GATE-INTEG · GATE-CONC |
| POL-DEC-003 | CTL-AUTHZ-02 · CTL-SEC-01 | GATE-INTEG |
| POL-DEC-004 | CTL-SEC-02 · CTL-SEC-03 | GATE-INTEG |
| POL-DEC-005 | CTL-AUTHZ-02 · CTL-AUTHZ-05 | GATE-UNIT · GATE-INTEG |
| POL-DEC-006 | CTL-DATA-05 | GATE-UNIT |
| POL-DEC-007 | CTL-AUTHZ-01 · CTL-BOUND-01 · CTL-SEC-01 | GATE-UNIT · GATE-INTEG |
| POL-DEC-008 | CTL-AUTHZ-05 · CTL-CFG-01 | GATE-INTEG |
| POL-DEC-009 | CTL-SEC-01 · CTL-CFG-01 | GATE-SEC |
| POL-DEC-010 | CTL-AUTHZ-02 · CTL-CFG-01 · CTL-AUDIT-01 | GATE-INTEG |
| POL-DEC-011 | CTL-CFG-01 · CTL-AUDIT-01 | GATE-INTEG |
| POL-DEC-012 | CTL-AUTHZ-02 · CTL-CONC-01 | GATE-CONC |
| POL-DEC-013 | CTL-DATA-05 · CTL-AUTHZ-02 | GATE-INTEG |
| POL-DEC-014 | CTL-DATA-04 · CTL-AUDIT-01 | GATE-INTEG |
| POL-DEC-015 | CTL-AUTHZ-07 · CTL-DATA-03 | GATE-INTEG |
| POL-DEC-016 | CTL-DATA-05 | GATE-UNIT |
| POL-DEC-017 | CTL-DATA-07 · CTL-DATA-09 · CTL-BOUND-02 | GATE-INTEG · GATE-CONC |
| POL-DEC-018 | CTL-AUTHZ-07 · CTL-DATA-03 | GATE-INTEG |
| POL-DEC-019 | CTL-AUTHZ-07 · CTL-DATA-03 · CTL-CONC-02 | GATE-INTEG · GATE-CONC |
| POL-DEC-020 | CTL-DATA-05 · CTL-AUDIT-01 | GATE-UNIT · GATE-INTEG |
| POL-DEC-021 | CTL-AUTHZ-02 · CTL-AUTHZ-06 · CTL-SEC-01 | GATE-UNIT · GATE-INTEG |
| POL-DEC-022 | CTL-SEC-02 · CTL-SEC-03 · CTL-AUTHZ-06 | GATE-INTEG · GATE-SEC |

## 12. OPS-DEC — Operation dashboard (18)

| DEC | Controls | Gates |
| --- | --- | --- |
| OPS-DEC-001 | CTL-AUTHZ-02 · CTL-BOUND-02 | GATE-INTEG |
| OPS-DEC-002 | CTL-AUTHZ-02 · CTL-CFG-01 | GATE-INTEG |
| OPS-DEC-003 | CTL-PROV-01 · CTL-SEC-01 | GATE-INTEG |
| OPS-DEC-004 | CTL-CFG-01 | GATE-INTEG |
| OPS-DEC-005 | CTL-DATA-02 | GATE-UNIT |
| OPS-DEC-006 | CTL-DATA-02 · CTL-CONC-03 | GATE-UNIT · GATE-INTEG |
| OPS-DEC-007 | CTL-DATA-02 · CTL-CONC-02 | GATE-UNIT · GATE-CONC |
| OPS-DEC-008 | CTL-AUTHZ-02 · CTL-SEC-01 · CTL-SEC-03 | GATE-INTEG |
| OPS-DEC-009 | CTL-AUTHZ-02 · CTL-AUTHZ-07 | GATE-INTEG |
| OPS-DEC-010 | CTL-CFG-01 · CTL-CONC-03 | GATE-INTEG |
| OPS-DEC-011 | CTL-SEC-01 · CTL-AUTHZ-05 | GATE-INTEG |
| OPS-DEC-012 | CTL-AUTHZ-05 · CTL-SEC-01 | GATE-INTEG |
| OPS-DEC-013 | CTL-DATA-05 · CTL-BOUND-02 | GATE-INTEG |
| OPS-DEC-014 | CTL-BOUND-02 · CTL-DATA-02 | GATE-UNIT · GATE-INTEG |
| OPS-DEC-015 | CTL-AUTHZ-06 · CTL-AUTHZ-07 · CTL-SEC-02 | GATE-INTEG |
| OPS-DEC-016 | CTL-AUTHZ-04 · CTL-CFG-01 | GATE-INTEG |
| OPS-DEC-017 | CTL-AUTHZ-02 · CTL-PROV-05 · CTL-AUTHZ-06 | GATE-INTEG |
| OPS-DEC-018 | CTL-AUTHZ-02 · CTL-CONC-03 · CTL-AUTHZ-06 | GATE-INTEG · GATE-CONC |

## 13. ONB-DEC — Onboarding (8)

| DEC | Controls | Gates |
| --- | --- | --- |
| ONB-DEC-001 | CTL-PROV-04 · CTL-AUTHZ-04 | GATE-INTEG |
| ONB-DEC-002 | CTL-DATA-04 | GATE-INTEG |
| ONB-DEC-003 | CTL-SEC-02 · CTL-TXN-02 | GATE-INTEG |
| ONB-DEC-004 | CTL-CFG-01 · CTL-SEC-01 | GATE-INTEG |
| ONB-DEC-005 | CTL-DATA-07 · CTL-AUTHZ-07 | GATE-INTEG |
| ONB-DEC-006 | CTL-TXN-01 · CTL-CONC-03 · CTL-TXN-02 | GATE-INTEG · GATE-CONC |
| ONB-DEC-007 | CTL-AUTHZ-07 · CTL-DATA-05 | GATE-INTEG |
| ONB-DEC-008 | CTL-CONC-01 · CTL-PROV-05 · CTL-PROV-02 | GATE-CONC |

## 14. SUB-DEC — Subscription pricing (9)

| DEC | Controls | Gates |
| --- | --- | --- |
| SUB-DEC-001 | CTL-DATA-01 · CTL-CFG-01 | GATE-UNIT |
| SUB-DEC-002 | CTL-DATA-01 | GATE-UNIT |
| SUB-DEC-003 | CTL-CFG-01 | GATE-UNIT |
| SUB-DEC-004 | CTL-PROV-04 · CTL-DATA-05 | GATE-INTEG |
| SUB-DEC-005 | CTL-PROV-05 · CTL-DATA-04 | GATE-INTEG |
| SUB-DEC-006 | CTL-DATA-01 · CTL-DATA-04 | GATE-UNIT |
| SUB-DEC-007 | CTL-DATA-03 · CTL-DATA-01 | GATE-INTEG |
| SUB-DEC-008 | CTL-PROV-05 · CTL-AUTHZ-02 · CTL-AUDIT-01 | GATE-INTEG |
| SUB-DEC-009 | CTL-CFG-01 · CTL-PROV-05 | GATE-INTEG |

## 15. LIFE-DEC — Subscription lifecycle (7)

| DEC | Controls | Gates |
| --- | --- | --- |
| LIFE-DEC-001 | CTL-CFG-01 · CTL-DATA-05 | GATE-UNIT · GATE-INTEG |
| LIFE-DEC-002 | CTL-DATA-01 · CTL-DATA-02 · CTL-DATA-04 | GATE-UNIT · GATE-INTEG |
| LIFE-DEC-003 | CTL-AUTHZ-04 · CTL-DATA-02 | GATE-INTEG |
| LIFE-DEC-004 | CTL-AUTHZ-04 · CTL-BOUND-02 | GATE-INTEG |
| LIFE-DEC-005 | CTL-DATA-02 · CTL-CONC-02 | GATE-INTEG |
| LIFE-DEC-006 | CTL-CONC-02 · CTL-DATA-07 · CTL-PROV-05 | GATE-CONC |
| LIFE-DEC-007 | CTL-CONC-02 · CTL-CONC-01 · CTL-PROV-05 | GATE-CONC |

## 16. RBAC-DEC — Permission matrix (17)

| DEC | Controls | Gates |
| --- | --- | --- |
| RBAC-DEC-001 | CTL-AUTHZ-08 · CTL-AUTHZ-02 | GATE-UNIT · GATE-INTEG |
| RBAC-DEC-002 | CTL-AUTHZ-02 | GATE-UNIT |
| RBAC-DEC-003 | CTL-AUTHZ-03 | GATE-UNIT · GATE-INTEG |
| RBAC-DEC-004 | CTL-AUTHZ-01 · CTL-AUTHZ-02 | GATE-UNIT · GATE-INTEG |
| RBAC-DEC-005 | CTL-AUTHZ-01 · CTL-AUTHZ-02 | GATE-UNIT |
| RBAC-DEC-006 | CTL-AUTHZ-02 · CTL-AUTHZ-05 | GATE-INTEG |
| RBAC-DEC-007 | CTL-AUTHZ-02 · CTL-AUTHZ-08 | GATE-UNIT · GATE-INTEG |
| RBAC-DEC-008 | CTL-AUTHZ-02 · CTL-AUTHZ-08 | GATE-UNIT |
| RBAC-DEC-009 | CTL-AUTHZ-03 · CTL-AUTHZ-08 | GATE-UNIT · GATE-INTEG |
| RBAC-DEC-010 | CTL-AUTHZ-02 · CTL-AUTHZ-07 | GATE-UNIT |
| RBAC-DEC-011 | CTL-AUTHZ-07 · CTL-AUTHZ-08 | GATE-UNIT |
| RBAC-DEC-012 | CTL-AUTHZ-02 · CTL-AUTHZ-08 | GATE-UNIT |
| RBAC-DEC-013 | CTL-AUTHZ-08 · CTL-AUTHZ-02 | GATE-UNIT |
| RBAC-DEC-014 | CTL-SEC-03 · CTL-CONC-04 | GATE-CONC |
| RBAC-DEC-015 | CTL-AUTHZ-02 · CTL-AUTHZ-03 | GATE-UNIT · GATE-INTEG |
| RBAC-DEC-016 | CTL-AUTHZ-02 · CTL-AUTHZ-08 | GATE-UNIT |
| RBAC-DEC-017 | CTL-AUTHZ-02 · CTL-AUTHZ-06 | GATE-UNIT · GATE-INTEG |

## 17. STAFF-DEC — Staff lifecycle (9)

| DEC | Controls | Gates |
| --- | --- | --- |
| STAFF-DEC-001 | CTL-SEC-02 · CTL-TXN-02 | GATE-INTEG |
| STAFF-DEC-002 | CTL-DATA-07 · CTL-AUTHZ-05 | GATE-INTEG |
| STAFF-DEC-003 | CTL-SEC-03 · CTL-SEC-02 | GATE-INTEG |
| STAFF-DEC-004 | CTL-SEC-03 · CTL-CONC-02 | GATE-CONC |
| STAFF-DEC-005 | CTL-DATA-03 | GATE-INTEG |
| STAFF-DEC-006 | CTL-DATA-07 | GATE-INTEG |
| STAFF-DEC-007 | CTL-SEC-03 · CTL-CONC-04 · CTL-AUTHZ-08 | GATE-CONC |
| STAFF-DEC-008 | CTL-CONC-02 · CTL-AUTHZ-02 | GATE-CONC |
| STAFF-DEC-009 | CTL-DATA-07 · CTL-CONC-02 · CTL-CONC-03 | GATE-CONC |

## 18. DEP-DEC — Deposit and correction (10)

| DEC | Controls | Gates |
| --- | --- | --- |
| DEP-DEC-001 | CTL-DATA-04 · CTL-CFG-01 | GATE-INTEG |
| DEP-DEC-002 | CTL-AUDIT-01 · CTL-TXN-01 | GATE-INTEG |
| DEP-DEC-003 | CTL-PROV-04 · CTL-DATA-05 | GATE-INTEG |
| DEP-DEC-004 | CTL-AUTHZ-08 · CTL-AUDIT-01 | GATE-INTEG |
| DEP-DEC-005 | CTL-PROV-03 · CTL-CFG-01 | GATE-INTEG |
| DEP-DEC-006 | CTL-TXN-03 · CTL-DATA-07 · CTL-DATA-03 | GATE-INTEG |
| DEP-DEC-007 | CTL-CONC-01 · CTL-CONC-02 · CTL-DATA-08 | GATE-CONC |
| DEP-DEC-008 | CTL-AUTHZ-08 · CTL-DATA-04 | GATE-UNIT · GATE-INTEG |
| DEP-DEC-009 | CTL-CONC-01 · CTL-PROV-05 · CTL-DATA-07 | GATE-CONC |
| DEP-DEC-010 | CTL-AUTHZ-02 · CTL-AUTHZ-06 · CTL-PROV-05 | GATE-INTEG |

## 19. CHK-DEC — Checkout exception (6)

| DEC | Controls | Gates |
| --- | --- | --- |
| CHK-DEC-001 | CTL-DATA-05 · CTL-AUTHZ-03 | GATE-INTEG |
| CHK-DEC-002 | CTL-AUTHZ-08 · CTL-AUDIT-01 | GATE-INTEG |
| CHK-DEC-003 | CTL-DATA-03 · CTL-AUTHZ-02 | GATE-INTEG |
| CHK-DEC-004 | CTL-CONC-01 · CTL-PROV-04 · CTL-DATA-07 | GATE-CONC |
| CHK-DEC-005 | CTL-TXN-03 · CTL-DATA-03 | GATE-INTEG |
| CHK-DEC-006 | CTL-AUTHZ-08 · CTL-DATA-05 | GATE-INTEG |

## 20. INV-DEC — Minibar inventory (8)

| DEC | Controls | Gates |
| --- | --- | --- |
| INV-DEC-001 | CTL-DATA-03 · CTL-DATA-04 | GATE-INTEG |
| INV-DEC-002 | CTL-DATA-03 · CTL-TXN-01 | GATE-INTEG · GATE-CONC |
| INV-DEC-003 | CTL-DATA-03 · CTL-TXN-03 | GATE-INTEG |
| INV-DEC-004 | CTL-DATA-01 · CTL-DATA-04 | GATE-UNIT · GATE-INTEG |
| INV-DEC-005 | CTL-DATA-08 · CTL-CONC-01 | GATE-CONC |
| INV-DEC-006 | CTL-AUTHZ-08 · CTL-DATA-04 · CTL-AUDIT-01 | GATE-INTEG |
| INV-DEC-007 | CTL-CFG-01 · CTL-DATA-05 | GATE-INTEG |
| INV-DEC-008 | CTL-AUTHZ-03 · CTL-AUTHZ-08 | GATE-UNIT · GATE-INTEG |

## 21. FIN-DEC — Financial reporting (10)

| DEC | Controls | Gates |
| --- | --- | --- |
| FIN-DEC-001 | CTL-DATA-05 · CTL-DATA-02 | GATE-INTEG |
| FIN-DEC-002 | CTL-BOUND-01 · CTL-DATA-05 | GATE-UNIT · GATE-INTEG |
| FIN-DEC-003 | CTL-DATA-04 · CTL-DATA-01 | GATE-INTEG |
| FIN-DEC-004 | CTL-DATA-05 · CTL-DATA-01 | GATE-INTEG |
| FIN-DEC-005 | CTL-DATA-05 · CTL-AUTHZ-02 · CTL-TXN-01 | GATE-INTEG |
| FIN-DEC-006 | CTL-DATA-02 | GATE-UNIT · GATE-INTEG |
| FIN-DEC-007 | CTL-DATA-02 · CTL-BOUND-02 | GATE-INTEG |
| FIN-DEC-008 | CTL-SEC-01 · CTL-AUTHZ-02 | GATE-INTEG |
| FIN-DEC-009 | CTL-TXN-03 · CTL-DATA-03 | GATE-INTEG |
| FIN-DEC-010 | CTL-AUTHZ-02 · CTL-AUTHZ-08 | GATE-UNIT · GATE-INTEG |

## 22. CASH-DEC — Cash drawer ledger (10)

| DEC | Controls | Gates |
| --- | --- | --- |
| CASH-DEC-001 | CTL-DATA-07 · CTL-TXN-01 | GATE-CONC |
| CASH-DEC-002 | CTL-DATA-05 · CTL-DATA-03 | GATE-INTEG |
| CASH-DEC-003 | CTL-DATA-04 · CTL-AUDIT-01 | GATE-INTEG |
| CASH-DEC-004 | CTL-DATA-03 · CTL-DATA-05 | GATE-INTEG |
| CASH-DEC-005 | CTL-TXN-01 · CTL-DATA-05 | GATE-INTEG |
| CASH-DEC-006 | CTL-CONC-01 · CTL-TXN-01 · CTL-DATA-07 | GATE-CONC |
| CASH-DEC-007 | CTL-AUTHZ-02 · CTL-AUDIT-01 | GATE-INTEG |
| CASH-DEC-008 | CTL-DATA-03 · CTL-DATA-05 | GATE-INTEG |
| CASH-DEC-009 | CTL-TXN-03 · CTL-DATA-02 · CTL-AUTHZ-07 | GATE-INTEG |
| CASH-DEC-010 | CTL-AUTHZ-02 · CTL-AUTHZ-08 | GATE-UNIT · GATE-INTEG |

## 23. PRICE-DEC — Selling price snapshot (8)

| DEC | Controls | Gates |
| --- | --- | --- |
| PRICE-DEC-001 | CTL-DATA-04 · CTL-TXN-01 | GATE-INTEG |
| PRICE-DEC-002 | CTL-DATA-04 | GATE-INTEG |
| PRICE-DEC-003 | CTL-DATA-04 · CTL-AUTHZ-02 | GATE-INTEG |
| PRICE-DEC-004 | CTL-DATA-04 · CTL-DATA-03 | GATE-INTEG |
| PRICE-DEC-005 | CTL-DATA-04 · CTL-TXN-01 | GATE-INTEG |
| PRICE-DEC-006 | CTL-DATA-04 · CTL-BOUND-02 | GATE-INTEG |
| PRICE-DEC-007 | CTL-AUTHZ-05 · CTL-DATA-04 | GATE-INTEG |
| PRICE-DEC-008 | CTL-DATA-04 · CTL-DATA-01 | GATE-INTEG |

## 24. RML-DEC — Room and minibar lifecycle (28)

| DEC | Controls | Gates |
| --- | --- | --- |
| RML-DEC-001 | CTL-CFG-01 · CTL-DATA-05 | GATE-INTEG |
| RML-DEC-002 | CTL-DATA-04 · CTL-DATA-03 | GATE-INTEG |
| RML-DEC-003 | CTL-CFG-01 · CTL-DATA-07 | GATE-INTEG |
| RML-DEC-004 | CTL-DATA-04 · CTL-DATA-03 | GATE-INTEG |
| RML-DEC-005 | CTL-DATA-03 · CTL-AUTHZ-02 | GATE-INTEG |
| RML-DEC-006 | CTL-AUTHZ-08 · CTL-AUDIT-01 | GATE-INTEG |
| RML-DEC-007 | CTL-DATA-07 · CTL-CONC-01 | GATE-CONC |
| RML-DEC-008 | CTL-DATA-04 · CTL-DATA-05 | GATE-INTEG |
| RML-DEC-009 | CTL-TXN-01 · CTL-DATA-08 | GATE-INTEG |
| RML-DEC-010 | CTL-DATA-08 · CTL-AUTHZ-08 | GATE-INTEG |
| RML-DEC-011 | CTL-TXN-01 · CTL-DATA-03 | GATE-INTEG |
| RML-DEC-012 | CTL-DATA-04 · CTL-DATA-07 | GATE-INTEG |
| RML-DEC-013 | CTL-AUTHZ-02 · CTL-AUTHZ-05 | GATE-UNIT · GATE-INTEG |
| RML-DEC-014 | CTL-TXN-03 · CTL-TXN-01 · CTL-AUDIT-01 | GATE-INTEG |
| RML-DEC-015 | CTL-DATA-05 | GATE-UNIT |
| RML-DEC-016 | CTL-DATA-03 · CTL-DATA-04 | GATE-INTEG |
| RML-DEC-017 | CTL-DATA-07 · CTL-DATA-04 | GATE-INTEG |
| RML-DEC-018 | CTL-TXN-01 · CTL-CFG-01 | GATE-INTEG |
| RML-DEC-019 | CTL-DATA-07 · CTL-TXN-01 | GATE-CONC |
| RML-DEC-020 | CTL-AUTHZ-03 · CTL-AUTHZ-08 · CTL-DATA-04 | GATE-UNIT · GATE-INTEG |
| RML-DEC-021 | CTL-DATA-07 · CTL-CONC-01 · CTL-AUTHZ-03 | GATE-CONC |
| RML-DEC-022 | CTL-CFG-01 · CTL-DATA-04 | GATE-INTEG |
| RML-DEC-023 | CTL-TXN-01 · CTL-DATA-07 | GATE-CONC |
| RML-DEC-024 | CTL-TXN-01 · CTL-AUTHZ-03 · CTL-CONC-01 | GATE-CONC |
| RML-DEC-025 | CTL-DATA-04 · CTL-BOUND-02 | GATE-INTEG |
| RML-DEC-026 | CTL-DATA-05 · CTL-TXN-01 | GATE-INTEG · GATE-CONC |
| RML-DEC-027 | CTL-TXN-03 · CTL-DATA-03 | GATE-INTEG |
| RML-DEC-028 | CTL-CONC-03 · CTL-DATA-07 · CTL-AUTHZ-05 | GATE-CONC |

---

## 25. Coverage summary

| Metric | Value |
| --- | --- |
| Decisions mapped | 279 / 279 |
| Distinct controls used | 37 |
| Decisions requiring `GATE-CONC` | 45 |
| Decisions requiring `GATE-SEC` | 3 |
| Decisions whose primary control is `CTL-CFG-01` (policy is configuration, not code) | 31 |

Controls and gates cited here are validated for existence by
`node tools/validate-governance.mjs` check 11.
