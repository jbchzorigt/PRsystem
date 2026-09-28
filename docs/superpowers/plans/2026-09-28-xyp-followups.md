# ХУР lookup-ийн дагалдах засварууд Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ХУР-ын урсгалыг production-д бэлэн болгох:
- ХУР холбогдоогүй үед шалтгааныг харуулж шууд гараар бүртгэх;
- адаптерын 10 секундийн timeout болон алдааны төрлийн мөр;
- FOUND үед илүү талбар хориглох;
- хугацаа дууссан хайлтыг оруулсан утгуудаа алдалгүй дахин татах;
- баримтыг бодит schema-тай тааруулах.

**Architecture:** Сервер, UI, баримт гэсэн гурван хэсэг.
- **Сервер (`xyp_lookups.py`):** хариунд `reason` нэмнэ; ХУР холбогдоогүй хайлтыг хязгаарт тоолохгүй; адаптерыг хязгаартай thread pool-д timeout-той дуудна.
- **Бүтэц:** `bind()` нь SQL ажиллуулдаг тул "цэвэр" `xyp.py`-аас `stays.py` руу шилжинэ.
- **UI (`reception.js`):** хариуны шалтгаан бүрт мессеж, товч; `form()`-д ерөнхий `failure` hook нэмж, түүгээр "ХУР-аас дахин татах" хийнэ.
- **Шинэ migration байхгүй.**

**Tech Stack:** Python 3.12, FastAPI, psycopg 3, PostgreSQL (FORCE RLS), vanilla JS, Playwright (node).

**Spec:** `docs/superpowers/specs/2026-09-28-xyp-followups-design.md`

## Global Constraints

- Branch `final`. Commit бүр дараах мөрүүдээр төгсөнө:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd
  ```
- `src/prsystem/xyp.py` psycopg, `scope`, `validate_identity` import хийхгүй (CI domain job psycopg-гүй).
- РД, овог, нэр, төрсөн огноо event, receipt, log-д хэзээ ч бичигдэхгүй.
- Хуучин migration-д гар хүрэхгүй (checksum). Энэ plan шинэ migration нэмэхгүй.
- UI-ийн мессежүүд spec §5.1-ийн хүснэгтээс яг хуулна:
  - `ХУР-д энэ РД-ээр мэдээлэл олдсонгүй.`
  - `ХУР холбогдоогүй байна. Гараар бүртгэнэ үү.`
  - `ХУР хугацаандаа хариулсангүй.`
  - `ХУР-тай холбогдож чадсангүй.`
  - `ХУР-ын мэдээлэл РД-тэй таарахгүй байна.`
- Timeout: `TIMEOUT_SECONDS = 10` (`xyp.py`), pool `max_workers=8`.

## Plan-level refinements (spec-ээс зөрсөн, хэрэгжүүлэхээс өмнө захиалагчид мэдэгдсэн)

1. **`XYP_LOOKUP_USED`-ийн мессеж:** spec §5.2 "одоогийн мессеж хэвээр" гэсэн. Гэтэл одоогийн мессеж "…Дахин татна уу." нь дахин татахыг санал болгодог бөгөөд USED үед дахин татах товч гаргахгүй гэсэн шийдвэртэй зөрчилдөнө. Шинэ мессеж: `Энэ хайлтаар аль хэдийн бүртгэсэн. Идэвхтэй байрлалтуудаа шалгана уу.`
2. **Шинэ browser suite:** spec §6-ийн UI тестүүдийг урт, дараалалдаа хамааралтай `reception.cjs`-д биш, шинэ `tests/browser/reception-xyp.cjs`-д бичнэ. Энэ suite-ийг CI-д нэмнэ. Browser suite-ийн тоо 25 → 26.

## Review Focus

1. **Timeout-ийн дараа хоцорч ирсэн ХУР-ын хариу:** хаягдах ёстой. FOUND мөр үүсэхгүй, citizen өгөгдөл хадгалагдахгүй. Тест: Task 2.
2. **Дахин татахад өөр РД оруулаад FOUND биш хариу авах:** check-in маягт хаагдаж, ердийн мессеж, товч гарна. Хуучин хайлтын дугаартай маягт үлдэхгүй. Тест: Task 4 (browser).
3. **"ХУР-аас дахин татах" товчийг давхар дарах:** зөвхөн нэг дахин татах маягт гарна. Тест: Task 4 (browser).
4. **ХУР холбогдоогүй хайлтыг ижил idempotency key-ээр давтах:** яг ижил хариу (`reason`-тай) буцна. Тест: Task 1.
5. **FOUND үед зөвхөн хоосон зайтай утга (`note: ' '`) илгээх:** API-ийн `min_length=1`-ийг давж domain-д хүрнэ; `None` биш тул татгалзана (422 `XYP_VERIFIED_FIELDS_LOCKED`). Тест: Task 3.

---

## Орчин

```bash
cd /home/user/PRsystem
service postgresql start
export PRSYSTEM_TEST_ADMIN_DSN=postgresql://postgres:postgres@127.0.0.1:5432/postgres
export PRSYSTEM_BROWSER_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
```

- PostgreSQL тест: `PYTHONPATH=src:tests .venv/bin/python -m unittest ...`
- Domain тест: `PYTHONPATH=src .venv/bin/python -m unittest ...`
- PostgreSQL сервис үе үе зогсдог. `Connection refused` гарвал `service postgresql start`.

---

### Task 1: Хариунд шалтгаан; ХУР холбогдоогүй хайлт хязгаарт тоологдохгүй

**Files:**
- Modify: `src/prsystem/xyp_lookups.py` (`view`, `limit`, `lookup`)
- Test: `tests/test_xyp_lookup.py`

**Interfaces:**
- Produces:
  - `XypLookups.view(conn, tenant, lookup) -> dict`: `lookup_id`, `status`, `expires_at`, `citizen?`. `reason` нь зөвхөн DB мөрөнд `reason` байгаа үед (UNAVAILABLE) нэмэгдэнэ.
  - Хязгаар нь `gateway` байгаа үед л шалгагдана. Тоололд `reason='NOT_CONFIGURED'` мөр орохгүй.

- [ ] **Step 1: Failing test бичих**

`tests/test_xyp_lookup.py`-д `test_unconfigured_production_adapter_reports_unavailable`-ийн өмнө нэмнэ:

```python
    def test_unconfigured_lookups_report_reason_and_skip_the_limit(self):
        with TestClient(create_app(self.app_dsn, self.settings, identity_vault=self.vault), client=(self.peer, 12345)) as client:
            def unconfigured(key):
                return client.post(f'/hotels/{self.tenant}/guest-identity/xyp-lookups', headers=self.headers(self.worker_token),
                                   json=dict(document_number='АБ90010211', consent=True, idempotency_key=key))
            first = self.assert_status(unconfigured('unconfigured-0'), 201)
            self.assertEqual((first['status'], first['reason']), ('UNAVAILABLE', 'NOT_CONFIGURED'))
            self.assertEqual(self.assert_status(unconfigured('unconfigured-0'), 201), first)
            for index in range(1, 25):
                self.assertEqual(self.assert_status(unconfigured(f'unconfigured-{index}'), 201)['reason'], 'NOT_CONFIGURED')
        self.assertNotIn('reason', self.assert_status(self.lookup(), 201))
        self.assertNotIn('reason', self.assert_status(self.lookup('АБ85020311', key='miss'), 201))
        down = self.assert_status(self.lookup(MockXypGateway.OUTAGE, key='down'), 201)
        self.assertEqual((down['status'], down['reason']), ('UNAVAILABLE', 'PROVIDER_ERROR'))
