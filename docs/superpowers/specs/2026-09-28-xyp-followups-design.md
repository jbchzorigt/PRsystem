# ХУР lookup-ийн дагалдах засварууд — Design

- **Огноо:** 2026-09-28
- **Төлөв:** Хэлэлцэж батласан (3 хэсэг), spec хянуулахаар
- **Эх сурвалж:** ХУР autofill ажлын (`docs/superpowers/specs/2026-09-28-xyp-identity-autofill-design.md`, RC-DEC-046) эцсийн review-ийн хойшлуулсан 10 жижиг асуудал ба захиалагчийн 2 шийдвэр
- **Захиалагчийн шийдвэр:**
  1. ХУР холбогдоогүй (NOT_CONFIGURED) үед шалтгааныг харуулж шууд гараар бүртгэнэ.
  2. Хязгаарын slot-ыг ХУР дуудахаас өмнө захиалахыг EXT-01-тэй хамт хийнэ.

## 1. Зорилго

ХУР-ын урсгалыг production-д ашиглахад бэлэн болгох:
- бодит адаптергүй үед ч Reception-ийг төөрөгдүүлэхгүй байх;
- адаптер гацах эсвэл эвдрэх үед хүсэлт хүлээлгэхгүй, оношлох мөр үлдээх;
- browser-ийн илгээсэн identity-г серверийн дүрэмтэй бүрэн нийцүүлэх;
- баримтыг бодит schema-тай тааруулах.

## 2. Хамрах хүрээ

**Орно:** §3–§7.

**Орохгүй:**
- Slot захиалга (ХУР дуудахаас өмнө хязгаарын эрх захиалах). EXT-01-ийн шаардлагад бичнэ (§7.4).
- Ашиглагдаагүй хайлтын өгөгдлийг хадгалах хугацаа (P1-09/EXT-08).
- Бодит ХУР адаптер (EXT-01).

## 3. Сервер

### 3.1 Шалтгааныг буцаах (NOT_CONFIGURED)

`XypLookups.view()` нь `status='UNAVAILABLE'` үед `reason`-ийг хариунд нэмнэ: `NOT_CONFIGURED`, `TIMEOUT`, `PROVIDER_ERROR` эсвэл `INVALID_EVIDENCE`. Хувийн мэдээлэл агуулахгүй. Бусад төлөвт `reason` талбар байхгүй. Replay нь хадгалсан мөрөөс ижил хариуг буцаана.

### 3.2 Хязгаар ХУР руу явсан хайлтыг л тоолно

- `gateway is None` бол ХУР руу дуудлага явахгүй тул `lookup()` хязгаарыг шалгахгүй.
- `limit()` тоололд `reason IS DISTINCT FROM 'NOT_CONFIGURED'` нөхцөл нэмнэ.
- Хоёр transaction-ы дахин тоолол (өмнөх засвар) хэвээр.

### 3.3 10 секундийн timeout

- Модулийн түвшний `ThreadPoolExecutor(max_workers=8, thread_name_prefix='xyp')`.
- `ask()` адаптерын `citizen(number)`-ийг pool-д илгээж `future.result(timeout=TIMEOUT_SECONDS)`-ээр хүлээнэ.
- `TimeoutError` бол `future.cancel()` (дараалалд байвал цуцлагдана) хийгээд `('UNAVAILABLE','TIMEOUT',None)` буцаана. Ажиллаж буй thread-ийг зогсоохгүй. Pool дүүрсэн бол хүсэлт дараалалд хүлээх боловч нийт хүлээлт 10 секундэд багтана.
- Бусад exception-ийн mapping одоогийнхоор: `XypNotFound` → NOT_FOUND, `XypUnavailable` → өөрийн reason, бусад → PROVIDER_ERROR.
- `TIMEOUT_SECONDS`-ийг `xyp.py`-аас import хийнэ. Тест `prsystem.xyp_lookups.TIMEOUT_SECONDS`-ийг patch хийнэ.

### 3.4 Адаптерын алдааны мөр

Урьдчилан тооцоогүй exception (catch-all) гарвал `XYP_LOOKUP` operational event-ийн `details`-д `error: type(exc).__name__` нэмнэ. Мессеж текст, РД, traceback бичихгүй. `XypNotFound(document_number)` нь РД агуулдаг тул тэр салаанд юу ч нэмэхгүй. Бусад тохиолдолд `details` нь `{status, reason}` хэвээр.

### 3.5 FOUND үед илүү талбар

FOUND хайлтаар check-in хийхэд `guest` дотор `identity_type` ба `xyp_lookup_id`-аас өөр, `None` биш аливаа талбар ирвэл `XYP_VERIFIED_FIELDS_LOCKED` (422) буцаана. Жишээ нь `note` эсвэл `issuing_country`. Энэ нь одоогийн `MANUAL_FIELDS` жагсаалтыг орлоно. Гар бүртгэлийн зам (`validate_identity`) өөрчлөгдөхгүй.

### 3.6 Бүтэц

