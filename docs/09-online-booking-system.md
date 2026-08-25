# Online Booking System — Хайлт, бүртгэл, захиалга ба settlement

**Хувилбар:** 1.0  
**Төлөв:** MVP booking shape, booker/staying guest, category inventory, QPay/Khaan payment, cancellation/no-show, settlement, overbooking болон P0-39D хамгаалалт батлагдсан  
**Хамаарах үе шат:** MVP — Online Booking

## 1. Зорилго

Зочин утас эсвэл laptop-ийн web browser-оос огноо, сонгосон байршил эсвэл төхөөрөмжийн одоогийн location ашиглан ойрхон зочид буудал хайж, буудал болон өрөөний зураг, үнэ, боломжит төлөв, холбоо барих утсыг харан онлайнаар захиалга хийх боломжтой байна.

Online Booking системийн баталгаажсан захиалга Reception системд шууд харагдаж, check-in үед `ONLINE` эх үүсвэртэй байрлалт болно. Одоогийн батлагдсан дүрмээр онлайн захиалгад тусдаа барьцаа авахгүй; booking-ийн урьдчилсан төлбөрийг барьцаа гэж бүртгэхгүй.

Restaurant-ийн MVP order/payment/refund/handoff суурь дүрмийг [08-restaurant-ordering.md](./08-restaurant-ordering.md)-д тусад нь баталсан; online room booking settlement-тэй холихгүй.

## 2. Үндсэн оролцогчид

- **Зочин:** Буудал хайх, бүртгүүлэх/нэвтрэх, өрөө сонгох, төлөх, өөрийн захиалгыг харах.
- **Зочид буудал:** Нийтийн профайл, өрөөний ангилал, зураг, үнэ, онлайн inventory болон захиалгыг удирдах.
- **Reception:** Баталгаажсан online booking-ийг харах, ирсэн зочныг check-in хийх.
- **Manager:** Буудал, өрөөний ангилал, үнэ, зураг болон online booking-д нийтлэх төлөвийг удирдах.
- **Эрх бүхий Platform Operation/Finance хэрэглэгч:** Гэрээний шимтгэл, settlement, буудлын нийтлэх эрх, санхүүгийн тулгалт болон аудитыг тусгай permission-оор удирдах.
- **e-Mongolia:** Зочны зөвшөөрөлд тулгуурласан бүртгэл/нэвтрэх гадаад суваг.
- **OTP үйлчилгээ:** Утасны дугаар эзэмшиж буйг 6 оронтой кодоор баталгаажуулах суваг.
- **Төлбөрийн үйлчилгээ:** QPay болон Хаан Банкны gateway нь ижил provider-adapter contract-аар booking төлбөрийг server-side баталгаажуулна (`PAY-DEC-005`).

## 3. Нийтийн дэлгэцийн бүтэц

### 3.1 Нүүр хуудас ба хайлт

Зочин нэвтрээгүй үедээ хайлт хийж болно. Хайлт дор хаяж:

- check-in өдөр;
- check-out өдөр;
- хот/дүүрэг/хаяг зэрэг гараар сонгох байршил;
- `Миний одоогийн байршлыг ашиглах` үйлдэл;
- `Буудал хайх` үйлдэл

агуулна.

MVP online booking зөвхөн хоногоор байна. `1 booking = 1 room category-ийн 1 room = 1 үндсэн staying guest`; хамт байрлагчдыг тусад нь бүртгэхгүй (`BK-DEC-012`).

### 3.2 Буудлын жагсаалт

Сонгосон огноо, байршлын дагуу буудлын card бүрд:

- буудлын нэр;
- нүүр зураг;
- нийтлэгдсэн дундаж үнэлгээ болон сэтгэгдлийн тоо;
- хаяг;
- хэрэглэгчийн location ашигласан бол ойролцоох зай;
- буудлын нийтэд харуулах холбоо барих утас болон `Залгах` үйлдэл;
- сонгосон хугацаанд `Боломжтой`, `Дүүрсэн` эсвэл `Online захиалга авахгүй` төлөв;
- үнэ сонгоогүй огноонд `...₮-с`, огноо сонгосон үед боломжит өрөөний бодит нийт/нэг шөнийн үнэ;
- буудлын дэлгэрэнгүй үзэх үйлдэл

харагдана.

`Идэвхтэй` гэсэн нэг ерөнхий үгээр бүх нөхцөлийг нуухгүй. Нийтлэх төлөв, захиалга авч байгаа эсэх болон сонгосон хугацааны өрөөний үлдэгдлийг тусдаа шалгана.

### 3.3 Буудлын дэлгэрэнгүй

Буудал сонгоход:

- буудлын зураг болон тайлбар;
- газрын зураг дээрх байршил;
- хаяг, холбоо барих утас;
- дундаж үнэлгээ, үнэлгээний тоо болон нийтлэгдсэн сэтгэгдлүүд;
- check-in/check-out цаг;
- боломжит өрөөний ангиллууд;
- өрөөний зураг;
- өрөөний үнэ болон сонгосон хугацааны нийт дүн;
- өрөө боломжтой эсэх;
- `Захиалах` үйлдэл

харагдана.

Нэвтэрсэн хэрэглэгчид `Үнэлгээ, сэтгэгдэл үлдээх` үйлдэл харагдана. Үнэлгээ өгөх нарийн эрх, бодитоор байрласан эсэхийг шалгах болон moderation дүрмийг [10-hotel-ratings-reviews.md](./10-hotel-ratings-reviews.md) баримт бичигт тусад нь боловсруулна.

MVP-д яг нэг физик өрөөг нийтэд сонгуулахгүй; **өрөөний ангилал** болон тухайн ангиллын боломжит тоог харуулна. Booking category inventory-ийн нэг unit эзэлж, physical room-ийг Reception check-in үед онооно (`BK-DEC-013`).

### 3.4 Захиалгын баталгаажуулах дэлгэц

Зочинд төлбөрийн өмнө:

- буудал;
- өрөөний ангилал;
- check-in/check-out огноо;
- хоногийн тоо;
- нэгж үнэ, нийт өрөөний төлбөр;
- татвар/шимтгэл зочны төлөх дүнд нэмэгдэх бол тусдаа мөр;
- цуцлалтын нөхцөл;
- зочны холбоо барих мэдээлэл

харагдана. Зочны төлөх дүнг browser-оос итгэж авахгүй; сервер үнэ, хугацаа болон availability-г дахин шалгаж бодно.

Online booking зөвхөн nightly tariff ашиглана. Сервер `category override → hotel default` дарааллаар шийдэж, category override тохируулаагүй бол hotel default-ийг өвлөнө. Физик өрөө booking хийсний дараа оноогддог тул room override online quote-д хэзээ ч орохгүй.

Төлбөр баталгаажиж booking confirmed болоход `unit_price`, stay type, source level, source entity ID болон config version-ийг booking price snapshot болгон хадгална. Manager дараа тариф өөрчилсөн, эсвэл check-in үед өөр room override-тэй физик өрөө оноосон ч paid/confirmed booking-ийн үнэ өөрчлөгдөхгүй (`STAY-DEC-005`).

Online booking-ийн `N` нь эерэг бүхэл шөнийн тоо байна. Planned checkout-ийг буудлын local timezone дахь check-in календарийн огноо дээр `N` календарийн өдөр нэмээд, баталгаажуулах үед snapshot хийсэн fixed hotel check-out цагт тогтооно; check-in нь уг цагаас өмнө байсан ч нэг шөнө маргаашийн check-out цагт дуусна. Нийт өрөөний төлбөр `effective nightly unit rate × N` байна. Сервер confirmation/check-in үед дараагийн booking болон cleaning buffer-тэй давхцлыг дахин шалгаж, nights, rate/source/config version, fixed checkout time болон planned checkout-ийг snapshot хадгална. Дараагийн tariff/check-out config edit баталгаажсан booking/active stay-г өөрчлөхгүй (`STAY-DEC-007`). Early-morning cutoff түр хойшлогдсон; online hourly stay байхгүй (`BK-DEC-012`).

