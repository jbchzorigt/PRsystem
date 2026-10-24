# Касс, сейф ба ээлжийн зөрүү Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ээлжийн зөрүү зөвхөн жинхэнэ дутагдлыг харуулдаг болохын тулд зочны бус бэлэн мөнгөний бүх урсгалыг (сейф, банк, эзэн, зардал, top-up, засвар) хариуцагчтай, холбоостой хөдөлгөөнөөр бүртгэх.

**Architecture:**
- `cash_drawer`-ийг `DRAWER`/`SAFE`/`IN_TRANSIT` байршил болгож өргөтгөнө. Бүх хөдөлгөөн нэг `cash_book` lock дор `cash_event`-д бичигдэнэ.
- Бусдын кассанд хүрэх хөдөлгөөн бүр `cash_movement_request`-ээр кассын эзний баталгаа авна.
- Урсгал бүр өөрийн service файлтай (`ShiftService`-ээс удамшина), цэвэр бодлогын дүрмүүд `cash_policy.py`-д (psycopg-гүй).
- Route-ууд `cash_api.install`-д, UI нь `reception.js`-ийн `cashTools`-д.

**Tech Stack:** Python 3.12, FastAPI, psycopg 3, PostgreSQL 17 (FORCE RLS), vanilla JS, Playwright (node).

**Spec:** `docs/superpowers/specs/2026-10-24-cash-shift-outflows-design.md`

## Global Constraints

- Branch: `main`-аас салгасан шинэ branch (`superpowers:using-git-worktrees`). Commit бүр дараах мөрүүдээр төгсөнө:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0134quKh15pa1B1v2xoyXVGU
  ```
- Хуучин migration-д гар хүрэхгүй (checksum). Шинэ migration: `081`–`087`, task бүр нэгийг нэмнэ.
- Шинэ хүснэгт бүр `079_xyp_lookup.sql`-ийн загвараар: `ENABLE` + `FORCE ROW LEVEL SECURITY`, `tenant_scope` policy, `REVOKE ALL ... FROM PUBLIC`. Runtime grant-ийг `tests/postgres_support.py`-ийн grant жагсаалт болон `docs/29` §runtime grants-д нэмнэ.
- `src/prsystem/cash_policy.py` psycopg import хийхгүй (CI domain job psycopg-гүй).
- Зөвхөн төгрөг (integer MNT, `common.money()`).
- Хөдөлгөөний нэр `docs/24` §5-тай яг ижил: `CASH_TOP_UP`, `PAID_CASH_EXPENSE`, `OWNER_OTHER_WITHDRAWAL`, `SAFE_TRANSFER_OUT/IN`, `TRANSIT_OUT/IN`, `BANK_DEPOSIT_OUT`, `CASH_CORRECTION_IN/OUT`, `COUNT_VARIANCE_IN/OUT`. Reservation: `MOVEMENT_RESERVED`, `MOVEMENT_RELEASED`.
- Анхдагч тохиргоо (spec §6.1, §6.7, §7.5): petty нэг удаа **50,000₮**, petty ээлж **100,000₮**, Manager-ийн шууд зардал **500,000₮**, Admin-д дамжуулах дүн **20,000₮** (`>`), давтамж **3**, тоолох доод хэмжээ **1,000₮** (`>=`).
- Хугацаа: withdrawal баталгаа **24 цаг**, дугтуй тоолох **24 цаг**, transit **48 цаг, Бямба/Ням тооцохгүй**, зөрүүний цонх **30 хоног**. Бүгд `Asia/Ulaanbaatar`.
- Command бүр: `idempotency_key` (`_receipt`/`_save_receipt`), `reason` хоосон биш ≤1000, амжилттай command бүр `self.event(...)` audit.
- Шинэ error code: `PETTY_LIMIT_EXCEEDED`, `DIRECT_EXPENSE_LIMIT_EXCEEDED`, `DRAWER_IN_CUSTODY`, `NO_ACTIVE_SHIFT`, `SAFE_NOT_CONFIGURED`, `SAFE_EXISTS`, `ENVELOPE_EXISTS`, `RECEIPT_REQUIRED`, `RECEIPT_ALREADY_LINKED`, `INVALID_RECEIPT`. Хуучнаас: `INSUFFICIENT_CASH`, `FORBIDDEN`, `WORK_NOT_OPEN`, `PENDING_SHIFT_OBLIGATIONS`, `INVALID_REASON`.
- UI текст Монгол хэлээр, `reception.js`-ийн `labels`/`errors` map-д нэмнэ.

## Plan-level refinements (spec-ийг нарийвчилсан, хэрэгжүүлэхээс өмнө захиалагчид мэдэгдсэн)

1. **"Hotel Admin-д сануулга"** (spec §6.2, §6.3, §6.4): push/SMS/email биш, `admin-overview`-д `overdue` тэмдэглэгээтэй жагсаалт болон UI badge. Гадаад мэдэгдлийн суваг development mock хэвээр байгаа тул шинэ provider нэмэхгүй.
2. **Зардлын ангилал:** tenant-ийн анхны уншилтаар `docs/23` §4.4-ийн 8 ангиллыг idempotent seed хийнэ; "Minibar бараа татан авалт" нь `INVENTORY_PURCHASE`, бусад нь `OPERATING`.
3. **Ресепшний тайлбар** (spec §8 нэмэлт санал 1): `cash_variance`-д append-only `shift_variance_note`; засах, устгахгүй.

## Review Focus

1. **Нэг кассанд зэрэг хоёр OUT хүсэлт** (Manager банк руу + ресепшн drop): available-аас давахгүй байх ёстой; хоёр дахь нь `INSUFFICIENT_CASH`. Тест: Task 3 `test_concurrent_requests_cannot_overdraw_available`.
2. **Кассын эзэн татгалзсаны дараа үүсгэгч ижил idempotency key-ээр дахин илгээх:** өмнөх (татгалзсан) хариуг replay хийнэ, шинэ хүсэлт үүсгэхгүй; шинэ key шаардлагатай. Тест: Task 3 `test_rejected_request_replays_and_new_key_creates_new`.
3. **Ээлж хүлээлцэлтийн дараа өмнөх ээлжид хамаарах pending хүсэлт:** хүлээлцэлт хориглогдсон тул үүсэх боломжгүй; гэвч хүсэлт `SUBMITTED` ээлж дээр ирвэл `WORK_NOT_OPEN`. Тест: Task 3 `test_request_against_submitted_shift_rejected`.
4. **Transit holder ажлаас гарсан, Admin "Буцааж тоолсон" гэж хаахад хүлээн авах касс custody-д байх:** `DRAWER_IN_CUSTODY`, сейф рүү хаах боломжтой. Тест: Task 7 `test_admin_close_into_custody_drawer_rejected_safe_allowed`.
5. **30 хоногийн цонхны зааг (орон нутгийн шөнө дунд):** UTC-ээр 30 хоног биш, буудлын цагаар 29 хоногийн өмнөх шөнө дундаас. Тест: Task 1 `test_variance_window_starts_at_local_midnight`.

---

## Орчин

```bash
cd PRsystem
python -m pip install -e ".[api,test]" tzdata
service postgresql start
export PRSYSTEM_TEST_ADMIN_DSN=postgresql://postgres:postgres@127.0.0.1:5432/postgres
export PRSYSTEM_BROWSER_PATH=<chromium path>
```

- PostgreSQL тест: `PYTHONPATH=src:tests python -m unittest tests.<module> -v`
- Domain тест: `PYTHONPATH=src python -m unittest tests.test_cash_policy -v`

## Файлын бүтэц

| Файл | Үүрэг |
| --- | --- |
| `src/prsystem/cash_policy.py` (шинэ) | Цэвэр дүрэм: тохиргоо, лимит, баримт, хугацаа, Admin-д дамжуулах, харагдах төлөв |
| `src/prsystem/subscription.py` | `Action.CASH_SAFEGUARD`, `Action.CASH_SPEND` |
| `src/prsystem/cash_locations.py` (шинэ) | Байршил унших, `post()` primitive, сейф үүсгэх, тохиргоо хадгалах |
| `src/prsystem/cash_movements.py` (шинэ) | §6.6 хүсэлт/хүлээн авах/татгалзах, top-up |
| `src/prsystem/shift_variance.py` (шинэ) | Зөрүүний бүртгэл, escalation, засвар, Manager-ийн буцаалт, маргааны hook |
| `src/prsystem/cash_safe.py` (шинэ) | Drop, дугтуй тоолох, сейфээс гаргах |
| `src/prsystem/cash_withdrawals.py` (шинэ) | Эзэн/бусдад мөнгө өгөх |
| `src/prsystem/cash_transit.py` (шинэ) | Банкинд тушаах |
| `src/prsystem/cash_expenses.py` (шинэ) | Petty ба шууд зардал, хяналт |
| `src/prsystem/cash_reports.py` (шинэ) | Admin/Manager/Reception-ий read model |
| `src/prsystem/cash_api.py` (шинэ) | Бүх шинэ route (`install(app, *, token, **services)`) |
| `src/prsystem/handover.py`, `shifts.py` | `finish()`-д escalation, `_pending()`-д §6.6, `review()`-д authority/засвар |
| `src/prsystem/api.py` | Service үүсгэж `cash_api.install` дуудах |
| `src/prsystem/static/reception.js` | `cashTools()` ба `shiftTools()` өргөтгөл |
| `src/prsystem/postgres/migrations/081`–`087` | Task бүрт нэг |
| `tests/test_cash_*.py`, `tests/test_shift_variance.py`, `tests/browser/cash.cjs` | Тест |

---

### Task 1: Цэвэр бодлого ба subscription action

**Files:**
- Create: `src/prsystem/cash_policy.py`
- Modify: `src/prsystem/subscription.py` (`Action`, `subscription_gate`)
- Test: `tests/test_cash_policy.py`, `tests/test_subscription.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) CashControlSettings(petty_single=50000, petty_shift=100000, direct_limit=500000, escalation_amount=20000, escalation_count=3, counting_floor=1000)` + `.validate() -> None` (`INVALID_REQUEST`: `money()` бүгдэд, `escalation_count >= 1`, `petty_single <= petty_shift`).
  - `check_petty(settings, amount: int, spent_in_shift: int) -> None` → `PETTY_LIMIT_EXCEEDED`.
  - `check_direct(settings, amount: int, *, admin: bool) -> None` → `DIRECT_EXPENSE_LIMIT_EXCEEDED` (admin бол хэзээ ч).
  - `class ReceiptType(StrEnum): EBARIMT_ORG, EBARIMT_PERSONAL, PAPER, NONE`; `validate_receipt(kind: str, number: str | None, reason: str | None) -> dict` → `{'receipt_type','receipt_number','receipt_reason'}` эсвэл `INVALID_RECEIPT`. Дүрэм: `EBARIMT_ORG` number; `EBARIMT_PERSONAL` number + reason; `PAPER` number; `NONE` reason. Number 1–64, reason 1–1000 тэмдэгт.
  - `transit_deadline(started_at: datetime) -> datetime` (aware) — Даваа–Баасан орон нутгийн цагаар 48 цаг.
  - `envelope_overdue(dropped_at: datetime, now: datetime) -> bool` (`now >= dropped_at + 24h`).
  - `withdrawal_overdue(recorded_at, now) -> bool` (24 цаг).
  - `variance_window_start(now: datetime) -> datetime` — `now`-ийн орон нутгийн огнооноос 29 хоногийн өмнөх 00:00 (Asia/Ulaanbaatar), UTC aware.
  - `escalation_required(variance: int, prior_counted: int, settings) -> bool` — `abs(variance) > escalation_amount` эсвэл (`abs(variance) >= counting_floor` ба `prior_counted + 1 >= escalation_count`).
  - `display_state(shift_state, handover_state: str | None, review_state, self_close: bool, custody_held: bool) -> str` — spec §7.2-ын эрэмбээр: `RECOUNT_REQUIRED`, `IN_CUSTODY`, `OPEN`, `SUBMITTED`, `CASH_RECEIVED`, `SELF_CLOSED`, `CLOSED`.
  - `Action.CASH_SAFEGUARD = "cash.safeguard"` (lock-ийн дараа ч зөвшөөрнө), `Action.CASH_SPEND = "cash.spend"` (lock-ийн дараа хориглоно).

- [ ] **Step 1: Failing test бичих** — `tests/test_cash_policy.py`, `class CashPolicyTests(unittest.TestCase)`:

```python
UB = ZoneInfo('Asia/Ulaanbaatar')
def at(y,m,d,h=0): return datetime(y,m,d,h,tzinfo=UB)

