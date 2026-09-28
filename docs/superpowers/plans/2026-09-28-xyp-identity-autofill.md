# ХУР-аас үндсэн зочны мэдээлэл автоматаар бөглөх — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Монгол РД-тэй үндсэн зочны овог, нэр, төрсөн огноог ХУР-аас (одоогоор mock) татаж, check-in-д `XYP_VERIFIED` болгон холбоно. Гараар бүртгэхийг зөвхөн тухайн РД-ийн бүтэлгүй хайлтын дараа зөвшөөрнө.

**Architecture:**
- **Цэвэр domain** (`xyp.py`): port, хариуны шалгалт, check-in-д холбох `bind()`. psycopg импортлохгүй.
- **DB-тэй service** (`xyp_lookups.py`): `StayService`-ийн удамшил. ХУР-ыг транзакцаас гадна дуудаж, шифрлэсэн үр дүнг `xyp_lookup` хүснэгтэд хадгална.
- **Check-in:** хайлтын дугаараар нэг удаа холбоно.
- **Mock адаптер:** `mock_providers.py` дотор. Бодит адаптер EXT-01-ийн дараа нэмэгдэнэ.

**Tech Stack:** Python 3.12, FastAPI/pydantic (strict), psycopg 3, PostgreSQL 16/17 (FORCE RLS), `unittest`, Playwright 1.62.1, vanilla JS (`reception.js`).

**Spec:** `docs/superpowers/specs/2026-09-28-xyp-identity-autofill-design.md`.

## Global Constraints

- **Branch:** зөвхөн `final`. Push: `git push -u origin final`.
- **Python:** `>=3.12`. Шинэ dependency нэмэхгүй.
- **CI-ийн domain job** (`python -m unittest discover -s tests`, `PYTHONPATH=src`) psycopg/fastapi-гүй ажилладаг:
  - `xyp.py`, `guest_identity.py`, `mock_providers.py` psycopg импортлохгүй.
  - PostgreSQL тестүүд `ADMIN_DSN`-ээр skip хийнэ.
- **Migration:** хуучин migration засахгүй. Шинэ нь `079_xyp_lookup.sql`.
- **Хязгаар:** 20 хайлт / 10 минут / ажилтан. Хайлтын дугаар 15 минут хүчинтэй, нэг удаа ашиглагдана.
- **Зөвшөөрөл:** Reception тэмдэглэнэ. `consent` нь JSON `true` байх ёстой.
- **Нууцлал:** РД, нэр, төрсөн огноо log, audit, event болон `staff_command_receipt`-д ил орохгүй. ХУР-ын үр дүн зөвхөн `vault.seal(..., 'xyp-lookup')`-оор хадгалагдана.
- **ХУР-ын эрх:** check-in-тэй ижил, `ShiftService._reception(..., action=Action.CHECK_IN)`. Хайлтад ээлж шаардахгүй.
- **Production:** `xyp_gateway=None` → хайлт бүр `UNAVAILABLE`/`NOT_CONFIGURED`.
- **Commit message-ийн төгсгөлд:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd
  ```

## Spec-ийг нарийвчилсан 2 шийдвэр (Task 5-д spec-д тусгана)

1. **Receipt:** шинэ `xyp_lookup_receipt` хүснэгтийн оронд одоогийн `staff_command_receipt`-ийг (`_receipt`/`_save_receipt`) ашиглана.
   - Receipt-д зөвхөн `{lookup_id}` хадгална. Replay үед иргэний мэдээллийг `xyp_lookup`-ийн шифрлэсэн envelope-оос сэргээнэ.
   - Ингэснээр receipt-д хувийн мэдээлэл ил орохгүй, шинэ хүснэгт шаардлагагүй.
2. **Тестийн туслах функц:** `WalkInCase` тестийн app-д ХУР адаптер байхгүй тул `checkin` helper-ийн хайлт `UNAVAILABLE` буцаана. Иймд helper гараар бүртгэх замаар одоогийн нэрсээр үргэлжилнэ.
   - Олдсон (`FOUND`) замыг `tests/test_xyp_lookup.py` mock адаптераар шалгана.
   - Spec §7-ийн "seed-д АБ90010211" гэсэн хэсгийг үүгээр солино.

## Review Focus

1. **Амжилттай check-in-ийг ижил idempotency key-ээр дахин илгээх:** эхний хариугаа (201) буцаах ёстой, `XYP_LOOKUP_USED` биш. Тест: Task 3.
2. **Нэг хайлтын дугаараар зэрэг 2 check-in** (хоёр tab, өөр өрөө): яг нэг нь амжилттай, нөгөө нь 409 `XYP_LOOKUP_USED`. Тест: Task 3.
3. **Жижиг үсэг эсвэл хоосон зайтай РД** (`аб85020311 `)-ээр хайгаад том үсгээр гараар бүртгэх: fingerprint таарах ёстой (`XYP_LOOKUP_MISMATCH` биш). Тест: Task 3.
4. **Бүтэлгүй check-in** (жишээ нь өрөө бэлэн биш): хайлтыг "ашиглагдсан" болгохгүй, дахин оролдоход ажиллана. Тест: Task 3.
5. **UI дээрх "Дахин оролдох":** шинэ idempotency key-тэй шинэ хайлт хийнэ, бүтэлгүй хайлтыг replay хийхгүй. Тест: Task 4 (browser).

---

## Орчин

```bash
cd /home/user/PRsystem
service postgresql start
export PRSYSTEM_TEST_ADMIN_DSN=postgresql://postgres:postgres@127.0.0.1:5432/postgres
export PRSYSTEM_BROWSER_PATH=/opt/pw-browsers/chromium
# .venv болон node_modules (playwright@1.62.1, @axe-core/playwright@4.13.0) бэлэн байна; байхгүй бол:
# python3.12 -m venv .venv && .venv/bin/pip install -q -e '.[postgres,api,test]' tzdata
# npm install --no-save --package-lock=false playwright@1.62.1 @axe-core/playwright@4.13.0
```

PostgreSQL тестийг `PYTHONPATH=src:tests .venv/bin/python -m unittest ...` командаар ажиллуулна. Domain тестийг `PYTHONPATH=src .venv/bin/python -m unittest ...` командаар ажиллуулна.

---

### Task 1: ХУР port, хариуны шалгалт, mock адаптер

**Files:**
- Create: `src/prsystem/xyp.py`
- Modify: `src/prsystem/guest_identity.py:36-62` (`registration_number` гаргаж авах)
- Modify: `src/prsystem/mock_providers.py` (`MockXypGateway` нэмэх)
- Test: `tests/test_xyp_domain.py`

**Interfaces:**
- Produces:
  - `guest_identity.registration_number(value) -> tuple[str, date]` (normalized РД, кодлогдсон төрсөн огноо; буруу бол `DomainError('INVALID_GUEST_IDENTITY')`).
  - `xyp.XypUnavailable(reason='PROVIDER_ERROR')` (`.reason` ∈ `xyp.REASONS`), `xyp.XypNotFound`, `xyp.XypGateway` (Protocol: `citizen(document_number) -> dict`).
  - `xyp.citizen_evidence(document_number, raw) -> dict(document_number, family_name, given_name, date_of_birth)`.
  - `mock_providers.MockXypGateway(store)`: `.add_citizen(document_number, family_name, given_name, date_of_birth)`, `.set_available(bool)`, `.citizen(document_number)`, `.calls: int`, `OUTAGE = 'ЖЖ80010100'`, `is_mock = True`.

- [ ] **Step 1: Унадаг тест бичих** — `tests/test_xyp_domain.py`:

```python
"""ХУР port evidence rules and the development mock adapter (no database)."""
import unittest
from datetime import date
from tempfile import TemporaryDirectory

from prsystem.common import DomainError
from prsystem.guest_identity import registration_number
from prsystem.mock_providers import MockStore, MockXypGateway
from prsystem.xyp import XypNotFound, XypUnavailable, citizen_evidence


class RegistrationNumberTests(unittest.TestCase):
    def test_normalizes_and_decodes_birth_date(self):
        self.assertEqual(registration_number(' аб90010211 '), ('АБ90010211', date(1990, 1, 2)))
        self.assertEqual(registration_number('АБ15210211'), ('АБ15210211', date(2015, 1, 2)))

    def test_rejects_malformed_numbers(self):
        for value in ('AB90010211', 'АБ90133211', 'АБ9001021', None):
            with self.subTest(value=value), self.assertRaisesRegex(DomainError, 'INVALID_GUEST_IDENTITY'):
                registration_number(value)


class CitizenEvidenceTests(unittest.TestCase):
    def test_accepts_complete_matching_answer(self):
        self.assertEqual(citizen_evidence('АБ90010211', dict(family_name=' Туршилт ', given_name='Зочин', date_of_birth='1990-01-02')),
                         dict(document_number='АБ90010211', family_name='Туршилт', given_name='Зочин', date_of_birth='1990-01-02'))

    def test_incomplete_or_mismatched_answer_is_unusable(self):
        for raw in (dict(family_name='Туршилт', given_name='Зочин'), dict(family_name='', given_name='Зочин', date_of_birth='1990-01-02'),
                    dict(family_name='Туршилт', given_name='Зочин', date_of_birth='1990-01-03'), None):
            with self.subTest(raw=raw), self.assertRaises(XypUnavailable) as caught:
                citizen_evidence('АБ90010211', raw)
            self.assertEqual(caught.exception.reason, 'INVALID_EVIDENCE')


class MockXypGatewayTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.gateway = MockXypGateway(MockStore(directory.name + '/xyp.sqlite3', environment='test'))
        self.gateway.add_citizen('АБ90010211', 'Туршилт', 'Зочин', '1990-01-02')

    def test_found_not_found_and_outages(self):
        self.assertEqual(self.gateway.citizen('АБ90010211'), dict(family_name='Туршилт', given_name='Зочин', date_of_birth='1990-01-02'))
        with self.assertRaises(XypNotFound): self.gateway.citizen('АБ85020311')
        with self.assertRaises(XypUnavailable): self.gateway.citizen(MockXypGateway.OUTAGE)
        self.gateway.set_available(False)
        with self.assertRaises(XypUnavailable): self.gateway.citizen('АБ90010211')
        self.assertEqual(self.gateway.calls, 4)

    def test_mock_store_refuses_production_mode(self):
        with TemporaryDirectory() as directory, self.assertRaises(ValueError):
            MockXypGateway(MockStore(directory + '/xyp.sqlite3', environment='production'))
