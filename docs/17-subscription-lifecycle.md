# Subscription lifecycle ба package upgrade

**Хувилбар:** 0.5  
**Төлөв:** MVP upgrade-only, pending upgrade/renewal serialization, 48 цагийн grace period болон grace-ийн дараах hard-lock lifecycle батлагдсан; subscription lifecycle-ийн P0 шийдвэрүүд хаагдсан  
**Хамаарах үе шат:** MVP — Subscription / Entitlement

## 1. Зорилго

Hotel subscription-ийн багц өөрчлөх боломж, хугацаа дуусах үеийн эрх болон өгөгдлийн хамгаалалтын суурь дүрмийг тодорхойлно.

## 2. Upgrade-only дүрэм

MVP болон одоогийн бизнесийн бодлогод package downgrade байхгүй. Hotel subscription зөвхөн одоогийн багцаа хадгалах эсвэл илүү өндөр багц руу upgrade хийх боломжтой.

Зөвшөөрөгдсөн шилжилт:

```text
20,000₮ → 25,000₮
20,000₮ → 30,000₮
25,000₮ → 30,000₮
```

Хориглосон шилжилт:

```text
25,000₮ → 20,000₮
30,000₮ → 25,000₮
30,000₮ → 20,000₮
```

- Downgrade сонголтыг Hotel Admin, Operation болон бусад хэрэглэгчид харуулахгүй.
- Downgrade API/action үүсгэхгүй; client request явуулсан ч сервер хориглоно.
- Operation хэрэглэгч package floor-ийг гараар багасгахгүй.
- 30,000₮ багц хамгийн өндөр тул түүнээс package change хийхгүй; зөвхөн хугацаа сунгана.
- Анх hotel бүртгүүлэхдээ гурван багцын аль нэгийг сонгож болно. Төлбөр баталгаажсаны дараа тухайн багц нь subscription-ийн minimum package floor болно.
- Upgrade payment provider/server талаас амжилттай баталгаажсан мөчөөс target package нь renewal-ийн committed minimum floor болно; operational entitlement нь батлагдсан `effective_at` хүртэл хуучин package-аар хэвээр байна.
- Subscription хугацаа дууссан ч өмнөх package floor арилж, доод багцаар дахин эхлэхгүй.

## 3. Renewal-д үзүүлэх нөлөө

- Renewal хийхдээ effective package floor болон төлбөр нь баталгаажсан pending upgrade target-ийн аль өндрөөс доошгүй багц сонгоно.
- Доод багцын үнэ төлөх invoice/intent үүсгэхгүй.
- Renewal хийгээгүй бол subscription `Дууссан` болно; package floor болон түүхэн data хадгалагдана.
- Дууссаны дараа renewal хийхэд мөн ижил эсвэл өндөр багц сонгоно.
- Paid pending upgrade байхгүй үед renewal_floor-оос өндөр package-аар renewal хийж болно. Active term дуусаагүй бол өндөр package entitlement өмнөх `expires_at` буюу шинэ term эхлэх мөчид нээгдэнэ; grace үед эсвэл grace-ийн дараа renewal хийвэл payment confirmation нь term start-аас хожуу тул entitlement payment commit-тэй хамт шууд нээгдэнэ.

```text
renewal_floor = max(effective_package_floor, paid_pending_upgrade_target)

higher_renewal_effective_at = max(previous_expires_at, renewal_payment_confirmed_at)
```

Pending target-аас өндөр багц руу шилжих бол 4.3-ын incremental second-upgrade урсгалыг эхэлж дуусгана. Иймээс renewal invoice нь аль хэдийн төлөгдсөн upgrade-ийг үл тоон доод package-аар хугацаа нэмэхгүй.

## 4. Төлбөр ба түүх