def test_defaults_and_validation(self):
    s = CashControlSettings()
    self.assertEqual((s.petty_single,s.petty_shift,s.direct_limit,s.escalation_amount,s.escalation_count,s.counting_floor),(50000,100000,500000,20000,3,1000))
    with self.assertRaisesRegex(DomainError,'INVALID_REQUEST'): CashControlSettings(petty_single=200000).validate()

def test_petty_and_direct_limits(self):
    s = CashControlSettings()
    check_petty(s,50000,50000)
    with self.assertRaisesRegex(DomainError,'PETTY_LIMIT_EXCEEDED'): check_petty(s,50001,0)
    with self.assertRaisesRegex(DomainError,'PETTY_LIMIT_EXCEEDED'): check_petty(s,1,100000)
    check_direct(s,500000,admin=False); check_direct(s,9_000_000,admin=True)
    with self.assertRaisesRegex(DomainError,'DIRECT_EXPENSE_LIMIT_EXCEEDED'): check_direct(s,500001,admin=False)

def test_receipt_rules(self):
    self.assertEqual(validate_receipt('EBARIMT_ORG','123',None)['receipt_type'],'EBARIMT_ORG')
    for bad in [('EBARIMT_ORG',None,None),('EBARIMT_PERSONAL','1',None),('PAPER',None,'x'),('NONE',None,' '),('CARD','1','x')]:
        with self.assertRaisesRegex(DomainError,'INVALID_RECEIPT'): validate_receipt(*bad)

def test_transit_deadline_skips_weekend(self):
    self.assertEqual(transit_deadline(at(2026,10,21,10)), at(2026,10,23,10))   # Лхагва → Баасан
    self.assertEqual(transit_deadline(at(2026,10,23,10)), at(2026,10,27,10))   # Баасан → Мягмар
    self.assertEqual(transit_deadline(at(2026,10,24,15)), at(2026,10,28,0))    # Бямба → Лхагва 00:00

def test_variance_window_starts_at_local_midnight(self):
    now = datetime(2026,10,24,17,30,tzinfo=timezone.utc)                       # UB 25-ны 01:30
    self.assertEqual(variance_window_start(now), at(2026,9,26))

def test_escalation(self):
    s = CashControlSettings()
    self.assertFalse(escalation_required(20000,0,s)); self.assertTrue(escalation_required(-20001,0,s))
    self.assertFalse(escalation_required(999,9,s)); self.assertTrue(escalation_required(1000,2,s)); self.assertFalse(escalation_required(1000,1,s))

