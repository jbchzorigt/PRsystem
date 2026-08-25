# 10 — Money and Time Invariants

The specification `packages/money` and `packages/time` implement in Phase 03, and every module obeys.

---

## 1. Money

### 1.1 Representation

| Concept | Type | Rule |
| --- | --- | --- |
| Amount | `bigint` MNT | Whole tögrög. No subunit exists in these requirements. Never `number`, never `numeric` with a scale, never a string parsed at the edge |
| Rate | `integer` basis points | `5% = 500 bps`. Never a decimal fraction (`PAY-DEC-008`) |
| Quantity | `integer` | Stock, nights, half-hour units |

TypeScript exposes a branded `Mnt` type so an ordinary `number` cannot be passed where money is
expected. The Drizzle column type is `bigint`; the API serialises as a JSON string to avoid IEEE-754
truncation at the client boundary.

### 1.2 Rounding

Rounding happens **once**, at the point the requirements name, using `ROUND_HALF_UP`:

```
hourly_total_mnt   = ROUND_HALF_UP(effective_hourly_rate_mnt × half_hour_units / 2)   # STAY-DEC-014
nightly_total_mnt  = effective_nightly_rate_mnt × night_count                          # STAY-DEC-007, exact
commission_amount  = ROUND_HALF_UP(commission_base_mnt × contract_rate_bps / 10_000)   # PAY-DEC-008
```

Intermediate values stay exact. A pipeline never rounds twice, because rounding a rounded value drifts.

### 1.3 Arithmetic rules

- Addition and subtraction only on `Mnt`. Multiplication only by an `integer` quantity or a
  basis-point rate.
- Division exists solely inside the two rounding helpers above.
- No cross-currency arithmetic. Currency is validated on provider callbacks (`CTL-PROV-03`) but not
  modelled as a dimension (assumption **CTX-02**).

### 1.4 Balance identities

Balances are **derived from ledgers**, never stored and overwritten.

```
deposit_available = successful_receipt − receipt_reversal − allocated
                    − refund_reserved − refunded                      >= 0     # DEP-DEC-007

expected_drawer_cash = opening_snapshot + Σ(IN movements) − Σ(OUT movements)   # CASH-DEC-004
variance             = actual_counted_cash − expected_drawer_cash

stock_balance(location, product) = Σ(IN) − Σ(OUT)                     >= 0     # INV-DEC-005

hotel_total_stock = warehouse_balance + Σ(room_balances)                        # INV-DEC-002
```

Non-negativity is a database check evaluated **inside** the locking transaction, not an application
guard.

### 1.5 Weighted average cost

```
new_avg_cost = (prev_qty × prev_avg_cost + received_qty × received_unit_cost)
             / (prev_qty + received_qty)
```

Special cases fixed by `INV-DEC-004`: previous quantity zero → the new average equals the receipt unit
cost; a positive adjustment with no established cost requires the Manager to supply a unit cost.

**Every consuming movement snapshots the cost it used.** A later purchase can never retro-change a
past COGS figure, which is what makes historical gross profit stable (`FIN-DEC-003`).

### 1.6 Money never invented client-side

Unit price, totals, commission, refunds and balances are always recomputed server-side. A client value
is a hint for display, never an input to a decision (`CLAUDE.md` §4, `PRICE-DEC-007`,
`STAY-DEC-005`).

---

## 2. Time

### 2.1 Representation

| Concept | Storage | Rule |
| --- | --- | --- |
| Instant | `timestamptz`, UTC | Every event time |
| Hotel-local date | derived | Computed from the instant plus the hotel's IANA timezone |
| Timezone | `text` per hotel | `Asia/Ulaanbaatar` seed (assumption **CTX-01**) |
| Duration | `integer` minutes, `integer` half-hour units | Never a float (`STAY-DEC-014`) |
| Occupancy | `[start_at, end_at)` | End-exclusive (`STAY-DEC-008`) |

Client and device clocks are never authoritative. Server time is established once at the start of the
deciding transaction and reused throughout it, so a long transaction cannot straddle two "nows".

### 2.2 Business date rules

Business dates are hotel-local, event times are UTC. The two must never be conflated.

```
planned_checkout = hotel_local_date(check_in) + night_count days
                   at the fixed checkout time snapshotted at confirmation      # STAY-DEC-007
```

A check-in before the fixed checkout time still ends on the **next** calendar day for `N = 1`; a
shorter same-day stay must be booked hourly.

### 2.3 The three stay timestamps

