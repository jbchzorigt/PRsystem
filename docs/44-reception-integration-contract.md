# Reception — stage 3 integration contract

Хамрах хүрээ нь [38-р баримтын зургаан тогтмол implementation багц](38-reception-foundation.md).
Хэрэглэгчийн 2026-09-07-ны шийдвэрээр бэлэн болоогүй гадаад API болон дараагийн
module-ийн үйлчилгээний boundary-г durable mock-аар ажиллуулна. Энэ нь online
booking marketplace, Restaurant/Minibar бүхэл module болон production acceptance
дууссан гэсэн утга биш.

## Нэгтгэсэн урсгал

1. Hotel Admin кассын байршил/эхлэх float тохируулна. Reception биечлэн тоолж
   анхны ээлж нээнэ; expected float тоолохоос өмнө харагдахгүй.
2. Manager өрөө/ангилал, тариф, 50,000–100,000₮ барьцааг тохируулна. Canonical
   цэвэрлэгээ, buffer, booking overlap, шаардлагатай mock minibar stock бэлэн байна.
3. Reception walk-in эсвэл confirmed-paid booking mock-оос check-in хийнэ.
   Нэг үндсэн зочны identity шифрлэгдэнэ. Cash/POS/provider барьцааны эх үүсвэр,
   үнэ, planned end, actual/recorded time, room/configuration snapshot хадгалагдана.
4. Charge payment, deposit allocation, буцаалт, immutable reversal correction
   нь нэг stay finance revision болон холбогдох original shift/drawer-ийг шалгана.
5. Checkout initiation цагийн шинэ amendment-ийг хаана. Mock minibar тайлан
   ирж, шаардлагатай dispute шийдэгдэж, charge/deposit тэглэгдэнэ. Дуусаагүй
   Restaurant захиалга бүрийн хүлээн авах/буцаалт хүсэх сонголтыг зочинд мэдээлнэ.
6. Checkout original planned end/price-ийг өөрчлөхгүй; guest session/code-г
   цуцална, retention snapshot хадгална, өрөөг DIRTY болгож CLEAN + REFILL
   ажлыг үүсгэнэ. Бүх action болон buffer дууссаны дараа дараагийн stay нээгдэнэ.
7. Reception өөрийн тооллогоор handover submit хийнэ. SUBMITTED ээлж дээр шинэ
   санхүүгийн үйлдэл зогсоно. Хүлээн авагч биечлэн тоолж байж expected/variance
   харна; зөрүүтэй бол дахин тоолно. Шинэ shift бодит мөнгөөр нээгдэх ба Manager/
   Admin financial review тусдаа үлдэнэ. Зөвшөөрсөн self-close ба custody fallback
   мөн эдгээр canonical source-оор ажиллана.

## Нэмэгдсэн API-ууд

`/hotels/{hotel}` prefix, current hotel bearer. Бүх write дээр server scope,
role/package, source state, idempotency болон шаардлагатай revision-г шалгана.

| Boundary | API / үйлдэл |
| --- | --- |
| Booking mock | `POST /mock/bookings`, `GET /bookings`, `POST /bookings/{id}/check-in` |
| Guest QR | `POST /rooms/{id}/guest-qr`, `GET /rooms/{id}/guest-qr/card` |
| Guest access | `/stays/{id}/guest-codes`, `/guest-access/revoke`, `/guest-sessions`, `/guest-sessions/{session}/revoke` |
| Time amendment | `/stays/{id}/time-amendments`, `/{amendment}/decision` |
| Deposit funding | `POST /check-in-funding`, `/{id}/reconcile`, `/{id}/cancel`, `/{id}/return`, `/{id}/return/complete` |
| Payment | `/stays/{id}/pos-payments`, `/payment-intents`, `/{intent}/reconcile`, `/{intent}/cancel` |
| Refund | `/stays/{id}/refunds`, `/{refund}/approval`, `/complete`, `/release`, `/reconcile` |
| Correction | `/stays/{id}/financial-corrections`, `/{correction}/invoice`, `/{correction}/decision` |
| Checkout mock ports | `/stays/{id}/checkout/initiate`, `/checkout/preview`, `/minibar-review`; `/mock/stays/{id}/minibar-report`, `/restaurant-orders` |
| Lifecycle | `/rooms/{id}/lifecycle`, `/room-categories/{id}/lifecycle` |
| Shift | `/handovers`, `/{handover}/counts`, `/{handover}/decision`, `PUT /shifts/policy` |
| Read models | `GET /operations`, `/stays/{id}/guest`, `/shifts/{id}/report` |

Public guest endpoints: `/guest/entry` UI, `POST /guest/access` and
`GET /guest/session`. Platform late-refund claim/resolve remain in the separate
Platform realm, with permission `DEPOSIT_REFUND_RECONCILE` and recent MFA.

## Санхүүгийн хаалт

- POS/provider барьцаа liability үүсгэнэ; Cash drawer нэмэхгүй. Confirmed funding
  нь application-аас өмнө provider capture-г нийтлэг unique registry-д эзэмшинэ.
- Төлөгдөөгүй invoice нь authoritative mock void-ийн дараа л cancelled болно.
  FAILED/EXPIRED/UNKNOWN төлөв дангаараа санхүүгийн hold чөлөөлөх нотолгоо биш.
  Void болон simulated capture нь нэг SQLite transaction lock-оор өрсөлдөнө.
- Confirmed боловч stay-д ашиглаагүй funding-г эх сувагт нь буцааж болно.
  REFUNDING үеэс check-in-д ашиглахгүй; POS буцаалтын баримт эсвэл server provider
  success нотолгооны дараа л shift obligation чөлөөлөгдөнө. Төлбөргүй stay
  үүсгэж барьцааны буцаалтыг зохиомлоор шийдэхгүй.