def test_display_state_order(self):
    self.assertEqual(display_state('OPEN','RETURNED','NOT_SUBMITTED',False,False),'RECOUNT_REQUIRED')
    self.assertEqual(display_state('CLOSED','ACCEPTED','MANAGER_REQUIRED',False,True),'IN_CUSTODY')
    self.assertEqual(display_state('CLOSED','ACCEPTED','APPROVED',True,False),'SELF_CLOSED')
    self.assertEqual(display_state('CLOSED','ACCEPTED','DISPUTED',False,False),'CASH_RECEIVED')
    self.assertEqual(display_state('CLOSED','ACCEPTED','APPROVED',False,False),'CLOSED')
```

`tests/test_subscription.py`-д: `test_cash_safeguard_survives_lock_and_spend_does_not` — `expires_at + 49h`-д `CASH_SAFEGUARD` → `allowed=True, code='CASH_SAFEGUARD'`; `CASH_SPEND` → `SUBSCRIPTION_EXPIRED`; `tenant_security_suspended=True` үед `CASH_SAFEGUARD` → `SECURITY_SUSPENDED`.

- [ ] **Step 2: Унаж байгааг шалгах** — `PYTHONPATH=src python -m unittest tests.test_cash_policy tests.test_subscription -v` → `ModuleNotFoundError: prsystem.cash_policy`.
- [ ] **Step 3: Хэрэгжүүлэх** — `cash_policy.py` (`zoneinfo`, `common.money`, `DomainError`). `transit_deadline`: орон нутгийн цагт хувиргаад Бямба/Ням өдрийг алгасан ажлын секундийг 172800 хүртэл урагшлуулна. `subscription_gate`: `now < locked_at` шалгалтын дараа `if action == Action.CASH_SAFEGUARD: return AccessDecision(True, "CASH_SAFEGUARD")`.
- [ ] **Step 4: Давсныг шалгах** — ижил команд → OK.
- [ ] **Step 5: Commit** — `feat(cash): pure cash control policy and safeguard action`.

---

### Task 2: Байршлын төрөл, posting primitive, сейф үүсгэх, тохиргоо

**Files:**
- Create: `src/prsystem/postgres/migrations/081_cash_locations.sql`, `src/prsystem/cash_locations.py`, `src/prsystem/cash_api.py`
- Modify: `src/prsystem/api.py` (service үүсгэх, `install`), `tests/postgres_support.py` (grant)
- Test: `tests/test_cash_locations.py`

**Interfaces:**
- Consumes: `CashControlSettings` (Task 1), `ShiftService._book`, `_admin`, `_receipt`, `_save_receipt`, `event`.
- Produces:
  - Migration 081: `cash_drawer` + `location_type text NOT NULL DEFAULT 'DRAWER' CHECK IN ('DRAWER','SAFE','IN_TRANSIT')`, `holder_id text NULL`, `closed_at timestamptz NULL`; `shift_id` NULL болно; CHECK: DRAWER ⇒ shift_id NOT NULL ∧ holder NULL; SAFE ⇒ shift NULL ∧ holder NULL; IN_TRANSIT ⇒ shift NULL ∧ holder NOT NULL; `UNIQUE (tenant_id) WHERE location_type='SAFE'`. `cash_event.shift_id` NULL болно. `cash_event` kind/sign CHECK-ийг Global Constraints-ийн нэрсээр солино: IN төрөл `posted>0, reserved=0`; OUT төрөл `posted<0, reserved IN (0, posted)`; `MOVEMENT_RESERVED` `posted=0,reserved>0`; `MOVEMENT_RELEASED` `posted=0,reserved<0`; хуучин мөрүүд хэвээр. `cash_control_settings(tenant_id PK, petty_single, petty_shift, direct_limit, escalation_amount, escalation_count, counting_floor, revision, configured_by, configured_at)`.
  - `class Location(NamedTuple): id, type, shift_id, holder_id, posted, reserved, closed`.
  - `CashLocations.load(conn, tenant, location_id) -> Location` (`FOR UPDATE`; байхгүй бол `WORK_SOURCE_NOT_FOUND`).
  - `CashLocations.post(conn, tenant, actor, location_id, kind, reference, posted_delta, reserved_delta, now) -> int` (cash_book revision) — `GuestFinance.cash`-ийн өргөтгөл: DRAWER бол `shift_id` нь `reception_shift.state='OPEN'` байх ёстой (`NO_ACTIVE_SHIFT`), `cash_custody` HELD бол `DRAWER_IN_CUSTODY`; хаагдсан байршил → `WORK_NOT_OPEN`; `posted<0` эсвэл `reserved>posted` → `INSUFFICIENT_CASH`. Event, outbox бичнэ. Caller `_book()` lock-ийг барьсан байна.
  - `CashLocations.settings(conn, tenant) -> CashControlSettings` (мөр байхгүй бол анхдагч).
  - `CashControlService(ShiftService)`: `create_safe(bearer, tenant, name, key) -> dict` (Hotel Admin; `SAFE_EXISTS`), `configure(bearer, tenant, values: dict, revision: int, key) -> dict` (Hotel Admin; `REVISION_CONFLICT`).
  - Route: `POST /hotels/{tenant_id}/cash/safe` (201), `PUT /hotels/{tenant_id}/cash/controls`, `GET /hotels/{tenant_id}/cash/controls`.
  - `cash_api.install(app, *, token, controls)` — дараагийн task бүр keyword нэмнэ.

- [ ] **Step 1: Failing test** — `tests/test_cash_locations.py`, `class CashLocationTests(GuestFinanceCase)`:
  - `test_admin_creates_single_safe` — admin 201 `location_type='SAFE'`; дахин → `SAFE_EXISTS`; manager → `FORBIDDEN`.
  - `test_controls_default_and_update` — GET → Global Constraints-ийн 6 утга, `revision=0`; PUT `petty_single=60000, revision=0` → `revision=1`; хуучин revision → `REVISION_CONFLICT`; `petty_single > petty_shift` → `INVALID_REQUEST`.
  - `test_location_shape_constraints` — owner DSN-ээр `SAFE`-д `shift_id` тавих, `IN_TRANSIT`-д holder-гүй мөр оруулах → `CheckViolation`.
  - `test_post_rejects_closed_shift_and_custody` — `post()`-ийг шууд transaction-д дуудаж хаагдсан ээлжийн DRAWER → `NO_ACTIVE_SHIFT`; custody HELD касс → `DRAWER_IN_CUSTODY`; available-аас их OUT → `INSUFFICIENT_CASH`.
  - `test_existing_kinds_still_valid` — одоогийн `start()` + зочны бэлэн төлбөр амжилттай (migration хуучин мөрийг эвдээгүй).
- [ ] **Step 2: Унаж байгааг шалгах** — `PYTHONPATH=src:tests python -m unittest tests.test_cash_locations -v` → 404 / ImportError.
- [ ] **Step 3: Хэрэгжүүлэх** — migration 081, `cash_locations.py`, `cash_api.py`, `api.py`-д `controls=CashControlService(service)`. Шинэ хүснэгтийн RLS/grant Global Constraints-ийн дагуу.
- [ ] **Step 4: Давсныг шалгах** — дээрх + `tests.test_handover_lifecycle tests.test_guest_finance tests.test_initial_opening` бүгд OK.
- [ ] **Step 5: Commit** — `feat(cash): location types, posting primitive, safe and controls`.

---

### Task 3: Кассын эзний баталгаа (§6.6) ба top-up

**Files:**
- Create: `src/prsystem/postgres/migrations/082_cash_movement_requests.sql`, `src/prsystem/cash_movements.py`
- Modify: `src/prsystem/shifts.py` (`_pending`), `src/prsystem/cash_api.py`, `src/prsystem/api.py`
- Test: `tests/test_cash_movements.py`

**Interfaces:**
- Consumes: `CashLocations.post/load` (Task 2).
- Produces:
  - Migration 082: `cash_movement_request(tenant_id, id, location_id, shift_id, direction IN/OUT, target_kind, amount>0, requested_by, source_kind, source_id, state PENDING/ACCEPTED/REJECTED, decided_by, decided_at, reason, created_at)`; immutable trigger (зөвхөн `PENDING`→terminal). `UNIQUE(tenant_id, source_kind, source_id)`.
  - `CashMovements(ShiftService)`:
    - `register(source_kind: str, *, accepted: Callable[[conn, tenant, source_id, actor, now], dict], rejected: Callable[[conn, tenant, source_id, actor, now], None]) -> None`.
    - `request(conn, tenant, actor, location_id, direction, target_kind, amount, source_kind, source_id, now) -> dict` — `{'state':'POSTED'}` (байршил SAFE/IN_TRANSIT эсвэл actor = DRAWER-ийн идэвхтэй ээлжийн эзэн: шууд `post()`, `accepted` callback дуудна) эсвэл `{'state':'PENDING','request_id':…}` (OUT бол `MOVEMENT_RESERVED`).
    - `decide(bearer, tenant, request_id, accept: bool, reason, key) -> dict` — зөвхөн тухайн DRAWER-ийн `OPEN` ээлжийн эзэн; accept: OUT бол `target_kind` (`posted=-a, reserved=-a`), IN бол (`posted=+a`), callback; reject: `MOVEMENT_RELEASED`, callback.
    - `pending(bearer, tenant) -> list[dict]` — тухайн хэрэглэгчийн кассанд хүлээгдэж буй.
    - `top_up(bearer, tenant, drawer_id, amount, source, reason, key) -> dict` — Manager/Manager Plus/Hotel Admin; `CASH_TOP_UP` IN; `source_kind='TOP_UP'`; `Action.CASH_SPEND`.
  - `ShiftService._pending()` нь тухайн drawer-ийн `PENDING` хүсэлтийг мөн тооцно → `PENDING_SHIFT_OBLIGATIONS`.
  - Route: `GET /hotels/{t}/cash/movement-requests`, `POST /hotels/{t}/cash/movement-requests/{id}/decision` (`{accept, reason, idempotency_key}`), `POST /hotels/{t}/cash/drawers/{drawer_id}/top-ups` (201).

- [ ] **Step 1: Failing test** — `tests/test_cash_movements.py`, `class CashMovementTests(GuestFinanceCase)` (`self.start()` нь worker-ийн ээлжийг нээнэ):
  - `test_manager_top_up_waits_for_drawer_owner` — manager top-up 30,000 → `PENDING`; drawer posted өөрчлөгдөөгүй; worker accept → posted +30,000, `cash_event.kind='CASH_TOP_UP'`, `actor_id`=manager.
  - `test_reception_cannot_top_up` → `FORBIDDEN`.
  - `test_reject_releases_nothing_posted` — reject (reason заавал) → state `REJECTED`, cash_event-д `CASH_TOP_UP` байхгүй.
  - `test_pending_blocks_handover` — pending байхад handover submit → `PENDING_SHIFT_OBLIGATIONS`; accept-ийн дараа submit 201.
  - `test_only_drawer_owner_decides` — replacement эсвэл manager decide → `FORBIDDEN`.
  - `test_concurrent_requests_cannot_overdraw_available` — posted 60,000 үед `request(OUT 40,000)` хоёр удаа (тусдаа transaction) → хоёр дахь `INSUFFICIENT_CASH`.
  - `test_rejected_request_replays_and_new_key_creates_new` — ижил key → ижил хариу, шинэ key → шинэ `request_id`.
  - `test_request_against_submitted_shift_rejected` — handover submit хийсний дараа top-up → `WORK_NOT_OPEN`.
- [ ] **Step 2: Унаж байгааг шалгах** → 404.
- [ ] **Step 3: Хэрэгжүүлэх** — migration 082, `cash_movements.py`, `_pending` өргөтгөл, route.
- [ ] **Step 4: Давсныг шалгах** — дээрх + `tests.test_handover_lifecycle tests.test_shift_takeover` OK.
- [ ] **Step 5: Commit** — `feat(cash): drawer-owner confirmation for others' movements and top-up`.

