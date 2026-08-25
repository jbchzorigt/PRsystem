# Reception — Ээлж хаах, батлах, хүлээлцэх ажиллагаа

**Хувилбар:** 1.11  
**Төлөв:** P0-34 батлагдсан; P0-37, P0-38 болон P0-39A–P0-39C-2 батлагдсан  
**Хамаарах үе шат:** MVP — Reception system

## 1. Зорилго

Ээлжийн хугацаанд системээр бүртгэгдсэн мөнгөн хөдөлгөөн болон кассанд бодитоор байгаа бэлэн мөнгийг тулгаж, хариуцлагыг дараагийн ажилтанд тодорхой шилжүүлэхэд энэ ажиллагааны зорилго оршино.

Ээлжийн **operational төлөв** болон санхүүгийн **review төлөв** тусдаа байна. Мөнгө бодитоор хүлээлцэж дараагийн ээлж эхлэх ажиллагааг Manager-ийн дараах review-ээс хамааруулж зогсоохгүй.

## 2. Батлагдсан эрхийн хуваарилалт

### Ээлжээс бууж буй Reception

- Ээлж хаах ажиллагааг эхлүүлнэ.
- Бодитоор тоолсон бэлэн мөнгөний дүнг оруулна.
- Системийн тооцоо, бодит дүн болон зөрүүг шалгана.
- Ээлжийг хүлээлгэн өгөхөөр илгээнэ.
- Ердийн хоёр ажилтантай горимд өөрийн илгээсэн ээлжийг эцсийн байдлаар өөрөө батлахгүй. Идэвхжүүлсэн нэг ажилтантай горимын self-close нь 3-р хэсгийн тусгай дүрэмтэй.

### Ээлж авч буй Reception

- Хүлээлгэн өгч буй бэлэн мөнгийг дахин тоолж шалгана.
- Хүлээн авсан бодит дүнг батална эсвэл дахин тоолгуулахаар буцаана.
- Энэ баталгаа нь мөнгийг бодитоор хүлээн авсны баталгаа болохоос ээлжийн санхүүгийн эцсийн баталгаа биш байна.
- Дараагийн ээлжийн эхний бэлэн мөнгө нь хүлээн авч баталсан бодит дүн байна.

### Manager / Manager Plus

- Ээлжийн санхүүгийн хаалтын үндсэн баталгаажуулагч байна.
- Хүлээгдэж буй болон бодит бэлэн мөнгө, төлбөрийн задаргаа болон зөрүүг хянана.
- Ээлжийг эцэслэн баталж хаана. Шинэ ээлж эхлээгүй бол дахин шалгуулахаар буцааж болно; эхэлсэн бол хуучин ээлжийг дахин нээхгүй, маргаан/correction урсгал ашиглана.
- Ээлжийн хуучин гүйлгээг устгах, дүнг шууд засахгүй; шаардлагатай засварыг тусдаа залруулгын гүйлгээгээр бүртгэнэ.
- Дараагийн Reception байхгүй жижиг буудлын нөхцөлд ээлж хүлээн авагчийн үүргийг гүйцэтгэж болно.

### Hotel Admin

- Ээлжийн болон зөрүүний тайланг хянана.
- Ердийн горимд Manager боломжгүй, Manager өөрөө тухайн ээлжид Reception байдлаар ажилласан, эсвэл ноцтой/давтагдсан зөрүү гарсан үед орлох баталгаажуулагчаар ажиллана. Нэг ажилтантай горимд зөвхөн зөрүүтэй self-close-д review шаардана.
- Өдөр тутмын жирийн ээлж бүрийг заавал батлах үндсэн хэрэглэгч биш байна.

## 3. Хэн ээлжийг батлах вэ?

Батлагдсан үндсэн дүрэм:

- **Ердийн ээлжийн санхүүгийн хаалт:** Manager/Manager Plus эцэслэн батална.
- **Мөнгө хүлээлцэх:** Ээлж авч буй Reception бодитоор хүлээн авсан дүнгээ батална. Энэ нь Manager-ийн эцсийн баталгааг орлохгүй.
- **Дараагийн Reception байхгүй, ердийн горимд тусдаа Manager байгаа:** Manager мөнгийг хүлээн авч, санхүүгийн хаалтыг батална. Manager боломжгүй бол Hotel Admin орлоно.
- **Manager тухайн ээлжид Reception байсан, ердийн горим:** Hotel Admin эцэслэн батална.
- **Нэг ажилтантай горим:** Энэ нь өөрийн ээлжийг ердийн approver-аар батлах биш, тусдаа operational terminal self-close байна. Зөрүүгүй бол review шаардахгүй; зөрүүтэй бол Hotel Admin review хийнэ.

Manager-ийн баталгаа хүлээгдэж байсан ч мөнгө хүлээлцсэн даруй дараагийн Reception шинэ ээлжээ эхлүүлж болно. Ингэснээр санхүүгийн хяналт хадгалагдах боловч зочид буудлын 24/7 ажиллагаа зогсохгүй.

### Жижиг буудлын нэг ажилтантай горим

- Уг горимыг буудлын түвшинд Hotel Admin урьдчилан идэвхжүүлнэ; Reception өөрөө асаахгүй.
- Reception болон Manager/Manager Plus-ийн үүргийг нэг хүн гүйцэтгэж байгаа үед тусдаа хүлээн авагчгүйгээр өөрийн ээлжийг хааж болно.
- Систем уг ээлжийг operational terminal `Өөрөө хаасан` гэж ялгаж тэмдэглэнэ; дахин гүйлгээ нэмэхгүй.
- Хүлээгдэж буй дүн, анхны тоолсон дүн, зөрүү болон бүх гүйлгээний түүхийг өөрчлөхгүй хадгална.
- Өөрөө хаасан ээлжийг Hotel Admin тайлангаас тусад нь шүүж харах боломжтой байна.
- Зөрүү `0` бол нэмэлт баталгаа/review шаардахгүй.
- Зөрүүтэй бол operational хаалт хүчинтэй хэвээр үлдэж, санхүүгийн review status нь `Hotel Admin review шаардлагатай` болно.
- Өөр review хийх хүнгүй жижиг hotel-д Hotel Admin өөрийн ээлжийн review-г хийж болно; аудитад `self-reviewed` гэж тэмдэглэнэ.
- Дараагийн ээлж self-close үед бодитоор тоолсон дүнгээр шууд эхэлнэ.
- Нэг ажилтантай горим нь хаасан гүйлгээ засах, устгах эсвэл аудитын түүх алгасах эрх өгөхгүй.

## 4. Ээлж хаах үеийн тооцоо

### 4.1 Хүлээгдэж буй бэлэн мөнгө

```text
Хүлээгдэж буй бэлэн мөнгө
= Ээлж эхлэх үеийн бэлэн мөнгө
+ Бэлнээр авсан өрөөний төлбөр
+ Бэлнээр авсан минибар болон бусад төлбөр
+ Бэлнээр хүлээн авсан барьцаа
+ Cash top-up болон drawer/safe transfer in
+ Cash correction in
- Бэлнээр буцаасан төлбөр
- Бэлнээр буцаасан барьцаа
- Paid cash expense
- Drawer/safe transfer out
- Банк/owner/other withdrawal
- Cash correction out
```

QPay болон картын гүйлгээг төлбөрийн тайланд харуулах боловч кассанд байх хүлээгдэж буй **бэлэн мөнгөнд** нэмэхгүй.

`STAY-DEC-008` болон `STAY-DEC-012`-ын дагуу actual check-out эрт/орой болсон эсвэл өрөөний cleaning buffer-ийн readiness хугацаа шилжсэн нь дангаараа шинэ charge, payment, refund эсвэл cash movement үүсгэхгүй. Late check-out-д автомат хугацаа хэтрэлтийн төлбөр/торгууль нэмэхгүй; early check-out нь автоматаар reprice/refund хийхгүй. Зөвхөн тусдаа журмаар эцэслэгдэж, амжилттай баталгаажсан санхүүгийн гүйлгээ ээлжийн тооцоонд орно.

