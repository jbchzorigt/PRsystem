# Manager — Өрөө болон Minibar удирдлага

**Хувилбар:** 1.12  
**Төлөв:** MVP өрөө, minibar stock/price, P0-37 lifecycle, P0-38 stay pricing/config болон P0-39A–P0-39C-2 батлагдсан  
**Хамаарах үе шат:** MVP — Manager system

## 1. Багцын хамрах хүрээ

- Өрөө болон өрөөний ангилал удирдах боломж бүх багцын Manager-д байна; Manager Plus role нь зөвхөн 30,000₮ багцад үүснэ.
- Minibar бүтээгдэхүүн, үнэ, өртөг, агуулах/өрөөний нөөц, template болон shortage override зөвхөн **25,000₮**, **30,000₮** багцад байна.
- **20,000₮** багцад minibar UI/API ажиллахгүй.
- Hotel Admin эдгээр operational үйлдлийг хийх бол тухайн багцад зөвшөөрөгдсөн Manager, эсвэл 30,000₮ багцад Manager Plus role тусад нь авна.
- Package, role, subscription болон hotel scope-ийг сервер/API action бүр шалгана.
- Hotel Admin role assignment-аар дээд багцын entitlement үүсгэхгүй: 20,000₮-д minibar/Cleaner/Manager Plus, 25,000₮-д Manager Plus/Restaurant эрх нээхгүй.

## 2. Өрөөний ангилал

Manager өрөөний ангилал үүсгэхдээ:

- ангиллын нэр;
- тайлбар;
- optional нэг цагийн category override; хоосон бол hotel default-ийг өвлөнө;
- optional нэг шөнийн category override; хоосон бол hotel default-ийг өвлөнө;
- category-level барьцааны дүн, хэрэв ашиглах бол;
- цэвэрлэгээний хамгийн бага хугацаа;
- үүсгэх үеийн төлөв: `Идэвхтэй` эсвэл `Идэвхгүй`; `Идэвхгүй болгохоор хүлээгдэж буй` төлөвийг хэрэглэгч гараар сонгохгүй, deactivation урсгал автоматаар тогтооно

бүртгэнэ.

### 2.1 Stay тарифын шатлал

Manager бүх багцад цагийн болон хоногийн stay тарифыг хооронд нь хольж бус, тус тусад нь тохируулна. Category болон room түвшний hourly/nightly override `null` буюу тохируулаагүй байж болох бөгөөд энэ тохиолдолд сервер дараагийн доод түвшний утгыг өвлүүлнэ.

- **Walk-in check-in:** `room override → category override → hotel default`.
- **Online booking quote:** `category override → hotel default`; физик өрөөг дараа оноох учраас room override-ийг online үнэд ашиглахгүй.
- Hotel default нь тухайн stay type-ийн заавал fallback үнэ байна; сонгосон hourly/nightly төрөлд хүчинтэй үнэ олдохгүй бол баталгаажуулах ажиллагааг сервер хориглоно.
- Reception room, stay type болон хугацааг сонгох боловч нэгж үнэ зохиох, гараар override хийх эсвэл client-ээс үнэ батлуулахгүй. Сервер authoritative тарифаар бодно.
- Walk-in check-in эсвэл online booking баталгаажихад тухайн stay type-ийн `unit_price`, хэрэглэсэн source level, source entity ID болон config version-ийг immutable price snapshot болгон хадгална.
- Баталгаажсан online booking-г check-in хийхэд booking-ийн price snapshot хэвээр үлдэнэ. Дараа сонгосон физик room өөр override-тэй байсан ч дахин үнэ бодохгүй.
- Manager-ийн дараагийн hotel/category/room tariff edit нь өмнө баталгаажсан booking болон active stay-г reprice хийхгүй; зөвхөн дараагийн шинэ quote/check-in-д үйлчилнэ.
- Hotel default, category override, room override-ийн create/update/unset бүр actor, өмнөх/шинэ утга, config version, огноо/цагаар аудитлагдана.

Энэ P0-38A дүрмийн canonical шийдвэр нь `STAY-DEC-005`. P0-38B-ийн configurable minimum/maximum/increment саналыг хэрэгжүүлэхгүй бөгөөд Manager-д ийм шинэ duration тохиргоо нэмэхгүй. `STAY-DEC-002`-ын `effective нэг цагийн үнэ × Reception-ийн сонгосон цагийн тоо` томьёог хэвээр хадгалсан canonical шийдвэр нь `STAY-DEC-006`. P0-38C-ийн `STAY-DEC-007`-оор хоногийн байрлалтыг эерэг бүхэл шөнөөр тооцож, planned checkout-ийг hotel-local check-in огноо + сонгосон шөнө дээр snapshot хийсэн fixed check-out цагаар тогтооно; early-morning cutoff-ийг түр хойшлуулсан. Ингэснээр P0-38 бүрэн хаагдсан.

### 2.2 Stay interval ба өрөө бэлэн болох хугацаа