Paid/confirmed online booking-ийг Reception check-in хийхэд default actual time нь initial confirmation-ийн server time байна. Past actual time сонговол STAY-DEC-009-ийн нийт 120 минут/current open shift/current local day хязгаар дээр `confirmed_booking.planned_checkin_at` нэмэлт доод хязгаар болно; online planned start-аас өмнө backdate хийхгүй. Reason code заавал, note optional бөгөөд Manager approval/evidence шаардахгүй. Сервер historical readiness, `[actual_check_in_at, planned_checkout_at)` overlap, lifecycle/blocker, next booking + buffer болон planned checkout ирээдүйд байгаа эсэхийг нэг transaction-д шалгана; нотлогдохгүй бол server-now check-in санал болгоно.

Online booking-ийн paid price snapshot check-in/backdate-аас болж reprice болохгүй. Physical room-ийн current configuration, minibar price/opening болон бусад stay snapshot-ийг past state болгон зохиохгүй, `check_in_recorded_at` агшны authoritative state-аар үүсгэнэ. `actual_check_in_at`/`check_in_recorded_at` immutable; activation-аас хойших correction нь зөвхөн P0-39B-2 / `STAY-DEC-010` immutable amendment урсгалаар хийгдэнэ. Booking shape-ийг `BK-DEC-012` мөрдөнө.

Active stay-ийн actual time алдаатай бол Reception checkout эхлэхээс өмнө corrected time + mandatory reason бүхий STAY-DEC-010 request үүсгэнэ. Manager approve/reject хийх бөгөөд Hotel Admin-д Manager role тусдаа шаардлагатай; Reception+Manager account self-approve хийвэл `self_approved` audit хадгална. Нэг pending request checkout initiation-ийг блоклож, duplicate submit/approval idempotent, decision concurrency-safe байна.

Online stay correction-ийн earliest boundary-д original paid booking-ийн `planned_checkin_at` заавал орно. Цонх original `check_in_recorded_at`/original shift/local day дээр тогтмол бөгөөд approved effective time-ээс дахин гулсахгүй. Approval unchanged planned checkout ашиглан historical readiness болон overlap-ийг дахин шалгана. Original check-in event/field immutable, latest approved amendment зөвхөн effective actual start-ийг өөрчилнө; planned checkout, hours/nights, stay type, paid price, deposit/payment/cash shift, room/minibar config/stock snapshot болон Police original Match/alert timestamps өөрчлөгдөхгүй.

Online booking-ийн nightly duration-ийг payment/confirmation-оос өмнө сонгоно. Hourly stay зөвхөн walk-in байна.

Paid эсэхээс үл хамааран confirmed online booking болон түүнээс үүссэн `ACTIVE` stay-ийн `planned_checkout_at`/effective planned end-ийг MVP-д огт өөрчлөхгүй (`STAY-DEC-012`). `STAY-DEC-011` direct-overwrite guard хэвээр; amendment, change button/API/action, extension, planned-end shorten/lengthen болон hourly ↔ nightly conversion байхгүй.

Зочин бодитоор planned checkout-оос эрт эсвэл орой гарч болно. Reception existing checkout урсгалаар `actual_checkout_at`-ийг бүртгэх бөгөөд original planned checkout болон paid price/payment/cash/config/stock snapshot өөрчлөгдөхгүй. Early actual checkout automatic reprice/refund хийхгүй; overdue үед status болон хэтэрсэн хугацаа л харагдаж automatic fee/penalty үүсэхгүй. Room actual checkout хүртэл occupied хэвээр, дараа нь P0-39A-ийн snapshotted buffer + actual cleaning + applicable minibar readiness gate үйлчилнэ.

`STAY-DEC-012` нь cancellation-ийг planned-end edit/conversion болгохгүй. Booking shape `BK-DEC-012`, cancellation/no-show lifecycle `PAY-DEC-007` байна.

## 4. Байршил ба ойрхон буудал

- Одоогийн location ашиглах нь хэрэглэгчийн сайн дурын зөвшөөрөлтэй байна.
- Зөвшөөрөл өгөөгүй, browser location дэмжихгүй эсвэл алдаа гарвал байршлыг гараар сонгож хайна.
- Систем location зөвшөөрөл өгөхөөс өмнө яагаад хэрэгтэйг тайлбарлана.
- Одоогийн координатыг ойрхон буудал тооцох зорилгоор ашиглаж, хэрэглэгчийн байнгын хөдөлгөөнийг хянахгүй.
- Нэвтрээгүй хэрэглэгчийн яг координатыг account profile-д хадгалахгүй.
- Буудлын зай болон эрэмбийг сервер/газрын зургийн үйлчилгээ тооцно; client-ийн илгээсэн зайд шууд итгэхгүй.
- Ойрхон гэж үзэх радиус болон `зайгаар/үнээр` эрэмбэлэх дүрмийг дараа батална.

## 5. Буудал болон өрөө харагдах нөхцөл

Буудал нийтийн хайлтад харагдахын тулд дор хаяж:

```text
Hotel account = Идэвхтэй
Subscription = Хүчинтэй
Public listing = Нийтэлсэн
Hotel location = Бүрэн
Public phone = Бүртгэлтэй
```

байна.

Сонгосон хугацаанд `Боломжтой` гэж харуулахын тулд:

- өрөөний ангилал нийтлэгдсэн бөгөөд lifecycle `ACTIVE`;
- үнэ хүчинтэй;
- зураг бүртгэлтэй;
- тухайн хугацаанд дор хаяж нэг lifecycle `ACTIVE` физик өрөө захиалга/байрлалттай давхцаагүй;
- тухайн физик өрөөнд non-terminal minibar configuration change байхгүй;
- шаардлагатай цэвэрлэгээний хугацаа дараагийн байрлалтуудын хооронд багтсан

байна.

Booking/stay хугацааг төгсгөлийн агшныг оруулахгүй `[start, end)` interval-аар тооцно. Нэг interval-ийн `end` нөгөөгийн `start`-тай тэнцэх нь өөрөө overlap биш боловч хүчинтэй cleaning buffer-ийг тухайн stay/booking-д snapshot хадгалж, тусдаа багтаана. Actual checkout хараахан бүртгэгдээгүй үед future availability-ийн earliest time-ийг `planned checkout + snapshotted cleaning buffer`-аар, бүртгэгдсэний дараа `actual checkout + ижил snapshotted cleaning buffer`-аар тооцно. Энэ overlap/availability шалгалтыг сервер authoritative байдлаар хийнэ (`STAY-DEC-008`).

`RETIRING/INACTIVE` room/category-г шинэ хайлт, availability count, hold, booking болон check-in-д ашиглахгүй. Deactivation-оос өмнө баталгаажсан booking-г автоматаар cancel/reprice хийхгүй; entity-г reactivate хийх, өөр `ACTIVE` room/category-д шилжүүлэх эсвэл батлагдсан cancellation урсгалаар шийдтэл check-in blocker-тэй confirmed хэвээр байна. Minibar-enabled room-ийн template entity болон бүх template product `ACTIVE` биш, current configuration exact version заагаагүй, эсвэл physical room non-terminal pending configuration change-тэй бол configuration blocker-тэй гэж availability/assignment-аас хасна. `DRAFT/ARCHIVED` version шинэ assignment-д ашиглагдахгүй. Current/pending room эсвэл active stay-д reference-тэй version archive болохгүй тул хүчинтэй operational configuration Archive үйлдлээр Archived төлөвт орохгүй. Canonical entity/version/Rollout lifecycle: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md)-ийн RML-DEC-015–028.

