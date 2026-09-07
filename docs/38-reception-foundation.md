# Reception foundation — v0.8.0

**Үе шат 3/6.** Бодит provider-ийг хэрэглэгчийн шийдвэрээр mock болгон хойшлуулж,
Reception module-ийн эхний хоёр багцыг хэрэгжүүлэв. Энэ нь check-in/out бүхэлдээ
ажилладаг болсон гэсэн тайлан биш.

**Одоогийн шинэчлэлт: 6/6 implementation багц mock boundary-тай баталгаажсан.**
413 backend тест skip-гүй, browser/API-contract/design/token CI амжилттай. Дүнг
[43-р acceptance баримт](43-reception-stage3-acceptance.md)-д нэгтгэв.
Доорх хүснэгт нь v0.8–v0.11 үеийн түүхэн төлөв.

## 3-р шатны 6 implementation багц

| № | Багц | Төлөв |
| --- | --- | --- |
| 1 | Room/category суурь бүртгэл, тарифын тохиргоо, Reception read API | Хэрэгжүүлсэн |
| 2 | Admin configured float → анхны Reception shift opening | Хэрэгжүүлсэн |
| 3 | Stay interval/readiness, immutable snapshot, check-in | Хэсэгчлэн: [development-mock walk-in, canonical cleaning readiness, encrypted identity бэлэн](39-walkin-check-in.md); online booking/guest access integration үлдсэн |
| 4 | Guest charge/payment/deposit, allocation/refund, cash source posting | Хэсэгчлэн: [cash deposit/payment/allocation/refund ба source posting](40-guest-cash-finance.md) хэрэгжсэн; [cash correction, POS болон provider charge-payment mock](41-guest-corrections-and-provider-mocks.md) нэмэгдсэн; provider deposit/refund, alternate-channel, non-cash correction үлдсэн |
| 5 | Checkout, cleaning source/readiness, room/category lifecycle | Хэсэгчлэн: [settled minibar-OFF checkout, cleaning claim/completion](42-checkout-cleaning.md) нэмэгдсэн; lifecycle болон minibar-enabled flow үлдсэн |
| 6 | Ердийн handover/self-close, operational screens ба end-to-end урсгал | Үлдсэн |

Эдгээр нь 2-р шатны өмнөх 9 багцаас тусдаа, энэ milestone-оос эхэлсэн Reception
implementation тоолол. 2-р шатны acceptance хүснэгтийг 31-р баримт хадгална.

## API

Bearer нь hotel-ийн active, verified account/current membership-тэй байна.

| Method / path (`/hotels/{hotel}` prefix) | Эрх / үр дүн |
| --- | --- |
| POST `/cash/drawers` | Hotel Admin: шинэ zero-balance drawer + configured float |
| POST `/cash/drawers/{drawer}/configure` | Hotel Admin: ашиглаагүй drawer-ийн configuration CAS |
| POST `/cash/drawers/{drawer}/open` | Reception: actual count → анхны opening |
| POST `/cash/drawers/{drawer}/opening-review/approve` эсвэл `/dispute` | Hotel Admin: анхны float variance-ийн тусдаа review |
| PUT `/rooms/settings` | Manager/зөв багцын Manager Plus: hourly/nightly defaults, fixed checkout time |
| POST `/room-categories` | Manager: name/description, overrides, deposit, buffer, ACTIVE/INACTIVE |
| POST `/rooms` | Manager: unique number, floor, active same-hotel category, overrides |
| PUT `/rooms/{room}/tariffs` | Manager: hourly/nightly override set/unset, CAS |
| PUT `/room-categories/{category}/tariffs` | Manager: category override set/unset, CAS |
| GET `/rooms`, GET `/room-categories` | Reception/Manager: bounded keyset listing |

Hotel Admin operational Manager/Reception role-ийг автоматаар өвлөхгүй.
Manager Plus нь зөвхөн 30,000₮ багцад; room catalog нь бүх багцын Manager-д байна.
Шинэ setup/open нь expired эсвэл security-suspended hotel-д хориглогдоно.

## Анхны касс ба ээлж

Canonical: docs/24 §3, docs/03. Admin configured float ба Reception actual count
хоёр тусдаа input. Reception request-д expected/balance/owner/shift time өгдөггүй.
Admin response-оос өөр газар configured float-ийг count-оос өмнө буцаахгүй.

```json
{"code":"front","name":"Үндсэн касс","physical_location":"Reception","expected_float":200000,"status":"ACTIVE","expected_revision":0,"idempotency_key":"configure-front"}
```

Onboarding-аар үүссэн `default` drawer-ийг `/configure`-оор тохируулж болно.
Historical balance/movement/transfer/shift-тай legacy drawer-д first-opening
урсгал ашиглан мөнгө нэмж эсвэл overwrite хийж болохгүй.

```json
{"actual":190000,"idempotency_key":"open-front-1"}
```