- Booking/stay нь `[start, end)` interval ашиглана; `end` агшин interval-д орохгүй. Дараагийн interval яг тэр агшинд эхлэх нь өөрөө overlap биш боловч хүчинтэй cleaning buffer-ийг тухайн stay/booking-д snapshot хадгалж, заавал багтаана.
- Actual checkout бүртгэгдэхээс өмнөх planning earliest availability нь `planned checkout + snapshotted cleaning buffer`, бүртгэгдсэний дараах actual earliest readiness нь `actual checkout + ижил snapshotted cleaning buffer` байна.
- Өрөө бодитоор дахин ашиглагдахад server time buffer хугацаанд хүрсэн эсвэл өнгөрсөн, actual cleaning state `Цэвэр`, applicable existing minibar readiness зэрэг хангагдана. Эцсийн overlap/readiness validation серверт байна.
- Early actual checkout buffer-ийг эрт эхлүүлж болох ч existing confirmed next booking автоматаар урагшлахгүй, room charge auto reprice/refund болохгүй.
- Late actual checkout readiness time-ийг хойшлуулна; overdue status/time л харуулж fee/penalty автоматаар үүсгэхгүй. Дараагийн confirmed booking-тэй conflict `STAY-DEC-013`-ын alert/blocker/remedy-г ашиглана.
- Энэ P0-39A дүрэм Manager/Manager Plus, Reception, Cleaner эсвэл Hotel Admin-д шинэ action/permission үүсгэхгүй; existing cleaning buffer config болон operational actions хэвээр байна (`STAY-DEC-008`).
- `STAY-DEC-009`-ийн initial actual-time backdate нь historical Manager configuration сонгох эрх биш. Check-in-ийн room/minibar current configuration, exact version, opening snapshot болон selling price нь immutable `check_in_recorded_at` үеийн authoritative state-аар үүсэж, past actual time руу configuration/stock сэргээхгүй. Initial backdate-д Manager approval шаардахгүй. `STAY-DEC-010`-аар active stay actual-time correction request-ийг Manager approve/reject хийнэ; Hotel Admin-д Manager role тусдаа, Reception+Manager нэг actor self-approve хийж болох ч `self_approved` audit-тай байна. Approved correction зөвхөн effective actual start-ийг өөрчилж, current configuration/version/opening/price/stock snapshot-ийг сэргээхгүй, солихгүй.
- Confirmed booking эсвэл `ACTIVE` stay-ийн `planned_checkout_at` direct edit/overwrite хийхгүй. MVP-д change байхгүй; STAY-DEC-011-ийн append-only history/revalidation нь зөвхөн post-MVP change хожим тусдаа батлагдвал мөрдөх invariant байна.
- Энэ нь одоогоор Manager/Manager Plus/Hotel Admin-д хугацаа өөрчлөх шинэ button/API/action, permission/approval, taxonomy, eligibility эсвэл pricing/refund эрх өгөхгүй. Room tariff, minibar configuration/version, opening/price/stock snapshot, Cleaner task болон movement immutable хэвээр; guard өөрөө side effectгүй.
- `STAY-DEC-012`-оор confirmed booking/active stay-ийн planned end MVP-д бүрэн түгжээтэй: amendment/action/button/API, extension, shorten болон hourly ↔ nightly conversion байхгүй. Early/late actual checkout нь original planned end-ийг өөрчлөхгүйгээр зөвхөн `actual_checkout_at` бүртгэнэ.
- Active stay actual checkout хүртэл room-ийг occupied/blocking байлгана. Үүний дараа P0-39A-ийн actual checkout + snapshot buffer, clean болон applicable minibar readiness gate үйлчилнэ. Энэ lock нь tariff, configuration/version, price/opening/stock snapshot, task, movement эсвэл lifecycle side effect үүсгэхгүй.
- Manager cleaning buffer-ийг дараа өөрчилсөн ч өмнө confirmed болсон booking/active stay-ийн snapshotted buffer автоматаар өөрчлөгдөхгүй.

## 3. Өрөө

Manager өрөө бүрд:

- тухайн hotel дотор давхцахгүй өрөөний дугаар;
- давхар;
- өрөөний ангилал;
- зөвхөн walk-in-д ашиглах optional нэг цагийн болон нэг шөнийн room override; тохируулаагүй утга category/hotel шатлалаас өвлөгдөнө;
- үүсгэх үеийн төлөв: `Идэвхтэй` эсвэл `Идэвхгүй`; `Идэвхгүй болгохоор хүлээгдэж буй` нь system-managed lifecycle төлөв;
- 25,000₮/30,000₮ багцад `Minibar ашиглана/ашиглахгүй` mode;
- minibar ашиглавал нэг `ACTIVE` minibar template entity болон түүний exact `PUBLISHED` version; анхны сонголтод Default Published version

сонгоно.

Бүх өрөөнд minibar заавал биш. `Minibar ашиглана` өрөө active template entity + exact eligible Published version-гүй check-in хийхгүй. Current mode `Minibar ашиглахгүй` өрөөнд routine guest minibar task/charge үүсэхгүй, minibar төлөв `Хамаарахгүй` байна; OFF → ON pending change-ийн assigned reconciliation task тусдаа байж болно.

Room/category нь `ACTIVE → RETIRING → INACTIVE` lifecycle ашиглана. Deactivation хүсэлтээс хойш шинэ booking, walk-in check-in болон assignment хийхгүй. Active stay болон өмнө баталгаажсан future booking-г автоматаар cancel/reprice хийхгүй; stay/booking/task/reconciliation шийдэгдтэл `RETIRING` байна. Өмнөх stay, payment, inventory болон audit түүхийг устгахгүй.

### 3.1 Өрөөний Restaurant QR

30,000₮ багцад Manager/Manager Plus:

- өрөөний тогтмол QR үүсгэх;
- хэвлэх хэлбэрээр татах;
- гэмтсэн QR-г дахин хэвлэх;
- token сольж хуучин QR-г хүчингүй болгох

