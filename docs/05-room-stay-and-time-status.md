# Өрөөний байрлалтын төрөл ба цагийн төлөв

**Хувилбар:** 0.29  
**Төлөв:** Цаг/үнийн суурь дүрэм, P0-37, P0-38A/B/C, P0-39A–D, бутархай цагийн precision болон overdue stay–дараагийн booking хамгаалалт батлагдсан  
**Хамаарах үе шат:** MVP — Reception system

## 1. Зорилго

Check-in хийх үед зочин өрөөг цагаар эсвэл хоногоор ашиглахыг бүртгэж, өрөөний одоогийн болон дараагийн захиалгын хугацааг Reception-д ойлгомжтой харуулна. Систем нэг өрөөнд хугацаа давхардсан байрлалт, захиалга үүсэхээс хамгаална.

## 2. Хооронд нь тусдаа хадгалах ойлголтууд

Өрөөний мэдээллийг нэг ерөнхий төлөвөөр хязгаарлахгүй, дараах чиглэлүүдээр тусад нь хадгална:

1. **Захиалгын эх үүсвэр** — Walk-in эсвэл Online.
2. **Ашиглалтын төлөв** — сул, захиалгатай, check-in хийсэн, check-out хийгдэж байгаа.
3. **Тооцооны төрөл** — цагаар эсвэл хоногоор.
4. **Цагийн мэдээлэл** — эхлэх огноо/цаг, төлөвлөсөн дуусах огноо/цаг, үлдсэн эсвэл хэтэрсэн хугацаа.
5. **Цэвэрлэгээний төлөв** — цэвэр, цэвэрлэгээ шаардлагатай, цэвэрлэж байгаа.
6. **Минибарын mode/дүүргэлт** — 25,000₮/30,000₮ багцад хамаарахгүй, бүтэн, дутуу эсвэл тодорхойгүй; дутуу бол Manager-ийн shortage exception байгаа эсэх.
7. **Минибарын шалгалт** — 25,000₮/30,000₮ багцын minibar-enabled өрөөнд Cleaner report-ийн хүлээлт, шалгалт, илгээх, залруулах, payment lock болон тооцоонд орсон lifecycle.
8. **Entity lifecycle** — өрөө болон ангилал `ACTIVE`, `RETIRING` эсвэл `INACTIVE` эсэх.
9. **Minibar configuration change** — current mode/template exact version, pending target exact version, reconciliation state болон check-in/assignment blocker; зөвхөн 25,000₮/30,000₮ багцад.
10. **Template version lifecycle** — template entity lifecycle-ээс тусдаа `DRAFT`, `PUBLISHED`, `ARCHIVED` төлөв болон шинэ assignment-д ашиглах `Default Published` version.

Ингэснээр өрөө одоо сул боловч орой захиалгатай, эсвэл зочин гарсан боловч цэвэрлэгдээгүй зэрэг нөхцөлийг зөв харуулна.

Төлөвлөсөн болон бодит хугацааг тусад нь хадгална:

- төлөвлөсөн check-in огноо/цаг;
- төлөвлөсөн check-out огноо/цаг;
- бодит check-in огноо/цаг (`actual_check_in_at`);
- check-in-ийг системд баталгаажуулсан серверийн огноо/цаг (`check_in_recorded_at`);
- бодит check-out огноо/цаг.

`Үлдсэн хугацаа`, `дуусах дөхсөн`, `хугацаа хэтэрсэн` зэрэг цагийн төлөвийг гараар хадгалж өөрчлөхгүй. Систем дээрх хугацаанууд болон серверийн одоогийн цагаас автоматаар бодож харуулна.

## 3. Check-in хийх үеийн сонголт

Reception дараах мэдээллийг сонгож эсвэл баталгаажуулна:

- өрөө;
- байрлалтын төрөл: `Цагаар` эсвэл `Хоногоор`;
- бодит check-in огноо/цаг; default нь эцсийн баталгаажуулалтын серверийн цаг бөгөөд зөвхөн анхны баталгаажуулалтаас өмнө P0-39B-1-ийн хүрээнд ухрааж болно;
- төлөвлөсөн check-out огноо/цаг;
- үргэлжлэх цаг эсвэл хоногийн тоо;
- серверээс бодсон хүчинтэй үнийн тариф болон түүний эх сурвалж;
- өрөөний төлбөрийн урьдчилсан дүн.

30,000₮ багцад check-in амжилттай батлагдсаны дараа систем Restaurant менюд нэвтрэх 4–6 оронтой нэг удаагийн guest access код үүсгэнэ. Код нь зөвхөн тухайн `hotel + room + stay`-д хамаарна. Reception нэмэлт төхөөрөмжид зориулж тусдаа нэг удаагийн код үүсгэж болох бөгөөд нэг stay-д дээд тал нь 5 идэвхтэй guest session байна.

Онлайн захиалгатай зочны хувьд байрлалтын төрөл болон төлөвлөсөн хугацааг захиалгын мэдээллээс автоматаар авна. Online booking зөвхөн хоногоор, нэг booking нэг category room/нэг үндсэн зочинтой байна. Booking confirmed болсны дараа planned checkout, selected duration болон stay type-ийг check-in дээр өөрчлөхгүй; огноо/төрөл солих бол direct edit биш, cancel + шинэ booking байна (`BK-DEC-012`, `PAY-DEC-007`, `STAY-DEC-012`).

Actual check-in цагийг client төхөөрөмжийн цаг, form нээсэн цаг эсвэл Reception-ийн дурын утгаар батлахгүй. Эцсийн check-in transaction эхлэхэд сервер `check_in_recorded_at`-ийг тогтоож, default `actual_check_in_at`-ийг түүнтэй ижил болгоно. Reception backdate сонгосон бол §19-ийн 120 минут, open shift, hotel-local өдөр болон online booking-ийн planned start заагийг сервер шалгана.

25,000₮/30,000₮ багцын minibar-enabled өрөөнд check-in амжилттай батлагдахтай нэг transaction-д current configuration-д заасан exact template version-ийн бүх product selling price-ийг stay price book болгон үүсгэнэ. Price book бүрэн үүсэхгүй бол stay-г active болгохгүй. Дэлгэрэнгүйг [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md)-д тодорхойлсон.

Шинэ check-in-д room болон category хоёул `ACTIVE` байна. `RETIRING/INACTIVE` entity-г existing booking ID эсвэл client-ийн шууд ID-гаар илгээсэн ч сервер хориглоно. Deactivation-оос өмнө баталгаажсан booking автоматаар цуцлагдахгүй; entity-г reactivate хийх, booking-г өөр `ACTIVE` room/category руу шилжүүлэх эсвэл cancellation урсгалаар шийдтэл check-in blocker-тэй confirmed хэвээр байна. Minibar-enabled room-ийн template entity болон бүх template product мөн `ACTIVE` биш бол configuration blocker үйлчилнэ. Room current configuration нь exact `PUBLISHED` version заана; `DRAFT/ARCHIVED` version-ийг assignment/check-in-д ашиглахгүй. Current/pending reference-тэй version archive болохгүй тул хүчинтэй room configuration-г Archive үйлдлээр Archived төлөвт оруулах боломжгүй.

Room-д non-terminal pending minibar configuration change байвал physical room шинэ check-in/assignment авахгүй. Future booking-ийн minibar config-ийг booking үед pin хийхгүй; change амжилттай дууссан бол check-in үеийн current config-д заасан exact version-ийг ашиглана. Change дуусаагүй бол booking confirmed хэвээр боловч тухайн room-д check-in хийхгүй, өөр eligible room руу шилжүүлж болно. Шинэ Draft/version publish болох эсвэл Default Published version солигдох нь existing room, active stay болон future booking-г автоматаар өөрчлөхгүй. Canonical lifecycle ба reconciliation: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md).

Template entity-ийн `ACTIVE/RETIRING/INACTIVE` lifecycle-ээс version-ийн `DRAFT/PUBLISHED/ARCHIVED` lifecycle тусдаа байна. `DRAFT` засварлагдаж болох ч assignment/check-in-д ашиглагдахгүй; `PUBLISHED` version-ийн product list/target quantity immutable тул өөрчлөлтийг шинэ Draft/version-оор хийнэ; `ARCHIVED` terminal/history-only, шинэ assignment-д ашиглагдахгүй, Published руу шууд сэргээхгүй бөгөөд дахин ашиглахдаа шинэ Draft clone үүсгэнэ. Олон Published version зэрэгцэн байж болох бөгөөд Published version-тэй template бүр шинэ assignment-д зориулсан нэг Default Published version-тэй байна. Ашиглагдсан/reference-тэй exact version stay/configuration/audit түүхдээ хадгалагдана.

Publish хийхэд parent template entity `ACTIVE`, дор хаяж нэг product байгаа бөгөөд бүх product тухайн hotel-д хамаарах `ACTIVE`, давхардалгүй, target quantity бүр эерэг бүхэл тоо эсэхийг сервер шалгана. Анхны Published version автоматаар цорын ганц Default болно; дараагийн publish одоогийн Default-ийг автоматаар солихгүй. Default version-ийг archive хийх бол эхлээд өөр eligible Published version-ийг Default болгоно. Room current/pending, active stay эсвэл non-terminal reconciliation/Cleaner/configuration task-д reference-тэй exact version archive болохгүй. Historical stay/report/price book/audit reference blocker болохгүй, түүхдээ хадгалагдана; future booking version pin хийдэггүй тул өөрөө blocker биш.

