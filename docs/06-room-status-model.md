# Reception — Өрөөний төлөвийн загвар

**Хувилбар:** 2.0  
**Төлөв:** Одоогийн occupancy ба ирээдүйн reservation тусгаарлалт, fractional hourly duration, overdue booking conflict, minibar configuration/version/Rollout, interval/buffer, actual-time болон immutable planned-end хамгаалалт батлагдсан  
**Хамаарах үе шат:** MVP — Reception system

## 1. Үндсэн зарчим

Өрөөнд нэг л ерөнхий статус хадгалахгүй. Захиалгын эх үүсвэр, байрлалт, хугацаа, цэвэрлэгээ болон minibar нь хоорондоо хамааралтай боловч тусдаа төлөвүүд байна.

`Walk-in` болон `Check-in` нь нэг төрлийн статус биш:

- **Walk-in** — зочин хаанаас, ямар сувгаар орж ирснийг заана.
- **Check-in хийсэн** — зочин өрөөнд бодитоор орж байрлаж байгааг заана.

Тиймээс нэг өрөө зэрэг `Walk-in` болон `Check-in хийсэн` төлөвтэй байж болно.

## 2. Reception-д харагдах төлөвүүд

| Төлөвийн төрөл | Боломжит утга | Тайлбар |
| --- | --- | --- |
| **Одоогийн байрлалтын төлөв** | `Сул`, `Check-in хийсэн`, `Check-out хийгдэж байгаа` | Зөвхөн өрөөний одоогийн бодит occupancy-г заана; ирээдүйн booking-ээс бодохгүй |
| **Одоогийн stay-ийн эх үүсвэр** | `Хамаарахгүй`, `Walk-in`, `Online` | Active stay байвал барьцаа болон эх үүсвэрийг тодорхойлно |
| **Ирээдүйн reservation** | `Байхгүй`, `Hold байгаа`, `Confirmed booking байгаа`, `Overdue conflict` | Category hold/booking болон оноосон physical room-ийн дараагийн холбоосоос derive хийнэ; одоогийн occupancy-г өөрчлөхгүй |
| **Тооцооны төрөл** | `Цагаар`, `Хоногоор` | Өрөөний төлбөрийг хэрхэн бодохыг заана |
| **Цагийн төлөв** | `Удахгүй эхэлнэ`, `Үргэлжилж байна`, `Дуусах дөхсөн`, `Хугацаа хэтэрсэн` | Огноо/цаг болон серверийн одоогийн цагаас автоматаар бодогдоно |
| **Цэвэрлэгээний төлөв** | `Цэвэр`, `Цэвэрлэгээ шаардлагатай`, `Цэвэрлэж байгаа` | Өрөө шинэ зочин авахад бэлэн эсэхийг заана |
| **Минибарын mode/дүүргэлт** | `Хамаарахгүй`, `Бүтэн`, `Дутуу`, `Тодорхойгүй` | Minibar ашиглах эсэх болон бодит тоо зорилтот хэмжээндээ байгаа эсэх; зөвхөн 25,000₮/30,000₮ багцад |
| **Минибарын shortage exception** | `Байхгүй`, `Manager зөвшөөрсөн` | `Дутуу` өрөөг бодит эхний snapshot-тайгаар дараагийн stay-д нээх тусдаа flag |
| **Минибарын шалгалт** | `Хүлээгдэж байгаа`, `Шалгаж байгаа`, `Илгээсэн`, `Залруулах шаардлагатай`, `Дахин илгээсэн`, `Төлбөрт түгжигдсэн`, `Тооцоонд орсон` | Check-out үеийн Cleaner report lifecycle; зөвхөн 25,000₮/30,000₮ багцад |
| **Entity lifecycle** | `Идэвхтэй`, `Идэвхгүй болгохоор хүлээгдэж буй`, `Идэвхгүй` | Шинэ booking/check-in/assignment-д ашиглаж болох эсэх; occupancy/readiness-ээс тусдаа |
| **Template version lifecycle** | `DRAFT`, `PUBLISHED`, `ARCHIVED` | Template entity lifecycle-ээс тусдаа; room configuration нь template entity болон exact version-ийг хамтад нь заана |
| **Minibar configuration change** | `Байхгүй`, `Stay дуусахыг хүлээж байгаа`, `Тааруулахад бэлэн`, `Гүйцэтгэж байгаа`, `Нөөц/зөрүүгээр блоклогдсон`, `Rollback шаардлагатай` | Current mode/template exact version-оос pending target exact version руу шилжих room-level урсгал; active stay/unfinished ажиллагаатай Rollout нь `SCHEDULED_AFTER_STAY`, бүх non-terminal үед check-in/assignment blocker |
| **Rollout batch** | `IN_PROGRESS`, `COMPLETED`, `PARTIALLY_COMPLETED`, `CANCELLED`, `FAILED_VALIDATION` | Manager batch summary; Reception тухайн room-ийн child холбоос, pending state/blocker болон ерөнхий batch state-ийг read-only харна |

## 3. Өрөөний картын жишээ

```text
Өрөө 203
Walk-in · Check-in хийсэн · Цагаар
14:00–17:00 · 42 минут үлдсэн
Цэвэрлэгээ: Цэвэр · Минибар: Бүтэн
Дараагийн захиалга: 18:00–22:00
```

```text
Өрөө 305
Одоо сул · Ирээдүйн confirmed booking · Online · Хоногоор
Өнөөдөр 18:00–Маргааш 12:00
Цэвэрлэгээ: Цэвэр · Минибар: Дутуу
```

```text
Өрөө 107
Check-out хийгдэж байгаа
Минибарын дүүргэлт: Тодорхойгүй
Минибарын шалгалт: Шалгаж байгаа
Lifecycle: Идэвхгүй болгохоор хүлээгдэж буй
```

