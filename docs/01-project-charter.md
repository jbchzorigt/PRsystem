# Hotel Booking System — Төслийн суурь тодорхойлолт

**Хувилбар:** 0.35  
**Төлөв:** Ноорог — шаардлагууд хэсэгчлэн; P0-37 Room–Minibar lifecycle, P0-38 stay pricing/config болон P0-39A–C-2 stay timing хамгаалалт батлагдсан  
**Баримт бичгийн үе шат:** Шаардлага тодорхойлох

## 1. Төслийн зорилго

Улаанбаатар хотод үйл ажиллагаа явуулдаг том, жижиг зочид буудлуудын өдөр тутмын үйл ажиллагааг нэг системээр удирдах боломж бүрдүүлэхийн зэрэгцээ хуульд заасан үндэслэл, эрх бүхий байгууллагын баталгаажуулсан мэдээлэлд тулгуурлан эрэн сурвалжлагдаж буй эсвэл шалгах шаардлагатай этгээд зочид буудлаар үйлчлүүлж байгаа тохиолдлыг илрүүлэхэд Цагдаагийн ерөнхий газарт дэмжлэг үзүүлэх систем байгуулна.

> **Нэр томьёоны анхааруулга:** Эцсийн шийдвэр гарахаас өмнө хүнийг шууд “гэмт этгээд” гэж тодорхойлохгүй. Системийн баримт бичигт хууль зүйн статуст нийцсэн “эрэн сурвалжлагдаж буй этгээд”, “шалгах шаардлагатай этгээд” зэрэг нэр томьёог ЦЕГ болон хууль зүйн мэргэжилтэнтэй баталгаажуулсны дараа хэрэглэнэ.

## 2. Системийн ерөнхий хэлбэр

Систем нь олон зочид буудал ашиглах боломжтой, төлбөрт үйлчилгээний загвартай платформ байна. Зочид буудал тус бүр өөрийн бүртгэл, ажилтан, өрөө, орлого, зарлага болон үйлчилгээний мэдээллээ бусад буудлаас тусгаарлан удирдана.

## 3. Үндсэн оролцогч талууд

- **Платформын оператор:** Системийг ажиллуулах, үйлчилгээний багц болон зочид буудлын бүртгэлийг удирдах тал.
- **Operation Admin:** Систем ашиглаж буй буудал, сонгосон багц, subscription-ийн хугацаа болон үйлчилгээний SMS сануулгыг удирдах платформын эрх бүхий дотоод хэрэглэгч.
- **Зочид буудлын эзэмшигч буюу захиалагч:** Байгууллага эсвэл хувь хүн хэлбэрээр бүртгүүлж, сонгосон багцын дагуу систем ашиглана.
- **Зочид буудлын ажилтан:** Менежер, ресепшн, цэвэрлэгч зэрэг өөр өөр эрхтэй хэрэглэгч.
- **Зочин:** Зочид буудалд байрлах, үйлчилгээ авах хувь хүн.
- **Рестораны түнш:** Зөвшөөрөгдсөн багцын хүрээнд хоол, уух зүйл болон цэсээ удирдах байгууллага, ажилтан.
- **Цагдаагийн ерөнхий газар:** Хуульд зөвшөөрсөн хүрээнд шалгалт, мэдэгдлийн процесст оролцох эрх бүхий байгууллага.
- **Гадаад үйлчилгээ үзүүлэгчид:** QPay, Хаан Банкны төлбөрийн гарц, e-Mongolia, ХУР/XYP, CallPro Text SMS API болон газрын зураг, байршлын үйлчилгээ.

## 4. Одоогоор тодорхой болсон өндөр түвшний хамрах хүрээ