Барьцаанаас төлбөрт суутгах үед шинэ мөнгө кассанд орж ирэхгүй. Иймээс суутгасан дүнг бэлэн мөнгөнд дахин нэмэхгүй; зөвхөн барьцааны үлдэгдлээс зочны нэгдсэн тооцооны холбогдох өрөө, минибар эсвэл бусад мөр рүү шилжүүлж бүртгэнэ.

Typed movement, default/multiple drawer, optional safe, transfer/withdrawal/top-up болон expense execution-ийн canonical дүрэм: [24-cash-drawer-ledger.md](./24-cash-drawer-ledger.md).

### 4.2 P0-39B-1 — Initial check-in time ба shift isolation

Reception зөвхөн stay-г **анх баталгаажуулахдаа** `actual_check_in_at`-ийг server confirmation time-оос хойш биш, 120 минутаас ихгүй хугацаагаар буцааж сонгож болно. Сонгосон агшин current open shift-ийн эхлэлээс өмнө биш, hotel-local ижил календарь өдөрт, Online booking бол `planned_checkin_at`-аас өмнө биш байна. Reason code заавал сонгоно. Системийн баталгаажуулсан мөчийг тусдаа immutable `check_in_recorded_at` болгон server time-аар хадгална.

Backdated `actual_check_in_at` нь occupancy-ийн бодит эхлэлийг тэмдэглэхээс санхүүгийн effective time биш. Барьцаа, payment болон cash movement нь тухайн үйлдэл бодитоор баталгаажсан current open shift, drawer болон server effective time-д үлдэнэ; өмнөх shift рүү шилжүүлэх, historical movement үүсгэх, opening/closing snapshot-ийг дахин байгуулахгүй. Check-in үеийн tariff/configuration/stock/minibar snapshot-ийг мөн `check_in_recorded_at` дахь current authoritative state-аар нэг удаа үүсгэнэ. Paid/confirmed Online booking-ийн locked room-rate snapshot-ийг reprice хийхгүй.

Энэ backdate нь шинэ financial movement эсвэл нэмэлт approval үүсгэхгүй. Stay `Active` болсны дараа Reception `actual_check_in_at`-ийг шууд засахгүй; зөвхөн `STAY-DEC-010`-ын Reception request + Manager decision бүхий immutable amendment ашиглана. Actor, role, reason, `actual_check_in_at`, `check_in_recorded_at`, shift болон server validation result аудитад хадгалагдана.

### 4.3 P0-39B-2 — Active stay actual-time amendment

Stay `Active` бөгөөд check-out эхлээгүй үед Reception original `actual_check_in_at`-ийг overwrite хийхгүй, шинэ actual time болон reason бүхий correction request үүсгэнэ. Нэг stay-д нэг л pending request байна; pending хэвээр бол `Check-out эхлүүлэх` хориглогдоно. Manager request-ийг approve эсвэл reject хийнэ. Hotel Admin энэ operational action-ийг автоматаар өвлөхгүй, Manager role тусдаа шаардлагатай. Reception болон Manager role нэг account-д байгаа жижиг hotel-д self-approve зөвшөөрөх боловч audit-д `self-approved` гэж тусад нь тэмдэглэнэ.

Approve хийхэд original event өөрчлөгдөхгүй, immutable amendment үүсэж latest approved value-оос `effective_actual_check_in_at` derivation хийнэ. Requested time нь original `check_in_recorded_at`, original check-in shift, тухайн recorded-at hotel-local day болон Online booking-ийн original `planned_checkin_at`-аар тогтоосон `STAY-DEC-009`-ийн анхны цонхны дотор хэвээр байна. Approval transaction corrected time-ээс unchanged planned checkout хүртэлх overlap, өмнөх stay-ийн checkout + buffer, сонгосон агшны historical `Цэвэр`/minibar readiness болон stay/check-out state-ийг дахин шалгаж, idempotent/concurrency-safe шийдвэрлэнэ.