---

### Task 4: Ээлжийн зөрүү — бүртгэл, Admin-д дамжуулах, засвар, Manager-ийн буцаалт

**Files:**
- Create: `src/prsystem/postgres/migrations/083_shift_variance.sql`, `src/prsystem/shift_variance.py`
- Modify: `src/prsystem/handover.py` (`finish`, self-close зам, `manager_return`), `src/prsystem/shifts.py` (`review`), `src/prsystem/cash_api.py`, `src/prsystem/api.py`
- Test: `tests/test_shift_variance.py`

**Interfaces:**
- Consumes: `escalation_required`, `variance_window_start` (Task 1), `CashLocations.settings` (Task 2), `CashMovements.request/register` (Task 3).
- Produces:
  - Migration 083: `reception_shift.review_authority text NOT NULL DEFAULT 'MANAGER' CHECK IN ('MANAGER','ADMIN')`; `cash_variance(tenant_id, id, responsible_id NULL, source_kind SHIFT/ENVELOPE/TRANSIT/EXPENSE, source_id, amount bigint <> 0, recorded_at)` append-only (`reject_history_mutation`), `UNIQUE(tenant_id, source_kind, source_id)`; `shift_variance_note(tenant_id, variance_id, author_id, note, created_at)` append-only.
  - `ShiftVariance` (static, conn авна):
    - `record(conn, tenant, responsible_id: str | None, source_kind, source_id, amount, now) -> str`.
    - `prior_counted(conn, tenant, responsible_id, settings, now) -> int` — `recorded_at >= variance_window_start(now)`, `abs(amount) >= counting_floor`, `responsible_id` тэнцүү (NULL-ийг хэзээ ч тоолохгүй).
    - `escalate(conn, tenant, shift_id, actor, reason) -> None` — `review_state='DISPUTED'`, `review_authority='ADMIN'` (APPROVED-оос ч), `SHIFT_REVIEW_REOPENED` event.
  - `HandoverService.finish` ба self-close: variance ≠ 0 бол `record(owner, 'SHIFT', shift_id, variance)`; `escalation_required(...)` эсвэл одоогийн ADMIN нөхцөл бол `review_authority='ADMIN'`. Хариунд `review_authority` нэмнэ.
  - `HandoverService.manager_return(bearer, tenant, handover_id, reason, key) -> dict` — Manager/Manager Plus эсвэл Hotel Admin; зөвхөн `SUBMITTED`; одоогийн буцаалтын адил `RETURNED` + ээлж `OPEN`; event `HANDOVER_RETURNED_BY_MANAGER`.
  - `ShiftService.review`: `review_authority='ADMIN'` бол `HOTEL_ADMIN` шаардана. Шинэ decision `CORRECT`: `correct(bearer, tenant, shift_id, direction, amount, reason, key) -> dict` — тухайн drawer-ийн одоогийн идэвхтэй ээлжид `CASH_CORRECTION_IN/OUT` хүсэлт (`source_kind='SHIFT_CORRECTION'`); accepted callback → `review_state='APPROVED'`; хүсэлт хүлээгдэж байх хооронд дахин review → `WORK_NOT_OPEN`.
  - `ShiftVariance.history(conn, tenant, responsible_id, since) -> list[dict]`.
  - Route: `POST /hotels/{t}/handovers/{id}/return`, `POST /hotels/{t}/shifts/{id}/review/correct` (`{direction:'IN'|'OUT', amount, reason, idempotency_key}`), `POST /hotels/{t}/cash/variances/{id}/notes`.