- Зочид буудлыг байгууллага болон хувь хүнээр бүртгэх.
- Бүртгэлийн мэдээлэл бүрэн байсан ч төлбөр баталгаажаагүй үед бодит hotel account, subscription болон анхны Hotel Admin activation үүсгэхгүй; зөвхөн provider/server баталгаажуулсан амжилттай төлбөрийн дараа үүсгэх.
- Зочид буудлын байршлыг газрын зураг ашиглан бүртгэх.
- Үйлчилгээний багц болон ашиглах хугацаа сонгох, төлбөр төлөх.
- Зочид буудлын ажилтнуудыг үүрэг, эрхээр бүртгэх.
- Өрөө, минибар, орлого, зарлага, төлбөрийн задаргаа болон тайлан удирдах.
- Тухайн буудлын Hotel Admin болон Manager бүртгэлтэй зочдын байрлалтын жагсаалтыг pagination-аар харах, зөвшөөрөгдсөн багануудаар Excel файл татах.
- Сонгосон багцад рестораны мэдээлэл, ажилтан болон цэс удирдах.
- Зочин web системээс огноо, байршил болон төхөөрөмжийн одоогийн location ашиглан буудал хайх, өрөөний зураг, үнэ, боломжит төлөв харах, бүртгүүлж төлбөр төлөн онлайн захиалга хийх.
- Нэвтэрсэн хэрэглэгч буудалд үнэлгээ, сэтгэгдэл үлдээж, нийтийн booking хэрэглэгчид буудлын үнэлгээг харах.
- Онлайн booking-ийн төлбөрийг платформ хүлээн авч, гэрээний шимтгэлийг суутгасны дараа буудалтай settlement хийх.
- Зочны мэдээллийг хуульд зөвшөөрсөн процессоор баталгаажуулах, шаардлагатай тохиолдолд ЦЕГ-тай холбоотой хяналт, мэдэгдлийн урсгал ажиллуулах.
- Цагдаагийн тусгаарлагдсан portal-д эрэн сурвалжлах бүртгэл хөтлөх, буудлын үндсэн үйлчлүүлэгчийн регистртэй match үүсэхэд эрх бүхий цагдаагийн алба хаагчид alert хүргэх, dashboard болон зөвшөөрөгдсөн Excel тайлан гаргах.
- Платформын Operation Dashboard-д систем ашиглаж буй буудал, сонгосон багц, ашиглах эрхийн дуусах хугацааг хянаж, subscription/service сануулгыг SMS-ээр илгээх.

## 5. Суурь таамаглал

- Зочид буудал бүр систем дотор тусдаа өгөгдлийн орон зайтай байна.
- ЦЕГ-тай мэдээлэл солилцох ажиллагаа нь албан ёсны эрх, гэрээ, API болон хууль зүйн зөвшөөрөлд тулгуурлана.
- Цагдаагийн мэдээллийн сан, hotel guest мэдээлэл болон commercial booking өгөгдлийг тусдаа эрхийн хилтэй байлгана. Буудлын хэрэглэгчид эрэн сурвалжлах сан болон match төлөвийг харахгүй.
- e-Mongolia-г booking хэрэглэгчийн бүртгэл/нэвтрэлтэд ашиглах чиглэл тодорхой болсон боловч авах өгөгдөл, зөвшөөрөл болон интеграцийн яг үйлчилгээ баталгаажаагүй.
- ХУР/XYP-ээр check-in үеийн иргэний мэдээлэл баталгаажуулах ажиллагааны яг үйлчилгээ, зөвшөөрөл баталгаажаагүй.
- Платформ зочны booking төлбөрийг төвлөрүүлж буудалд шилжүүлэх санхүүгийн загвар нь төлбөрийн үйлчилгээ үзүүлэгч, гэрээ, татвар, нягтлан бодох болон хууль зүйн тусдаа баталгаажуулалт шаардана.

## 6. Батлагдсан эхний чиглэл

MVP-ийн шаардлагыг дөрвөн уялдсан үндсэн системээр тодорхойлно:

1. **Reception дотоод систем:** Зочны бүртгэл, check-in/check-out, өрөөний төлөв, төлбөр тооцоо болон ээлж хүлээлцэх ажиллагаа.
2. **Online Booking систем:** Зочин буудал/өрөө хайх, бүртгүүлэх, төлбөр төлөх, захиалгаа удирдах болон баталгаажсан захиалгыг Reception системд дамжуулах ажиллагаа.
3. **Цагдаагийн хяналтын систем:** Эрэн сурвалжлах бүртгэл, хамгаалагдсан match, alert, Police dashboard болон эрх бүхий тайлангийн ажиллагаа.
4. **Operation Dashboard:** Платформ ашиглаж буй буудал, багц, subscription хугацаа болон SMS сануулгын ажиллагаа.

Хөгжүүлэлтийн дарааллыг баримт бичгүүд эцэслэн батлагдсаны дараа тогтооно. Restaurant-ийн MVP order/payment/refund/handoff суурь дүрэм батлагдсан; menu add-on зэрэг P1 нарийвчлал тусдаа үлдсэн.