- Өөр сувгаар guest deposit буцаахад Manager/зөв багцын Manager Plus approval
  шаардана. Cash reservation мөн бодит drawer capacity-г нөөцөлнө.
- Provider рүү явуулсан буцаалтыг дур мэдэн чөлөөлөхгүй. Authoritative terminal
  not-success нотолгоотой release-ийн дараа late success ирвэл case үүсгэж
  finance-г freeze хийнэ. Platform reconciliation available deposit-оос covered,
  үлдсэнийг shortfall posting-д салгаж, negative deposit үүсгэхгүй. Event нь
  хэрэглэсэн receipt бүрийн coverage холбоос болон бодит Platform resolver-той.
- Correction нь original receipt/charge history-г overwrite хийхгүй. Linked
  reversal, allocation reversal, replacement receipt үүсгэнэ. Source channel
  солигдох үед зөвхөн net cash delta drawer-т орно. Provider replacement payment
  нь server-confirmed proof-гүй батлагдахгүй.
- Shift report нь gross receipt/deposit, cash movement, completed refund болон
  pending obligation-ийг тусад нь харуулна. Эхлэх float, барьцаа, шилжүүлгийг
  hotel revenue гэж нэгтгэхгүй. Энэ нь docs/23-ийн бүх hotel financial report биш.

## Дэлгэц ба ашиглалт

API-г ажиллуулаад `/reception` нээнэ. Буудлын код, ажилтны имэйл/нууц үгээр
нэвтэрнэ. Reception үндсэн цэс: **Зочин бүртгэх, Өрөөнүүд, Төлбөр, Ресторан**
(30,000₮). Ээлж, Удирдлага, Цэвэрлэгээ нь role-оор харагдана; Hotel Admin
Manager/Reception-ийн бичих эрхийг автоматаар өвлөхгүй.

QR картын canonical origin-г `PRSYSTEM_PUBLIC_ORIGIN=https://your-hotel-host`
гэсэн environment configuration-оор тохируулна. Client-ийн Host/header эсвэл
дурын URL-г QR-д authority болгон ашиглахгүй. Development default нь
`http://127.0.0.1:8000`. QR-г харж SVG татаж болно; token нь guest URL fragment-д
байх бөгөөд guest page нээхэд history-с арилна. Нэг удаагийн код 10 минут,
нэг stay-д session + хүчинтэй хэрэглээгүй code нийлээд хамгийн ихдээ 5.

Bearer, зочны identity, санхүүгийн маягт болон QR secret-г browser storage-д
хадгалахгүй. Pagehide/logout/session expiry нь private context-г цэвэрлэнэ.
Inline validation, dirty-form modal, pending duplicate guard, stable idempotency
retry, stale-response protection, 320px reflow болон keyboard focus contract нь
`UX-CONTRACT.md`-д байна. Native date/select popup platform-owned байна.

## Mock service boundaries ба үлдсэн release gates

- QPay/Khaan, SMS, email, external identity verification нь хэрэглэгчийн
  зөвшөөрсөн mock/port boundary хэвээр. Live credential шаардаагүй; real payment,
  message, payout болон production deployment хийгээгүй.
- Booking mock нь Reception-д өгөгдөх confirmed-paid quotation/source-г
  орлоно. Marketplace, booking cancellation/no-show/payout нь **4-р шат**.
- Minibar configuration/report/refill болон Restaurant checkout choice outbox
  нь Reception acceptance-д хэрэгтэй mock ports. Бүтээгдэхүүний lifecycle,
  template rollout, full stock management, post-payment minibar dispute/refund,
  Restaurant fulfillment/delivery worker нь **5-р шатны** бүрэн module.
- Room/category historical records-ийг устгахгүй; immutable readiness/reference
  үүссэн entity lifecycle нь deactivate/retire/reactivate-аар ажиллана.
- Admin/Manager bulk guest registry/Excel (docs/12), full hotel financial reports,
  legal hold/retention erasure, Police matching and production acceptance-г
  Reception console хэрэгжсэнтэй андуурч дууссан гэж тооцохгүй.
- Subscription-expired completion командууд original pre-lock root-оор
  ажиллана. Console overview хугацаа дууссаны дараа зөвхөн persisted pre-lock
  stay/shift root бүрийг дахин authorize хийж completion ажлуудыг харуулна.
  Тариф, шинэ booking/check-in, funding болон configuration үүсгэхгүй.
- Source database migrations 001–033 append-only. Runtime нь owner/superuser/
  BYPASSRLS биш, шаардлагатай хүснэгт/column permission-тэй байна. Conflict-тэй
  historical funding capture migration fail-closed; immutable history overwrite
  хийж зөрчлийг нуухгүй.

## Баталгаажуулалт

`tests/test_operations.py`, `test_handover_lifecycle.py`,
`test_guest_access_amendments.py`, `test_reception_booking.py`,
`test_checkin_funding.py`, `test_routed_refunds.py`,
`test_financial_corrections.py`, `test_reception_dependencies.py` болон өмнөх
financial/tenant/concurrency suites real PostgreSQL 17 дээр ажиллана.
`tests/browser/reception.cjs` нь DOM interaction урсгал; түүний бодитоор үүсгэсэн
payload-уудыг `validate_requests.py` real API models-оор дахин шалгана.
UI strict audit, token drift, design lint болон screenshot evidence тусдаа байна.

QR encoder: pinned `qrcode==8.2`, [upstream project](https://github.com/lincolnloop/python-qrcode).
