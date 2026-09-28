# Үлдсэн ажил ба эхний багц

**Эх сурвалжийн commit:** `738d9a4`.
**Үнэлсэн:** 2026-09-28.
**Холбоотой:** [Индекс](requirements-index.md) · [Төлөв](requirements-status.md) · [Зөрчил](requirements-conflicts.md)

## 1. Одоогийн байдал

833 шаардлагын ID-ийн үнэлгээ ([дэлгэрэнгүй](requirements-status.md)):

| Төлөв | Тоо |
| --- | ---: |
| хэрэгжсэн | 306 |
| дутуу | 293 |
| хийгдээгүй | 117 |
| баталгаажаагүй | 63 |
| — (хамаарахгүй) | 54 |

Энэ session-д `738d9a4` дээр 937/937 backend тест, 25/25 browser suite, 171 API-model command давсан. Гэвч бүрэн хийгдээгүй модуль дөрөв бий: Reviews (10), Guest registry жагсаалт/Excel (12), Police (13), Hotel Admin санхүүгийн тайлан (23). Мөн баримттай шууд зөрж буй 6 кодын алдаа олдсон ([B-01…B-06](requirements-conflicts.md#code-defects)).

## 2. Үлдсэн ажил — хамаарлын дарааллаар

Давхарга бүр өмнөх давхаргын үр дүнг шаардана. Нэг давхарга доторх ажлууд хоорондоо бие даасан.

| Давхарга | Ажил | Хамаарал | Шаардлагын ID / эх сурвалж |
| --- | --- | --- | --- |
| **L0 — Шийдвэр** | D-01: implementation line сонгох | Бүх кодын ажлын урьдчилсан нөхцөл | [X-01](requirements-conflicts.md#x-01) |
| | D-02…D-12: scope/эрх/семантик шийдвэр | Тус бүр доорх тодорхой ажлыг блоклоно | [§1](requirements-conflicts.md#decisions) |
| **L1 — Суурийн алдаа засах** (шийдвэр шаардахгүй) | B-01…B-06 | Зөвхөн D-01 | 02-03.01, 17-06.x, 18-03.03, 26-05.00, 09-11.00 |
| **L2 — Суурь модулийн дутуу** | RBAC-ийн зөрүүг засах | D-06 | REQ-18-* (15 дутуу, 4 хийгдээгүй) |
| | Subscription: upgrade, reconciliation outcome, contact утас | D-10 | REQ-15/16/17-* |
| | Касс: safe, bank deposit, owner withdrawal, top-up, paid cash expense | D-03, D-08 | REQ-24-02.01, 24-05.00, 24-08.x, 24-09.x |
| | Reception-ийн үлдсэн хэсэг (cleaning buffer default, overdue conflict/alert, session дүрэм) | D-12 | REQ-02/03/05/06-* (77 дутуу) |
| **L3 — Домэйн модулийг гүйцээх** | Booking: hold expiry, `FULFILLMENT_UNAVAILABLE`, payment тэнхлэг | D-09 | REQ-09/11-* |
| | Minibar: retry/READY/hard-delete/selling price засах | D-07, D-11 | REQ-07/22/25/26-* |
| | Cleaner / маргаан | D-07, D-12 | REQ-04/21-* |
| | Restaurant: RM reassignment, checkout < 10 мин, guest code хадгалалт | D-06, D-12 | REQ-08-*, [C-093](requirements-conflicts.md#c-093) |
| | Operation: session/MFA хугацаа, reconciliation queue | D-10 | REQ-14-* |
| **L4 — Шинэ модуль** | Guest registry жагсаалт + background Excel (12) | L2 Reception, D-05; Excel/export дэд бүтэц 23-тай хамт | REQ-12-* |
| | Hotel Admin санхүүгийн тайлан, expense, KPI, 4 Excel (23) | L2 касс, L3 Minibar COGS, Booking, D-03 | REQ-23-* |
| | Reviews + moderation (10), e-Mongolia (09) | L3 Booking, Operation moderation, D-04, EXT-02 | REQ-10-*, REQ-09-06.x |
| **L5 — Police (13)** | D-02-оос хамаарна | L4 registry identity, тусдаа realm, EXT-09/10 | REQ-13-* |
| **L6 — Production gate** | Бодит provider, security, load, restore, retention | EXT-01…11, P1-xx, `docs/71` | [зөрчлийн §4](requirements-conflicts.md#open-register) |

## 3. Санал болгох эхний багц — "Batch 1: баримттай зөрж буй 6 алдааг TDD-ээр засах"

### 3.1 Яагаад энэ багц эхэнд

1. **Шийдвэр хүлээхгүй.** Эх шаардлага хоорондоо зөрөөгүй. Одоогийн зан төлөвийг дэмжсэн баримт олдоогүй. Хамаарал нь зөвхөн D-01.
2. **Хамаарлын хувьд доод давхарга.** Subscription grace, RBAC, room lifecycle, booking API дээр L3/L4-ийн модулиуд (санхүүгийн тайлан, reviews, registry) суурилна. Суурь буруу бол дээр нь бүтээсэн зүйл буруу өгөгдөлд тулгуурлана.
3. **Жижиг, тусгаарлагдсан, шалгагдахуйц.** Засвар бүр нэг domain function/SQL function/UI талбарт хамаарна. Эхлээд унадаг тест бичих боломжтой.
4. **Төлөвийн итгэлцлийг сэргээнэ.** B-04, B-06 дээр одоогийн тестүүд шаардлагатай зөрөх зан төлөвийг "зөв" гэж түгжиж байна. Эдгээрийг засахгүйгээр "хэрэгжсэн" гэсэн тоо төөрөгдүүлнэ.

**Урьдчилсан нөхцөл:** D-01 нь Python line (`final` = `feat/approved-risk-controls`) байх. TypeScript line сонгогдвол энэ багцыг тэр кодтой дахин тулгана.

### 3.2 Хамрах хүрээ

| # | Шаардлагын ID | Эхэлж бичих унадаг тест | Хүлээгдэх үр дүн |
| --- | --- | --- | --- |
| B-01 | REQ-02-03.01, REQ-02-07.12 (STAY-DEC-014) | `tests/browser/reception.cjs`: HOURLY-д "2" цаг оруулахад илгээсэн `duration_units` = 4 | UI цагийг 0.5 алхмаар авч half-hour unit руу хөрвүүлнэ, эсвэл талбарыг нэгжтэй нь тодорхой нэрлэнэ. Серверийн дүрэм өөрчлөгдөхгүй. |
| B-02 | REQ-26-05.00, REQ-26-12.00, REQ-26-13.03 (RML-DEC-001–006) | PostgreSQL тест: CONFIRMED category `booking_hold` байхад category retire → INACTIVE болохгүй, `BOOKING` blocker харагдана | Шинэ forward migration-аар `category_blockers`-т category-level hold нэмнэ. 024-ийг засахгүй. |
| B-03 | REQ-18-03.03, REQ-18-09.00, REQ-18-10.16 (RBAC-DEC-016) | 30,000₮ багцад зөвхөн MANAGER_PLUS-тэй account NO_SHOW → 403 | NO_SHOW-г зөвхөн Reception эсвэл Manager батална (`docs/18:165,351`). CANCELLED_HOTEL/upgrade-д Manager Plus хэвээр (`docs/18:173`). |
| B-04 | REQ-17-06.00, REQ-17-06.03, REQ-17-07.04 (LIFE-DEC-004) | `expires_at`-аас 1 цагийн дараа (grace дотор) public search-д харагдана, hold үүсгэж болно; `grace_expires_at`-аас хойш нуугдана | `booking_public.py` шүүлтүүрийг grace boundary руу шилжүүлнэ. `test_booking_holds.py:731`-ийн хүлээлтийг шаардлагын дагуу өөрчилнө. |
| B-05 | REQ-17-06.00, REQ-17-07.03 | Grace дотор Restaurant зочны шинэ захиалга амжилттай; grace дууссаны дараа `SUBSCRIPTION_EXPIRED` | `restaurant_orders.py` boundary-г `grace_expires_at` болгоно. |
| B-06 | REQ-09-11.00 | Guest/public хариунд `commission_rate_bps`, `rate_bps`, `contract_id`, `contract_version` байхгүй | Snapshot-ийг сервер талд хадгалсаар, зочинд харуулахгүй. `test_booking_holds.py:194`-ийн assert-ийг staff/Platform талд шилжүүлнэ. |

**Хамрахгүй:** D-01…D-12-ийн аль нь ч, шинэ модуль, provider ажил, бусад refactor.

### 3.3 Дууссаны шалгуур

- B бүрт эхлээд унадаг тест, дараа нь засвар. Commit тус бүр нэг B.
- Бүрэн шалгалт шинэ HEAD дээр давна:
  - `python -m scripts.run_postgres_shard` 4 shard, 0 skip;
  - 25 browser suite;
  - `validate_requests.py`;
  - CI-ийн design/token check.
- Шаардлагатай зөрж байсан тестийг өөрчилсөн бол (B-04, B-06) PR-ийн тайлбарт шалтгааныг REQ ID-тай бичнэ.
- [requirements-status.md](requirements-status.md)-ийн холбогдох мөрүүдийг шинэ run-ийн үр дүнгээр шинэчилж, [зөрчлийн §3](requirements-conflicts.md#code-defects)-т хаагдсан гэж тэмдэглэнэ.

**Төлөв (2026-09-28):** Batch 1 дууссан — B-01…B-06 хаагдсан ([зөрчлийн §3](requirements-conflicts.md#code-defects)). Нотолгоо: [төлөвийн §2](requirements-status.md). §1-ийн тоо Batch 1-ийн дараах байдлаар (REQ-17-07.04, REQ-26-13.03 хэрэгжсэн болсон). Review-д олдсон нээлттэй алдаа: [B-07](requirements-conflicts.md#code-defects).

### 3.4 Superpowers-ээр гүйцэтгэх дараалал

Энэ session-д Superpowers plugin (obra/superpowers) идэвхгүй байна. Идэвхжүүлсний дараах санал болгох урсгал:

1. `using-git-worktrees` — `final`-аас тусдаа branch/worktree.
2. `brainstorming` — хамрах хүрээ дээр тогтсон тул зөвхөн B-01-ийн UI сонголтыг (0.5 алхамтай цаг эсвэл нэгжийн нэр) тодруулна.
3. `writing-plans` — B тус бүр нэг task. Файл, унадаг тест, хүлээгдэх үр дүнг дээрх хүснэгтээс авна.
4. `test-driven-development` — task бүр red → green → refactor.
5. `verification-before-completion` — §3.3-ийн бүрэн шалгалт.
6. `requesting-code-review` → `finishing-a-development-branch`.

## 4. Дараагийн багцуудын санал болгох дараалал

| Багц | Агуулга | Урьдчилсан шийдвэр |
| --- | --- | --- |
| 2 | Эрхийн нийцүүлэлт (C-002, 003, 006, 020, 021, 028, 060, 067, 091, 092) | D-06 |
| 3 | Касс (24)-ийн дутуу хөдөлгөөн + засварын загвар | D-03, D-08 |
| 4 | Guest registry (12) + background Excel дэд бүтэц | D-05 |
| 5 | Hotel Admin санхүүгийн тайлан (23) | D-03; 3, 4-р багц |
| 6 | Booking hold семантик + Subscription дутуу | D-09, D-10 |
| 7 | Reviews (10) | D-04 |
| 8 | Police (13) | D-02 |