Нээлттэй шийдвэр, гаднын хамаарал болон MVP-ээс хойшлуулсан ажлын нэгдсэн бүртгэлийг [00-mvp-open-decisions.md](./00-mvp-open-decisions.md)-д хөтөлнө.

Hotel onboarding, төлбөрөөр activation нээх болон анхны Hotel Admin account-ийн урсгалыг [15-hotel-onboarding-account-activation.md](./15-hotel-onboarding-account-activation.md)-д тодорхойлно.

Subscription-ийн сарын суурь үнэ, 1/3/7/12 сарын нийт төлбөр болон price snapshot-ийн дүрмийг [16-subscription-pricing-and-payment.md](./16-subscription-pricing-and-payment.md)-д тодорхойлно.

Subscription-ийн upgrade-only бодлого, package floor болон хугацаа дуусах үеийн эрхийг [17-subscription-lifecycle.md](./17-subscription-lifecycle.md)-д тодорхойлно.

Бүх role-ийн action-level permission, package/subscription gate болон Hotel/Operation/Police эрхийн хилийг [18-action-level-permission-matrix.md](./18-action-level-permission-matrix.md)-д canonical байдлаар тодорхойлно.

Hotel/Restaurant staff invitation, activation, password reset, role/suspension, Primary Hotel Admin болон session lifecycle-ийг [19-staff-account-lifecycle.md](./19-staff-account-lifecycle.md)-д тодорхойлно.

Reception-ийн deposit авах/суутгах/буцаах суваг, POS reference, refund status болон immutable financial correction-ийг [20-deposit-and-payment-correction.md](./20-deposit-and-payment-correction.md)-д тодорхойлно.

Reception-ийн ээлж хүлээлцэх, operational/review төлөв, нэг ажилтантай self-close, actual opening balance болон immutable shift correction-ийг [03-reception-shift-handover.md](./03-reception-shift-handover.md)-д canonical байдлаар тодорхойлно.

Default/multiple cash drawer, optional safe, initial actual opening, typed movement, paid expense execution, transfer/withdrawal/top-up болон effective-date physical correction-ийг [24-cash-drawer-ledger.md](./24-cash-drawer-ledger.md)-д canonical байдлаар тодорхойлно.

Cleaner minibar тайлан заавал байх нөхцөл, Manager-ийн онцгой тайлан, тайлангийн хувилбар/төлбөрийн түгжээ, зочны маргаан болон төлбөрийн дараах adjustment-ийг [21-cleaner-checkout-exception-and-dispute.md](./21-cleaner-checkout-exception-and-dispute.md)-д тодорхойлно.

Minibar-ын warehouse/room stock, immutable movement, weighted average cost, optional room mode болон `Дутуу minibar-тайгаар нээх` Manager exception-ийг [22-minibar-stock-inventory.md](./22-minibar-stock-inventory.md)-д тодорхойлно.

Minibar-enabled check-in үеийн stay price book, active stay-ийн locked selling price, Cleaner/Manager report, refill болон correction-д ашиглах үнийг [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md)-д canonical байдлаар тодорхойлно.

Room/category/minibar product/template entity-ийн `ACTIVE → RETIRING → INACTIVE` lifecycle, template version-ийн тусдаа `DRAFT → PUBLISHED → ARCHIVED` lifecycle, active stay/future booking хамгаалалт, hard-delete/reactivation, мөн нэг room-ийн exact version-тэй `current + pending` minibar configuration, Cleaner reconciliation, check-in blocker болон rollback дүрмийг [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md)-д canonical байдлаар тодорхойлно.

Цагаар болон хоногоор байрлуулах room тарифын тусдаа шатлал, Walk-in/Online эх үүсвэрийн ялгаа, серверийн authoritative rate resolution, баталгаажсан үнэ snapshot, олон шөнийн төлбөр, тогтсон check-out цагаарх planned checkout, хугацааны interval, cleaning buffer/readiness, initial actual check-in/backdate, active-stay immutable correction, confirmed/active planned-end direct-overwrite хамгаалалт болон MVP no-change дүрмийг [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md)-д canonical байдлаар тодорхойлно.