Availability-г зөвхөн дэлгэц дээр тооцохгүй. Захиалгын hold үүсгэх болон төлбөр баталгаажуулахын өмнө сервер дахин шалгаж, хоёр хэрэглэгч нэг сүүлийн өрөөг зэрэг баталгаажуулахаас хамгаална.

`Availability` болон `Room readiness`-ийг тусдаа ойлголт болгон хадгална:

- **Availability:** Сонгосон ирээдүйн хугацаанд өөр hold, баталгаажсан booking эсвэл байрлалттай давхцахгүй байх.
- **Room readiness:** Бодит check-in агшинд өрөө `Цэвэр` байна. 25,000₮/30,000₮ багцын minibar-enabled өрөө ердийн үед `Бүтэн`; `Дутуу` бол зөвхөн Manager/Manager Plus-ийн хүчинтэй shortage override болон бодит эхний snapshot-тай байна. Minibar-disabled өрөөнд minibar readiness хамаарахгүй.

Ирээдүйн booking хийх үед өрөө одоо зочинтой эсвэл цэвэрлэгээ шаардлагатай байж болно. Харин өмнөх байрлалтын planned/actual дуусах цаг болон шинэ check-in хооронд snapshot хийсэн цэвэрлэгээний хугацаа багтах ёстой. Бодит check-in үед server time buffer-д хүрсэн эсвэл өнгөрсөн, actual cleaning state `Цэвэр`, applicable minibar readiness хангагдсан эсэхийг сервер дахин шалгана; хангаагүй бол Reception ижил ангиллын өөр өрөө оноох ажиллагаа шаардлагатай болно.

Early actual checkout нь buffer-ийг эрт эхлүүлж болох боловч existing confirmed next booking-ийг автоматаар урагшлуулахгүй. Late actual checkout buffer/readiness time-ийг хойшлуулна. `STAY-DEC-012` early automatic reprice/refund болон overdue automatic fee/penalty үүсгэхгүй; дараагийн booking conflict-ийг `STAY-DEC-013`-ын hard blocker/reassignment/hotel-cancellation урсгалаар шийднэ.

Future booking дээр minibar mode/template/version configuration-г pin хийхгүй. Existing booking pending room change-аас болж автоматаар cancel/reprice болохгүй. Check-in-ээс өмнө change `Applied`, `Cancelled` эсвэл `Rolled back` болсон бол тухайн үеийн current configuration-д заасан exact version-оор stay snapshot үүсгэнэ; дуусаагүй бол тухайн physical room-д check-in хийхгүй, booking-г өөр eligible room руу шилжүүлж болно.

Template entity-ийн `ACTIVE/RETIRING/INACTIVE` lifecycle нь version-ийн `DRAFT/PUBLISHED/ARCHIVED` lifecycle-ээс тусдаа. Нэг template-ийн олон Published version зэрэгцэн байж болох бөгөөд анхны Published version автоматаар цорын ганц Default болно; дараагийн publish одоогийн Default-ийг автоматаар солихгүй. `ARCHIVED` terminal/history-only, шинэ assignment-д ашиглагдахгүй, Published руу шууд сэргээхгүй бөгөөд дахин ашиглахдаа шинэ Draft clone үүсгэнэ. Publish хийхэд parent template entity болон бүх product тухайн hotel-ийн `ACTIVE`, дор хаяж нэг product-той, duplicate product-гүй, target quantity бүр эерэг бүхэл тоо байхыг сервер шалгана.

Default version-ийг archive хийхээс өмнө өөр eligible Published version-ийг Default болгоно. Exact version room current/pending, active stay эсвэл non-terminal reconciliation/Cleaner/configuration task-д reference-тэй бол archive хориглоно. Historical stay/report/price book/audit reference blocker биш бөгөөд хадгалагдана. Future booking minibar version pin хийдэггүй тул өөрөө archive blocker болохгүй.

`Publish`, `Set default`, `Archive` нь existing room current/pending, active stay, future booking, inventory/stock-ийг өөрчлөхгүй, Cleaner task, configuration request эсвэл check-in blocker үүсгэхгүй. Эдгээр үйлдэл болон exact-version Rollout-ийг зөвхөн идэвхтэй minibar entitlement + зөвшөөрөгдсөн role хийнэ: 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus; Hotel Admin дээрх role-ийг тусдаа авна. 20,000₮/entitlement-гүй үед хориглож, 25,000₮-д Manager Plus үүсгэж gate тойрохгүй.

Rollout target нь тухайн hotel-ийн ижил `ACTIVE` template entity-ийн бүх product нь `ACTIVE` exact `PUBLISHED` version байна; target Default байх албагүй. Eligible physical room нь lifecycle `ACTIVE`, minibar mode `ON`, target-аас өөр current version-тэй, non-terminal pending configuration-гүй байхыг Confirm дээр сервер дахин шалгана; mode/template switch нь Rollout биш, ердийн configuration change байна. Active stay-тай room сонгогдож болох бөгөөд confirm хийхэд exact target-тай room-level pending request болон check-in/assignment blocker атомикаар шууд үүснэ.

Safe/vacant room-д request `READY_FOR_RECONCILIATION` болж Cleaner reconciliation task шууд үүснэ. Active stay эсвэл checkout/payment/minibar report/refill дуусаагүй бол request `SCHEDULED_AFTER_STAY` болж existing safe point хангагдсаны дараа task үүснэ. Confirm нь current version, stock, price, stay price book эсвэл cleaning status-ийг өөрчлөхгүй; Cleaner reconciliation + existing P0-37B validation амжилттай үед apply атомик хийгдэнэ. Дараагийн Publish/Default exact target-ийг солихгүй, pending target Archive blocker байна. Existing future booking автоматаар cancel/reprice болохгүй боловч pending room availability/assignment/check-in-ээс хасагдана.

Multi-room Rollout нь нэг exact target version, нэг hotel/template-ийн олон room бүхий batch parent болон room бүрийн тусдаа child request ашиглана. Read-only preview room бүрийг `Одоо хийх боломжтой`, `Stay дууссаны дараа`, `Сонгох боломжгүй` гэж reason-тэй ангилах боловч availability, booking, pending request, blocker, task, movement эсвэл Archive eligibility-д side effect үүсгэхгүй. Confirm үед room бүрийг дахин шалгаж partial success хэрэглэнэ: accepted child pending request + check-in/assignment blocker-оо атомикаар авч шинэ availability/assignment-аас хасагдана; invalid room `SKIPPED` болж blocker авахгүй. Нэг child failure бусад child болон existing booking-ийг rollback/cancel/reprice хийхгүй.

Batch state child үр дүнгээс `IN_PROGRESS`, `COMPLETED`, `PARTIALLY_COMPLETED`, `CANCELLED`, `FAILED_VALIDATION` гэж бодогдоно. `Cancel remaining` movement эхлээгүй child-ийг цуцлан unblock хийнэ; movement эхэлсэн child existing rollback урсгалаар terminal болтол blocker-тэй, `APPLIED` room хэвээр байна. Буцаах бол шинэ Rollout үүсгэнэ. Retry нь `retry_of_batch_id`-тай шинэ batch бөгөөд хуучин түүхийг засахгүй.

Batch target exact ID-аар түгжигдэх тул дараагийн Publish/Default target-ийг солихгүй. Preview болон zero-accepted batch Archive blocker биш; confirmed non-terminal child/batch target version Archive blocker байна. Duplicate Confirm idempotent бөгөөд нэг room-д давхар pending, cross-hotel/cross-template room/target холбоос үүсэхгүй. Эрх нь 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus; Hotel Admin-д зөвшөөрөгдсөн role тусдаа шаардлагатай, 20,000₮ болон 25,000₮ багцын Manager Plus-д хориглоно. Reception batch/child/blocker-ийг read-only харж, Cleaner зөвхөн assigned child task гүйцэтгэнэ.