```

- [ ] **Step 2: Унаж байгааг шалгах**

Run: `PYTHONPATH=src .venv/bin/python -m unittest tests.test_xyp_domain -v`
Expected: ERROR — `ImportError: cannot import name 'registration_number' from 'prsystem.guest_identity'`.

- [ ] **Step 3: `registration_number`** — `guest_identity.py`-д `calendar_date`-ийн (`:27-33`) дараа:

```python
def registration_number(value):
    """Normalized Mongolian РД and the birth date it encodes."""
    number = text(value).upper()
    if not re.fullmatch(r'[А-ЯЁӨҮ]{2}[0-9]{8}', number):
        raise DomainError('INVALID_GUEST_IDENTITY')
    yy, mm, dd = int(number[2:4]), int(number[4:6]), int(number[6:8])
    try:
        return number, date(2000 + yy if mm > 20 else 1900 + yy, mm - 20 if mm > 20 else mm, dd)
    except ValueError as exc:
        raise DomainError('INVALID_GUEST_IDENTITY') from exc
```

`validate_identity` доторх `MN_REG_NO` салбарыг:

```python
        required = {'document_number'}
        identifier = text(data.get('document_number')).upper()
        if not re.fullmatch(r'[А-ЯЁӨҮ]{2}[0-9]{8}', identifier):
            raise DomainError('INVALID_GUEST_IDENTITY')
        yy, mm, dd = int(identifier[2:4]), int(identifier[4:6]), int(identifier[6:8])
        try:
            rd_dob = date(2000 + yy if mm > 20 else 1900 + yy, mm - 20 if mm > 20 else mm, dd)
        except ValueError as exc:
            raise DomainError('INVALID_GUEST_IDENTITY') from exc
        if rd_dob != dob:
```
→
```python
        required = {'document_number'}
        identifier, rd_dob = registration_number(data.get('document_number'))
        if rd_dob != dob:
```

- [ ] **Step 4: `src/prsystem/xyp.py`**

```python
"""ХУР (XYP) citizen register port and evidence rules (RC-DEC-046).

Pure domain: no database driver imports. Only a server-held, encrypted lookup
result can make an identity XYP_VERIFIED; the browser never asserts it.
"""
from typing import Protocol

from prsystem.common import DomainError
from prsystem.guest_identity import calendar_date, registration_number, text

REASONS = frozenset({'NOT_CONFIGURED', 'TIMEOUT', 'PROVIDER_ERROR', 'INVALID_EVIDENCE'})
# Real adapters must answer or raise XypUnavailable('TIMEOUT') within this bound.
TIMEOUT_SECONDS = 10


class XypUnavailable(Exception):
    """Network, timeout, missing configuration or an unusable answer."""

    def __init__(self, reason='PROVIDER_ERROR'):
        super().__init__(reason)
        self.reason = reason if reason in REASONS else 'PROVIDER_ERROR'


class XypNotFound(Exception):
    """The register has no citizen for this РД."""


class XypGateway(Protocol):
    def citizen(self, document_number: str) -> dict: ...


def citizen_evidence(document_number, raw):
    """Accept only a complete answer whose birth date matches the РД encoding."""
    try:
        result = dict(family_name=text(raw['family_name']), given_name=text(raw['given_name']),
                      date_of_birth=calendar_date(raw['date_of_birth']).isoformat())
    except (DomainError, KeyError, TypeError) as exc:
        raise XypUnavailable('INVALID_EVIDENCE') from exc
    if registration_number(document_number)[1].isoformat() != result['date_of_birth']:
        raise XypUnavailable('INVALID_EVIDENCE')
    return dict(result, document_number=document_number)
```

- [ ] **Step 5: `MockXypGateway`** — `mock_providers.py`-ийн төгсгөлд:

```python
class MockXypGateway:
    """Simulated ХУР citizen register (EXT-01 pending). Never a production adapter."""
    is_mock = True
    OUTAGE = 'ЖЖ80010100'

    def __init__(self, store):
        self.store, self.available, self.calls = store, True, 0
        with store.connect() as conn:
            conn.execute('''CREATE TABLE IF NOT EXISTS mock_citizen (document_number TEXT PRIMARY KEY,
                family_name TEXT NOT NULL, given_name TEXT NOT NULL, date_of_birth TEXT NOT NULL)''')

    def add_citizen(self, document_number, family_name, given_name, date_of_birth):
        with self.store.connect() as conn:
            conn.execute('INSERT OR REPLACE INTO mock_citizen VALUES (?,?,?,?)', (document_number, family_name, given_name, date_of_birth))

    def set_available(self, available):
        self.available = available is True

    def citizen(self, document_number):
        from prsystem.xyp import XypNotFound, XypUnavailable
        self.calls += 1
        if not self.available or document_number == self.OUTAGE:
            raise XypUnavailable('PROVIDER_ERROR')
        with self.store.connect() as conn:
            row = conn.execute('SELECT family_name,given_name,date_of_birth FROM mock_citizen WHERE document_number=?', (document_number,)).fetchone()
        if row is None:
            raise XypNotFound(document_number)
        return dict(row)
```

- [ ] **Step 6: Давж байгааг шалгах**

Run: `PYTHONPATH=src .venv/bin/python -m unittest tests.test_xyp_domain tests.test_stay_policy -v`
Expected: бүгд OK (`test_stay_policy`-ийн РД тестүүд refactor-ын дараа ч давна).

- [ ] **Step 7: Commit**

```bash
git add src/prsystem/xyp.py src/prsystem/guest_identity.py src/prsystem/mock_providers.py tests/test_xyp_domain.py
git commit -m "feat(xyp): add ХУР port, evidence rules and development mock adapter

RC-DEC-046 groundwork: registration_number() is shared by manual and ХУР
paths; ХУР answers are accepted only when complete and consistent with the
РД-encoded birth date. MockXypGateway simulates found, not found and outage.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 2: `xyp_lookup` хүснэгт, хайлтын service ба API

**Files:**
- Create: `src/prsystem/postgres/migrations/079_xyp_lookup.sql`
- Create: `src/prsystem/xyp_lookups.py`
- Modify: `src/prsystem/api.py:896` (`create_app` signature), `:902` (mock илрүүлэлт), `:923` (service үүсгэх), шинэ model + route, error map
- Modify: `tests/walkin_support.py:23-31` (grant)
- Test: `tests/test_xyp_lookup.py`

**Interfaces:**
- Consumes: Task 1-ийн `citizen_evidence`, `XypNotFound`, `XypUnavailable`, `registration_number`, `MockXypGateway`.
- Produces:
  - `XypLookups(auth, vault, gateway=None).lookup(bearer, tenant, document_number, consent, key) -> dict` (`lookup_id`, `status`, `expires_at`, `citizen?`).
  - HTTP `POST /hotels/{tenant_id}/guest-identity/xyp-lookups` (body `XypLookupInput`: `document_number`, `consent`, `idempotency_key`) → 201.
  - `create_app(..., xyp_gateway=None)`.
  - Хүснэгт `prsystem.xyp_lookup`, trigger `xyp_lookup_guard`.

- [ ] **Step 1: Test grant нэмэх** — `tests/walkin_support.py`-ийн `WalkInCase.setUpClass` statement жагсаалтад (`'GRANT SELECT ON prsystem.room_reservation TO {}',` мөрийн дараа):

```python
                'GRANT SELECT,INSERT ON prsystem.xyp_lookup TO {}',
                'GRANT UPDATE (stay_id) ON prsystem.xyp_lookup TO {}',
```

- [ ] **Step 2: Унадаг тест бичих** — `tests/test_xyp_lookup.py`:

```python
"""ХУР lookup and check-in binding on real PostgreSQL through the API (RC-DEC-046)."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from tempfile import TemporaryDirectory
from threading import Barrier

from postgres_support import ADMIN_DSN
from walkin_support import WalkInCase
if ADMIN_DSN:
    import psycopg
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.mock_providers import MockStore, MockXypGateway


@unittest.skipUnless(ADMIN_DSN, 'PRSYSTEM_TEST_ADMIN_DSN is not set')
class XypLookupTests(WalkInCase):
    def setUp(self):
        super().setUp()
        directory = TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.xyp = MockXypGateway(MockStore(directory.name + '/xyp.sqlite3', environment='test'))
        self.xyp.add_citizen('АБ90010211', 'Туршилт', 'Зочин', '1990-01-02')
        self.client.close()
        self.client = TestClient(create_app(self.app_dsn, self.settings, identity_vault=self.vault, runtime_mode='test',
                                            mock_stay_finance=True, xyp_gateway=self.xyp), client=(self.peer, 12345))
        self.addCleanup(self.client.close)

    def lookup(self, number='АБ90010211', consent=True, key='lookup', token=None):
        return self.client.post(f'/hotels/{self.tenant}/guest-identity/xyp-lookups', headers=self.headers(token or self.worker_token),
                                json=dict(document_number=number, consent=consent, idempotency_key=key))

    def test_found_lookup_returns_citizen_and_stores_only_encrypted_evidence(self):
        result = self.assert_status(self.lookup(), 201)
        self.assertEqual((result['status'], result['citizen']),
                         ('FOUND', dict(family_name='Туршилт', given_name='Зочин', date_of_birth='1990-01-02', nationality='MN')))
        with psycopg.connect(self.owner_dsn) as conn:
            row = conn.execute('''SELECT actor_id,status,reason,lookup_token,envelope,consent_at<=created_at,expires_at-created_at
                FROM prsystem.xyp_lookup WHERE tenant_id=%s AND id=%s''', (self.tenant, result['lookup_id'])).fetchone()
            events = str(conn.execute("SELECT details FROM prsystem.operational_event WHERE tenant_id=%s AND kind='XYP_LOOKUP'", (self.tenant,)).fetchall())
            receipts = str(conn.execute('SELECT result FROM prsystem.staff_command_receipt WHERE tenant_id=%s', (self.tenant,)).fetchall())
        self.assertEqual(row[:3], (self.worker, 'FOUND', None))
        self.assertTrue(row[5]); self.assertEqual(row[6].total_seconds(), 900)
        for secret in ('АБ90010211', 'Туршилт', 'Зочин', '1990-01-02'):
            self.assertNotIn(secret, row[3] + str(row[4]) + events + receipts)

    def test_not_found_and_unavailable_are_recorded_without_evidence(self):
        self.assertEqual(self.assert_status(self.lookup('АБ85020311', key='miss'), 201)['status'], 'NOT_FOUND')
        down = self.assert_status(self.lookup(MockXypGateway.OUTAGE, key='down'), 201)
        self.assertEqual((down['status'], 'citizen' in down), ('UNAVAILABLE', False))
        self.xyp.add_citizen('АБ88010111', 'Буруу', 'Огноо', '1988-01-02')
        self.assertEqual(self.assert_status(self.lookup('АБ88010111', key='bad'), 201)['status'], 'UNAVAILABLE')
        with psycopg.connect(self.owner_dsn) as conn:
            rows = conn.execute('SELECT status,reason,envelope FROM prsystem.xyp_lookup WHERE tenant_id=%s ORDER BY created_at', (self.tenant,)).fetchall()
        self.assertEqual(rows, [('NOT_FOUND', None, None), ('UNAVAILABLE', 'PROVIDER_ERROR', None), ('UNAVAILABLE', 'INVALID_EVIDENCE', None)])

    def test_consent_structure_and_permissions_are_checked_before_calling_xyp(self):
        self.assertEqual(self.lookup(consent=False).json()['code'], 'XYP_CONSENT_REQUIRED')
        self.assertEqual(self.lookup(consent=False).status_code, 422)
        self.assertEqual(self.lookup('AB90010211', key='latin').json()['code'], 'INVALID_GUEST_IDENTITY')
        _, cleaner = self.add_staff(['CLEANER'])
        for token in (cleaner, self.admin):
            self.assert_status(self.lookup(token=token, key='denied'), 403)
        self.assertEqual(self.xyp.calls, 0)

    def test_retry_replays_without_second_xyp_call_and_limit_applies(self):
        first = self.assert_status(self.lookup(), 201)
        self.assertEqual(self.assert_status(self.lookup(), 201), first)
        self.assertEqual(self.xyp.calls, 1)
        for index in range(19):
            self.assert_status(self.lookup(key=f'more-{index}'), 201)
        over = self.lookup(key='over')
        self.assertEqual((over.status_code, over.json()['code']), (429, 'XYP_LOOKUP_LIMIT'))
        self.assertEqual(self.xyp.calls, 20)

    def test_unconfigured_production_adapter_reports_unavailable(self):
        with TestClient(create_app(self.app_dsn, self.settings, identity_vault=self.vault), client=(self.peer, 12345)) as client:
            response = client.post(f'/hotels/{self.tenant}/guest-identity/xyp-lookups', headers=self.headers(self.worker_token),
                                   json=dict(document_number='АБ90010211', consent=True, idempotency_key='prod'))
        self.assertEqual(self.assert_status(response, 201)['status'], 'UNAVAILABLE')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT reason FROM prsystem.xyp_lookup WHERE tenant_id=%s', (self.tenant,)).fetchone()[0], 'NOT_CONFIGURED')

    def test_lookup_rows_are_tenant_scoped_and_append_only(self):
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        with psycopg.connect(self.app_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.xyp_lookup').fetchone()[0], 0)
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,false)", (self.tenant,))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.xyp_lookup').fetchone()[0], 1)
        with psycopg.connect(self.owner_dsn) as conn, self.assertRaises(psycopg.errors.CheckViolation):
            conn.execute("UPDATE prsystem.xyp_lookup SET status='NOT_FOUND' WHERE id=%s", (lookup,))
```

- [ ] **Step 3: Унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_xyp_lookup -v`
Expected: `setUpClass` ERROR — `psycopg.errors.UndefinedTable: relation "prsystem.xyp_lookup" does not exist` (grant statement). Migration байхгүй.

- [ ] **Step 4: Migration** — `src/prsystem/postgres/migrations/079_xyp_lookup.sql`:

```sql
-- RC-DEC-046: server-held ХУР lookup bound once to a check-in. No plaintext РД or names.
CREATE TABLE prsystem.xyp_lookup (
 tenant_id text NOT NULL, id text NOT NULL, actor_id text NOT NULL, lookup_token text NOT NULL,
 status text NOT NULL CHECK (status IN ('FOUND','NOT_FOUND','UNAVAILABLE')),
 reason text CHECK (reason IN ('NOT_CONFIGURED','TIMEOUT','PROVIDER_ERROR','INVALID_EVIDENCE')),
 envelope jsonb, consent_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, stay_id text,
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 FOREIGN KEY (tenant_id,stay_id) REFERENCES prsystem.stay(tenant_id,id),
 CHECK (expires_at = created_at + interval '15 minutes'),
 CHECK (consent_at <= created_at),
 CHECK ((status='FOUND') = (envelope IS NOT NULL)),
 CHECK ((status='UNAVAILABLE') = (reason IS NOT NULL))
);
CREATE UNIQUE INDEX xyp_lookup_one_stay ON prsystem.xyp_lookup (tenant_id,stay_id) WHERE stay_id IS NOT NULL;
CREATE INDEX xyp_lookup_actor_recent ON prsystem.xyp_lookup (tenant_id,actor_id,created_at);
CREATE FUNCTION prsystem.guard_xyp_lookup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.stay_id IS NOT NULL OR NEW.stay_id IS NULL
    OR (to_jsonb(NEW)-'stay_id') IS DISTINCT FROM (to_jsonb(OLD)-'stay_id') THEN
  RAISE EXCEPTION 'xyp_lookup is append-only except one stay binding' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER xyp_lookup_guard BEFORE UPDATE OR DELETE ON prsystem.xyp_lookup
FOR EACH ROW EXECUTE FUNCTION prsystem.guard_xyp_lookup();
ALTER TABLE prsystem.xyp_lookup ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.xyp_lookup FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prsystem.xyp_lookup
 USING (tenant_id=current_setting('prsystem.tenant_id',true)) WITH CHECK (tenant_id=current_setting('prsystem.tenant_id',true));
REVOKE ALL ON prsystem.xyp_lookup FROM PUBLIC;
REVOKE ALL ON FUNCTION prsystem.guard_xyp_lookup() FROM PUBLIC;
-- 018's inline CHECK is named stay_guest_identity_provenance_check (verified in pg_constraint).
ALTER TABLE prsystem.stay_guest_identity DROP CONSTRAINT stay_guest_identity_provenance_check;
ALTER TABLE prsystem.stay_guest_identity ADD CONSTRAINT stay_guest_identity_provenance_check
 CHECK (provenance='MANUAL' OR (provenance='XYP_VERIFIED' AND identity_type='MN_REG_NO'));
```

- [ ] **Step 5: Service** — `src/prsystem/xyp_lookups.py`:

```python
"""Server-held ХУР lookups for Reception (RC-DEC-046).

The adapter is called outside database transactions. Receipts keep only the
lookup id; citizen data lives in the encrypted xyp_lookup envelope.
"""
import secrets
from datetime import timedelta

from psycopg.types.json import Jsonb

from prsystem.booking_inventory import scope
from prsystem.common import DomainError
from prsystem.guest_identity import registration_number
from prsystem.postgres.connection import transaction
from prsystem.stays import StayService
from prsystem.xyp import XypNotFound, XypUnavailable, citizen_evidence

LOOKUP_LIMIT = 20
LOOKUP_WINDOW = timedelta(minutes=10)
LOOKUP_TTL = timedelta(minutes=15)


class XypLookups(StayService):
    def __init__(self, auth, vault, gateway=None):
        super().__init__(auth, vault)
        self.gateway = gateway

    def ask(self, number):
        if self.gateway is None:
            return 'UNAVAILABLE', 'NOT_CONFIGURED', None
        try:
            return 'FOUND', None, citizen_evidence(number, self.gateway.citizen(number))
        except XypNotFound:
            return 'NOT_FOUND', None, None
        except XypUnavailable as exc:
            return 'UNAVAILABLE', exc.reason, None
        except Exception:  # A crashing adapter must not block manual fallback.
            return 'UNAVAILABLE', 'PROVIDER_ERROR', None

    def view(self, conn, tenant, lookup):
        scope(conn, tenant)
        status, envelope, expires = conn.execute('SELECT status,envelope,expires_at FROM prsystem.xyp_lookup WHERE tenant_id=%s AND id=%s',
                                                 (tenant, lookup)).fetchone()
        result = dict(lookup_id=lookup, status=status, expires_at=expires.isoformat())
        if envelope:
            citizen = self.vault.open(envelope, tenant, lookup, 'xyp-lookup')
            result['citizen'] = dict(family_name=citizen['family_name'], given_name=citizen['given_name'],
                                     date_of_birth=citizen['date_of_birth'], nationality='MN')
        return result

    def begin(self, conn, bearer, tenant, document_number, consent, key):
        actor = self._actor(conn, bearer, tenant)
        number, _ = registration_number(document_number)
        if consent is not True:
            raise DomainError('XYP_CONSENT_REQUIRED')
        token = self.vault.fingerprint('guest-exact-identity', ['MN_REG_NO', 'MN', number])
        command = dict(action='XYP_LOOKUP', fingerprint=self.vault.fingerprint('xyp-lookup-command', [tenant, token]))
        return actor, number, token, command, self._receipt(conn, tenant, key, actor, command)

    def lookup(self, bearer, tenant, document_number, consent, key):
        if self.vault is None:
            raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
        with transaction(self.auth.dsn) as conn:
            actor, number, token, command, replay = self.begin(conn, bearer, tenant, document_number, consent, key)
            if replay is not None:
                return self.view(conn, tenant, replay['lookup_id'])
            scope(conn, tenant)
            recent = conn.execute('SELECT count(*) FROM prsystem.xyp_lookup WHERE tenant_id=%s AND actor_id=%s AND created_at>clock_timestamp()-%s',
                                  (tenant, actor, LOOKUP_WINDOW)).fetchone()[0]
            if recent >= LOOKUP_LIMIT:
                raise DomainError('XYP_LOOKUP_LIMIT')
            consent_at = conn.execute('SELECT clock_timestamp()').fetchone()[0]
        status, reason, citizen = self.ask(number)  # never inside a database transaction
        with transaction(self.auth.dsn) as conn:
            actor, number, token, command, replay = self.begin(conn, bearer, tenant, document_number, consent, key)
            if replay is not None:  # a concurrent retry with the same key committed first
                return self.view(conn, tenant, replay['lookup_id'])
            scope(conn, tenant)
            lookup = secrets.token_hex(16)
            now = conn.execute('SELECT clock_timestamp()').fetchone()[0]
            envelope = Jsonb(self.vault.seal(citizen, tenant, lookup, 'xyp-lookup')) if citizen else None
            conn.execute('''INSERT INTO prsystem.xyp_lookup(tenant_id,id,actor_id,lookup_token,status,reason,envelope,consent_at,created_at,expires_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''', (tenant, lookup, actor, token, status, reason, envelope, consent_at, now, now + LOOKUP_TTL))
            self.event(conn, tenant, actor, 'XYP_LOOKUP', lookup, dict(status=status, reason=reason))
            self._save_receipt(conn, tenant, key, actor, command, dict(lookup_id=lookup))
            return self.view(conn, tenant, lookup)