Opening transaction нь account → hotel → receipt → cash book дарааллаар lock
хийнэ. Нэг удаагийн `INITIAL_FLOAT` funding, drawer projection, immutable
Reception opening, staff work registry, initial count/variance, cash outbox,
audit болон receipt бүгд нэг commit. Float нь sale/deposit/expense биш.
Actual `0` бол snapshot хадгалах боловч zero-amount movement үүсгэхгүй.

Expected 200,000₮ / actual 190,000₮ бол shift 190,000₮-өөр нээгдэж, -10,000₮
variance нь `ADMIN_REQUIRED` болно. Review нь shift нээгдэхийг зогсоохгүй.
Нэг drawer-д болон нэг account-д нэг open shift; concurrent/retry давхар float
нэмэхгүй. Ашигласны дараа configured opening-г энэ endpoint-оор солихгүй;
handover, top-up болон correction нь тусдаа canonical урсгал.

## Room catalog ба үнэ

Шинэ room-ийн cleaning state `DIRTY`, minibar mode `OFF`. Client `CLEAN`,
`RETIRING`, `minibar_mode=ON` эсвэл ready/available flag зохиож оруулахгүй.
Minibar ON нь template exact Published version, stock болон pending-request
producer хэрэгжсэн үед тусдаа migration/API-тай нэмэгдэнэ.

Hourly/nightly үнэ тусдаа: `room override → category override → hotel default`.
List нь effective unit price, source level/entity/version-ийг буцаана. Fallback
байхгүй бол үнэ `null`; тогтмол/таамагласан үнэ зохиохгүй. Энэ нь current walk-in
tariff projection, confirmed booking price snapshot эсвэл availability promise биш.
Online quote-д room override хэрэглэхгүй; booking adapter дараагийн шатанд байна.

Manager price set/unset бүр expected revision, before/after audit-тай.
Checkout time нь HH:MM hotel-local configuration; check-in snapshot/stay calendar
тооцоолол энэ багцад хараахан ороогүй. Booking/stay/readiness/task integration,
room/category deactivation/reactivation болон үндсэн Reception дэлгэц дараагийн
багцуудад орно. Generic room update/delete endpoint нээгээгүй.

## Migration ба grants

001–017 migration-ийг owner role-оор ажиллуулна. 016 нь cash event enum/check-д
`INITIAL_FLOAT` нэмнэ; хуучин check-үүдийн amount/reservation invariant хэвээр.
Initial opening snapshot UPDATE/DELETE хоригтой; financial review л өөрчлөгдөнө.
017 нь same-tenant category FK, unique category name/room number, positive integer
tariff болон revision constraint-тай.

Restricted role-ийн column grant жишээ: `tests/reception_support.py`.
`cash_location_config`-ийн configure эрх нь API-ийн Hotel Admin action-тай,
room config write нь Manager action-тай; HTTP caller database grants өөрчилдөггүй.
Бодит source/history-г client-ээс шууд insert хийдэг generic endpoint байхгүй.

Тестүүд: `test_initial_opening.py`, `test_room_catalog.py`. Scope/role/package,
duplicate/CAS/concurrency, immutable opening, commit failure rollback, tariff
inheritance/unset болон forged readiness-ийн rejection-ийг шалгана.

Баталгаа: [v0.8.0 CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34084343027),
source `336a14e`, **264 backend тест skip-гүй**, browser/design/token checks амжилттай.

## v0.9.0 continuation

[Walk-in check-in contract](39-walkin-check-in.md) нь initial opening ба room catalog-ийг real stay transaction-тай холбов. Үндсэн зургаан багцын 1–2 бүрэн, 3 хэсэгчлэн; 4–6 үлдсэн. Online booking quotation/confirmed source болон guest QR/session integration-ийг дууссан гэж тооцоогүй. Дараагийн үндсэн хэрэгжүүлэлт: багц 4-ийн guest financial ledger, deposit/payment allocation/refund.

v0.10 cash integration: production cash check-in нь authoritative deposit configuration ба receipt-тай ажиллана. Funding-гүй check-in fail-closed; development mock source-г live finance рүү adopt хийхгүй. Барьцааны required amount 50,000–100,000₮-ийн guard-тай.

Одоогийн тоолол: **2 бүрэн, 3 ба 4-р багц хэсэгчлэн, 5–6 үлдсэн**. Багц 4-ийн cash acceptance болон дараагийн provider/correction contract: [40-guest-cash-finance.md](40-guest-cash-finance.md).


v0.11-ийн одоогийн тоолол: **2 бүрэн + 3 хэсэгчлэн (3–5) + 1 үлдсэн (6) = 6**.
Correction/POS/provider charge-payment mock, timeline болон checkout cleaning нь
нэг branch дээр холбогдсон; online/guest access, үлдсэн refund/lifecycle/handover/UI
тусдаа pending acceptance хэвээр.