`Publish`, `Set default`, `Archive` нь existing room current/pending, active stay, future booking, inventory/stock-ийг өөрчлөхгүй, Cleaner task, configuration request эсвэл check-in blocker үүсгэхгүй. Эдгээр үйлдэл болон exact-version Rollout зөвхөн идэвхтэй minibar entitlement + зөвшөөрөгдсөн role-д нээгдэнэ: 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus; Hotel Admin дээрх role-ийг тусдаа авна. 20,000₮/entitlement-гүй үед хориглож, 25,000₮-д Manager Plus үүсгэж gate тойрохгүй.

Explicit Rollout нь тухайн hotel-ийн ижил `ACTIVE` template entity-ийн бүх product нь `ACTIVE` exact `PUBLISHED` target-ийг сонгоно; target Default байх албагүй, eligibility-г Confirm дээр сервер дахин шалгана. Зөвхөн lifecycle `ACTIVE`, minibar mode `ON`, target-аас өөр current version-тэй, non-terminal pending configuration-гүй room eligible; mode/template switch нь ердийн configuration change бөгөөд Rollout биш. Active stay-тай room сонгогдож болох ч confirm хийхэд current stay-ийн version/opening/price book өөрчлөгдөхгүй.

Rollout confirm нь exact target-тай room pending request болон check-in/assignment blocker-ийг атомикаар шууд үүсгэнэ. Safe/vacant room-д request `READY_FOR_RECONCILIATION` болж Cleaner reconciliation task шууд үүснэ; active stay эсвэл checkout/payment/minibar report/refill дуусаагүй бол request `SCHEDULED_AFTER_STAY` төлөвтэй байж, existing safe point хангагдсаны дараа task үүснэ. Confirm өөрөө current version, stock, selling price болон cleaning status-д хүрэхгүй; Cleaner reconciliation + existing P0-37B validation амжилттай дуусахад apply атомикаар хийгдэнэ. Дараагийн Publish/Default pending exact target-ийг солихгүй, pending target reference Archive-ийг хориглоно.

Multi-room Rollout нь нэг exact target version болон ижил hotel/template-ийн олон room бүхий batch байна. Read-only preview room бүрийг `Одоо хийх боломжтой`, `Stay дууссаны дараа`, `Сонгох боломжгүй` гэж шалтгаантай ангилах боловч availability, stay, pending request, blocker, Cleaner task, stock эсвэл Archive eligibility-г өөрчлөхгүй. Confirm агшинд room бүрийг дахин шалгаж partial success хэрэглэнэ: accepted child pending request + check-in/assignment blocker-оо атомикаар авч, invalid child `SKIPPED` болох бөгөөд blocker авахгүй. Нэг child failure бусад child-ийг rollback хийхгүй.

Accepted active-stay room `SCHEDULED_AFTER_STAY` болж current stay-ийн exact version/opening/price book болон төлөвлөсөн хугацааг хэвээр хадгална; safe point-д хүрсний дараа л Cleaner task үүснэ. Accepted room нь confirm-оос эхлэн шинэ availability/assignment/check-in-д орохгүй. `Cancel remaining` нь movement эхлээгүй child-ийг цуцалж blocker-ийг арилгана; хөдөлгөөн эхэлсэн child rollback terminal болтол blocker-тэй, `APPLIED` room хэвээр байна. Буцаах бол өмнөх exact version рүү шинэ Rollout үүсгэнэ. Retry нь хуучин түүхийг засахгүй, `retry_of_batch_id`-тай шинэ batch байна.

Batch target exact ID-аар түгжигдэж, дараагийн Publish/Default өөрчлөлтөөр солигдохгүй. Preview болон zero-accepted `FAILED_VALIDATION` batch Archive blocker биш; confirmed non-terminal child/batch target version-ийг Archive хийхгүй. Duplicate Confirm idempotent бөгөөд нэг room-д нэгээс олон pending change, cross-hotel/cross-template target үүсгэхийг сервер хориглоно. Batch state `IN_PROGRESS`, `COMPLETED`, `PARTIALLY_COMPLETED`, `CANCELLED`, `FAILED_VALIDATION` утгатай. Эрх нь 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus; Hotel Admin-д зөвшөөрөгдсөн role тусдаа шаардлагатай, 20,000₮ болон 25,000₮ багцын Manager Plus-д хориглоно. Reception үр дүн/blocker-ийг read-only харж, Cleaner зөвхөн assigned child task гүйцэтгэнэ.

Canonical суурь: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md)-ийн RML-DEC-015–028.

## 4. Өрөөний карт дээр харагдах цагийн төлөв

Өрөөний жагсаалтын карт дор хаяж дараах мэдээллийг харуулна:

- өрөөний дугаар, ангилал;
- захиалгын эх үүсвэр `Walk-in` эсвэл `Online`;
- одоогийн ашиглалтын төлөв;
- `Цагаар` эсвэл `Хоногоор` гэсэн тэмдэглэгээ;
- одоогийн байрлалтын эхлэх, төлөвлөсөн дуусах цаг;
- үлдсэн хугацаа эсвэл хугацаа хэтэрсэн мэдээлэл;
- дараагийн баталгаажсан захиалгын цаг;
- цэвэрлэгээний төлөв;
- боломжтой багцад минибарын төлөв.
- room/category lifecycle болон `RETIRING` бол blocker-ийн товч badge.
- current minibar mode/template exact version, pending target exact version/state болон `Configuration change pending` blocker.

Жишээ:

```text
Өрөө 203 · Walk-in · Check-in хийсэн · Цагаар
14:00–17:00 · 42 минут үлдсэн
Дараагийн захиалга: 18:00–22:00
Минибар: Бүтэн
```

```text
Өрөө 205 · Одоо сул · 17:30 хүртэл ашиглах боломжтой
Дараагийн захиалга: 18:00–Маргааш 12:00
Төлөв: Цэвэр
```

## 5. Цагийн төлөвийн үндсэн дүрэм

- Ирээдүйн захиалгатай өрөөг одоо шууд `эзэлсэн` гэж харуулахгүй; одоо сул эсэх болон хэдий хүртэл ашиглах боломжтойг харуулна.
- Захиалгын эхлэх цаг болсон ч зочин ирээгүй бол `Захиалгын цаг болсон — check-in хүлээж байна` гэж харуулна.
- Төлөвлөсөн check-out цаг өнгөрөхөд систем автоматаар check-out хийхгүй; `Хугацаа хэтэрсэн` гэж тэмдэглэж Reception-д анхааруулна. Энэ төлөв дангаараа нэмэлт төлбөр үүсгэхгүй.
- Check-out-ыг зөвхөн эрхтэй Reception хэрэглэгч бодитоор дуусгана.
- Төлөгдсөн боловч эцсийн төлөвт ороогүй Restaurant захиалга check-out-ыг хатуу хориглохгүй. Reception зочинд мэдэгдсэнээ баталгаажуулсны дараа үргэлжлүүлнэ.
- Дуусаагүй захиалга бүрд Reception `Reception дээр хүлээн авах`, `Зочин Restaurant-аас өөрөө авах`, `Цуцлалт/буцаалт хүсэх` сонголтын аль нэгийг бүртгэнэ. Сонголт бүртгэгдээгүй бол эцсийн check-out батлахгүй.
- Check-out дуусмагц тухайн stay-д хамаарах ашиглагдаагүй guest access код болон идэвхтэй guest session-ууд автоматаар хүчингүй болно.
- Өрөө `цэвэр` биш бол шинэ check-in хийхийг зөвшөөрөхгүй.
- `RETIRING/INACTIVE` room/category-д шинэ booking/check-in/assignment хийхгүй. Deactivation-оос өмнөх confirmed booking-г автоматаар cancel/reprice хийхгүй боловч reactivate/active entity рүү шилжүүлэх/цуцлах хүртэл check-in хийхгүй.
- Minibar-enabled room-ийн template entity эсвэл template product `ACTIVE` биш бол шинэ booking/check-in хориглоно.
- `DRAFT` template version-ийг current/pending assignment болон check-in-д ашиглахгүй. Published/default өөрчлөлт existing room/stay-ийн exact version reference-ийг солихгүй, existing future booking-г cancel/reprice/config-pin хийхгүй.
- Non-terminal pending minibar configuration change-тэй physical room-ийг шинэ availability/assignment-аас хасаж, check-in хориглоно. Existing future booking-г автоматаар cancel/reprice хийхгүй; change-г terminal болгох эсвэл өөр eligible room руу шилжүүлнэ.
- 20,000₮ багцад өрөөний бодит check-out дууссан, snapshot хийсэн cleaning buffer өнгөрсөн бөгөөд өмнө батлагдсан package permission-ийн дагуу Manager өрөөг `Цэвэр` болгосон үед дахин ашиглах боломжтой болно.
- 25,000₮/30,000₮ багцын minibar-disabled өрөөнд мөн бодит check-out, cleaning buffer болон Cleaner-ийн `Цэвэр` төлөв гурвуул шаардагдана.
- Minibar-enabled өрөөний хувьд дээрх нөхцөлүүдээс гадна minibar-ын applicable readiness дүрэм хангагдсан байна; ердийн тохиолдолд minibar `Бүтэн` болсон байна.
- Minibar `Дутуу` бол зөвхөн Manager/Manager Plus-ийн дараагийн stay-д хүчинтэй шалтгаан, бодит эхний snapshot болон audit-тай shortage override-аар check-in зөвшөөрнө. `Тодорхойгүй` үед хориглоно.
- Цагаар эсвэл хоногоор байрласан эсэх нь барьцааны дүрмийг өөрчлөхгүй: walk-in байрлалт барьцаатай, баталгаажсан онлайн захиалга барьцаагүй байна.