боломжтой байна.

QR дотор өрөөний дугаар, stay ID болон зочны мэдээллийг ил бичихгүй. Manager QR-г удирдах боловч check-in бүрийн guest access кодыг Reception олгоно.

### 3.2 Room/category deactivation

- Active stay-тай room current guest-ийн checkout хүртэл `RETIRING` байна.
- Physical room-д өмнө баталгаажсан future booking оноогдсон бол booking автоматаар цуцлагдахгүй. Гэхдээ retiring room дээр check-in хийхгүй; room-г reactivate хийх, booking-г өөр `ACTIVE` room-д шилжүүлэх эсвэл тусдаа урсгалаар цуцлах хүртэл `INACTIVE` болохгүй.
- Category шинэ booking/check-in/room assignment-д шууд хаагдана. Dependent room, active stay болон future booking шийдэгдсэний дараа inactive болно.
- Огт ашиглагдаагүй, reference/task/stock/movement-гүй entity-г л hard-delete хийж болно. Бусад entity түүхээ хадгалан inactive болно.
- Reactivation нь dependency, configuration, package болон uniqueness шалгалт амжилттай үед хэрэгжинэ.

Canonical lifecycle: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md).

### 3.3 Room minibar configuration change

Room яг нэг current mode/template entity/exact Published version, хамгийн ихдээ нэг non-terminal pending target entity/version change-тай байна. Manager/Manager Plus:

- `Ашиглана → Ашиглахгүй`;
- `Ашиглахгүй → Ашиглана`;
- Template A → Template B

өөрчлөлтийн request үүсгэх, exact Published target version сонгох, active stay байвал checkout-ын дараа хэрэгжихээр товлох, хөдөлгөөн эхлээгүй request цуцлах, stock shortage/count variance/rollback шийдэх боломжтой.

Active stay-ийн current exact version, opening quantity болон price book өөрчлөгдөхгүй. Checkout, payment, minibar report болон active-stay refill task бүр terminal болсны дараа Cleaner-ийн physical reconciliation эхэлнэ. Pending change terminal болтол physical room шинэ check-in/assignment авахгүй; Reception current/pending exact version болон blocker-ийг read-only харна.

## 4. Minibar бүтээгдэхүүн

Гурван өөр ойлголтыг тусад нь хадгална:

- **Өрөөний ангилал:** Standard, Deluxe, Suite.
- **Бүтээгдэхүүний ангилал:** Ус, ундаа, алкоголь, амттан.
- **Minibar template:** Standard Minibar, Premium Minibar зэрэг бүтээгдэхүүн ба зорилтот тооны дахин ашиглах загвар.

Manager/Manager Plus бүтээгдэхүүн бүрд:

- нэр;
- бүтээгдэхүүний ангилал;
- хэмжих нэгж;
- худалдах нэгж үнэ;
- худалдан авалтын нэгж өртөг;
- агуулахын анхны тоо;
- үүсгэх үеийн төлөв: `Идэвхтэй` эсвэл `Идэвхгүй`; `Идэвхгүй болгохоор хүлээгдэж буй` нь system-managed lifecycle төлөв

оруулна.

Product form дахь тоо нь зөвхөн **агуулахын анхны үлдэгдэл** байна. Өрөөнүүдэд байгаа тоог нэмэхгүй. Анхны тоо нэг `Анхны үлдэгдэл` movement үүсгэж, дараа нь balance-ийг overwrite хийхгүй.

Product `RETIRING` болмогц шинэ template/refill/check-in configuration-д ашиглахгүй. Өмнө stay price book-д орсон product active stay-ийн checkout/report/correction-д locked price-аараа хэвээр байна. Room stock болон pending холбоос шийдэгдэх хүртэл inactive болохгүй; warehouse stock inventory/report-д хадгалагдана.

## 5. Minibar template entity ба version

Template entity нь:

- нэр;
- тайлбар;
- үүсгэх үеийн entity төлөв: `Идэвхтэй` эсвэл `Идэвхгүй`; `Идэвхгүй болгохоор хүлээгдэж буй` нь system-managed lifecycle төлөв

агуулна. Бүтээгдэхүүний жагсаалт болон бүтээгдэхүүн бүрийн зорилтот тоо нь entity дээр бус, **version бүрийн immutable content** байна.

```text
Template entity: ACTIVE → RETIRING → INACTIVE
Template version: DRAFT → PUBLISHED → ARCHIVED
```