```

- [ ] **Step 6: API** — `api.py`:

1. Import (`from prsystem.reception_booking import ReceptionBooking` мөрийн дараа):
   ```python
   from prsystem.xyp_lookups import XypLookups
   ```
2. Model (`class WalkInCheckIn(BaseModel):`-ийн өмнө):
   ```python
   class XypLookupInput(BaseModel):
       model_config = ConfigDict(extra='forbid',strict=True)
       document_number: str = Field(min_length=1,max_length=200)
       consent: bool
       idempotency_key: str = Field(min_length=1,max_length=128)


   ```
3. `create_app` signature-ийн төгсгөл `...,contact_notice_gateway=None) -> FastAPI:` → `...,contact_notice_gateway=None,xyp_gateway=None) -> FastAPI:`.
4. Mock илрүүлэлт (`:902`) дээрх жагсаалт `[phone_gateway, bank_gateway, sms_gateway, ebarimt_gateway, contact_notice_gateway, ...` → `[phone_gateway, bank_gateway, sms_gateway, ebarimt_gateway, contact_notice_gateway, xyp_gateway, ...`.
5. `stays = ReceptionBooking(...)` (`:923`)-ийн дараа:
   ```python
       xyp_lookups = XypLookups(service, stays.vault, xyp_gateway)
   ```
6. Route (`@app.post('/hotels/{tenant_id}/stays/check-in',status_code=201)`-ийн өмнө):
   ```python
       @app.post('/hotels/{tenant_id}/guest-identity/xyp-lookups',status_code=201)
       def xyp_lookup(tenant_id: str,body: XypLookupInput,secret: Annotated[str,Depends(token)]):
           return xyp_lookups.lookup(secret,tenant_id,body.document_number,body.consent,body.idempotency_key)

   ```
7. Error map (`stay_errors['STAY_FINANCE_UNAVAILABLE'] = 503` мөрийн дараа):
   ```python
           stay_errors.update({'XYP_CONSENT_REQUIRED':422,'XYP_LOOKUP_LIMIT':429})
   ```

- [ ] **Step 7: Давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_xyp_lookup tests.test_walkin_stays -v`
Expected: бүгд OK.

- [ ] **Step 8: Commit**

```bash
git add src/prsystem/postgres/migrations/079_xyp_lookup.sql src/prsystem/xyp_lookups.py src/prsystem/api.py tests/walkin_support.py tests/test_xyp_lookup.py
git commit -m "feat(xyp): server-held ХУР lookup with consent, limit and encrypted evidence

RC-DEC-046: POST /hotels/{t}/guest-identity/xyp-lookups calls the adapter
outside transactions, stores FOUND evidence only in an encrypted envelope,
caps lookups at 20 per staff member per 10 minutes and keeps receipts free
of personal data. Migration 079 adds the tenant-RLS xyp_lookup table and
allows XYP_VERIFIED provenance for MN_REG_NO identities.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 3: Check-in-ийг хайлтын дугаартай холбох

**Files:**
- Modify: `src/prsystem/xyp.py` (`bind` нэмэх)
- Modify: `src/prsystem/stays.py:88-94` (legacy fingerprint), `:206` (identity), `:222-224` (provenance + холболт), шинэ `_guest_identity`
- Modify: `src/prsystem/api.py` (`PrimaryGuestInput`, error map)
- Modify: `tests/walkin_support.py` (`with_xyp`, `checkin`), `tests/test_booking_holds.py:264-267` (`apply_hold`), `tests/test_reception_booking.py:21-23` (`arrive`), `tests/test_ui_review.py:58-60`
- Test: `tests/test_xyp_lookup.py`

**Interfaces:**
- Consumes: Task 2-ийн `xyp_lookup` хүснэгт, lookup API.
- Produces:
  - `xyp.bind(conn, vault, tenant, guest, on_date) -> (identity, exact, lookup_id)`.
  - `StayService._guest_identity(conn, tenant, guest, on_date) -> (identity, exact, lookup_id|None)`.
  - `PrimaryGuestInput.xyp_lookup_id`.
  - `WalkInCase.with_xyp(guest, token=None, tenant=None, key='checkin') -> dict`.
  - Алдааны кодууд: `XYP_LOOKUP_REQUIRED`/`XYP_VERIFIED_FIELDS_LOCKED`/`XYP_LOOKUP_MISMATCH` (422), `XYP_LOOKUP_NOT_FOUND` (404), `XYP_LOOKUP_USED`/`XYP_LOOKUP_EXPIRED` (409).

- [ ] **Step 1: Унадаг тест бичих** — `tests/test_xyp_lookup.py`-ийн `XypLookupTests` класын төгсгөлд:

```python
    MANUAL = dict(family_name='Бат', given_name='Болд', date_of_birth='1985-02-03', nationality='MN', document_number='АБ85020311')

    def guest(self, lookup, **manual):
        return dict(identity_type='MN_REG_NO', xyp_lookup_id=lookup, **manual)

    def identity(self, stay):
        with psycopg.connect(self.owner_dsn) as conn:
            provenance, envelope = conn.execute('SELECT provenance,envelope FROM prsystem.stay_guest_identity WHERE tenant_id=%s AND stay_id=%s',
                                                (self.tenant, stay)).fetchone()
        return provenance, self.vault.open(envelope, self.tenant, stay)

    def second_room(self):
        room = self.assert_status(self.client.post(f'/hotels/{self.tenant}/rooms', headers=self.headers(self.manager_token),
            json=dict(number='102', floor='1', category_id=self.category, idempotency_key='room-102')), 201)['room_id']
        task = self.assert_status(self.client.post(f'/hotels/{self.tenant}/rooms/{room}/cleaning-requests', headers=self.headers(self.manager_token),
            json=dict(assignee_id=self.worker, expected_revision=1, idempotency_key='cleaning-102')), 201)
        self.assert_status(self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task["task_id"]}/start', headers=self.headers(self.worker_token),
            json=dict(expected_revision=task['assignment_version'], idempotency_key='start-102')), 200)
        self.assert_status(self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task["task_id"]}/post', headers=self.headers(self.worker_token),
            json=dict(expected_revision=task['assignment_version'], action_id=task['action_id'], quantity=1, idempotency_key='clean-102')), 200)
        return room

    def test_found_lookup_checks_in_as_xyp_verified_and_locks_fields(self):
        self.ready()
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        self.assertEqual(self.checkin(guest=self.guest(lookup, family_name='Өөр'), idempotency_key='edited').json()['code'], 'XYP_VERIFIED_FIELDS_LOCKED')
        stay = self.assert_status(self.checkin(guest=self.guest(lookup)), 201)['stay_id']
        provenance, identity = self.identity(stay)
        self.assertEqual((provenance, identity['family_name'], identity['given_name'], identity['date_of_birth'], identity['nationality'], identity['document_number']),
                         ('XYP_VERIFIED', 'Туршилт', 'Зочин', '1990-01-02', 'MN', 'АБ90010211'))

    def test_manual_entry_only_for_the_failed_normalized_rd(self):
        self.ready()
        miss = self.assert_status(self.lookup(' аб85020311 ', key='miss'), 201)['lookup_id']
        other = dict(self.MANUAL, document_number='АБ90010211', date_of_birth='1990-01-02')
        self.assertEqual(self.checkin(guest=self.guest(miss, **other), idempotency_key='other').json()['code'], 'XYP_LOOKUP_MISMATCH')
        stay = self.assert_status(self.checkin(guest=self.guest(miss, **self.MANUAL)), 201)['stay_id']
        provenance, identity = self.identity(stay)
        self.assertEqual((provenance, identity['xyp_fallback']), ('MANUAL', dict(status='NOT_FOUND', reason=None)))

    def test_unavailable_lookup_allows_manual_entry_with_reason(self):
        self.ready(); self.xyp.set_available(False)
        down = self.assert_status(self.lookup('АБ85020311', key='down'), 201)['lookup_id']
        stay = self.assert_status(self.checkin(guest=self.guest(down, **self.MANUAL)), 201)['stay_id']
        self.assertEqual(self.identity(stay)[1]['xyp_fallback'], dict(status='UNAVAILABLE', reason='PROVIDER_ERROR'))

    def test_lookup_is_required_known_unexpired_and_mn_only(self):
        self.ready()
        # Posted directly: the WalkInCase.checkin helper would add a lookup on its own.
        none = self.client.post(f'/hotels/{self.tenant}/stays/check-in', headers=self.headers(self.worker_token), json=dict(
            room_id=self.room, kind='HOURLY', duration_units=3, guest=dict(self.MANUAL, identity_type='MN_REG_NO'), idempotency_key='none'))
        self.assertEqual(none.json()['code'], 'XYP_LOOKUP_REQUIRED')
        missing = self.checkin(guest=self.guest('0' * 32), idempotency_key='missing')
        self.assertEqual((missing.status_code, missing.json()['code']), (404, 'XYP_LOOKUP_NOT_FOUND'))
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        passport = dict(identity_type='FOREIGN_PASSPORT', family_name='Test', given_name='Guest', date_of_birth='2000-09-08', nationality='US',
                        document_number='P123', issuing_country='US', expiry_date='2030-01-01', xyp_lookup_id=lookup)
        self.assertEqual(self.checkin(guest=passport, idempotency_key='passport').json()['code'], 'INVALID_GUEST_IDENTITY')
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('ALTER TABLE prsystem.xyp_lookup DISABLE TRIGGER xyp_lookup_guard')
            conn.execute("UPDATE prsystem.xyp_lookup SET created_at=created_at-interval '16 minutes',consent_at=consent_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes' WHERE id=%s", (lookup,))
            conn.execute('ALTER TABLE prsystem.xyp_lookup ENABLE TRIGGER xyp_lookup_guard')
        late = self.checkin(guest=self.guest(lookup), idempotency_key='late')
        self.assertEqual((late.status_code, late.json()['code']), (409, 'XYP_LOOKUP_EXPIRED'))

    def test_lookup_is_single_use_and_replay_returns_the_first_result(self):
        self.ready(); room = self.second_room()
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        first = self.assert_status(self.checkin(guest=self.guest(lookup)), 201)
        self.assertEqual(self.assert_status(self.checkin(guest=self.guest(lookup)), 201), first)
        used = self.checkin(room_id=room, guest=self.guest(lookup), idempotency_key='second')
        self.assertEqual((used.status_code, used.json()['code']), (409, 'XYP_LOOKUP_USED'))

    def test_concurrent_checkins_with_one_lookup_have_one_winner(self):
        self.ready(); room = self.second_room()
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        barrier = Barrier(2)
        def attempt(args):
            room_id, key = args; barrier.wait()
            return self.checkin(room_id=room_id, guest=self.guest(lookup), idempotency_key=key)
        with ThreadPoolExecutor(2) as pool:
            responses = list(pool.map(attempt, [(self.room, 'a'), (room, 'b')]))
        self.assertEqual(sorted(r.status_code for r in responses), [201, 409])
        self.assertEqual(next(r for r in responses if r.status_code == 409).json()['code'], 'XYP_LOOKUP_USED')

    def test_failed_checkin_leaves_the_lookup_usable(self):
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        self.assertEqual(self.checkin(guest=self.guest(lookup), idempotency_key='dirty').json()['code'], 'ROOM_NOT_READY')
        self.ready()
        self.assert_status(self.checkin(guest=self.guest(lookup)), 201)

    def test_xyp_birth_date_applies_the_adult_rule(self):
        self.ready(); self.xyp.add_citizen('АБ15210211', 'Бага', 'Хүүхэд', '2015-01-02')
        lookup = self.assert_status(self.lookup('АБ15210211'), 201)['lookup_id']
        self.assertEqual(self.checkin(guest=self.guest(lookup)).json()['code'], 'GUEST_UNDER_18')
