# Reception — 3/6-р шатны acceptance

**Төлөв: 3/6-р шатны 6/6 implementation багц mock boundary-тай баталгаажсан.**

2026-09-07. Энэ баримт 38-р баримтын зургаан багцын одоогийн implementation-ийг нэгтгэнэ.
Бизнесийн батлагдсан дүрэм docs/02,03,05,18,20,21,24,26-д хэвээр байна.

| № | Багц | Хэрэгжсэн урсгал | Шалгах эх сурвалж |
| --- | --- | --- | --- |
| 1 | Өрөө, ангилал, тариф | Tenant/Manager хамгаалалт, versioned тохиргоо, тарифын өвлөлт, bounded Reception жагсаалт | test_room_catalog.py |
| 2 | Анхны ээлж | Admin float, Reception бодит тооллого, immutable INITIAL_FLOAT, variance review | test_initial_opening.py |
| 3 | Check-in ба guest access | Readiness/history/давхцал, encrypted identity, immutable үнэ/хугацаа, cash/POS/provider deposit, confirmed booking adapter, QR/code/session rotation/revoke, Manager time amendment | test_walkin_stays.py, test_reception_booking.py, test_checkin_funding.py, test_guest_access_amendments.py |
| 4 | Санхүү | Deposit/payment/allocation, original/alternate-channel refund ба approval, immutable cash/noncash correction, MFA late-refund reconciliation, unapplied funding return, provider capture uniqueness | test_guest_finance.py, test_guest_payments.py, test_financial_corrections.py, test_routed_refunds.py, test_checkin_funding.py |
| 5 | Checkout, cleaning, lifecycle | Finance gate, actual checkout, access revoke, minibar inspection/report/return/dispute/refill, Restaurant acknowledgement, canonical cleaning, room/category retirement/reactivation | test_checkout.py, test_reception_dependencies.py, test_handover_lifecycle.py |
| 6 | Handover ба дэлгэц | Independent blind counts, recount, custody, policy-gated self-close, separate review, shift report, Reception/Manager/Cleaner console, guest QR entry | test_handover_lifecycle.py, test_operations.py, tests/browser/reception.cjs |

## Mock ба дараагийн шатны зааг

Хэрэглэгч бэлэн болоогүй гадаад API-уудыг mock үлдээхийг зөвшөөрсөн.
QPay/Khaan, SMS/email, XYP/Police-ийн бодит интеграц production release gate хэвээр.
Confirmed booking producer нь 4-р шатны үйлчилгээний isolated mock; Reception
тогтсон захиалгыг нэг transaction-аар physical stay болгох adapter-тай.
Minibar/Restaurant producer нь 5-р шатны isolated mock. Reception-ийн report,
checkout, cleaning болон acknowledgement хэрэглэгчийн урсгал холбогдсон боловч
бүтэн агуулах, рестораны захиалга, online booking бүтээгдэхүүнийг дууссан гэж тооцохгүй.
Mock өгөгдөл production санхүүгийн нотолгоо болохгүй.

## Аюулгүй байдлын баталгаа

- Бүх мөнгө бүхэл MNT; давтан хүсэлт ба зэрэгцээ өөрчлөлтөд idempotency/revision/transaction хамгаалалттай.
- Барьцаа нь орлого биш; refund hold-ийг төлбөр/зарлага давхар ашиглахгүй.
- Check-in-ээс өмнө баталгаажсан funding нь provider capture-ийг эзэмшинэ. Өөр stay эсвэл төлбөрт давхар ашиглахыг DB trigger хориглоно.
- Check-in болоогүй баталгаажсан төлбөрийг буцаахдаа эхлээд REFUNDING болгоно; POS proof эсвэл authoritative mock provider success хүртэл ээлжийн үүрэг нээлттэй үлдэнэ.
- Room/category retirement нь түүх устгахгүй; stay/cleaning/source blocker дуусахыг хүлээнэ.
- QR/code/session нь scope, capacity, expiry, rotation/revocation-той. Нэвтрэх token болон зочны мэдээллийг браузерийн persistent storage-д хадгалахгүй.
- Одоогийн эрх, hotel security suspension, subscription болон pre-lock root completion нь серверийн шалгалт хэвээр.

## Баталгаажуулалт

v0.12.0 source `75cb9b479cfd58410df59d5392c3dd1e02903a95` дээр
[эцсийн CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34119366083):
**414 backend тест skip-гүй, 289.319 секундэд амжилттай**. Chromium staff/Reception/
guest entry, expired completion UI, API request-model contract, design lint болон
token check бүгд давсан. Өмнөх 364 тесттэй milestone-оос 50 тест нэмэгдсэн.
Local: 68 тест ажилласан, PostgreSQL шаарддаг 346 skip. Local дүн нь бүрэн
PostgreSQL CI-ийн оронд ашиглагдаагүй. Premium strict audit: 0 error/warning.
Desktop болон 320px mobile screenshot-ийг CI artifact-д хадгалж харагдацыг шалгасан.
Энэ дүнг оруулсан дараагийн commit зөвхөн баримтжуулалт өөрчилсөн.

Энэ milestone нь дээр тодорхойлсон Reception implementation acceptance юм.
Бодит provider болон дараагийн module-ийн production acceptance биш.
Subscription-expired completion API болон console overview нь persisted pre-lock
stay/shift бүрийг authorize хийж зөвхөн гүйцээх ажлыг харуулна. Шинэ check-in,
funding, booking болон configuration хаалттай. Stage-2 live acceptance тусдаа хэвээр.
API, санхүү, QR болон mock boundary-ийн дэлгэрэнгүй: [integration contract](44-reception-integration-contract.md).