- [ ] **Step 1: Failing test** — `tests/test_shift_variance.py`, `class ShiftVarianceTests(GuestFinanceCase)`; helper `close_with_variance(delta)` нь handover-ийг `actual=expected+delta`, хоёр удаа тоолж accept хийнэ:
  - `test_large_variance_requires_admin` — delta −20,001 → `review_authority='ADMIN'`; manager review → `FORBIDDEN`; admin review APPROVE → 200.
  - `test_threshold_is_strict` — delta −20,000 → `MANAGER`.
  - `test_third_counted_variance_escalates` — тухайн worker-т өмнө нь −1,000 ба +1,500 (`cash_variance` мөрийг owner DSN-ээр 10 хоногийн өмнө оруулна) → гурав дахь −1,000 → `ADMIN`.
  - `test_small_variances_do_not_count` — өмнө нь −999 хоёр мөр → −1,000 → `MANAGER`.
  - `test_unknown_responsible_never_counts` — `responsible_id NULL` гурван мөр → `MANAGER`.
  - `test_window_excludes_older_rows` — 31 хоногийн өмнөх хоёр мөр → `MANAGER`.
  - `test_manager_return_before_accept` — submit → manager return → handover `RETURNED`, ээлж `OPEN`; worker → `FORBIDDEN`; accept-ийн дараа → `WORK_NOT_OPEN`.
  - `test_correction_via_current_drawer_owner` — хаагдсан ээлжид −10,000; manager `correct IN 10,000` → replacement (одоогийн эзэн) accept → `CASH_CORRECTION_IN` replacement-ийн ээлжид, хуучин ээлжийн `review_state='APPROVED'`, хуучин `opening_actual`/handover тоо өөрчлөгдөөгүй.
  - `test_escalate_reopens_approved` — APPROVED ээлжид `ShiftVariance.escalate` → `DISPUTED`/`ADMIN`.
  - `test_reception_writes_note_on_own_variance_only`.
- [ ] **Step 2: Унаж байгааг шалгах** → `KeyError: 'review_authority'`.
- [ ] **Step 3: Хэрэгжүүлэх** — migration 083, `shift_variance.py`, handover/shifts өөрчлөлт, route.
- [ ] **Step 4: Давсныг шалгах** — дээрх + `tests.test_handover_lifecycle tests.test_shift_takeover` OK (хуучин `review_state` хүлээлт өөрчлөгдөхгүй).
- [ ] **Step 5: Commit** — `feat(shift): variance attribution, admin escalation, correction and manager return`.

---

### Task 5: Сейф — drop, дугтуй тоолох, сейфээс гаргах

**Files:**
- Create: `src/prsystem/postgres/migrations/084_cash_envelopes.sql`, `src/prsystem/cash_safe.py`
- Modify: `src/prsystem/cash_api.py`, `src/prsystem/api.py`
- Test: `tests/test_cash_safe.py`

**Interfaces:**
- Consumes: `CashLocations` (Task 2), `CashMovements.request` (Task 3), `ShiftVariance.record` (Task 4), `envelope_overdue` (Task 1).
- Produces:
  - Migration 084: `cash_envelope(tenant_id, id, number, safe_id, drawer_id, shift_id, dropped_by, declared bigint>0, dropped_at, state SEALED/COUNTED, seal_state INTACT/BROKEN NULL, counted bigint NULL, counted_by, counted_at, note)`; `UNIQUE(tenant_id, number)`; SEALED→COUNTED л шилжинэ.
  - `CashSafe(ShiftService)`:
    - `drop(bearer, tenant, envelope_number, amount, key) -> dict` — Reception, өөрийн `OPEN` ээлжийн касс; `SAFE_TRANSFER_OUT` (drawer) + `SAFE_TRANSFER_IN` (safe) нэг transaction; сейфгүй → `SAFE_NOT_CONFIGURED`; давхар дугаар → `ENVELOPE_EXISTS`; `Action.CASH_SAFEGUARD`.
    - `count(bearer, tenant, envelope_id, seal_state, actual, note, key) -> dict` — Manager/Manager Plus/Hotel Admin; diff = actual − declared; diff ≠ 0 бол `COUNT_VARIANCE_IN/OUT` safe дээр, `ShiftVariance.record(responsible = dropped_by if INTACT else None, 'ENVELOPE', id, diff)`; `BROKEN` эсвэл diff ≠ 0 бол `note` заавал (`INVALID_REASON`), хариунд `admin_review=True`.
    - `release(bearer, tenant, amount, destination_drawer_id, reason, key) -> dict` — Manager/Manager Plus/Hotel Admin; `CashMovements.request(... 'IN', 'SAFE_TRANSFER_IN', source_kind='SAFE_RELEASE')`; accepted callback safe дээр `SAFE_TRANSFER_OUT`; гарахаас өмнө safe дээр `MOVEMENT_RESERVED`; `Action.CASH_SPEND`.
    - `envelopes(bearer, tenant) -> list[dict]` — `overdue` талбартай.
  - Route: `POST /hotels/{t}/cash/safe/drops` (201), `POST /hotels/{t}/cash/envelopes/{id}/count`, `POST /hotels/{t}/cash/safe/releases` (201), `GET /hotels/{t}/cash/envelopes`.

- [ ] **Step 1: Failing test** — `tests/test_cash_safe.py`, `class CashSafeTests(GuestFinanceCase)` (`setUp`: admin сейф үүсгэнэ, worker ээлж 60,000):
  - `test_reception_drop_moves_cash_immediately` — drop 50,000 `E-1` → drawer posted 10,000, safe posted 50,000; хоёр event ижил reference.
  - `test_drop_requires_safe_and_unique_number` — сейфгүй tenant → `SAFE_NOT_CONFIGURED`; `E-1` дахин → `ENVELOPE_EXISTS`.
  - `test_reception_cannot_count_or_release` → `FORBIDDEN` ×2.
  - `test_intact_shortage_attributed_to_dropper` — count INTACT 45,000 note → `COUNT_VARIANCE_OUT` 5,000; `cash_variance.responsible_id`=worker, `admin_review=True`.
  - `test_broken_seal_is_unattributed_and_needs_note` — BROKEN note-гүй → `INVALID_REASON`; note-той → `responsible_id IS NULL`.
  - `test_exact_intact_count_closes_without_variance` — `cash_variance` мөр нэмэгдэхгүй, `admin_review=False`.
  - `test_release_to_drawer_needs_owner_acceptance` — manager release 20,000 → pending; worker accept → drawer +20,000, safe −20,000.
  - `test_overdue_after_24h` — `dropped_at`-ийг owner DSN-ээр 25 цаг хойш шилжүүлэхэд `envelopes()`-д `overdue=True`.
- [ ] **Step 2: Унаж байгааг шалгах** → 404.
- [ ] **Step 3: Хэрэгжүүлэх**.
- [ ] **Step 4: Давсныг шалгах** — OK.
- [ ] **Step 5: Commit** — `feat(cash): blind safe drop, sealed envelope count and release`.

---

### Task 6: Эзэн/бусдад мөнгө өгөх

**Files:**
- Create: `src/prsystem/postgres/migrations/085_cash_withdrawals.sql`, `src/prsystem/cash_withdrawals.py`
- Modify: `src/prsystem/cash_api.py`, `src/prsystem/api.py`
- Test: `tests/test_cash_withdrawals.py`