```

(`guest` нь `xyp_lookup_id`-тай тул Step 5-ын `with_xyp` дахин хайлт хийхгүй.)

- [ ] **Step 2: Унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_xyp_lookup -v`
Expected: шинэ 8 тест FAIL/ERROR. `xyp_lookup_id` API model-д байхгүй тул `extra='forbid'` → 422 `INVALID_REQUEST`, жишээ нь `AssertionError: 422 != 201`. Task 2-ын тестүүд OK хэвээр.

- [ ] **Step 3: `bind`** — `src/prsystem/xyp.py`-ийн төгсгөлд. Импортыг `from prsystem.common import DomainError, identifier`, `from prsystem.guest_identity import calendar_date, registration_number, text, validate_identity` болгож, `from prsystem.booking_inventory import scope` нэмнэ (`booking_inventory` psycopg импортлохгүй):

```python
MANUAL_FIELDS = ('document_number', 'family_name', 'given_name', 'date_of_birth', 'nationality')


def bind(conn, vault, tenant, guest, on_date):
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
        if any(guest.get(name) is not None for name in MANUAL_FIELDS):
            raise DomainError('XYP_VERIFIED_FIELDS_LOCKED')
        citizen = vault.open(envelope, tenant, lookup, 'xyp-lookup')
        identity, exact = validate_identity(dict(citizen, identity_type='MN_REG_NO', nationality='MN'), on_date)
        identity['provenance'] = 'XYP_VERIFIED'
    else:
        identity, exact = validate_identity({k: v for k, v in guest.items() if k != 'xyp_lookup_id'}, on_date)
        if vault.fingerprint('guest-exact-identity', list(exact)) != token:
            raise DomainError('XYP_LOOKUP_MISMATCH')
        identity['xyp_fallback'] = dict(status=status, reason=reason)
    return identity, exact, lookup
```

- [ ] **Step 4: `stays.py`**

1. `check_in`-ий эхэнд (`if funding_id and cash_deposit is not None:raise ...` мөрийн дараа):
   ```python
           # Keep legacy command fingerprints stable when the new optional lookup is absent.
           if data['guest'].get('xyp_lookup_id') is None:
               data=dict(data,guest={k:v for k,v in data['guest'].items() if k!='xyp_lookup_id'})
   ```
2. `identity, exact = validate_identity(data['guest'], actual.astimezone(HOTEL_ZONE).date())` → `identity, exact, xyp_lookup = self._guest_identity(conn, tenant, data['guest'], actual.astimezone(HOTEL_ZONE).date())`.
3. `stay_guest_identity` insert:
   ```python
               conn.execute('''INSERT INTO prsystem.stay_guest_identity (tenant_id,stay_id,identity_type,provenance,envelope,lookup_token)
                   VALUES (%s,%s,%s,'MANUAL',%s,%s)''', (tenant, stay, identity['identity_type'], Jsonb(self.vault.seal(identity, tenant, stay)), lookup))
   ```
   →
   ```python
               conn.execute('''INSERT INTO prsystem.stay_guest_identity (tenant_id,stay_id,identity_type,provenance,envelope,lookup_token)
                   VALUES (%s,%s,%s,%s,%s,%s)''', (tenant, stay, identity['identity_type'], identity['provenance'], Jsonb(self.vault.seal(identity, tenant, stay)), lookup))
               if xyp_lookup:
                   conn.execute('UPDATE prsystem.xyp_lookup SET stay_id=%s WHERE tenant_id=%s AND id=%s', (stay, tenant, xyp_lookup))
   ```
4. `_shift`-ийн (`:36-46`) дараа шинэ method:
   ```python
       def _guest_identity(self, conn, tenant, guest, on_date):
           """RC-DEC-046: a Mongolian РД identity resolves through its server-held ХУР lookup."""
           if guest.get('identity_type') == 'MN_REG_NO':
               from prsystem.xyp import bind
               return bind(conn, self.vault, tenant, guest, on_date)
           if guest.get('xyp_lookup_id') is not None:
               raise DomainError('INVALID_GUEST_IDENTITY')
           return (*validate_identity(guest, on_date), None)
   ```

- [ ] **Step 5: API** — `PrimaryGuestInput`-ийн 4 заавал талбарыг optional болгож, хайлтын дугаар нэмнэ:

```python
    family_name: str = Field(min_length=1,max_length=200)
    given_name: str = Field(min_length=1,max_length=200)
    date_of_birth: str = Field(min_length=10,max_length=10)
    nationality: str = Field(min_length=1,max_length=200)
```
→
```python
    # RC-DEC-046: an ХУР-verified РД guest sends only xyp_lookup_id; the domain enforces per-type fields.
    family_name: str | None = Field(default=None,min_length=1,max_length=200)
    given_name: str | None = Field(default=None,min_length=1,max_length=200)
    date_of_birth: str | None = Field(default=None,min_length=10,max_length=10)
    nationality: str | None = Field(default=None,min_length=1,max_length=200)
```

`note: str | None = Field(default=None,min_length=1,max_length=2000)`-ийн дараа:
```python
    xyp_lookup_id: str | None = Field(default=None,min_length=1,max_length=128)
```

Error map (Task 2-ын мөрийн дараа):
```python
        stay_errors.update({'XYP_LOOKUP_REQUIRED':422,'XYP_VERIFIED_FIELDS_LOCKED':422,'XYP_LOOKUP_MISMATCH':422,'XYP_LOOKUP_NOT_FOUND':404,'XYP_LOOKUP_USED':409,'XYP_LOOKUP_EXPIRED':409})
```

- [ ] **Step 6: Шинэ тестүүд давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_xyp_lookup -v`
Expected: бүгд OK.

- [ ] **Step 7: Одоогийн тестүүд унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_walkin_stays tests.test_reception_booking tests.test_booking_holds 2>&1 | tail -5`
Expected: FAIL/ERROR. Монгол РД-тэй check-in-ууд `422 XYP_LOOKUP_REQUIRED` буцаана.

- [ ] **Step 8: Тестийн helper-уудыг шинэчлэх**

`tests/walkin_support.py` — `checkin`-ийг солино:

```python
    def checkin(self,token=None,tenant=None,**extra):
        body=dict(room_id=self.room,kind='HOURLY',duration_units=3,guest=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),idempotency_key='checkin')
        body.update(extra)
        return self.client.post(f'/hotels/{tenant or self.tenant}/stays/check-in',headers=self.headers(token or self.worker_token),json=body)
```
→
```python
    def with_xyp(self,guest,token=None,tenant=None,key='checkin'):
        """RC-DEC-046: MN_REG_NO check-in needs a ХУР lookup. Apps without an adapter answer
        UNAVAILABLE, so the same manual guest data stays valid. The key is derived from the
        check-in key, so retries replay the same lookup instead of creating a new one."""
        if not isinstance(guest,dict) or guest.get('identity_type')!='MN_REG_NO' or 'xyp_lookup_id' in guest or not isinstance(guest.get('document_number'),str):
            return guest
        response=self.client.post(f'/hotels/{tenant or self.tenant}/guest-identity/xyp-lookups',headers=self.headers(token or self.worker_token),
            json=dict(document_number=guest['document_number'],consent=True,idempotency_key=f'xyp-{key}'[:128]))
        return dict(guest,xyp_lookup_id=response.json()['lookup_id']) if response.status_code==201 else guest

    def checkin(self,token=None,tenant=None,**extra):
        body=dict(room_id=self.room,kind='HOURLY',duration_units=3,guest=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),idempotency_key='checkin')
        body.update(extra)
        body['guest']=self.with_xyp(body['guest'],token,tenant,str(body.get('idempotency_key')))
        return self.client.post(f'/hotels/{tenant or self.tenant}/stays/check-in',headers=self.headers(token or self.worker_token),json=body)
```