```

- [ ] **Step 2: Унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_xyp_lookup.XypLookupTests.test_unconfigured_lookups_report_reason_and_skip_the_limit 2>&1 | tail -4`
Expected: `KeyError: 'reason'` бүхий ERROR.

- [ ] **Step 3: Хэрэгжүүлэх**

`src/prsystem/xyp_lookups.py` дээр:

`view()`-ийн эхний хоёр мөрийг:
```python
        status, envelope, expires = conn.execute('SELECT status,envelope,expires_at FROM prsystem.xyp_lookup WHERE tenant_id=%s AND id=%s',
                                                 (tenant, lookup)).fetchone()
        result = dict(lookup_id=lookup, status=status, expires_at=expires.isoformat())
```
дараахаар солино:
```python
        status, reason, envelope, expires = conn.execute('SELECT status,reason,envelope,expires_at FROM prsystem.xyp_lookup WHERE tenant_id=%s AND id=%s',
                                                         (tenant, lookup)).fetchone()
        result = dict(lookup_id=lookup, status=status, expires_at=expires.isoformat())
        if reason is not None:  # UNAVAILABLE only (DB CHECK); a category, never registry data
            result['reason'] = reason
```

`limit()`-ийн query-г:
```python
        recent = conn.execute('SELECT count(*) FROM prsystem.xyp_lookup WHERE tenant_id=%s AND actor_id=%s AND created_at>clock_timestamp()-%s',
                              (tenant, actor, LOOKUP_WINDOW)).fetchone()[0]
```
дараахаар солино:
```python
        recent = conn.execute('''SELECT count(*) FROM prsystem.xyp_lookup WHERE tenant_id=%s AND actor_id=%s
            AND created_at>clock_timestamp()-%s AND reason IS DISTINCT FROM 'NOT_CONFIGURED' ''',
                              (tenant, actor, LOOKUP_WINDOW)).fetchone()[0]
```

`lookup()` доторх **хоёр** `self.limit(conn, tenant, actor)` мөрийг `if self.gateway is not None:`-ийн дотор оруулна:
```python
            if self.gateway is not None:  # NOT_CONFIGURED lookups never reach ХУР
                self.limit(conn, tenant, actor)
```
Хоёр дахь дээр одоогийн тайлбарыг хадгална:
```python
            if self.gateway is not None:  # again: concurrent requests all passed the first count
                self.limit(conn, tenant, actor)
```

- [ ] **Step 4: Давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_xyp_lookup 2>&1 | tail -3`
Expected: `OK` (16 тест).

- [ ] **Step 5: Commit**

```bash
git add src/prsystem/xyp_lookups.py tests/test_xyp_lookup.py
git commit -m "feat(xyp): return the UNAVAILABLE reason; unconfigured lookups skip the limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 2: 10 секундийн timeout ба адаптерын алдааны төрөл

**Files:**
- Modify: `src/prsystem/xyp_lookups.py` (imports, `ADAPTER_POOL`, `ask`, `lookup`)
- Test: `tests/test_xyp_lookup.py`

**Interfaces:**
- Consumes: `prsystem.xyp.TIMEOUT_SECONDS` (10).
- Produces:
  - `prsystem.xyp_lookups.TIMEOUT_SECONDS` (module global, тест patch хийнэ).
  - `prsystem.xyp_lookups.ADAPTER_POOL`.
  - `XypLookups.ask(number) -> (status, reason, citizen, error_type)`. Дөрөв дэх утга нь `None` эсвэл урьдчилан тооцоогүй exception-ийн төрлийн нэр.
  - `XYP_LOOKUP` event `details` = `{status, reason}` эсвэл `{status, reason, error}`.

- [ ] **Step 1: Failing test бичих**

`tests/test_xyp_lookup.py`-ийн import-уудыг:
```python
from threading import Barrier
from time import sleep
```
дараахаар солино:
```python
from threading import Barrier, Event
from time import sleep
from unittest.mock import patch
```

`test_unconfigured_production_adapter_reports_unavailable`-ийн өмнө нэмнэ:

```python
    def test_slow_adapter_times_out_and_its_late_answer_is_discarded(self):
        citizen, release = self.xyp.citizen, Event()
        def stuck(number):
            release.wait(5); return citizen(number)
        self.xyp.citizen = stuck
        with patch('prsystem.xyp_lookups.TIMEOUT_SECONDS', 0.2):
            result = self.assert_status(self.lookup(), 201)
        release.set()
        self.assertEqual((result['status'], result['reason'], 'citizen' in result), ('UNAVAILABLE', 'TIMEOUT', False))
        for _ in range(50):  # the abandoned adapter call finishes in the background
            if self.xyp.calls:
                break
            sleep(0.05)
        self.assertEqual(self.xyp.calls, 1)
        with psycopg.connect(self.owner_dsn) as conn:
            rows = conn.execute('SELECT status,reason,envelope FROM prsystem.xyp_lookup WHERE tenant_id=%s', (self.tenant,)).fetchall()
        self.assertEqual(rows, [('UNAVAILABLE', 'TIMEOUT', None)])

    def test_crashing_adapter_records_only_the_error_type(self):
        def crash(number):
            raise RuntimeError(f'register rejected {number}')
        self.xyp.citizen = crash
        self.assertEqual(self.assert_status(self.lookup(), 201)['reason'], 'PROVIDER_ERROR')
        with psycopg.connect(self.owner_dsn) as conn:
            details = conn.execute("SELECT details FROM prsystem.operational_event WHERE tenant_id=%s AND kind='XYP_LOOKUP'", (self.tenant,)).fetchone()[0]
        self.assertEqual(details, dict(status='UNAVAILABLE', reason='PROVIDER_ERROR', error='RuntimeError'))
        self.assertNotIn('АБ90010211', str(details))
```