Ашиглагдсан/reference-тэй exact version-ийг booking/stay/configuration түүхээс устгахгүй. Canonical дүрэм: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md)-ийн RML-DEC-015–028.

Minibar room mode болон shortage override-ийн canonical дүрмийг [22-minibar-stock-inventory.md](./22-minibar-stock-inventory.md)-ээс үзнэ.

## 6. Бүртгэл ба нэвтрэлт

Зочин буудал, өрөө хайж харахын тулд нэвтрэх шаардлагагүй. `Захиалах` үйлдлээс цааш үргэлжлэхдээ дараах хоёр аргын аль нэгээр нэвтэрнэ.

### 6.1 e-Mongolia-аар бүртгүүлэх/нэвтрэх

- Зочныг e-Mongolia-ийн зөвшөөрөгдсөн authentication урсгал руу шилжүүлнэ.
- Зочин зөвшөөрсөний дараа систем зөвхөн гэрээ/API-аар зөвшөөрөгдсөн хамгийн бага мэдээллийг авна.
- e-Mongolia-аас авсан мэдээллийг утасны бүртгэлтэй адил гэж автоматаар таахгүй; provider subject/identifier-ээр account link хадгална.
- Access token, refresh token болон иргэний мэдээллийг URL, browser log эсвэл энгийн application log-д гаргахгүй.
- e-Mongolia ажиллахгүй үед утасны дугаарын бүртгэлийг нөөц сонголт болгон ашиглаж болно.

Яг авах талбар, consent, token lifecycle болон account холбох нөхцөлийг e-Mongolia-ийн албан ёсны гэрээ/API-ийн дараа батална.

### 6.2 Утасны дугаараар бүртгүүлэх

1. Зочин утасны дугаар оруулна.
2. Систем 6 оронтой, таах боломжгүй, хугацаатай OTP илгээнэ.
3. Зочин OTP-г зөв оруулж дугаар эзэмшиж буйгаа баталгаажуулна.
4. Шинэ хэрэглэгч өөрийн нууц үгийг зохионо.
5. Нууц үгийг эх утгаар нь хадгалахгүй, хамгаалалттай password hash ашиглана.
6. Дараагийн нэвтрэлтэд утас + нууц үг ашиглаж, нууц үг сэргээх болон эрсдэлтэй үйлдэлд шинэ OTP шаардана.

Утасны OTP нь зөвхөн тухайн дугаарыг ашиглах боломжтойг батална; хүний хууль ёсны хэн болохыг баталгаажуулсан гэж үзэхгүй. Check-in үед Reception-ийн ХУР/гараар баталгаажуулах ажиллагаа тусдаа үргэлжилнэ.

OTP илгээх, шалгах, нууц үг таах оролдлогыг IP, дугаар болон төхөөрөмжийн түвшинд хязгаарлана. OTP-ийн хүчинтэй минут, дахин илгээх зай болон оролдлогын тоог дараа батална.

### 6.3 Давхардсан account-аас хамгаалах

- Нэг баталгаажсан утасны дугаар нэг үндсэн account-тай байна.
- e-Mongolia account болон өмнөх утасны account нэг хүн болохыг баталгаажуулахгүйгээр автоматаар нийлүүлэхгүй.
- Account холбохдоо хоёр сувгийн хяналтыг баталгаажуулж, үйлдлийг аудитын түүхтэй хадгална.
- Нэвтрэх алдааны мэдэгдлээр тухайн утас бүртгэлтэй эсэхийг гаднын хүнд ил тод задлахгүй.

### 6.4 Account, захиалагч болон байрлах зочин

Дараах ойлголтыг хооронд нь автоматаар адилтгахгүй:

- **Account:** Системд нэвтэрч буй хэрэглэгчийн бүртгэл.
- **Booker:** Booking хийж, төлбөр төлсөн захиалагч.
- **Staying guest:** Буудалд бодитоор байрлах хүн.

Утасны OTP нь account/booker-ийн дугаарыг ашиглах боломжийг л батална. Booker болон staying guest өөр хүн байж болно. Check-in үеийн бодит staying guest-ийг Reception ХУР/XYP эсвэл батлагдсан гараар бүртгэх урсгалаар шалгана. ЦЕГ-тай холбоотой шалгалтыг booking account-ийн нэр/утаснаас бус, check-in дээр бүртгэсэн бодит зочны мэдээлэлд тулгуурлана (`BK-DEC-012`, `RC-DEC-044`).

## 7. Захиалгын үндсэн урсгал

1. Зочин огноо болон байршил сонгож буудал хайна.
2. Буудал, өрөөний зураг, үнэ болон availability харна.
3. Өрөөний ангилал сонгож `Захиалах` дарна.
4. Нэвтрээгүй бол e-Mongolia эсвэл утасны дугаараар бүртгүүлж/нэвтэрнэ.
5. Сервер хэрэглэгч, буудал, өрөөний ангилал, хугацаа, үнэ болон availability-г дахин шалгана.
6. Систем өрөөнд хугацаатай түр hold үүсгэж, booking төлбөрийн invoice/session үүсгэнэ.
7. Зочин платформ руу booking төлбөр төлнө.
8. Төлбөрийн үйлчилгээний server-to-server баталгаажуулалт амжилттай бол booking `Баталгаажсан` болно.
9. Зочинд захиалгын дугаар, дэлгэрэнгүй болон төлбөрийн баталгаа харагдана.
10. Буудлын Reception/Manager-д шинэ баталгаажсан online booking мэдэгдэнэ.
11. Check-in үед booking-г ашиглан `ONLINE` байрлалт үүсгэж, тусдаа барьцаа шаардахгүй.

8-р алхмын баталгаажуулалт нь online effective rate-ийн unit price, category/hotel source level ба ID, config version-ийг snapshot болгоно. 11-р алхам booking snapshot-ийг stay-д шилжүүлэн ашиглах бөгөөд room assignment тариф дахин бодох шалтгаан болохгүй.

Төлбөр баталгаажаагүй screenshot, browser redirect эсвэл хэрэглэгчийн хэлсэн мэдээллээр booking-г баталгаажуулахгүй.

## 8. Canonical booking/payment state axes

Нэг ерөнхий status талбарт booking, hold, payment, refund болон payout-ийг холихгүй:

| Тэнхлэг | Canonical төлөв |
| --- | --- |
| Booking | `HOLDING`, `CONFIRMED`, `CHECKED_IN`, `COMPLETED`, `EXPIRED`, `CANCELLED_GUEST`, `CANCELLED_HOTEL`, `NO_SHOW` |
| Hold | `ACTIVE`, `CONSUMED`, `EXPIRED`, `CANCELLED` |
| Payment | `PENDING`, `PAID`, `FAILED`, `EXPIRED` |
| Payment attempt | `ACTIVE`, `SUPERSEDED`, `PAID`, `FAILED`, `EXPIRED` |
| Refund | `NONE`, `REQUIRED`, `PENDING`, `PARTIALLY_REFUNDED`, `REFUNDED`, `FAILED` |
| Payout | `NOT_ELIGIBLE`, `ELIGIBLE`, `HELD`, `BATCHED`, `PAID`, `FAILED`, `ADJUSTMENT_DUE` |

`Гараар шалгах`, `Буцаалт хүлээж байгаа`, `Цуцлалт хүссэн` зэрэг UI label-ийг booking state болгон зохиохгүй; reconciliation task/refund axis-аас derive хийнэ. Transition бүр row/version lock, idempotency key, actor/reason болон immutable event-тэй байна (`PAY-DEC-005`–`009`).

