# ХУР-аас үндсэн зочны мэдээлэл автоматаар бөглөх — Design

**Огноо:** 2026-09-28
**Төлөв:** Захиалагчтай хэсэг хэсгээр тохирсон; бичмэл spec хянагдаж байна.
**Холбоотой шаардлага:** `docs/02:31` (XYP_VERIFIED/MANUAL), `RC-DEC-007` (ХУР-ын нөөц ажиллагаа), `RC-DEC-045` (18 хүрээгүй үндсэн зочинд үйлчлэхгүй), `docs/00` EXT-01 (ХУР гэрээ/техникийн нөхцөл), EXT-08 (хувийн мэдээлэл).

## 1. Зорилго

Reception Монгол РД-тэй үндсэн зочны **овог, нэр, төрсөн огноо**-г гараар бичихгүй. РД оруулахад ХУР-аас эдгээрийг татаж, серверт `XYP_VERIFIED` эх сурвалжтай хадгална. ХУР ажиллахгүй эсвэл мэдээлэл олдохгүй үед л гараар бүртгэнэ (`MANUAL` + шалтгаан, RC-DEC-007).

**Амжилтын шалгуур:**

- ХУР ажиллаж, мэдээлэл олдсон үед Reception нэр/огноог өөрчилж чадахгүй; browser нэр илгээсэн ч сервер хүлээн авахгүй.
- ХУР ажиллаж байхад "гараар бүртгэх" зам нээгдэхгүй: гараар бүртгэхэд тухайн РД-ийн бүтэлгүй ХУР хайлтын нотолгоо шаардана.
- Бодит ХУР холбогдоход зөвхөн адаптер нэмнэ; domain, API, UI өөрчлөгдөхгүй.

## 2. Хамрах хүрээ

**Орно:**

- Зөвхөн `MN_REG_NO` identity type. `FOREIGN_PASSPORT`, `OTHER_GOV_ID`, `NO_DOCUMENT` одоогийнхоор гараар.
- ХУР-аас авах талбар: `family_name` (овог), `given_name` (нэр), `date_of_birth`. `nationality` нь РД-тэй бол `MN` гэж сервер тавина.
- Walk-in болон онлайн захиалгын check-in (ижил `PrimaryGuestInput`, ижил `StayService.check_in`).
- Development/test mock адаптер, UI review fixture.

**Орохгүй:**

- Бодит ХУР адаптер (EXT-01: service, field list, VPN/сертификат/IP, гэрээ шийдэгдээгүй).
- Иргэний OTP/хурууны хээгээр зөвшөөрөл авах (EXT-01 шийдэгдсэний дараа port-д нэмнэ).
- Хаяг, зураг, ургийн овог гэх мэт нэмэлт талбар.
- Хугацаа дууссан, ашиглагдаагүй хайлтын үр дүнг цэвэрлэх worker (retention P1-09 нээлттэй; §9).
- Police portal-ын ХУР хайлт (`docs/13`), бүртгэлийн засвар.

## 3. Reception-ий урсгал

Баримтын төрөл **"Монгол регистр"** үед маягт хоёр алхамтай:

1. **Хайлт:** талбарууд — `РД`, чагт **"Зочин ХУР-аас мэдээлэл авахыг зөвшөөрсөн"** (заавал). Товч **"ХУР-аас татах"**. Овог/нэр/огнооны оролтын талбар энэ үед байхгүй.
2. **Үр дүн:**
   - **Олдсон (`FOUND`):** "ХУР-аар баталгаажсан" шошготой, засах боломжгүй жагсаалт — овог, нэр, төрсөн огноо, иргэншил MN. Товч **"Өөр РД оруулах"** (1-р алхам руу буцна). Цааш өрөө/хугацаа/барьцааны одоогийн маягт.
   - **Олдоогүй (`NOT_FOUND`):** "ХУР-д энэ РД-ээр мэдээлэл олдсонгүй." Товч **"Гараар бүртгэх"** → овог, нэр, төрсөн огноо, иргэншлийн талбар нээгдэнэ; РД засах боломжгүй (хайсан РД).
   - **Ажиллаагүй (`UNAVAILABLE`):** "ХУР-тай холбогдож чадсангүй." Товч **"Дахин оролдох"** (шинэ хайлт) ба **"Гараар бүртгэх"** (дээрхтэй ижил).
3. Check-in хүсэлт:
   - `FOUND`: `guest = {identity_type:'MN_REG_NO', xyp_lookup_id}` — нэр, огноо, РД илгээхгүй.
   - `NOT_FOUND`/`UNAVAILABLE`: `guest = {identity_type:'MN_REG_NO', xyp_lookup_id, document_number, family_name, given_name, date_of_birth, nationality}`.