- [ ] **Step 2: Унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_xyp_lookup.XypLookupTests.test_slow_adapter_times_out_and_its_late_answer_is_discarded tests.test_xyp_lookup.XypLookupTests.test_crashing_adapter_records_only_the_error_type 2>&1 | grep -E "^(ERROR|FAIL):|Error|Ran"`
Expected:
- эхний тест: `AttributeError: ... does not have the attribute 'TIMEOUT_SECONDS'` бүхий ERROR;
- хоёр дахь тест: `details`-д `error` байхгүй тул FAIL.

- [ ] **Step 3: Хэрэгжүүлэх**

`src/prsystem/xyp_lookups.py`-ийн import-уудыг:
```python
import secrets
from datetime import timedelta
```
дараахаар солино:
```python
import secrets
from concurrent.futures import ThreadPoolExecutor, TimeoutError as AdapterTimeout
from datetime import timedelta
```
ба
```python
from prsystem.xyp import XypNotFound, XypUnavailable, citizen_evidence
```
мөрийг:
```python
from prsystem.xyp import TIMEOUT_SECONDS, XypNotFound, XypUnavailable, citizen_evidence
```
болгоно. `LOOKUP_TTL = timedelta(minutes=15)` мөрийн дараа нэмнэ:
```python
# Bounded: a hanging adapter holds at most these threads; queued calls still time out.
ADAPTER_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix='xyp')
```

`ask()`-ийг бүхэлд нь солино:
```python
    def ask(self, number):
        """Return (status, reason, citizen, error_type); error_type names an unexpected adapter crash."""
        if self.gateway is None:
            return 'UNAVAILABLE', 'NOT_CONFIGURED', None, None
        call = ADAPTER_POOL.submit(self.gateway.citizen, number)
        try:
            return 'FOUND', None, citizen_evidence(number, call.result(timeout=TIMEOUT_SECONDS)), None
        except AdapterTimeout:
            call.cancel()  # still queued: never runs; already running: its answer is discarded
            return 'UNAVAILABLE', 'TIMEOUT', None, None
        except XypNotFound:
            return 'NOT_FOUND', None, None, None
        except XypUnavailable as exc:
            return 'UNAVAILABLE', exc.reason, None, None
        except Exception as exc:  # A crashing adapter must not block manual fallback.
            return 'UNAVAILABLE', 'PROVIDER_ERROR', None, type(exc).__name__  # the type only: messages may hold a РД
```

`lookup()` дотор:
```python
        status, reason, citizen = self.ask(number)  # never inside a database transaction
```
мөрийг:
```python
        status, reason, citizen, error = self.ask(number)  # never inside a database transaction
```
болгож,
```python
            self.event(conn, tenant, actor, 'XYP_LOOKUP', lookup, dict(status=status, reason=reason))
```
мөрийг:
```python
            self.event(conn, tenant, actor, 'XYP_LOOKUP', lookup, dict(status=status, reason=reason, **({'error': error} if error else {})))
```
болгоно.

- [ ] **Step 4: Давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_xyp_lookup 2>&1 | tail -3`
Expected: `OK` (18 тест).

- [ ] **Step 5: Commit**

```bash
git add src/prsystem/xyp_lookups.py tests/test_xyp_lookup.py
git commit -m "feat(xyp): bound adapter calls to 10 seconds and record crash types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 3: FOUND-д илүү талбар хориглох; `bind`-ийг `stays.py` руу; tenant тест

**Files:**
- Modify: `src/prsystem/xyp.py` (`bind`, `MANUAL_FIELDS`, илүү import-уудыг хасна)
- Modify: `src/prsystem/stays.py` (`_guest_identity`, шинэ `_xyp_identity`, imports)
- Test: `tests/test_xyp_lookup.py`, `tests/test_xyp_domain.py`

**Interfaces:**
- Consumes: `xyp_lookup` хүснэгт (079), `IdentityVault.open/fingerprint`, `validate_identity`.
- Produces:
  - `StayService._xyp_identity(conn, tenant, guest, on_date) -> (identity, exact, lookup_id)`. Буцаах утга нь хуучин `xyp.bind`-тэй ижил.
  - `prsystem.xyp`-д `bind`, `MANUAL_FIELDS`, `scope`, `validate_identity`, `identifier` байхгүй.

- [ ] **Step 1: Failing test бичих**

`tests/test_xyp_lookup.py`-д `test_xyp_birth_date_applies_the_adult_rule`-ийн өмнө нэмнэ:

```python
    def test_found_lookup_rejects_any_other_identity_field(self):
        self.ready()
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        for index, extra in enumerate((dict(note='VIP'), dict(issuing_country='US'), dict(note=' '))):
            response = self.checkin(guest=self.guest(lookup, **extra), idempotency_key=f'extra-{index}')
            self.assertEqual((response.status_code, response.json()['code']), (422, 'XYP_VERIFIED_FIELDS_LOCKED'), extra)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.stay WHERE tenant_id=%s', (self.tenant,)).fetchone()[0], 0)

    def test_lookup_from_another_hotel_is_not_found(self):
        self.ready()
        foreign = 'f' * 32
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('''INSERT INTO prsystem.xyp_lookup(tenant_id,id,actor_id,lookup_token,status,reason,envelope,consent_at,created_at,expires_at)
                VALUES(%s,%s,%s,'token','NOT_FOUND',NULL,NULL,now(),now(),now()+interval '15 minutes')''', (self.other, foreign, self.account))
        response = self.checkin(guest=self.guest(foreign, **self.MANUAL), idempotency_key='foreign')
        self.assertEqual((response.status_code, response.json()['code']), (404, 'XYP_LOOKUP_NOT_FOUND'))
```

`tests/test_xyp_domain.py`-ийн төгсгөлд нэмнэ:

```python
class PortModuleTests(unittest.TestCase):
    def test_port_module_holds_no_database_code(self):
        import prsystem.xyp as xyp
        for name in ('bind', 'MANUAL_FIELDS', 'scope', 'validate_identity', 'identifier'):
            self.assertFalse(hasattr(xyp, name), name)
```

- [ ] **Step 2: Унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_xyp_lookup.XypLookupTests.test_found_lookup_rejects_any_other_identity_field tests.test_xyp_lookup.XypLookupTests.test_lookup_from_another_hotel_is_not_found tests.test_xyp_domain.PortModuleTests 2>&1 | grep -E "^(ERROR|FAIL):|AssertionError|Ran|OK|FAILED"`
Expected:
- `test_found_lookup_rejects_any_other_identity_field`: FAIL (`(201, ...)` != `(422, 'XYP_VERIFIED_FIELDS_LOCKED')`).
- `test_port_module_holds_no_database_code`: FAIL (`bind`).
- `test_lookup_from_another_hotel_is_not_found`: **давна**. Энэ тест одоо байгаа зөв зан төлөвийг хамгаална (spec §6-ийн тестийн дутуу). Унавал tenant тусгаарлалт эвдэрсэн гэсэн үг.

- [ ] **Step 3: Хэрэгжүүлэх**

`src/prsystem/stays.py`-ийн import-уудыг:
```python
from prsystem.common import DomainError
from prsystem.guest_identity import validate_identity
```
дараахаар солино:
```python
from prsystem.booking_inventory import scope
from prsystem.common import DomainError, identifier
from prsystem.guest_identity import validate_identity
```