| Field | Set by | Mutable |
| --- | --- | --- |
| `actual_check_in_at` | Reception, default server-now, backdatable ≤120 minutes at initial confirmation only | Never after activation |
| `check_in_recorded_at` | Server confirmation instant | Never |
| `effective_actual_check_in_at` | `latest approved amendment ?? actual_check_in_at` | Derived |

`check_in_recorded_at` is the anchor for everything that must not move: tariff and configuration
snapshots, the minibar price book, cash shift assignment and Police matching. Backdating
`actual_check_in_at` shifts the occupancy timeline only — never a financial effective time, never a
Police alert time (`STAY-DEC-009`, `POL-DEC-002`).

### 2.4 Backdate bound

```
earliest_allowed = max(server_now − 120 min,
                       current_open_shift.started_at,
                       hotel_local_day_start(server_now),
                       confirmed_booking.planned_checkin_at)
earliest_allowed <= actual_check_in_at <= server_now
```

The correction bound is anchored to the **original** `check_in_recorded_at`, so a long-running stay
cannot slide the window backwards (`STAY-DEC-010`).

### 2.5 Readiness anchors

```
planned_ready_not_before = planned_checkout_at + snapshotted_cleaning_buffer
actual_ready_not_before  = actual_checkout_at  + snapshotted_cleaning_buffer

room_reusable = now >= actual_ready_not_before
                AND cleaning_state = Цэвэр
                AND applicable_minibar_readiness = READY
```

Before an actual checkout exists, planning uses the planned anchor; once it exists, the actual anchor
is authoritative. The three conditions are independent — a clean room whose buffer has not elapsed is
not ready, and an elapsed buffer does not make a room clean (`STAY-DEC-008`).

### 2.6 Service months and calendar months

Subscription periods advance in **calendar months from the start instant**, not 30-day windows. When
the target month lacks the start day, the last day of that month at the same time is used —
31 January + 1 month = 28/29 February (`OPS-DEC-006`).

A **service month** is the monthly recurrence of the subscription start, used for upgrade effective
boundaries (`LIFE-DEC-002`). It is not the calendar month.

### 2.7 Grace and cutoffs

| Rule | Value | Source |
| --- | --- | --- |
| Subscription grace | `expires_at + 48 h` | `LIFE-DEC-003` |
| Expiring-soon threshold | `expires_at − as_of ≤ 168 h` | `OPS-DEC-005` |
| Booking payment hold | 10 minutes from server creation | `PAY-DEC-002` |
| Free cancellation boundary | 24 hours before planned check-in | `PAY-DEC-007` |
| No-show cutoff | arrival date `23:59:59` hotel-local | `PAY-DEC-007` |
| Review window | 30 days from `actual_checkout_at` | `RV-DEC-003` |
| Payout batch | `D+1 12:00 Asia/Ulaanbaatar` | `PAY-DEC-009` |
| Guest export file / URL | 1 hour / 5 minutes | `GUEST-DEC-007` |
| Police historical search window | 31 days per query | `POL-DEC-010` |

### 2.8 Report date bases

Each metric declares its own date basis; they are never mixed (`FIN-DEC-006`):

| Metric | Basis |
| --- | --- |
| Sales | charge `recognized_at` |
| Received money | payment success/effective time |
| Expense | payment effective time, `Paid` only |
| Refund/reversal | success/effective time |
| Top-5 rooms | stay `actual_checkout_at` |
| Deposit held | balance snapshot at period end |
| Guest registry ordering | `effective_actual_check_in_at` |

---

## 3. Verification

| Claim | Gate | Evidence |
| --- | --- | --- |
| No float reaches a money or duration column | `GATE-INTEG` | Schema introspection over every money/duration column |
| Rounding occurs once with `ROUND_HALF_UP` | `GATE-UNIT` | Property tests including `.5` boundaries |
| Balances never go negative under concurrency | `GATE-CONC` | Parallel allocation and refill suites |
| Cost snapshots are stable after later purchases | `GATE-INTEG` | Purchase after consumption leaves prior COGS unchanged |
| End-of-month clamping is correct | `GATE-UNIT` | 29/30/31-day boundary table |
| Backdate bound rejects out-of-window values | `GATE-INTEG` | Boundary table incl. shift start and local-day start |
| `[start,end)` adjacency is not an overlap | `GATE-INTEG` | Exclusion-constraint test with touching intervals |
| Readiness requires all three conditions | `GATE-INTEG` | Truth table over buffer, cleaning state, minibar readiness |
