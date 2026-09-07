# Reception — 3/6-р шатны acceptance

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

Source e20648e: local 413 тест илэрсэн, 60 ажилласан, PostgreSQL-dependent 353 skip.
Local token check болон premium strict audit: алдаагүй.
PostgreSQL 17 болон browser/API-contract/design CI-ийн эцсийн үр дүнг хүлээж байна.
CI баталгаажаагүй үед зургаан багцыг release-ready гэж тайлагнахгүй.