## 9. Booking төлбөр, шимтгэл ба settlement

### 9.1 Батлагдсан бизнесийн чиглэл

- Зочны өрөөний booking төлбөр тухайн буудлын дансанд шууд орохгүй; платформын зориулалтын данс/merchant руу орно.
- Платформ идэвхтэй гэрээний шимтгэлийг суутгаж, үлдсэн дүнг тухайн буудалд шилжүүлнэ.
- 5% нь зөвхөн тооцооны жишээ бөгөөд системийн default/fallback хувь биш байна.
- Буудал бүрийн хүчинтэй гэрээнд commission rate-ийг заавал explicit утгаар батална. Хувь хүн/байгууллага болон тохиролцсон тарифаас хамаарч гэрээ бүр өөр хувьтай байж болно.
- Commission rate-гүй гэрээгээр online booking нийтлэх, төлбөр авах болон settlement үүсгэхгүй.
- Төлбөр баталгаажих үед ашигласан хувь болон тооцоолсон дүнг snapshot болгон хадгална. Дараа тариф өөрчлөгдсөн ч өмнөх booking өөрчлөгдөхгүй.

### 9.2 Суурь тооцоолол

```text
Gross booking amount = Зочны баталгаажсан нийт төлбөр
Commission amount = Commission base × Contract rate snapshot
Hotel net payout = Gross booking amount − Commission amount − Батлагдсан буцаалт/суутгал
Platform net revenue = Commission amount − Provider gateway fee
```

Бүх дүнг бүхэл төгрөгөөр хадгална. Contract rate-ийг integer basis point-оор snapshot хийж, commission-ийг `ROUND_HALF_UP` ашиглан бүхэл MNT-д нэг удаа тоймлоно (`PAY-DEC-008`).

Дараахыг тусад нь хадгална:

- booking/payment ID;
- hotel/contract ID;
- гэрээний төрөл: хувь хүн эсвэл байгууллага;
- tariff/version ID;
- commission rate snapshot;
- commission rate-ийг систем дотор basis point-оор хадгалж болно (`5% = 500 bps`);
- commission base;
- commission amount;
- gross paid amount;
- hotel net payout;
- payout status болон банкны гүйлгээний холбоос;
- refund/adjustment;
- үүсгэсэн болон баталгаажуулсан огноо/цаг.

### 9.3 Тусдаа мөнгөн урсгалууд

Дараах гурван урсгалыг нэг ledger/тайлангийн төрөл болгон холихгүй:

1. **Буудлын subscription төлбөр:** Буудал платформын багц ашигласны төлбөр.
2. **Online room booking төлбөр:** Зочин платформд төлж, платформ шимтгэл суутгаад буудалд settlement хийнэ.
3. **Restaurant захиалгын төлбөр:** Одоогийн батлагдсан дүрмээр Restaurant-ийн өөрийн QPay merchant-д шууд орно; платформ settlement хийхгүй.

### 9.4 Санхүүгийн ledger-ийн хамгаалалт

Төлбөр, commission, hotel payable, refund, adjustment болон payout-ийг booking-ийн нэг `үлдэгдэл` талбарыг дарж засах байдлаар хөтлөхгүй. Дараах event бүр тусдаа, өөрчлөгдөхгүй санхүүгийн мөр байна:

- payment баталгаажсан;
- commission үүссэн;
- hotel payable үүссэн;
- refund баталгаажсан;
- commission/payable залруулсан;
- payout эхлүүлсэн;
- payout амжилттай болсон эсвэл амжилтгүй болсон.

Алдаа засахдаа хуучин мөрийг устгахгүй, холбоостой эсрэг/залруулгын мөр үүсгэнэ. Ингэснээр gross, commission, refund болон net payout-ийг booking болон payout batch бүрээр тулгаж чадна.

Payment gateway-ийн шимтгэлийг платформын contract commission дотор нууцаар нэгтгэхгүй; `provider fee` гэж платформын тусдаа зардлаар бүртгэнэ.

Батлагдсан дүрмээр provider gateway fee-г платформ хариуцна. Иймээс уг fee-г hotel net payout-аас хасахгүй, зочны төлөх дүнд нэмэхгүй; платформын commission орлогоос зардал болгон тусад нь бүртгэнэ.

### 9.5 Батлагдсан settlement дүрэм

- Completed stay болон refund дууссан cancellation/no-show-ийн retained payable `PAY-DEC-009`-ын дагуу `D+1 12:00 Asia/Ulaanbaatar` batch-д орно.
- Commission base нь бодитоор retained хийсэн VAT-inclusive room charge; `ROUND_HALF_UP`, basis-point болон first-night fee-ийн дүрмийг `PAY-DEC-008` тодорхойлно.
- 24 цагаас дотогших cancellation/no-show, hotel-local cutoff болон inventory release-ийг `PAY-DEC-007` тодорхойлно.
- Provider/refund/reconciliation non-terminal бол payout `HELD`; payout дараах refund/chargeback immutable negative adjustment байна.
- Payout account нь production settlement эхлэхээс өмнө тухайн хүчинтэй гэрээний owner-той баталгаажсан байна.

Платформ өөрийн дансаар бусдын төлбөрийг хүлээн авч дараа шилжүүлэх тул production эхлэхээс өмнө төлбөрийн үйлчилгээ үзүүлэгчийн гэрээ, settlement боломж, буцаалтын API/ажиллагаа, татвар/баримт, нягтлан бодох болон хууль зүйн хариуцлагыг мэргэжлийн түвшинд баталгаажуулна.

## 10. Үнэ ба availability-ийн хамгаалалт