- `xyp.bind()`-ийг `stays.py` руу `StayService._xyp_identity(conn, tenant, guest, on_date)` болгож шилжүүлнэ. Логик нь 3.5-аас бусад тохиолдолд хэвээр.
- `_guest_identity` доторх lazy import арилна.
- `xyp.py`-д port (`XypGateway`, `XypUnavailable`, `XypNotFound`), `REASONS`, `TIMEOUT_SECONDS`, `citizen_evidence` л үлдэнэ.
- `xyp.py` SQL, `scope`, `validate_identity` import хийхгүй. psycopg-гүй CI domain job-д ажилласаар байна.

## 4. API

- `POST /hotels/{tenant}/guest-identity/xyp-lookups` хариу: `{lookup_id, status, expires_at, citizen?, reason?}`. `reason` зөвхөн UNAVAILABLE үед байна.
- Шинэ алдааны код байхгүй. `XYP_VERIFIED_FIELDS_LOCKED` (422) аль хэдийн map хийгдсэн.

## 5. Reception UI (`static/reception.js`)

### 5.1 Хайлтын хариу

| Хариу | Мессеж | "Дахин оролдох" | Гар бүртгэл |
|---|---|---|---|
| NOT_FOUND | ХУР-д энэ РД-ээр мэдээлэл олдсонгүй. | — | "Гараар бүртгэх" товч |
| UNAVAILABLE/NOT_CONFIGURED | ХУР холбогдоогүй байна. Гараар бүртгэнэ үү. | — | Маягт шууд нээгдэж, курсор маягтын гарчиг дээр очно |
| UNAVAILABLE/TIMEOUT | ХУР хугацаандаа хариулсангүй. | байна | "Гараар бүртгэх" товч |
| UNAVAILABLE/PROVIDER_ERROR | ХУР-тай холбогдож чадсангүй. | байна | "Гараар бүртгэх" товч |
| UNAVAILABLE/INVALID_EVIDENCE | ХУР-ын мэдээлэл РД-тэй таарахгүй байна. | — | "Гараар бүртгэх" товч |

- `reason` ирээгүй UNAVAILABLE хариу (хуучин сервер) PROVIDER_ERROR шиг харагдана.
- Бүх тохиолдолд "Өөр РД оруулах" товч байна.
- Маягт шууд нээгдэхгүй тохиолдолд курсор мессеж дээр очно.

### 5.2 Хугацаа дууссан хайлтыг дахин татах

- FOUND хайлтаар check-in илгээхэд `XYP_LOOKUP_EXPIRED` ирвэл алдааны доор **"ХУР-аас дахин татах"** товч гарна.
- Дарахад тухайн РД бөглөгдсөн, зөвшөөрлийн checkbox нь тэмдэглээгүй жижиг хайлтын маягт гарна. Зөвшөөрөл хайлт бүрт тусдаа бүртгэгддэг тул дахин тэмдэглэнэ.
- Шинэ хайлт FOUND бол check-in маягтын оруулсан утгууд (өрөө, хугацаа, барьцаа, ирсэн цаг) хэвээр үлдэнэ. Маягтын хайлтын дугаар шинэчлэгдэж, "ХУР-аар баталгаажсан" мөр шинэ мэдээллээр солигдоно.
- Шинэ хайлт FOUND биш бол маягтыг хаагаад §5.1-ийн урсгалаар үргэлжилнэ. Оруулсан утгууд алга болно (маш ховор).
- **`XYP_LOOKUP_USED`-д дахин татах товч гаргахгүй.** Энэ нь тухайн хайлтаар өөр check-in (жишээ нь өөр tab) аль хэдийн бүртгэгдсэн гэсэн үг тул дахин татвал нэг зочныг давхар бүртгэх эрсдэлтэй. Одоогийн мессеж хэвээр.

## 6. Тест

**PostgreSQL** (`tests/test_xyp_lookup.py`):
- `test_lookup_from_another_hotel_is_not_found`: өөр tenant-ын `lookup_id`-аар check-in → 404 `XYP_LOOKUP_NOT_FOUND`.
- `test_found_lookup_rejects_any_other_identity_field`: FOUND + `note` эсвэл `issuing_country` → 422 `XYP_VERIFIED_FIELDS_LOCKED`; stay үүсэхгүй.
- `test_slow_adapter_times_out_as_unavailable`: timeout 0.2 сек, adapter 1 сек унтана → хариу ~1 сек дотор, `UNAVAILABLE`, `reason='TIMEOUT'`.
- `test_crashing_adapter_records_only_the_error_type`: adapter `RuntimeError('АБ90010211 ...')` шиднэ → event `details` = `{status, reason:'PROVIDER_ERROR', error:'RuntimeError'}`; РД event-д байхгүй.
- `test_unconfigured_lookups_report_reason_and_skip_the_limit`: gateway-гүй app-д 25 хайлт бүгд 201, `reason='NOT_CONFIGURED'`; 429 гарахгүй.
- Одоогийн `test_retry_replays_without_second_xyp_call_and_limit_applies` ба `test_limit_holds_for_concurrent_lookups` хэвээр давна.