P0-37C-2A-аар Publish/Default дүрмийг баталсан: Publish үед `ACTIVE` parent template, тухайн hotel-ийн дор хаяж нэг давхардалгүй `ACTIVE` product, бүтээгдэхүүн бүрийн эерэг бүхэл target quantity-г сервер шалгана; анхны Published version цорын ганц Default болж, дараагийн publish одоогийн Default-ийг солихгүй. `Publish` болон `Set default` нь existing room current/pending, active stay, booking, inventory/stock-д өөрчлөлт хийхгүй, Cleaner task эсвэл check-in blocker үүсгэхгүй. Эдгээр үйлдэл 25,000₮ багцад Manager, 30,000₮ багцад Manager эсвэл Manager Plus-д зөвшөөрөгдөнө; Hotel Admin тохирох тусдаа Manager/Manager Plus role-гүйгээр хийхгүй. Canonical шийдвэр нь RML-DEC-018–020.

P0-37C-2B-1-ийн RML-DEC-021-ээр зөвхөн Default биш exact `PUBLISHED` version-ийг Archive хийнэ. Room-ийн current/pending reference, active stay эсвэл nonterminal reconciliation/Cleaner/configuration task байвал хориглоно; historical stay/report/price-book/audit reference-ийг хадгалах боловч blocker болгохгүй. Archive нь existing room/pending/stay/booking pointer, price snapshot, warehouse/room stock movement, Cleaner task, configuration request эсвэл check-in blocker-т side effect үүсгэхгүй; future booking version pin-гүй тул Archive-г хориглохгүй, өөрчлөгдөхгүй. `ARCHIVED` terminal бөгөөд дахин ашиглах бол шинэ `DRAFT` руу clone хийнэ. Эрх нь хүчинтэй entitlement-тэй 25,000₮ багцын Manager, 30,000₮ багцын Manager/Manager Plus; Hotel Admin тохирох зөвшөөрөгдсөн role-ийг тусдаа авна, package gate-ийг role-оор тойрохгүй.

P0-37C-2B-2-ийн RML-DEC-022–024-өөр Manager ижил template-ийн exact `PUBLISHED` target version-ийг сонгож, `ACTIVE`, minibar идэвхтэй, target-аас өөр current version-тэй, өөр pending өөрчлөлтгүй eligible room-д explicit Rollout батална. Per-room Confirm хийхэд тухайн room-ийн exact pending configuration request болон check-in/assignment blocker шууд үүсэх боловч stock, үнэ, current version pointer өөрчлөгдөхгүй. Safe point-д байгаа room-д Cleaner reconciliation task шууд үүснэ; active stay эсвэл дуусаагүй checkout/payment/report/refill-тэй room нь stay-ийн дараах safe point хүртэл хүлээгээд task үүсгэнэ. Target exact version ID-аар түгжигдэх тул дараа нь Default өөрчлөгдсөн ч Rollout target солигдохгүй. Эрх нь хүчинтэй entitlement-тэй 25,000₮ багцын Manager, 30,000₮ багцын Manager/Manager Plus; Hotel Admin тохирох тусдаа operational role-гүйгээр хийхгүй.

P0-37C-3-ийн RML-DEC-025–028-аар multi-room Rollout-ийг баталсан. Нэг exact target version-тэй read-only preview нь room бүрийг одоо хийх, stay дууссаны дараа хийх эсвэл шалтгаантайгаар сонгох боломжгүй гэж ангилах боловч request, blocker, task эсвэл өөрчлөлт үүсгэхгүй. Confirm үед room бүрийг дахин шалгаж, eligible room бүрд тусдаа child request/blocker үүсгэн reconciliation-ийг бие даалгана; eligible биш room `SKIPPED` болж шалтгаанаа хадгална, нэг room-ийн алдаа бусдыг rollback хийхгүй. Batch progress нь child үр дүнгээс бодогдоно. `Cancel remaining` нь эхлээгүй child-ийг цуцалж, movement эхэлснийг compensating rollback-д оруулах боловч `APPLIED` room-ийг буцаахгүй; retry нь хуучин audit-ийг өөрчлөхгүй шинэ холбоостой batch байна. Exact target pin хадгалагдаж, nonterminal child-тай version Archive болохгүй. Эрх нь хүчинтэй entitlement-тэй 25,000₮ багцын Manager, 30,000₮ багцын Manager/Manager Plus; Hotel Admin тохирох тусдаа operational role-гүйгээр хийхгүй.

Ингэснээр P0-37A–P0-37C-ийн Room–Minibar entity, configuration, template version, Publish/Default, Archive, single-room болон multi-room Rollout lifecycle (RML-DEC-001–028) бүрэн хаагдсан.