`_guest_identity`-г бүхэлд нь солино, шинэ `_xyp_identity`-г түүний дараа нэмнэ:
```python
    def _guest_identity(self, conn, tenant, guest, on_date):
        """RC-DEC-046: a Mongolian РД identity resolves through its server-held ХУР lookup."""
        if guest.get('identity_type') == 'MN_REG_NO':
            return self._xyp_identity(conn, tenant, guest, on_date)
        if guest.get('xyp_lookup_id') is not None:
            raise DomainError('INVALID_GUEST_IDENTITY')
        return (*validate_identity(guest, on_date), None)

    def _xyp_identity(self, conn, tenant, guest, on_date):
        """Resolve a Mongolian РД guest through its server-held, unused, unexpired ХУР lookup."""
        lookup = guest.get('xyp_lookup_id')
        if lookup is None:
            raise DomainError('XYP_LOOKUP_REQUIRED')
        identifier(lookup)
        scope(conn, tenant)
        row = conn.execute('''SELECT status,reason,lookup_token,envelope,stay_id,expires_at<=clock_timestamp()
            FROM prsystem.xyp_lookup WHERE tenant_id=%s AND id=%s FOR UPDATE''', (tenant, lookup)).fetchone()
        if not row:
            raise DomainError('XYP_LOOKUP_NOT_FOUND')
        status, reason, token, envelope, stay, expired = row
        if stay is not None:
            raise DomainError('XYP_LOOKUP_USED')
        if expired:
            raise DomainError('XYP_LOOKUP_EXPIRED')
        if status == 'FOUND':
            # Everything but the type and the lookup comes from ХУР; any other value is a browser edit.
            if any(value is not None for name, value in guest.items() if name not in ('identity_type', 'xyp_lookup_id')):
                raise DomainError('XYP_VERIFIED_FIELDS_LOCKED')
            citizen = self.vault.open(envelope, tenant, lookup, 'xyp-lookup')
            identity, exact = validate_identity(dict(citizen, identity_type='MN_REG_NO', nationality='MN'), on_date)
            identity['provenance'] = 'XYP_VERIFIED'
        else:
            identity, exact = validate_identity({k: v for k, v in guest.items() if k != 'xyp_lookup_id'}, on_date)
            if self.vault.fingerprint('guest-exact-identity', list(exact)) != token:
                raise DomainError('XYP_LOOKUP_MISMATCH')
            identity['xyp_fallback'] = dict(status=status, reason=reason)
        return identity, exact, lookup
```

`src/prsystem/xyp.py` дээр:
- `MANUAL_FIELDS = (...)` мөр болон `def bind(...)` функцийг бүхэлд нь (файлын төгсгөл хүртэл) устгана.
- Import-уудыг:
  ```python
  from prsystem.booking_inventory import scope
  from prsystem.common import DomainError, identifier
  from prsystem.guest_identity import calendar_date, registration_number, text, validate_identity
  ```
  дараахаар солино:
  ```python
  from prsystem.common import DomainError
  from prsystem.guest_identity import calendar_date, registration_number, text
  ```
- Module docstring-ийг:
  ```python
  """ХУР (XYP) citizen register port and evidence rules (RC-DEC-046).

  Pure domain: no database code. Only a server-held, encrypted lookup result can
  make an identity XYP_VERIFIED (bound in StayService._xyp_identity); the
  browser never asserts it.
  """
  ```
  болгоно.

- [ ] **Step 4: Давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_xyp_lookup tests.test_xyp_domain tests.test_walkin_stays tests.test_booking_holds 2>&1 | tail -3`
Expected: `OK`.

Run (psycopg-гүй domain job-ийг загварчилна):
```bash
cat > /tmp/nopsy.py <<'EOF'
import sys, unittest
class Block:
    def find_spec(self, name, path=None, target=None):
        if name == 'psycopg' or name.startswith(('psycopg.', 'psycopg_')):
            raise ImportError('blocked ' + name)
sys.meta_path.insert(0, Block())
result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromName('test_xyp_domain'))
sys.exit(not result.wasSuccessful())
EOF
env -u PRSYSTEM_TEST_ADMIN_DSN PYTHONPATH=src:tests .venv/bin/python /tmp/nopsy.py 2>&1 | tail -2
```
Expected: `OK` (7 тест).

- [ ] **Step 5: Commit**

```bash
git add src/prsystem/xyp.py src/prsystem/stays.py tests/test_xyp_lookup.py tests/test_xyp_domain.py
git commit -m "refactor(xyp): bind lookups in StayService; FOUND rejects every other field

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 4: Reception UI: шалтгаан бүрийн мессеж, NOT_CONFIGURED, дахин татах

**Files:**
- Modify: `src/prsystem/static/reception.js` (`errors.XYP_LOOKUP_USED`, `form()` catch, `xypLookup`/`xypResult` блок, `guestForm`)
- Create: `tests/browser/reception-xyp.cjs`
- Modify: `.github/workflows/domain-tests.yml` (шинэ suite-ийн алхам, validate жагсаалт)

**Interfaces:**
- Consumes: Task 1-ийн хайлтын хариу `{lookup_id, status, expires_at, citizen?, reason?}`. Check-in алдаа `{code:'XYP_LOOKUP_EXPIRED'|'XYP_LOOKUP_USED'}` (409).
- Produces:
  - `form(parent,title,fields,submit,action,opts)` нь `opts.failure(error,form,status)`-ийг алдааны мессеж тавьсны дараа дуудна.
  - `guestForm(start,booking,room,type,lookup,xyp={})`: `xyp.notice` нь "ХУР-аар баталгаажсан" мөр, `xyp.restart(result)` нь FOUND биш дахин татсан хариугаар урсгалыг шинээр эхлүүлнэ.

- [ ] **Step 1: Failing browser suite бичих**

`tests/browser/reception-xyp.cjs` үүсгэнэ:

```js
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
// RC-DEC-046 follow-ups: every ХУР lookup outcome, the manual fallback payload and re-pulling an expired lookup.
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`;
  const requests=[],problems=[];let lookups=0,reject=null;page.on('pageerror',e=>problems.push(e.message));
  const room={room_id:'room-1',number:'101',floor:'1',category_id:'category-1',category_name:'Стандарт',status:'ACTIVE',cleaning_state:'CLEAN',revision:1,minibar_mode:'OFF',tariffs:{}};
  const overview=()=>({account_id:'worker',roles:['RECEPTION'],package_mnt:30000,mode:'MOCK_CASH_LEDGER',limit:50,staff:[{account_id:'worker',email:'worker@example.com',roles:['RECEPTION']}],drawers:[{drawer_id:'drawer-1',name:'Үндсэн касс',unused:false}],shifts:[{shift_id:'shift-1',owner_id:'worker',drawer_id:'drawer-1',state:'OPEN',opened_at:'2026-09-07T00:00:00Z',review_state:'NOT_SUBMITTED'}],funding:[],custodies:[],qrs:[],inspections:[],cleaning:[]});
  // Outcome by РД; any other number is FOUND. ЕЕ… imitates an older server that sends no reason.
  const outcomes={'АБ85020311':{status:'NOT_FOUND'},'ББ90010211':{status:'UNAVAILABLE',reason:'NOT_CONFIGURED'},'ВВ90010211':{status:'UNAVAILABLE',reason:'TIMEOUT'},'ГГ90010211':{status:'UNAVAILABLE',reason:'PROVIDER_ERROR'},'ДД90010211':{status:'UNAVAILABLE',reason:'INVALID_EVIDENCE'},'ЕЕ90010211':{status:'UNAVAILABLE'}};
  await page.route('**/auth/**',async route=>{const url=new URL(route.request().url());await route.fulfill({json:url.pathname==='/auth/login'?{access_token:'test-session'}:url.pathname==='/auth/me'?{roles:['RECEPTION']}:{}});});
  await page.route('**/hotels/**',async route=>{
   const url=new URL(route.request().url()),tail=url.pathname.replace('/hotels/test-hotel/',''),body=route.request().postDataJSON();requests.push({tail,body,method:route.request().method()});
   let data={};
   if(tail==='operations')data=overview();
   else if(tail==='rooms')data=[room];else if(tail==='room-categories')data=[{category_id:'category-1',name:'Стандарт',status:'ACTIVE',revision:1}];
   else if(['stays/active','bookings','handovers','cleaning/checkouts'].includes(tail))data=[];
   else if(tail==='guest-identity/xyp-lookups'){assert.equal(body.consent,true);lookups+=1;data={lookup_id:`lookup-${lookups}`,expires_at:'2026-09-07T01:15:00Z',...(outcomes[body.document_number]||{status:'FOUND',citizen:{family_name:'Бат',given_name:'Болд',date_of_birth:'1990-01-02',nationality:'MN'}})};}
   else if(tail==='stays/check-in'){if(reject){const code=reject;reject=null;await route.fulfill({status:409,json:{code}});return;}data={stay_id:'stay-1',room_id:'room-1',guest_access_code:'123456'};}
   await route.fulfill({json:data});
  });
  const open=async()=>{await page.goto(origin+'/reception');await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('worker@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false');
   await page.getByRole('button',{name:'Шууд ирсэн зочин бүртгэх',exact:true}).click();await page.getByRole('button',{name:'Зочны мэдээлэл оруулах',exact:true}).click();};
  const consent=()=>page.getByLabel('Зочин ХУР-аас мэдээлэл авахыг зөвшөөрсөн',{exact:false});
  const pull=async number=>{await page.getByLabel('Регистрийн дугаар',{exact:true}).fill(number);await consent().check();await page.getByRole('button',{name:'ХУР-аас татах',exact:true}).click();};
  const focused=()=>page.evaluate(()=>document.activeElement.textContent);
  const count=name=>page.getByRole('button',{name,exact:true}).count();
  const deposit=async()=>{await page.getByLabel('Бэлнээр авсан барьцаа (₮)',{exact:false}).fill('60000');await page.getByLabel('Бэлэн барьцааг биечлэн авсан',{exact:false}).check();};
  const submit=()=>page.getByRole('button',{name:'Зочны бүртгэл баталгаажуулах',exact:true}).click();
  const checkins=()=>requests.filter(r=>r.tail==='stays/check-in');
  const verified='ХУР-аар баталгаажсан: Бат Болд · 1990-01-02 · MN';

  // Spec §5.1: one message per outcome; retry only where asking again can help.
  await open();
  for(const [number,message,retry] of [['АБ85020311','ХУР-д энэ РД-ээр мэдээлэл олдсонгүй.',0],['ВВ90010211','ХУР хугацаандаа хариулсангүй.',1],['ГГ90010211','ХУР-тай холбогдож чадсангүй.',1],['ДД90010211','ХУР-ын мэдээлэл РД-тэй таарахгүй байна.',0],['ЕЕ90010211','ХУР-тай холбогдож чадсангүй.',1]]){
   await pull(number);await page.getByText(message,{exact:true}).waitFor();
   assert.equal(await focused(),message,number);assert.equal(await count('Дахин оролдох'),retry,number);assert.equal(await count('Гараар бүртгэх'),1,number);
   await page.getByRole('button',{name:'Өөр РД оруулах',exact:true}).click();await page.getByLabel('Регистрийн дугаар',{exact:true}).waitFor();
  }

  // NOT_CONFIGURED opens the manual form at once; the manual payload carries the failed lookup and its РД.
  await pull('ББ90010211');await page.getByText('ХУР холбогдоогүй байна. Гараар бүртгэнэ үү.',{exact:true}).waitFor();await page.getByLabel('Овог',{exact:true}).waitFor();
  assert.equal(await focused(),'Шууд ирсэн зочин бүртгэх');assert.equal(await count('Дахин оролдох'),0);assert.equal(await count('Гараар бүртгэх'),0);
  await page.getByLabel('Овог',{exact:true}).fill('Бат');await page.getByLabel('Нэр',{exact:true}).fill('Болд');await page.getByLabel('Төрсөн огноо',{exact:true}).fill('1990-01-02');await deposit();
  await submit();await page.getByRole('button',{name:'Байрлалтыг нээх',exact:true}).waitFor();
  assert.deepEqual(checkins().at(-1).body.guest,{identity_type:'MN_REG_NO',xyp_lookup_id:`lookup-${lookups}`,document_number:'ББ90010211',family_name:'Бат',given_name:'Болд',date_of_birth:'1990-01-02',nationality:'MN'});

  // Spec §5.2: an expired FOUND lookup is pulled again without losing what Reception typed.
  await open();await pull('АБ90010211');await page.getByText(verified,{exact:true}).waitFor();const first=`lookup-${lookups}`;await deposit();
  reject='XYP_LOOKUP_EXPIRED';await submit();await page.getByText('ХУР-ын хайлтын хугацаа дууссан. Дахин татна уу.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'ХУР-аас дахин татах',exact:true}).click();
  assert.equal(await count('ХУР-аас дахин татах'),0);assert.equal(await page.getByRole('heading',{name:'ХУР-аас дахин татах',exact:true}).count(),1);
  assert.equal(await page.getByLabel('Регистрийн дугаар',{exact:true}).inputValue(),'АБ90010211');assert.equal(await consent().isChecked(),false);
  await consent().check();await page.getByRole('button',{name:'ХУР-аас татах',exact:true}).click();await page.getByLabel('Регистрийн дугаар',{exact:true}).waitFor({state:'detached'});
  assert.equal(await focused(),verified);assert.equal(await page.getByLabel('Бэлнээр авсан барьцаа (₮)',{exact:false}).inputValue(),'60000');
  await submit();await page.getByRole('button',{name:'Байрлалтыг нээх',exact:true}).waitFor();
  assert.equal(checkins().at(-2).body.guest.xyp_lookup_id,first);assert.notEqual(first,`lookup-${lookups}`);
  assert.deepEqual(checkins().at(-1).body.guest,{identity_type:'MN_REG_NO',xyp_lookup_id:`lookup-${lookups}`});assert.equal(checkins().at(-1).body.deposit.amount_mnt,60000);

  // Re-pull that is not FOUND closes the stale form and continues with the normal outcome.
  await open();await pull('АБ90010211');await page.getByText(verified,{exact:true}).waitFor();await deposit();
  reject='XYP_LOOKUP_EXPIRED';await submit();await page.getByRole('button',{name:'ХУР-аас дахин татах',exact:true}).click();
  await page.getByLabel('Регистрийн дугаар',{exact:true}).fill('ГГ90010211');await consent().check();await page.getByRole('button',{name:'ХУР-аас татах',exact:true}).click();
  await page.getByText('ХУР-тай холбогдож чадсангүй.',{exact:true}).waitFor();assert.equal(await focused(),'ХУР-тай холбогдож чадсангүй.');
  assert.equal(await page.getByLabel('Бэлнээр авсан барьцаа (₮)',{exact:false}).count(),0);assert.equal(await count('Дахин оролдох'),1);

  // USED: the lookup already produced a stay; never offer a re-pull that could register the guest twice.
  await open();await pull('АБ90010211');await page.getByText(verified,{exact:true}).waitFor();await deposit();
  reject='XYP_LOOKUP_USED';await submit();await page.getByText('Энэ хайлтаар аль хэдийн бүртгэсэн. Идэвхтэй байрлалтуудаа шалгана уу.',{exact:true}).waitFor();
  assert.equal(await count('ХУР-аас дахин татах'),0);

  fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/reception-xyp-requests.json',JSON.stringify(requests));
  assert.deepEqual(problems,[]);assert.equal(await page.locator('form:not([novalidate])').count(),0);
  console.log('Reception ХУР checks passed: outcome messages, focus, manual fallback payload, expired re-pull and USED guard.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
```

- [ ] **Step 2: Унаж байгааг шалгах**

Run: `node tests/browser/reception-xyp.cjs 2>&1 | grep -E "AssertionError|Error|passed" | head -3`
Expected: `TimeoutError`. Хуучин код `ВВ90010211`-д `ХУР-тай холбогдож чадсангүй.` гэж харуулдаг тул `ХУР хугацаандаа хариулсангүй.` текстийг хүлээх `waitFor` 30 секундэд timeout болно.

- [ ] **Step 3: Хэрэгжүүлэх**

`src/prsystem/static/reception.js` дээр:

**3a.** `errors` map-д:
```js
XYP_LOOKUP_USED:'Энэ хайлтаар аль хэдийн бүртгэсэн. Дахин татна уу.'
```
хэсгийг:
```js
XYP_LOOKUP_USED:'Энэ хайлтаар аль хэдийн бүртгэсэн. Идэвхтэй байрлалтуудаа шалгана уу.'
```
болгоно.

**3b.** `form()`-ийн catch хэсэгт:
```js
}catch(e){if(f.isConnected){status.textContent=e.message;status.className='result error';}}
```
хэсгийг:
```js
}catch(e){if(f.isConnected){status.textContent=e.message;status.className='result error';opts.failure?.(e,f,status);}}
```
болгоно.

**3c.** `  function xypLookup(`-оос `  function guestForm(`-ын өмнөх мөр хүртэлх блокийг (`xypLookup` ба `xypResult`) дараахаар бүхэлд нь солино:
```js
  const xypReasons={NOT_CONFIGURED:'ХУР холбогдоогүй байна. Гараар бүртгэнэ үү.',TIMEOUT:'ХУР хугацаандаа хариулсангүй.',PROVIDER_ERROR:'ХУР-тай холбогдож чадсангүй.',INVALID_EVIDENCE:'ХУР-ын мэдээлэл РД-тэй таарахгүй байна.'};
  function verified(c){return `ХУР-аар баталгаажсан: ${c.family_name} ${c.given_name} · ${c.date_of_birth} · MN`;}
  function xypForm(parent,title,value,done){
    return form(parent,title,[field('document_number','Регистрийн дугаар','text',{value}),field('consent','Зочин ХУР-аас мэдээлэл авахыг зөвшөөрсөн','checkbox')],'ХУР-аас татах',
      async v=>({...await api(path('guest-identity/xyp-lookups'),{document_number:v.document_number,consent:v.consent===true,idempotency_key:v.idempotency_key}),document_number:v.document_number}),
      {focus:true,success:async(result,f)=>{f.remove();done(result);}});
  }
  function xypLookup(start,booking,room,value=''){xypForm(start,'ХУР-аас зочны мэдээлэл татах',value,result=>xypResult(start,booking,room,result));}
  function xypResult(start,booking,room,result){
    const box=node('div');start.append(box);const again=value=>guard(()=>{box.remove();xypLookup(start,booking,room,value);});
    if(result.status==='FOUND'){const notice=node('p',verified(result.citizen),'notice');notice.tabIndex=-1;box.append(notice);actions(box).append(btn('Өөр РД оруулах',()=>again('')));
      guestForm(box,booking,room,'MN_REG_NO',result,{notice,restart:next=>{box.remove();xypResult(start,booking,room,next);}});return;}
    const reason=result.status==='NOT_FOUND'?null:xypReasons[result.reason]?result.reason:'PROVIDER_ERROR';  // an older server sends no reason
    const notice=node('p',reason?xypReasons[reason]:'ХУР-д энэ РД-ээр мэдээлэл олдсонгүй.','notice');notice.tabIndex=-1;box.append(notice);
    const a=actions(box);if(reason==='TIMEOUT'||reason==='PROVIDER_ERROR')a.append(btn('Дахин оролдох',()=>again(result.document_number)));
    if(reason==='NOT_CONFIGURED'){a.append(btn('Өөр РД оруулах',()=>again('')));guestForm(box,booking,room,'MN_REG_NO',result);return;}  // the form takes focus
    const manual=btn('Гараар бүртгэх',()=>{manual.remove();guestForm(box,booking,room,'MN_REG_NO',result);});a.append(manual,btn('Өөр РД оруулах',()=>again('')));
    notice.focus();  // the lookup form and its focused button are gone
  }
```

**3d.** `guestForm` дотор гурван өөрчлөлт хийнэ:

- Эхний мөрүүдийг:
  ```js
    function guestForm(start,booking,room,type,lookup){
      const found=lookup?.status==='FOUND',
  ```
  дараахаар солино:
  ```js
    function guestForm(start,booking,room,type,lookup,xyp={}){
      let current=lookup;const found=lookup?.status==='FOUND',
  ```
- Action доторх:
  ```js
  const guest={identity_type:type};if(lookup){guest.xyp_lookup_id=lookup.lookup_id;if(!found)guest.document_number=lookup.document_number;}
  ```
  хэсгийг:
  ```js
  const guest={identity_type:type};if(current){guest.xyp_lookup_id=current.lookup_id;if(!found)guest.document_number=current.document_number;}
  ```
  болгоно.
- `guestForm`-ын төгсгөлийн options-ийг:
  ```js
      },{focus:true,success:async(result,f,status)=>{showResult(status,result);f.querySelector('button[type=submit]').hidden=true;await reloadOverview();status.append(btn('Байрлалтыг нээх',()=>openStay({stay_id:result.stay_id,room_id:result.room_id},start)));}});
    }
  ```
  дараахаар солино:
  ```js
      },{focus:true,success:async(result,f,status)=>{showResult(status,result);f.querySelector('button[type=submit]').hidden=true;await reloadOverview();status.append(btn('Байрлалтыг нээх',()=>openStay({stay_id:result.stay_id,room_id:result.room_id},start)));},
        // Spec §5.2: only an expired lookup is pulled again; USED means a stay already exists.
        failure:(e,f,status)=>{if(found&&e.code==='XYP_LOOKUP_EXPIRED')status.append(btn('ХУР-аас дахин татах',()=>repull(f,status)));}});
      function repull(f,status){status.replaceChildren();const holder=node('div');f.before(holder);
        // An EXPIRED answer committed nothing, so the form may keep its idempotency key with the new lookup.
        xypForm(holder,'ХУР-аас дахин татах',current.document_number,next=>{holder.remove();
          if(next.status!=='FOUND'){dirtyForms.delete(f);dirty=hasDirtyForms();xyp.restart(next);return;}
          current=next;xyp.notice.textContent=verified(next.citizen);xyp.notice.focus();});}
    }
  ```

**3e.** `.github/workflows/domain-tests.yml`:
- Дараах хоёр мөрийн:
  ```yaml
        - name: Verify Reception operations
          run: node tests/browser/reception.cjs
  ```
  дараа нэмнэ:
  ```yaml
        - name: Verify Reception ХУР lookup outcomes
          run: node tests/browser/reception-xyp.cjs
  ```
- `PYTHONPATH=src python tests/browser/validate_requests.py artifacts/reception-requests.json` мөрийн дараа нэмнэ:
  ```yaml
            PYTHONPATH=src python tests/browser/validate_requests.py artifacts/reception-xyp-requests.json
  ```

- [ ] **Step 4: Давж байгааг шалгах**

Run:
```bash
node tests/browser/reception-xyp.cjs 2>&1 | tail -1
node tests/browser/reception.cjs 2>&1 | tail -1
node tests/browser/ui-quality.cjs 2>&1 | tail -1
PYTHONPATH=src .venv/bin/python tests/browser/validate_requests.py artifacts/reception-xyp-requests.json && echo valid
```
Expected:
- `Reception ХУР checks passed: …`
- `Reception browser checks passed: …`
- ui-quality-ийн `passed` мөр
- `valid`

- [ ] **Step 5: Commit**

```bash
git add src/prsystem/static/reception.js tests/browser/reception-xyp.cjs .github/workflows/domain-tests.yml
git commit -m "feat(reception): ХУР outcome messages, direct manual entry and expired re-pull

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 5: Баримт