4. Алдааны мессежүүд (UI `errors` map):
   - `XYP_CONSENT_REQUIRED`: "Зочны зөвшөөрлийг тэмдэглэнэ үү."
   - `XYP_LOOKUP_EXPIRED`: "ХУР-ын хайлтын хугацаа дууссан. Дахин татна уу."
   - `XYP_LOOKUP_USED`: "Энэ хайлтаар аль хэдийн бүртгэсэн. Дахин татна уу."
   - `XYP_LOOKUP_LIMIT`: "Хэт олон ХУР хайлт хийсэн. Түр хүлээгээд дахин оролдоно уу."
   - `XYP_VERIFIED_FIELDS_LOCKED`: "ХУР-аар баталгаажсан мэдээллийг өөрчлөх боломжгүй."

Нас: ХУР-ын төрсөн огноогоор check-in өдөр 18 хүрээгүй бол `GUEST_UNDER_18` (RC-DEC-045).

## 4. Сервер

### 4.1 ХУР port (`src/prsystem/xyp.py`)

```python
class XypUnavailable(Exception): ...   # сүлжээ, timeout, тохируулаагүй, хариу буруу
class XypNotFound(Exception): ...

class XypGateway(Protocol):
    def citizen(self, document_number: str) -> dict: ...
    # → {'family_name': str, 'given_name': str, 'date_of_birth': 'YYYY-MM-DD'}
    #   эсвэл XypNotFound / XypUnavailable
```

- Адаптерийн хариуг шалгана: гурван талбар заавал, `text()`/`calendar_date()` дүрмээр. Төрсөн огноо нь РД-д кодлогдсон огноотой таарахгүй бол хариуг хүлээн авахгүй → `UNAVAILABLE` (шалтгаан `INVALID_EVIDENCE`).
- Production-д адаптер тохируулаагүй (`xyp_gateway=None`) бол хайлт бүр `UNAVAILABLE` (шалтгаан `NOT_CONFIGURED`) — гараар бүртгэх урсгал одоогийнх шиг ажиллана.

### 4.2 Хайлт — `POST /hotels/{tenant}/guest-identity/xyp-lookups`

Request: `{document_number: str, consent: true, idempotency_key: str}` (`extra='forbid'`, strict).
Response 201: `{lookup_id, status: FOUND|NOT_FOUND|UNAVAILABLE, expires_at, citizen?: {family_name, given_name, date_of_birth, nationality:'MN'}}` (`citizen` зөвхөн `FOUND` үед).

Дараалал:

1. Transaction 1 (богино): нэвтрэлт; эрх = check-in-тэй ижил `ShiftService._reception(conn, tenant, actor, action=Action.CHECK_IN)` (RECEPTION role, идэвхтэй membership, subscription gate, security suspend). Нээлттэй ээлж шаардахгүй (хайлт мөнгө хөдөлгөхгүй); check-in өөрөө ээлж шаардсан хэвээр. `consent is True` биш бол `XYP_CONSENT_REQUIRED` (422). РД-ийн бүтцийг `MN_REG_NO` дүрмээр шалгана (422 `INVALID_GUEST_IDENTITY`). Idempotency: ижил `(tenant, actor, key)` өмнө нь байвал хадгалсан хариуг буцаана (ХУР-ыг дахин дуудахгүй); өөр command бол `IDEMPOTENCY_CONFLICT`. Хязгаар: тухайн ажилтны сүүлийн 10 минутын хайлт ≥ 20 бол `XYP_LOOKUP_LIMIT` (429).
2. ХУР дуудлага **DB transaction-ээс гадна**, timeout 10 секунд.
3. Transaction 2: `xyp_lookup` мөр болон command receipt-ийг бичнэ; audit event `XYP_LOOKUP` (status, reason; РД/нэр байхгүй).

### 4.3 Check-in-ий өөрчлөлт

`PrimaryGuestInput`: `xyp_lookup_id: str | None` нэмэгдэнэ; `family_name`, `given_name`, `date_of_birth`, `nationality`, `document_number` optional болно (identity type тус бүрийн заавал талбарыг domain шалгана — одоогийн `validate_identity` хэвээр).

`MN_REG_NO` үед, check-in transaction дотор:

1. `xyp_lookup_id` байхгүй → `XYP_LOOKUP_REQUIRED` (422).
2. Мөрийг `FOR UPDATE` уншина: өөр tenant / олдохгүй → `XYP_LOOKUP_NOT_FOUND` (404); `stay_id` бөглөгдсөн → `XYP_LOOKUP_USED` (409); `expires_at <= now` → `XYP_LOOKUP_EXPIRED` (409).
3. `FOUND`: request-д `family_name/given_name/date_of_birth/nationality/document_number`-ийн аль нэг байвал `XYP_VERIFIED_FIELDS_LOCKED` (422). Identity-г хадгалсан үр дүнгээс бүтээнэ (`provenance='XYP_VERIFIED'`, `nationality='MN'`), насны дүрэм мөрдөнө.
4. `NOT_FOUND`/`UNAVAILABLE`: гараар өгсөн талбаруудыг `validate_identity`-ээр шалгана; `document_number`-ийн fingerprint нь хайлтын fingerprint-тэй тэнцүү биш бол `XYP_LOOKUP_MISMATCH` (422). `provenance='MANUAL'`, identity envelope-д `xyp_fallback: NOT_FOUND|UNAVAILABLE` (+ reason) хадгална.
5. Амжилттай бол `xyp_lookup.stay_id = stay` (нэг удаагийн). Idempotent replay нь хадгалсан check-in хариуг буцаана.

Бусад identity type-д `xyp_lookup_id` илгээвэл `INVALID_GUEST_IDENTITY` (422).

### 4.4 Аюулгүй байдал ба хувийн мэдээлэл

- РД-ийг ил хадгалахгүй: `lookup_token = vault.fingerprint('guest-exact-identity', ['MN_REG_NO','MN',РД])` (одоогийн exact-identity namespace-тэй ижил).
- ХУР-ын үр дүнг `vault.seal(result, tenant, lookup_id, 'xyp-lookup')`-ээр шифрлэнэ.
- Зөвшөөрөл: `consent_at` (server time) ба `actor_id` мөрөнд.
- Log/audit/event-д РД, нэр, огноо орохгүй.
- Хязгаар 20 хайлт / 10 минут / ажилтан (тохиргоо биш, код дахь тогтмол).

## 5. Өгөгдөл — migration `079_xyp_lookup.sql`

```sql
CREATE TABLE prsystem.xyp_lookup (
 tenant_id text NOT NULL, id text NOT NULL, actor_id text NOT NULL,
 lookup_token text NOT NULL,
 status text NOT NULL CHECK (status IN ('FOUND','NOT_FOUND','UNAVAILABLE')),
 reason text CHECK (reason IN ('NOT_CONFIGURED','TIMEOUT','PROVIDER_ERROR','INVALID_EVIDENCE')),
 envelope jsonb,                                  -- зөвхөн FOUND үед
 consent_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 stay_id text,
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 FOREIGN KEY (tenant_id,stay_id) REFERENCES prsystem.stay(tenant_id,id),
 CHECK (expires_at = created_at + interval '15 minutes'),
 CHECK ((status='FOUND') = (envelope IS NOT NULL)),
 CHECK ((status='UNAVAILABLE') = (reason IS NOT NULL))
);
CREATE INDEX xyp_lookup_actor_recent ON prsystem.xyp_lookup (tenant_id,actor_id,created_at);
CREATE TABLE prsystem.xyp_lookup_receipt (
 tenant_id text NOT NULL, actor_id text NOT NULL, key text NOT NULL,
 command jsonb NOT NULL, lookup_id text NOT NULL,
 PRIMARY KEY (tenant_id,actor_id,key),
 FOREIGN KEY (tenant_id,lookup_id) REFERENCES prsystem.xyp_lookup(tenant_id,id)
);
-- stay_id-г зөвхөн NULL → утга руу нэг удаа; бусад багана өөрчлөгдөхгүй; DELETE хориотой.
-- ENABLE + FORCE ROW LEVEL SECURITY, tenant_scope policy (034-ийн загвараар) хоёр хүснэгтэд.
ALTER TABLE prsystem.stay_guest_identity DROP CONSTRAINT stay_guest_identity_provenance_check;
ALTER TABLE prsystem.stay_guest_identity ADD CONSTRAINT stay_guest_identity_provenance
  CHECK (provenance IN ('MANUAL','XYP_VERIFIED'));
```

`stay_guest_identity_provenance_check` нь `018`-ийн inline CHECK-ийн PostgreSQL-ийн үүсгэсэн нэр (migrate хийсэн DB-ийн `pg_constraint`-оос баталгаажуулсан). Хуучин migration засахгүй.

`stays.py`: `stay_guest_identity`-д `provenance`-ийг identity-гээс авч бичнэ (одоо `'MANUAL'` hardcode).

## 6. Mock ба development

`src/prsystem/mock_providers.py`-д `MockXypGateway(store)` (`is_mock = True`):