Энэ request/amendment зөвхөн actual start field-д үйлчилнэ. Planned checkout, duration, hourly/nightly type, room tariff, minibar price book/configuration/opening stock, deposit/payment/cash shift/effective/recognized time болон opening/closing balance-ийг өөрчлөхгүй; movement, reprice эсвэл historical reconstruction үүсгэхгүй. Check-out эхэлсэн эсвэл дууссан stay-д request/approve хийхгүй. Pending request `Approved` эсвэл `Rejected` terminal болсны дараа л check-out эхэлж болно (`STAY-DEC-010`).

### 4.4 P0-39C-1 — Planned checkout-ийн минимал хамгаалалт

Confirmed booking эсвэл `ACTIVE` stay-ийн `planned_checkout_at`-ийг Reception болон бусад хэрэглэгч generic edit/PATCH-аар шууд overwrite хийхгүй. Энэ MVP шийдвэр одоогоор хугацаа өөрчлөх шинэ button, API action, action taxonomy, permission/approval, eligibility, pricing, repricing, refund эсвэл payment урсгал нээхгүй.

MVP-д ийм change байхгүй. Зөвхөн MVP-ээс хойш тусдаа бизнесийн шийдвэрээр зөвшөөрвөл original утгыг хадгалсан append-only immutable history үүсгэж, before/after хугацаа, mandatory reason, actor account + тухайн үеийн role, server time-ийг бүртгэнэ. Apply хийх сервер transaction нь room overlap, readiness болон booking/stay-д snapshot хийсэн cleaning buffer-ийг дахин шалгана. Энэхүү post-MVP invariant өөрөө shift, cash drawer, deposit/payment/refund, charge/recognized time, room/minibar үнэ/configuration/stock snapshot эсвэл movement-д side effect үүсгэхгүй (`STAY-DEC-011`).

### 4.5 P0-39C-2 — Planned checkout MVP-д бүрэн түгжээтэй

`CONFIRMED` booking болон `ACTIVE` stay-ийн original `planned_checkout_at`-ийг MVP-д огт өөрчлөхгүй. Amendment, change request/action, button, API endpoint нээхгүй; хугацаа сунгах, planned end-ийг урагшлуулах болон hourly ↔ nightly conversion хийхгүй. `STAY-DEC-011`-ийн хамгаалалт хэвээр боловч түүний future amendment нөхцөл MVP-д executable биш (`STAY-DEC-012`).

Зочин эрт эсвэл орой гарсан үед Reception зөвхөн бодит `actual_checkout_at`-ийг бүртгэнэ; original planned end өөрчлөгдөхгүй. Early actual checkout автоматаар reprice/refund хийхгүй. Planned end өнгөрсөн active stay-д overdue status болон хугацааг л харуулж, automatic fee/penalty үүсгэхгүй. Room нь actual checkout бүртгэгдэх хүртэл occupied/blocking хэвээр; бүртгэгдсэний дараа л `actual_checkout_at + snapshotted cleaning buffer`, `Цэвэр` төлөв болон applicable minibar readiness-ийн P0-39A gate үйлчилнэ.

Энэ түгжээ shift, drawer, deposit/payment/refund, charge/recognized time, room/minibar үнэ, configuration/stock snapshot, task эсвэл movement-ийг өөрчлөхгүй, шинээр үүсгэхгүй.

### 4.6 Зөрүү

```text
Зөрүү = Бодитоор тоолсон бэлэн мөнгө − Хүлээгдэж буй бэлэн мөнгө
```

- `0` бол зөрүүгүй.
- Эерэг бол кассанд илүү мөнгө байна.
- Сөрөг бол кассанд мөнгө дутуу байна.

## 5. Үндсэн ажиллагааны дараалал