```text
Өрөө 208 · Одоо сул
Цэвэрлэгээ: Цэвэр · Минибар: Бүтэн
Current config: Template A · v1 · Published
Pending config: Template B · v3 · Published · Нөөц хүрэлцэхгүй
Source: Rollout · Exact target pinned
Readiness: Check-in хориглосон
```

## 4. Цэвэрлэгээний төлөв

- Check-out дуусахад систем өрөөг `Цэвэрлэгээ шаардлагатай` болгоно.
- 20,000₮ багцад Manager `Цэвэрлэгээ шаардлагатай → Цэвэр` төлөвийг өөрчилнө.
- 25,000₮/30,000₮ багцад зөвхөн Cleaner `Цэвэрлэгээ шаардлагатай → Цэвэрлэж байгаа → Цэвэр` төлөвийг өөрчилнө.
- Reception цэвэрлэгээний төлөвийг бүх багцад зөвхөн харна.
- Шинэ check-in хийхийн тулд цэвэрлэгээний төлөв `Цэвэр` болсон байна.

### 4.1 Хугацаа, cleaning buffer ба бодит readiness

- Booking/stay хугацааг төгсгөлийн агшныг оруулахгүй `[start, end)` interval-аар тооцно. Нэг interval-ийн `end` нөгөөгийн `start`-тай тэнцэх нь өөрөө overlap биш; тухайн stay/booking-д snapshot хийсэн cleaning buffer тусдаа багтсан байна.
- Actual checkout бүртгэгдэхээс өмнө future availability төлөвлөх earliest time нь `planned checkout + snapshotted cleaning buffer` байна.
- Future planning time өнгөрсөн байсан ч actual checkout бүртгэгдээгүй stay-ийн room occupied хэвээр бөгөөд бодит assignment/check-in-д дахин ашиглахгүй. Planned checkout өнгөрвөл room `Хугацаа хэтэрсэн` төлөв болон хэтэрсэн хугацааг харуулна.
- Actual checkout бүртгэгдсэний дараа earliest readiness time-ийг `actual checkout + ижил snapshotted cleaning buffer` гэж дахин бодно.
- Өрөөг бодитоор дахин ашиглахын тулд server time earliest readiness time-д хүрсэн эсвэл өнгөрсөн, actual cleaning state `Цэвэр`, мөн тухайн өрөөнд хамаарах existing minibar readiness зэрэг хангагдана.
- Early actual checkout buffer-ийг эрт эхлүүлж болох боловч өмнө confirmed болсон дараагийн booking-ийн эхлэх цагийг автоматаар урагшлуулахгүй. P0-39A өөрөө financial үр дүнг шийдээгүй; `STAY-DEC-012` early actual checkout automatic reprice/refund үүсгэхгүй гэж баталсан.
- Late actual checkout earliest readiness time-ийг хойшлуулна. Нэмэлт/overdue fee автоматаар үүсэхгүй. Дараагийн confirmed booking-д багтах ижил category-ийн eligible room байхгүй болсон мөчид unique `OVERDUE_BOOKING_CONFLICT` нээгдэж, Reception/Manager-д alert өгнө; active stay actual checkout хийгдээгүй room дээр check-in-ийг сервер хориглоно (`STAY-DEC-013`).
- Availability overlap болон бодит check-in readiness-ийн эцсийн шалгалтыг client status-аар бус сервер authoritative байдлаар хийнэ (`STAY-DEC-008`).

### 4.2 Actual check-in time ба backdate үеийн төлөв

- Initial confirmation-ийн default `actual_check_in_at` нь server time; тусдаа `check_in_recorded_at` мөн бодит server confirmation time байна.
- Reception confirmation-оос өмнө л past actual time сонгож болно. Доод хязгаар нь server now-оос 120 минут, current open shift-ийн эхлэл, hotel local өдрийн эхлэл болон online booking байвал planned check-in-ийн хамгийн сүүлийн агшин; сонгосон утга server now-оос хэтрэхгүй. Current open shift байхгүй бол check-in батлахгүй.
- Backdate-д reason code заавал, note optional; Manager approval/evidence шаардахгүй. Activation-оос хойш Reception actual time-ийг direct edit хийхгүй.
- Backdated `[actual_check_in_at, planned_checkout_at)` interval-д сервер өмнөх stay-ийн actual checkout + snapshotted cleaning buffer болон тухайн requested actual агшин дахь historical `Цэвэр`/applicable minibar readiness-ийг event history-оор нотолж, lifecycle/configuration blocker, next booking + buffer болон `planned_checkout_at > server_now`-г нэг transaction-д шалгана.
- Historical readiness нотлогдохгүй бол room-ийг тухайн past агшинд бэлэн байсан гэж таахгүй; backdate-ийг блоклож server-now check-in сонголт өгнө.
- Backdated actual time нь duration/status timeline-ийн эхлэл боловч tariff, current room/minibar configuration, minibar price book болон opening quantity-г historical байдлаар сэргээхгүй. Эдгээр snapshot `check_in_recorded_at` үеийн authoritative state-оос үүснэ; paid online price snapshot хэвээр байна.
- Payment/cash current shift-д, Police matching `check_in_recorded_at` үед үүснэ. `actual_check_in_at`, `check_in_recorded_at`, bound/reason/note/validation болон actor бүрэн audit-тай байна (`STAY-DEC-009`).

### 4.3 Active stay-ийн actual-time correction төлөв