- Online nightly effective rate-ийг сервер `category override → hotel default` дарааллаар бодно; unset category утга hotel default-ийг өвлөнө, room override ашиглахгүй.
- Booking/stay overlap-ийг `[start, end)` interval-аар бодно; end exclusive боловч дараагийн start хүртэл snapshotted cleaning buffer багтсан байна.
- Actual checkout-оос өмнөх planning availability `planned checkout + snapshotted buffer`, дараах actual readiness `actual checkout + ижил snapshotted buffer` ашиглана. Check-in үед server time уг хугацаанд хүрсэн эсвэл өнгөрсөн, actual cleaning `Цэвэр`, applicable minibar readiness хангагдсан эсэхийг сервер дахин шалгана.
- Initial online-booking check-in default `actual_check_in_at = server_now`. Reception-ийн pre-confirm backdate нь 120 минут, current open shift, current hotel-local day болон booking planned start-ын хамгийн сүүлийн доод хязгаараас өмнө байхгүй; reason code-той байна.
- Backdate confirmation нь historical checkout + snapshotted buffer, historical actual readiness, `[actual, planned_checkout)` overlap, lifecycle/blocker, next booking + buffer болон `planned_checkout > server_now`-г сервер transaction-д дахин шалгана. Historical readiness нотлогдохгүй бол server-now сонголт өгнө.
- Paid online booking reprice болохгүй; room/minibar snapshot recorded-at current state ашиглана. Check-in-тэй холбоотой payment/cash current shift-д, Police matching recorded-at үед бүртгэгдэнэ.
- Active online stay/checkout эхлээгүй үед Reception mandatory reason-тэй actual-time correction request submit хийж болно; нэг pending request checkout initiation-ийг блоклоно.
- Manager approval fixed original-recorded-at/shift/day/online-planned-start bound болон unchanged planned checkout-аар historical readiness/overlap-ийг recheck хийнэ. Approved amendment зөвхөн effective actual start-ийг өөрчилж, paid booking price болон бусад snapshot/financial/Police timestamp-ийг өөрчлөхгүй (`STAY-DEC-010`).
- Confirmed online booking болон `ACTIVE` stay-ийн planned/effective end-ийг MVP-д direct overwrite эсвэл amendment-аар өөрчлөхгүй; change button/API/action, extension, shortening болон hourly ↔ nightly conversion байхгүй (`STAY-DEC-012`).
- Early/late actual checkout нь `actual_checkout_at`-д бодит цаг хадгалж original planned checkout болон price/payment/cash/config/stock snapshot-ийг өөрчлөхгүй. Early үед automatic reprice/refund, overdue үед automatic fee/penalty үүсэхгүй.
- Room actual checkout хүртэл occupied; actual checkout-оос хойш snapshotted buffer + actual cleaning + applicable minibar readiness gate үйлчилнэ. Overdue-next-booking conflict `STAY-DEC-013`-ын дагуу шийдэгдэнэ.
- Үнэ, stay type/хугацаа, commission болон нийт төлөх дүнг сервер бодно; client/Reception нэгж үнийг override хийхгүй.
- Төлбөр эхлэхэд authoritative quote үүсэж, төлбөр баталгаажихад unit price, source level/ID, config version, contract rate болон booking breakdown snapshot хадгална.
- Hold болон confirmed booking нь physical room бус `room_category_id`-ийн нэг capacity unit эзэлнэ; category capacity-аас overlapping active hold, confirmed booking болон active stay-г хасч, check-in үед physical room онооно.
- Payment hold нь сервер дээр үүссэн цагаас 10 минут хүчинтэй байна.
- Payment invoice/session-ийн expiry нь hold-ийн дуусах цагаас хэтрэхгүй.
- Сүүлийн өрөөнд хоёр хэрэглэгч зэрэг төлөхөд зөвхөн нэг hold/booking амжилттай байна.
- Hold хугацаа дуусвал inventory автоматаар суллагдаж, хуучин payment session-аар booking баталгаажихгүй.
- Hold дууссаны дараа төлбөр орсон бол booking-г дахин нээхгүй, inventory буцаан эзлэхгүй; payment `PAID`, refund `REQUIRED` болж бүтэн refund obligation үүснэ (`PAY-DEC-006`).
- Буудал/category/өрөөний үнэ өөрчлөгдсөн ч төлөгдсөн/баталгаажсан booking-ийн snapshot өөрчлөгдөхгүй.
- Check-in үед өөр физик room оноох буюу дахин оноох нь booking snapshot-ийг room override-аар reprice хийхгүй; snapshot price stay дээр үргэлжилнэ.
- Room/category `RETIRING` болмогц шинэ hold/booking-д availability-гаас хасагдана; өмнө confirmed booking автоматаар cancel/reprice болохгүй.
- Rollout confirm болон бусад эх үүсвэрээр үүссэн non-terminal minibar configuration change-тэй physical room шинэ availability/assignment-аас хасагдана; existing booking confirmed хэвээр бөгөөд minibar config booking үед pin болохгүй.
- Multi-room preview availability/booking-д нөлөөлөхгүй; Confirm-оор accepted child л pending/blocker авч availability-аас хасагдана, `SKIPPED` room blocker авахгүй.
- Retiring/inactive entity-д өмнө confirmed booking-ээр ч check-in хийхгүй; reactivate, active entity рүү шилжүүлэх эсвэл cancellation-аар resolve хийнэ.

## 11. Аюулгүй байдал ба өгөгдлийн хамгаалалт

- Буудал бүрийн inventory, booking, contract болон payout өгөгдлийг tenant-аар тусгаарлана.
- Нийтийн API-д буудлын дотоод өрөөний ID, зочны регистр, payout данс болон гэрээний хувийг ил гаргахгүй.
- Зочин зөвхөн өөрийн booking, payment болон profile-ийг харна.
- Manager/Reception зөвхөн өөрийн буудлын booking-г харна.
- Password, OTP, e-Mongolia token, payment credential болон payout дансны мэдээллийг log-д ил гаргахгүй.
- Нийтийн буудлын утас нь зөвхөн нийтэд харуулах бизнесийн дугаар байна.
- Байршил, нэвтрэлт, account link, үнэ, availability, booking, payment, commission, payout болон refund-ийн чухал үйлдэл аудитын түүхтэй байна.
- Hotel/category/room stay tariff edit болон booking confirmation price snapshot нь actor, source/config version, өмнөх/шинэ утга, огноо/цагаар аудитлагдана.
- Client-ийн `available`, `paid`, `price`, `commission` утгад итгэхгүй; сервер болон provider-оос баталгаажуулна.

## 12. Үнэлгээ ба сэтгэгдэл

- Буудлын дундаж үнэлгээ болон нийтлэгдсэн үнэлгээний тоо жагсаалт, дэлгэрэнгүй дээр харагдана.
- Нэвтрээгүй хэрэглэгч үнэлгээ харах боломжтой боловч шинэ үнэлгээ/сэтгэгдэл илгээхгүй.
- Нэвтэрсэн хэрэглэгч буудалд үнэлгээ болон сэтгэгдэл илгээх боломжтой байна.
- Review илгээх account нь тухайн буудлын `Дууссан/Check-out хийсэн` online booking-тэй байна.
- Нэг completed booking-ээр нэг review үүсгэнэ.
- Цуцлагдсан, no-show, төлбөргүй эсвэл check-out хийгдээгүй booking-ээр review үүсгэхгүй.
- Rating нь 1–5 бүхэл од байна; бутархай од зөвшөөрөхгүй.
- Comment заавал байх бөгөөд эхлэл/төгсгөлийн хоосон зайг хассаны дараа 10–1000 тэмдэгт байна.
- Review-г бодит check-out цагаас хойш 30 хоногийн дотор илгээнэ.
- Хэрэглэгч 30 хоногийн review цонх хаагдах хүртэл өөрийн rating/comment-ийг засаж болно.
- Хэрэглэгч өөрийн review-г хүссэн үедээ устгаж болох бөгөөд систем soft-delete хийнэ.
- Устгасан review нийтийн жагсаалт болон дундаж үнэлгээнд орохгүй, тухайн booking-ээр шинэ хоёр дахь review үүсгэхгүй.
- Review үүсгэх эрхийг зөвхөн UI дээр бус сервер талд session/account-аар шалгана.
- Үнэлгээ, сэтгэгдлийн нарийн ажиллагаа [10-hotel-ratings-reviews.md](./10-hotel-ratings-reviews.md)-д байна.

## 13. MVP acceptance criteria