**Interfaces:**
- Consumes: Task 2–4, `withdrawal_overdue` (Task 1).
- Produces:
  - Migration 085: `cash_withdrawal(tenant_id, id, location_id, shift_id NULL, amount, recipient_kind ADMIN/OTHER, recipient_account_id NULL, recipient_name NULL, reason, recorded_by, recorded_at, state PENDING_MOVEMENT/AWAITING_CONFIRMATION/CONFIRMED/DENIED/CANCELLED, decided_by, decided_at, decision_reason)`; CHECK: ADMIN ⇒ account NOT NULL; OTHER ⇒ name NOT NULL.
  - `CashWithdrawals(ShiftService)`:
    - `record(bearer, tenant, location_id, amount, recipient_kind, recipient_account_id, recipient_name, reason, key) -> dict` — Reception: зөвхөн `ADMIN` + хүлээн авагч нь идэвхтэй `HOTEL_ADMIN` гишүүн, өөрийн касс; Manager/Manager Plus: ADMIN эсвэл OTHER, DRAWER/SAFE; Hotel Admin: шууд `CONFIRMED` (`self_approved=True`). `CashMovements.request(... 'OUT','OWNER_OTHER_WITHDRAWAL', source_kind='WITHDRAWAL')`; rejected callback → `CANCELLED`; `Action.CASH_SAFEGUARD`.
    - `decide(bearer, tenant, withdrawal_id, confirm: bool, reason, key) -> dict` — ADMIN бол зөвхөн тухайн `recipient_account_id`; OTHER бол дурын Hotel Admin, гэхдээ бүртгэгч өөрөө биш. Deny → `ShiftVariance.escalate(conn, tenant, withdrawal.shift_id, actor, reason)` (shift_id байвал).
    - `awaiting(bearer, tenant) -> list[dict]` — `overdue` талбартай.
  - Route: `POST /hotels/{t}/cash/withdrawals` (201), `POST /hotels/{t}/cash/withdrawals/{id}/decision`, `GET /hotels/{t}/cash/withdrawals`.

- [ ] **Step 1: Failing test** — `class CashWithdrawalTests(GuestFinanceCase)`:
  - `test_reception_to_admin_awaits_confirmation` — worker 200,000 → admin руу → drawer −200,000 тэр даруй (өөрийн касс), `AWAITING_CONFIRMATION`; admin confirm → `CONFIRMED`.
  - `test_reception_cannot_pay_other_person` → `FORBIDDEN`; хүлээн авагч нь manager account → `FORBIDDEN`.
  - `test_manager_from_reception_drawer_needs_owner_acceptance` — manager OTHER → `PENDING_MOVEMENT`; worker reject → `CANCELLED`, drawer өөрчлөгдөхгүй.
  - `test_admin_record_is_self_confirmed`.
  - `test_denial_reopens_shift_review_even_if_approved` — worker withdrawal → handover/accept → manager APPROVE → admin deny → ээлж `DISPUTED`/`ADMIN`.
  - `test_pending_confirmation_does_not_block_handover`.
  - `test_other_recipient_confirmed_by_admin_only` — manager OTHER (сейфээс) → `AWAITING_CONFIRMATION`; manager decide → `FORBIDDEN`; admin decide → `CONFIRMED`.
  - `test_overdue_after_24h`.
- [ ] **Step 2–4:** унах → хэрэгжүүлэх → давах.
- [ ] **Step 5: Commit** — `feat(cash): owner and other withdrawals with recipient confirmation`.

---

### Task 7: Банкинд тушаах ("замд")

**Files:**
- Create: `src/prsystem/postgres/migrations/086_cash_transits.sql`, `src/prsystem/cash_transit.py`
- Modify: `src/prsystem/cash_api.py`, `src/prsystem/api.py`
- Test: `tests/test_cash_transit.py`

**Interfaces:**
- Consumes: Task 2–4, `transit_deadline` (Task 1).
- Produces:
  - Migration 086: `cash_transit(tenant_id, id, location_id (IN_TRANSIT), source_location_id, holder_id, amount, started_at, deadline_at, state PENDING_MOVEMENT/IN_TRANSIT/DEPOSITED/RETURNED/LOST/CANCELLED, bank_reference NULL, deposited bigint NULL, closed_by, closed_at, reason)`; `UNIQUE(tenant_id, bank_reference) WHERE bank_reference IS NOT NULL`.
  - `CashTransit(ShiftService)`:
    - `start(bearer, tenant, source_location_id, amount, key) -> dict` — Manager/Manager Plus/Hotel Admin; шинэ `IN_TRANSIT` байршил (holder = actor); `CashMovements.request(source, 'OUT','TRANSIT_OUT', source_kind='TRANSIT')`; accepted callback transit дээр `TRANSIT_IN`, state `IN_TRANSIT`; rejected → `CANCELLED`, байршил хаагдана. `deadline_at = transit_deadline(started_at)`. `Action.CASH_SAFEGUARD`.
    - `deposit(bearer, tenant, transit_id, bank_reference, deposited, key) -> dict` — зөвхөн holder; `BANK_DEPOSIT_OUT = deposited`; `amount − deposited`-ийг `COUNT_VARIANCE_OUT/IN`-ээр, `ShiftVariance.record(holder,'TRANSIT',...)`; байршил `closed_at`; holder нь Hotel Admin бол `self_reviewed=True`.
    - `admin_close(bearer, tenant, transit_id, outcome: 'RETURNED'|'LOST', destination_location_id: str | None, counted: int | None, reason, key) -> dict` — Hotel Admin; зөвхөн holder идэвхгүй (түдгэлзсэн/гарсан) үед; RETURNED: destination руу (`CashMovements.request` хэрэглэнэ), зөрүүг holder дээр; LOST: үлдэгдлийг `COUNT_VARIANCE_OUT` holder дээр.
    - `open_transits(bearer, tenant) -> list[dict]` — `overdue = now >= deadline_at`.
  - Route: `POST /hotels/{t}/cash/transits` (201), `POST /hotels/{t}/cash/transits/{id}/deposit`, `POST /hotels/{t}/cash/transits/{id}/admin-close`, `GET /hotels/{t}/cash/transits`.

- [ ] **Step 1: Failing test** — `class CashTransitTests(GuestFinanceCase)`:
  - `test_manager_takes_from_drawer_after_owner_count` — start 50,000 → pending; worker accept → drawer −50,000, transit +50,000, state `IN_TRANSIT`.
  - `test_deposit_exact_closes_location` — deposit `REF-1` 50,000 → `DEPOSITED`, transit posted 0, `closed_at` бий, `cash_variance` мөргүй.
  - `test_short_deposit_attributed_to_holder` — 48,000 → `COUNT_VARIANCE_OUT` 2,000, `responsible_id`=manager.
  - `test_only_holder_deposits` — admin → `FORBIDDEN`.
  - `test_duplicate_bank_reference_rejected`.
  - `test_reception_cannot_start` → `FORBIDDEN`.
  - `test_admin_close_only_when_holder_inactive` — идэвхтэй holder → `FORBIDDEN`; manager-ийг suspend → `LOST` → variance holder дээр.
  - `test_admin_close_into_custody_drawer_rejected_safe_allowed` — custody касс → `DRAWER_IN_CUSTODY`; сейф → амжилттай.
  - `test_deadline_matches_policy` — `deadline_at == transit_deadline(started_at)`.
- [ ] **Step 2–4.**
- [ ] **Step 5: Commit** — `feat(cash): bank deposit via named in-transit custody`.

---

### Task 8: Зардал — petty ба Manager-ийн шууд зардал

**Files:**
- Create: `src/prsystem/postgres/migrations/087_cash_expenses.sql`, `src/prsystem/cash_expenses.py`
- Modify: `src/prsystem/cash_api.py`, `src/prsystem/api.py`
- Test: `tests/test_cash_expenses.py`