Minibar readiness-ийн canonical дүрэм: [22-minibar-stock-inventory.md](./22-minibar-stock-inventory.md).

## 6. Давхардлаас хамгаалах

- Захиалга болон stay бүрийн эзэмшлийн хугацааг төгсгөлийн цэг орохгүй `[start_at, end_at)` интервалаар тооцно. Иймээс нэг интервалын `end_at` нь нөгөөгийн `start_at`-тай тэнцүү байх нь өөрөө occupancy overlap биш.
- Нэг өрөөний баталгаажсан захиалга болон идэвхтэй байрлалтын occupancy интервал хоорондоо давхцахгүй. Гэхдээ дараагийн ашиглалтад cleaning buffer тусдаа заавал тооцогдоно.
- Бодит check-out хийгдээгүй үед availability/booking төлөвлөлтийн хамгийн эрт боломжит цагийг `planned_checkout_at + snapshotted_cleaning_buffer` гэж бодно. Дараагийн захиалгын эхлэл энэ цагаас өмнө байж болохгүй.
- Бодит check-out бүртгэгдсэнээс хойш room readiness-ийн authoritative хугацааны зааг `actual_checkout_at + snapshotted_cleaning_buffer` болж шинэчлэгдэнэ.
- Check-in батлахын өмнө систем next booking/active stay overlap, authoritative readiness time, эрх бүхий хэрэглэгчийн тогтоосон бодит `Цэвэр` төлөв болон хамаарах minibar readiness-ийг дахин шалгана.
- Backdate сонгосон бол дээрх readiness болон lifecycle/blocker-ийг зөвхөн одоогийн төлөвөөр бус, сонгосон `actual_check_in_at` агшинд хүчинтэй байсан audit event-үүдээр нотолж дахин шалгана. Түүхэн readiness нотлогдохгүй бол backdate-ийг хориглоно.
- Manager буудлын үндсэн цэвэрлэгээний хамгийн бага хугацааг минутаар тохируулна. Шаардлагатай бол өрөөний ангилал бүрд өөр хугацаа тохируулж болно.
- Reception цэвэрлэгээний хамгийн бага хугацааг өөрчлөхгүй.
- Төлөвлөсөн хугацаа cleaning buffer-тэйгээ багтахгүй бол систем booking/check-in-ыг хориглож, боломжтой хугацаа эсвэл өөр өрөөг санал болгоно.
- Давхцлын шалгалтыг зөвхөн дэлгэц дээр бус сервер талд хийнэ. Хоёр Reception зэрэг ажилласан ч нэг өрөөг давхар олгохгүй.
- Бүх огноо/цагийг тухайн буудлын timezone-аар хадгалж, харуулна. Улаанбаатарын буудалд `Asia/Ulaanbaatar` ашиглана.

## 7. Төлбөр тооцооны суурь дүрэм

- Manager бүх багцад цагийн болон хоногийн тарифыг хооронд нь тусдаа дараах түвшнээр тохируулна:
  1. hotel-ийн үндсэн тариф;
  2. room category-ийн optional override;
  3. physical room-ийн optional override.
- Override тохируулаагүй (`null/unset`) бол дараагийн доод түвшний утгыг автоматаар өвлөнө. Цагийн override нь хоногийн тарифт, хоногийн override нь цагийн тарифт нөлөөлөхгүй.
- Walk-in check-in-ийн хүчинтэй тарифыг сервер `room override → category override → hotel default` дарааллаар олно.
- Online booking-ийн quote/confirmation нь physical room хараахан оноогдоогүй тул `category override → hotel default` дараалал ашиглаж, room override-ийг тооцохгүй.
- Online booking зөвхөн nightly тул online hourly тариф ашиглахгүй (`BK-DEC-012`).
- Төлбөр хийгдсэн/баталгаажсан online booking-ийн tariff snapshot-ийг physical room assignment эсвэл check-in үед room override-оор дахин бодохгүй.
- Reception duration, room болон stay type-ийг сонгох боловч нэгж үнэ, source level эсвэл config version-ийг гараар оруулах/солихгүй. Сервер effective tariff-ийг authoritative байдлаар бодно.
- Цагийн байрлалтын урьдчилсан өрөөний төлбөрийг `нэг цагийн үнэ × сонгосон цагийн тоо` томьёогоор бодно.
- Reception check-in хийхдээ байрлах цагийн тоог сонгоход систем төлөвлөсөн check-out цаг болон урьдчилсан төлбөрийг автоматаар гаргана.
- Manager буудлын хэмжээнд хоногийн тогтсон check-out цагийг тохируулна.
- Нэг хоногийг check-in хийснээс хойших бүтэн 24 цаг гэж үзэхгүй; нэг шөнө байрлаад буудлын тогтсон check-out цагт дуусна.
- Хоногийн `N` тоо сонгоход planned checkout-ийг hotel-local check-in огноо дээр `N` calendar өдөр нэмж, баталгаажуулах үеийн тогтсон check-out цагт автоматаар бодно. Check-in тухайн өдрийн check-out цагаас өмнө байсан ч `N = 1` нь дараагийн calendar өдрийн check-out цагт дуусна.
- Quote/booking/check-in батлах үед ашигласан stay type, нэгж үнэ, tariff source level, source entity ID, pricing config version, төлөвлөсөн хугацаа болон урьдчилсан/баталгаажсан дүнг snapshot болгон хадгална.
- Nightly confirmation snapshot нь positive whole `night_count`, effective nightly unit rate/source/config version, ашигласан fixed checkout time болон planned checkout-ийг хамтад нь хадгална.
- Тогтсон check-out цагийг дараа өөрчилсөн ч өмнө баталгаажсан захиалга, идэвхтэй байрлалтын дуусах цаг автоматаар өөрчлөгдөхгүй.
- Manager дараа hotel/category/room tariff өөрчилсөн, override нэмсэн/арилгасан ч өмнө баталгаажсан online booking болон идэвхтэй stay-ийн snapshot үнэ автоматаар өөрчлөгдөхгүй.
- Tariff create/update/override/clear бүр hotel, level/entity, stay type, old/new value, config version, actor, role болон server time-тай audit түүхтэй байна.
- Tariff тохиргоо бүх subscription багцын Manager-д нээлттэй. Hotel Admin operational action-ийг автоматаар өвлөхгүй бөгөөд тариф тохируулах бол Manager role тусдаа авна. Reception effective tariff болон snapshot-ийг зөвхөн read-only харна.
- MVP-д confirmed booking/active stay-ийн planned checkout-ийг сунгах, богиносгох эсвэл hourly/nightly төрлийг солих ажиллагаа байхгүй; original planned end болон confirmation snapshot хэвээр үлдэнэ.
- Бодит check-out төлөвлөсөн цагаас хэтэрсэн ч систем нэмэлт төлбөр автоматаар бодохгүй.
- `Хугацаа сунгах` button/API, planned-end amendment болон нэмэлт extension төлбөрийн мөр MVP-д үүсэхгүй (`STAY-DEC-012`).

## 8. MVP acceptance criteria