**Domain** (`tests/test_xyp_domain.py`): `xyp` модуль `scope`/`validate_identity`/`bind` export хийхгүй болсныг шалгана. psycopg хаагдсан үед ажиллана.

**Browser** (`tests/browser/reception.cjs`):
- Mock route РД-ээс хамааран NOT_FOUND, UNAVAILABLE+NOT_CONFIGURED, UNAVAILABLE+TIMEOUT, UNAVAILABLE+PROVIDER_ERROR, UNAVAILABLE+INVALID_EVIDENCE, FOUND буцаана. Мессеж бүр, "Дахин оролдох" байгаа/байхгүй эсэх, курсорын байрлалыг шалгана.
- NOT_CONFIGURED → маягт шууд нээгдэж, курсор гарчиг дээр очно.
- Гар бүртгэлийн check-in-ийг бүрэн бөглөж илгээнэ: `body.guest` = `{identity_type:'MN_REG_NO', xyp_lookup_id, document_number, family_name, given_name, date_of_birth, nationality:'MN'}`.
- FOUND check-in эхний удаа 409 `XYP_LOOKUP_EXPIRED` → "ХУР-аас дахин татах" → зөвшөөрөл тэмдэглээд татна → барьцааны утга хэвээр → илгээхэд шинэ `xyp_lookup_id`.
- `XYP_LOOKUP_USED` үед "ХУР-аас дахин татах" товч гарахгүй.

## 7. Баримт

1. `docs/39-walkin-check-in.md`: "server-owned `MANUAL` provenance" өгүүлбэрийг `MANUAL` эсвэл `XYP_VERIFIED` (RC-DEC-046) болгоно. "Minimum grants" блокт `GRANT SELECT, INSERT ON prsystem.xyp_lookup TO app_role;` ба `GRANT UPDATE (stay_id) ON prsystem.xyp_lookup TO app_role;` нэмнэ.
2. `docs/superpowers/specs/2026-09-28-xyp-identity-autofill-design.md` §5: SQL-ийг migration 079-тэй яг тааруулна:
   - `created_at`-д DEFAULT байхгүй;
   - `CHECK (consent_at <= created_at)`;
   - `xyp_lookup_one_stay` unique index;
   - `guard_xyp_lookup` trigger (append-only, `stay_id`-г NULL-аас нэг удаа).
3. `docs/02-reception-system-scope.md` RC-DEC-046-ийн шийдвэрт нэмнэ:
   - хайлтын хариу UNAVAILABLE шалтгааныг харуулна;
   - ХУР холбогдоогүй үед маягт шууд нээгдэнэ, хайлт хязгаарт тоологдохгүй;
   - адаптерын хариуг 10 секундээр хязгаарлана.
4. `docs/00-mvp-open-decisions.md` EXT-01 мөрөнд нэмнэ: "ХУР дуудахаас өмнө ажилтны хязгаарын slot захиалах (одоо зэрэг хүсэлтэд ХУР илүү дуудагдаж болно); адаптер 10 сек-д хариулах эсвэл TIMEOUT".
5. `docs/requirements-status.md`:
   - REQ-02-03.01 ба REQ-02-07.07 мөрийн шаардлагыг бүтнээр уншиж, нотолгоог `test_xyp_lookup`/`test_xyp_domain`/`reception.cjs`-ээр шинэчилнэ.
   - Үүрэг бүр серверийн код ба давсан тесттэй бол "хэрэгжсэн" болгоно. Бодит ХУР адаптер шаарддаг хэсэг үлдвэл "дутуу" хэвээр үлдээж, тайлбарт EXT-01 гэж бичнэ.
   - Төлөв өөрчлөгдвөл §2.1, §3, roadmap-ийн нийт тоог шинэчилнэ.

## 8. Шалгалт

- Domain-only suite (psycopg-гүй).
- PostgreSQL 4 shard: алгасалт 0, бүгд OK.
- 25 browser suite (`PRSYSTEM_BROWSER_PATH` тохируулсан), `validate_requests`, `export_ui_tokens --check`, design lint (0 алдаа).
- Дараа нь `git push -u origin final`.

## 9. Эрсдэл

- **Timeout thread:** Хугацаа хэтэрсэн адаптер thread-ийг зогсоох боломжгүй. Олон удаа гацвал pool-ийн 8 worker бүгд эзлэгдэж, дараагийн хайлтууд бүгд TIMEOUT болно. Гар бүртгэл ажилласаар байна. Бодит адаптер өөрөө socket timeout тохируулах ёстой (EXT-01).
- **NOT_CONFIGURED хязгааргүй:** ХУР руу дуудлага явахгүй, мөрөнд зөвхөн шифрлэсэн token хадгалагдах тул хувийн мэдээлэл задрахгүй.
- **`reason`-ийг ил болгох:** Зөвхөн техникийн ангилал. Registry-ийн хариу, хувийн мэдээлэл биш.