- Upgrade төлбөрийг QPay эсвэл Khaan Bank gateway-аар төлнө.
- Provider/server төлбөрийг амжилттай баталгаажсаны дараа `Хүлээгдэж буй upgrade` үүснэ; package entitlement дараагийн үйлчилгээний сарын эхлэх мөчид өөрчлөгдөнө.
- Upgrade payment-д НӨАТ багтсан үнэ, платформын provider fee болон eBarimt-ийн батлагдсан subscription дүрэм үйлчилнэ.
- Upgrade төлбөр буцаан олгогдохгүй.
- Upgrade request, хуучин/шинэ package, price calculation, payment, effective time болон хэрэглэгчийг audit/ledger-д хадгална.
- Өмнөх package болон feature ашиглалтын түүхийг устгахгүй.

Үнэ, payment, eBarimt-ийн дэлгэрэнгүй дүрэм: [16-subscription-pricing-and-payment.md](./16-subscription-pricing-and-payment.md).

### 4.1 Үйлчилгээний сарын хил

`Үйлчилгээний сар` нь календарийн сарын 1-нээс заавал эхлэхгүй. Subscription анх төлбөр баталгаажсан огноо/цагийн сар бүрийн давталт байна.

Жишээ: subscription 2026-08-21 15:00-д эхэлсэн бол дараагийн үйлчилгээний сарын хил нь 2026-09-21 15:00 байна. Зорилтот сард ижил өдрийн дугаар байхгүй бол өмнө батлагдсан календарь сарын сүүлийн өдрийн дүрмийг ашиглана.

Upgrade хүсэлт үйлчилгээний сар эхэлснээс хойш ирсэн бол тухайн эхэлсэн сарыг хэрэглэсэн гэж үзэж, хуучин package-аар дуусгана. Upgrade-ийн `effective_at` нь дараагийн үйлчилгээний сарын хил байна.

### 4.2 Upgrade төлбөрийн томьёо

```text
Нэг сарын үнийн зөрүү
= Шинэ package-ийн сарын үнэ − Одоогийн package-ийн сарын үнэ

Upgrade төлбөр
= Нэг сарын үнийн зөрүү × Effective_at-аас expiry хүртэлх үлдсэн бүтэн үйлчилгээний сар
```

Жишээ:

```text
Одоогийн package: 20,000₮
Шинэ package: 25,000₮
Үлдсэн бүтэн үйлчилгээний сар: 8

(25,000₮ − 20,000₮) × 8 = 40,000₮
```

- 40,000₮ төлбөр баталгаажмагц upgrade request бүртгэгдэнэ.
- Cleaner/Minibar зэрэг шинэ feature дараагийн үйлчилгээний сарын хил дээр нээгдэнэ.
- Upgrade нь subscription-ийн одоогийн `expires_at`-ийг өөрчлөхгүй.
- Төлбөр амжилтгүй/тодорхойгүй бол хүлээгдэж буй upgrade үүсэхгүй.
- Үлдсэн бүтэн үйлчилгээний сар `0` бол upgrade difference invoice үүсгэхгүй; дараагийн renewal-ийг өндөр package-аар хийнэ.
- Upgrade price calculation бүр хуучин/шинэ сарын үнэ, үлдсэн бүтэн сарын тоо, effective_at, expires_at болон нийт дүнгийн snapshot-тай байна.

### 4.3 Pending upgrade дээр дахин upgrade хийх

Paid pending upgrade байгаа үед зөвхөн түүнээс **дээш** target руу second upgrade зөвшөөрнө.

Жишээ:

```text
Effective package: 20,000₮
Paid pending target: 25,000₮
Зөвшөөрөх second target: 30,000₮

Incremental payment
= (30,000₮ − 25,000₮) × ижил үлдсэн бүтэн service month
```

- Ижил эсвэл доод target руу шинэ invoice үүсгэхгүй.
- Second upgrade нь өмнөх paid upgrade-г refund/cancel/reprice хийхгүй; өмнөх болон incremental payment хоёул immutable түүхтэй үлдэнэ.
- Second upgrade-ийн `effective_at`, price basis болон `expires_at` snapshot нь existing paid pending upgrade-тай ижил байна. Subscription хугацаа өөрчлөгдвөл unpaid incremental quote stale болж дахин бодогдоно.
- Incremental payment амжилттай баталгаажмагц committed pending target болон renewal floor 30,000₮ болж атомикаар шинэчлэгдэнэ. Operational entitlement original `effective_at` хүртэл effective package-аараа хэвээр.