- `DRAFT`: Manager/Manager Plus бүтээгдэхүүн болон target quantity-г засна; room/default/check-in/reconciliation target болгож ашиглахгүй.
- `PUBLISHED`: product list болон target quantity-г in-place edit хийхгүй; өөрчлөх бол шинэ Draft/version үүсгэнэ.
- `ARCHIVED`: terminal historical version; direct reactivation хийхгүй. Дахин ашиглах бол immutable version-оос шинэ Draft clone үүсгэнэ.
- Нэг template-ийн хэд хэдэн Published version gradual migration-ийн үед зэрэг байж болно. Published version байгаа үед шинэ configuration-д анх санал болгох яг нэг Default Published version байна.
- Publish хийхэд parent template `ACTIVE`, дор хаяж нэг unique same-hotel `ACTIVE` product-тэй, target quantity бүр эерэг бүхэл байна. Validation бүтэлгүй бол Draft хэвээр үлдэнэ.
- Анхны Published version автоматаар Default болно; дараагийн publish одоогийн Default-ийг солихгүй. Manager/Manager Plus тусдаа `Set default` action ашиглана.
- Room current configuration болон pending target exact version ID хадгална. Draft/publish/default өөрчлөлт existing room/stay/booking pointer-ийг шууд солихгүй.
- Publish/Set default нь stock movement, Cleaner task, configuration request эсвэл check-in blocker автоматаар үүсгэхгүй.
- Minibar-enabled өрөөнд `ACTIVE` template entity + exact eligible `PUBLISHED` version заавал байна; minibar-disabled өрөөнд шаардахгүй.
- Идэвхтэй stay-ийн exact template version, эхний бодит тоо, зорилтот тоо болон үнийн snapshot буцаад өөрчлөгдөхгүй.
- Template entity `RETIRING` болмогц шинэ room/check-in assignment-д сонгохгүй. Existing assignment, active stay болон reconciliation шийдэгдэх хүртэл inactive болохгүй.
- Effective exact version-ийн бүх product entity `ACTIVE` биш бол room өөрөө active байсан ч шинэ booking/check-in-д configuration blocker-тэй байна.
- Referenced/used version hard-delete болохгүй; огт publish хийгдээгүй, reference/task-гүй Draft л existing never-used delete gate ашиглана.

Version Archive хийхэд тухайн Published version Default биш, ямар ч room-ийн exact current/pending version биш, active stay болон non-terminal configuration/reconciliation/rollback/Cleaner task reference-гүй байна. Default version-ийг archive хийх бол эхлээд өөр eligible Published version-ийг Default болгоно; өөр Published version байхгүй бол archive хийхгүй. Terminal historical stay/report/price book/invoice/export/inventory movement/audit reference blocker болохгүй бөгөөд immutable түүх хадгалагдана. Archive нь room pointer, booking, price, stock balance, stock movement, Cleaner task, configuration request, Rollout эсвэл check-in blocker үүсгэхгүй. Transition болон audit атомик байна.

Room-level Explicit Rollout хийхдээ Manager ижил hotel болон ижил `ACTIVE` template entity-ийн өөр exact `PUBLISHED` target version сонгоно. Сонгогдох room `ACTIVE`, minibar ON, одоогийн version нь target-аас өөр, non-terminal pending configuration-гүй байна; target-ийн бүх product dependency `ACTIVE` байна. Mode ON/OFF эсвэл template entity солих нь Rollout биш, existing configuration-change урсгалаар хийгдэнэ.

Active stay байгаа room-г сонгож болох боловч request `SCHEDULED_AFTER_STAY` байна. Confirm амжилттай болоход exact pending target болон check-in/assignment blocker шууд, нэг атомик ажиллагаагаар үүснэ. Safe point бүрдсэн room `READY_FOR_RECONCILIATION` болж Cleaner task нэн даруй авна; active stay эсвэл checkout/payment/minibar report/refill дуусаагүй бол бүх dependency terminal болсны дараа task үүснэ.

Rollout Confirm нь current version, stay/booking/price book, stock болон cleaning status-ийг шууд өөрчлөхгүй. Cleaner reconciliation болон final validation амжилттай үед current version switch, pending completion, audit атомикаар хийгдэнэ. Target exact ID pinned тул дараагийн Publish/Set default түүнийг солихгүй, pending reference байх хугацаанд target version Archive болохгүй.

Multi-room Rollout batch нэг hotel/template-ийн нэг exact eligible Published target болон олон selected room-той байна. Read-only Preview нь room бүрийг `Одоо хийх боломжтой`, `Stay дууссаны дараа`, `Сонгох боломжгүй` гэж reason-тэй ангилах боловч pending, blocker, Cleaner task, stock/current version/price/stay/booking/cleaning эсвэл Archive blocker үүсгэхгүй.

Confirm room бүрийг дахин шалгаж partial success ашиглана: eligible room бүр өөрийн атомик pending child + immediate blocker-тэй, ineligible room `SKIPPED` result/no blocker-тэй байна. Нэг child-ийн failure бусдыг stop/cancel/rollback хийхгүй. Batch state child/result progress-оос `IN_PROGRESS`, `COMPLETED`, `PARTIALLY_COMPLETED`, `CANCELLED` эсвэл `FAILED_VALIDATION` гэж derive хийгдэнэ.

`Cancel remaining` movement-гүй child-ийг cancel/unblock, movement-тэй child-ийг compensating rollback-д оруулж, Applied child-ийг өөрчлөхгүй. Applied room-ийг буцаах бол өмнөх exact version рүү шинэ Rollout үүсгэнэ. Retry хуучин history-г засахгүй, `retry_of_batch_id`-тай шинэ batch үүсгэн target/room eligibility-г дахин шалгана. Preview/zero-accepted batch Archive blocker биш; accepted non-terminal child байх хугацаанд exact target Archive болохгүй.

## 6. Stock ба өртгийн canonical дүрэм

Нөөцийг:

1. hotel-ийн агуулах;
2. өрөө тус бүрийн minibar

гэсэн тусдаа location-оор хөтөлнө.

Opening stock, purchase, room transfer, warehouse return, consumption, waste болон stock adjustment бүр immutable хөдөлгөөн байна. Нөөц сөрөг болохгүй. Waste/adjustment шалтгаан болон audit-тай, нотлох зураг/хоёр дахь approval шаардахгүй.