P0-38A-ийн `STAY-DEC-005`-аар room тарифын эх үүсвэр ба snapshot-ийг баталсан. Цагийн болон хоногийн тариф тусдаа байна. Walk-in үед `room override → category override → hotel default`, Online quote үед `category override → hotel default` дарааллаар сервер хүчинтэй үнийг олно; тохируулаагүй override дараагийн түвшнээ өвлөнө. Online quote room override ашиглахгүй. Paid/confirmed booking-ийн unit price, source level + source ID болон configuration version snapshot хадгалагдаж, өрөө оноох/check-in хийх эсвэл дараа тариф засахад reprice болохгүй. Reception үнэ гараар өөрчлөхгүй. Тарифыг бүх багцын Manager тохируулж, Hotel Admin хийх бол Manager role тусдаа авна; өөрчлөлт бүр аудиттай байна.

P0-38B-ийн `STAY-DEC-006`-аар цагийн minimum, maximum болон increment-ийн шинэ тохиргоо нэмэх саналыг хэрэгжүүлэхгүй гэж хаасан. Өмнөх `STAY-DEC-002` хэвээр мөрдөгдөж, цагийн өрөөний төлбөрийг `effective нэг цагийн үнэ × Reception-ийн сонгосон цагийн тоо` томьёогоор тооцно. Manager-д хугацааны minimum/maximum/increment тохируулах шинэ action эсвэл field нэмэхгүй.

P0-38C-ийн `STAY-DEC-007`-оор хоногийн байрлалтын `N` нь эерэг бүхэл шөнийн тоо байна. Planned checkout-ийг буудлын local timezone дахь check-in календарийн огноо дээр `N` календарийн өдөр нэмээд, баталгаажуулах үед snapshot хийсэн тухайн буудлын тогтсон check-out цагт тогтооно. Check-in нь check-out цагаас өмнө байсан ч нэг шөнө маргаашийн check-out цагт дуусна; тухайн өдрийн check-out хүртэлх богино байрлалтыг цагаар бүртгэнэ. Хоногийн өрөөний төлбөр `effective нэг шөнийн үнэ × N` байна. Сервер дараагийн booking болон cleaning buffer-тэй давхцлыг дахин шалгаж, шөнийн тоо, effective unit rate/source/config version, тогтсон check-out цаг болон planned checkout-ийг snapshot хадгална. Дараагийн тариф/check-out config edit нь confirmed booking болон active stay-г өөрчлөхгүй. Early-morning cutoff-ийг энэ шийдвэрт нэмээгүй, түр хойшлуулсан. Ингэснээр P0-38A–C бүрэн хаагдсан.

P0-39A-ийн `STAY-DEC-008`-аар booking/stay хугацааг төгсгөлөө оруулахгүй `[start, end)` interval-аар тооцно. Actual checkout бүртгэгдэхээс өмнө төлөвлөлтийн хамгийн эрт бэлэн болох цаг нь `planned_checkout + snapshotted cleaning buffer`, харин actual checkout бүртгэгдсэний дараа `actual_checkout + ижил snapshotted cleaning buffer` байна. Өрөөг дахин ашиглахын тулд server time уг хугацаанд хүрсэн эсвэл өнгөрсөн, бодит cleaning state `Цэвэр`, мөн тухайн өрөөнд хамаарах existing minibar readiness зэрэг хангагдана. Early checkout дараагийн confirmed booking-ийг автоматаар урагшлуулахгүй; late checkout buffer-ийг хойшлуулна. `STAY-DEC-012` early actual checkout-д automatic reprice/refund, overdue-д automatic fee/penalty үүсгэхгүй гэж хаасан. `STAY-DEC-013` overdue conflict-ийг unique alert, hard blocker, same/higher-category reassignment эсвэл hotel-caused cancellation + бүтэн refund-аар шийднэ. Давхцал/readiness-ийг сервер authoritative байдлаар шалгана.