### 4.4 Upgrade/renewal concurrency ба stale payment

- Subscription бүр monotonic `billing_revision`-тай байна. Upgrade/renewal quote нь уг revision, effective/current/committed target package, `effective_at`, `expires_at`, term болон amount snapshot-тай байна.
- Нэг subscription-д нэг агшинд зөвхөн нэг unpaid/non-terminal upgrade эсвэл renewal payment intent байна. Өөр төрлийн billing action эхлүүлэхийн өмнө өмнөх unpaid intent-ийг cancel/expire хийнэ.
- Provider callback/status query боловсруулахдаа subscription/billing revision-ийг transaction-аар түгжиж, зөвхөн нэг transition subscription-д нөлөөлнө.
- Renewal эхэлж амжилттай commit хийж `expires_at`-ийг өөрчилбөл хуучин expiry дээр бодсон unpaid upgrade/incremental quote stale болно; шинэ expiry-гаар дахин quote хийнэ.
- Upgrade эхэлж амжилттай commit хийвэл түүний target-аас доод package-тай өмнөх unpaid renewal intent stale/cancelled болно; шинэ renewal `renewal_floor`-оос доошгүй байна.
- Cancelled/stale intent дээр provider payment бодитоор амжилттай болсон late callback ирвэл package, pending target, entitlement, `starts_at` эсвэл `expires_at`-ийг автоматаар өөрчлөхгүй. Payment `PAID_REQUIRES_RECONCILIATION` төлөвт орж, Operation/finance-ийн давхар суутгал/provider-system exception урсгалд шилжинэ.
- Ижил provider payment ID/callback/retry өмнөх commit эсвэл reconciliation record-ийг буцаана; хугацаа, target болон invoice-г давхар нэмэхгүй.
- Callback бүр lock дотор `effective_at <= server_now` эсэхийг дахин шалгана. Second-upgrade payment effective boundary өнгөрсний дараа баталгаажсан бол committed target-ийг pending орхихгүй, target package entitlement-ийг ижил transaction-д шууд apply хийнэ.
- Service-month boundary worker callback-тэй ижил subscription row lock, `billing_revision` compare-and-set болон idempotency key ашиглаж paid pending target-ийг нэг удаа effective package болгоно. Renewal-аар expiry сунсан ч өмнөх target болон `effective_at` өөрчлөгдөхгүй; worker/callback зэрэг commit хийхэд revision ялсан нэг transition л entitlement-д нөлөөлнө.
- `PAID_REQUIRES_RECONCILIATION` payment нь explicit `SUBSCRIPTION_PAYMENT_RECONCILE` permission-тэй Operation/finance queue-д орно. Queue resolution subscription/package/expiry-г автоматаар apply хийхгүй; provider status corrected-not-paid, duplicate/system payment-ийн external void/refund/chargeback эсвэл finance-closed exception гэсэн баримттай terminal outcome-оор хаана. Хэрэглэгч entitlement авах бол шинэ authoritative billing quote/intent үүсгэнэ.

## 5. MVP acceptance criteria — батлагдсан хэсэг