Худалдах үнэ болон худалдан авалтын өртөг тусдаа байна. MVP-д hotel-level тасралтгүй жигнэсэн дундаж өртөг ашиглана. Дэлгэрэнгүй movement, cost formula, override болон acceptance criteria-г [22-minibar-stock-inventory.md](./22-minibar-stock-inventory.md)-д canonical байдлаар тодорхойлсон.

## 7. Өрөөний minibar ажиллагаа

1. Manager/Manager Plus product болон агуулахын opening/purchase stock бүртгэнэ.
2. Template entity доторх Draft version-д бүтээгдэхүүн, зорилтот тоог тохируулна. Parent template `ACTIVE`, дор хаяж нэг unique same-hotel `ACTIVE` product, target бүр эерэг бүхэл гэсэн validation амжилттай үед immutable Published version гарна. Анхны Published version Default болж, дараагийн publish Default-ийг автоматаар солихгүй.
3. Minibar-enabled өрөөнд active template entity + exact Published version онооно; initial candidate нь Default Published version байна.
4. Pending change байхгүй үед агуулахаас өрөө рүү зөвхөн room-ийн exact current version-д байгаа lifecycle `ACTIVE` product нөхөхөд агуулах хасагдаж, өрөө нэмэгдэх нэг атомик transfer үүснэ. Retiring/inactive product-ийг warehouse → room нөхөхгүй бөгөөд configuration blocker хэвээр байна.
5. Cleaner хэрэглээг тайлагнахад өрөөний бодит тооноос consumption movement үүснэ.
6. Pending change байхгүй бол Cleaner өрөөг цэвэрлэхдээ агуулахын боломжит active product-ийн үлдэгдлээр exact current version-ийн target-ийг нөхнө. Pending change байвал хуучин current version-р routine refill хийхгүй, pinned exact target version-ын reconciliation task ажиллана.
7. Current/шинээр applied configuration-ийн зорилтот тоо бүрдвэл minibar `Бүтэн`, хүрээгүй бол `Дутуу` байна.
8. Нөөц хүрэлцэхгүй бол Manager/Manager Plus дараагийн stay-д `Дутуу minibar-тайгаар нээх` exception үүсгэж болно.

Active stay үргэлжилж байхад Reception эсвэл Manager/Manager Plus `Minibar нөхөх хүсэлт` үүсгэж, Cleaner өөрийн task-аар actual quantity-г батална. Зөвхөн completion үед stay/room/product/price-book line-тэй warehouse → room movement үүснэ. Pending task дуусах/цуцлагдахаас өмнө check-out эхлэхгүй.

Active stay-ийн warehouse return, room waste болон negative adjustment-ийг зөвхөн Manager/Manager Plus шалтгаантай, stay-scoped non-guest movement болгон бүртгэнэ. Эдгээрийг billable availability-гаас хасна; generic positive adjustment billable quantity нэмэхгүй.

### 7.1 Configuration reconciliation

- **ON → OFF:** Cleaner assigned task-аар usable stock-ийг room → warehouse буцаана. Manager/Manager Plus waste/count variance-г шийднэ. Бүх room balance `0` болсны дараа mode OFF, template `null`, minibar status `Хамаарахгүй` болно.
- **OFF → ON:** Manager active template entity + exact Published target version сонгож, Cleaner task-аар тухайн version-ийн target quantity-г нөхнө. Stock хүрэлцэхгүй бол pending хэвээр; existing controlled shortage override шаардлага хангавал үндсэн status `Дутуу` + `Manager зөвшөөрсөн` flag-тай apply хийж болно.
- **Template/version A → B:** Cleaner эхлээд actual count батална. Pending request-д pinned exact B version-д байхгүй/илүүдэл stock warehouse-д буцаж, шинэ/дутуу stock room-д нөхөгдөнө. Энэ нь guest consumption, sale, revenue эсвэл stay charge биш.
- **Cancel/rollback:** Ямар ч movement эхлээгүй бол direct cancel. Movement post болсон бол silent cancel хийхгүй, linked compensating rollback movement-ээр baseline сэргээнэ. Applied config-г буцаах бол шинэ request үүсгэнэ.

Cleaner зөвхөн server-generated, өөрт оноогдсон task-ийн product/direction/quantity boundary дотор room ↔ warehouse transfer батална. Final target/override validation амжилттай үед current configuration switch болон pending completion атомикаар хийгдэнэ. Configuration apply нь cleaning status-ийг автоматаар `Цэвэр` болгохгүй.

## 8. Дутуу minibar-тайгаар нээх

Ердийн minibar-enabled өрөө check-in-ээс өмнө `Бүтэн` байна. Нөөц хүрэлцэхгүй үед Manager/Manager Plus:

- өрөө `Цэвэр`, өмнөх check-out дууссаныг шалгах;
- бодит эхний тоог тоолох;
- дутуу бүтээгдэхүүн болон exact current/target version-ийн target-ийг тулгах;
- шалтгаан оруулах;
- зөвхөн дараагийн stay-д үйлчлэх exception үүсгэх

боломжтой.

Reception exception болон `Дутуу — Manager зөвшөөрсөн` badge-ийг харна, гэхдээ өөрөө үүсгэхгүй. Template price book-д байсан боловч opening actual quantity `0` бүтээгдэхүүнийг stay үеэр баримтжуулан refill хийсэн бол check-in price-аар бодит хэрэглээг тооцож болно; refill хийгээгүй өмнөөс дутуу барааг тооцохгүй. Check-in price book-д огт байгаагүй product-ийг тухайн stay-д charge хийхгүй. Override нь minibar-ыг `Бүтэн` гэж худал төлөвт оруулахгүй.