- Утас болон laptop дээр responsive хайлт ашиглана.
- Зочин огноо, гараар сонгосон байршил эсвэл зөвшөөрсөн current location-оор буудал хайна.
- Location зөвшөөрөлгүй үед гараар хайх боломж хэвээр байна.
- Буудлын жагсаалтад зураг, бизнесийн утас, үнэ болон сонгосон хугацааны availability харагдана.
- Буудлын дэлгэрэнгүйд өрөөний зураг, үнэ болон `Захиалах` үйлдэл байна.
- Буудлын жагсаалт болон дэлгэрэнгүйд дундаж үнэлгээ, үнэлгээний тоо харагдана.
- Зөвхөн нэвтэрсэн хэрэглэгч үнэлгээ, сэтгэгдэл илгээж чадна.
- Completed booking-гүй account review үүсгэхгүй.
- Нэг booking-ээр нэгээс олон review үүсэхгүй.
- 1–5 бүхэл одноос өөр rating болон 10–1000 тэмдэгтийн хязгаараас гадуурх comment-ийг сервер хүлээн авахгүй.
- Check-out-оос хойш 30 хоног өнгөрсөн booking review илгээх эрхгүй байна.
- Review owner 30 хоногийн deadline хүртэл өөрийн review-г засаж чадна; бусдын review-г засахгүй.
- Soft-delete хийсэн review нийтийн жагсаалт/aggregate-аас хасагдаж, ижил booking-ээр дахин review үүсэхгүй.
- Нэвтрээгүй хэрэглэгч хайж болох боловч төлбөртэй захиалга батлахын өмнө нэвтэрнэ.
- e-Mongolia болон утасны 6 оронтой OTP гэсэн хоёр бүртгэл/нэвтрэх суваг байна.
- Утасны шинэ хэрэглэгч OTP баталгаажуулсны дараа нууц үгээ өөрөө тохируулна.
- Phone account нь утасны дугаар баталгаажсан төлөв болохоос иргэний identity баталгаажсан төлөв биш байна.
- Booking account/booker болон check-in хийх бодит зочны мэдээллийг тусад нь хадгална.
- Систем сервер талд үнэ, availability болон төлбөрийг баталгаажуулна.
- Online booking зөвхөн хоногоор; nightly rate-ийг category override → hotel default дарааллаар сервер бодож, room override ашиглахгүй.
- Unset category override hotel default-ийг өвлөж, хүчинтэй effective rate олдохгүй бол booking/payment confirmation хийхгүй.
- Booking confirmed болоход unit price, stay type, source level/ID болон config version snapshot хадгална.
- Тарифын дараагийн edit болон өөр room assignment paid/confirmed booking-г reprice хийхгүй; check-in stay booking snapshot-ийг ашиглана.
- Confirmed booking/`ACTIVE` stay-ийн planned/effective end-ийг MVP-д ямар ч amendment/action/button/API-аар өөрчлөхгүй; extension, shortening болон hourly ↔ nightly conversion байхгүй.
- Early/late actual checkout original planned checkout болон financial/config/stock snapshot-ийг өөрчлөхгүй. Early үед automatic reprice/refund, overdue үед automatic fee/penalty үүсэхгүй; actual checkout хүртэл room occupied байна.
- Actual checkout бүртгэгдсэний дараа P0-39A-ийн snapshotted buffer + actual cleaning + applicable minibar readiness хангагдаж байж room дахин ашиглагдана.
- `RETIRING/INACTIVE` room/category шинэ availability, hold болон booking-д орохгүй.
- Deactivation-оос өмнөх confirmed booking-г автоматаар cancel/reprice хийхгүй.
- Pending minibar configuration change-тэй physical room availability/assignment/check-in-д орохгүй; existing booking автоматаар cancel/reprice болохгүй.
- Minibar configuration-г booking үед pin хийхгүй; check-in үеийн current applied configuration-д заасан exact version-ийг ашиглана.
- `DRAFT` template version assignment/check-in-д ашиглагдахгүй; Published/default өөрчлөлт existing room/active stay-ийн exact version-ийг солихгүй, future booking-д config автоматаар pin/change хийхгүй.
- Анхны Published version автоматаар цорын ганц Default болж, дараагийн publish одоогийн Default-ийг солихгүй.
- Publish/Set default/Archive нь existing booking/room/stay, stock, Cleaner/configuration task болон check-in blocker-д side effect үүсгэхгүй; room version солих explicit Rollout тусдаа байна.
- Default, room current/pending, active stay эсвэл non-terminal task-д reference-тэй version archive болохгүй; historical reference болон version pin хийгдээгүй future booking blocker болохгүй.
- Per-room Rollout confirm тухайн eligible room-д exact `PUBLISHED` target-тай pending request болон check-in/assignment blocker-ийг шууд үүсгэх боловч existing booking-г cancel/reprice/config-pin хийхгүй.
- Active stay/unfinished checkout/payment/minibar report/refill-тэй room `SCHEDULED_AFTER_STAY` болж safe point хүртэл Cleaner task үүсэхгүй; safe/vacant room task-ийг шууд авна.
- Rollout confirm current version, stock, үнэ болон stay price book-ийг өөрчлөхгүй; Cleaner reconciliation + P0-37B validation амжилттай үед apply атомик байна.
- Later Publish/Default pending exact target-ийг солихгүй бөгөөд pending target Archive болохгүй.
- Multi-room preview room бүрийг now/scheduled/ineligible гэж reason-тэй харуулж side effect үүсгэхгүй; Confirm room бүрийг дахин шалган partial success хэрэглэнэ.
- Accepted child pending + blocker-оо атомикаар авч, invalid room `SKIPPED`/blocker-гүй байна; нэг child failure бусад room эсвэл existing booking-ийг rollback/cancel/reprice хийхгүй.
- Batch state child-үүдээс автоматаар бодогдож, `Cancel remaining` нь movement-free child-ийг unblock хийх боловч `APPLIED` room-ийг өөрчлөхгүй; Retry холбоостой шинэ batch байна.
- Confirmed non-terminal child/batch target Archive blocker, preview/zero-accepted batch blocker биш; duplicate Confirm болон нэг room-ийн давхар pending үүсэхгүй.
- Баталгаажсан booking Reception системд `ONLINE` эх үүсвэртэй харагдаж, check-in үед тусдаа барьцаа шаардахгүй.
- Booking төлбөр платформд орж, гэрээний commission snapshot хадгалагдана.
- Гэрээ бүр commission rate-ийн explicit утгатай; rate-гүй гэрээгээр online booking төлбөр авахгүй.
- Өрөөний payment hold 10 минут байна.
- QPay болон Khaan Bank gateway-ийн server-verified result л төлбөрийн authority; нэг мөчид нэг active attempt, provider/reference unique, callback idempotent байна.
- Hold expiry болон callback зэрэг ирвэл row lock авсан эхний valid transition ялна; expired booking дээрх late/duplicate payment бүтэн refund obligation болж booking-г сэргээхгүй.
- Gateway/provider fee-г платформ хариуцаж, hotel net payout болон зочны төлөх дүнд нэмэхгүй.
- Check-in-ээс 24 ба түүнээс олон цагийн өмнө цуцалбал бүтэн refund хийх cancellation framework байна.
- 24 цагаас дотогших cancellation болон no-show first-night fee, hotel-local cutoff, refund болон inventory release `PAY-DEC-007`-ыг мөрдөнө.
- Hotel net payout болон платформын commission тусдаа ledger/тайлантай байна.
- Restaurant төлбөрийг online room booking settlement-тэй холихгүй.

## 14. Одоогоор бүртгэсэн Booking шийдвэрүүд

### BK-DEC-001 — Нийтийн хайлт

- **Төлөв:** Захиалагчийн өгсөн шаардлага
- **Шийдвэр:** Зочин огноо, байршил эсвэл төхөөрөмжийн зөвшөөрсөн current location ашиглан ойрхон буудал хайж, зураг, үнэ, availability болон бизнесийн утсыг харна.

### BK-DEC-002 — Booking authentication

- **Төлөв:** Захиалагчийн өгсөн шаардлага
- **Шийдвэр:** Зочин хайлт болон дэлгэрэнгүйг нэвтрэхгүй харж болох боловч захиалга хийхдээ e-Mongolia эсвэл утасны дугаараар нэвтэрнэ. Шинэ утасны account 6 оронтой OTP-оор дугаараа баталгаажуулж, нууц үгээ өөрөө тохируулна.

### BK-DEC-003 — Платформоор дамжих booking төлбөр

- **Төлөв:** Батлагдсан; settlement `PAY-DEC-009`-өөр хаагдсан
- **Шийдвэр:** Online room booking-ийн төлбөр платформд орж, тухайн буудлын хүчинтэй гэрээний commission rate-аар шимтгэл суутгасны дараа hotel payable үүснэ. Хувь хүн/байгууллага болон гэрээний тарифаас хамаарч хувь өөр байна; retained дүнгийн settlement-ийг `PAY-DEC-008/009` мөрдөнө.