**Files:**
- Modify: `docs/39-walkin-check-in.md`, `docs/superpowers/specs/2026-09-28-xyp-identity-autofill-design.md`, `docs/02-reception-system-scope.md`, `docs/00-mvp-open-decisions.md`, `docs/requirements-status.md`, `docs/requirements-roadmap.md`

**Interfaces:** Кодын өөрчлөлтгүй.

- [ ] **Step 1: Засварыг хэрэгжүүлэх**

```bash
.venv/bin/python - <<'EOF'
import re
def rep(path, old, new):
    s = open(path, encoding='utf-8').read(); assert s.count(old) == 1, (path, old[:60], s.count(old))
    open(path, 'w', encoding='utf-8').write(s.replace(old, new))

rep('docs/39-walkin-check-in.md', 'nationality and server-owned `MANUAL` provenance.',
    'nationality and server-owned provenance: `XYP_VERIFIED` only from a server-held ХУР lookup, otherwise `MANUAL` (RC-DEC-046).')
rep('docs/39-walkin-check-in.md', 'GRANT UPDATE (state) ON prsystem.reception_shift TO app_role;\n',
    'GRANT UPDATE (state) ON prsystem.reception_shift TO app_role;\n'
    '-- RC-DEC-046 ХУР lookup (migration 079):\n'
    'GRANT SELECT, INSERT ON prsystem.xyp_lookup TO app_role;\n'
    'GRANT UPDATE (stay_id) ON prsystem.xyp_lookup TO app_role;\n')

spec = 'docs/superpowers/specs/2026-09-28-xyp-identity-autofill-design.md'
s = open(spec, encoding='utf-8').read()
start = s.index('```sql\n', s.index('## 5. Өгөгдөл'))
end = s.index('```\n', start + 7)
migration = open('src/prsystem/postgres/migrations/079_xyp_lookup.sql', encoding='utf-8').read()
open(spec, 'w', encoding='utf-8').write(s[:start] + '```sql\n' + migration + s[end:])