(Хайлт амжилтгүй бол (403, 401, subscription) guest-ийг өөрчлөхгүй. Check-in-ий эрхийн шалгалт identity-ээс өмнө явагддаг тул тест өмнөх алдаагаа авсаар байна.)

`tests/test_booking_holds.py:264-267` `apply_hold`:
```python
        body=dict(room_id=self.room,guest=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),idempotency_key=key)
        body.update(extra)
```
→
```python
        body=dict(room_id=self.room,guest=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),idempotency_key=key)
        body.update(extra)
        body['guest']=self.with_xyp(body['guest'],token,None,str(body.get('idempotency_key')))
```

`tests/test_reception_booking.py` `arrive`:
```python
        body=dict(guest=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),idempotency_key='arrive');body.update(extra)
```
→
```python
        body=dict(guest=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),idempotency_key='arrive');body.update(extra)
        body['guest']=self.with_xyp(body['guest'],key=str(body.get('idempotency_key')))
```

`tests/test_ui_review.py:58-60` — review app-д адаптер байхгүй (Task 5 хүртэл) тул `UNAVAILABLE`, гараар бүртгэнэ:
```python
            stay = fixture.assert_status(client.post(root+'stays/check-in', headers=reception, json=dict(
                room_id=fixture.room, kind='NIGHTLY', duration_units=1,
                guest=dict(identity_type='MN_REG_NO',family_name='Туршилт',given_name='Зочин',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),
```
→
```python
            lookup = fixture.assert_status(client.post(root+'guest-identity/xyp-lookups', headers=reception,
                json=dict(document_number='АБ90010211', consent=True, idempotency_key=uuid4().hex)), 201)
            stay = fixture.assert_status(client.post(root+'stays/check-in', headers=reception, json=dict(
                room_id=fixture.room, kind='NIGHTLY', duration_units=1,
                guest=dict(identity_type='MN_REG_NO',xyp_lookup_id=lookup['lookup_id'],family_name='Туршилт',given_name='Зочин',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),
```

- [ ] **Step 9: Давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_xyp_lookup tests.test_walkin_stays tests.test_reception_booking tests.test_booking_holds tests.test_minibar_configuration tests.test_ui_review tests.test_stay_policy 2>&1 | tail -4`
Expected: `OK`.

Хэрэв `test_booking_holds`-ийн production client check-in (`:325`) эсвэл `test_minibar_configuration:161` унавал алдааны кодыг уншина. Эдгээр тест identity-ээс өмнө гарах алдааг (`503`, `CONFIGURATION_PENDING`) хүлээдэг. Хэрэв `XYP_LOOKUP_REQUIRED` буцвал тухайн body-д `self.with_xyp(guest, key=...)`-ийг ижил загвараар нэмнэ.

- [ ] **Step 10: Commit**

```bash
git add src/prsystem/xyp.py src/prsystem/stays.py src/prsystem/api.py tests/test_xyp_lookup.py tests/walkin_support.py tests/test_booking_holds.py tests/test_reception_booking.py tests/test_ui_review.py
git commit -m "feat(xyp): bind MN_REG_NO check-in to a single-use ХУР lookup

RC-DEC-046: FOUND lookups create XYP_VERIFIED identities from server-held
evidence and reject edited fields; NOT_FOUND/UNAVAILABLE lookups allow
manual entry only for the same РД and record the fallback reason. Lookups
are tenant-bound, expire after 15 minutes and bind to exactly one stay.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 4: Reception UI

**Files:**
- Modify: `src/prsystem/static/reception.js:11` (`errors`), `:529-550` (`checkin` → `checkin` + `xypLookup` + `xypResult` + `guestForm`)
- Test: `tests/browser/reception.cjs:9, :21, :23, :37-38`, `tests/browser/ui-quality.cjs:49`

**Interfaces:**
- Consumes: Task 2-ын `POST guest-identity/xyp-lookups` хариу (`lookup_id`, `status`, `citizen?`). Task 3-ын `guest.xyp_lookup_id`.
- Produces: UI-ийн шошгууд. Browser тест эдгээрт тулгуурлана:
  - Маягтын гарчиг `ХУР-аас зочны мэдээлэл татах`.
  - Талбарууд `Регистрийн дугаар`, `Зочин ХУР-аас мэдээлэл авахыг зөвшөөрсөн`.
  - Товчнууд `ХУР-аас татах`, `Дахин оролдох`, `Гараар бүртгэх`, `Өөр РД оруулах`.
  - Мессежүүд: `ХУР-аар баталгаажсан: {овог} {нэр} · {огноо} · MN`, `ХУР-д энэ РД-ээр мэдээлэл олдсонгүй.`, `ХУР-тай холбогдож чадсангүй.`

- [ ] **Step 1: Унадаг browser тест бичих** — `tests/browser/reception.cjs`:

1. `:9`: `let requests=[],failure=false,` → `let requests=[],lookups=[],failure=false,`.
2. `:21`: `   else if(tail==='stays/check-in'){` мөрийн **өмнө** шинэ мөр:
   ```js
      else if(tail==='guest-identity/xyp-lookups'){assert.equal(body.consent,true);lookups.push(body);data=body.document_number==='АБ85020311'?{lookup_id:'lookup-miss',status:'NOT_FOUND',expires_at:'2026-09-07T01:15:00Z'}:lookups.length===2?{lookup_id:'lookup-down',status:'UNAVAILABLE',expires_at:'2026-09-07T01:15:00Z'}:{lookup_id:'lookup-ok',status:'FOUND',expires_at:'2026-09-07T01:15:00Z',citizen:{family_name:'Бат',given_name:'Болд',date_of_birth:'1990-01-01',nationality:'MN'}};}
   ```
3. `:23` (check-in route) `assert.equal(body.guest.identity_type,'MN_REG_NO');` → `assert.deepEqual(body.guest,{identity_type:'MN_REG_NO',xyp_lookup_id:'lookup-ok'});`.
4. `:37-38`-ийн хоёр мөрийг (`await page.getByLabel('Овог',...).fill('Бат');...` болон `await page.getByLabel('Нэр',...)...check();`) дараах мөрүүдээр солино:
   ```js
     // RC-DEC-046: ХУР fills Mongolian РД identities; manual entry only after a failed lookup.
     const pull=async number=>{await page.getByLabel('Регистрийн дугаар',{exact:true}).fill(number);await page.getByLabel('Зочин ХУР-аас мэдээлэл авахыг зөвшөөрсөн',{exact:false}).check();await page.getByRole('button',{name:'ХУР-аас татах',exact:true}).click();};
     await pull('АБ85020311');await page.getByText('ХУР-д энэ РД-ээр мэдээлэл олдсонгүй.',{exact:true}).waitFor();await page.getByRole('button',{name:'Гараар бүртгэх',exact:true}).click();
     assert.equal(await page.getByLabel('Баримтын дугаар',{exact:true}).count(),0);assert.equal(await page.getByLabel('Иргэншил',{exact:true}).inputValue(),'MN');
     await page.getByLabel('Овог',{exact:true}).fill('Бат');await page.getByRole('link',{name:'Өрөөнүүд',exact:true}).click();await page.locator('#discard').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>document.activeElement.id),'keep');await page.keyboard.press('Escape');assert.equal(await page.getByLabel('Овог',{exact:true}).inputValue(),'Бат');
     await page.getByRole('button',{name:'Өөр РД оруулах',exact:true}).click();await page.locator('#discard').click();
     await pull('АБ90010111');await page.getByText('ХУР-тай холбогдож чадсангүй.',{exact:true}).waitFor();await page.getByRole('button',{name:'Дахин оролдох',exact:true}).click();
     assert.equal(await page.getByLabel('Регистрийн дугаар',{exact:true}).inputValue(),'АБ90010111');await pull('АБ90010111');
     await page.getByText('ХУР-аар баталгаажсан: Бат Болд · 1990-01-01 · MN',{exact:true}).waitFor();assert.equal(await page.getByLabel('Овог',{exact:true}).count(),0);
     assert.equal(new Set(lookups.map(l=>l.idempotency_key)).size,3);
     await page.getByLabel('Бэлнээр авсан барьцаа (₮)',{exact:false}).fill('60000');await page.getByLabel('Бэлэн барьцааг биечлэн авсан',{exact:false}).check();
   ```

5. Дараагийн хоёр мөрөнд (503 retry-ийн шалгалт) ХУР-аар олдсон үед байхгүй `Овог` талбарын оронд барьцааны талбарыг шалгана:
   - `assert.equal(await page.getByLabel('Овог',{exact:true}).inputValue(),'Бат');` (`failure=true;` мөрөнд) → `assert.equal(await page.getByLabel('Бэлнээр авсан барьцаа (₮)',{exact:false}).inputValue(),'60000');`
   - `document.querySelector('[name=family_name]').form` (`failure=false;` мөрөнд) → `document.querySelector('[name=duration]').form`

`tests/browser/ui-quality.cjs:49` (`...await page.keyboard.press('Escape');assert.equal(await select.evaluate(e=>e===document.activeElement),true);`)-ийн төгсгөлд (бүлэг/validation шалгалт гараар бөглөх маягт дээр явагдана):
```js
await select.selectOption('FOREIGN_PASSPORT');
```

- [ ] **Step 2: Унаж байгааг шалгах**

Run: `node tests/browser/reception.cjs`
Expected: FAIL — `locator.fill: Timeout 30000ms exceeded` (`getByLabel('Регистрийн дугаар')` байхгүй).

- [ ] **Step 3: `errors` map** — `reception.js:11` доторх `GUEST_UNDER_18:'18 нас хүрээгүй зочинд үйлчлэхгүй. Насанд хүрсэн хүнийг үндсэн зочноор бүртгэнэ үү.'`-ийн дараа:

```js
,XYP_CONSENT_REQUIRED:'Зочны зөвшөөрлийг тэмдэглэнэ үү.',XYP_LOOKUP_EXPIRED:'ХУР-ын хайлтын хугацаа дууссан. Дахин татна уу.',XYP_LOOKUP_USED:'Энэ хайлтаар аль хэдийн бүртгэсэн. Дахин татна уу.',XYP_LOOKUP_LIMIT:'Хэт олон ХУР хайлт хийсэн. Түр хүлээгээд дахин оролдоно уу.',XYP_VERIFIED_FIELDS_LOCKED:'ХУР-аар баталгаажсан мэдээллийг өөрчлөх боломжгүй.',XYP_LOOKUP_MISMATCH:'Регистрийн дугаар ХУР-аас хайсан дугаартай таарахгүй байна.',XYP_LOOKUP_REQUIRED:'Эхлээд ХУР-аас мэдээлэл татна уу.',XYP_LOOKUP_NOT_FOUND:'ХУР-ын хайлт олдсонгүй. Дахин татна уу.'
```

- [ ] **Step 4: Check-in маягт** — `reception.js`-ийн `function checkin(parent,booking=null,room=null){`-оос түүний хаалт `  }` хүртэлх (`:529-550`) блокийг бүхэлд нь солино:

```js
  function checkin(parent,booking=null,room=null){
    const kinds=[['MN_REG_NO','Монгол регистр'],['FOREIGN_PASSPORT','Гадаад паспорт'],['OTHER_GOV_ID','Бусад төрийн баримт'],['NO_DOCUMENT','Баримтгүй']];
    const start=node('div');parent.append(start);
    form(start,'Бүртгэлийн төрөл',[select('identity_type','Баримтын төрөл',kinds)],'Зочны мэдээлэл оруулах',async v=>v,{success:async(r,f)=>{f.remove();if(r.identity_type==='MN_REG_NO')xypLookup(start,booking,room);else guestForm(start,booking,room,r.identity_type,null);}});
  }
  // RC-DEC-046: ХУР fills Mongolian РД identities; manual entry only after a failed lookup.
  function xypLookup(start,booking,room,value=''){
    form(start,'ХУР-аас зочны мэдээлэл татах',[field('document_number','Регистрийн дугаар','text',{value}),field('consent','Зочин ХУР-аас мэдээлэл авахыг зөвшөөрсөн','checkbox')],'ХУР-аас татах',
      async v=>({...await api(path('guest-identity/xyp-lookups'),{document_number:v.document_number,consent:v.consent===true,idempotency_key:v.idempotency_key}),document_number:v.document_number}),
      {focus:true,success:async(result,f)=>{f.remove();xypResult(start,booking,room,result);}});
  }
  function xypResult(start,booking,room,result){
    const box=node('div');start.append(box);const again=value=>guard(()=>{box.remove();xypLookup(start,booking,room,value);});
    if(result.status==='FOUND'){const c=result.citizen;box.append(node('p',`ХУР-аар баталгаажсан: ${c.family_name} ${c.given_name} · ${c.date_of_birth} · MN`,'notice'));actions(box).append(btn('Өөр РД оруулах',()=>again('')));guestForm(box,booking,room,'MN_REG_NO',result);return;}
    box.append(node('p',result.status==='NOT_FOUND'?'ХУР-д энэ РД-ээр мэдээлэл олдсонгүй.':'ХУР-тай холбогдож чадсангүй.','notice'));
    const a=actions(box);if(result.status==='UNAVAILABLE')a.append(btn('Дахин оролдох',()=>again(result.document_number)));
    const manual=btn('Гараар бүртгэх',()=>{manual.remove();guestForm(box,booking,room,'MN_REG_NO',result);});a.append(manual,btn('Өөр РД оруулах',()=>again('')));
  }
  function guestForm(start,booking,room,type,lookup){
    const found=lookup?.status==='FOUND',fields=found?[]:[field('family_name','Овог'),field('given_name','Нэр'),field('date_of_birth','Төрсөн огноо','date'),field('nationality','Иргэншил','text',lookup?{value:'MN'}:{})];
    if(!lookup&&type!=='NO_DOCUMENT')fields.push(field('document_number','Баримтын дугаар'));
    if(['FOREIGN_PASSPORT','OTHER_GOV_ID'].includes(type))fields.push(field('issuing_country','Олгосон улс (2 үсэг)'));
    if(type==='FOREIGN_PASSPORT')fields.push(field('expiry_date','Баримтын дуусах огноо','date'));
    if(type==='OTHER_GOV_ID')fields.push(field('document_type','Баримтын төрөл'),field('issuing_authority','Олгосон байгууллага'));
    if(type==='NO_DOCUMENT')fields.push(field('no_document_reason','Баримтгүй шалтгаан','textarea'),field('note','Нэмэлт тайлбар','textarea'));
    if(!booking)fields.push(select('room_id','Өрөө',choices(room?[room]:rooms.filter(r=>r.status==='ACTIVE'&&!r.pending_minibar_change),'room_id','number')),select('kind','Хугацааны төрөл',[['HOURLY','Цагаар'],['NIGHTLY','Хоногоор']]),field('duration','Хугацаа: цагаар бол цаг (0.5 алхам), хоногоор бол хоног','number',{min:0.5,value:1,decimal:true}),select('deposit_channel','Барьцаа авах суваг',[["CASH","Бэлэн"],["FUNDING","Баталгаажсан POS / банкны барьцаа"]]),amount('deposit_amount','Бэлнээр авсан барьцаа (₮)'),field('received','Бэлэн барьцааг биечлэн авсан','checkbox',{optional:true}),select('funding_id','Өмнө баталгаажсан барьцаа',[['','Сонгоогүй'],...choices(overview.funding?.filter(f=>f.state==='CONFIRMED')||[],'funding_id',f=>`${rooms.find(r=>r.room_id===f.room_id)?.number||'Өрөө'} · ${labels[f.channel]} · ${money(f.amount_mnt)}`)],true));
    const depositField=fields.find(f=>f.name==='deposit_amount');if(depositField)depositField.optional=true;
    if(booking?.category_id)fields.push(select('room_id','Оноох өрөө',choices(rooms.filter(r=>r.status==='ACTIVE'&&!r.pending_minibar_change),'room_id',r=>`${r.number} · ${r.category_name}`)));
    fields.push(field('actual_checkin_at','Өмнө ирсэн цаг (Улаанбаатар)','datetime-local',{optional:true}),field('backdate_reason','Өмнө ирсэн цагийн шалтгаан','textarea',{optional:true}));
    const sections={family_name:'Зочны мэдээлэл',room_id:'Өрөө ба байрлах хугацаа',deposit_channel:'Барьцааны мэдээлэл',actual_checkin_at:'Ирсэн цагийн нэмэлт мэдээлэл'};for(const spec of fields)if(sections[spec.name])spec.section=sections[spec.name];
    form(start,booking?'Онлайн захиалгаар зочин бүртгэх':'Шууд ирсэн зочин бүртгэх',fields,'Зочны бүртгэл баталгаажуулах',async v=>{
      const guest={identity_type:type};if(lookup){guest.xyp_lookup_id=lookup.lookup_id;if(!found)guest.document_number=lookup.document_number;}
      for(const key of ['family_name','given_name','date_of_birth','nationality','document_number','issuing_country','expiry_date','document_type','issuing_authority','no_document_reason','note'])if(v[key])guest[key]=v[key];
      const body={guest,idempotency_key:v.idempotency_key};if(v.actual_checkin_at)body.actual_checkin_at=new Date(v.actual_checkin_at+'+08:00').toISOString();if(v.backdate_reason)body.backdate_reason=v.backdate_reason;
      if(!booking){Object.assign(body,{room_id:v.room_id,kind:v.kind,duration_units:stayUnits(v.kind,v.duration)});if(v.deposit_channel==='CASH')body.deposit={channel:'CASH',amount_mnt:v.deposit_amount||0,received:v.received};else body.funding_id=v.funding_id||'';}
      if(booking?.category_id)body.room_id=v.room_id;
      return api(booking?path(`${booking.category_id?'booking-holds':'bookings'}/${enc(booking.booking_id)}/check-in`):path('stays/check-in'),body);
    },{focus:true,success:async(result,f,status)=>{showResult(status,result);f.querySelector('button[type=submit]').hidden=true;await reloadOverview();status.append(btn('Байрлалтыг нээх',()=>openStay({stay_id:result.stay_id,room_id:result.room_id},start)));}});
  }
```

- [ ] **Step 5: Давж байгааг шалгах**

Run: `node tests/browser/reception.cjs && node tests/browser/ui-quality.cjs && node tests/browser/daily-workflows.cjs && PYTHONPATH=src .venv/bin/python tests/browser/validate_requests.py artifacts/reception-requests.json`
Expected: гурван suite "…passed". Validator `… browser commands match actual API models` гэж хэвлэнэ (хайлтын 3 хүсэлт `XypLookupInput`-д таарна).

- [ ] **Step 6: Commit**