- Hotel subscription-д downgrade хийх UI/API байхгүй.
- Сервер доод package руу шилжих request-ийг хориглоно.
- Зөвхөн 20→25, 20→30, 25→30 upgrade зөвшөөрнө.
- Upgrade хийгдсэн бол дараагийн renewal-аар доод package сонгох боломжгүй байна.
- Subscription дууссан ч package floor болон түүхэн data устахгүй.
- Upgrade payment баталгаажаагүй бол package entitlement өөрчлөгдөхгүй.
- Upgrade төлбөр баталгаажсан ч шинэ package тухайн эхэлсэн service month-д бус дараагийн service-month boundary дээр хэрэгжинэ.
- Upgrade төлбөр зөвхөн effective_at-аас expires_at хүртэлх үлдсэн бүтэн үйлчилгээний саруудад бодогдоно.
- Upgrade нь subscription-ийн анхны expires_at-ийг сунгахгүй, богиносгохгүй.
- Үлдсэн бүтэн саргүй бол upgrade invoice үүсгэхгүй; өндөр package renewal санал болгоно.
- Paid pending upgrade target нь operational entitlement хэрэгжихээс өмнө renewal-ийн minimum floor болно.
- Paid 20→25 pending upgrade дээр зөвхөн 25→30 incremental second upgrade зөвшөөрч, `(30−25) × ижил үлдсэн бүтэн сар`-аар бодно; ижил/доод target invoice үүсэхгүй.
- Нэг subscription-д нэг unpaid/non-terminal billing intent байна; upgrade/renewal callback billing revision lock-оор serialize хийгдэнэ.
- Renewal эхэлж expiry өөрчилсөн бол хуучин unpaid upgrade quote, upgrade эхэлж target floor нэмсэн бол доод package renewal quote stale болно.
- Stale/cancelled intent-ийн late paid callback subscription-д автоматаар нөлөөлөхгүй, `PAID_REQUIRES_RECONCILIATION` болно.
- Duplicate callback болон service-boundary retry package/expiry-г хоёр удаа өөрчлөхгүй.
- Higher-package renewal active term дуусахаас өмнө төлөгдвөл entitlement шинэ term эхлэх `previous expires_at` дээр, grace/expired renewal бол payment confirmation дээр хэрэгжинэ.
- Boundary worker болон callback ижил row lock/revision ашиглаж, callback үед effective boundary өнгөрсөн бол target шууд apply болно.
- `PAID_REQUIRES_RECONCILIATION` нь Operation/finance permission-тэй queue-д орж, ordinary entitlement/renewal-г автоматаар өөрчлөхгүй.

## 5.1 Subscription хугацаа дуусах grace period ба hard lock

Subscription-ийн `expires_at` болсон мөчид эрхийг шууд хаахгүй. Тухайн hotel **48 цаг буюу 2 хоногийн grace period**-д орно.

```text
grace_expires_at = expires_at + 48 цаг
```

Grace period-ийн турш:

- одоогийн package-ийн бүх operational эрх хэвийн ажиллана;
- бүх button/API идэвхтэй хэвээр байна;
- Hotel Admin, Manager, Reception, Cleaner болон Restaurant хэрэглэгчид ажлаа үргэлжлүүлнэ;
- hotel public landing page/search болон online booking-д харагдсан хэвээр байна;
- дэлгэцийн тогтмол анхааруулгад subscription дууссан, grace-ийн үлдсэн цаг болон `Сунгах/төлөх` үйлдлийг харуулна;
- шинэ subscription сар автоматаар нэмэгдэхгүй, grace нь үнэгүй шинэ subscription period гэж тооцогдохгүй.

Renewal төлбөр grace period дотор provider/server талаас амжилттай баталгаажвал сонгосон саруудыг анхны `expires_at`-ээс үргэлжлүүлэн нэмнэ. Төлбөр баталгаажсан мөчөөс шинээр эхлүүлэхгүй; ингэснээр renewal бүрд 2 үнэгүй хоног хуримтлагдахгүй.

Grace period дууссаны дараа төлбөр баталгаажаагүй бол тухайн hotel-ийн төлбөртэй operational эрхүүд бүгд hard lock болно.

### Нээлттэй үлдэх үйлдэл

Hotel Admin-д зөвхөн:

- `Subscription сунгах/төлөх`;
- `Тусламж/оператортой холбогдох`;
- `Гарах`

үйлдэл нээлттэй байна.

Бусад hotel staff expired төлөвийн мэдэгдэл харж, `Гарах` болон тусламжийн мэдээлэлд хандаж болох боловч operational дэлгэц/үйлдэлд орохгүй.

### Хаагдах ажиллагаа