1. Ээлжээс бууж буй Reception **Ээлж хаах** үйлдлийг эхлүүлнэ.
2. Дуусаагүй QPay/картын гүйлгээг шийдвэрлэж, тухайн drawer оролцсон pending transfer-ийг complete эсвэл бодитоор буцаан тоолж cancel болгоно. Pending transfer хэвээр бол close/handover үргэлжлэхгүй. Дараа нь систем тухайн мөчийн төлбөр, буцаалт, барьцаа болон бусад мөнгөн хөдөлгөөний snapshot-ийг түгжинэ.
3. Reception системийн хүлээгдэж буй дүнг харахаасаа өмнө кассанд байгаа бэлэн мөнгийг тоолж, бодит дүнг оруулна.
4. Систем хүлээгдэж буй дүн болон зөрүүг бодож харуулна.
5. Reception ээлжийг хүлээлгэн өгөхөөр илгээнэ. Илгээсний дараа тухайн ээлжид шинэ гүйлгээ нэмэхгүй.
6. Ээлж авч буй Reception мөнгийг тусдаа тоолж, хүлээн авсан дүнг батална эсвэл дахин тоолгуулахаар буцаана.
7. Хоёр талын тооллого зөрвөл дахин тоолно. Зөрүү хэвээр бол бодитоор хүлээлцсэн дүнг хадгалж, хуучин ээлжийг `Маргаантай` төлөвт оруулна.
8. Мөнгө хүлээлцсэн бол шинэ ээлж бодитоор хүлээн авсан дүнгээр шууд эхэлж болно. Хуучин ээлж `Manager-ийн баталгаа хүлээж байгаа` төлөвт байна.
9. Шинэ ээлж эхлээгүй бол Manager хаалтыг дахин тоолгуулахаар буцааж болно.
10. Шинэ ээлж эхэлсэн бол Manager хуучин ээлжийг дахин `Нээлттэй`/editable болгохгүй; review-г `Маргаантай` болгож, `Зөрүүг зөвшөөрөх` эсвэл холбоостой correction үүсгэх замаар шийдвэрлэнэ.
11. Manager хаалтыг баталсан эсвэл маргааныг шийдвэрлэсний дараа ердийн ээлж `Хаагдсан` төлөвт орно.
12. Анхны expected/actual дүн, зөрүү, тооллого болон review түүхийг баталгаа/correction хийсэн ч устгахгүй.

## 6. Ээлжийн хоёр тусдаа төлөв

### 6.1 Operational төлөв

| Төлөв | Утга | Шинэ гүйлгээ нэмэх эсэх |
| --- | --- | ---: |
| **Нээлттэй** | Reception гүйлгээ бүртгэж байгаа идэвхтэй ээлж | ✓ |
| **Хааж байгаа** | Бэлэн мөнгө тоолж, хаалтын snapshot бэлдэж байгаа | — |
| **Хүлээлгэн өгсөн** | Бууж буй Reception илгээсэн, хүлээн авагч хүлээж байгаа | — |
| **Дахин тоолох шаардлагатай** | Шинэ ээлж эхлэхээс өмнө дүнг дахин шалгана | — |
| **Мөнгө хүлээн авсан** | Дараагийн Reception бодит дүнг хүлээн авч, шинэ ээлж эхлэх боломжтой | — |
| **Өөрөө хаасан** | Нэг ажилтантай горимын operational terminal төлөв | — |
| **Хаагдсан** | Ердийн ээлжийн review/шийдвэр дууссан terminal төлөв | — |

`Өөрөө хаасан` болон `Хаагдсан` ээлжийг буцааж `Нээлттэй` болгохгүй. `Мөнгө хүлээн авсан` ээлж ч transaction талдаа түгжигдсэн байна; зөвхөн review шийдвэр хүлээж болно.

### 6.2 Санхүүгийн review төлөв