- Reception check-in хийхдээ `Цагаар` эсвэл `Хоногоор` сонгоно.
- Сонголтоос хамаарч эхлэх, дуусах цаг болон урьдчилсан төлбөр харагдана.
- Өрөөний карт дээр одоогийн байрлалтын төрөл, дуусах цаг болон үлдсэн хугацаа харагдана.
- `Walk-in/Online`, `Check-in хийсэн`, цэвэрлэгээ болон minibar-ын төлөвүүд тусдаа харагдана.
- Одоо сул боловч дараа захиалгатай өрөөнд дараагийн захиалгын эхлэх, дуусах цаг харагдана.
- Хугацаа хэтэрсэн байрлалтыг систем ялгаж анхааруулна.
- Давхардсан захиалга/check-in үүсгэх боломжгүй байна.
- Цэвэрлэгээний шаардлагатай хугацаагүйгээр дараагийн захиалгатай давхцах байрлалт үүсгэхгүй.
- Тариф болон original planned checkout snapshot immutable хадгалагдаж, confirmed/active record-д planned-end amendment үүсэхгүй.
- Walk-in тариф нь room override, category override, hotel default гэсэн тогтсон precedence-ээр server-side бодогдоно.
- Online booking quote нь category override, hotel default дарааллаар бодогдож, room override ашиглахгүй; дараа physical room оноох нь баталгаажсан booking-ийг reprice хийхгүй.
- Цагийн болон хоногийн тариф тусдаа өвлөгдөж, тохируулаагүй override дараагийн түвшнээс утгаа авна.
- Reception нэгж үнэ/source/config version-ийг гараар override хийхгүй; confirmation snapshot нь price болон эх сурвалжийг сэргээн нотлох мэдээлэлтэй байна.
- Default actual check-in нь check-in confirmation-ийн серверийн цаг байна; Reception зөвхөн анхны confirmation-оос өмнө, одоогийн open shift/local өдөр дотор болон хамгийн ихдээ 120 минут backdate хийж болно.
- Online booking-тэй check-in-ийг батлагдсан planned check-in цагаас өмнө backdate хийхгүй; future actual time болон хаагдсан/өмнөх shift-д хамаарах цагийг хориглоно.
- Backdate-д шалтгаан заавал бөгөөд Manager approval, нотлох файл шаардахгүй; server сонгосон агшин дахь overlap болон нийлмэл room readiness-ийг түүхэн event-ээр нотолно.
- Initial `actual_check_in_at` болон `check_in_recorded_at` original event дээр immutable хадгалагдаж, backdate нь tariff/config/minibar snapshot, paid online booking, deposit/payment/cash effective time болон Police alert time-ийг өнгөрсөн рүү шилжүүлэхгүй.
- Stay active болсны дараа Reception original actual check-in цагийг шууд overwrite хийхгүй; зөвхөн STAY-DEC-010-ын immutable correction amendment ашиглана.
- Actual-time correction request-ийг Reception үүсгэж, Manager approve/reject хийнэ; Reception+Manager multi-role нэг actor self-approve хийж болох ч audit-д тусгай тэмдэглэгдэнэ.
- Correction нь зөвхөн active, checkout эхлээгүй stay-д, original recorded-at дээр түгжсэн STAY-DEC-009 boundary дотор байна. Нэг pending request checkout эхлүүлэхийг блоклоно.
- Approved correction-оос effective actual start derivation хийх боловч planned checkout, selected duration, stay type, room/minibar price, deposit/payment/cash shift болон configuration/stock snapshot өөрчлөгдөхгүй.
- Tariff өөрчлөлт confirmed booking/active stay snapshot-д буцаж нөлөөлөхгүй бөгөөд өөрчлөлт бүр audit-тай байна.
- Tariff configuration бүх багцын Manager action; Hotel Admin-д Manager role тусдаа шаардлагатай.
- Nightly `N` шөнийн planned checkout нь check-in local date + `N` calendar day, snapshotted fixed checkout time-аар бодогдоно; check-out цагаас өмнөх check-in мөн дараагийн өдрийн checkout-оор нэг шөнө дуусна.
- Nightly room charge нь `effective нэг шөнийн үнэ × N`; confirmation өмнө next booking болон cleaning buffer-ийг server дахин шалгана.
- Availability төлөвлөлт actual checkout үүсэхээс өмнө planned checkout + snapshot cleaning buffer ашиглана; actual checkout үүсмэгц readiness anchor нь actual checkout + ижил snapshot buffer болно.
- Room-ийг дахин ашиглахад readiness хугацаа өнгөрсөн, package-д эрх бүхий хэрэглэгч өрөөг `Цэвэр` болгосон, хамаарах minibar readiness хангагдсан гэсэн бүх gate зэрэг үнэн байна.
- Эрт actual checkout нь readiness хугацааг эрт эхлүүлж болох ч дараагийн confirmed booking-ийн эхлэх цагийг автоматаар урагшлуулахгүй; орой actual checkout нь readiness-ийг хойшлуулна.
- Overdue нь автоматаар fee үүсгэхгүй. Дараагийн confirmed booking-тэй мөргөлдвөл `STAY-DEC-013`-ын unique alert + hard blocker үйлчилж, ижил category room, нэмэлт төлбөргүй higher category эсвэл hotel cancellation + бүтэн refund гэсэн terminal шийдлийн аль нэгийг хэрэглэнэ.
- Early-morning cutoff configuration current MVP дүрэмд байхгүй; тусдаа хойшлуулсан санал байна.
- Minibar-enabled check-in бүр server-side stay price book-тэй; active stay current product price-аар reprice болохгүй.
- Room/category lifecycle нь occupancy/readiness-ээс тусдаа харагдаж, retiring/inactive entity шинэ booking/check-in/assignment-д ашиглагдахгүй.
- Active stay эсвэл өмнө баталгаажсан booking deactivation-аас болж автоматаар cancel/reprice болохгүй.
- Өмнө confirmed booking ч retiring/inactive entity дээр check-in хийхгүй; reactivate, active entity рүү шилжүүлэх эсвэл cancellation-аар resolve хийнэ.
- Reception current/pending minibar config-ийн exact version болон blocker-ийг read-only харна; non-terminal pending change-тэй physical room шинэ assignment/check-in авахгүй.
- Future booking minibar config-ийг booking үед pin хийхгүй; check-in үеийн амжилттай applied current config-ийн exact version-оор stay snapshot үүсгэнэ.
- Pending change, шинэ Draft/Published version болон Default Published өөрчлөлт active stay-ийн pinned mode/template version/opening/price book болон эцсийн тооцоог өөрчлөхгүй.
- Анхны publish цорын ганц Default version үүсгэж, дараагийн publish одоогийн Default-ийг солихгүй; Publish/Set default дангаараа room current/pending болон booking/stay-г өөрчлөхгүй.
- Publish/Set default/Archive нь inventory movement, Cleaner/configuration task эсвэл check-in blocker үүсгэхгүй; room version өөрчлөх explicit Rollout тусдаа байна.
- Default, room current/pending, active stay эсвэл non-terminal task-д reference-тэй version archive болохгүй; historical reference болон version pin хийгдээгүй future booking blocker болохгүй.
- Eligible active-stay room дээр Rollout confirm хийсэн ч stay-ийн exact version, opening quantity, price book болон эцсийн төлбөр өөрчлөгдөхгүй; room pending request/blocker шууд үүсэж `SCHEDULED_AFTER_STAY` төлөвт хүлээнэ.
- Safe/vacant room-д Rollout reconciliation task шууд үүсэж, бусад room-д active stay болон checkout/payment/minibar report/refill terminal болсон existing safe point-д л үүснэ.
- Rollout exact target дараагийн Publish/Default-оор солигдохгүй бөгөөд pending target Archive болохгүй; apply нь Cleaner reconciliation болон P0-37B validation амжилттай үед атомик байна.
- Multi-room preview нь stay/availability/pending/blocker/task-д side effect үүсгэхгүй; Confirm room бүрийг дахин шалгаж accepted child-д blocker үүсгэн, invalid room-ийг reason-тэй `SKIPPED` болгоно.
- Partial success үед нэг room-ийн failure бусад room-ийн child урсгалыг rollback хийхгүй; batch-ийн state child үр дүнгээс автоматаар бодогдоно.
- Accepted active-stay child current stay snapshot-аараа дуусч safe point-д task авна; `Cancel remaining` movement-free child-ийг unblock хийх боловч `APPLIED` room-ийг өөрчлөхгүй.
- Confirmed non-terminal child/batch target Archive blocker байна; preview/zero-accepted batch blocker биш, duplicate Confirm болон нэг room-ийн давхар pending change үүсэхгүй.
- 30,000₮ багцын check-in бүрд шинэ guest access код үүсэж, check-out дуусмагц тухайн stay-ийн guest session-ууд хүчингүй болно.
- Нэг stay-д 5-аас олон идэвхтэй guest session үүсэхгүй; Reception нэг session эсвэл бүх session-ийг гараар хүчингүй болгож чадна.
- Дуусаагүй төлөгдсөн Restaurant захиалга байвал анхааруулга, Reception-ийн баталгаажуулалт болон Restaurant-д очих check-out мэдэгдэл үүснэ; захиалга автоматаар цуцлагдахгүй.
- Дуусаагүй Restaurant захиалга бүрийн хүлээн авах сонголтыг Restaurant-д дамжуулна; хоолны төлбөр check-out-ын дүнд нэмэгдэхгүй.

## 9. Батлагдсан хоногийн дүрэм

`Хоногоор` байрлалтыг Manager-ийн буудлын хэмжээнд тохируулсан тогтсон check-out цагтай нэг шөнөөр тооцно. Check-in хийсэн цагаас хойших бүтэн 24 цаг гэж үзэхгүй.

Жишээ: буудлын check-out цаг 12:00 бөгөөд зочин 8-р сарын 14-ний 18:00 цагт нэг шөнөөр check-in хийвэл төлөвлөсөн check-out нь 8-р сарын 15-ны 12:00 байна.

P0-38C-ийн calendar дүрэм:

```text
night_count = N, N нь эерэг бүхэл тоо

planned_checkout
= hotel-local date(check_in) + N calendar days
  at snapshotted hotel fixed checkout time

nightly_room_charge
= effective nightly unit rate × N
```

| Check-in | N | Fixed checkout | Planned checkout |
| --- | ---: | --- | --- |
| 8/14 18:00 | 1 | 12:00 | 8/15 12:00 |
| 8/14 09:00 | 1 | 12:00 | 8/15 12:00 |
| 8/14 18:00 | 3 | 12:00 | 8/17 12:00 |

Check-in тухайн өдрийн fixed checkout-оос өмнө байсан ч нэг шөнө нь дараагийн calendar өдөр дуусна. Тухайн өдрийн check-out хүртэл богино хугацаагаар байрлуулах бол `Цагаар` төрлийг ашиглана. Confirmation хийхийн өмнө planned checkout болон дараах cleaning buffer нь next confirmed booking-тэй давхцахгүйг сервер шалгана.

Check-out time, night count, planned checkout болон effective nightly price/source/config version snapshot хадгалагдана. Manager дараа tariff эсвэл fixed checkout time өөрчилсөн ч confirmed booking болон active stay-ийн хугацаа/үнэ автоматаар өөрчлөгдөхгүй.

## 10. Батлагдсан цагийн үнийн дүрэм

Manager hotel default болон optional category/room override-ийг тохируулна. Сервер `STAY-DEC-005`-ын precedence-ээр effective нэг цагийн үнийг resolve хийж, Reception-ийн сонгосон цагийн тоогоор үржүүлэн өрөөний төлбөрийг тооцно.

