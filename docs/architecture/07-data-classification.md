# 07 — Data Classification

Five sensitivity classes, the handling rule for each, and where each class lives.

---

## 1. Classes

| Class | Definition | Examples |
| --- | --- | --- |
| **C0 — Public** | Intended for anonymous viewing | Hotel public name, photos, public phone, address, map location, published reviews, aggregate rating |
| **C1 — Internal** | Business data, tenant-scoped, not personal | Room numbers, tariffs, cleaning buffers, inventory balances, template versions, shift variances |
| **C2 — Personal** | Identifies or relates to a person | Guest name, date of birth, age, phone, email, booker contact, staff name and email, restaurant contact |
| **C3 — Sensitive personal / financial** | Elevated legal or financial harm | Registration number, passport number, other government id, guardian details, card/POS references, deposit and payment records, cash ledger, financial exports |
| **C4 — Secret** | Compromise breaks a security control | Passwords, OTPs, activation/reset/session tokens, guest access codes, provider credentials and webhook secrets, encryption keys, Police Match SMS bodies |

Wanted-person and Match data is **C3** with an additional legal constraint: it is confined to the
Police realm and is invisible to every other realm regardless of class rules
(`POL-DEC-007`).

---

## 2. Handling matrix

| Rule | C0 | C1 | C2 | C3 | C4 |
| --- | :---: | :---: | :---: | :---: | :---: |
| Anonymous read | ✓ | — | — | — | — |
| In application logs | ✓ | ✓ | id only | **never** | **never** |
| In traces / spans | ✓ | ✓ | id only | **never** | **never** |
| In analytics | ✓ | aggregate | — | — | — |
| In URLs or query strings | ✓ | ✓ | — | **never** | **never** |
| In error messages | ✓ | ✓ | — | **never** | **never** |
| In audit payloads | ✓ | ✓ | ✓ | reference or masked | **never** |
| In outbox payloads | ✓ | ✓ | minimal | keyed token only | **never** |
| In fixtures / seeds | ✓ | ✓ | synthetic | synthetic | synthetic |
| Encrypted at rest | — | — | — | ✓ | ✓ hashed/keyed |
| Export permitted | ✓ | with permission | with permission | explicit permission + audit | **never** |

C4 is never stored in a readable form. Passwords use a password hash; one-time codes use a keyed
HMAC bound to purpose and subject; provider secrets live in secret storage and are injected at
runtime (`CLAUDE.md` §8, `POL-DEC-022`, `RC-DEC-027`).

---

## 3. Class-specific rules taken directly from the requirements

### 3.1 Registration numbers and identity documents (C3)

- Stored as ciphertext. Exact matching uses a **separate keyed lookup token** namespaced by identity
  type and country, so the plaintext is never needed for a lookup (`RC-DEC-044`, doc 13 §6.3).
- Never written to ordinary application logs or analytics (doc 02 §3.1).
- Excluded from the guest registry list and its Excel export — the six approved columns contain no
  identifier (`GUEST-DEC-002`).
- Two audited exceptions exist inside the Police realm, both requiring written ЦЕГ approval
  (EXT-10): the full number in the Match SMS (`POL-DEC-009`) and in the Police Admin check-in list
  (`POL-DEC-010`). Wanted Case exports mask by default; the full value needs
  `WANTED_EXPORT_FULL_IDENTIFIER` plus recent step-up MFA (`POL-DEC-021`).

### 3.2 Age and date of birth (C2)

Age is **derived** server-side from the verified date of birth and the effective check-in date, then
snapshotted. No role may type an age. Date of birth itself is never an export column
(`GUEST-DEC-003`).

### 3.3 One-time codes and tokens (C4)

Guest access codes, staff invitations, password resets, Police activation codes and OTPs: hashed at
rest, single use, short-lived, rate-limited, and invalidated by a newer issue. The **value** is never
placed in an audit record, a log line or a URL (`RC-DEC-027`, `STAFF-DEC-001`, `POL-DEC-022`).

### 3.4 SMS bodies (C4 when they carry C3)

A Police Match SMS contains a full registration number. The body is therefore never persisted to
application logs, delivery logs or provider callback records; the identifier is masked in any
delivery record (doc 13 §10.2).

### 3.5 Financial records (C3)

Ledger rows, cash movements, deposit records and financial exports are C3. Financial Excel exports
must contain **no** guest registration number, phone, home address or other unnecessary personal data
(`FIN-DEC-008`, doc 23 §8).

### 3.6 Card data

The platform stores POS/gateway **references** only — approval code, transaction id, terminal id,
amount, timestamp. It never stores a PAN, CVV or full card payload (`DEP-DEC-005`, `CLAUDE.md` §8).

---

## 4. Retention

| Data | Default | Mechanism | Status |
| --- | --- | --- | --- |
| Guest registry personal data | 365 days from `actual_checkout_at` | `retention_policy_version`, `retention_days`, `retention_expires_at` snapshotted at checkout; deletion/anonymisation job; legal hold suspends it | Confirmed (`GUEST-DEC-008`) |
| Guest export file | 1 hour object TTL; 5-minute signed URL | Object lifecycle + signed URL expiry | Confirmed (`GUEST-DEC-007`) |
| Police check-in history | **Not defaulted** | Versioned configuration; without an approved value, historical search is disabled in production | Blocked by EXT-09 (`POL-DEC-010`) |
| Audit, review, restaurant order, payment, SMS logs | **Not defaulted** | Retention matrix per data class | Open — P1-09 |

Retention values are configuration rows with owner, legal basis, effective date and retroactivity —
never constants in code (doc 12 §9, doc 13 §13.2).

A legal hold suspends deletion for the named scope and records reason, authority reference, actor and
window. When it lapses, the retention job re-evaluates (`GUEST-DEC-008`).

---

## 5. Development and test data

- Synthetic identities only. Real registration numbers, addresses or case data must never appear in a
  non-production environment (`CLAUDE.md` §8, doc 13 §17).
- The synthetic factory in `packages/testing` generates structurally valid but reserved-range
  registration numbers, so exact-match logic is exercised without real personal data.
- Fixtures and seeds are scanned by the Phase 22 secret-leakage scanner alongside logs and traces.

---

## 6. Verification

| Claim | Gate | Evidence |
| --- | --- | --- |
| No C3/C4 value reaches logs, traces, audit payloads, outbox payloads, fixtures or seeds | `GATE-SEC` | Repository-wide scanner with known canary values planted in tests |
| Redacting logger drops classified fields even when passed explicitly | `GATE-UNIT` | Logger unit test asserting redaction by field name and by value shape |
| Identifier ciphertext is never returned by a non-Police endpoint | `GATE-INTEG` | Response-shape assertion per endpoint |
| Guest registry export contains exactly the six approved columns | `GATE-INTEG` | Column-set assertion |
| Financial exports contain no guest PII | `GATE-INTEG` | Column-set assertion |
| One-time codes are unreadable at rest | `GATE-INTEG` | Table introspection: no plaintext code column |
| Retention job honours legal hold | `GATE-INTEG` | Held rows survive expiry; unheld rows are removed |