- шинэ online booking болон walk-in check-in;
- checkout, room/minibar payment болон барьцааны ажиллагаа;
- өрөө, үнэ, minibar, staff болон Restaurant тохиргоо;
- Cleaner-ийн task, minibar report болон cleaning status update;
- Restaurant-ийн шинэ болон идэвхтэй order processing;
- Reception shift-ийн гүйлгээ, хаалт болон хүлээлцэх ажиллагаа;
- Admin/Manager тайлан, Excel export болон бусад operational үйлдэл.

UI дээр button нуух/идэвхгүй болгохоос гадна backend/API бүр тухайн hotel-ийн subscription status-ийг шалгаж `SUBSCRIPTION_EXPIRED` үр дүнгээр үйлдлийг хориглоно. Идэвхтэй session байсан ч `grace_expires_at`-ийн дараа operational API ашиглахгүй; `expires_at`-аас хойших 48 цагийн grace үед §5.1-ийн эрх хэвийн байна.

Grace дууссан hard lock нь өгөгдөл устгах ажиллагаа биш. Hotel, room, staff, stay, booking, payment, minibar, Restaurant, report болон audit data хадгалагдана. Идэвхтэй workflow-ууд renewal хүртэл царцсан төлөвт үлдэнэ.

### Нийтийн landing page ба online booking

- Анхны onboarding төлбөр баталгаажаагүй, түдгэлзсэн, эсвэл expiry-гийн 48 цагийн grace period дууссан hotel landing page болон public hotel search/list-ээс hide болно.
- Зөвхөн `expires_at` болсон боловч grace period үргэлжилж байгаа hotel public listing/booking-д харагдсан хэвээр байна.
- Шууд hotel detail URL нээсэн ч тухайн hotel-ийн public detail/booking мэдээллийг харуулахгүй; `Одоогоор захиалга авахгүй` гэсэн ерөнхий төлөв харуулна.
- Шинэ availability, booking hold болон payment invoice үүсгэхгүй.
- Grace дууссаны дараах renewal төлбөр provider/server талаас амжилттай баталгаажвал шинэ subscription period нь төлбөр баталгаажсан мөчөөс эхэлж operational entitlement сэргээнэ.
- Hotel-ийн public listing өмнө `Нийтэлсэн`, шаардлагатай өрөө/үнэ/зураг/утас/байршил бүрэн хэвээр байвал renewal-ийн дараа landing page/search-д дахин харагдана.

Subscription дуусахаас өмнөх болон grace period-ийн сануулгыг Operation Dashboard/CallPro-ийн батлагдсан manual SMS ажиллагаагаар илгээж болох боловч сануулга явуулаагүй нь `grace_expires_at`-ийн hard lock-ийг хойшлуулахгүй.

## 6. Батлагдсан шийдвэр

### LIFE-DEC-001 — Downgrade байхгүй, зөвхөн upgrade

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel subscription-ийн package-ийг доошлуулах боломж байхгүй. Зөвхөн 20,000₮-өөс 25,000₮/30,000₮, эсвэл 25,000₮-өөс 30,000₮ рүү upgrade хийнэ. Upgrade payment provider/server талаас амжилттай баталгаажмагц target нь renewal-ийн minimum floor болж, operational entitlement нь батлагдсан service-month boundary дээр хэрэгжинэ. Subscription дууссан ч доод package сонгох боломж нээгдэхгүй.

### LIFE-DEC-002 — Upgrade үнэ ба хэрэгжих мөч

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Upgrade хүсэлт болон төлбөрийг одоо үүсгэж баталгаажуулна. Одоо эхэлсэн үйлчилгээний сарыг хуучин package-аар хэрэглэж дуусгана. Шинэ package дараагийн service-month boundary-оос хэрэгжих бөгөөд төлбөрийг `(шинэ сарын үнэ − хуучин сарын үнэ) × үлдсэн бүтэн үйлчилгээний сар` томьёогоор бодно. Одоогийн subscription-ийн expires_at өөрчлөгдөхгүй. Үлдсэн бүтэн саргүй бол upgrade difference invoice үүсгэхгүй, дараагийн renewal-ийг өндөр package-аар хийнэ.