```text
Цагийн байрлалтын төлбөр = Нэг цагийн үнэ × Сонгосон цагийн тоо
```

Жишээ: нэг цагийн үнэ 20,000₮ бөгөөд 3 цаг сонгосон бол өрөөний төлбөр 60,000₮ байна.

## 11. Батлагдсан хугацаа хэтрэлтийн дүрэм

Зочин төлөвлөсөн check-out цагаас хэтэрсэн тохиолдолд янз бүрийн шалтгаан байж болох тул нэмэлт төлбөр, торгууль болон хэсэг цагийн төлбөр автоматаар бодохгүй. Систем зөвхөн `Хугацаа хэтэрсэн` төлөв болон бодитоор хэтэрсэн хугацааг Reception-д харуулна.

MVP-д албан ёсны сунгалтын operational action, permission болон нэмэлт цаг/хоногийн үнэ байхгүй (`STAY-DEC-012`).

## 12. Батлагдсан цэвэрлэгээний хугацааны дүрэм

Manager буудлын үндсэн цэвэрлэгээний хамгийн бага хугацааг тохируулна. Шаардлагатай бол стандарт, люкс зэрэг өрөөний ангилал бүрд өөр хугацаа тохируулна. Reception уг тохиргоог өөрчлөхгүй.

Дараагийн захиалга/check-in зөвшөөрөгдөхийн тулд:

1. өмнөх байрлалтын дараах тохируулсан цэвэрлэгээний хугацаа хангагдсан байх;
2. өрөөний бодит цэвэрлэгээний төлөв `Цэвэр` болсон байх

гэсэн хоёр нөхцөл зэрэг биелнэ. Тохируулсан хугацаа өнгөрсөн ч Cleaner эсвэл Manager өрөөг `Цэвэр` болгоогүй бол шинэ check-in хийхгүй.

## 13. P0-38A — Тарифын шатлал ба room charge snapshot

### 13.1 Түвшин тус бүрийн үүрэг

| Үнийн төрөл | Hotel default | Category override | Room override |
| --- | --- | --- | --- |
| Цагийн тариф | Буудлын үндсэн fallback | Тухайн ангиллын нийтлэг тусгай үнэ | Зөвхөн тухайн physical room-ийн онцгой үнэ |
| Хоногийн тариф | Буудлын үндсэн fallback | Online болон category-based үндсэн тусгай үнэ | Зөвхөн walk-in physical room сонгогдсон үед хэрэглэх онцгой үнэ |

Цагийн болон хоногийн утгыг тус тусад нь resolve хийнэ. Category/room түвшний hourly override unset боловч nightly override тохируулагдсан байж болох бөгөөд энэ тохиолдолд зөвхөн hourly утга дараагийн түвшнээс өвлөгдөнө.

```text
Walk-in effective rate
= room override ?? category override ?? hotel default

Online booking effective rate
= category override ?? hotel default
```

Online booking-д physical room-ийг дараа оноодог тул room override нь нийтийн quote, payment болон booking confirmation-д орохгүй. Booking баталгаажсаны дараа аль physical room оноосноос үл хамааран booking-ийн хадгалсан rate/total хүчинтэй хэвээр байна.

### 13.2 Server authority, snapshot ба audit

- Client/Reception зөвхөн context сонгоно; effective tariff, source болон config version-ийг сервер бодож батална.
- Walk-in check-in болон online booking confirmation тус бүр өөрийн room charge snapshot-тай байна.
- Snapshot нь дор хаяж stay/booking ID, stay type, unit rate, quantity, total, source level, source entity ID, pricing config version болон confirmation time хадгална.
- Online booking-ийн payment/confirmation snapshot check-in үед шинэ room tariff-аар солигдохгүй. Walk-in check-in snapshot мөн дараагийн config edit-ээр reprice болохгүй.
- Manager-ийн tariff create/update/override/clear бүр immutable audit event үүсгэнэ.
- Энэ тохиргоо бүх багцад Manager-ийн operational action байна; Hotel Admin-д Manager role тусдаа шаардлагатай, Reception read-only байна.

### 13.3 P0-38A acceptance criteria

- Hourly болон nightly rate тусдаа `hotel → category → room` configuration-тэй байна.
- Unset override дараагийн түвшнээс өвлөгдөж, нэг stay type-ийн override нөгөө төрөлд нөлөөлөхгүй.
- Walk-in `room → category → hotel`, online booking `category → hotel` precedence ашиглана.
- Online booking confirmation/paid snapshot physical room assignment болон check-in-ээр reprice болохгүй.
- Reception үнэ/source/config version-ийг гараар override хийхгүй; server authoritative resolve хийнэ.
- Confirmation snapshot тооцооллыг сэргээн нотлох source/config metadata-тай байна.
- Дараагийн тарифын edit confirmed booking/active stay-г өөрчлөхгүй, edit бүр audit-тай байна.
- Бүх багцын Manager configure хийнэ; Hotel Admin-д Manager role тусдаа шаардлагатай.

## 14. Батлагдсан шийдвэрүүд

### STAY-DEC-001 — Тогтсон check-out цагтай хоногийн байрлалт

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Хоногийн stay нь check-in-ээс хойших 24 цаг биш, Manager-ийн hotel-level тогтсон check-out цагтай нэг шөнөөр тооцогдоно. Олон шөнийн calendar томьёо болон checkout цагаас өмнөх check-in edge case `STAY-DEC-007`-оор хаагдсан.

### STAY-DEC-002 — Цагийн үнийн үндсэн томьёо

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Цагийн өрөөний үндсэн төлбөр `effective нэг цагийн үнэ × Reception-ийн сонгосон цагийн тоо` байна. P0-38B-аар үүн дээр Manager-ийн minimum, maximum эсвэл increment тохиргоо нэмэхгүй гэж баталсан.

### STAY-DEC-003 — Хугацаа хэтрэхэд автомат төлбөргүй

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Төлөвлөсөн check-out өнгөрөх нь дангаараа нэмэлт төлбөр/торгууль үүсгэхгүй. Систем overdue төлөв болон хугацааг харуулна. `STAY-DEC-012`-ын дагуу MVP-д extension action болон тусдаа extension төлбөрийн мөр/үнэ үүсэхгүй; бодит дуусах цагийг actual checkout бүртгэнэ.

### STAY-DEC-004 — Цэвэрлэгээний хугацаа ба бодит төлөв

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Manager hotel default cleaning duration, шаардлагатай бол category override тохируулна. Дараагийн check-in-д хугацааны buffer хангагдсан болон бодит cleaning state `Цэвэр` болсон хоёр нөхцөл зэрэг шаардагдана.

### STAY-DEC-005 — Тарифын precedence, snapshot ба permission

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hourly/nightly tariff тусдаа байна. Walk-in rate нь room override → category override → hotel default; online rate нь category override → hotel default precedence ашиглаж room override-ийг тооцохгүй. Server effective tariff-ийг бодож source/config metadata-тай confirmation snapshot хадгална; room assignment болон дараагийн config edit confirmed booking/active stay-г reprice хийхгүй. Бүх багцын Manager тохируулж, Hotel Admin-д Manager role тусдаа шаардлагатай; Reception үнэ override хийхгүй, өөрчлөлт бүр audit-тай байна.
- **Scope boundary:** Online booking зөвхөн nightly; walk-in hourly нь 30 минутын алхамтай (`BK-DEC-012`, `STAY-DEC-014`).

### STAY-DEC-006 — P0-38B Manager-аар тохируулах нэмэлт хязгаарлалтгүй байх

- **Төлөв:** Батлагдсан — санал дэмжигдээгүй тул хуучин дүрмийг хэвээр үлдээсэн
- **Шийдвэр:** MVP-д hourly stay-д Manager-аар тохируулах minimum hours, maximum hours эсвэл increment configuration нэмэхгүй. Reception өмнөх урсгалаар цагийн тоог сонгож, сервер `STAY-DEC-002` болон `STAY-DEC-005`-ын дагуу `effective нэг цагийн үнэ × сонгосон цагийн тоо` томьёог ашиглана. Existing availability, давхцал болон cleaning buffer validation хэвээр үйлчилнэ; шинэ duration cap/default үүсгэхгүй.
- **Scope boundary:** Manager minimum/maximum/increment тохируулахгүй. Platform-ийн тогтмол хагас цагийн precision-ийг `STAY-DEC-014` тодорхойлно. Online booking зөвхөн хоногоор байхыг `BK-DEC-012` баталсан. Confirmed/active stay-ийн extension болон төрөл солих ажиллагааг `STAY-DEC-012`-оор MVP-ээс хассан.

### STAY-DEC-007 — P0-38C nightly calendar, үнэ ба early-arrival дүрэм

- **Төлөв:** Батлагдсан
- **Шийдвэр:** `N` шөнийн planned checkout нь hotel-local check-in огноо + `N` calendar өдөр, confirmation-д snapshot хийсэн fixed checkout time байна. Check-in тухайн өдрийн checkout цагаас өмнө байсан ч `N = 1` нь дараагийн өдрийн checkout цагт дуусна; same-day short stay-д hourly төрлийг ашиглана. Nightly room charge нь effective nightly unit rate × `N`. Server next booking/cleaning buffer-ийг дахин шалгаж, night count, rate/source/config version, fixed checkout time болон planned checkout snapshot хадгална; дараагийн config edit confirmed booking/active stay-г өөрчлөхгүй.
- **Deferred boundary:** Early-morning cutoff/bизнес өдрийн тусдаа заагийг одоо шийдээгүй бөгөөд current MVP-д нэмэлт cutoff configuration үүсгэхгүй.

