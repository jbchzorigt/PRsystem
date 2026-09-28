# Batch 1: баримттай зөрж буй 6 кодын алдааг TDD-ээр засах — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [B-01…B-06](../../requirements-conflicts.md#code-defects)-г засна. Эдгээр нь эх шаардлагаас зөрсөн, шийдвэр шаардахгүй 6 алдаа. Алдаа бүрийг эхлээд унадаг тестээр баталж, дараа нь засна.

**Architecture:** Засвар бүр нэг domain function, SQL function эсвэл UI талбарт хамаарна. Серверийн authority-г өөрчлөхгүй. UI зөвхөн оруулсан утгыг зөв нэгж рүү хөрвүүлнэ. DB өөрчлөлт нь зөвхөн шинэ forward migration (`078`) байна. Хуучин migration-ийн checksum-ийг `migrate.py` шалгадаг тул тэдгээрт хүрэхгүй.

**Tech Stack:** Python 3.12, FastAPI, psycopg 3, PostgreSQL 16/17 (RLS), `unittest`, Playwright 1.62.1 (Chromium) browser suites, vanilla JS (`src/prsystem/static/reception.js`).

**Spec:** [docs/requirements-roadmap.md §3](../../requirements-roadmap.md) (багцын хамрах хүрээ, унадаг тест, дууссаны шалгуур) ба [docs/requirements-conflicts.md §3](../../requirements-conflicts.md#code-defects) (алдаа бүрийн шаардлага/код/нотолгоо). Эх шаардлага: `docs/02:38`, `docs/26:109`, `docs/18:165,351`, `docs/17:158–201`, `docs/09:372`.

## Global Constraints

- Урьдчилсан нөхцөл D-01: `final` нь Python line (`src/prsystem`) байна. Энэ нөхцөл хангагдсан. TypeScript line сонгогдвол энэ plan хүчингүй.
- Branch: зөвхөн `final` дээр ажиллана. Push: `git push -u origin final`. Өөр branch/PR үүсгэхгүй.
- Python `>=3.12` (`pyproject.toml`). Шинэ dependency нэмэхгүй.
- Хуучин migration (`001`–`077`) засахгүй. DB өөрчлөлт зөвхөн `src/prsystem/postgres/migrations/078_category_booking_blockers.sql`.
- Grace хил нь кодын бусад хэсэгтэй адил `expires_at + 48 цаг` бөгөөд exclusive: `now < expires_at + 48h` бол grace (`subscription.py:125`).
- UI текст Монгол хэлээр. Кодын хэв маяг нь тухайн файлын нягт, нэг мөрт стиль хэвээр.
- Commit тус бүр нэг B. Commit message-ийн төгсгөлд:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd
  ```
- Хамрахгүй: D-01…D-12 шийдвэр, шинэ модуль, provider ажил, бусад refactor.

## Review Focus

1. **B-01 — 0.5-д хуваагдахгүй цаг (жишээ нь `1.25`).** Хүлээгдэх үр дүн: хэрэглэгчид алдаа харагдана, серверт хүсэлт илгээгдэхгүй. Тест: Task 1.
2. **B-02 — Төлбөр хүлээж буй (`HOLDING`) hold ба tenant RLS.** `booking_hold*` хүснэгтүүд `FORCE ROW LEVEL SECURITY`-тэй. `RoomLifecycle.change` tenant scope тохируулдаггүй тул scope-гүйгээр blocker үргэлж хоосон буцна (fail-open). Хүлээгдэх үр дүн: `HOLDING` hold ч category retirement-ийг блоклоно; hold дуусах эсвэл цуцлагдахад retirement автоматаар дуусна. Тест: Task 5 (2 тест, API замаар).
3. **B-03 — Manager Plus-ийн бусад эрх.** Manager Plus дангаараа `CANCELLED_HOTEL`-ийг хийж чадсан хэвээр байх ёстой. `MANAGER_PLUS+RECEPTION` хослол `NO_SHOW` хийж чадна. Тест: Task 3.
4. **B-04/B-05 — Grace-ийн яг хил.** `expires_at+48h`-д хүрсэн мөчөөс эхлэн түгжигдэнэ. Тест: Task 2 яг 48 цагаар шалгана. Task 4 бодит DB цагтай тул 48ц 1 минутаар шалгана.
5. **B-06 — Гэрээний хувийг бусад талбараас тооцоолох.** `commission_mnt / retained_mnt` харьцаа нь хувийг шууд илчилнэ. Idempotent replay хариунд ч нууц талбар гарч болно. Хүлээгдэх үр дүн: зочны хариунд `commission_mnt`, `hotel_payable_mnt`, `confirmation` ч байхгүй, replay хариу мөн шүүгдэнэ. Тест: Task 6.

**Хамрахгүй, дараагийн ажил:**

- `reception.js:957` нь `NO_SHOW` сонголтыг Manager Plus-only хэрэглэгчид ч харуулсан хэвээр байна. Засварын дараа сервер 403 буцаана. Online tools-ийн browser suite байхгүй тул UI gating-ийг тусдаа ажлаар хийнэ.
- `reception.js:655` dev-only mock booking маягт ижил "Цаг / хоногийн тоо" шошготой. Энэ нь production-д байхгүй туршилтын маягт.
- `074_minibar_partial_rollback.sql:313` мөн `h.expires_at>clock_timestamp()` ашигладаг. Энэ нь B жагсаалтад ороогүй.

---

## Орчин бэлдэх (Task бүрийн өмнө нэг удаа)

```bash
cd /home/user/PRsystem
python3.12 -m venv .venv && .venv/bin/pip install -q -e '.[postgres,api,test]' tzdata
service postgresql start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\""
export PRSYSTEM_TEST_ADMIN_DSN=postgresql://postgres:postgres@127.0.0.1:5432/postgres
npm install --no-save --package-lock=false playwright@1.62.1 @axe-core/playwright@4.13.0
export PRSYSTEM_BROWSER_PATH=/opt/pw-browsers/chromium
```

`.venv/` ба `node_modules/` нь `.gitignore`-д орсон. PostgreSQL тест `PYTHONPATH=src:tests` шаарддаг, учир нь тестүүд `postgres_support`-ийг шууд import хийдэг. Baseline (`1faa290`): `tests.test_booking_holds`, `tests.test_restaurant_orders`, `tests.test_handover_lifecycle` — 86/86 OK. `tests/browser/reception.cjs` давсан.

---

### Task 1: B-01 — Walk-in цагийг half-hour unit руу хөрвүүлэх

**Шаардлага:** REQ-02-03.01, REQ-02-07.12, STAY-DEC-014 (`docs/02:38`). Reception цаг оруулна. Сервер 30 минутын бүхэл нэгж (`duration_units`) хадгална. Одоо "2" цаг оруулахад `duration_units=2` (60 минут, хагас үнэ) илгээгддэг.

**Files:**
- Modify: `src/prsystem/static/reception.js:26` (helper нэмэх), `:537` (талбар), `:546` (payload)
- Test: `tests/browser/reception.cjs:37-39`

**Interfaces:**
- Consumes: `form()`-ийн `decimal:true` number талбар (`reception.js:32-72`). `action` дотор шидсэн `Error` нь `.result.error` статус болж харагдана.
- Produces: `stayUnits(kind, value) -> int`. `kind==='HOURLY'` бол `value*2`, `NIGHTLY` бол `value`. Бүхэл ≥1 биш бол `Error` шиднэ. API payload өөрчлөгдөхгүй: `{kind, duration_units:int}`.

- [ ] **Step 1: Унадаг browser тест бичих**

`tests/browser/reception.cjs`-ийн 37-р мөрийн дараа (`...'Бэлэн барьцааг биечлэн авсан',{exact:false}).check();` мөрийн дараа, `failure=true;` мөрийн өмнө) доорх гурван мөрийг оруулна:

```js
  const duration=page.getByLabel('Хугацаа: цагаар бол цаг (0.5 алхам), хоногоор бол хоног',{exact:true});assert.equal(await page.getByLabel('Хугацааны төрөл',{exact:true}).inputValue(),'HOURLY');assert.equal(await duration.inputValue(),'1');
  await duration.fill('1.25');await page.getByRole('button',{name:'Зочны бүртгэл баталгаажуулах',exact:true}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.result.error')).some(n=>n.textContent.includes('0.5 алхмаар')));assert.equal(requests.filter(r=>r.tail==='stays/check-in').length,0);
  await duration.fill('2');
```

39-р мөрийн `assert.equal(writes[1].body.idempotency_key,first.body.idempotency_key);`-ийн дараа ижил мөрөнд нэмнэ:

```js
assert.equal(writes[1].body.kind,'HOURLY');assert.equal(writes[1].body.duration_units,4);assert.equal('duration' in writes[1].body,false);
```

- [ ] **Step 2: Тест унаж байгааг шалгах**

Run: `node tests/browser/reception.cjs`
Expected: FAIL — `locator.inputValue: Timeout 30000ms exceeded` (`getByLabel('Хугацаа: цагаар бол цаг (0.5 алхам), хоногоор бол хоног')` одоогоор байхгүй).

- [ ] **Step 3: Хамгийн бага засвар**

`reception.js:26`-ийн (`const amount=...`) дараа:

```js
  // STAY-DEC-014: Reception enters hours in 0.5 steps; the API stores half-hour units.
  const stayUnits=(kind,value)=>{const units=kind==='HOURLY'?value*2:value;if(!Number.isSafeInteger(units)||units<1)throw new Error(kind==='HOURLY'?'Цагийг 0.5 алхмаар оруулна уу, жишээ нь 1.5.':'Хоногийн тоог бүхэл тоогоор оруулна уу.');return units;};
```

`reception.js:537` дотор:

```js
amount('duration_units','Цаг / хоногийн тоо',1)
```
→
```js
field('duration','Хугацаа: цагаар бол цаг (0.5 алхам), хоногоор бол хоног','number',{min:0.5,value:1,decimal:true})
```

`reception.js:546` дотор:

```js
duration_units:v.duration_units
```
→
```js
duration_units:stayUnits(v.kind,v.duration)
```

(`reception.js:655`-ийн mock booking маягтад хүрэхгүй. Review Focus-ийн "Хамрахгүй" хэсгийг үзнэ.)

- [ ] **Step 4: Тест давж байгааг шалгах**

Run: `node tests/browser/reception.cjs && node tests/browser/ui-quality.cjs && node tests/browser/daily-workflows.cjs && PYTHONPATH=src .venv/bin/python tests/browser/validate_requests.py artifacts/reception-requests.json`
Expected: гурван suite "…passed" гэж хэвлэнэ. `validate_requests.py` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/prsystem/static/reception.js tests/browser/reception.cjs
git commit -m "fix(reception): convert walk-in hours to half-hour units (B-01)

REQ-02-03.01/REQ-02-07.12, STAY-DEC-014: Reception enters hours in 0.5
steps; the UI sends duration_units=hours*2 for HOURLY stays and rejects
non half-hour values before any request. Server rules are unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 2: B-05 — Grace дотор Restaurant зочны захиалга

**Шаардлага:** REQ-17-06.00, REQ-17-07.03, LIFE-DEC-003 (`docs/17:158-168`). Grace-ийн 48 цагт package-ийн бүх эрх хэвийн ажиллана. Одоо `restaurant_orders.py:73` `now >= expires_at` үед хаадаг.

**Files:**
- Modify: `src/prsystem/restaurant_orders.py:8` (import), `:73`
- Test: `tests/test_restaurant_orders.py` (`RestaurantOrderTests` класын төгсгөлд)

**Interfaces:**
- Consumes: `RestaurantOrders.guest(conn, bearer, ordering=True)`. `create()` ба `invoice()` хоёулаа үүнийг дуудна. `RestaurantOrders.now` тестэд `self.clock`-оор patch хийгдсэн.
- Produces: алдааны код өөрчлөгдөхгүй. `now >= expires_at + 48h` бол `SUBSCRIPTION_EXPIRED`.

- [ ] **Step 1: Унадаг тест бичих**

`tests/test_restaurant_orders.py`-ийн төгсгөлд (класын дотор, 4 зайн indent):

```python
    def expire_subscription(self, hours_ago):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.hotel_access SET expires_at=%s WHERE tenant_id=%s', (self.clock-timedelta(hours=hours_ago), self.tenant))

    def test_guest_orders_during_grace_and_locks_at_grace_end(self):
        # REQ-17-06.00 / LIFE-DEC-003: grace keeps every package right, Restaurant included.
        self.expire_subscription(1)
        created = self.flow.create(self.guest_token,self.restaurant,{'soup':1},'grace-order')
        self.assertEqual(self.flow.invoice(self.guest_token,created['order_id'])['amount_mnt'],4000)
        self.expire_subscription(48)
        with self.assertRaisesRegex(DomainError,'SUBSCRIPTION_EXPIRED'):
            self.flow.create(self.guest_token,self.restaurant,{'soup':1},'after-grace-order')
```

- [ ] **Step 2: Тест унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_restaurant_orders.RestaurantOrderTests.test_guest_orders_during_grace_and_locks_at_grace_end -v`
Expected: ERROR — `prsystem.common.DomainError: SUBSCRIPTION_EXPIRED` (эхний `create` дээр).

- [ ] **Step 3: Хамгийн бага засвар**

`restaurant_orders.py:8`:

```python
from datetime import date, datetime
```
→
```python
from datetime import date, datetime, timedelta
```

`restaurant_orders.py:73`:

```python
            if self.now(conn) >= access[1]:
```
→
```python
            # LIFE-DEC-003: guests keep ordering through the 48h grace period.
            if self.now(conn) >= access[1] + timedelta(hours=48):
```

- [ ] **Step 4: Тест давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_restaurant_orders -v`
Expected: бүх тест OK (шинэ тест мөн).

- [ ] **Step 5: Commit**

```bash
git add src/prsystem/restaurant_orders.py tests/test_restaurant_orders.py
git commit -m "fix(restaurant): keep guest ordering open during subscription grace (B-05)

REQ-17-06.00/REQ-17-07.03, LIFE-DEC-003: new Restaurant guest orders and
invoices are allowed until expires_at+48h and locked from that instant.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 3: B-03 — Manager Plus дангаараа NO_SHOW хийхгүй

**Шаардлага:** REQ-18-03.03, REQ-18-09.00, REQ-18-10.16, RBAC-DEC-016 (`docs/18:165,172,351`). `NO_SHOW`-г Reception эсвэл Manager батална. Manager Plus role дангаараа энэ эрхийг өвлөхгүй. `CANCELLED_HOTEL` болон upgrade-ийг Manager/Manager Plus хийнэ. Одоо `staff_hold(manager=False)` нь `_manager()`-ээр дамжуулан 30,000₮ багцын MP-only account-ийг зөвшөөрдөг.

**Files:**
- Modify: `src/prsystem/booking_lifecycle.py:15`
- Test: `tests/test_booking_holds.py` (`BookingHoldTests` класын төгсгөлд)

**Interfaces:**
- Consumes: `OperationalCase.add_staff(roles) -> (account_id, token)` (`tests/operational_support.py:38`), `BookingHoldTests.terminal(hold,outcome,token,key)`, `begin()`, `pay()`, `call()`.
- Produces: `staff_hold(conn,token,tenant,hold,manager)`. `manager=True` (CANCELLED_HOTEL, upgrade) бол `_manager(roles,package)`. `manager=False` (NO_SHOW) бол `RECEPTION` эсвэл `MANAGER` role шаардлагатай.

- [ ] **Step 1: Унадаг тест бичих**

`tests/test_booking_holds.py`-ийн төгсгөлд (класын дотор):

```python
    def pass_no_show_cutoff(self):
        from psycopg.types.json import Jsonb
        with psycopg.connect(self.owner_dsn) as conn:
            snapshot=conn.execute('SELECT snapshot FROM prsystem.booking_hold WHERE tenant_id=%s',(self.tenant,)).fetchone()[0]
            snapshot['no_show_cutoff']=(datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()
            conn.execute('ALTER TABLE prsystem.booking_hold DISABLE TRIGGER preserve_booking_hold')
            conn.execute('UPDATE prsystem.booking_hold SET snapshot=%s WHERE tenant_id=%s',(Jsonb(snapshot),self.tenant))
            conn.execute('ALTER TABLE prsystem.booking_hold ENABLE TRIGGER preserve_booking_hold')

    def test_manager_plus_alone_cannot_confirm_no_show(self):
        # REQ-18-03.03 / RBAC-DEC-016: Manager Plus alone does not inherit Manager no-show.
        hold=self.begin();self.pay();self.call(hold,'/reconcile');self.pass_no_show_cutoff()
        _,plus=self.add_staff(['MANAGER_PLUS'])
        self.assert_status(self.terminal(hold,'NO_SHOW',plus,key='plus-no-show'),403)
        # Manager Plus keeps CANCELLED_HOTEL authority: it reaches the time rule, not 403.
        self.assertEqual(self.terminal(hold,'CANCELLED_HOTEL',plus,key='plus-cancel').json()['code'],'ACTUAL_TIME_OUT_OF_RANGE')
        _,plus_reception=self.add_staff(['MANAGER_PLUS','RECEPTION'])
        result=self.assert_status(self.terminal(hold,'NO_SHOW',plus_reception,key='plus-reception'),200)
        self.assertEqual(result['booking_state'],'NO_SHOW')
```

- [ ] **Step 2: Тест унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_booking_holds.BookingHoldTests.test_manager_plus_alone_cannot_confirm_no_show -v`
Expected: FAIL — `AssertionError: 200 != 403`.

- [ ] **Step 3: Хамгийн бага засвар**

`booking_lifecycle.py:15`:

```python
        allowed=self._manager(principal['roles'],hotel[0]) or (not manager and 'RECEPTION' in principal['roles'])
```
→
```python
        # RBAC-DEC-016: NO_SHOW is Reception/Manager only; Manager Plus alone keeps
        # CANCELLED_HOTEL/upgrade authority but does not inherit no-show.
        allowed=self._manager(principal['roles'],hotel[0]) if manager else bool({'RECEPTION','MANAGER'}&set(principal['roles']))
```

- [ ] **Step 4: Тест давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_booking_holds.BookingHoldTests.test_manager_plus_alone_cannot_confirm_no_show tests.test_booking_holds.BookingHoldTests.test_no_show_cutoff_and_manager_reception_permissions tests.test_booking_holds.BookingHoldTests.test_hotel_cancellation_checks_rooms_and_requires_manager -v`
Expected: 3 тест OK.

- [ ] **Step 5: Commit**

```bash
git add src/prsystem/booking_lifecycle.py tests/test_booking_holds.py
git commit -m "fix(booking): Manager Plus alone cannot confirm NO_SHOW (B-03)

REQ-18-03.03/REQ-18-10.16, RBAC-DEC-016: NO_SHOW requires Reception or
Manager. Manager Plus keeps CANCELLED_HOTEL and upgrade authority.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 4: B-04 — Grace дотор буудал public listing/booking-д харагдана

**Шаардлага:** REQ-17-06.00, REQ-17-06.03, REQ-17-07.04, LIFE-DEC-004 (`docs/17:200-201,229`). Зөвхөн `expires_at` өнгөрсөн, grace үргэлжилж буй буудал харагдсан хэвээр байна. Grace дуусахад нуугдана. Одоо `booking_public.py:88,110` `h.expires_at>clock_timestamp()` шүүлтүүрээр шууд нууж байна. Мөн `tests/test_booking_holds.py:731` нь grace доторх нуултыг "зөв" гэж түгжсэн.

**Files:**
- Modify: `src/prsystem/booking_public.py:88` (`listing`), `:110` (`search`)
- Test: `tests/test_booking_holds.py:727-732` (одоогийн тестийг grace-ийн дараах хил рүү шилжүүлэх) + шинэ тест

**Interfaces:**
- Consumes: `booker_setup()`, `public_search()`, `customer_hold(token=None,key='customer')` (`tests/test_booking_holds.py:685-705`).
- Produces: `BookingPublic.listing/search` нь `h.expires_at+interval '48 hours'>clock_timestamp()` үед харуулна. `create()` нь `listing()`-ээр дамжина. `create_locked()` grace-ийг аль хэдийн зөв шалгадаг (`booking_holds.py:126`).

- [ ] **Step 1: Унадаг тест бичих + шаардлагатай зөрж буй тестийг засах**

`tests/test_booking_holds.py:731` дотор:

```python
            conn.execute('UPDATE prsystem.booking_publication SET allowed=true WHERE tenant_id=%s',(self.tenant,));conn.execute("UPDATE prsystem.hotel_access SET expires_at=now()-interval '1 hour' WHERE tenant_id=%s",(self.tenant,))
```
→ (REQ-17-06.03: нуулт зөвхөн grace дууссаны дараа)
```python
            conn.execute('UPDATE prsystem.booking_publication SET allowed=true WHERE tenant_id=%s',(self.tenant,));conn.execute("UPDATE prsystem.hotel_access SET expires_at=now()-interval '48 hours 1 minute' WHERE tenant_id=%s",(self.tenant,))
```

Класын төгсгөлд шинэ тест:

```python
    def test_hotel_in_subscription_grace_stays_public_and_bookable(self):
        # REQ-17-06.03 / LIFE-DEC-004: expires_at alone does not hide the hotel.
        self.booker_setup()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_access SET expires_at=now()-interval '1 hour' WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual([h['tenant_id'] for h in self.assert_status(self.public_search(),200)['items']],[self.tenant])
        self.assertEqual(self.assert_status(self.customer_hold(),201)['booking_state'],'HOLDING')
```

- [ ] **Step 2: Тест унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_booking_holds.BookingHoldTests.test_hotel_in_subscription_grace_stays_public_and_bookable tests.test_booking_holds.BookingHoldTests.test_unpublished_and_expired_hotels_cannot_accept_new_customer_holds -v`
Expected: шинэ тест FAIL — `AssertionError: Lists differ: [] != ['<tenant>']`. Засагдсан хуучин тест OK.

- [ ] **Step 3: Хамгийн бага засвар**

`booking_public.py:88` ба `:110` хоёуланд нь SQL доторх:

```
h.expires_at>clock_timestamp()
```
→
```
h.expires_at+interval '48 hours'>clock_timestamp()
```

`def listing` (`:85`)-ийн өмнө нэг мөр тайлбар нэмнэ:

```python
    # LIFE-DEC-004: a hotel stays public/bookable through the 48h subscription grace.
```

- [ ] **Step 4: Тест давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_booking_holds -v`
Expected: бүх тест OK.

- [ ] **Step 5: Commit**

```bash
git add src/prsystem/booking_public.py tests/test_booking_holds.py
git commit -m "fix(booking): keep hotels public and bookable during grace (B-04)

REQ-17-06.03/REQ-17-07.04, LIFE-DEC-004: public listing/search/create use
expires_at+48h. The old test asserted hiding inside grace, contrary to the
requirement; it now pins hiding after grace instead.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 5: B-02 — Category түвшний online booking нь category retirement-ийг блоклоно

**Шаардлага:** REQ-26-05.00, REQ-26-12.00, REQ-26-13.03, RML-DEC-001–006 (`docs/26:109`). Category-г `INACTIVE` болгохын өмнө future booking шийдэгдсэн байх ёстой. Одоо `024_room_lifecycle.sql:32` `category_blockers` нь зөвхөн room-level `room_reservation`-ийг шалгадаг. Online booking нь category түвшний `booking_hold` (`BK-DEC-013`).

**Анхаарах:** `booking_hold`, `booking_hold_application`, `booking_hold_cancellation` нь `FORCE ROW LEVEL SECURITY`-тэй (`034:84-86`, `035:14-16`, `036:16-18`). `RoomLifecycle.change` нь `_queue_actor`-оор дамждаг бөгөөд tenant scope тохируулдаггүй (`membership.py:112-123`). Тиймээс зөвхөн migration нэмэхэд тест улаан хэвээр байна. `RoomLifecycle.blockers/sweep` дотор `scope()` заавал дуудна.

**Files:**
- Create: `src/prsystem/postgres/migrations/078_category_booking_blockers.sql`
- Modify: `src/prsystem/room_lifecycle.py:1-18` (`scope` import, `sweep`, `blockers`)
- Modify: `src/prsystem/booking_holds.py:269` (`reconcile` return-ийн өмнө), `:339` (`cancel_in_transaction` return-ийн өмнө)
- Test: `tests/test_booking_holds.py` (класын төгсгөлд)

**Interfaces:**
- Consumes: `booking_inventory.scope(conn, tenant)` (`set_config('prsystem.tenant_id',…,true)`), `booking_inventory.claims`-ийн predicate (`hold_state IN ('ACTIVE','CONSUMED')`, application/cancellation байхгүй).
- Produces: `prsystem.category_blockers(text,text) -> text[]`. `'BOOKING'` нь room reservation эсвэл амьд category hold-ын аль нэгээс үүснэ. `RoomLifecycle.sweep(conn,tenant)` нь hold terminal болох бүрт дуудагдана.

- [ ] **Step 1: Унадаг тест бичих**

`tests/test_booking_holds.py`-ийн төгсгөлд:

```python
    def deactivate(self,kind,entity,key):
        table,path=('room','rooms') if kind=='room' else ('room_category','room-categories')
        with psycopg.connect(self.owner_dsn) as conn:
            revision=conn.execute(sql.SQL('SELECT revision FROM prsystem.{} WHERE tenant_id=%s AND id=%s').format(sql.Identifier(table)),(self.tenant,entity)).fetchone()[0]
        return self.assert_status(self.client.post(f'/hotels/{self.tenant}/{path}/{entity}/lifecycle',headers=self.headers(self.manager_token),
            json=dict(action='DEACTIVATE',expected_revision=revision,reason='Planned room retirement',idempotency_key=key)),200)

    def category_status(self):
        with psycopg.connect(self.owner_dsn) as conn:
            return conn.execute('SELECT status FROM prsystem.room_category WHERE tenant_id=%s AND id=%s',(self.tenant,self.category)).fetchone()[0]

    def test_confirmed_category_booking_blocks_category_retirement(self):
        # REQ-26-05.00 / RML-DEC-003: category stays RETIRING until its online booking resolves.
        hold=self.begin();self.pay();self.assertEqual(self.call(hold,'/reconcile').json()['booking_state'],'CONFIRMED')
        retiring=self.deactivate('category',self.category,'category-off')
        self.assertEqual(retiring['status'],'RETIRING');self.assertIn('BOOKING',retiring['blockers'])
        self.deactivate('room',self.room,'room-off')
        self.assertEqual(self.category_status(),'RETIRING')
        self.assert_status(self.cancel(hold),200)
        self.assertEqual(self.category_status(),'INACTIVE')

    def test_expired_unpaid_hold_releases_category_retirement(self):
        hold=self.begin()
        self.assertIn('BOOKING',self.deactivate('category',self.category,'category-off')['blockers'])
        self.deactivate('room',self.room,'room-off')
        self.assertEqual(self.category_status(),'RETIRING')
        self.age(hold)
        self.assertEqual(self.assert_status(self.call(hold,'/reconcile'),200)['booking_state'],'EXPIRED')
        self.assertEqual(self.category_status(),'INACTIVE')
```

- [ ] **Step 2: Тест унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_booking_holds.BookingHoldTests.test_confirmed_category_booking_blocks_category_retirement tests.test_booking_holds.BookingHoldTests.test_expired_unpaid_hold_releases_category_retirement -v`
Expected: хоёулаа FAIL — `AssertionError: 'BOOKING' not found in ['ACTIVE_ROOMS']`.

- [ ] **Step 3: Migration нэмэх**

`src/prsystem/postgres/migrations/078_category_booking_blockers.sql`:

```sql
-- REQ-26-05.00 / RML-DEC-003: a category with a live category-level online booking
-- (same predicate as booking_inventory.claims) cannot become INACTIVE.
-- booking_hold* tables force tenant RLS: callers must set prsystem.tenant_id first.
CREATE OR REPLACE FUNCTION prsystem.category_blockers(p_tenant text,p_category text) RETURNS text[] LANGUAGE sql STABLE AS $$
 SELECT array_remove(ARRAY[
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room WHERE tenant_id=p_tenant AND category_id=p_category AND status<>'INACTIVE') THEN 'ACTIVE_ROOMS' END,
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room r JOIN prsystem.stay s ON(s.tenant_id,s.room_id)=(r.tenant_id,r.id)
 WHERE r.tenant_id=p_tenant AND r.category_id=p_category AND s.state='ACTIVE') THEN 'ACTIVE_STAY' END,
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room r JOIN prsystem.room_reservation b ON(b.tenant_id,b.room_id)=(r.tenant_id,r.id)
 WHERE r.tenant_id=p_tenant AND r.category_id=p_category AND b.state='CONFIRMED' AND b.planned_checkout_at>clock_timestamp())
 OR EXISTS(SELECT 1 FROM prsystem.booking_hold h WHERE h.tenant_id=p_tenant AND h.category_id=p_category
 AND h.hold_state IN ('ACTIVE','CONSUMED') AND h.planned_checkout_at>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM prsystem.booking_hold_application a WHERE (a.tenant_id,a.hold_id)=(h.tenant_id,h.id))
 AND NOT EXISTS(SELECT 1 FROM prsystem.booking_hold_cancellation x WHERE (x.tenant_id,x.hold_id)=(h.tenant_id,h.id))) THEN 'BOOKING' END
 ],NULL);