- Stay `ACTIVE`, checkout initiation эхлээгүй үед Reception corrected actual time + mandatory reason бүхий correction request үүсгэнэ. Нэг stay-д нэг pending request байх бөгөөд pending үед checkout initiation хориглогдоно.
- Manager request-ийг approve/reject хийнэ; Hotel Admin-д Manager role тусдаа шаардлагатай. Reception + Manager role нэг account-д байвал `self_approved` audit-тай self-approve хийж болно. Manager Plus дангаараа энэ specific approval эрхгүй.
- Correction bound нь original `check_in_recorded_at`, original shift, recorded-at hotel-local day болон online planned check-in дээр түгжигдэнэ. Corrected time нь fixed earliest boundary-гаас original recorded-at хүртэл байна; approved correction effective time-ээс шинэ 120 минутын цонх үүсгэхгүй.
- Original `actual_check_in_at`/`check_in_recorded_at` болон initial event immutable. Approved immutable amendment-аас room/stay timeline-д харагдах `effective_actual_check_in_at` гарна.
- Approval өмнөх stay + snapshotted buffer, corrected агшин дахь historical `Цэвэр`/applicable minibar readiness болон `[corrected, unchanged planned_checkout)` overlap/lifecycle/blocker/next-booking нөхцөлийг серверээр дахин шалгана.
- Approved correction зөвхөн effective actual start-ийг өөрчилнө. Planned checkout, hours/nights, stay type, price/deposit/payment/cash shift, room/minibar configuration, price/opening/stock snapshot болон Police original Match/alert/detected цаг өөрчлөгдөхгүй; duplicate alert үүсэхгүй.
- Guest registry/Excel latest approved effective actual time ашиглана. One-pending invariant, idempotent submit/decision, concurrency-safe approval болон original/effective/request/decision/Police холбоос бүр audit-тай байна. Checkout эхэлсэн/дууссан эсвэл fixed bound-аас гадуур request/approval хориглогдоно (`STAY-DEC-010`).

### 4.4 Confirmed/active stay-ийн immutable planned end

- Confirmation-оос өмнө initial stay type/duration сонгож, confirmation амжилттай үед `planned_checkout_at` snapshot тогтоно.
- Confirmed booking болон `ACTIVE` stay-ийн `planned_checkout_at`/effective planned end-ийг MVP-д огт өөрчлөхгүй. `STAY-DEC-011` direct-overwrite guard хэвээр; `STAY-DEC-012`-оор amendment, action/button/API, extension, planned-end shorten/lengthen болон hourly ↔ nightly conversion байхгүй.
- Зочин planned time-ээс эрт/орой бодитоор checkout хийж болно. `actual_checkout_at` бодит төгсгөлийг хадгалж original planned checkout-ийг өөрчлөхгүй.
- Early actual checkout automatic reprice/refund үүсгэхгүй. Overdue room зөвхөн status/time харуулах бөгөөд automatic fee/penalty үүсгэхгүй.
- Actual checkout хүртэл room occupied. Дараа нь `actual checkout + snapshotted cleaning buffer`, actual `Цэвэр` төлөв болон applicable minibar readiness хамт хангагдсаны дараа л өрөөг дахин ашиглана.
- Planned end болон stay type/duration fixed үлдэх тул price/payment/cash, room/minibar configuration, price book/opening болон stock snapshot өөрчлөгдөхгүй. Overdue conflict-ийг ready болох, ижил category-д дахин оноох, Manager/Manager Plus-аар өндөр category-д нэмэлт төлбөргүй оноох эсвэл hotel-caused cancellation + бүтэн refund-аар terminal болгоно (`STAY-DEC-013`).
- Online booking зөвхөн хоногоор, нэг booking нэг category room/нэг үндсэн зочинтой байна. Cancellation/no-show нь planned-end edit биш, тусдаа terminal transition байна (`BK-DEC-012`, `PAY-DEC-007`).

### 4.5 Цагийн үйлчилгээний бутархай хугацаа

- Walk-in hourly duration-ийг 30 минутын алхмаар сонгоно: `0.5`, `1`, `1.5`, `2` цаг гэх мэт.
- Өгөгдлийн санд floating-point цаг хадгалахгүй; `duration_minutes` болон `half_hour_units` эерэг бүхэл утга хадгална.
- Нийт үнэ `ROUND_HALF_UP(hourly_rate × half_hour_units / 2)` байна. Reception дур мэдэн rounding хийхгүй, Manager minimum/maximum/increment тохируулахгүй.
- Online booking hourly байхгүй; зөвхөн nightly байна (`STAY-DEC-014`, `BK-DEC-012`).

## 5. Минибарын төлөв

Минибарын төлөв зөвхөн 25,000₮ болон 30,000₮ багцад байна.

### 5.1 Дүүргэлтийн төлөв

- **Хамаарахгүй:** Current mode `Minibar ашиглахгүй`; current template болон routine guest minibar task/charge үүсэхгүй. OFF → ON pending change-ийн reconciliation task тусдаа байж болно.
- **Бүтэн:** Өрөөнд байх ёстой бүтээгдэхүүний тоо тохируулсан хэмжээндээ байна.
- **Дутуу:** Нэг эсвэл хэд хэдэн бүтээгдэхүүний бодит тоо тохируулсан хэмжээнээс бага байна.
- **Тодорхойгүй:** Check-out эхэлсэн боловч Cleaner бодит тоог хараахан баталгаажуулаагүй байна.

`Manager зөвшөөрсөн` shortage exception нь үндсэн `Дутуу` төлөвийг `Бүтэн` болгон өөрчлөхгүй. Энэ нь Manager/Manager Plus шалтгаан болон бодит эхний тооны snapshot-тайгаар зөвхөн дараагийн stay-д check-in зөвшөөрсөн тусдаа flag байна.

### 5.2 Шалгалтын төлөв

- **Хүлээгдэж байгаа:** Check-out эхэлсэн, Cleaner ажлыг авч эхлээгүй байна.
- **Шалгаж байгаа:** Cleaner өрөөний минибарыг шалгаж байна.
- **Илгээсэн:** Cleaner хэрэглэсэн бүтээгдэхүүний тоо эсвэл `Хэрэглээгүй` тайланг илгээсэн байна.
- **Залруулах шаардлагатай:** Reception шалтгаантайгаар тайланг Cleaner-д буцаасан байна.
- **Дахин илгээсэн:** Cleaner залруулсан шинэ тайлангийн хувилбар илгээсэн байна.
- **Төлбөрт түгжигдсэн:** Тухайн report version payment attempt-д ашиглагдаж, шууд засах боломжгүй болсон байна.
- **Тооцоонд орсон:** Холбоотой төлбөр амжилттай баталгаажсан байна.