| Review төлөв | Хэзээ ашиглах вэ |
| --- | --- |
| **Шаардахгүй** | Зөрүүгүй self-close |
| **Manager review хүлээж байгаа** | Ердийн мөнгө хүлээлцэлт дууссан |
| **Hotel Admin review шаардлагатай** | Зөрүүтэй self-close; ердийн горимд Manager өөрөө Reception байсан; Manager боломжгүй exception |
| **Маргаантай** | Review actor дүн/зөрүүг зөвшөөрөөгүй боловч дараагийн ээлж аль хэдийн эхэлсэн |
| **Reviewed/Resolved** | Зөрүүг зөвшөөрсөн эсвэл correction-оор шийдвэрлэсэн |

Operational болон review төлөвийг нэг field-д холихгүй. Жишээлбэл `Өөрөө хаасан + Hotel Admin review шаардлагатай` гэсэн хос төлөв хүчинтэй байна.

## 7. Хадгалах аудитын мэдээлэл

- Ээлж эхэлсэн, хаах хүсэлт илгээсэн, хүлээн авсан болон баталсан огноо/цаг.
- Ээлжээс буусан, ээлж авсан болон зөрүү баталсан хэрэглэгч.
- Эхний үлдэгдэл, хүлээгдэж буй дүн, хоёр талын тоолсон бодит дүн болон зөрүү.
- Төлбөрийн төрлөөрх нийт дүн.
- Хүлээн авсан, буцаасан болон суутгасан барьцааны нийлбэр.
- Дахин тоолуулахаар буцаасан болон Manager/Hotel Admin-аар баталсан үйлдлийн түүх.
- Хаасан ээлжийн өгөгдлийг устгахгүй; залруулгыг шинэ, холбоостой гүйлгээгээр бүртгэнэ.
- Шинэ ээлжийн opening balance, correction-ийн дүн/төрөл/effective time болон холбоотой хуучин shift ID.
- Accept, recount, reject/dispute, variance approval, review, self-review болон correction бүрийн actor, огноо/цаг. Recount/reject/dispute, зөрүүг зөвшөөрөх болон correction-д reason заавал; зөрүүгүй энгийн accept-д reason шаардахгүй.
- Нэг касс/ажлын цэг дээр нэг агшинд зөвхөн нэг идэвхтэй ээлж ажиллана.
- Ажилтан бүр өөрийн хэрэглэгчийн эрхээр ажиллана; Reception-ийн дундын account ашиглахгүй.
- Амжилттай баталгаажаагүй QPay/картын гүйлгээг амжилттай орж ирсэн төлбөрт тооцохгүй. Finalized charge-д суурилсан баталгаажсан борлуулалтыг payment success-ээс тусад нь тайлагнана.

## 8. Батлагдсан жижиг буудлын нөхцөл

Жижиг буудалд нэг хүн Reception болон Manager/Manager Plus-ийн ажлыг зэрэг гүйцэтгэх боломжтой. Энэ тохиолдолд Hotel Admin-аар идэвхжүүлсэн `нэг ажилтантай горим` ашиглан өөрийн ээлжийг хаахыг зөвшөөрнө. Ийм ээлжийг жирийн хоёр ажилтантай хүлээлцсэн ээлжээс ялгаж тайлагнана. Зөрүүгүй self-close нэмэлт баталгаагүй terminal; зөрүүтэй self-close terminal хэвээр боловч Hotel Admin review шаардлагатай байна.

## 9. Opening balance ба дараах correction

### 9.1 Opening balance

- Ердийн хүлээлцэлтэд шинэ ээлжийн opening balance нь дараагийн Reception-ийн бодитоор тоолж **хүлээн авсан дүн** байна.
- Self-close үед дараагийн ээлжийн opening balance нь хаахдаа бодитоор **тоолсон дүн** байна.
- Expected cash эсвэл өмнөх системийн balance-ийг actual opening balance болгон хүчээр ашиглахгүй.
- Шинэ ээлж эхэлсний дараа opening balance-ийг буцааж overwrite хийхгүй.

### 9.2 Manager rejection/dispute