**Interfaces:**
- Consumes: `check_petty`, `check_direct`, `validate_receipt` (Task 1); Task 2–4.
- Produces:
  - Migration 087: `expense_category(tenant_id, id, name, expense_type INVENTORY_PURCHASE/OPERATING, status ACTIVE/INACTIVE, revision)` — tenant-ийн анхны уншилтаар `docs/23` §4.4-ийн 8 ангиллыг (Minibar бараа татан авалт = INVENTORY_PURCHASE, бусад OPERATING) idempotent seed хийнэ. `cash_expense(tenant_id, id, kind PETTY/DIRECT, location_id, shift_id NULL, amount, expense_type, category_id, description, supplier NULL, receipt_type, receipt_number, receipt_reason, minibar_receipt_id NULL, recorded_by, recorded_at, state PENDING_MOVEMENT/PAID/CANCELLED, review_state PENDING_REVIEW/APPROVED/DISPUTED, reviewed_by, reviewed_at, review_reason)`; `UNIQUE(tenant_id, minibar_receipt_id) WHERE minibar_receipt_id IS NOT NULL`; CHECK: DIRECT ⇒ supplier NOT NULL; INVENTORY_PURCHASE ⇒ minibar_receipt_id NOT NULL.
  - `CashExpenses(ShiftService)`:
    - `petty(bearer, tenant, amount, category_id, description, receipt: dict, key) -> dict` — Reception, өөрийн `OPEN` ээлжийн касс; `spent_in_shift` = тухайн ээлжийн PETTY PAID нийлбэр; `check_petty`; `PAID_CASH_EXPENSE`; `Action.CASH_SPEND`.
    - `direct(bearer, tenant, location_id, amount, expense_type, category_id, supplier, description, receipt: dict, minibar_receipt_id, key) -> dict` — Manager/Manager Plus (`check_direct(admin=False)`) эсвэл Hotel Admin (`admin=True`); INVENTORY_PURCHASE бол minibar purchase receipt (Stage 5 warehouse receipt) байх (`RECEIPT_REQUIRED`), өөр expense-тэй холбоогүй (`RECEIPT_ALREADY_LINKED`); бусдын кассаас бол `CashMovements.request`; `Action.CASH_SPEND`.
    - `review(bearer, tenant, expense_id, approve: bool, reason, key) -> dict` — PETTY: Manager/Manager Plus/Hotel Admin; DIRECT: зөвхөн Hotel Admin; бүртгэгч өөрөө → `FORBIDDEN`, гэхдээ бүртгэгч нь Hotel Admin бөгөөд өөр Hotel Admin байхгүй бол `self_reviewed=True`. DISPUTED → `ShiftVariance.record(recorded_by,'EXPENSE',id,-amount)`.
    - `categories(bearer, tenant) -> list[dict]`; `configure_category(bearer, tenant, ..., key)` — Hotel Admin.
  - Route: `POST /hotels/{t}/cash/expenses/petty` (201), `POST /hotels/{t}/cash/expenses/direct` (201), `POST /hotels/{t}/cash/expenses/{id}/review`, `GET|POST /hotels/{t}/cash/expense-categories`.
  - API model `ReceiptInput{receipt_type, receipt_number?, receipt_reason?}`.

- [ ] **Step 1: Failing test** — `class CashExpenseTests(GuestFinanceCase)`:
  - `test_petty_posts_paid_with_receipt_type` — 20,000 `EBARIMT_ORG` → drawer −20,000, `state='PAID'`, `review_state='PENDING_REVIEW'`.
  - `test_petty_single_and_shift_limits` — 50,001 → `PETTY_LIMIT_EXCEEDED`; 50,000 + 50,000 амжилттай, дараагийн 1 → `PETTY_LIMIT_EXCEEDED`; шинэ ээлжид дахин 50,000 боломжтой.
  - `test_petty_requires_valid_receipt` — `NONE` reason-гүй → `INVALID_RECEIPT`.
  - `test_manager_cannot_petty_without_reception_role` → `FORBIDDEN`.
  - `test_direct_limit_for_manager_not_admin` — manager 500,001 → `DIRECT_EXPENSE_LIMIT_EXCEEDED`; admin 900,000 (сейфээс) → 201.
  - `test_inventory_purchase_links_receipt_once` — receipt-гүй → `RECEIPT_REQUIRED`; холбосон → 201; ижил receipt дахин → `RECEIPT_ALREADY_LINKED`.
  - `test_direct_from_reception_drawer_needs_acceptance`.
  - `test_review_permissions` — PETTY-г manager APPROVE; DIRECT-ийг manager → `FORBIDDEN`, admin → 200; бүртгэгч өөрөө → `FORBIDDEN`.
  - `test_disputed_expense_counts_for_recorder` — dispute → `cash_variance` (`EXPENSE`, −amount, recorded_by).
  - `test_default_categories_seeded_once`.
- [ ] **Step 2–4.**
- [ ] **Step 5: Commit** — `feat(cash): petty and manager direct expenses with eBarimt receipt type`.

---

### Task 9: Subscription lock үеийн матриц (spec §10)

**Files:**
- Test: `tests/test_cash_lock_matrix.py`
- Modify (шаардлагатай бол): Task 3–8-ийн service-үүдийн `Action` сонголт

**Interfaces:**
- Consumes: Task 3–8-ийн бүх command.

- [ ] **Step 1: Failing test** — `class CashLockMatrixTests(GuestFinanceCase)`; `hotel_access.expires_at`-ийг owner DSN-ээр `now − 49h` болгоод:
  - **Амжилттай байх ёстой:** handover submit/count/accept, movement-request decide, safe drop, envelope count, safe release to `IN_TRANSIT` (transit start from safe), transit deposit, withdrawal record/decide, shift review/correct.
  - **`SUBSCRIPTION_EXPIRED`:** petty, direct expense, top-up, safe release to drawer.
- [ ] **Step 2: Ажиллуулах** — `PYTHONPATH=src:tests python -m unittest tests.test_cash_lock_matrix -v`; унасан мөр бүрийн `Action`-ийг spec §10-д нийцүүлж засна.
- [ ] **Step 3: Давсныг шалгах.**
- [ ] **Step 4: Commit** — `test(cash): subscription lock matrix for cash safeguard actions`.

---

### Task 10: Read model ба тайлан

**Files:**
- Create: `src/prsystem/cash_reports.py`
- Modify: `src/prsystem/operations.py` (`overview`, `shift_report`), `src/prsystem/cash_api.py`
- Test: `tests/test_cash_reports.py`

**Interfaces:**
- Consumes: Task 1–8-ийн хүснэгтүүд, `display_state`.
- Produces:
  - `operations.overview` нэмэлт талбар: `cash_locations` (төрөл, posted, reserved, available, safe-ийн `sealed_total`), `movement_requests` (өөрийн касс), `display_state` ээлж бүрт.
  - `shift_report` нэмэлт: шинэ хөдөлгөөн төрлөөр, `awaiting_withdrawals`, `unreviewed_expenses`.
  - `CashReports(ShiftService)`:
    - `admin_overview(bearer, tenant) -> dict` (Hotel Admin) — `total_cash = drawers + safe + open transits`; `overdue_envelopes`; `awaiting_withdrawals` (overdue-тэй); `other_recipient_withdrawals`; `overdue_transits`; `expenses_personal_or_none`; `self_closed_shifts`; `inactive_staff_open_items` (идэвхгүй гишүүний нээлттэй transit/withdrawal/review хүлээж буй зардал).
    - `variance_history(bearer, tenant, account_id, since) -> list[dict]` — Hotel Admin/Manager: дурын; Reception: зөвхөн өөрийн (`FORBIDDEN`).
    - `variance_export(bearer, tenant, since) -> csv text` — зөвхөн Hotel Admin, export audit event `CASH_VARIANCE_EXPORTED`.
  - Route: `GET /hotels/{t}/cash/admin-overview`, `GET /hotels/{t}/cash/variances?account_id=&since=`, `GET /hotels/{t}/cash/variances/export`.