Санал болгож буй шилжилт:

```text
Бүтэн
  → Check-out эхлэх
Дүүргэлт: Тодорхойгүй · Шалгалт: Хүлээгдэж байгаа/Шалгаж байгаа
  → Cleaner хэрэглээ илгээх
Дүүргэлт: Дутуу эсвэл Бүтэн · Шалгалт: Илгээсэн
  → Алдаа байвал Reception буцаах
Шалгалт: Залруулах шаардлагатай → Дахин илгээсэн
  → Reception төлбөр эхлүүлэх
Шалгалт: Төлбөрт түгжигдсэн → Тооцоонд орсон
  → Нөхөн дүүргэлт батлах
Бүтэн
```

`Онцгой тайлан`, `Маргаантай`, `Маргаан шийдсэн`, `Залруулга хийгдсэн`, `Цуцлагдсан`-ыг үндсэн шалгалтын төлөвт хольж хадгалахгүй; тусдаа report type/flag/event байна. Canonical transition болон exception дүрмийг [21-cleaner-checkout-exception-and-dispute.md](./21-cleaner-checkout-exception-and-dispute.md)-ээс үзнэ.

Cleaner хэрэглэсэн бүтээгдэхүүн, тоо ширхэгийг илгээхэд систем өрөөний minibar-ын бодит тоог шинэчилнэ. Ямар ч бүтээгдэхүүн хэрэглээгүй бол `Бүтэн` хэвээр байна. Хэрэглэсэн бол `Дутуу` болно.

Pending configuration change байхгүй үед Cleaner өрөөг цэвэрлэх явцдаа зөвхөн lifecycle `ACTIVE` дутуу бүтээгдэхүүнийг current configuration-ийн exact version-ийн дагуу нөхөж, бүтээгдэхүүн тус бүрийн нөхсөн тоог бүртгэнэ. Pending change байвал хуучин current version-оор routine refill хийхгүй; server pending target exact version-д зориулсан configuration reconciliation task үүсгэнэ. Retiring/inactive product-ийг warehouse → room refill хийхгүй боловч removed/excess stock-ийг assigned reconciliation task-аар room → warehouse буцааж болно. Target бүрдэх хүртэл room `Configuration blocker`-тай байна.

Минибарын төлбөр төлөгдсөн эсэх болон минибар физик байдлаар `Бүтэн/Дутуу` байх нь тусдаа ойлголт байна. Зочин хэрэглэсэн төлбөрөө төлсөн ч бүтээгдэхүүнийг нөхөөгүй бол өрөөний minibar `Дутуу` хэвээр байна.

Minibar mode, warehouse/room stock болон shortage override-ийн canonical дүрмийг [22-minibar-stock-inventory.md](./22-minibar-stock-inventory.md)-ээс үзнэ. Opening quantity `0` product-ийн documented refill болон check-in price, мөн price book-д байгаагүй product-ийг charge хийхгүй байх дүрмийг [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md)-ээс үзнэ.

Room/category/product/template-ийн deactivation, hard-delete болон reactivation нь [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md)-д canonical байна. `RETIRING/INACTIVE` room/category шинэ operation-д ашиглагдахгүй боловч active stay болон өмнө баталгаажсан booking автоматаар cancel/reprice болохгүй.

### 5.3 Configuration change-ийн төлөв

- Room яг нэг current configuration, хамгийн ихдээ нэг non-terminal pending change-тай байна; ON configuration бүр template entity болон exact version заана.
- Explicit Rollout нь ижил hotel, ижил `ACTIVE` template entity-ийн бүх product нь `ACTIVE` exact `PUBLISHED` target-ийг сонгоно; target Default байх албагүй. Eligible room нь lifecycle `ACTIVE`, minibar mode `ON`, target-аас өөр current version-тэй, non-terminal pending configuration-гүй байхыг Confirm дээр сервер дахин шалгана. Mode/template switch нь Rollout биш, ердийн configuration change байна.
- Rollout confirm нь exact target-ийг түгжсэн room-level pending request болон check-in/assignment blocker-ийг нэг transaction-д шууд үүсгэнэ; current version, stock, selling price эсвэл active stay price book-ийг өөрчлөхгүй.
- Active stay эсвэл checkout/payment/minibar report/refill дуусаагүй бол pending `Stay дуусахыг хүлээж байгаа` (`SCHEDULED_AFTER_STAY`); current stay-ийн mode/template/opening/price book өөрчлөгдөхгүй, Cleaner task хараахан үүсэхгүй.
- Room safe/vacant бөгөөд дээрх ажиллагаа бүгд terminal бол pending `Тааруулахад бэлэн` (`READY_FOR_RECONCILIATION`) болж Cleaner reconciliation task шууд үүснэ. Scheduled request existing safe point-д хүрэхэд л task үүсгэнэ.
- Checkout, payment, minibar report болон refill task terminal болсны дараа `Тааруулахад бэлэн` болно.
- Cleaner assigned task-аар actual count, removed/excess return болон added/short refill хийж байх үед `Гүйцэтгэж байгаа` байна.
- Stock хүрэлцэхгүй эсвэл count variance шийдэгдээгүй бол `Нөөц/зөрүүгээр блоклогдсон` байна.
- Posted movement-тэй request цуцлагдвал `Rollback шаардлагатай`; compensating movement бүрэн дуусах хүртэл blocker арилгахгүй.
- `Applied`, хөдөлгөөнгүй `Cancelled` эсвэл бүрэн `Rolled back` terminal болсон үед pending badge арилна.