### LIFE-DEC-003 — Expiry hard lock, 48 цагийн grace-ээр шинэчилсэн

- **Төлөв:** Шинэчлэн батлагдсан
- **Шийдвэр:** Subscription-ийн `expires_at` болсон мөчид шууд hard lock хийхгүй. 48 цагийн grace period-ийн турш бүх одоогийн package эрх хэвийн ажиллана. `grace_expires_at` хүртэл төлбөр баталгаажаагүй бол бүх operational UI/API хаагдаж, идэвхтэй stay, checkout, payment, Cleaner, Restaurant order болон shift renewal хүртэл царцана. Hotel Admin-д зөвхөн subscription сунгах/төлөх, тусламж авах болон гарах үйлдэл нээлттэй үлдэнэ. Өгөгдлийг устгахгүй.

### LIFE-DEC-004 — Landing page-ээс нуух

- **Төлөв:** Шинэчлэн батлагдсан
- **Шийдвэр:** Subscription `expires_at` болсон ч 48 цагийн grace period дотор hotel public landing/search/booking-д хэвээр байна. Grace дуусахад төлбөр баталгаажаагүй бол public landing page, hotel search/list болон шинэ booking availability-аас hide болно. Renewal амжилттай болж, public listing-ийн бусад шаардлага хангагдсан үед дахин харагдана.

### LIFE-DEC-005 — Grace period доторх renewal

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Grace period нь `expires_at`-аас хойш 48 цаг байна. Энэ хугацаанд бүх эрх хэвийн үргэлжилнэ. Grace дотор renewal төлбөр баталгаажвал шинэ саруудыг анхны `expires_at`-ээс нэмнэ. Grace дууссаны дараа төлбөр баталгаажвал шинэ period нь төлбөр баталгаажсан мөчөөс эхэлнэ.

### LIFE-DEC-006 — Paid pending upgrade ба renewal serialization

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Paid pending target нь entitlement хэрэгжихээс өмнө renewal floor болно. Pending target дээр зөвхөн түүнээс дээш second upgrade хийх бөгөөд төлбөрийг pending target-аас шинэ target хүртэлх incremental difference × ижил үлдсэн бүтэн service month-аар бодно. Нэг subscription-д нэг unpaid billing intent, monotonic billing revision болон transaction lock ашиглаж upgrade/renewal callback-ийг serialize хийнэ. Renewal expiry-г түрүүлж өөрчилбөл хуучин unpaid upgrade quote, upgrade target floor-ийг түрүүлж нэмбэл доод package renewal quote stale болно. Stale/cancelled intent-ийн late paid callback entitlement/expiry-г автоматаар өөрчлөхгүй, `PAID_REQUIRES_RECONCILIATION` queue-д орно. Duplicate callback болон boundary apply idempotent байна.

### LIFE-DEC-007 — Higher renewal, boundary race ба reconciliation owner

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Pending upgrade-гүй higher-package renewal active term дуусахаас өмнө paid бол entitlement previous `expires_at` дээр, grace/expired үед paid бол confirmation мөчид хэрэгжинэ. Boundary worker болон upgrade callback ижил subscription lock/revision ашиглаж, callback commit үед `effective_at <= now` бол target шууд apply хийнэ. Stale/second paid payment зөвхөн `SUBSCRIPTION_PAYMENT_RECONCILE` permission-тэй Operation/finance queue-д орж, ordinary entitlement/expiry-г автоматаар өөрчлөхгүй.

## 7. Хаагдсан төлөв

Subscription lifecycle-ийн P0 үндсэн шийдвэрүүд LIFE-DEC-001–007-гоор хаагдсан. Subscription provider reconciliation-ийн SLA/alert нь implementation configuration боловч owner permission, package floor, upgrade/renewal state болон entitlement schema-г дахин нээхгүй.