## 9. Үнэ ба түүхийн хамгаалалт

- Manager үнэ/өртөг өөрчилсөн ч өмнөх payment, inventory movement болон cost snapshot өөрчлөгдөхгүй.
- Check-in үед template version, бүх бүтээгдэхүүний selling price, бодит эхний/зорилтот тоог stay price book болгон snapshot хийнэ; opening quantity `0` product мөн орно.
- Minibar charge-д бүтээгдэхүүний нэр, check-in нэгж үнэ, тоо болон нийт дүн snapshot байна.
- Inventory consumption/waste-д тухайн хөдөлгөөний үеийн weighted average cost snapshot байна.
- Active stay үед current selling price өөрчлөгдсөн ч Cleaner/Manager report, correction болон refill reprice болохгүй; шинэ үнэ дараагийн check-in-ээс үйлчилнэ.
- Check-in price book, report version болон correction-ийн canonical дүрмийг [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md)-д PRICE-DEC-001–008-аар баталсан.
- Minibar-ын орлого, COGS, gross profit/margin болон Excel тайлангийн томьёог [23-admin-financial-reporting.md](./23-admin-financial-reporting.md)-д canonical байдлаар баталсан.
- Бүтээгдэхүүн, үнэ, өртөг, template, room mode/assignment, movement болон override аудиттай байна.

## 10. Эрхийн хуваарилалт

- **Manager/Manager Plus:** Manager бүх багцад, Manager Plus зөвхөн 30,000₮ багцад hotel default, category override болон walk-in room override-ийн hourly/nightly stay тариф, өрөө/category удирдана. Багцын entitlement-тэй үед product, худалдах үнэ, худалдан авалтын өртөг, warehouse stock, template entity, Draft version create/edit, `Publish`, `Set default`, `Archive`, room-level Rollout, multi-room Preview/Confirm/`Cancel remaining`/Retry, exact pending target version, config cancel/variance/rollback, waste/adjustment, shortage override, active-stay refill request болон entity lifecycle удирдана. Minibar/version action нь 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus-д нээгдэнэ. 25,000₮ багцад Manager Plus role үүсгэн gate тойрохгүй.
- **Cleaner:** Өөрийн ажлын хүрээнд хэрэглэсэн болон нөхсөн бүтээгдэхүүн/тоог бүртгэнэ; active-stay refill болон configuration reconciliation/rollback task-ийн actual quantity/transfer-ийг батална; selling price/cost харахгүй, price, cost, target, generic warehouse balance/adjustment болон override-ийг шууд өөрчлөхгүй.
- **Reception:** Өрөөний readiness, server-resolved stay tariff/source ба баталгаажсан price snapshot, current/pending exact version, blocker, minibar mode/status болон хүчинтэй shortage exception-ийг read-only харна; active-stay refill request үүсгэж болно, харин stay үнэ зохиох/override хийх, tariff/config/version request, inventory movement/override өөрчлөхгүй.
- **Hotel Admin:** Full financial тайланг харна; stay тариф тохируулахад Manager role, бусад дээрх operational үйлдэлд багцад зөвшөөрөгдсөн Manager/Manager Plus role тусдаа шаардлагатай.

## 11. MVP acceptance criteria