P0-39B-1-ийн `STAY-DEC-009`-өөр initial check-in confirmation-ийн default `actual_check_in_at` нь server time байна. Reception зөвхөн confirmation-оос өмнө 120 минут хүртэлх өнгөрсөн цаг сонгож болох бөгөөд доод хязгаар нь `max(server_now − 120 минут, current open shift start, hotel local day start, confirmed online booking-ийн planned check-in)` байна. Backdate нь reason code-той, optional note-той боловч Manager approval/нотолгоо шаардахгүй. Сервер `[actual_check_in_at, planned_checkout_at)` overlap, түүхэн checkout + snapshotted buffer, тухайн агшны `Цэвэр`/minibar readiness, lifecycle/blocker, дараагийн booking + buffer болон `planned_checkout_at > server_now`-г нэг transaction-д шалгана; түүхэн readiness нотлогдохгүй бол backdate-ийг хориглож server-now сонголт өгнө. `actual_check_in_at` ба `check_in_recorded_at` immutable; тариф, room/minibar snapshot нь recorded-at үеийн authoritative state ашиглана, paid online booking reprice болохгүй. Payment/cash current shift-д, Police matching recorded-at үед үүснэ. Activation-оос хойш Reception original event-ийг шууд edit хийхгүй. Ингэснээр P0-39B-1 хаагдсан.

P0-39B-2-ийн `STAY-DEC-010`-аар Reception зөвхөн stay `ACTIVE`, checkout эхлээгүй үед corrected actual time + заавал reason бүхий correction request үүсгэнэ; нэг stay-д хамгийн ихдээ нэг pending request байна, pending нь checkout initiation-ийг блоклоно. Manager approve/reject хийх бөгөөд Hotel Admin-д тусдаа Manager role шаардлагатай. Reception + Manager role нэг account-д байвал `self_approved` audit-тайгаар өөрөө баталж болно. Bound нь original `check_in_recorded_at` дээр тогтмол: `max(original recorded_at − 120 минут, original shift start, recorded-at local day start, online planned check-in)`-ээс original recorded-at хүртэл; дараагийн correction-оор цонх гулсахгүй. Original field/event overwrite болохгүй, approved immutable amendment-аас effective actual start гарна. Зөвхөн effective start өөрчлөгдөж, planned checkout, сонгосон hours/nights, stay type, room/minibar price, deposit/payment/cash shift, configuration/stock snapshot өөрчлөгдөхгүй. Сервер unchanged planned checkout ашиглан historical readiness/overlap-ийг дахин шалгана. Police original Match/alert/detected цаг хэвээр, duplicate alert үүсэхгүй; correction Police audit-тай холбоно. Guest registry/Excel latest approved effective actual time ашиглаж, original audit-д үлдэнэ. Approval idempotent/concurrency-safe; checkout эхэлсэн/дууссан эсвэл original bound-аас гадуур үед хориглоно. Ингэснээр P0-39B-2 хаагдсан.

P0-39C-1-ийн `STAY-DEC-011`-ээр confirmed booking болон `ACTIVE` stay-ийн `planned_checkout_at`-ийг аль ч role, UI эсвэл API шууд overwrite хийхгүй гэсэн хамгаалалтыг баталсан. Original planned end-ийг хадгалах, direct mutation хийхгүй invariant хэвээр боловч энэ шийдвэр дангаараа change action үүсгээгүй.

P0-39C-2-ийн `STAY-DEC-012`-оор MVP-д confirmed booking болон `ACTIVE` stay-ийн `planned_checkout_at`/effective planned end-ийг **огт өөрчлөхгүй** гэж баталсан. Initial stay type болон duration-ийг confirmation-оос өмнө сонгох existing урсгал хэвээр; confirmation-оос хойш amendment, action/button/API, extension, planned end урагшлуулах эсвэл хойшлуулах, hourly ↔ nightly conversion байхгүй. Зочин бодитоор эрт эсвэл орой check-out хийж болох бөгөөд `actual_checkout_at` бодит цагийг хадгалж original planned checkout-ийг өөрчлөхгүй. Early actual checkout автомат reprice/refund, overdue нь автомат fee/penalty үүсгэхгүй. Өрөө actual checkout хүртэл occupied хэвээр, дараа нь snapshotted cleaning buffer + бодит cleaning + applicable minibar readiness gate үйлчилнэ. `STAY-DEC-013` overdue conflict, `STAY-DEC-014` 30 минутын fractional hourly precision-ийг хаасан; online booking зөвхөн nightly байна (`BK-DEC-012`).

Hotel Admin-ийн баталгаажсан борлуулалт, орж ирсэн мөнгө, авлага, deposit, minibar gross profit, expense, top-5 өрөө, график болон дөрвөн financial Excel-ийн canonical дүрмийг [23-admin-financial-reporting.md](./23-admin-financial-reporting.md)-д тодорхойлно.