## 15. P0-38 хаагдсан төлөв

- **P0-38B:** Хаагдсан — configurable minimum/maximum/increment санал батлагдаагүй; хуучин томьёо хэвээр (`STAY-DEC-006`).
- **P0-38C:** Хаагдсан — nightly calendar/price/early-arrival дүрэм батлагдсан, early-morning cutoff хойшлуулсан (`STAY-DEC-007`).

P0-38A/B/C бүхэлдээ хаагдсан. Дараагийн кодын өмнөх асуудал нь **P0-39 — Stay edits/overlap** байна.

## 16. MVP-ээс хойшлуулсан санал — Early-morning cutoff

02:00 зэрэг маш эрт check-in-ийг өмнөх business night-д тооцож тухайн өдрийн checkout-д гаргах тусдаа cutoff тохиргоог current MVP-д хэрэгжүүлэхгүй. Одоогийн `STAY-DEC-007` дүрэм бүх nightly check-in-д ижил үйлчилнэ. Дараа энэ боломжийг хэлэлцвэл hotel-level cutoff time, exact boundary, үнэ, online display болон confirmed snapshot migration-ийг шинэ decision-оор батална.

## 17. P0-39A — Interval boundary ба cleaning buffer anchor

### 17.1 Тооцооны canonical дүрэм

```text
occupancy_interval = [start_at, end_at)

planned_ready_not_before = planned_checkout_at + snapshotted_cleaning_buffer
actual_ready_not_before  = actual_checkout_at  + snapshotted_cleaning_buffer

room_reusable =
  current_server_time >= actual_ready_not_before
  AND cleaning_state = CLEAN
  AND applicable_minibar_readiness = READY
```

- `end_at` нь occupancy интервалд орохгүй. Гэхдээ cleaning buffer эерэг бол дараагийн stay яг `end_at` дээр эхлэх боломжгүй; `ready_not_before` хүртэл room blocked хэвээр байна.
- Actual checkout үүсээгүй үед quote, booking confirmation болон future availability нь `planned_ready_not_before`-ийг ашиглана. Энэ нь ирээдүйд өрөө бодитоор цэвэр болсон гэсэн баталгаа биш.
- Actual checkout үүсмэгц `actual_ready_not_before` нь тухайн өрөөний бодит readiness хугацааны authoritative anchor болно.
- Cleaning buffer нь booking/stay confirmation үеийн хүчинтэй hotel/category configuration-оос snapshot хийгдэнэ. Manager дараа buffer-ийг өөрчилсөн ч өмнөх confirmed booking/active stay-ийн snapshot автоматаар өөрчлөгдөхгүй.
- Cleaning state-ийг package-ийн өмнө батлагдсан эрхээр өөрчилнө: 25,000₮/30,000₮ багцад зөвхөн Cleaner, Cleaner feature-гүй 20,000₮ багцад Manager `Цэвэр` болгоно; Reception бүх багцад read-only байна. Buffer хугацаа өнгөрөх, бодит cleaning state болон хамаарах minibar readiness нь бие биеэ орлохгүй.
- Early actual checkout нь Cleaner-ийн ажил болон бодит buffer-ийг эрт эхлүүлж болно. Гэхдээ систем өмнө confirmed болсон дараагийн booking-ийн эхлэх цагийг зочны шинэ зөвшөөрөлгүйгээр автоматаар урагшлуулахгүй.
- Late actual checkout нь readiness anchor-ийг хойшлуулна. Overdue өөрөө автомат fee үүсгэхгүй; дараагийн booking-тэй үүссэн бодит мөргөлдөөнийг `STAY-DEC-013`-ын alert/blocker/reassignment/hotel-cancellation урсгалаар шийднэ.
- STAY-DEC-008 дангаараа early checkout-ийн room charge/refund-ийг шийдээгүй; харин current MVP-д early actual checkout automatic reprice/refund хийхгүйг STAY-DEC-012-оор хаасан.
- Availability, overlap болон check-in readiness-ийн эцсийн шалгалтыг authoritative server transaction дээр дахин хийж, зэрэг хүсэлтээр давхар room олгохгүй.

### STAY-DEC-008 — Exclusive end interval ба planned/actual cleaning readiness

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Booking/stay occupancy нь `[start_at, end_at)` exclusive-end интервалтай. Actual checkout-оос өмнө availability-г planned checkout + snapshotted cleaning buffer-ээр төлөвлөж, actual checkout бүртгэгдсэний дараа actual checkout + ижил buffer-ийг authoritative readiness anchor болгоно. Room зөвхөн уг хугацаа өнгөрсөн, package-д эрх бүхий хэрэглэгч бодит cleaning state-ийг `Цэвэр` болгосон, хамаарах minibar readiness хангагдсан үед дахин ашиглагдана. Early checkout дараагийн confirmed booking-ийг автоматаар урагшлуулахгүй; late checkout automatic fee үүсгэхгүй. STAY-DEC-012 early actual checkout automatic reprice/refund хийхгүйг, STAY-DEC-013 overdue conflict-ийн alert/blocker/remedy-г хаасан. Сервер overlap/readiness-ийг баталгаажуулах мөчид дахин шалгана.

## 18. P0-39-ийн төлөв

P0-39A, P0-39B-1/B-2, P0-39C-1/C-2 болон P0-39D `STAY-DEC-008`–`STAY-DEC-013`-аар хаагдсан. MVP-д confirmed booking/active stay-ийн planned checkout өөрчлөх, extension хийх, planned end богиносгох, hourly/nightly conversion хийх, early actual checkout-аар room charge-ийг автоматаар reprice/refund хийхгүй. Actual checkout original planned end-ийг өөрчлөхгүй. Overdue stay дараагийн confirmed booking-ийг давхар check-in болгохгүй; canonical conflict/reassignment/hotel-cancellation дүрэм §23-т байна.

## 19. P0-39B-1 — Actual check-in time ба backdate хамгаалалт

### 19.1 Default болон зөвшөөрөгдөх интервал

Check-in-ийн эцсийн баталгаажуулалтын transaction эхлэхэд сервер authoritative `server_now` үүсгэнэ. Default үед `actual_check_in_at = check_in_recorded_at = server_now` байна. Reception зөвхөн энэ анхны confirmation-оос өмнө өнгөрсөн цаг сонгож болно.

```text
earliest_allowed = max(
  server_now - 120 minutes,
  current_open_shift.started_at,
  hotel_local_day_start(server_now),
  confirmed_booking.planned_checkin_at  // booking байгаа үед
)

earliest_allowed <= actual_check_in_at <= server_now
```

- Current open shift байхгүй бол check-in батлахгүй. Өмнөх/хаагдсан shift, өмнөх hotel-local calendar өдөр эсвэл 120 минутаас өмнөх цаг сонгохгүй.
- Баталгаажсан online booking байгаа бол түүний planned check-in-ээс өмнөх early arrival-ийг backdate-аар тойрохгүй.
- Backdate хийвэл шалтгаан заавал бүртгэнэ. MVP-д Manager-ийн нэмэлт approval болон нотлох файл шаардахгүй.
- Future цаг сонгохгүй; client device-ийн clock серверийн цагийг орлохгүй.

### 19.2 Confirmation үеийн authoritative validation

Сервер нэг transaction-д дор хаяж дараахыг дахин шалгана:

1. `[actual_check_in_at, planned_checkout_at)` нь өөр confirmed booking/active stay-тай давхцахгүй;
2. өмнөх stay-ийн `actual_checkout_at + snapshotted_cleaning_buffer` сонгосон actual check-in-ээс хэтрээгүй;
3. package-д эрх бүхий actor өрөөг `Цэвэр` болгосон event болон applicable minibar readiness сонгосон цагт аль хэдийн хүчинтэй байсан;
4. room/category/minibar configuration lifecycle болон blocker check-in-ийг зөвшөөрч байгаа;
5. дараагийн booking хүртэл planned stay + cleaning buffer багтаж байгаа;
6. `planned_checkout_at` нь confirmation үеийн `server_now`-оос хойш байгаа.

Түүхэн cleaning/minibar readiness-ийг timestamp бүхий audit event-ээр нотолж чадахгүй бол сервер backdate-ийг хориглож, одоогийн серверийн цагаар дахин батлах боломжийг харуулна.

### 19.3 Timestamp, snapshot болон side effect

- `actual_check_in_at` нь Reception-ийн баталсан бодит орсон цаг; `check_in_recorded_at` нь системд баталгаажуулсан серверийн цаг. Хоёул original event дээр immutable байна.
- Walk-in room tariff, current minibar configuration, stay price book болон opening snapshot нь `check_in_recorded_at` үеийн authoritative төлөвөөр үүснэ. Backdate historical тариф, configuration, selling price эсвэл stock movement зохиож сэргээхгүй.
- Paid/confirmed online booking өөрийн өмнөх snapshot үнээ хадгалж, backdate-аас болж reprice болохгүй.
- Deposit, payment болон cash movement нь тухайн confirmation-ийн active shift, бодит server effective time-д бүртгэгдэнэ; `actual_check_in_at`-тай хамт өмнөх shift рүү шилжихгүй.
- Exact-RD Police matching болон alert нь `check_in_recorded_at` дээр шууд ажиллана. Match/audit нь `actual_check_in_at` болон detection/recorded time-ийг тусад нь хадгалж, alert timestamp-ийг backdate хийхгүй.
- Stay active болсны дараа Reception original actual time-ийг overwrite хийхгүй. Дараах залруулга нь STAY-DEC-010-ын холбоостой immutable correction amendment байна.
- Audit-д default/selected actual time, backdate минут, шалтгаан, actor/role, hotel, room, stay/booking, shift, server time болон validation result хадгална.