- Шинэ ээлж эхлээгүй бол `Дахин тоолох шаардлагатай` төлөвт буцааж болно.
- Шинэ ээлж эхэлсэн бол хуучин ээлжийг дахин нээхгүй; review status-ийг `Маргаантай` болгоно.
- Review actor `Зөрүүг зөвшөөрөх` эсвэл `Correction үүсгэх` шийдвэрийн аль нэгийг reason-тэй сонгоно.
- Нотлох зураг/файл MVP-д заавал биш.

### 9.3 Correction

Хожим мөнгө олдох, тооллогын алдаа тогтоогдох эсвэл бусад санхүүгийн залруулга шаардлагатай бол:

- original shift, expected cash, actual cash болон opening balance-ийг edit/delete хийхгүй;
- correction-ийг илэрсэн/effective болсон үед шинэ, холбоостой хөдөлгөөнөөр бүртгэнэ;
- correction бодитоор кассанд нэмэгдсэн/хасагдсан бол тухайн үед идэвхтэй shift-ийн expected cash-д шинэ хөдөлгөөнөөр нөлөөлнө;
- original shift ID, correction reason, actor, approver болон effective time хадгална.

Жишээ:

```text
Хуучин expected cash:          1,000,000₮
Бодитоор хүлээн авсан:           990,000₮
Шинэ shift opening balance:      990,000₮
Анхны зөрүү:                     -10,000₮

Дараа нь олдсон мөнгө:           +10,000₮ correction
Хуучин opening/closing дүнг overwrite хийхгүй.
```

Cash drawer, withdrawal, safe transfer болон correction movement-ийн нарийн төрлийг [24-cash-drawer-ledger.md](./24-cash-drawer-ledger.md)-д CASH-DEC-001–010-аар баталсан.

## 10. MVP acceptance criteria

- Operational болон financial review төлөв тусдаа хадгалагдана.
- Мөнгө бодитоор хүлээн авмагц Manager review хүлээлгүй дараагийн ээлж эхэлж чадна.
- Шинэ ээлжийн opening balance нь бодитоор хүлээн авсан/self-close үед тоолсон дүн байна.
- `Өөрөө хаасан` нь operational terminal бөгөөд дахин гүйлгээ нэмэхгүй.
- Зөрүүгүй self-close-д нэмэлт review шаардахгүй.
- Зөрүүтэй self-close-д Hotel Admin review шаардлагатай боловч дараагийн ээлжийг хориглохгүй.
- Өөр review actor байхгүй үед Hotel Admin self-review хийж, аудитад `self-reviewed` гэж хадгална.
- Шинэ ээлж эхэлсний дараах Manager rejection хуучин ээлжийг дахин нээхгүй.
- Зөрүүг зөвшөөрөх эсвэл correction хийх шийдвэр reason-тэй байна.
- Original close/opening balance immutable; correction холбоостой шинэ хөдөлгөөн байна.
- Pending drawer transfer complete/cancel болоогүй бол source/destination shift close/handover хийхгүй.
- Accept/recount/reject/review/self-review/correction бүх үйлдэл аудиттай байна.
- Early/late actual check-out болон cleaning-buffer readiness-ийн өөрчлөлт дангаараа shift-ийн expected cash-д хөдөлгөөн үүсгэхгүй; late check-out-д automatic overdue fee тооцохгүй.
- Initial confirmation дээр зөвшөөрсөн backdated `actual_check_in_at` нь deposit/payment/cash movement-ийн shift/effective time болон opening/closing snapshot-ийг өөрчлөхгүй; `check_in_recorded_at` server time authoritative байна.
- Stay active болсны дараа Reception check-in time-ийг шууд edit хийхгүй; initial backdate actor/reason/two timestamps/current shift-тэй аудиттай байна.
- Active stay actual-time correction нь Reception request + Manager approve/reject бүхий immutable amendment байна; multi-role self-approval `self-approved` flag-тай, нэг pending request check-out initiation-ийг блоклоно.
- Approved amendment shift/payment/cash/recognized time, opening/closing balance эсвэл snapshot-ийг өөрчлөхгүй; check-out эхэлсэн/дууссан үед зөвшөөрөхгүй.
- Confirmed booking/active stay-ийн `planned_checkout_at` change MVP-д байхгүй; STAY-DEC-011-ийн append-only history/revalidation нь зөвхөн post-MVP change хожим тусдаа батлагдвал мөрдөх invariant байна.
- Энэхүү минимал guard өөрөө шинэ хугацаа өөрчлөх action, permission/approval, үнэ/төлбөр/refund эсвэл shift/cash movement үүсгэхгүй.
- Confirmed booking/active stay-ийн planned checkout MVP-д өөрчлөгдөхгүй; amendment/action/button/API, extension, shorten болон hourly/nightly conversion байхгүй.
- Early/late actual checkout нь original planned end-д хүрэхгүйгээр `actual_checkout_at` л бүртгэнэ; early үед auto reprice/refund, overdue үед auto fee/penalty үүсэхгүй.
- Room actual checkout хүртэл occupied хэвээр; дараа нь snapshot buffer + clean + minibar readiness gate үйлчилж, C2 өөрөө shift/cash/financial/snapshot side effect үүсгэхгүй.