Configuration apply нь cleaning status-ийг автоматаар өөрчлөхгүй. Future booking автоматаар cancel/reprice болохгүй бөгөөд minibar config booking үед pin болохгүй; check-in үеийн current configuration ашиглагдана. Cleaner task-ийн immutable stock movement-үүд reconciliation үеэр хийгдэж, existing P0-37B final validation амжилттай үед current version switch, pending completion болон audit атомикаар хийгдэнэ.

### 5.4 Template version lifecycle-ийн суурь

- Template entity `ACTIVE/RETIRING/INACTIVE`, version нь тусдаа `DRAFT/PUBLISHED/ARCHIVED` lifecycle-тэй байна.
- `DRAFT` засварлагдаж болох боловч room current/pending configuration-д сонгохгүй, check-in-д ашиглахгүй.
- `PUBLISHED` version-ийн product list болон target quantity immutable; өөрчлөлт бүр шинэ `DRAFT`/version-оор хийгдэнэ.
- Publish хийхэд сервер parent template entity `ACTIVE`, дор хаяж нэг product байгаа бөгөөд бүх product тухайн hotel-д хамаарах `ACTIVE`, duplicate product-гүй, target quantity бүр эерэг бүхэл тоо эсэхийг шалгана.
- `ARCHIVED` terminal/history-only бөгөөд шинэ assignment-д ашиглагдахгүй, шууд Published болгон сэргээхгүй; дахин ашиглахдаа шинэ `DRAFT` clone үүсгэнэ.
- Нэг template entity олон `PUBLISHED` version-тэй зэрэг байж болно. Анхны Published version автоматаар цорын ганц `Default Published` болно; дараагийн publish одоогийн Default-ийг автоматаар солихгүй.
- Default Published version-ийг archive хийхийн өмнө өөр eligible Published version-ийг `Set default` хийнэ.
- Exact version нь room current/pending, active stay эсвэл non-terminal reconciliation/Cleaner/configuration task-д reference-тэй бол archive хориглоно. Historical stay/report/price book/audit reference blocker болохгүй, түүхдээ хадгалагдана. Future booking version pin хийдэггүй тул өөрөө archive blocker биш.
- Room current/pending configuration exact version заах тул шинэ Draft, `Publish`, `Set default` эсвэл `Archive` нь existing room, active stay, future booking болон pending reconciliation target-ийг автоматаар өөрчлөхгүй; inventory/stock movement, Cleaner task, configuration request эсвэл check-in blocker үүсгэхгүй.
- `Publish`, `Set default`, `Archive`-ийг зөвхөн идэвхтэй minibar entitlement + зөвшөөрөгдсөн role хийнэ: 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus. Hotel Admin operational inheritance авахгүй бөгөөд дээрх role тусдаа шаардлагатай; 25,000₮-д Manager Plus role үүсгэж gate тойрохгүй.
- Ашиглагдсан/reference-тэй version, түүнд хамаарах stay/configuration/task/audit холбоосыг hard-delete хийхгүй.

Room-ийг шинэ exact version рүү шилжүүлэх explicit Rollout нь Publish/Set default/Archive-аас тусдаа. Confirm-оор түгжигдсэн pending target-ийг дараагийн Publish/Default өөрчлөхгүй бөгөөд pending target reference нь Archive blocker байна. Canonical суурь: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md)-ийн RML-DEC-015–024.

### 5.5 Multi-room Rollout batch-ийн төлөв

- Нэг batch parent нь нэг exact `PUBLISHED` target version болон ижил hotel/template-ийн олон room child-ийг заана. Target ID түгжигдэх тул дараагийн Publish/Default batch-ийг өөр version рүү шилжүүлэхгүй.
- Read-only preview нь room бүрийг `Одоо хийх боломжтой`, `Stay дууссаны дараа`, `Сонгох боломжгүй` гэж reason-тэй ангилна. Preview нь room state, availability, pending request, blocker, Cleaner task, stock movement эсвэл Archive blocker үүсгэхгүй.
- Confirm дээр room бүрийг сервер дахин шалгана. Eligible room-д exact target-тай child pending request + blocker нэг transaction-д үүснэ; invalid room `SKIPPED` болж шалтгаанаа хадгална, blocker авахгүй. Нэг child failure бусад child-ийг rollback хийхгүй.
- Accepted child бүр дээрх room-level state machine-ээр бие даан `SCHEDULED_AFTER_STAY`, `READY_FOR_RECONCILIATION`, `IN_PROGRESS`, blocked/rollback эсвэл terminal төлөвт шилжинэ. Cleaner зөвхөн өөрт оноогдсон child task-ийг гүйцэтгэнэ.
- Batch state-ийг child үр дүнгээс дараах байдлаар гаргана:

| Batch state | Нөхцөл |
| --- | --- |
| `IN_PROGRESS` | Дор хаяж нэг accepted child non-terminal |
| `COMPLETED` | Сонгосон room бүр accepted болж, accepted child бүр `APPLIED` |
| `CANCELLED` | Дор хаяж нэг room accepted болсон бөгөөд accepted child бүр movement эхлэхээс өмнө `CANCELLED` |
| `FAILED_VALIDATION` | Confirm үед нэг ч room accepted болоогүй |
| `PARTIALLY_COMPLETED` | Accepted child бүр terminal боловч `COMPLETED`, `CANCELLED`, `FAILED_VALIDATION`-д орохгүй; `SKIPPED`, `CANCELLED`, `ROLLED_BACK` эсвэл бусад non-`APPLIED` outcome оролцсон |

Batch summary нь нийт сонгосон, accepted, ready, scheduled, in-progress, stock/variance blocker-тэй, applied, skipped, cancelled, rollback шаардлагатай болон rolled-back child-ийн тоог харуулна. Эдгээр тоо болон batch state-ийг хэрэглэгч гараар overwrite хийхгүй.