- Manager өрөөний ангилал болон өрөө үүсгэж чадна.
- Manager бүх багцад hourly/nightly hotel default, category override болон walk-in room override-ийг тус тусад нь тохируулж чадна; unset override дараагийн түвшний утгыг өвлөнө.
- Walk-in effective tariff нь room → category → hotel, online quote нь category → hotel дарааллаар серверээс бодогдож, online үнэд room override хэзээ ч орохгүй.
- Reception нэгж үнэ зохиох/override хийхгүй; баталгаажуулах агшинд unit price, source level/ID болон config version snapshot хадгалагдана.
- Paid/confirmed online booking room assignment/check-in үед reprice болохгүй; Manager-ийн дараагийн тарифын edit өмнөх confirmed booking болон active stay-д нөлөөлөхгүй.
- Stay тарифын edit болон confirmation snapshot audit-тай байна; Hotel Admin tariff config хийхэд Manager role тусдаа авсан байна.
- Хоногийн stay нь эерэг бүхэл `N` шөнөтэй, planned checkout нь hotel-local check-in календарийн огноо + `N` өдөр дээр баталгаажуулах үед snapshot хийсэн fixed hotel check-out цаг байна.
- Check-in fixed check-out цагаас өмнө байсан ч нэг шөнө маргаашийн check-out цагт дуусна; тухайн өдрийн check-out хүртэлх богино stay цагаар бүртгэгдэнэ.
- Хоногийн төлбөр `effective нэг шөнийн үнэ × N` байна. Сервер дараагийн booking/cleaning buffer-ийг дахин шалгаж, nights, effective rate/source/config version, fixed checkout time болон planned checkout snapshot хадгална.
- Manager-ийн дараагийн tariff эсвэл fixed check-out config edit confirmed booking/active stay-г өөрчлөхгүй. Early-morning cutoff тохиргоо P0-38-д нэмэгдээгүй, түр хойшлогдсон.
- Booking/stay interval `[start, end)` бөгөөд availability/readiness-ийн snapshotted buffer-ийг actual checkout-оос өмнө planned checkout, дараа нь actual checkout-оос тооцно.
- Шинэ check-in хийхэд server time buffer-д хүрсэн эсвэл өнгөрсөн, actual cleaning state `Цэвэр`, applicable minibar readiness зэрэг хангагдаж, сервер overlap/readiness-ийг дахин шалгана.
- Early checkout confirmed next booking-ийг автоматаар урагшлуулахгүй, auto reprice/refund хийхгүй; overdue нь status/time л харуулж automatic fee/penalty үүсгэхгүй. Next-booking conflict resolution `STAY-DEC-013`-аар хаагдсан.
- Confirmed booking/active stay-ийн planned checkout change MVP-д байхгүй; amendment/action/extension/shorten/conversion хоригтой. STAY-DEC-011 нь зөвхөн post-MVP invariant бөгөөд C2 өөрөө permission, payment эсвэл snapshot/movement үүсгэхгүй.
- Room actual checkout хүртэл occupied; дараа нь actual checkout + snapshot buffer, clean, applicable minibar readiness бүгд хангагдана.
- Өрөөний дугаар нэг hotel дотор давхцахгүй.
- 25,000₮/30,000₮ багцад product, худалдах үнэ, худалдан авалтын өртөг болон агуулахын opening stock үүсгэж чадна.
- Product quantity нь зөвхөн агуулахын анхны үлдэгдэл байна.
- Warehouse болон room stock тусдаа, хөдөлгөөнөөр хөтлөгдөнө.
- Stock receipt weighted average cost-ийг шинэчилнэ.
- Transfer, consumption, waste болон adjustment immutable audit-тай байна.
- Warehouse/room stock сөрөг болохгүй.
- Waste/adjustment шалтгаантай байна.
- Бүх 25,000₮/30,000₮ өрөөнд minibar заавал биш.
- Minibar-enabled өрөө active template entity + exact eligible Published version-гүй check-in хийхгүй.
- Minibar-disabled өрөөнд routine guest minibar task/charge үүсэхгүй; OFF → ON pending change-ийн reconciliation task тусдаа байна.
- Manager/Manager Plus шалтгаан, бодит эхний snapshot болон audit-тай shortage override үүсгэж чадна.
- Reception override үүсгэхгүй; баримтжуулсан active-stay refill хийгээгүй өмнөөс дутуу барааг зочинд тооцохгүй.
- Cleaner-ийн consumption/refill нь inventory movement үүсгэнэ.
- Active-stay refill request дангаараа movement биш; Cleaner completion нь stay/price-book line-тэй атомик transfer үүсгэнэ.
- Active stay-ийн non-guest stock-out billable quantity-гаас хасагдаж, generic positive adjustment charge нэмэхгүй.
- Manager price өөрчилсөн ч active stay-ийн minibar charge өөрчлөгдөхгүй; шинэ үнэ дараагийн check-in-ээс үйлчилнэ.
- Cleaner/Reception/Manager report line-ийн unit price-ийг гараар override хийхгүй.
- 20,000₮ багцад minibar UI/API ажиллахгүй.
- 30,000₮ багцад Manager/Manager Plus өрөөний QR-г удирдаж чадна.
- Deactivation хүсэлт шинэ booking/check-in/assignment-ийг шууд хааж, active stay/future booking-г автоматаар cancel/reprice хийхгүй.
- Referenced entity hard-delete болохгүй; never-used, reference/task/stock/movement-гүй entity-д л зөвшөөрнө.
- Room нэг current config, хамгийн ихдээ нэг non-terminal pending change-тай байна.
- Pending change active stay-ийн pinned config/price book-ийг өөрчлөхгүй бөгөөд safe point хүртэл reconciliation эхлэхгүй.
- Non-terminal pending change-тэй physical room шинэ assignment/check-in авахгүй; future booking автоматаар cancel/reprice болохгүй.
- ON → OFF room balance `0` болсны дараа, OFF → ON/A → B target эсвэл хүчинтэй shortage override хангасны дараа apply болно.
- Cleaner assigned reconciliation task-аар хоёр чиглэлийн transfer баталж, Manager/Manager Plus shortage/variance/cancel/rollback шийднэ.
- Reconciliation movement guest consumption/sale/revenue/charge үүсгэхгүй; movement эхэлсний дараа cancellation immutable rollback шаарддаг.
- Configuration apply cleaning status-ийг автоматаар өөрчлөхгүй.
- Template entity lifecycle болон `DRAFT → PUBLISHED → ARCHIVED` version lifecycle тусдаа байна.
- Draft version room/default/check-in/reconciliation target болохгүй; Published product list/target quantity in-place edit болохгүй.
- Нэг template-ийн олон Published version зэрэг байж болох ч Published version байгаа үед яг нэг Default байна.
- Room current/pending config exact version ID хадгалж, default/publish change existing room/stay/booking pointer-ийг шууд өөрчлөхгүй.
- Referenced/used version hard-delete болохгүй; never-published reference-гүй Draft л existing delete gate ашиглана.
- Publish validation-д parent template `ACTIVE`, дор хаяж нэг unique same-hotel `ACTIVE` product болон target бүр эерэг бүхэл байна.
- Анхны Published version автоматаар Default болох ба дараагийн publish Default-ийг солихгүй.
- Publish/Set default нь existing room/pending/stay/booking, stock, Cleaner task болон check-in blocker-д автомат өөрчлөлт хийхгүй.
- 20,000₮ багц minibar Publish/Set default/Archive/Rollout хийхгүй; 25,000₮ багцад Manager Plus role үүсгэн entitlement тойрохгүй.
- Default, room current/pending, active stay эсвэл non-terminal configuration/reconciliation/rollback/Cleaner task reference-тэй Published version archive болохгүй.
- Зөвхөн terminal historical reference-тэй Published version archive болж болох бөгөөд түүх, тайлан, price book болон inventory movement өөрчлөгдөхгүй.
- Archive нь room/pending pointer, booking, price, stock, stock movement, Cleaner task, configuration request, Rollout эсвэл check-in blocker үүсгэхгүй.
- Archived version terminal/history-only; direct Published reactivation хийхгүй, шаардлагатай бол шинэ Draft clone үүсгэнэ.
- Archive transition blocker recheck болон audit атомик байна; 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus зөвшөөрөгдөж, Hotel Admin-д тохирох operational role тусдаа шаардлагатай.
- Room-level Rollout зөвхөн `ACTIVE`, minibar ON, pending-гүй room-ийг ижил hotel/template-ийн өөр exact eligible Published version рүү чиглүүлнэ.
- Current version-тэй ижил, cross-hotel, өөр template, Draft/Archived эсвэл inactive dependency-тэй target reject болно.
- Rollout Confirm exact pending target болон check-in/assignment blocker-ийг шууд үүсгэх боловч current version, stay/booking/price book, stock болон cleaning status-ийг өөрчлөхгүй.
- Safe point бүрдсэн бол Cleaner task шууд, active stay эсвэл checkout/payment/report/refill дуусаагүй бол dependency бүр terminal болсны дараа үүснэ.
- Reconciliation болон final validation амжилттай үед current version switch, pending completion, audit атомикаар хийгдэнэ; exact target-ийг Default/Publish өөрчлөхгүй, pending үед Archive хийхгүй.
- Rollout action-д 25,000₮-ийн Manager, 30,000₮-ийн Manager/Manager Plus зөвшөөрөгдөж, Hotel Admin-д тохирох operational role тусдаа шаардлагатай.
- Multi-room batch нэг hotel/template-ийн нэг exact target-тай бөгөөд room бүр тусдаа child/result байна.
- Preview read-only бөгөөд room бүрийн eligibility/reason-ийг харуулах боловч pending, blocker, task, stock/pointer/price эсвэл Archive blocker үүсгэхгүй.
- Confirm room бүрийг дахин шалгаж partial success ашиглана; eligible child pending+blocker-тай, ineligible room reason-тэй `SKIPPED`/no blocker байна.
- Нэг child-ийн failure бусад child-ийг stop/cancel/rollback хийхгүй; batch progress/state child/result-ээс derive хийгдэнэ.
- `Cancel remaining` хөдөлгөөнгүй child-ийг cancel/unblock, movement-тэй child-ийг immutable rollback-д оруулж, Applied child-ийг өөрчлөхгүй.
- Applied room-ийг буцаах бол өмнөх exact version рүү шинэ Rollout үүсгэнэ; Retry old history-г өөрчлөхгүй, холбоостой шинэ batch байна.
- Default/Publish batch target-ийг солихгүй; preview/zero-accepted batch Archive blocker биш, accepted non-terminal child target Archive-ийг хориглоно.
- Duplicate Confirm шинэ batch/child үүсгэхгүй; one-pending болон cross-hotel guard үйлчилнэ.
- Batch Preview/Confirm/Cancel/Retry-д 25,000₮-ийн Manager, 30,000₮-ийн Manager/Manager Plus зөвшөөрөгдөж, Hotel Admin-д тохирох role тусдаа шаардлагатай.