## 11. Батлагдсан шийдвэр

### SHIFT-DEC-001 — Operational ба review төлөв тусдаа

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Мөнгө хүлээлцэх operational workflow болон Manager/Hotel Admin-ийн financial review-г тусдаа төлөвөөр хадгална; review хүлээлт 24/7 ажиллагааг зогсоохгүй.

### SHIFT-DEC-002 — Actual cash opening balance

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Дараагийн ээлжийн opening balance нь ердийн горимд хүлээн авагчийн бодитоор тоолж хүлээн авсан, self-close-д хаахдаа бодитоор тоолсон дүн байна.

### SHIFT-DEC-003 — Self-close terminal

- **Төлөв:** Батлагдсан
- **Шийдвэр:** `Өөрөө хаасан` нь operational terminal төлөв. Зөрүү `0` бол нэмэлт review шаардахгүй; зөрүүтэй бол Hotel Admin review шаардлагатай ч дараагийн ээлж эхэлж болно.

### SHIFT-DEC-004 — Self-review fallback

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Өөр review actor байхгүй жижиг hotel-д Hotel Admin өөрийн ээлжийг review хийж болох бөгөөд `self-reviewed` audit хадгална.

### SHIFT-DEC-005 — Rejection хуучин ээлжийг дахин нээхгүй

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Шинэ ээлж эхэлсний дараа Manager/Hotel Admin rejection нь хуучин ээлжийг editable/open болгохгүй; `Маргаантай` review-ээр зөрүүг зөвшөөрөх эсвэл correction хийж шийдвэрлэнэ.

### SHIFT-DEC-006 — Immutable opening ба correction

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Original close болон шинэ ээлжийн opening balance-ийг буцааж overwrite хийхгүй. Correction нь effective үедээ original shift-тэй холбоотой шинэ хөдөлгөөн байна.

### SHIFT-DEC-007 — Audit

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Accept, recount, reject/dispute, variance approval, review/self-review болон correction бүр actor, time, холбоостой shift/movement-тэй аудитад хадгалагдана. Recount/reject/dispute, зөрүүг зөвшөөрөх болон correction-д reason заавал; зөрүүгүй энгийн accept-д reason шаардахгүй.

## 12. Дараагийн баталгаажуулах нэг асуудал

P0-34–P0-39 болон hourly precision хаагдсан. Cash ledger-ийн source of truth нь [24-cash-drawer-ledger.md](./24-cash-drawer-ledger.md), minibar selling price-ийн source of truth нь [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md), entity/configuration/template version ба Rollout-ийн source of truth нь [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md). Stay-ийн canonical шийдвэр `STAY-DEC-008`–`014`; overdue conflict remedy болон fractional duration нь shift/cash хөдөлгөөний түүхийг overwrite хийхгүй.