- `Cancel remaining` хийхэд movement эхлээгүй child `CANCELLED` болж blocker арилна. Movement эхэлсэн child existing compensating rollback state/task-аар terminal болтол blocker-тэй байна. `APPLIED` child өөрчлөгдөхгүй; өмнөх version рүү буцаахдаа шинэ Rollout үүсгэнэ.
- Retry нь хуучин batch/child state, task, movement эсвэл audit-ийг засахгүй; eligibility-г дахин шалгасан `retry_of_batch_id` холбоостой шинэ batch үүсгэнэ.
- Preview болон zero-accepted `FAILED_VALIDATION` batch Archive blocker биш. Confirmed non-terminal child/batch exact target version Archive blocker болж, бүх child terminal болсон үед бусад archive blocker-ийг ердийн дүрмээр дахин шалгана.
- Duplicate Confirm ижил idempotency key-ээр хоёр batch үүсгэхгүй. Нэг room-д нэгээс олон non-terminal pending change үүсгэхгүй; cross-hotel/cross-template room/target ID-г сервер хориглоно.

Canonical multi-room Rollout төлөв: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md)-ийн RML-DEC-025–028.

## 6. Эрхийн хуваарилалт

- **Reception:** Бүх төлөв, Rollout batch/child summary болон current/pending configuration/blocker-ийг read-only харна; цэвэрлэгээ, minibar status, batch эсвэл config-г гараар өөрчлөхгүй.
- **Cleaner:** Хэрэглэсэн minibar-ын бүтээгдэхүүн, тоог тайлагнана; pending change байхгүй үед current config-аар routine refill хийнэ; өөрт оноогдсон reconciliation/rollback child task-аар room ↔ warehouse transfer батална; цэвэрлэгээний төлөвийг өөрчилнө; batch preview/confirm/cancel/retry хийхгүй.
- **Manager/Manager Plus:** Идэвхтэй minibar entitlement-д 25,000₮ багцын зөвхөн Manager, 30,000₮ багцын Manager/Manager Plus нь minibar product, template Draft/Publish/Default/Archive, room/multi-room Rollout preview/confirm/cancel/retry, үнэ/өртөг, warehouse stock, pending room mode/template change, variance болон shortage override-ийг удирдана; 20,000₮/entitlement-гүй үед minibar action хориглогдож, 25,000₮-д Manager Plus үүсгэн gate тойрохгүй. 20,000₮ багцын Manager зөвхөн холбогдох цэвэрлэгээний төлөвийг өөрчилнө.
- **Hotel Admin:** Publish/Set default/Archive/Rollout зэрэг Manager operational action-ийг автоматаар өвлөхгүй; 25,000₮-д Manager, 30,000₮-д Manager эсвэл Manager Plus role тусдаа шаардлагатай.

Cleaner warehouse balance-ийг шууд засахгүй. Cleaner-ийн active product нөхөлт warehouse-оос room руу атомик movement үүсгэж өрөөний бодит тоог шинэчилнэ. Retiring/inactive product-ийн routine refill хориглогдоно. Product, үнэ/өртөг, зорилтот тоо болон warehouse/room ledger-ийн хяналт Manager/Manager Plus-д байна.

## 7. Системийн хамгаалалт

- Төлөвүүдийг нэг текст талбарт хольж хадгалахгүй.
- Цагийн төлөвийг хэрэглэгч гараар сонгохгүй; хугацаанаас автоматаар бодно.
- Booking/stay overlap-ийг `[start, end)` interval болон snapshotted cleaning buffer-ээр сервер шалгана; UI-ийн `Сул` badge дангаараа check-in зөвшөөрөх үндэслэл биш.
- Минибарын төлөвийг бүтээгдэхүүний зорилтот болон бодит тооноос автоматаар гаргана.
- Reception minibar status эсвэл shortage override-ийг гараар өөрчлөхгүй.
- Reception lifecycle state/blocker-ийг read-only харна; deactivate/reactivate/hard-delete хийхгүй.
- Нэг room-д нэгээс олон non-terminal configuration change үүсгэхгүй; pending үед physical room шинэ check-in/assignment авахгүй.
- `DRAFT` template version-ийг assignment/check-in-д ашиглахгүй; current/pending configuration exact version reference-ээ хадгална.
- Publish validation болон package/role gate-ийг сервер талд шалгана; анхны publish л Default-ийг автоматаар үүсгэнэ.
- Default болон operational exact reference-тэй version-ийн Archive-ийг сервер хориглож, historical reference-ийг хэвээр хадгална.
- Publish/Set default/Archive нь room current/pending, stay/booking, stock/task/blocker-д side effect үүсгэхгүй.
- Rollout confirm дээр eligibility-г сервер дахин шалгаж exact target-тай pending request/blocker-ийг атомикаар үүсгэнэ; confirm өөрөө current version, stock, selling price эсвэл stay price book-ийг өөрчлөхгүй.
- Safe/vacant room-д reconciliation task шууд, active stay эсвэл unfinished checkout/payment/minibar report/refill-тэй room-д existing safe point хангагдсаны дараа л үүснэ.
- Pending Rollout target-ийг дараагийн Publish/Default өөрчлөхгүй бөгөөд target version-ийг Archive хийхгүй.
- Multi-room preview side effect-гүй; Confirm eligibility-г room бүрээр дахин шалгаж partial success хэрэглэнэ.
- Accepted child-д pending request/blocker атомикаар үүсэж, invalid room `SKIPPED`/blocker-гүй байна; нэг child failure бусдыг rollback хийхгүй.
- Duplicate Confirm хоёр batch үүсгэхгүй; нэг room-ийн давхар pending болон cross-hotel/cross-template холбоосыг сервер хориглоно.
- `Cancel remaining` нь movement-free child-ийг unblock хийж, started child-ийг existing rollback урсгалаар terminal болтол хамгаална; `APPLIED` child хэвээр байна.
- Preview/zero-accepted batch Archive blocker биш, confirmed non-terminal child/batch target Archive blocker байна.
- Ашиглагдсан/reference-тэй template version-ийг history-оос hard-delete хийхгүй.
- Warehouse/room stock сөрөг болохгүй; movement бүр audit-тай байна.
- Reception-д өрөөний хамгийн сүүлийн төлөв бодит хугацаанд шинэчлэгдэж харагдана.
- 20,000₮ багцад minibar-ын төлөв харагдахгүй бөгөөд API-аар ашиглах боломжгүй байна.
- Бүх төлөвийн өөрчлөлтөд хэрэглэгч, огноо/цаг, өмнөх болон шинэ утгыг аудитын түүхэд хадгална.