- [ ] **Step 1: Failing test** — `class CashReportTests(GuestFinanceCase)`:
  - `test_total_cash_includes_safe_and_transit` — drawer 10,000 + safe 50,000 + transit 20,000 → `total_cash=80,000`; `sealed_total` тоологдоогүй дугтуйгаар.
  - `test_admin_lists_flag_overdue_and_risky_items` — overdue дугтуй, 24ц хэтэрсэн withdrawal, OTHER withdrawal, PERSONAL зардал, overdue transit бүгд харагдана.
  - `test_inactive_staff_items_listed` — manager-т transit, suspend → `inactive_staff_open_items`-д.
  - `test_variance_history_scopes` — worker өөрийнхийг → 200, бусдынхыг → `FORBIDDEN`; manager → 200; manager export → `FORBIDDEN`; admin export → CSV + audit.
  - `test_overview_display_state` — RETURNED handover → `RECOUNT_REQUIRED`; custody → `IN_CUSTODY`.
- [ ] **Step 2–4.**
- [ ] **Step 5: Commit** — `feat(cash): admin, manager and reception cash read models`.

---

### Task 11: Reception UI ба browser suite

**Files:**
- Modify: `src/prsystem/static/reception.js` (`shiftTools`, шинэ `cashTools`, `labels`, `errors`, `cashLabel`), `src/prsystem/static/reception.css` (шаардлагатай бол)
- Create: `tests/browser/cash.cjs`
- Modify: `.github/workflows/domain-tests.yml` (`node tests/browser/cash.cjs` + `validate_requests.py artifacts/cash-requests.json`)

**Interfaces:**
- Consumes: Task 2–10-ийн route-ууд.
- Produces (дэлгэц, role-оор):
  - **Reception:** "Миний касст хүлээгдэж буй" (хүлээн авах/татгалзах, тоолсон дүнг харуулах), "Сейф рүү хийх" (сейф байгаа үед л), "Жижиг зардал" (лимит ба үлдсэн ээлжийн лимит харагдана; лимит давахад Manager руу чиглүүлэх мессеж), "Эзэнд мөнгө өгсөн" (зөвхөн Hotel Admin сонголт), "Миний зөрүү" (тайлбар бичих).
  - **Manager:** "Банк руу" (эхлүүлэх/баримт оруулах), "Дугтуй тоолох" (битүүмж сонголт, зөрүүтэй/гэмтсэн үед тайлбар заавал), "Сейфээс гаргах", "Касс нэмэх", "Шууд зардал" (inventory бол minibar receipt сонголт), "Бусдад мөнгө өгөх" (шалтгаан сонгоход "Энэ зардал уу?" анхааруулга), ээлжийн review-д "Засвар" ба "Дахин тоолуулах".
  - **Hotel Admin:** тохиргоо (6 утга), сейф үүсгэх, ангилал, `admin_overview`-ийн жагсаалтууд, withdrawal баталгаажуулах, зардал/transit/дугтуйн хяналт, зөрүүний түүх + export.
  - Ээлжийн мөр `display_state`-ийн Монгол нэрээр (`docs/03` §6.1), review төлөв тусдаа badge.

- [ ] **Step 1: Failing browser test** — `tests/browser/cash.cjs` (`daily-workflows.cjs`-ийн mock загвар), сценари бүр assertion-тэй:
  1. Reception: сейфгүй үед "Сейф рүү хийх" харагдахгүй; сейфтэй үед drop илгээсэн body `{envelope_number, amount, idempotency_key}`.
  2. Reception: petty 60,000 → mock `PETTY_LIMIT_EXCEEDED` → Монгол мессеж; NONE сонгоход шалтгааны талбар заавал.
  3. Reception: хүлээгдэж буй top-up-ийг татгалзахад reason заавал.
  4. Manager: дугтуй BROKEN сонгоход тайлбар заавал; transit deposit body `{bank_reference, deposited}`.
  5. Manager: "Бусдад мөнгө өгөх" шалтгаанд "Нийлүүлэгч" сонгоход шууд зардал руу шилжих санал.
  6. Admin: overview-ийн overdue мөрүүд тэмдэглэгээтэй; export товч зөвхөн admin-д.
  7. 390px өргөнд хэвтээ гүйлгээгүй (`ui-quality.cjs`-ийн шалгалт).
  - Бүх хүсэлтийг `artifacts/cash-requests.json`-д бичнэ.
- [ ] **Step 2: Унаж байгааг шалгах** — `node tests/browser/cash.cjs` → assertion fail.
- [ ] **Step 3: Хэрэгжүүлэх** — `reception.js`.
- [ ] **Step 4: Давсныг шалгах** — `node tests/browser/cash.cjs && PYTHONPATH=src python tests/browser/validate_requests.py artifacts/cash-requests.json`; бусад бүх browser suite (`reception.cjs`, `daily-workflows.cjs`, `ui-quality.cjs` …) давна.
- [ ] **Step 5: Commit** — `feat(ui): reception, manager and admin cash screens`.

---

### Task 12: Баримт шинэчлэх ба бүрэн шалгалт

**Files:**
- Modify: `docs/24-cash-drawer-ledger.md`, `docs/03-reception-shift-handover.md`, `docs/23-admin-financial-reporting.md`, `docs/18-action-level-permission-matrix.md`, `docs/17-subscription-lifecycle.md`, `docs/48-minibar-warehouse.md`, `docs/29-postgres-cash.md` (runtime grants), `docs/requirements-status.md`, `docs/requirements-conflicts.md`, `README.md`

- [ ] **Step 1: Баримт** — spec §12-ын жагсаалт бүрийг; `docs/24`-т spec §5.4-ийн харгалзуулах хүснэгт, CASH-DEC-012–018; `docs/03`-т SHIFT-DEC-008–010; `docs/23` §4.3-т "нийлүүлэгч/баримт optional" гэснийг CASH-DEC-012/018-ийн хүрээнд заавал болсныг тэмдэглэх; C-053 (хэсэгчлэн), C-057, C-058, D-03-ыг шинэчлэх.
- [ ] **Step 2: Бүрэн шалгалт** —
  - `python -m scripts.run_postgres_shard` 4 shard, **0 skip**;
  - бүх browser suite + `validate_requests.py` artifact бүрээр;
  - CI-ийн design/token check (`scripts/ui_review.py`-ийн lint, `scripts/export_ui_tokens.py`).
- [ ] **Step 3: Хэрэглээний туршилт** — `python -m scripts.ui_review`: spec §11-ийн сценари ("шөнийн ээлж: drop + petty → өглөөний хүлээлцэлт → нийлүүлэгчид бэлнээр → дугтуй тоолох → Manager банк руу → эзэн мөнгө авах → Admin хяналт")-ийг Reception, Manager хүнээр хийлгэж `docs/76`-ийн ажиглалтын хүснэгтэд бүртгэх. **Энэ алхмыг захиалагч гүйцэтгэнэ;** agent зөвхөн сценарийн хүснэгтийг бэлдэнэ.
- [ ] **Step 4: `requirements-status.md`** — REQ-03-*, REQ-24-*-ийн мөрүүдийг шинэ run-ийн нотолгоо (тестийн ID)-оор шинэчлэх.
- [ ] **Step 5: Commit** — `docs(cash): record CASH-DEC-012–018, SHIFT-DEC-008–010 and evidence`.