### BK-DEC-004 — Буудлын үнэлгээ ба сэтгэгдэл

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Нэвтэрсэн хэрэглэгч буудалд үнэлгээ болон сэтгэгдэл үлдээх боломжтой байна. Нэвтрээгүй хэрэглэгч нийтлэгдсэн үнэлгээ, сэтгэгдлийг харах боловч илгээх үйлдэл хийхгүй.

### BK-DEC-005 — Verified-stay review

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Зөвхөн тухайн буудлын `Дууссан/Check-out хийсэн` online booking-тэй нэвтэрсэн account тухайн booking-ээр нэг удаа review өгнө. Цуцлагдсан, no-show, төлбөргүй болон check-out хийгдээгүй booking review эрх үүсгэхгүй. Эрх болон давхардлыг сервер/database түвшинд шалгана.

### BK-DEC-006 — Review input ба хугацаа

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Rating нь 1–5 бүхэл од, comment нь заавал бөгөөд trim хийсний дараа 10–1000 тэмдэгт байна. Review-г тухайн booking-ийн бодит check-out цагаас хойш 30 хоногийн дотор илгээнэ. Rating, comment болон deadline-ийг сервер илгээх агшинд дахин шалгана.

### BK-DEC-007 — Review засах ба soft-delete

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Review owner тухайн booking-ийн check-out-оос хойших 30 хоногийн review цонх хаагдах хүртэл rating/comment-оо засаж болно. Өөрийн review-г хүссэн үедээ soft-delete хийж болох бөгөөд нийтийн жагсаалт, review count болон дундаж үнэлгээнээс хасна. Soft-delete хийсэн review-г hard-delete хийхгүй, ижил booking-ээр шинэ review үүсгэхгүй. Засвар/устгал бүр аудитын түүхтэй байна.

### BK-DEC-008 — Гэрээ бүрийн commission rate

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Online Booking commission нь тогтмол 5% default биш байна. Буудал бүрийн хүчинтэй гэрээнд хувь хүн/байгууллага болон тохиролцсон тарифт нийцсэн commission rate-ийг explicit батална. Төлбөрийн агшинд rate/policy version snapshot хадгална; rate байхгүй бол online booking төлбөр авахгүй.

### BK-DEC-009 — 10 минутын payment hold

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Өрөө сонгон төлбөр эхлүүлэхэд 10 минутын inventory/payment hold үүснэ. Invoice/session уг hold-оос урт хүчинтэй байхгүй. Хугацаанд төлбөр баталгаажаагүй бол inventory-г суллаж, хоцорсон төлбөрийг автоматаар booking болгохгүй.

### BK-DEC-010 — Cancellation ба no-show framework

- **Төлөв:** `PAY-DEC-007/008`-аар хаагдсан
- **Шийдвэр:** Check-in-ээс 24+ цагийн өмнө бүтэн refund; 24 цагаас дотогших cancellation болон arrival date-ийн 23:59:59-оос хойш баталсан no-show first-night fee retained хийж үлдсэнийг refund хийнэ. Retained fee-д contract commission бодно; terminal transition дээр inventory сулрана.

### BK-DEC-011 — Gateway fee

- **Төлөв:** Батлагдсан
- **Шийдвэр:** QPay/банкны payment gateway/provider fee-г платформ хариуцна. Hotel net payout-аас хасахгүй, зочны төлөх дүнд нэмэхгүй; платформын commission орлогоос тусдаа зардлын мөрөөр бүртгэнэ.

P0-38A-ийн online quote, confirmation snapshot болон check-in reprice хоригийг canonical `STAY-DEC-005`-аар мөрдөнө. P0-38B-ээр Manager-ийн configurable minimum/maximum/increment нэмэхгүй, walk-in fractional precision-ийг `STAY-DEC-014` мөрдөнө. P0-38C-ийн эерэг бүхэл nights, hotel-local planned checkout, nightly total, availability/cleaning recheck, snapshot/no-mutation дүрмийг `STAY-DEC-007`-оор мөрдөнө; early-morning cutoff түр хойшлогдсон. Online booking `BK-DEC-012`-ын дагуу зөвхөн хоногоор байна.

P0-39A-ийн `[start, end)` interval, planned/actual checkout-аас эхлэх snapshotted cleaning buffer, нийлмэл actual readiness, early/late checkout-ийн non-financial нөлөө болон server-authoritative validation-ийг `STAY-DEC-008`-аар мөрдөнө. Early checkout confirmed booking-ийг автоматаар урагшлуулахгүй; `STAY-DEC-012`-оор early automatic reprice/refund болон overdue automatic fee/penalty байхгүй. Next-booking conflict-ийг `STAY-DEC-013` шийднэ.

P0-39B-1-ийн initial actual check-in, 120 минут/shift/day/online-start bound, historical validation, recorded-at snapshot, current-shift cash, Police timing, immutable timestamps болон audit дүрмийг `STAY-DEC-009`-өөр мөрдөнө. Check-in activation-аас хойших direct edit хориг хэвээр, approved correction нь `STAY-DEC-010` immutable amendment ашиглана.

P0-39B-2 active-stay correction request/approval, fixed original boundary, immutable amendment/effective time, checkout blocker, unchanged booking/price/snapshot/Police timestamps болон guest registry үр дүнг `STAY-DEC-010`-аар мөрдөнө.

P0-39C-1-ийн confirmed booking/active stay planned checkout direct-overwrite guard-ийг `STAY-DEC-011`-ээр хэвээр мөрдөнө. P0-39C-2-ын MVP planned/effective end no-change, early/late actual checkout, no automatic early refund/reprice or overdue fee, occupied-until-actual-checkout болон unchanged snapshot дүрмийг `STAY-DEC-012`-оор мөрдөнө. Amendment/change/extension/shortening/conversion байхгүй.

### BK-DEC-012 — MVP booking shape ба booker/staying guest

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Online booking зөвхөн хоногоор; `1 booking = 1 room category-ийн 1 room = 1 үндсэн staying guest`. Booker болон staying guest өөр хүн байж болно. Booker account/contact booking дээр, бодит үндсэн зочны identity check-in дээр тусдаа хадгалагдана. Хамт байрлагчдыг MVP-д тусад нь бүртгэхгүй. Confirmed date/duration edit хийхгүй; өөрчлөх бол cancel + new booking.

### BK-DEC-013 — Category inventory ба physical room assignment

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hold/confirmed booking нь нэг `room_category_id` capacity unit эзэлж, physical room-ийг Reception check-in дээр онооно. Availability нь eligible ACTIVE physical room capacity-аас overlapping active hold, confirmed booking болон stay-г хасч бодогдоно. Hold, payment confirmation болон assignment бүр server transaction/lock-оор дахин шалгагдана; check-in үед category reservation active stay occupancy-д атомикаар шилжиж давхар тоологдохгүй.

### BK-DEC-014 — Overbooking/hotel-caused fulfillment failure

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Check-in үед эхлээд ижил category room, дараа нь Manager/Manager Plus-ийн нэмэлт төлбөргүй higher-category room санал болгоно. Eligible room байхгүй бол Manager/Manager Plus `CANCELLED_HOTEL` болгож бүтэн refund obligation үүсгэнэ; commission `0`, gateway fee платформын зардал, inventory terminal transaction дээр сулрана. Өөр hotel руу relocation/compensation MVP-д байхгүй. Date change нь cancel + new booking.

## 15. Online booking P0 хаагдсан төлөв

Booking shape/booker, category inventory, gateway/hold/late callback, cancellation/no-show, commission/settlement, inventory release, overdue conflict болон hotel-caused overbooking `BK-DEC-012`–`014`, `PAY-DEC-005`–`009`, `STAY-DEC-013`-аар хаагдсан. Early-morning cutoff MVP-ээс хойшлуулсан. Search radius, guest OTP config болон production provider/legal гэрээнүүд P1/EXT хэвээр байна.