## 8. MVP acceptance criteria

- Walk-in зочин check-in хийсэн өрөөнд `Walk-in` болон `Check-in хийсэн` badge зэрэг харагдана.
- Онлайн захиалгатай өрөөнд `Online` болон захиалгын хугацаа харагдана.
- Reception цэвэрлэгээний `Цэвэр`, `Цэвэрлэгээ шаардлагатай`, `Цэвэрлэж байгаа` төлөвийг харна.
- 25,000₮/30,000₮ багцад Reception minibar-ын `Хамаарахгүй/Бүтэн/Дутуу/Тодорхойгүй`, shortage exception болон шалгалтын lifecycle-ийг тусад нь харна.
- Minibar-ын төлбөр төлөгдсөн ч нөхөн дүүргээгүй бол `Дутуу` төлөв хэвээр байна.
- 20,000₮ багцад minibar-ын төлөв харагдахгүй.
- Future availability-г actual checkout бүртгэгдэхээс өмнө `planned checkout + snapshotted cleaning buffer`, дараа нь `actual checkout + ижил snapshotted cleaning buffer`-аар тооцно.
- Шинэ check-in хийхэд server time уг buffer хугацаанд хүрсэн эсвэл өнгөрсөн, actual cleaning state `Цэвэр`, applicable minibar readiness хангагдсан байна.
- Early checkout confirmed next booking-ийг автоматаар урагшлуулахгүй; late checkout automatic overdue fee үүсгэхгүй.
- Initial check-in default actual time нь server time; Reception зөвхөн confirmation-оос өмнө STAY-DEC-009-ийн 120 минут/current shift/current local day/online planned-start хязгаарт reason code-той backdate сонгоно.
- Historical checkout-buffer, `Цэвэр`, applicable minibar readiness, lifecycle/blocker болон overlap нотлогдохгүй бол backdate хориглогдож server-now сонголт өгнө.
- `actual_check_in_at` ба `check_in_recorded_at` immutable; room/minibar snapshot recorded-at authoritative state ашиглаж, payment/cash current shift-д, Police matching recorded-at үед үүснэ.
- ACTIVE stay/checkout эхлээгүй үед Reception mandatory reason-тэй actual-time correction request үүсгэж, нэг pending request checkout initiation-ийг блоклоно.
- Manager approve/reject хийнэ; Hotel Admin-д Manager role тусдаа, Reception+Manager account self-approve бол `self_approved` audit-тай байна.
- Approved amendment fixed original-recorded-at bound болон historical readiness/overlap recheck ашиглаж зөвхөн effective actual start-ийг өөрчилнө; бусад duration/price/payment/config/stock/Police timestamp өөрчлөгдөхгүй.
- Confirmed booking/`ACTIVE` stay-ийн planned/effective end-ийг MVP-д ямар ч amendment/action/button/API-аар өөрчлөхгүй; extension, shortening болон hourly ↔ nightly conversion байхгүй.
- Early/late actual checkout original planned checkout-ийг өөрчлөхгүй. Early үед automatic reprice/refund, overdue үед automatic fee/penalty үүсэхгүй; actual checkout хүртэл occupied хэвээр байна.
- Actual checkout-оос хойш snapshotted buffer + actual cleaning + applicable minibar readiness gate үйлчилж, price/payment/cash/config/stock snapshot хэвээр үлдэнэ.
- 20,000₮ багцад check-out дууссан, actual checkout + snapshotted cleaning buffer хугацаа өнгөрсөн бөгөөд өрөө `Цэвэр` болсон үед шинэ check-in зөвшөөрнө.
- Minibar-disabled өрөө check-out дууссан, actual checkout + snapshotted cleaning buffer хугацаа өнгөрсөн, `Цэвэр` болсон үед шинэ check-in зөвшөөрнө.
- Minibar-enabled өрөө ердийн үед check-out дууссан, actual checkout + snapshotted cleaning buffer хугацаа өнгөрсөн, `Цэвэр`, minibar `Бүтэн` болсон үед шинэ check-in зөвшөөрнө.
- Minibar `Дутуу` бол зөвхөн Manager/Manager Plus-ийн дараагийн stay-д хүчинтэй шалтгаан, бодит эхний snapshot болон audit-тай override-аар check-in зөвшөөрнө.
- Minibar `Тодорхойгүй` үед check-in хориглоно.
- `RETIRING/INACTIVE` room/category шинэ booking, walk-in check-in болон assignment-д ашиглагдахгүй.
- Deactivation-оос өмнөх active stay/confirmed booking lifecycle state өөрчлөгдсөнөөр автоматаар cancel/reprice болохгүй.
- Retiring/inactive template/product-той minibar-enabled room configuration blocker-тэй бөгөөд шинэ check-in хийхгүй.
- Reception current/pending configuration болон blocker-ийг тусдаа харна; non-terminal pending change-тэй physical room шинэ assignment/check-in авахгүй.
- Future booking pending change-аас болж автоматаар cancel/reprice болохгүй бөгөөд config booking үед pin болохгүй.
- Шинэ Draft/Published version болон Default Published өөрчлөлт existing room, active stay, future booking эсвэл pending target-ийг автоматаар солихгүй.
- Published version-ийн product/target засагдахгүй; өөрчлөлт шинэ Draft/version үүсгэнэ.
- Анхны Published version автоматаар цорын ганц Default болж, дараагийн publish одоогийн Default-ийг солихгүй.
- Publish/Set default/Archive нь stock movement, Cleaner/configuration task эсвэл check-in blocker үүсгэхгүй; room version солих explicit Rollout тусдаа байна.
- Default, room current/pending, active stay эсвэл non-terminal task-д reference-тэй exact version archive болохгүй; historical reference болон future booking өөрөө blocker болохгүй.
- Rollout target нь same-hotel, same-active-template exact `PUBLISHED` version бөгөөд бүх target product `ACTIVE`; eligible room нь `ACTIVE`, minibar `ON`, өөр current version-тэй, pending config-гүй байна.
- Rollout confirm нь exact target-тай pending request болон check-in/assignment blocker-ийг атомикаар шууд үүсгэж, safe/vacant room-д Cleaner task нэн даруй үүсгэнэ.
- Active stay эсвэл unfinished checkout/payment/minibar report/refill-тэй room `SCHEDULED_AFTER_STAY` болж, safe point хүртэл Cleaner task үүсэхгүй; current stay болон current version/stock/price хэвээр байна.
- Cleaner reconciliation + existing P0-37B validation амжилттай үед apply атомик хийгдэж, later Publish/Default target-ийг солихгүй, pending target Archive blocker хэвээр байна.
- Multi-room preview room бүрийг now/scheduled/ineligible гэж reason-тэй ангилж, pending/blocker/task/movement үүсгэхгүй.
- Confirm partial success ашиглаж accepted child бүрд атомик pending + blocker үүсгэн, invalid room-ийг `SKIPPED`/blocker-гүй үлдээнэ; child-үүд бие даан үргэлжилнэ.
- Batch state `IN_PROGRESS/COMPLETED/PARTIALLY_COMPLETED/CANCELLED/FAILED_VALIDATION`-аас бүрдэж, Retry хуучин түүхийг засахгүй `retry_of_batch_id`-тай шинэ batch үүсгэнэ.
- `Cancel remaining` нь movement-free child-ийг unblock хийх бөгөөд started movement rollback terminal болтол blocker-тэй, `APPLIED` child unchanged байна.
- Duplicate Confirm, нэг room-ийн давхар pending болон cross-hotel/cross-template batch үүсэхгүй; confirmed non-terminal batch target Archive blocker, preview/zero-accepted batch blocker биш.
- Configuration reconciliation дууссан ч cleaning status тусдаа хэвээр байна.