### STAY-DEC-009 — Initial actual check-in ба 120 минутын backdate

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Default `actual_check_in_at` болон immutable `check_in_recorded_at` нь initial check-in confirmation-ийн server time байна. Reception зөвхөн confirmation-оос өмнө actual time-ийг хамгийн ихдээ 120 минут, current open shift болон hotel-local өдрийн дотор, online booking байвал planned check-in-ээс наашгүйгээр ухрааж, заавал шалтгаан бүртгэнэ; Manager approval/нотлох файл шаардахгүй. Server сонгосон агшны overlap, historical buffer/CLEAN/minibar readiness, lifecycle/blocker болон next booking-ийг authoritative transaction-аар шалгана. Backdate нь historical tariff/config/stock/minibar snapshot сэргээхгүй, paid online booking-ийг reprice хийхгүй, payment/cash болон Police alert time-ийг өмнөх цаг/shift рүү шилжүүлэхгүй. Active stay болсны дараах direct overwrite хориглогдоно; тусдаа correction amendment-ийг STAY-DEC-010 тодорхойлно.

## 20. P0-39B-2 — Active stay actual check-in correction amendment

### 20.1 Request, approval ба lifecycle gate

- Зөвхөн Reception active stay дээр corrected actual time болон заавал шалтгаантай correction request үүсгэнэ.
- Manager request-ийг approve эсвэл reject хийнэ. Hotel Admin operational Manager action-ийг автоматаар өвлөхгүй; Manager role тусдаа авсан байна.
- Нэг account Reception болон Manager role хоёуланг хүчинтэй эзэмшиж байвал өөрийн request-ийг self-approve хийж болно. Audit-д requester/approver ижил actor болон `self_approved = true` гэж хадгална.
- Stay `ACTIVE` бөгөөд `Check-out эхлүүлэх` хийгдээгүй үед л request/approval зөвшөөрнө. Нэг stay-д хамгийн ихдээ нэг pending correction байна; pending request terminal болох хүртэл checkout эхлүүлэхийг сервер хориглоно.
- Checkout эхэлсэн/дууссан stay болон original boundary-гаас гадуурх цагийг энэ MVP action-аар засахгүй.

### 20.2 Original recorded-at дээр түгжсэн correction boundary

Correction хийх үеийн одоогийн цагаас шинэ 120 минутын window бодохгүй. Initial confirmation-ийн original утгуудыг ашиглана:

```text
correction_earliest_allowed = max(
  original_check_in_recorded_at - 120 minutes,
  original_shift.started_at,
  hotel_local_day_start(original_check_in_recorded_at),
  confirmed_booking.planned_checkin_at  // booking байгаа үед
)

correction_earliest_allowed
  <= corrected_actual_check_in_at
  <= original_check_in_recorded_at
```

Ингэснээр stay удаан active байснаар backdate window улам хойш гулсаж, өмнөх өдөр/shift рүү тэлэхгүй.

### 20.3 Immutable amendment ба effective value

Initial `actual_check_in_at`, `check_in_recorded_at` болон өмнөх approved correction event-үүдийг overwrite/delete хийхгүй.

```text
effective_actual_check_in_at =
  latest_approved_correction.corrected_actual_check_in_at
  ?? initial_actual_check_in_at
```

Approved amendment нь correction ID, previous effective time, corrected time, шалтгаан, requester/approver, role-ууд, self-approved flag, original shift/stay/booking reference, request/decision server time болон validation result хадгална.

### 20.4 Approval үеийн validation ба өөрчлөгдөхгүй зүйлс

- Approval transaction нь corrected time-ээс unchanged `planned_checkout_at` хүртэлх occupancy overlap, өмнөх stay-ийн actual checkout + snapshot buffer, сонгосон агшны historical `Цэвэр`/applicable minibar readiness болон room холбоосыг дахин шалгана.
- Correction нь зөвхөн effective actual start-ийг өөрчилнө. `planned_checkout_at`, selected hours/nights, hourly/nightly type, room/minibar unit price болон charge, tariff/config/version/opening snapshot, deposit/payment/refund/cash movement/shift/recognized time-ийг өөрчлөхгүй.
- Planned checkout, duration, stay type эсвэл үнэ мөн алдаатай бол тэдгээрийг энэ correction-д хавсаргахгүй. `STAY-DEC-012`-оор current MVP-д эдгээрийг өөрчлөх amendment/action байхгүй бөгөөд original confirmation snapshot canonical хэвээр байна; ирээдүйд ийм боломж нээх бол тусдаа post-MVP дүрэм шаардана.
- Approve/reject давтан хүсэлт idempotent байна. Concurrent approval-аар хоёр amendment зэрэг effective болохгүй; approval үед pending version болон stay/checkout state-ийг дахин шалгана.

### 20.5 Police болон guest registry

- Existing exact-RD Match, alert, `check_in_recorded_at`, `detected_at`, delivery/escalation time өөрчлөгдөхгүй бөгөөд correction давхар Match/alert үүсгэхгүй.
- Correction request/decision болон old/new/effective actual time existing stay/Match audit-д холбоотой хадгалагдана.
- Hotel guest registry болон түүний зөвшөөрөгдсөн Excel, мөн Police portal-ийн зөвшөөрөгдсөн view дэх actual stay start нь latest approved `effective_actual_check_in_at`-ийг ашиглана. Original утга болон amendment chain audit/detail-д хэвээр үлдэнэ; энэ дүрэм Police check-in-list Excel/export-ийн шинэ эрх үүсгэхгүй.

### STAY-DEC-010 — Active stay actual-time immutable correction

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Active, checkout эхлээгүй stay-ийн actual check-in цагийг Reception mandatory reason-тэй request-ээр залруулж, Manager approve/reject хийнэ; Hotel Admin-д Manager role тусдаа, Reception+Manager multi-role actor self-approve хийж болох бөгөөд тусгай audit-тай байна. Corrected time нь original `check_in_recorded_at` дээр түгжсэн STAY-DEC-009-ийн 120 минут/shift/local-day/online-start boundary дотор байна. Original event overwrite болохгүй, latest approved immutable amendment-аас effective actual time derive хийнэ. Нэг pending request checkout initiation-ийг блоклож, approval server-side historical readiness/overlap-ийг дахин шалган idempotent/concurrency-safe байна. Correction нь planned checkout/duration/type/price, deposit/payment/cash shift, minibar/config/stock snapshot болон existing Police Match/alert time-ийг өөрчлөхгүй; hotel registry/түүний Excel болон зөвшөөрөгдсөн Police view latest effective actual time ашиглана. Police check-in-list export-ийн шинэ эрх үүсэхгүй. Checkout эхэлсэн/дууссан эсвэл boundary-гаас гадуурх засвар энэ MVP action-д байхгүй.

## 21. P0-39C-1 — Planned checkout-ийн минимал хамгаалалт

### 21.1 Direct overwrite хориг

- Draft буюу хараахан баталгаажаагүй booking input-ийн анхны хугацааг confirmation-оос өмнө existing validation дотор засаж болно.
- Booking `CONFIRMED` болсон эсвэл stay `ACTIVE` болсон мөчөөс initial `planned_checkout_at` болон өмнөх өөрчлөлтийн түүхийг UI, generic API update эсвэл backend write-аар шууд overwrite/delete хийхгүй.
- MVP-ээс хойш planned-checkout өөрчлөлт шинээр зөвшөөрөх бол өөрчлөлт бүр append-only immutable amendment байна. Amendment нь хамгийн багадаа previous effective value, requested/new value, mandatory reason, actor-ийн өөрчлөгдөхгүй account ID ба тухайн үеийн role, server event time болон booking/stay/room холбоос хадгална.

```text
effective_planned_checkout_at =
  latest_approved_planned_checkout_amendment.new_planned_checkout_at
  ?? initial_planned_checkout_at
```

### 21.2 Server хамгаалалт ба одоогийн хязгаар

- MVP-ээс хойш тусдаа ажиллагаа батлагдаж amendment apply хийх бүрд сервер тухайн room-ийн occupancy interval overlap болон P0-39A-ийн snapshotted cleaning-buffer/readiness guard-ийг authoritative transaction-аар дахин шалгана. Client-ийн тооцоо дангаараа шийдвэр болохгүй.
- Энэ минимал шийдвэр дангаараа planned checkout өөрчлөх executable button, generic endpoint эсвэл role permission үүсгэхгүй. `STAY-DEC-012`-оор current MVP-д confirmed booking/active stay дээр ийм өөрчлөлт хийх UI/API бүрэн disabled байна.
- STAY-DEC-011 өөрөө `Extension`, `Early checkout`, `Conversion`, `Booking change` ангилал/enum, request/approval эсвэл financial side effect батлаагүй. STAY-DEC-012-оор current MVP-д extension/planned-end change/conversion action болон early automatic reprice/refund-ийг бүхэлд нь хассан.
- Иймээс STAY-DEC-011 нь direct overwrite, audit алдагдал болон overlap validation алгасахыг хориглосон invariant болохоос хугацаа өөрчлөх бизнес ажиллагааны бүрэн зөвшөөрөл биш.