rep('docs/02-reception-system-scope.md', 'Бодит ХУР адаптер EXT-01-ийн дараа; одоо development/test mock.',
    'Хайлтын хариу UNAVAILABLE шалтгааныг (NOT_CONFIGURED/TIMEOUT/PROVIDER_ERROR/INVALID_EVIDENCE) харуулна; ХУР холбогдоогүй үед маягт шууд нээгдэж, тэр хайлт хязгаарт тоологдохгүй. Адаптерын хариуг 10 секундээр хязгаарлана. Бодит ХУР адаптер EXT-01-ийн дараа; одоо development/test mock.')
rep('docs/00-mvp-open-decisions.md', 'outage ба manual fallback-ийн албан нөхцөл |',
    'outage ба manual fallback-ийн албан нөхцөл. Адаптер 10 сек-д хариулах эсвэл TIMEOUT; ХУР дуудахаас өмнө ажилтны хязгаарын slot захиалах (одоо зэрэг хүсэлтэд ХУР илүү дуудагдаж болно, RC-DEC-046) |')
print('ok')
EOF
```

- [ ] **Step 2: REQ-02-07.07-г "хэрэгжсэн" болгох**

RC-DEC-007 (`docs/02:394–398`): "ХУР ажиллахгүй эсвэл мэдээлэл олдохгүй үед Reception овог, нэр, РД-г гараар бүртгэнэ. Систем баталгаажуулалтын эх үүсвэрийг ялгаж хадгална."

Одоо бүрэн хэрэгжсэн:
- гар бүртгэл зөвхөн амжилтгүй хайлтын дараа, тухайн РД-ээр;
- эх үүсвэр нь `MANUAL`/`XYP_VERIFIED` provenance ба `xyp_fallback` шалтгаан;
- тестүүд байгаа.

REQ-02-03.01 нь Police болон бусад хэсгийн улмаас "дутуу" хэвээр үлдэнэ. Зөвхөн ХУР-ын тэмдэглэлийг шинэчилнэ.

```bash
.venv/bin/python - <<'EOF'
def rep(path, old, new):
    s = open(path, encoding='utf-8').read(); assert s.count(old) == 1, (path, old[:60], s.count(old))
    open(path, 'w', encoding='utf-8').write(s.replace(old, new))