- SQLite `mock_citizen(document_number PRIMARY KEY, family_name, given_name, date_of_birth)`; `add_citizen(...)`, `set_available(bool)`.
- `citizen(РД)`: `set_available(False)` эсвэл тусгай РД `ЖЖ80010100` → `XypUnavailable`; жагсаалтад байвал үр дүн; үгүй бол `XypNotFound`.
- `create_app(..., xyp_gateway=None)`: mock port бол `require_development_database` (одоогийн mock хамгаалалт).
- Development factory болон UI review fixture seed:
  - `АБ90010211` → Туршилт / Зочин / 1990-01-02 (олдсон)
  - `АБ85020311` → жагсаалтад байхгүй (олдоогүй; гараар бүртгэхэд DOB 1985-02-03)
  - `ЖЖ80010100` → ХУР ажиллахгүй
  - `scripts/ui_review` эдгээрийг terminal-д хэвлэнэ; `docs/76`-ийн Reception даалгаврыг шинэ урсгалаар шинэчилнэ.

## 7. Тест

**Шинэ `tests/test_xyp_lookup.py`** (PostgreSQL, API-аар, `MockXypGateway` inject):

1. Олдсон → check-in `XYP_VERIFIED`, identity envelope-ийн нэр/огноо ХУР-ынх, nationality MN; request-д нэр илгээвэл 422 `XYP_VERIFIED_FIELDS_LOCKED`.
2. Олдоогүй → гараар бүртгэл `MANUAL` + `xyp_fallback=NOT_FOUND`; өөр РД-ээр → 422 `XYP_LOOKUP_MISMATCH`.
3. `set_available(False)` → `UNAVAILABLE`, гараар бүртгэл `MANUAL` + `UNAVAILABLE`.
4. `MN_REG_NO` хайлтгүй → 422 `XYP_LOOKUP_REQUIRED`.
5. Хугацаа дууссан (owner fixture-ээр `created_at/expires_at` хуучруулна) → 409; хоёр дахь ашиглалт → 409 `XYP_LOOKUP_USED`; өөр tenant-ын lookup → 404.
6. `consent:false` → 422; 21 дэх хайлт 10 минутад → 429; idempotent retry ХУР-ыг дахин дуудахгүй (mock call count).
7. Reception биш (Cleaner, Hotel Admin дангаараа) → 403.
8. ХУР-ын DOB 18 хүрээгүй → check-in 422 `GUEST_UNDER_18`.
9. Production (`xyp_gateway=None`) → `UNAVAILABLE`/`NOT_CONFIGURED`, гараар бүртгэл ажиллана.
10. RLS: өөр tenant scope-оос `xyp_lookup` харагдахгүй; audit/event болон `xyp_lookup`-ийн ил баганад РД/нэр байхгүй.
11. ХУР-ын DOB РД-тэй зөрвөл `UNAVAILABLE`/`INVALID_EVIDENCE`.

**Domain unit:** `xyp.py`-ийн хариу шалгалт (дутуу талбар, буруу огноо, DOB/РД зөрүү).

**Одоогийн тестүүд:** `tests/walkin_support.py` `WalkInCase.checkin` нь `MN_REG_NO` зочинд эхлээд mock ХУР-аас хайлт хийж `xyp_lookup_id` дамжуулна (seed-д `АБ90010211`). Тестийн бие өөрчлөгдөхгүй.

**Browser:** `tests/browser/reception.cjs` — хайлтын route mock: олдсон үед нэрийн оролтын талбар байхгүй, засах боломжгүй жагсаалт харагдана, check-in payload-д `xyp_lookup_id` байж нэр байхгүй; ажиллаагүй үед "Дахин оролдох"/"Гараар бүртгэх". MN_REG_NO check-in хийдэг бусад suite-д хайлтын route нэмнэ. `validate_requests.py` шинэ endpoint-ийг шалгана.

**Эцсийн шалгалт:** `run_postgres_shard` 4 shard 0 skip, 25 browser suite, `validate_requests.py`, token check, design lint.

## 8. Баримт

- `docs/02:31` — урсгалыг энэ spec-ийн дагуу тодруулна; шинэ `RC-DEC-046` (2026-09-28): зөвшөөрлийг Reception тэмдэглэнэ; хайлтын дугаараар холбох; гараар бүртгэл зөвхөн бүтэлгүй хайлтын дараа; 20/10 мин хязгаар; 15 мин хүчинтэй.
- `docs/37` (dev mock), `docs/39` (XYP deferred мөр), `docs/76` (UI review даалгавар) шинэчилнэ.

## 9. Нээлттэй (энэ ажлын хүрээнээс гадуур)

- EXT-01: бодит service, field list, иргэний зөвшөөрлийн арга, VPN/сертификат — ирэхэд адаптер + зөвшөөрлийн port.
- P1-09/EXT-08: `FOUND` боловч check-in болоогүй хайлтын үр дүнг хэр удаан хадгалах, цэвэрлэх worker.