## 9. Батлагдсан нөхөн дүүргэлтийн дүрэм

Pending configuration change байхгүй үед Cleaner өрөөг цэвэрлэх явцдаа minibar-ыг warehouse-ийн боломжит lifecycle `ACTIVE` product-оор current configuration-ийн exact version-ийн дагуу нөхөж, бүтээгдэхүүн/тоог бүртгэнэ. Pending change байвал current version-оор refill хийхгүй, pending exact target version-ийн reconciliation task ажиллана. Manager/Manager Plus product, үнэ/өртөг, target, variance болон warehouse/room inventory-д хяналт тавина.

## 10. Батлагдсан өрөө бэлэн болох дүрэм

- **Бүх багцын хугацааны gate:** Actual checkout бүртгэгдсэн бөгөөд server time `actual checkout + snapshotted cleaning buffer`-т хүрсэн эсвэл өнгөрсөн байна. Actual checkout-оос өмнөх future planning-д `planned checkout + ижил snapshotted cleaning buffer` ашиглана.
- **20,000₮ багц:** Хугацааны gate + өрөөний actual cleaning state `Цэвэр` болсон үед бэлэн.
- **25,000₮/30,000₮, minibar ашиглахгүй өрөө:** Хугацааны gate + өрөө `Цэвэр` болсон үед бэлэн.
- **25,000₮/30,000₮, minibar ашиглах өрөөний ердийн урсгал:** Хугацааны gate + өрөө `Цэвэр` + minibar `Бүтэн` болсон үед бэлэн.
- **Нөөцийн shortage exception:** Хугацааны gate + өрөө `Цэвэр` + minibar `Дутуу` + Manager/Manager Plus-ийн дараагийн stay-д хүчинтэй эхний snapshot бүхий override байгаа үед бэлэн.

Minibar `Дутуу` бөгөөд хүчинтэй override байхгүй, эсвэл minibar `Тодорхойгүй` бол өрөө цэвэр байсан ч шинэ check-in-ыг систем хориглоно. Reception override үүсгэхгүй.

Room/category `RETIRING/INACTIVE` эсвэл minibar-enabled room-ийн template/product dependency active биш бол дээрх readiness хангагдсан мэт харагдсан ч шинэ check-in хориглоно.

Мөн room-ийн minibar configuration change non-terminal бол цэвэрлэгээ болон minibar quantity бусад шаардлага хангаж байсан ч шинэ assignment/check-in хориглоно. Change `Applied`, `Cancelled` эсвэл `Rolled back` болсны дараа current configuration-аар readiness-ийг дахин бодно.

P0-39A interval/readiness нь `STAY-DEC-008`, P0-39B-1 initial actual check-in нь `STAY-DEC-009`, P0-39B-2 immutable active-stay correction нь `STAY-DEC-010`, P0-39C-1 direct-overwrite guard нь `STAY-DEC-011`, P0-39C-2 planned-end no-change нь `STAY-DEC-012`, overdue stay–next booking resolution нь `STAY-DEC-013`, fractional hourly precision нь [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md)-ийн `STAY-DEC-014`-өөр хаагдсан.