p = 'docs/requirements-status.md'
rep(p, "| `guest_identity.py:validate_identity`, `postgres/migrations/018_walkin_stays.sql` | `test_stay_policy.py::GuestIdentityPolicyTests.test_registration_normalizes_and_never_asserts_xyp`, `test_walkin_stays.py::WalkInStayTests.test_server_rejects_client_authority_and_identifier_provenance` (ok 2) | **дутуу** | хэсэгчлэн; Гараар бүртгэх нь цорын ганц зам; ХУР/XYP холболт ба mock байхгүй. provenance баганад зөвхөн MANUAL зөвшөөрөгдөнө (CHE… |",
       "| `stays.py:StayService._xyp_identity`, `xyp_lookups.py:XypLookups.lookup` +2 | `test_xyp_lookup.py::XypLookupTests.test_manual_entry_only_for_the_failed_normalized_rd`, `test_xyp_lookup.py::XypLookupTests.test_unavailable_lookup_allows_manual_entry_with_reason`, `test_xyp_lookup.py::XypLookupTests.test_found_lookup_checks_in_as_xyp_verified_and_locks_fields` +2 (ok 5) | **хэрэгжсэн** | RC-DEC-046: гар бүртгэл зөвхөн NOT_FOUND/UNAVAILABLE хайлтын дараа тухайн РД-ээр; provenance `MANUAL`/`XYP_VERIFIED`, `xyp_fallback` шалтгаан хадгална. Бодит ХУР адаптер EXT-01 (mock адаптертай). |")
rep(p, "Өмнөх олдвор: хэсэгчлэн; ХУР/XYP холболт ба mock огт байхгүй: provenance зөвхөн MANUAL (DB CHECK), XYP_VERIFIED/автоматаар бөглөх үгүй. Police… |",
       "ХУР lookup (RC-DEC-046) mock адаптертай хэрэгжсэн, бодит адаптер EXT-01. Өмнөх олдвор: хэсэгчлэн; Police… |")
rep(p, "| Reception (02, 03, 05, 06) | 61 | 77 | 1 | 15 | 11 | 165 | 40% |", "| Reception (02, 03, 05, 06) | 62 | 76 | 1 | 15 | 11 | 165 | 40% |")
rep(p, "| **Нийт** | **307** | **292** | **117** | **63** | **54** | **833** | **39%** |", "| **Нийт** | **308** | **291** | **117** | **63** | **54** | **833** | **40%** |")
rep(p, "| [02](#02-reception-system-scope) | 29 | 24 | 1 | 9 | 4 | 67 |", "| [02](#02-reception-system-scope) | 30 | 23 | 1 | 9 | 4 | 67 |")
rep(p, "| **Нийт** | **307** | **292** | **117** | **63** | **54** | **833** |", "| **Нийт** | **308** | **291** | **117** | **63** | **54** | **833** |")
rep('docs/requirements-roadmap.md', "| хэрэгжсэн | 307 |\n| дутуу | 292 |", "| хэрэгжсэн | 308 |\n| дутуу | 291 |")
print('ok')
EOF
```

Хувь:
- Reception: 62/154 = 40.3% → 40%.
- Нийт: 308/779 = 39.54% → 40%.

- [ ] **Step 3: Шалгах**

Run: `git diff --stat && grep -c "xyp_lookup_one_stay" docs/superpowers/specs/2026-09-28-xyp-identity-autofill-design.md`
Expected: 6 баримтын файл өөрчлөгдсөн; `1`.

- [ ] **Step 4: Commit**

```bash
git add docs/39-walkin-check-in.md docs/superpowers/specs/2026-09-28-xyp-identity-autofill-design.md docs/02-reception-system-scope.md docs/00-mvp-open-decisions.md docs/requirements-status.md docs/requirements-roadmap.md
git commit -m "docs: ХУР follow-ups in RC-DEC-046, EXT-01, docs/39 grants and status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 6: Бүрэн шалгалт ба push

- [ ] **Step 1: Domain-only**

Run: `env -u PRSYSTEM_TEST_ADMIN_DSN PYTHONPATH=src .venv/bin/python -m unittest discover -s tests 2>&1 | tail -1`
Expected: `OK (skipped=…)`.

- [ ] **Step 2: PostgreSQL 4 shard**

```bash
mkdir -p artifacts
for i in 0 1 2 3; do .venv/bin/python -m scripts.run_postgres_shard --index $i --count 4 > artifacts/xypf-shard-$i.log 2>&1 & done; wait
for i in 0 1 2 3; do grep -hE '^Discovered|^Ran |^OK|^FAILED' artifacts/xypf-shard-$i.log; done; grep -hE '\.\.\. (FAIL|ERROR|skipped)' artifacts/xypf-shard-*.log
```
Expected:
- `Discovered 976 tests`: 970 + Task 1 (1) + Task 2 (2) + Task 3 (3).
- Shard бүр `OK`.
- Сүүлийн grep юу ч хэвлэхгүй.

- [ ] **Step 3: 26 browser suite, payload шалгалт, design** (shard-ууд дууссаны дараа)

```bash
for s in staff restaurant reception reception-xyp booking minibar minibar-templates operation subscription-contact minibar-partial minibar-reconciliation minibar-archive minibar-rollout minibar-batches minibar-guest minibar-refill minibar-next-stay minibar-exception minibar-lifecycle minibar-adjustments minibar-paid-corrections minibar-variance minibar-shortages minibar-billing daily-workflows ui-quality; do node tests/browser/$s.cjs > artifacts/browser-$s.log 2>&1 || echo "FAILED $s"; done
for f in artifacts/*-requests.json; do PYTHONPATH=src .venv/bin/python tests/browser/validate_requests.py $f >/dev/null || echo "INVALID $f"; done
.venv/bin/python scripts/export_ui_tokens.py --check; echo "tokens $?"; npx --yes -p @google/design.md designmd lint DESIGN.md 2>&1 | grep '"errors"'
```
Expected: `FAILED`/`INVALID` мөр байхгүй; `tokens 0`; `"errors": 0`.

- [ ] **Step 4: Push**

```bash
git push -u origin final
```
Expected: push амжилттай. Network алдаа гарвал 2/4/8/16 секундийн зайтай 4 хүртэл удаа дахин оролдоно.
