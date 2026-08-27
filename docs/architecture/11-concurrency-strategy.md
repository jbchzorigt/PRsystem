# 11 — Concurrency Strategy

A catalogue of race classes and the mechanism each one uses. Choosing the mechanism is not a
per-feature judgement call; it follows from the race class.

---

## 1. Mechanisms

| Control | Mechanism | Use when |
| --- | --- | --- |
| `CTL-CONC-01` | `SELECT … FOR UPDATE` on the aggregate root | Two commands mutate one aggregate and must serialise |
| `CTL-CONC-02` | Monotonic revision + compare-and-set | A long-lived aggregate where a stale client or worker must lose |
| `CTL-CONC-03` | Idempotency key, unique in PostgreSQL | The same command may arrive twice |
| `CTL-CONC-04` | Single-statement conditional update | Claiming a task; the winner is decided by the database |
| `CTL-DATA-06` | Exclusion constraint | Interval overlap must be structurally impossible |
| `CTL-DATA-07` | Partial unique index | "At most one non-terminal X per scope" |
| `CTL-DATA-08` | Check constraint in the locking transaction | A balance must never go negative |
| `CTL-PROV-02` | Unique on `(provider, provider_event_id)` | Provider callbacks may repeat |

Redis is never used for any of these (`CLAUDE.md` §1, [02](02-container-and-deployment.md) §1.2).

---

## 2. Race classes

### R1 — Same aggregate, two writers

*Two Receptions check into one room; two allocations against one deposit; two movements on one shift.*

`CTL-CONC-01`. Lock the aggregate root, re-read state inside the lock, re-validate, write, commit.
Lock ordering is fixed to prevent deadlock: **hotel → room → stay → folio → deposit → drawer shift**.
A command needing two aggregates acquires in that order.

### R2 — Long-lived aggregate, stale actor

*Upgrade callback vs service-month boundary worker; invitation accept vs suspension; rollout confirm
vs a concurrent configuration change.*

`CTL-CONC-02`. The reader captures `expected_revision`; the writer updates
`… WHERE revision = expected_revision` and bumps it. Zero rows updated means the caller lost and must
re-read. Named revisions: `billing_revision` (`LIFE-DEC-006`), `membership_revision`
(`STAFF-DEC-008`), `assignment_version` (`STAFF-DEC-007`), deposit aggregate version
(`DEP-DEC-007`).

### R3 — Duplicate command

*Double-clicked submit; retried HTTP request; replayed provider callback.*

`CTL-CONC-03` for client commands, `CTL-PROV-02` for provider events. The idempotency row is inserted
in the same transaction as the effect; a duplicate hits the unique constraint and returns the stored
result. Because both live in PostgreSQL, a Redis flush cannot cause a duplicate effect.

### R4 — Scarce resource

*Last room in a category; last units of warehouse stock; the fifth guest session.*

`CTL-CONC-01` on the resource, plus `CTL-DATA-08` for the non-negativity check. Availability is
recomputed **inside** the lock; a value read before the lock is only a hint.

Category availability (`BK-DEC-013`):

```
available = eligible ACTIVE rooms
          − overlapping active holds
          − overlapping confirmed bookings
          − overlapping active stays
```

evaluated under a lock on the category inventory row at hold creation, at payment confirmation and
again at check-in.

### R5 — Interval overlap

*Booking or stay occupancy on one room.*

`CTL-DATA-06`: `EXCLUDE USING gist (room_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)`.
Adjacency is not overlap; the cleaning buffer is enforced separately as a readiness condition, not by
widening the interval (`STAY-DEC-008`).

### R6 — At most one pending

*One non-terminal configuration request per room; one pending actual-time correction per stay; one
active invitation per membership; one open conflict per booking; one non-terminal correction per
transaction.*

`CTL-DATA-07`: partial unique index over the scope key `WHERE state IN (non-terminal states)`. The
second attempt fails at the database, not in a service check that a concurrent request could slip past.

### R7 — Task claiming

*Two Cleaners open the same task; two Managers claim one takeover item.*

`CTL-CONC-04`: a single conditional update.

```sql
UPDATE task SET assignee = :actor, state = 'IN_PROGRESS', assignment_version = assignment_version + 1
WHERE id = :id AND state = 'PENDING'
RETURNING *;
```

Zero rows means someone else won; the caller is shown who and when. This satisfies the atomic-claim
requirement in doc 04 §8 while P1-19's automatic SLA escalation stays deferred.

### R8 — Timer versus event

*Hold expiry vs paid callback; service-month boundary vs upgrade callback; SLA timer vs restaurant
accept.*