```bash
git add src/prsystem/static/reception.js tests/browser/reception.cjs tests/browser/ui-quality.cjs
git commit -m "feat(reception): ХУР lookup step for Mongolian РД check-in

RC-DEC-046: Reception enters the РД with the guest's consent and pulls the
identity from ХУР; a FOUND identity is shown read-only and sent only as
xyp_lookup_id. NOT_FOUND/UNAVAILABLE offer retry or manual entry for the
same РД. Other identity types keep the manual form.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 5: Development ба UI review-д mock ХУР, баримт

**Files:**
- Modify: `src/prsystem/development.py:32-50`, `tests/ui_review_support.py:42-110`, `scripts/ui_review.py:115`, `tests/test_ui_review.py` (Task 3-ын lookup хэсэг)
- Modify: `docs/02-reception-system-scope.md:31` ба RC-DEC-046, `docs/37-development-mocks.md`, `docs/39-walkin-check-in.md:25`, `docs/76-ui-review-session.md` (3-р хэсэг Reception)
- Modify: `docs/superpowers/specs/2026-09-28-xyp-identity-autofill-design.md` §5, §7 (дээрх 2 шийдвэр)

**Interfaces:**
- Consumes: `MockXypGateway` (Task 1), `create_app(..., xyp_gateway=...)` (Task 2).
- Produces: `ReviewSession` app нь mock ХУР-тай. `АБ90010211` → FOUND, `АБ85020311` → NOT_FOUND, `ЖЖ80010100` → UNAVAILABLE.

- [ ] **Step 1: Унадаг тест бичих** — `tests/test_ui_review.py` Task 3-ын хэсгийг FOUND замаар солино:

```python
            lookup = fixture.assert_status(client.post(root+'guest-identity/xyp-lookups', headers=reception,
                json=dict(document_number='АБ90010211', consent=True, idempotency_key=uuid4().hex)), 201)
            stay = fixture.assert_status(client.post(root+'stays/check-in', headers=reception, json=dict(
                room_id=fixture.room, kind='NIGHTLY', duration_units=1,
                guest=dict(identity_type='MN_REG_NO',xyp_lookup_id=lookup['lookup_id'],family_name='Туршилт',given_name='Зочин',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),
```
→
```python
            lookup = fixture.assert_status(client.post(root+'guest-identity/xyp-lookups', headers=reception,
                json=dict(document_number='АБ90010211', consent=True, idempotency_key=uuid4().hex)), 201)
            self.assertEqual((lookup['status'], lookup['citizen']['family_name']), ('FOUND', 'Туршилт'))
            stay = fixture.assert_status(client.post(root+'stays/check-in', headers=reception, json=dict(
                room_id=fixture.room, kind='NIGHTLY', duration_units=1,
                guest=dict(identity_type='MN_REG_NO',xyp_lookup_id=lookup['lookup_id']),
```

- [ ] **Step 2: Унаж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_ui_review -v 2>&1 | tail -5`
Expected: FAIL — `AssertionError: Tuples differ: ('UNAVAILABLE', …` эсвэл `KeyError: 'citizen'` (review app-д адаптер байхгүй).

- [ ] **Step 3: Review fixture ба development** — `tests/ui_review_support.py`:
   1. `from guest_finance_support import GuestFinanceCase`-ийн дараа:
      ```python
          from tempfile import TemporaryDirectory
          from prsystem.mock_providers import MockStore, MockXypGateway
      ```
   2. `vault = IdentityVault(...)` мөрийн дараа:
      ```python
              providers = TemporaryDirectory(); fixture.addCleanup(providers.cleanup)
              xyp = MockXypGateway(MockStore(providers.name + '/xyp.sqlite3', environment='development'))
              xyp.add_citizen('АБ90010211', 'Туршилт', 'Зочин', '1990-01-02')  # АБ85020311 not found; ЖЖ80010100 outage
      ```
   3. `create_app(... runtime_mode='development', mock_stay_finance=True)` → `create_app(... runtime_mode='development', mock_stay_finance=True, xyp_gateway=xyp)`.

`src/prsystem/development.py` (`create_app`):
   1. `from prsystem.guest_identity import IdentityVault`-ийн дараа:
      ```python
          from prsystem.mock_providers import MockXypGateway
          xyp = MockXypGateway(store)
          xyp.add_citizen('АБ90010211', 'Туршилт', 'Зочин', '1990-01-02')
      ```
   2. `staff_app(...)` дуудлагын `contact_notice_gateway=MockContactNoticeGateway(store))` → `contact_notice_gateway=MockContactNoticeGateway(store),xyp_gateway=xyp)`.

`scripts/ui_review.py` — `print('101: зочин бүртгэхэд бэлэн. 201: цэвэрлэгчид оноосон ажил.')`-ийн дараа:
```python
            print('ХУР (mock): АБ90010211 → олдоно · АБ85020311 → олдохгүй · ЖЖ80010100 → ХУР ажиллахгүй')
```

- [ ] **Step 4: Давж байгааг шалгах**

Run: `PYTHONPATH=src:tests .venv/bin/python -m unittest tests.test_ui_review -v 2>&1 | tail -3`
Expected: OK.

- [ ] **Step 5: Баримт**
   - **`docs/02-reception-system-scope.md:31`:** мөрийн төгсгөлд нэмнэ: ` Урсгал, зөвшөөрөл, хязгаар: RC-DEC-046.`
   - **RC-DEC-045-ын дараа** (`## 8. Хаагдсан canonical scope`-ийн өмнө):
     ```markdown
     ### RC-DEC-046 — ХУР-аас үндсэн зочны мэдээлэл татах

     - **Төлөв:** Батлагдсан (2026-09-28, захиалагчийн шийдвэр)
     - **Шийдвэр:** `MN_REG_NO`-д Reception РД оруулж, зочны зөвшөөрлийг тэмдэглээд ХУР-аас овог, нэр, төрсөн огноог татна. Сервер үр дүнг шифрлэж 15 минут хүчинтэй, нэг удаагийн хайлтын дугаартай хадгална; check-in зөвхөн тэр дугаараар `XYP_VERIFIED` identity үүсгэнэ, browser нэр өөрчлөх боломжгүй. ХУР олдоогүй/ажиллаагүй үед л тухайн РД-ээр гараар бүртгэнэ (`MANUAL` + шалтгаан, RC-DEC-007). Хязгаар: ажилтан тутамд 10 минутад 20 хайлт. Бодит ХУР адаптер EXT-01-ийн дараа; одоо development/test mock. Design: `docs/superpowers/specs/2026-09-28-xyp-identity-autofill-design.md`.
     ```
   - **`docs/39-walkin-check-in.md:25`:** `XYP is deferred; current check-in accepts manually entered identity.`-ийг `MN_REG_NO check-in requires a server-held ХУР lookup (RC-DEC-046, mock adapter until EXT-01); manual identity entry is accepted only after a NOT_FOUND/UNAVAILABLE lookup for the same РД.` болгоно.
   - **`docs/37-development-mocks.md`:** `XYP-гүй үед manual primary guest entry ашиглана; XYP_VERIFIED болон Police match result зохиохгүй.`-ийг `Development/UI review нь MockXypGateway ашиглана (АБ90010211 олдоно, АБ85020311 олдохгүй, ЖЖ80010100 ХУР ажиллахгүй); production-д адаптергүй бол хайлт UNAVAILABLE тул гараар бүртгэнэ. Police match result зохиохгүй.` болгоно.
   - **`docs/76-ui-review-session.md`** Reception-ий 2-р даалгавар (`2. Жишээ зочин: овог ...`)-ийг солино:
     ```markdown
     2. Баримтын төрөл "Монгол регистр"-ийг сонгож `АБ90010211` оруулна; зочны зөвшөөрлийг
        тэмдэглээд **ХУР-аас татах** дарна. Овог, нэр, төрсөн огноо "ХУР-аар баталгаажсан"
        гэж засах боломжгүй харагдана. `АБ85020311` олдохгүй, `ЖЖ80010100` ХУР ажиллахгүй
        үеийг загварчилна — тэр үед л **Гараар бүртгэх** боломжтой. Бүгд хийсвэр тестийн өгөгдөл.
     ```
   - **Spec** §5: `xyp_lookup_receipt` хүснэгтийн SQL-ийг устгаад доор нь нэмнэ: `Idempotency: одоогийн staff_command_receipt; receipt-д зөвхөн {lookup_id}.` §7-ийн "Одоогийн тестүүд" мөрийг: `WalkInCase.checkin/with_xyp нь хайлт хийж xyp_lookup_id дамжуулна; адаптергүй тестийн app-д UNAVAILABLE тул гараар бүртгэх замаар ажиллана; FOUND замыг test_xyp_lookup шалгана.` болгоно.

- [ ] **Step 6: Commit**

```bash
git add src/prsystem/development.py tests/ui_review_support.py scripts/ui_review.py tests/test_ui_review.py docs/02-reception-system-scope.md docs/37-development-mocks.md docs/39-walkin-check-in.md docs/76-ui-review-session.md docs/superpowers/specs/2026-09-28-xyp-identity-autofill-design.md
git commit -m "feat(xyp): mock ХУР in development and UI review; record RC-DEC-046

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BvA5ZCcsBiQt9EEjQeU8Xd"
```

---

### Task 6: Бүрэн шалгалт ба push

- [ ] **Step 1: Domain-only (CI `test` job)**

Run: `env -u PRSYSTEM_TEST_ADMIN_DSN PYTHONPATH=src .venv/bin/python -m unittest discover -s tests 2>&1 | tail -3`
Expected: `OK (skipped=…)`. `test_xyp_domain` psycopg-гүй ажиллана.

- [ ] **Step 2: PostgreSQL 4 shard, 0 skip**

```bash
mkdir -p artifacts
for i in 0 1 2 3; do .venv/bin/python -m scripts.run_postgres_shard --index $i --count 4 > artifacts/xyp-shard-$i.log 2>&1 & done; wait
for i in 0 1 2 3; do grep -E '^Ran |^OK|^FAILED' artifacts/xyp-shard-$i.log; done; grep -h 'ERROR: .* skipped' artifacts/xyp-shard-*.log
```
Expected: shard бүр `OK`. Skip мөр гарахгүй. `Discovered 945+N tests`, N = шинэ тест: domain 6 + lookup 6 + binding 8 = 20 → 965.

- [ ] **Step 3: Browser 25 suite + payload validation + design** (shard-ууд дууссаны дараа ажиллуулна; CPU ачааллын race-аас сэргийлнэ)

```bash
for s in staff restaurant reception booking minibar minibar-templates operation subscription-contact minibar-partial minibar-reconciliation minibar-archive minibar-rollout minibar-batches minibar-guest minibar-refill minibar-next-stay minibar-exception minibar-lifecycle minibar-adjustments minibar-paid-corrections minibar-variance minibar-shortages minibar-billing daily-workflows ui-quality; do node tests/browser/$s.cjs > artifacts/browser-$s.log 2>&1 || echo "FAILED $s"; done
for f in artifacts/*-requests.json; do PYTHONPATH=src .venv/bin/python tests/browser/validate_requests.py $f >/dev/null || echo "INVALID $f"; done
.venv/bin/python scripts/export_ui_tokens.py --check && npx --yes -p @google/design.md designmd lint DESIGN.md | tail -3
```
Expected: `FAILED`/`INVALID` мөр гарахгүй. Token check exit 0. Lint 0 алдаа.

- [ ] **Step 4: Push**

```bash
git push -u origin final
```
Expected: push амжилттай (network алдаа гарвал 2/4/8/16 секундийн зайтай 4 хүртэл удаа дахин оролдоно).