### STAY-DEC-011 — Confirmed/active planned-checkout minimal guard

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Confirmed booking болон active stay-ийн initial/effective `planned_checkout_at`-ийг шууд overwrite/delete хийхгүй. MVP-ээс хойш өөрчлөлт шинээр зөвшөөрөх бол previous/new value, mandatory reason, actor account/role, server time болон booking/stay/room reference бүхий append-only immutable amendment ашиглаж, apply хийхэд сервер room overlap болон existing snapshotted cleaning-buffer/readiness guard-ийг authoritative transaction-аар дахин шалгана. Энэ минимал хамгаалалт executable action, permission эсвэл financial side effect үүсгэхгүй; `STAY-DEC-012`-оор current MVP-д planned-checkout change байхгүй.

## 22. P0-39C-2 — MVP-д planned checkout өөрчлөхгүй

### 22.1 Confirmation-оос хойших immutable хугацаа

- Draft/unconfirmed input дээр stay type болон duration-ийг confirmation-оос өмнө existing availability validation дотор сонгож/засаж болно.
- Booking `CONFIRMED` эсвэл stay `ACTIVE` болсны дараа original `planned_checkout_at`, selected hours/nights болон hourly/nightly type-ийг өөрчлөхгүй.
- MVP-д extension, planned end богиносгох, planned-checkout amendment, hourly ↔ nightly conversion, тэдгээрийн request/approval/button/API байхгүй. STAY-DEC-011-ийн future amendment contract нь хамгаалалтын суурь хэвээр боловч MVP-д amendment instance үүсэхгүй; `effective_planned_checkout_at = initial_planned_checkout_at` байна.
- Confirmed online booking-ийн planned end мөн адил immutable. Booking cancellation/rebooking нь энэ action-ийг тойрох direct edit биш бөгөөд `PAY-DEC-007`, `BK-DEC-012`-оор шийдэгдэнэ.

### 22.2 Actual checkout, overdue ба үнэ

- Зочин planned checkout-оос өмнө эсвэл дараа бодитоор гарч болно. Reception existing checkout flow-оор immutable `actual_checkout_at` бүртгэх бөгөөд энэ нь original planned checkout-ийг засахгүй.
- Planned checkout өнгөрсөн боловч actual checkout үүсээгүй stay `Хугацаа хэтэрсэн` төлөв болон хэтэрсэн хугацааг харуулна; өрөө actual checkout хүртэл эзлэгдсэн хэвээр байна.
- Overdue нь automatic fee/penalty/extension charge үүсгэхгүй. Early actual checkout нь room charge-ийг автоматаар reprice хийхгүй, refund үүсгэхгүй. Confirmation-ийн room tariff/price/payment snapshot хэвээр үлдэнэ.
- Actual checkout бүртгэгдмэгц P0-39A-ийн `actual_checkout_at + snapshotted_cleaning_buffer`, бодит `Цэвэр` төлөв болон applicable minibar readiness нь дахин ашиглах authoritative нөхцөл болно.
- Late actual checkout-оос дараагийн confirmed booking-тэй бодит мөргөлдөөн үүсвэл `STAY-DEC-013`-ын unique alert, hard blocker, same/higher-category reassignment эсвэл hotel-caused cancellation + бүтэн refund урсгалыг хэрэглэнэ.

### STAY-DEC-012 — No confirmed/active planned-checkout change in MVP

- **Төлөв:** Батлагдсан
- **Шийдвэр:** MVP-д confirmed booking болон active stay-ийн original planned checkout, selected duration болон hourly/nightly type immutable; extension, planned-end shortening, planned-checkout amendment/conversion болон тэдгээрийн role/action/UI/API байхгүй. Early/late actual checkout existing checkout flow-оор immutable actual time бүртгэж, original planned end-ийг өөрчлөхгүй. Overdue зөвхөн төлөв/хугацаа харуулж automatic fee/penalty/extension charge үүсгэхгүй; early actual checkout automatic reprice/refund хийхгүй. Room actual checkout хүртэл occupied хэвээр, дараа нь actual checkout + snapshotted buffer + `Цэвэр` + applicable minibar readiness-ээр дахин ашиглагдана. Late-stay/next-booking conflict-ийг `STAY-DEC-013`-аар шийднэ.

## 23. P0-39D — Overdue stay ба дараагийн confirmed booking

### 23.1 Conflict илрүүлэх ба хориг

- `actual_checkout_at`-гүй active stay-ийн physical room ямар ч нөхцөлд дахин assignment/check-in авахгүй.
- Дараагийн confirmed booking-ийн `planned_checkin_at - snapshotted_cleaning_buffer` агшин болсон ч тухайн stay checkout хийгдээгүй, мөн booking-ийн ангилалд өөр eligible room байхгүй бол `BOOKING_FULFILLMENT_CONFLICT` үүснэ.
- Нэг booking-д нэг нээлттэй conflict байна. Давтан scheduler/query/refresh duplicate alert үүсгэхгүй.
- Conflict-ийг Reception болон Manager/Manager Plus-д in-app banner/task хэлбэрээр харуулна. Тусдаа acknowledgement шаардахгүй; бодит шийдвэрийн event-ээр хаагдана.
- Сервер check-in transaction бүрд active stay, room/category lifecycle, configuration blocker, cleaning buffer, actual `Цэвэр` болон applicable minibar readiness-ийг дахин шалгана. UI-ийн төлөв check-in зөвшөөрөх эх сурвалж биш.

### 23.2 Шийдвэрлэх дараалал

1. Одоогийн stay actual checkout хийж, buffer + cleaning + minibar readiness дараагийн check-in-ээс өмнө бүрдвэл conflict `RESOLVED_READY` болно.
2. Reception ижил ангиллын өөр eligible room оноож болно; conflict `RESOLVED_REASSIGNED` болно.
3. Ижил ангиллын өрөө байхгүй бол Manager/Manager Plus илүү өндөр ангиллын eligible room-ийг зочны нэмэлт төлбөргүйгээр зөвшөөрнө. Reception+Manager multi-role account өөрөө шийдвэл `self_approved` audit хадгална. Paid booking-ийн price snapshot өөрчлөгдөхгүй.
4. Eligible room огт байхгүй бол Manager/Manager Plus booking-ийг `CANCELLED_HOTEL` болгоно. `BK-DEC-014`/`PAY-DEC-007`-ын дагуу бүтэн refund obligation үүсэж, commission `0` болно.

Одоогийн зочныг автоматаар checkout хийх, өрөөнөөс нүүлгэх, planned checkout өөрчлөх, overdue fee үүсгэх, дараагийн зочныг occupied room-д давхар check-in хийхгүй. Conflict, санал болгосон/сонгосон room, actor, reason, цаг болон terminal үр дүн append-only audit-тай байна.

### STAY-DEC-013 — Overdue conflict blocker ба deterministic remedy

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Actual checkout хийгдээгүй room occupied хэвээр бөгөөд давхар assignment/check-in хатуу хоригтой. Дараагийн confirmed booking-ийн cleaning-preparation boundary хүрч, ангилалд eligible room байхгүй бол нэг idempotent conflict үүсгэн Reception/Manager-д харуулна. Conflict нь actual readiness, ижил ангиллын reassignment, Manager/Manager Plus-ийн нэмэлт төлбөргүй higher-category reassignment эсвэл `CANCELLED_HOTEL` бүтэн refund гэсэн дөрвөн үр дүнгийн аль нэгээр terminal болно. Auto-checkout, auto-move, planned-end mutation болон overdue fee байхгүй.

## 24. Бутархай цагийн canonical precision

- Цагийн walk-in stay-д `0.5`, `1.0`, `1.5`, `2.0` гэх мэт **хагас цагийн алхам** сонгоно.
- Database/API-д binary floating-point hour хадгалахгүй; `duration_minutes` болон `half_hour_units` гэсэн бүхэл утга ашиглана. `duration_minutes = half_hour_units × 30`, `half_hour_units >= 1` байна.
- Manager platform-ийн 30 минутын алхмыг өөрчлөх minimum/maximum/increment тохиргоо үүсгэхгүй. Дээд хугацааг availability, next booking болон cleaning buffer л хязгаарлана.
- Төлбөрийг бүхэл төгрөгөөр дараах байдлаар нэг удаа бодно:

```text
hourly_total_mnt
= ROUND_HALF_UP(effective_hourly_rate_mnt × half_hour_units / 2)
```

- Confirmation snapshot-д unit hourly rate, half-hour units, duration minutes, rounding rule, source/config version болон final amount хадгална. Confirmed/active stay дээр duration өөрчлөхгүй.
- Online booking `BK-DEC-012`-ын дагуу зөвхөн хоногоор тул энэ precision зөвхөн walk-in hourly stay-д үйлчилнэ.

### STAY-DEC-014 — Хагас цагийн бутархай stay

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Walk-in hourly stay нь platform-fixed 30 минутын алхамтай, хамгийн багадаа нэг half-hour unit байна. Duration-ийг integer minutes/half-hour units-аар хадгалж, room charge-ийг effective hourly rate × fractional hours томьёогоор `ROUND_HALF_UP` ашиглан бүхэл төгрөгт нэг удаа тоймлоно. Manager minimum/maximum/increment тохируулахгүй; online booking hourly байхгүй.