Both contenders take the **same** lock on the same row and re-validate. The first valid transition
wins; the loser observes a terminal state and takes its documented alternative path — a refund
obligation, a reconciliation case, or a discretionary refund policy. Timers never bypass a lock and
never assume the entity is still in its prior state (`PAY-DEC-006`, `LIFE-DEC-007`, `REST-DEC-002`).

### R9 — Cross-aggregate atomicity

*Warehouse decrement plus room increment; drawer OUT plus drawer IN; provisioning creating hotel,
owner link, subscription and membership.*

One transaction, both sides, or neither. Partial results are forbidden: a transfer that debits without
crediting is a correctness defect (`INV-DEC-002`, `CASH-DEC-006`, `ONB-DEC-006`).

### R10 — Read-modify-write on a derived value

*Rating aggregate; batch progress; KPI counters.*

Recompute from the source rows inside the transaction, or rebuild the projection. Never
`value = value + 1` from an application-read value.

---

## 3. Transaction rules

1. One command, one transaction. No business decision spans two transactions.
2. No external call inside a transaction. Provider calls happen before the transaction (status
   query) or after commit (via outbox).
3. Server time is captured once per transaction.
4. Isolation is `READ COMMITTED` plus explicit locks. Where a race depends on rows that do not yet
   exist — a phantom — the constraint carries the guarantee (`CTL-DATA-06`, `CTL-DATA-07`), not the
   isolation level.
5. Lock ordering is fixed (§R1) and lock scope is minimal: no lock is held across user interaction.
6. Serialisation failures and deadlocks are retried at the command boundary, bounded, and only for
   idempotent commands.

---

## 4. Race register

Concrete races the requirements call out, and the mechanism each uses.

| Race | Class | Mechanism | Source |
| --- | --- | --- | --- |
| Two guests pay for the last category unit | R4 | Lock + availability recheck | `BK-DEC-013` |
| Hold expiry vs paid callback | R8 | Row lock; expiry queries provider once before deciding | `PAY-DEC-006` |
| Two providers pay one billing intent | R3 + R8 | First applies; second → `PAID_REQUIRES_RECONCILIATION` | `ONB-DEC-008` |
| Boundary worker vs upgrade callback | R2 + R8 | `billing_revision` CAS | `LIFE-DEC-007` |
| Suspension vs invitation accept | R2 | `membership_revision` CAS | `STAFF-DEC-008` |
| Two Managers claim one takeover item | R7 | Conditional update | `STAFF-DEC-007` |
| Two Cleaners claim one task | R7 | Conditional update | doc 04 §8 |
| Parallel refills vs scarce warehouse stock | R4 | Lock + non-negative check | `INV-DEC-005` |
| Duplicate rollout Confirm | R3 + R6 | Idempotency key + one-pending index | `RML-DEC-028` |
| Check-in vs configuration apply | R1 + R6 | Room lock; blocker re-check | `RML-DEC-007` |
| Two check-ins into one room | R1 + R5 | Lock + exclusion constraint | `STAY-DEC-008` |
| Deposit allocation vs refund reservation | R1 | Aggregate version lock + balance check | `DEP-DEC-007` |
| Released refund vs late provider success | R8 | Freeze + unique reconciliation case | `DEP-DEC-009` |
| Restaurant accept vs refund request | R8 | Order row lock; first valid transition | `REST-DEC-002` |
| Two officers confirm Found | R1 | Row lock; first wins; second sees who and when | `POL-DEC-012` |
| Duplicate matching run | R3 | Unique `(stay_id, wanted_person_id)` | `POL-DEC-017` |
| Drawer transfer confirm vs shift close | R1 + R9 | Both shifts locked; pending transfer blocks close | `CASH-DEC-006` |
| Two shifts opening on one drawer | R6 | Partial unique index | `CASH-DEC-001` |
| Sixth guest session | R4 | Count under lock at issue **and** redemption | `RC-DEC-027` |
| Concurrent review for one booking | R6 | Unique on `booking_id` | `RV-DEC-002` |
| Export scope changing between create and download | R2 | Re-check permission and scope at download | `GUEST-DEC-006` |

---

## 5. Testing concurrency

`GATE-CONC` runs against **real PostgreSQL**. Mocked repositories and SQLite cannot reproduce lock
behaviour and are not acceptable substitutes (`CLAUDE.md` §10).

Each race in §4 gets a test that:

1. opens two or more real connections;
2. synchronises them at a barrier inside the critical section;
3. releases them simultaneously;
4. asserts exactly one business effect, a deterministic winner, and a loser that observes a coherent
   terminal state;
5. asserts the audit trail records both attempts.

A race without a `GATE-CONC` test is not considered mitigated, regardless of the code.