$$;
```

`CREATE OR REPLACE` нь `024`-ийн `REVOKE ... FROM PUBLIC` болон тестийн `GRANT EXECUTE`-ийг хадгална. `024`-т хүрэхгүй.

- [ ] **Step 4: Migration-ий дараа ч унасан хэвээр байгааг шалгах (RLS)**

Run: Step 2-ийн команд.
Expected: FAIL хэвээр — `'BOOKING' not found in ['ACTIVE_ROOMS']`. Tenant scope-гүй үед RLS нь hold мөрүүдийг нууж байна. Хэрэв энэ алхамд тест давбал зогсоод шалтгааныг шалгана (RLS-ийн таамаг буруу байна гэсэн үг).

- [ ] **Step 5: Tenant scope ба hold terminal-ийн sweep нэмэх**

`room_lifecycle.py:5-18`:

```python
from prsystem.postgres.connection import transaction


class RoomLifecycle(RoomService):
    @staticmethod
    def sweep(conn,tenant):
        if conn.execute(...
```
→
```python
from prsystem.postgres.connection import transaction
from prsystem.booking_inventory import scope


class RoomLifecycle(RoomService):
    @staticmethod
    def sweep(conn,tenant):
        scope(conn,tenant)  # category_blockers reads tenant-RLS booking_hold rows.
        if conn.execute(...
```

ба

```python
    @staticmethod
    def blockers(conn,tenant,kind,entity):
        function='room_blockers' if kind=='room' else 'category_blockers'
```
→
```python
    @staticmethod
    def blockers(conn,tenant,kind,entity):
        scope(conn,tenant)
        function='room_blockers' if kind=='room' else 'category_blockers'
```

`booking_holds.py:269` (`reconcile`-ийн төгсгөл):

```python
                self.event_row(conn,tenant,hold,'HOLD_EXPIRED',{})
            return self.statement(conn,tenant,hold)
```
→
```python
                self.event_row(conn,tenant,hold,'HOLD_EXPIRED',{})
            from prsystem.room_lifecycle import RoomLifecycle
            RoomLifecycle.sweep(conn,tenant)  # A released hold may finish category retirement.
            return self.statement(conn,tenant,hold)
```

`booking_holds.py:337-339` (`cancel_in_transaction`-ийн төгсгөл):

```python
        self.event_row(conn,tenant,hold,'BOOKING_'+outcome,result)
        return result
```
→
```python
        self.event_row(conn,tenant,hold,'BOOKING_'+outcome,result)
        from prsystem.room_lifecycle import RoomLifecycle
        RoomLifecycle.sweep(conn,tenant)  # Cancellation/no-show may finish category retirement.
        return result
```

(Бусад module-тай адил local import ашиглана. `checkout.py:139`-ийг үзнэ.)

- [ ] **Step 6: Тест давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_booking_holds tests.test_handover_lifecycle tests.test_minibar_configuration tests.test_minibar_lifecycle -v`
Expected: бүх тест OK. Хэрэв өөр test class `permission denied for table booking_hold` гэж унавал тухайн support класс `WalkInCase`-ийн grant-гүй байна (`tests/walkin_support.py:27`). Тэр класст ижил `GRANT SELECT ON prsystem.booking_hold,prsystem.booking_hold_application,prsystem.booking_hold_cancellation` нэмнэ. Production runtime role-д энэ grant аль хэдийн шаардлагатай (walk-in check-in capacity).

- [ ] **Step 7: Commit**

```bash
git add src/prsystem/postgres/migrations/078_category_booking_blockers.sql src/prsystem/room_lifecycle.py src/prsystem/booking_holds.py tests/test_booking_holds.py
git commit -m "fix(rooms): block category retirement on live online bookings (B-02)

REQ-26-05.00/REQ-26-13.03, RML-DEC-003: forward migration 078 adds live
category-level booking holds (booking_inventory.claims predicate) to
category_blockers. Room lifecycle now scopes the tenant before reading the
RLS-forced booking tables, and hold expiry/cancellation/no-show re-run the
retirement sweep. Migration 024 is unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 6: B-06 — Зочин/public хариунд гэрээний нөхцөл гаргахгүй

**Шаардлага:** REQ-09-11.00 (`docs/09:372`). Нийтийн API-д гэрээний хувийг гаргахгүй. Одоо `/public/booking-hotels` quote, `/guest/booking-holds/...` statement (`quote`, `confirmation`, `cancellation`) болон `/booker/...` хариунд `commission_rate_bps`, `contract_id`, `contract_version`, `rate_bps` гарч байна. Guest cancel-ийн хариунд `commission_mnt`/`hotel_payable_mnt` гарч, хувийг тооцоолох боломж олгож байна. `tests/test_booking_holds.py:193-194,340,354-355` зочны хариунд эдгээр гарахыг түгжиж байна. Эдгээр assert-ийг staff inbox руу шилжүүлнэ.

**Files:** (мөрийн дугаар `1faa290`-ийнх. Task 4, 5-ын засварын дараа `booking_public.py` 1 мөрөөр, `booking_holds.py` `reconcile`-ээс хойш 2 мөрөөр шилжинэ. Иймд доор өгсөн кодын агуулгаар хайна.)
- Modify: `src/prsystem/booking_holds.py:23-25` (`guest_view` нэмэх), `:172` (`read`), `:269` (`reconcile`), `:309,:313` (`cancel_guest`)
- Modify: `src/prsystem/booking_public.py:9` (import), `:105` (`detail`), `:134` (`create`), `:140` (`owned`)
- Test: `tests/test_booking_holds.py:190-194, 340, 354-355` + шинэ тест

**Interfaces:**
- Consumes: `BookingHolds.statement(conn,tenant,hold)` (дотоод/staff-д бүтэн хэвээр), staff inbox `GET /hotels/{t}/booking-holds` (`BookingLifecycle.inbox`, бүтэн statement).
- Produces: `guest_view(value)`. Энэ нь dict/list-ээс `CONTRACT_TERMS`-ийн түлхүүрүүдийг бүх гүнд хасна. Guest/public/booker хариу бүр үүгээр дамжина. Staff (`/hotels/...`) ба Platform хариу өөрчлөгдөхгүй.

- [ ] **Step 1: Унадаг тест бичих + зочны хариунд нууц талбар түгжсэн assert-уудыг staff тал руу шилжүүлэх**

Файлын дээд хэсэгт, `@unittest.skipUnless` классын өмнө (import-уудын дараа):

```python
# REQ-09-11.00: platform contract terms and the commission split stay server-side.
CONTRACT_TERMS={'contract_id','contract_version','commission_rate_bps','rate_bps','commission_mnt','hotel_payable_mnt','confirmation'}


def exposed_terms(value):
    if isinstance(value,dict):return {k for k in value if k in CONTRACT_TERMS}.union(*map(exposed_terms,value.values()))
    if isinstance(value,list):return set().union(*map(exposed_terms,value))
    return set()
```

Класт helper (`def cancel` (`:334`)-ийн дараа):

```python
    def staff_booking(self,hold):
        inbox=self.assert_status(self.client.get(f'/hotels/{self.tenant}/booking-holds',headers=self.headers(self.manager_token)),200)
        return next(b for b in inbox if b['booking_id']==hold['booking_id'])
```

`:190-194`:

```python
    def test_confirmation_snapshots_current_contract_without_repricing_hold(self):
        hold=self.begin();self.assert_status(self.contract(rate=1000,revision=1,key='update'),200);self.pay()
        result=self.assert_status(self.call(hold,'/reconcile'),200)
        self.assertEqual(result['confirmation']['rate_bps'],1000)
        self.assertEqual((result['quote']['amount_mnt'],result['quote']['commission_rate_bps']),(160000,375))
```
→
```python
    def test_confirmation_snapshots_current_contract_without_repricing_hold(self):
        hold=self.begin();self.assert_status(self.contract(rate=1000,revision=1,key='update'),200);self.pay()
        self.assert_status(self.call(hold,'/reconcile'),200)
        staff=self.staff_booking(hold)  # REQ-09-11.00: contract terms are staff-side only.
        self.assertEqual(staff['confirmation']['rate_bps'],1000)
        self.assertEqual((staff['quote']['amount_mnt'],staff['quote']['commission_rate_bps']),(160000,375))
```

`:340`:

```python
        self.assertEqual((result['refund_due'],result['retained_mnt'],result['commission_mnt']),(160000,0,0))
```
→
```python
        self.assertEqual((result['refund_due'],result['retained_mnt']),(160000,0))
        self.assertEqual(self.staff_booking(hold)['cancellation']['commission_mnt'],0)
```

`:354-355`:

```python
        self.assertEqual((result['retained_mnt'],result['refund_due'],result['commission_mnt'],result['hotel_payable_mnt']),(80000,80000,8000,72000))
        self.assertEqual(self.call(hold).json()['cancellation']['commission_mnt'],8000)
```
→
```python
        self.assertEqual((result['retained_mnt'],result['refund_due']),(80000,80000))
        staff=self.staff_booking(hold)['cancellation']
        self.assertEqual((staff['commission_mnt'],staff['hotel_payable_mnt']),(8000,72000))
```

Класын төгсгөлд шинэ тест:

```python
    def test_guest_and_public_booking_responses_hide_contract_terms(self):
        # REQ-09-11.00: guest/public/booker APIs never carry contract rate, id, version or commission split.
        self.booker_setup()
        self.assertEqual(exposed_terms(self.assert_status(self.public_search(),200)),set())
        hold=self.assert_status(self.customer_hold(),201)
        self.assertEqual(exposed_terms(hold),set())
        self.attempt=self.assert_status(self.call(hold,'/reconcile'),200)['attempts'][0]['attempt_id'];self.pay()
        confirmed=self.assert_status(self.call(hold,'/reconcile'),200)
        self.assertEqual(confirmed['booking_state'],'CONFIRMED');self.assertEqual(exposed_terms(confirmed),set())
        self.assertEqual(exposed_terms(self.assert_status(self.call(hold),200)),set())
        self.assertEqual(exposed_terms(self.assert_status(self.client.get('/booker/bookings',headers=self.headers(self.booker_token)),200)),set())
        cancelled=self.assert_status(self.cancel(hold,'hide-terms'),200)
        self.assertEqual(exposed_terms(cancelled),set())
        self.assertEqual(self.assert_status(self.cancel(hold,'hide-terms'),200),cancelled)
        self.assertEqual(exposed_terms(self.assert_status(self.call(hold),200)),set())
        self.assertEqual(self.staff_booking(hold)['quote']['commission_rate_bps'],375)
```

- [ ] **Step 2: Тест унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_booking_holds.BookingHoldTests.test_guest_and_public_booking_responses_hide_contract_terms tests.test_booking_holds.BookingHoldTests.test_confirmation_snapshots_current_contract_without_repricing_hold tests.test_booking_holds.BookingHoldTests.test_guest_free_cancellation_releases_capacity_and_preserves_capture tests.test_booking_holds.BookingHoldTests.test_late_guest_cancellation_uses_confirmation_contract -v`
Expected: шинэ тест FAIL — `AssertionError: Items in the first set but not the second: 'commission_rate_bps' 'contract_id' 'contract_version'` (public search). Staff тал руу шилжүүлсэн 3 тест OK (засварын өмнө ч staff inbox бүтэн).

- [ ] **Step 3: Хамгийн бага засвар**

`booking_holds.py:23-25` (`def snapshot`)-ийн дараа:

```python
# REQ-09-11.00: platform contract terms and the commission split stay server-side.
CONTRACT_TERMS = frozenset({'contract_id', 'contract_version', 'commission_rate_bps', 'rate_bps',
                            'commission_mnt', 'hotel_payable_mnt', 'confirmation'})


def guest_view(value):
    """Guest/public projection: drop contract terms at any depth."""
    if isinstance(value, dict):
        return {k: guest_view(v) for k, v in value.items() if k not in CONTRACT_TERMS}
    if isinstance(value, list):
        return [guest_view(v) for v in value]
    return value
```

`booking_holds.py` дотор:

- `:172` (`read`): `return self.statement(conn,tenant,hold)` → `return guest_view(self.statement(conn,tenant,hold))`
- `:269` (`reconcile`, Task 5-ийн sweep-ийн дараах мөр): `return self.statement(conn,tenant,hold)` → `return guest_view(self.statement(conn,tenant,hold))` (`expire_due` зөвхөн `booking_state` уншдаг)
- `:309` (`cancel_guest`): `if replay is not None:return replay` → `if replay is not None:return guest_view(replay)`
- `:313` (`cancel_guest`): `return result` → `return guest_view(result)` (DB-д хадгалсан command result бүтэн хэвээр)

`booking_public.py:9`:

```python
from prsystem.booking_holds import snapshot
```
→
```python
from prsystem.booking_holds import snapshot,guest_view
```

`booking_public.py:105` (`detail`): `quote=snapshot(quote)` → `quote=guest_view(snapshot(quote))`

`booking_public.py:134` (`create`-ийн төгсгөл): `return dict(result,tenant_id=tenant)` → `return guest_view(dict(result,tenant_id=tenant))`

`booking_public.py:140` (`owned`): `return dict(self.booking.statement(conn,tenant,hold),tenant_id=tenant,access_token=secret)` → `return guest_view(dict(self.booking.statement(conn,tenant,hold),tenant_id=tenant,access_token=secret))`

(`BookingHolds.create` нь staff mock endpoint `/hotels/{t}/mock/booking-holds` тул бүтэн хэвээр. `inbox`, `terminal`, `booking_settlement` зэрэг staff/Platform хариу мөн бүтэн хэвээр.)

- [ ] **Step 4: Тест давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_booking_holds tests.test_booking_boundaries -v && node tests/browser/booking.cjs && PYTHONPATH=src .venv/bin/python tests/browser/validate_requests.py artifacts/booking-requests.json`
Expected: бүх тест OK, `booking.cjs` passed, validate exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/prsystem/booking_holds.py src/prsystem/booking_public.py tests/test_booking_holds.py
git commit -m "fix(booking): hide contract terms from guest and public responses (B-06)

REQ-09-11.00: guest/public/booker responses drop contract_id,
contract_version, commission_rate_bps, rate_bps, the confirmation contract
snapshot and the commission split (commission_mnt/hotel_payable_mnt, from
which the rate is derivable). Snapshots stay server-side and staff/Platform
views are unchanged; tests that pinned guest exposure now assert the staff
inbox instead.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 7: Бүрэн шалгалт, баримт шинэчлэх, push

**Files:**
- Modify: `docs/requirements-status.md` (§2 run-ийн мөр + 13 REQ мөр)
- Modify: `docs/requirements-conflicts.md` (§3-ийн доор "Хаагдсан" хүснэгт)
- Modify: `docs/requirements-roadmap.md` (§3.3-ийн доор төлөв)

- [ ] **Step 1: Domain-only (CI `test` job)**

Run: `env -u PRSYSTEM_TEST_ADMIN_DSN PYTHONPATH=src .venv/bin/python -m unittest discover -s tests 2>&1 | tail -3`
Expected: `OK (skipped=…)`. PostgreSQL тест энд skip хийдэг.

- [ ] **Step 2: PostgreSQL 4 shard, 0 skip (CI `postgres` job)**

```bash
mkdir -p artifacts
for i in 0 1 2 3; do .venv/bin/python -m scripts.run_postgres_shard --index $i --count 4 > artifacts/shard-$i.log 2>&1 & done; wait
tail -n 3 artifacts/shard-*.log; grep -h "^Discovered" artifacts/shard-0.log
```
Expected: shard бүр `OK` (skip байхгүй). Нийт тест = 937 (`1faa290`) + 6 шинэ = 943 (`Discovered 943 tests`). Шинэ тест: Task 2, 3, 4, 6-д тус бүр 1, Task 5-д 2.

- [ ] **Step 3: Browser 25 suite + payload validation + design check (CI `browser` job)**

```bash
for s in staff restaurant reception booking minibar minibar-templates operation subscription-contact minibar-partial minibar-reconciliation minibar-archive minibar-rollout minibar-batches minibar-guest minibar-refill minibar-next-stay minibar-exception minibar-lifecycle minibar-adjustments minibar-paid-corrections minibar-variance minibar-shortages minibar-billing daily-workflows ui-quality; do node tests/browser/$s.cjs || echo "FAILED $s"; done
for f in artifacts/*-requests.json; do PYTHONPATH=src .venv/bin/python tests/browser/validate_requests.py $f || echo "INVALID $f"; done
.venv/bin/python scripts/export_ui_tokens.py --check
npx --yes -p @google/design.md designmd lint DESIGN.md
```
Expected: 25 suite бүгд "passed". `FAILED`/`INVALID` мөр гарахгүй. Token check ба lint exit 0.

- [ ] **Step 4: Баримт шинэчлэх**

`docs/requirements-conflicts.md` §3 хүснэгтийн доорх "B-04, B-06 дээр…" мөрийн дараа (SHA-г `git log --format='%h %s' -6`-ээс авна):

```markdown
**Хаагдсан (2026-09-28, Batch 1):**

| # | Commit | Засвар | Тест |
| --- | --- | --- | --- |
| B-01 | `<B-01 sha>` | UI цагийг 0.5 алхмаар авч `duration_units = цаг × 2` илгээнэ | `tests/browser/reception.cjs` |
| B-02 | `<B-02 sha>` | `078`: category_blockers-т амьд category hold; lifecycle tenant scope; hold terminal-д sweep | `test_confirmed_category_booking_blocks_category_retirement`, `test_expired_unpaid_hold_releases_category_retirement` |
| B-03 | `<B-03 sha>` | NO_SHOW зөвхөн RECEPTION/MANAGER | `test_manager_plus_alone_cannot_confirm_no_show` |
| B-04 | `<B-04 sha>` | Public listing/search `expires_at + 48h` | `test_hotel_in_subscription_grace_stays_public_and_bookable` |
| B-05 | `<B-05 sha>` | Restaurant захиалга `expires_at + 48h` | `test_guest_orders_during_grace_and_locks_at_grace_end` |
| B-06 | `<B-06 sha>` | `guest_view`: guest/public/booker хариунаас гэрээний нөхцөл, commission split хасна | `test_guest_and_public_booking_responses_hide_contract_terms` |
```

`<… sha>`-г бодит богино SHA-аар солино.

`docs/requirements-status.md`:
- §2 хүснэгтэд Step 2/3-ын бодит тоогоор шинэ мөр нэмнэ: `| Batch 1 (B-01…B-06) | <HEAD sha>, локал PostgreSQL 16.13 | **<N> илэрсэн, <N> давсан, 0 унасан, 0 skip**; browser 25/25 |`.
- 13 мөр (`REQ-02-03.01`, `REQ-02-07.12`, `REQ-26-05.00`, `REQ-26-12.00`, `REQ-26-13.03`, `REQ-18-03.03`, `REQ-18-09.00`, `REQ-18-10.16`, `REQ-17-06.00`, `REQ-17-06.03`, `REQ-17-07.03`, `REQ-17-07.04`, `REQ-09-11.00`): тест баганад дээрх шинэ тестийг нэмнэ. Тайлбар баганаас тухайн B-ийн зөрүүг тайлбарласан хэсгийг хасаад `B-0x засагдсан (Batch 1);` гэж эхлүүлнэ. Төлөвийг `**хэрэгжсэн**` болгохдоо §1-ийн дүрмийг баримтална: B-ийн хэсгийг хассаны дараа тайлбарт өөр дутуу зүйл үлдээгүй тохиолдолд л өөрчилнө. Бусад тохиолдолд `**дутуу**` хэвээр үлдээнэ.

`docs/requirements-roadmap.md` §3.3-ийн төгсгөлд:

```markdown
**Төлөв (2026-09-28):** Batch 1 дууссан — B-01…B-06 хаагдсан ([зөрчлийн §3](requirements-conflicts.md#code-defects)). Нотолгоо: [төлөвийн §2](requirements-status.md).
```

- [ ] **Step 5: Commit ба push**

```bash
git add docs/requirements-status.md docs/requirements-conflicts.md docs/requirements-roadmap.md
git commit -m "docs: record Batch 1 (B-01…B-06) closure and verification run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
git push -u origin final
```
Expected: push амжилттай. Network алдаа гарвал 2s/4s/8s/16s зайтайгаар 4 хүртэл удаа дахин оролдоно.