## 12. Батлагдсан бизнесийн шийдвэр

P0-08 нь INV-DEC-001–008-аар, P0-09 нь FIN-DEC-001–010-аар, P0-36 нь PRICE-DEC-001–008-аар, P0-37A/B/C бүхэлдээ RML-DEC-001–028-аар, P0-38A–C нь `STAY-DEC-005`–`STAY-DEC-007`-оор, P0-39A interval/readiness нь `STAY-DEC-008`-аар, P0-39B-1 initial actual check-in/backdate нь `STAY-DEC-009`-өөр, P0-39B-2 actual-time correction нь `STAY-DEC-010`-аар, P0-39C-1 minimal guard нь `STAY-DEC-011`-ээр, P0-39C-2 MVP planned-checkout lock нь `STAY-DEC-012`-оор хаагдсан. Inventory-ийн canonical эх сурвалж нь [22-minibar-stock-inventory.md](./22-minibar-stock-inventory.md), financial тайлан нь [23-admin-financial-reporting.md](./23-admin-financial-reporting.md), selling price snapshot нь [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md), entity/room/version lifecycle нь [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md), stay pricing/config/time нь [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md) байна.

## 13. Үлдсэн нээлттэй асуудал

Room/Minibar lifecycle-ийн P0-37, stay pricing/config-ийн P0-38 болон P0-39A–D хаагдсан. MVP-д planned checkout extension/shorten/conversion байхгүй, early checkout auto refund/reprice хийхгүй; overdue conflict `STAY-DEC-013`, fractional hourly input `STAY-DEC-014`-ийг мөрдөнө. Early-morning cutoff түр хойшлогдсон.
