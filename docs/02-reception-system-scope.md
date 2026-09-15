# Reception (RC) System — Ерөнхий хамрах хүрээ

**Хувилбар:** 1.48  
**Төлөв:** RC үндсэн дүрэм, Монгол/гадаад/баримтгүй үндсэн зочны identity, P0-37, P0-38 болон P0-39A–D хамгаалалт батлагдсан  
**Хамаарах үе шат:** MVP — Reception system

## 1. Зорилго

Reception (RC) system нь зочид буудлын ресепшний өдөр тутмын үндсэн ажиллагаа болох зочин бүртгэх, check-in/check-out хийх, өрөөний төлөв хянах, төлбөр тооцоо хийх болон ээлж хүлээлцэх үйл явцыг нэг дор удирдана.

## 2. Нэр томьёо

Баримт бичигт ойлголт давхцахаас сэргийлж дараах нэршлийг ашиглана.

- **Зочин:** Зочид буудалд байрлаж, үйлчилгээ авч байгаа хувь хүн.
- **Системийн хэрэглэгч:** Reception, Cleaner, Manager, Manager Plus, Restaurant эсвэл Hotel Admin эрхээр системд нэвтрэх хүн.
- **Reception / RC:** Ресепшний ажилтан болон түүнд зориулсан системийн хэсэг.
- **Check-in:** Зочны мэдээллийг баталгаажуулж, өрөөнд оруулах ажиллагаа.
- **Check-out:** Зочны ашигласан өрөө, минибар болон бусад баталгаажсан төлбөрийг эцэслэн тооцож, байрлалтыг хаах ажиллагаа.
- **Шууд ирсэн зочин (Walk-in):** Урьдчилан баталгаажсан онлайн захиалгагүйгээр буудал дээр ирж өрөө авч байгаа зочин.
- **Онлайн захиалга:** Системд баталгаажсан захиалгын дугаар, эх үүсвэр болон төлөвтэйгээр урьдчилан үүссэн захиалга.
- **Цагаар байрлалт:** Төлөвлөсөн эхлэх, дуусах цагтай бөгөөд өрөөний төлбөрийг цагийн дүрмээр тооцох байрлалт.
- **Хоногоор байрлалт:** Төлөвлөсөн check-in/check-out огноо, цагтай бөгөөд өрөөний төлбөрийг хоногийн дүрмээр тооцох байрлалт.

## 3. RC системийн үндсэн ажиллагаа

### 3.1 Зочин бүртгэх

- Reception үндсэн зочны identity type-ийг `MN_REG_NO`, `FOREIGN_PASSPORT`, `OTHER_GOV_ID`, `NO_DOCUMENT`-оос сонгоно.
- Бүх төрөлд овог/фамилийн нэр, өөрийн нэр, төрсөн огноо, nationality болон identity source заавал байна. Нас тусдаа editable талбар биш; check-in өдрийн огноо болон баталгаажсан төрсөн огнооноос сервер тооцно.
- `MN_REG_NO` үед normalized, structurally valid Монгол регистр шаардана. ХУР/XYP-ээс мэдээлэл олдвол автоматаар бөглөж `XYP_VERIFIED`, service unavailable/not-found үед Reception гараар оруулж `MANUAL` provenance хадгална.
- `FOREIGN_PASSPORT` үед issuing country, passport number, expiry date; `OTHER_GOV_ID` үед document type, issuing country/authority, document number заавал байна.
- `NO_DOCUMENT` үед mandatory reason, note авч `LOW_ASSURANCE` гэж тэмдэглэнэ; document verified мэт харагдуулахгүй.
- Үндсэн зочин check-in өдөр 18 нас хүрээгүй бол guardian/responsible adult-ийн нэр, холбоо барих дугаар, relationship metadata заавал авна. Guardian нь тусдаа staying-guest/Excel мөр болохгүй.
- Зөвхөн structurally valid `MN_REG_NO` үндсэн зочны normalized регистр Police exact match-д орно. Passport/other ID/no-document дээр нэр, төрсөн огноо, хаягаар fuzzy match хийхгүй; `NOT_ELIGIBLE_EXACT_RD` гэж хадгална. Valid РД-тэй хүүхдийг matching-ээс хасахгүй.
- Raw identifier-ийг encrypted хадгалж, exact lookup-д identity type/country namespace бүхий keyed token ашиглана. Identifier-ийг ердийн log/analytics-д бичихгүй.
- Match үүссэн эсэх, эрэн сурвалжлах үндэслэл болон цагдаагийн мэдээллийг Reception, Manager, Hotel Admin, Cleaner, Restaurant эсвэл зочинд харуулахгүй. Зөвхөн эрх бүхий Police portal-д alert үүсгэнэ.
- Walk-in check-in хийх үед Reception байрлалтыг `цагаар` эсвэл `хоногоор` гэж сонгоно. Цагийн хугацааг 30 минутын алхмаар сонгож, сервер `duration_minutes`/`half_hour_units` бүхэл утгаар хадгалан `ROUND_HALF_UP(hourly_rate × half_hour_units / 2)`-оор бодно (`STAY-DEC-014`).
- Online booking зөвхөн `хоногоор`; stay type/duration нь booking snapshot-оос автоматаар ирнэ. Сонгосон төрлөөс хамаарч төлөвлөсөн дуусах огноо/цаг болон хүчинтэй үнийг сервер тооцоолно; Reception unit price-ийг гараар оруулах, солих эсвэл override хийхгүй (`BK-DEC-012`).
- Booking/stay хугацааг төгсгөлийн агшныг оруулахгүй `[start, end)` interval-аар тооцно. Иймээс нэг interval-ийн `end` нөгөөгийн `start`-тай тэнцэх нь өөрөө давхцал биш боловч тухайн stay/booking-д snapshot хийсэн cleaning buffer болон бодит readiness тусдаа заавал хангагдана.
- Төлөвлөсөн хугацаа нь тухайн өрөөний дараагийн захиалгатай давхцаж, эсвэл шаардлагатай cleaning buffer-ийг багтаахгүй байвал систем check-in-ыг зөвшөөрөхгүй. Эцсийн overlap/readiness validation-ийг сервер хийнэ.
- Баталгаажсан зочныг сонгосон өрөөнд check-in хийнэ.
- 30,000₮ багцад check-in амжилттай болмогц систем тухайн байрлалтад зориулсан 4–6 оронтой нэг удаагийн guest access код үүсгэж, Reception зочинд өгнө.
- Нэг өрөөнд олон зочин өөр төхөөрөмж ашиглах бол Reception нэмэлт нэг удаагийн код үүсгэж өгнө. Нэг stay-д зэрэг идэвхтэй байх guest session-ийн дээд хязгаар 5 байна.
- Check-out хийх үед байрлалт болон төлбөрийн тооцоог хаана.
- Төлөгдсөн боловч эцсийн төлөвт ороогүй Restaurant захиалга байвал Reception-д тод анхааруулга харуулна. Reception зочинд мэдэгдсэнээ баталгаажуулсны дараа check-out-ыг үргэлжлүүлэх бөгөөд уг захиалга check-out-оос шалтгаалан автоматаар цуцлагдахгүй.
- Дуусаагүй Restaurant захиалга бүрд Reception зочны хэлснээр `Reception дээр хүлээн авах`, `Зочин Restaurant-аас өөрөө авах`, `Цуцлалт/буцаалт хүсэх` сонголтын аль нэгийг бүртгэнэ. Сонголтыг Restaurant-д мэдэгдэнэ.
- Check-out дуусмагц тухайн байрлалтын ашиглагдаагүй guest access код болон идэвхтэй guest session-уудыг автоматаар хүчингүй болгоно.

> ХУР-ээс авах өгөгдлийн яг бүрдэл, зөвшөөрөл, алдаа гарсан үеийн ажиллагааг тусдаа шаардлагаар тодорхойлно.

### 3.2 Өрөөний төлөв харах

RC хэрэглэгч дор хаяж дараах мэдээллийг харна:

- өрөө сул эсвэл зочинтой эсэх;
- захиалгын эх үүсвэр `Walk-in` эсвэл `Online` эсэх;
- одоогийн occupancy `Сул`, `Check-in хийсэн` эсвэл `Check-out хийгдэж байгаа` эсэх;
- тусдаа ирээдүйн reservation `Hold`, `Confirmed booking` эсвэл `Overdue conflict` байгаа эсэх;
- өрөө цэвэрлэгдсэн эсэх;
- 25,000₮/30,000₮ багцад minibar mode/status `Хамаарахгүй`, `Бүтэн`, `Дутуу` эсвэл `Тодорхойгүй` эсэх;
- `Дутуу` бол дараагийн stay-д хүчинтэй `Manager зөвшөөрсөн` shortage exception байгаа эсэх;
- 25,000₮/30,000₮ багцын minibar-enabled өрөөнд Cleaner report-ийн хүлээлт, шалгалт, илгээх, залруулах, payment lock болон тооцоонд орсон lifecycle;
- 25,000₮/30,000₮ багцад current minibar mode/template exact version, pending target exact version/state болон `Configuration change pending` check-in blocker;
- тухайн өрөө цагаар эсвэл хоногоор ашиглагдаж байгаа эсэх;
- одоогийн байрлалтын төлөвлөсөн дуусах цаг болон үлдсэн хугацаа;
- дараагийн баталгаажсан захиалгын эхлэх, дуусах цаг.

Өрөө одоо сул боловч дараа нь захиалгатай бол `Сул — HH:mm хүртэл` болон `Дараагийн захиалга HH:mm–HH:mm` мэдээллийг хамтад нь харуулна. Ингэснээр Reception дараагийн захиалгатай давхцах цагийн байрлалт үүсгэхгүй.

Actual checkout бүртгэгдэхээс өмнө төлөвлөлтийн availability-г `planned checkout + snapshotted cleaning buffer`-аар тооцно. Actual checkout бүртгэгдсэний дараа өрөөний хамгийн эрт бэлэн болох цагийг `actual checkout + ижил snapshotted cleaning buffer`-аар дахин бодно. Server time уг хугацаанд хүрсэн эсвэл өнгөрсөн, бодит cleaning state `Цэвэр`, мөн тухайн өрөөнд хамаарах existing minibar readiness хангагдсан үед л өрөөг дахин check-in-д ашиглана.

Зочин эрт гарвал cleaning buffer actual checkout-оос эрт эхэлж болох боловч дараагийн confirmed booking-ийн эхлэх цаг автоматаар урагшлахгүй. Оройтож гарвал buffer болон actual readiness time хойшилно. `STAY-DEC-012` early automatic reprice/refund, overdue automatic fee/penalty үүсгэхгүй; дараагийн confirmed booking conflict-ийг `STAY-DEC-013`-ын hard blocker/reassignment/hotel-cancellation урсгалаар шийднэ.

25,000₮ болон 30,000₮ багцад өрөөний цэвэрлэгээний төлөвийг зөвхөн Cleaner эрхтэй хэрэглэгч гараар өөрчилнө. Reception уг төлөвийг зөвхөн харна.

20,000₮ багцад Cleaner байхгүй тул Manager өрөөний төлөвийг `цэвэрлэгээ шаардлагатай`-аас `цэвэр` болгон өөрчилнө. Reception уг төлөвийг зөвхөн харна.

- 25,000₮ болон 30,000₮ багцын minibar-enabled өрөөнд Reception check-out эхлүүлэх үед Cleaner dashboard-д minibar шалгах ажил үүснэ.
- Cleaner минибарын хэрэглээг илгээсний дараа Reception эцсийн төлбөрийг бодож check-out-ыг дуусгана.
- Эцсийн check-out дуусахад систем өрөөг автоматаар `цэвэрлэгээ шаардлагатай` төлөвт оруулна.
- Cleaner цэвэрлэгээг дуусгасны дараа өрөөг `цэвэр` төлөвт оруулна.
- 20,000₮ багц болон minibar-disabled өрөөний check-out minibar тайлан хүлээхгүй.

### 3.3 Төлбөр тооцоо хийх

- Төлбөрийг QPay, карт эсвэл бэлэн мөнгөөр хүлээн авна.
- Картын төлбөрийг банкны POS төхөөрөмжөөр авч системд гараар бүртгэх болон системтэй шууд холбогдсон төлбөрийн гарцаар баталгаажуулах хоёр хэлбэрийг дэмжинэ.
- POS төхөөрөмжийн төлбөрийг `гараар бүртгэсэн картын төлбөр`, холбогдсон гарцын төлбөрийг `системээр баталгаажсан картын төлбөр` гэж ялгаж хадгална.
- Байрлалт бүрд нэг нэгдсэн тооцоо үүсгэнэ.
- Нэгдсэн тооцоонд байрлалтын төрөл `цагаар` эсвэл `хоногоор` гэж хадгалагдаж, тухайн төрлийн баталгаажсан үнийн snapshot ашиглагдана.
- Өрөөний баталгаажсан snapshot нь unit price, тарифын эх үүсвэрийн түвшин ба ID, configuration version-ийг хадгална. Дараа Manager тариф зассан ч paid/confirmed booking болон active stay-ийн room charge-ийг current configuration-аас дахин бодохгүй.
- Өрөөний төлбөрийг эхэлж авч болох бөгөөд минибар болон бусад баталгаажсан хэрэглээг тухайн тооцоонд дараа нь нэмнэ.
- Систем `нийт хэрэглээ − өмнө төлсөн дүн = үлдэгдэл` зарчмаар эцсийн төлөх дүнг автоматаар тооцно.
- Check-out үед үлдэгдэл төлбөрийг барагдуулж, нэгдсэн тооцоог хаана.
- Эцсийн баримтад өрөө, минибар болон бусад төлбөрийг тус бүрээр задалж харуулна.
- 25,000₮ болон 30,000₮ багцын minibar-enabled өрөөнд Reception эцсийн тооцоог батлахын өмнө Cleaner-ийн минибарын тайланг авна. Тайланд хэрэглэсэн бүтээгдэхүүн байхгүй бол Cleaner үүнийг `хэрэглээгүй` гэж заавал батална.
- Cleaner-ийн илгээсэн бүтээгдэхүүн, тоо ширхэгт үндэслэн систем минибарын үнийг автоматаар нэгдсэн тооцоонд нэмнэ.
- Reception minibar тайлангийн бүтээгдэхүүн, тоо болон дүнг өөрөө засахгүй. Алдаа байвал Cleaner-д шалтгаантай буцааж шинэ хувилбар авна.
- Cleaner боломжгүй үед Manager/Manager Plus өрөөг бодитоор шалгаж, шалтгаантай онцгой minibar тайлан үүсгэсний дараа checkout үргэлжилнэ. Reception тайлангүй bypass хийхгүй.
- Зочин minibar хэрэглээг маргавал Reception маргаантай мөрийг тэмдэглэж, Manager/Manager Plus шийдвэрлэх хүртэл эцсийн checkout-ыг хүлээлгэнэ.
- Баталгаажсан борлуулалт болон орж ирсэн мөнгөн дүнг тусад нь хянана.

Cleaner report version, payment lock, exception, dispute болон төлбөрийн дараах adjustment-ийн canonical дүрэм: [21-cleaner-checkout-exception-and-dispute.md](./21-cleaner-checkout-exception-and-dispute.md).

### 3.4 Барьцаа

- Барьцааны шаардлагыг зочны хувийн төрлөөр бус, тухайн байрлалтын захиалгын эх үүсвэрээр автоматаар тодорхойлно.
- Урьдчилан баталгаажсан онлайн захиалгагүй, шууд ирсэн зочин барьцаа төлнө.
- Баталгаажсан онлайн захиалгаар ирсэн зочин барьцаа төлөхгүй.
- Онлайн захиалгын урьдчилсан төлбөр нь өрөөний төлбөрт тооцогдох бөгөөд барьцаа гэж бүртгэгдэхгүй.
- Шууд ирсэн зочны барьцааны дүн 50,000–100,000 төгрөгийн хооронд байна.
- Барьцааг QPay, карт эсвэл бэлэн мөнгөөр хүлээн авч, буцааж эсвэл төлбөрт суутгаж болно.
- Manager эсвэл Hotel Admin үндсэн барьцааны дүнг буудлын хэмжээнд, шаардлагатай бол өрөөний ангилал бүрээр урьдчилан тохируулна.
- Reception check-in хийх үед систем тухайн байрлалд барьцаа шаардах эсэх болон дүнг автоматаар харуулна.
- Барьцааг өрөө, минибарын борлуулалтын орлогод тооцохгүй бөгөөд төлбөрөөс тусдаа бүртгэнэ.
- Барьцаа хүлээн авсан, суутгасан болон буцаасан бүх хөдөлгөөн түүхтэй байна.
- Барьцаанаас бүхэлд нь эсвэл хэсэгчлэн суутгахад шалтгаан, нотлох зураг/баримт болон Manager/Hotel Admin-ийн тусдаа баталгаа шаардахгүй.
- Гэхдээ систем суутгасан дүн, үйлдэл хийсэн хэрэглэгч, огноо/цаг болон холбоотой байрлалтыг автоматаар аудитын түүхэд хадгална.
- Бэлэн мөнгөөр авсан болон буцаасан барьцаа нь ээлжийн кассын бодит үлдэгдэлд нөлөөлөх боловч борлуулалтын тайланд орохгүй.
- Reception хэрэглэгч захиалгын эх үүсвэр болон барьцаанаас чөлөөлөгдсөн төлөвийг дур мэдэн өөрчлөхгүй.
- Онцгой тохиолдлын өөрчлөлтийг Manager/Hotel Admin баталж, шалтгаан болон үйлдлийн түүхийг хадгална.
- Unused deposit-ийг боломжтой бол анхны payment сувгаар буцаана. Өөр сувгийн refund Manager/Hotel Admin approval-тай байна.
- Гар POS payment/refund reference заавал хадгална. Provider success-гүй refund complete болохгүй.
- Буруу financial transaction-ийг edit/delete хийхгүй; reversal + Manager/Hotel Admin баталсан correction ашиглана.

Canonical deposit/payment correction дүрэм: [20-deposit-and-payment-correction.md](./20-deposit-and-payment-correction.md).

### 3.5 Ээлж хаах ба хүлээлцэх

- Reception хэрэглэгч өөрийн ээлжийг хаана.
- Ердийн горимд дараагийн Reception-д мөнгөө хүлээлгэн өгч, хүлээн авагчийн бодитоор тоолсон дүнгээр шинэ ээлж шууд эхэлнэ.
- Ердийн ээлжийн санхүүгийн review-г Manager/Manager Plus, exception үед Hotel Admin хийнэ; review хүлээлт шинэ ээлжийг зогсоохгүй.
- Нэг ажилтантай горимын `Өөрөө хаасан` нь operational terminal байна. Зөрүүгүй бол нэмэлт review шаардахгүй, зөрүүтэй бол Hotel Admin review шаардлагатай.
- Шинэ ээлж эхэлсний дараа Manager/Hotel Admin хуучин ээлжийг дахин нээхгүй.
- Opening balance болон original close-ийг overwrite хийхгүй; дараах залруулгыг холбоостой шинэ correction хөдөлгөөнөөр бүртгэнэ.
- Системээр тооцсон хүлээгдэж буй бэлэн мөнгө болон бодитоор тоолсон бэлэн мөнгөний зөрүүг автоматаар гаргана.

Canonical state machine: [03-reception-shift-handover.md](./03-reception-shift-handover.md).

### 3.6 Cash drawer

- Hotel activation-д бүх багцад нэг `Үндсэн касс` үүснэ; Hotel Admin нэмэлт drawer болон optional safe үүсгэж болно.
- Нэг drawer-д нэг active shift, нэг Reception account-д нэг active drawer shift байна.
- Анхны shift-ийн opening нь Reception-ийн бодитоор тоолсон дүн; configured float-ийн зөрүү Hotel Admin review-д орно.
- Дараагийн opening balance-ийг гараар засахгүй; бодитоор хүлээн авсан/self-close үед тоолсон snapshot ашиглана.
- Cash payment/deposit/refund, `Paid cash expense`, top-up, transfer, bank/owner withdrawal болон correction тусдаа typed immutable movement байна.
- Drawer/safe transfer, top-up болон bank/owner withdrawal revenue/expense гэж автоматаар тооцогдохгүй.
- Pending drawer transfer complete эсвэл бодитоор буцааж cancel болоогүй бол оролцсон shift хаагдахгүй.
- Expense approval нь мөнгө гарсныг илэрхийлэхгүй; cash method-ийг active drawer-аас бодитоор execute хийхэд `Paid` + cash movement үүснэ. Card/POS болон bank/QPay expense `Paid` болохдоо transaction/provider reference хадгалах боловч cash movement үүсгэхгүй.
- Physical cash correction backdate хийхгүй; effective өдөр/current active shift-д орно.

Canonical cash ledger: [24-cash-drawer-ledger.md](./24-cash-drawer-ledger.md).

### 3.7 Minibar selling price snapshot

- 25,000₮/30,000₮ багцын minibar-enabled check-in батлагдах үед current configuration-д заасан exact template version-ийн бүх product, opening quantity `0` мөрийг оролцуулан, selling price-ийг stay price book болгон түгжинэ.
- Active stay үргэлжилж байх үед Manager current price өөрчилсөн ч тухайн stay reprice болохгүй; шинэ үнэ дараагийн check-in-ээс үйлчилнэ.
- Cleaner үндсэн report болон Manager/Manager Plus онцгой report-ын quantity-г оруулах боловч price override хийхгүй; сервер stay price book-оос дүн бодно.
- Төлбөрөөс өмнөх report version, payment lock болон төлбөрийн дараах correction original stay snapshot price ашиглана.
- Stay үеийн refill-ийг Reception эсвэл Manager/Manager Plus хүсэж, Cleaner task-аар actual quantity-г батлахад stay/price-book line-тэй warehouse → room movement үүснэ; check-in selling price хэрэглэнэ.
- Active stay-ийн warehouse return, room waste болон negative adjustment зочны хэрэглээнээс хасагдана; generic positive adjustment billable quantity нэмэхгүй.
- Price book-д байгаагүй product тухайн stay-д автоматаар charge болохгүй.

Canonical price snapshot: [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md).

### 3.8 Room/minibar entity lifecycle

- Room, category, minibar product болон template entity нь `ACTIVE → RETIRING → INACTIVE` lifecycle ашиглана; template version lifecycle үүнээс тусдаа байна.
- Deactivation хүсэлт шинэ booking, walk-in check-in болон assignment-ийг шууд хаана.
- Active stay болон deactivation-оос өмнө баталгаажсан booking-г автоматаар cancel/reprice хийхгүй; future booking-г reactivate/active entity рүү шилжүүлэх/cancellation-аар шийдтэл check-in хийхгүй, entity `RETIRING` байна.
- Minibar-enabled room-ийн template entity эсвэл template-ийн аль нэг product `ACTIVE` биш бол room өөрөө active байсан ч шинэ booking/check-in-д configuration blocker-тэй байна.
- Шинэ active-stay refill request зөвхөн active product-оор үүснэ; deactivation-оос өмнө үүссэн pending task retiring үед terminal болж болох ч inactive product дээр completion хийхгүй.
- Reception room/category lifecycle болон blocker-ийг read-only харна; deactivate/reactivate/hard-delete хийхгүй.
- Огт ашиглагдаагүй, reference/task/stock/movement-гүй entity-г л hard-delete хийж болно.
- Reactivation нь dependency, package, configuration болон uniqueness шалгалттай байна.

Canonical lifecycle: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md).

### 3.9 Room minibar configuration change

- Room яг нэг current configuration, хамгийн ихдээ нэг non-terminal pending mode/template change-тай байна; ON configuration бүр template entity болон exact version-ийг хамтад нь заана.
- Active stay үед Manager/Manager Plus change-г товлож болох боловч current stay-ийн mode, exact template version, opening quantity болон price book өөрчлөгдөхгүй.
- Checkout, payment, minibar report болон pending refill task бүр terminal болсны дараа Cleaner-д target configuration reconciliation task үүснэ.
- ON → OFF үед usable room stock warehouse-д буцаж, room balance `0` болсны дараа mode OFF/template `null` болно.
- OFF → ON болон Template A → B үед Cleaner actual count баталж, removed/excess stock буцаан, added/short stock нөхнө. Нөөц хүрэлцэхгүй бол Manager/Manager Plus-ийн хүчинтэй shortage override-гүйгээр apply хийхгүй.
- Configuration transfer нь guest consumption/charge биш. Configuration apply нь cleaning status-ийг автоматаар `Цэвэр` болгохгүй.
- Movement эхлээгүй request-ийг Manager/Manager Plus шууд cancel хийж болно; movement post болсон бол immutable compensating rollback бүрэн дуусна.
- Non-terminal pending change-тэй physical room шинэ assignment/check-in авахгүй. Future booking автоматаар cancel/reprice болохгүй, minibar config booking үед pin болохгүй; check-in үеийн current config-д заасан exact version ашиглагдана.
- Reception current/pending config, reconciliation state болон blocker-ийг read-only харна.

Canonical room configuration reconciliation: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md).

### 3.10 Minibar template version lifecycle

- Template entity-ийн `ACTIVE/RETIRING/INACTIVE` lifecycle болон түүнд хамаарах version-ийн `DRAFT/PUBLISHED/ARCHIVED` lifecycle-ийг тусад нь хадгална.
- `DRAFT` version засварлагдаж болох боловч room-ийн current/pending configuration-д сонгохгүй, check-in-д ашиглахгүй.
- `PUBLISHED` version-ийн product list болон target quantity immutable байна. Өөрчлөлт хийхдээ өмнөх version-оос шинэ `DRAFT` үүсгэнэ.
- Publish хийхдээ сервер parent template entity `ACTIVE`, дор хаяж нэг product байгаа бөгөөд бүх product тухайн hotel-д хамаарах lifecycle `ACTIVE`, давхардсан product-гүй, target quantity бүр эерэг бүхэл тоо эсэхийг нэг transaction-д шалгана. Аль нэг нөхцөл хангахгүй бол publish хийхгүй.
- `ARCHIVED` version terminal/history-only бөгөөд шинэ assignment-д сонгохгүй, шууд Published болгон сэргээхгүй. Дахин ашиглах бол archive-аас шинэ `DRAFT` clone үүсгэнэ.
- Нэг template entity дотор олон `PUBLISHED` version зэрэгцэн байж болно. Анхны Published version автоматаар тухайн template-ийн цорын ганц `Default Published` болно; дараагийн version publish болохдоо одоогийн Default-ийг автоматаар солихгүй.
- Room-ийн current болон pending configuration exact version заана. `Publish` болон `Set default` нь existing room-ийн current/pending reference, active stay эсвэл future booking-ийг автоматаар өөрчлөхгүй; inventory/stock movement, Cleaner task эсвэл check-in blocker үүсгэхгүй.
- Default Published version-ийг archive хийхгүй; эхлээд тухайн template-ийн өөр eligible Published version-ийг `Set default` хийнэ.
- Exact version нь аль нэг room-ийн current/pending configuration, active stay эсвэл non-terminal reconciliation/Cleaner/configuration task-д reference-тэй бол archive-ийг сервер хориглоно. Historical stay/report/price book/audit reference archive-ийг хориглохгүй бөгөөд түүхдээ хэвээр хадгалагдана.
- Future booking minibar version pin хийдэггүй тул өөрөө archive blocker болохгүй.
- Archive нь inventory/stock movement, Cleaner task, configuration request эсвэл check-in blocker үүсгэхгүй.
- `Publish`, `Set default`, `Archive`-ийг зөвхөн идэвхтэй minibar entitlement + тухайн багцад зөвшөөрөгдсөн role гүйцэтгэнэ: 25,000₮-д Manager, 30,000₮-д Manager эсвэл Manager Plus. Hotel Admin энэ operational үйлдлийг хийх бол дээрх зөвшөөрөгдсөн role-ийг тусдаа авна; 25,000₮ багцад Manager Plus role үүсгэж entitlement-ийг тойрохгүй.
- Ашиглагдсан эсвэл reference-тэй version-ийг түүхээс устгахгүй; stay, configuration, reconciliation болон audit холбоос exact version-ээ хадгална.
- Room-уудыг өөр exact version рүү шилжүүлэх explicit `Rollout` нь Publish/Set default/Archive-аас тусдаа ажиллагаа бөгөөд доорх 3.11-ийн батлагдсан room-level болон multi-room batch урсгалыг ашиглана.

Canonical template version lifecycle, Publish/Default, Archive болон Explicit Rollout: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md)-ийн RML-DEC-015–028.

### 3.11 Explicit Rollout

- Rollout хийхэд тухайн hotel-ийн нэг exact `PUBLISHED` target version сонгоно; Default байх албагүй. Confirm хийх мөчид сервер target-ийн parent template entity болон бүх target product `ACTIVE` хэвээр байгааг дахин шалгана.
- Eligible room нь ижил hotel, ижил `ACTIVE` template entity-д хамаарах, lifecycle `ACTIVE`, minibar mode `ON`, target-аас өөр current exact version-тэй бөгөөд өөр non-terminal pending configuration-гүй байна. Mode эсвэл template солих нь Rollout биш, ердийн room configuration change байна.
- Active stay-тай room-ийг Rollout-д сонгож болно. Confirm хийхэд exact target version-ийг түгжсэн room-level pending request болон `Configuration change pending` check-in/assignment blocker нэг transaction-д шууд үүснэ.
- Room сул бөгөөд checkout, payment, minibar report, refill зэрэг өмнөх ажиллагаа бүгд terminal болсон safe point-д байвал request `READY_FOR_RECONCILIATION` болж Cleaner reconciliation task шууд үүснэ. Active stay эсвэл дээрх ажиллагааны аль нэг дуусаагүй бол request `SCHEDULED_AFTER_STAY` төлөвт орж, task-ийг existing safe point хангагдсаны дараа л үүсгэнэ.
- Confirm нь current version, stay price book, room/warehouse stock, selling price эсвэл cleaning status-ийг өөрчлөхгүй. Cleaner task-аар шаардлагатай immutable stock movement-үүдийг reconciliation үеэр гүйцэтгэнэ; existing P0-37B final validation амжилттай үед current version switch, pending completion болон audit атомикаар хийгдэнэ.
- Pending request exact target-ээ хадгална. Дараа нь өөр version publish хийх эсвэл Default солих нь target-ийг өөрчлөхгүй; pending target reference байгаа үед тухайн version-ийг Archive хийхгүй.
- Rollout-ийг зөвхөн идэвхтэй minibar entitlement + зөвшөөрөгдсөн role хийнэ: 25,000₮-д Manager, 30,000₮-д Manager эсвэл Manager Plus. Hotel Admin-д дээрх role тусдаа шаардлагатай; 20,000₮ болон entitlement-гүй үед хориглож, 25,000₮-д Manager Plus role үүсгэн gate тойрохгүй.

Canonical Explicit Rollout дүрэм: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md)-ийн RML-DEC-022–024.

#### 3.11.1 Multi-room Rollout batch

- Нэг batch parent нь нэг exact `PUBLISHED` target version болон ижил hotel/template-ийн олон room-ийг заана. Target exact ID-аар түгжигдэх тул дараагийн `Publish`/`Set default` үйлдэл batch-ийг өөр version рүү шилжүүлэхгүй.
- Read-only preview нь room бүрийг `Одоо хийх боломжтой`, `Stay дууссаны дараа`, `Сонгох боломжгүй` гэж ангилж, боломжгүй шалтгааныг харуулна. Preview нь pending request, blocker, Cleaner task, stock movement эсвэл Archive blocker үүсгэхгүй.
- Confirm агшинд сервер room бүрийн hotel/template, lifecycle, current version болон existing pending change-ийг дахин шалгана. Шаардлага хангасан room бүрд exact target-тай child pending request + check-in/assignment blocker нэг transaction-д үүсэж, шаардлага хангаагүй room `SKIPPED` болж шалтгаанаа хадгална; skipped room-д blocker үүсэхгүй.
- Partial success ашиглана: нэг child-ийн failure бусад accepted child-ийг зогсоох эсвэл rollback хийхгүй. Child бүр өмнөх room-level safe-point, Cleaner reconciliation, apply болон rollback дүрмээр бие даан үргэлжилнэ.
- Batch parent-ийн төлөвийг child үр дүнгээс `IN_PROGRESS`, `COMPLETED`, `PARTIALLY_COMPLETED`, `CANCELLED`, `FAILED_VALIDATION` гэж автоматаар гаргана. Confirm-оор нэг ч room accepted болоогүй бол `FAILED_VALIDATION` бөгөөд target version-д Archive blocker үүсэхгүй.
- `Cancel remaining` нь movement эхлээгүй child-ийг цуцалж blocker-ийг арилгана. Movement эхэлсэн child existing immutable compensating rollback урсгалд орж terminal болтол blocker-тэй байна. `APPLIED` room өөрчлөгдөхгүй; буцаах бол өмнөх exact version рүү чиглэсэн шинэ Rollout үүсгэнэ.
- Retry нь хуучин batch/child түүхийг засахгүй. Eligibility-г дахин шалгасан шинэ batch үүсгэж `retry_of_batch_id`-аар өмнөх batch-тай холбоно.
- Confirmed non-terminal child/batch target version-ийг Archive хийхийг хориглоно. Бүх child terminal болсон үед тухайн version-ийн бусад archive blocker-ийг ердийн дүрмээр дахин шалгана.
- Давхар Confirm ижил idempotency key-ээр хоёр batch үүсгэхгүй. Нэг room-д нэгээс олон non-terminal pending change үүсгэхгүй бөгөөд cross-hotel/cross-template room эсвэл target ID-г сервер хориглоно.
- Preview/Confirm/Cancel remaining/Retry эрх нь 25,000₮ багцад зөвхөн Manager, 30,000₮ багцад Manager эсвэл Manager Plus-д байна. Hotel Admin-д зөвшөөрөгдсөн operational role тусдаа шаардлагатай; 20,000₮/entitlement-гүй үед хориглож, 25,000₮-д Manager Plus үүсгэн gate тойрохгүй.
- Reception batch, child pending state болон blocker-ийг read-only харна. Cleaner зөвхөн өөрт оноогдсон accepted child reconciliation/rollback task-ийг гүйцэтгэх бөгөөд batch-ийг Confirm/Cancel/Retry хийхгүй.

Canonical multi-room batch дүрэм: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md)-ийн RML-DEC-025–028.

### 3.12 Stay room тарифын шатлал, snapshot ба хоногийн planned checkout

- Цагийн болон хоногийн тариф нь бие даасан тохиргоо, resolution болон snapshot-тай байна. Нэг төрлийн override нөгөө төрлийн үнийг өөрчлөхгүй.
- Walk-in stay-д сервер `room override → category override → hotel default` дарааллаар эхний тохируулсан хүчинтэй тарифыг сонгоно.
- Online booking-ийн quote-д сервер `category override → hotel default` дарааллаар сонгож, room override ашиглахгүй. Өрөө дараа оноосон эсвэл check-in хийсэн нь баталгаажсан booking-ийн үнийг солихгүй.
- Override тохируулаагүй бол дараагийн доод түвшний тохиргоог автоматаар өвлөнө. Client/Reception-оос ирсэн unit price authoritative биш; сервер эх үүсвэрийг дахин resolve хийнэ.
- Walk-in check-in баталгаажихад, Online booking paid/confirmed болоход unit price, stay type, source level, source ID, configuration version болон server snapshot time-ийг immutable snapshot болгон хадгална.
- Paid/confirmed booking болон active stay үүссэний дараах tariff edit нь тэдгээрийг reprice хийхгүй. Шинэ үнэ зөвхөн дараагийн шинэ quote эсвэл Walk-in confirmation-д үйлчилнэ.
- Тарифыг 20,000₮, 25,000₮ болон 30,000₮ багцын Manager тохируулна. Hotel Admin tariff action хийх бол Manager role-ийг тусад нь авна. Үнэ өөрчилсөн audit нь old/new value, hourly/nightly type, source level/ID, configuration version, actor болон server time-ийг хадгална.
- P0-38B-ээр цагийн minimum, maximum эсвэл increment-ийн шинэ тохиргоо нэмэхгүй. Өмнөх суурь томьёогоор effective нэг цагийн үнийг Reception-ийн сонгосон цагийн тоогоор үржүүлнэ; Manager-д хугацааны ийм нэмэлт тохиргоо өгөхгүй.
- Хоногийн байрлалтад Reception эерэг бүхэл `N` шөнийн тоо сонгоно. Planned checkout нь буудлын local timezone дахь check-in календарийн огноо + `N` календарийн өдөр, баталгаажуулах үед snapshot хийсэн тогтсон hotel check-out цаг байна.
- Check-in тогтсон check-out цагаас өмнө хийгдсэн ч `1` шөнө нь маргаашийн check-out цагт дуусна. Тухайн өдрийн check-out хүртэлх богино байрлалтыг хоногоор биш, цагаар сонгоно.
- Хоногийн өрөөний төлбөрийг сервер `effective нэг шөнийн үнэ × N` томьёогоор бодож, баталгаажуулахын өмнө дараагийн booking болон cleaning buffer-тэй давхцлыг дахин шалгана.
- Баталгаажуулах үед шөнийн тоо, effective unit rate, rate source, config version, тогтсон check-out цаг болон planned checkout snapshot хадгалагдана. Дараагийн tariff/check-out config edit нь confirmed booking болон active stay-г өөрчлөхгүй.
- Early-morning cutoff-ийн тусдаа дүрмийг одоогоор нэмэхгүй; энэ нь P0-38C-ийн батлагдсан MVP дүрмээс гадуур түр хойшлогдсон.

Canonical шийдвэр: [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md)-ийн `STAY-DEC-005`–`STAY-DEC-008`.

### 3.13 Actual check-in time ба backdate хамгаалалт

- Initial check-in confirmation хийхэд default `actual_check_in_at = server_now`, `check_in_recorded_at = server_now` байна.
- Reception зөвхөн initial confirmation-оос өмнө past actual time сонгож болно. Хамгийн ихдээ 120 минут backdate хийх бөгөөд серверийн доод хязгаар:

```text
earliest_allowed = max(
  server_now - 120 minutes,
  current_open_shift.started_at,
  hotel_local_day_start,
  confirmed_booking.planned_checkin_at  // booking байвал
)
```

- Сонгосон `actual_check_in_at` нь `earliest_allowed ≤ actual_check_in_at ≤ server_now` байна. Иймээс өмнөх local өдөр, өмнөх/closed shift эсвэл online booking-ийн planned start-аас өмнө backdate хийхгүй.
- Current open shift байхгүй бол initial check-in confirmation хийхгүй; client/device clock нь server time-ийг орлохгүй.
- Past time сонговол батлагдсан reason code заавал, тайлбар note optional байна. Manager approval болон зураг/баримт шаардахгүй.
- Initial confirmation-ийн server transaction нь `[actual_check_in_at, planned_checkout_at)` interval-ийн overlap, өмнөх stay-ийн historical actual checkout + түүний snapshotted cleaning buffer, хүссэн actual агшин дахь historical `Цэвэр` төлөв болон applicable minibar readiness, room/category lifecycle ба blocker, дараагийн booking + buffer, мөн `planned_checkout_at > server_now` эсэхийг дахин шалгана.
- Historical readiness-ийг immutable event/state history-оор нотолж чадахгүй бол backdate-ийг хориглож, Reception-д `Server-ийн одоогийн цагаар check-in хийх` сонголтыг санал болгоно.
- Амжилттай confirmation-д `actual_check_in_at` болон `check_in_recorded_at` immutable хадгалагдана. Тариф, current room/minibar configuration, minibar price book болон opening quantity snapshot нь backdate хийсэн түүхэн төлөв зохиохгүй; `check_in_recorded_at` агшны current authoritative state-ийг ашиглана. Paid/confirmed online booking-ийн price snapshot reprice болохгүй.
- Check-in-тэй холбоотой payment/cash movement-ийг сонгосон past actual time эсвэл хуучин shift рүү буцааж бичихгүй; current open shift болон бодит transaction time-д бүртгэнэ. Police matching/alert нь `check_in_recorded_at` үед ажиллана.
- Stay activation амжилттай болсны дараа Reception `actual_check_in_at` эсвэл check-in record-ийг direct edit/backdate хийхгүй. Залруулгыг зөвхөн доорх P0-39B-2 / `STAY-DEC-010` immutable correction request-аар хийнэ.
- Audit нь actor/role, hotel/room/booking/stay/current shift, requested/default actual time, backdate минут, `check_in_recorded_at`, earliest-bound утгууд, reason code/optional note, validation result болон server time-ийг хадгална (`STAY-DEC-009`).

Canonical actual check-in/backdate шийдвэр: [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md)-ийн `STAY-DEC-009`.

### 3.14 Active stay-ийн actual check-in correction request

- Reception stay `ACTIVE` бөгөөд checkout initiation эхлээгүй үед corrected actual time болон заавал reason бүхий correction request submit хийнэ. Checkout эхэлсэн/дууссан stay-д энэ MVP action хориглогдоно.
- Нэг stay-д нэг л pending correction request байна. Pending request байхад checkout initiation блоклогдоно; duplicate submit/approval нь idempotent, approval/rejection concurrency-safe байна.
- Correction-ийн цонх original `check_in_recorded_at` дээр тогтмол түгжигдэнэ:

```text
correction_earliest = max(
  original_check_in_recorded_at - 120 minutes,
  original_shift.started_at,
  hotel_local_day_start(original_check_in_recorded_at),
  confirmed_booking.planned_checkin_at  // booking байвал
)

correction_earliest <= corrected_actual_check_in_at <= original_check_in_recorded_at
```

- Original `actual_check_in_at`, original `check_in_recorded_at`, shift болон initial event-ийг overwrite хийхгүй. Approved immutable amendment-аас `effective_actual_check_in_at`-ийг гаргана; дараагийн correction request цонхыг өмнөх approved effective time-ээс дахин тооцож гулсуулахгүй.
- Manager role correction request-ийг approve/reject хийнэ. Hotel Admin хийх бол тусдаа Manager role авна. Нэг account Reception + Manager role-той бол өөрийн request-ийг approve хийж болох бөгөөд `self_approved=true` audit заавал хадгална. Manager Plus role дангаараа энэ specific approval-ийг орлохгүй.
- Approval transaction нь unchanged `planned_checkout_at` ашиглан `[corrected_actual_check_in_at, planned_checkout_at)` overlap, өмнөх stay-ийн actual checkout + snapshotted buffer, corrected агшин дахь historical `Цэвэр` болон applicable minibar readiness, room/category/config lifecycle/blocker болон next booking + buffer-ийг дахин шалгана. Validation fail бол approve хийхгүй.
- Approved correction зөвхөн effective actual start-ийг өөрчилнө. `planned_checkout_at`, selected hours/nights, stay type, room/minibar unit price/snapshot, deposit/payment/cash shift, room/minibar configuration болон stock/opening snapshot өөрчлөгдөхгүй.
- Police-ийн original Match/alert/detected timestamp өөрчлөгдөхгүй, duplicate Police alert үүсэхгүй. Correction amendment-ийг original Police match/audit reference-тэй холбоно.
- Guest registry болон Excel нь latest approved `effective_actual_check_in_at`-ийг хугацааны эхлэл/эрэмбэд ашиглана; original actual/recorded time immutable audit-д хадгалагдана.
- Request/decision audit нь original/effective/corrected time, fixed bound components, reason, requester/approver roles, `self_approved`, decision/result, stay/room/booking/original shift болон server timestamps-ийг хадгална (`STAY-DEC-010`).

Canonical active-stay actual-time correction: [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md)-ийн `STAY-DEC-010`.

### 3.15 Confirmed booking/active stay-ийн immutable planned end

- Confirmation-оос өмнө Reception/guest existing урсгалаар зөвшөөрөгдсөн stay type болон duration-ийг сонгож болно. Confirmation амжилттай болмогц `planned_checkout_at` snapshot тогтоно.
- Confirmed booking болон `ACTIVE` stay-ийн `planned_checkout_at`/effective planned end-ийг MVP-д аль ч role өөрчлөхгүй. Direct edit/overwrite/delete хориглосон `STAY-DEC-011` хэвээр бөгөөд `STAY-DEC-012`-оор amendment, request/approve/execute action, button/API, extension, planned end shorten/lengthen болон hourly ↔ nightly conversion бүгд байхгүй.
- Зочин planned checkout-оос өмнө эсвэл хойно бодитоор check-out хийж болно. Existing Reception checkout урсгал `actual_checkout_at`-д бодит цагийг бүртгэх бөгөөд original `planned_checkout_at`-ийг mutation хийхгүй.
- Early actual checkout нь өрөөний үнэ/хоног/цагийг автоматаар дахин бодохгүй, төлбөр эсвэл refund автоматаар үүсгэхгүй. Planned checkout өнгөрсөн бол зөвхөн `Хугацаа хэтэрсэн` төлөв болон хэтэрсэн хугацаа харагдах бөгөөд автомат fee/penalty үүсэхгүй.
- Өрөө `actual_checkout_at` бүртгэгдэх хүртэл occupied хэвээр. Actual checkout бүртгэгдсэний дараа P0-39A-ийн тухайн stay-д snapshotted cleaning buffer хугацаа + бодит cleaning state + applicable minibar readiness хангагдсан үед л дахин ашиглана.
- Planned end өөрчлөхгүй тул room/minibar unit price болон price book, deposit/payment, cash shift/movement, room/minibar configuration, opening/stock snapshot хэвээр байна.
- Online booking зөвхөн nightly, нэг booking нэг category room/нэг үндсэн зочинтой; cancellation/no-show нь planned-end edit биш, тусдаа terminal transition байна (`BK-DEC-012`, `PAY-DEC-007`).

Canonical MVP planned-end no-change decision: [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md)-ийн `STAY-DEC-012`.

## 4. Системийн хэрэглэгчийн эрхүүд

| Эрх | Одоогоор тодорхой болсон үндсэн ажиллагаа |
| --- | --- |
| **Reception** | Check-in, check-out болон төлбөр тооцоо хийх; STAY-DEC-009-ийн pre-confirm actual time сонгох; active stay/checkout эхлээгүй үед STAY-DEC-010 correction request submit хийх боловч original field direct edit/approve хийхгүй; confirmation-оос өмнө initial type/duration сонгох боловч confirmed booking/active stay-ийн planned end-ийг өөрчлөх actionгүй; зочны early/late бодит checkout-ийг `actual_checkout_at`-аар бүртгэх; active-stay minibar refill request үүсгэх; өөрийн drawer/shift-ийн cash movement харах; зөвшөөрөгдсөн customer receipt/refund болон approved expense payment execute хийх; room/category lifecycle, multi-room batch summary болон current/pending minibar config/blocker-ийг read-only харах; ээлж хаах, хүлээлцэх; 30,000₮ багцад guest access код үүсгэх, идэвхтэй session-ийн тоог харах, нэг эсвэл бүх session-ийг хүчингүй болгох |
| **Cleaner** | Зөвхөн 25,000₮ болон 30,000₮ багцад идэвхжинэ; mobile responsive dashboard-аас active-stay refill, minibar шалгах, цэвэрлэх/нөхөх болон өөрт оноогдсон configuration child reconciliation/rollback task харах; actual хэрэглээ/refill/count болон assigned task-ийн room ↔ warehouse transfer батлах; цэвэрлэгээний төлөв өөрчлөх; Rollout batch-ийг Confirm/Cancel/Retry хийхгүй |
| **Manager** | Actual check-in correction request approve/reject хийх; Reception role давхар бол өөрийн request-ийг `self_approved` audit-тай батлах; бүх багцад hotel/category/room-ийн цагийн ба хоногийн тариф тохируулах; өрөө/category үүсгэх болон entity deactivation/reactivation удирдах; идэвхтэй 25,000₮/30,000₮ entitlement-д minibar product, худалдах үнэ, худалдан авалтын өртөг, warehouse/room stock, waste/adjustment, template Draft/Publish/Default/Archive, exact-version room/multi-room Rollout preview/confirm/cancel/retry, room configuration change/cancel/variance/rollback, shortage override болон active-stay refill request удирдах; expense хүсэлт submit болон approved expense payment execute хийх; drawer/safe transfer, bank/owner withdrawal request, top-up болон өөрийн operational cash breakdown удирдах; өөрийн буудлын guest registry-г pagination-аар харах, Excel татах |
| **Manager Plus** | Зөвхөн 30,000₮ багцад Manager-ийн зөвшөөрөгдсөн operational эрх дээр Restaurant удирдлага нэмэгдэнэ; ойр орчмын Restaurant бүртгэх, идэвхтэй/идэвхгүй болгох, Restaurant хэрэглэгчийн хандалт үүсгэх; operational expense хүсэлт submit хийх |
| **Restaurant** | Зөвхөн өөрийн хоол, уух зүйл, зураг, үнэ, ангилал болон бэлэн/бэлэн бус төлөвийг удирдах; төлбөр баталгаажсан захиалга хүлээн авах |
| **Hotel Admin** | Өөрийн hotel-ийн full financial/cash dashboard, борлуулалт, орж ирсэн мөнгө, авлага, deposit, Paid expense, minibar gross profit, top-5, график болон Excel харах; drawer/safe, initial configured float, expense/bank/owner withdrawal approval болон cash correction exception удирдах; зочдын байрлалтын жагсаалтыг pagination-аар харах, зөвшөөрөгдсөн Excel татах; actual check-in correction approve/reject хийхэд тусдаа Manager role, request submit хийхэд Reception role шаардана; тариф тохируулахад Manager role, operational customer action-д Reception, template Publish/Set default/Archive/Rollout-д тухайн багцад зөвшөөрөгдсөн Manager role, эсвэл зөвхөн 30,000₮-д Manager Plus role тусдаа шаардана |

> Үйлдэл тус бүрийн canonical зөвшөөрөл, package/subscription gate болон multi-role дүрмийг [18-action-level-permission-matrix.md](./18-action-level-permission-matrix.md)-д баталсан. Hotel Admin нь Manager/Reception-ийн operational эрхийг автоматаар өвлөхгүй.

## 5. RC хэрэглэгчийн үндсэн навигаци

RC системийн үндсэн хэсэг дөрвөн табтай байна:

1. **Зочин бүртгэл** — зочин хайх, бүртгэх, check-in/check-out эхлүүлэх.
2. **Өрөөнүүд** — өрөөний сул/идэвхтэй болон цэвэрлэгээний төлөв харах.
3. **Төлбөр тооцоо** — өрөө, минибарын задаргаа болон төлбөр хүлээн авах.
4. **Restaurant** — 30,000₮ багцад идэвхтэй ресторанууд, цэс болон зочны хоолны захиалгатай холбоотой мэдээллийг харах.

Эдгээр дөрвөн табыг зөвхөн **Reception эрхтэй хэрэглэгчийн үндсэн дэлгэцийн бүтэц** гэж түр ойлгов. Manager, Restaurant болон Hotel Admin хэрэглэгчдийн дэлгэцийг тусад нь тодорхойлно.

## 6. Бүртгэх болон тайлагнах үзүүлэлтүүд

- Нийт болон ашиглагдсан өрөөний тоо.
- Өрөө тус бүрийн төлбөрийн задаргаа.
- Минибарын хэрэглээ болон төлбөрийн задаргаа.
- Өдрийн баталгаажсан борлуулалтын дүн.
- Төлбөрийн төрлөөр орж ирсэн мөнгөн дүн.
- Хүлээгдэж буй болон бодит бэлэн мөнгөний зөрүү.
- Хүлээн авсан, буцаасан, суутгасан болон буцаагаагүй барьцааны дүн.
- Өрөө цэвэрлэсэн тоо.
- Өдөр болон захиалга/байрлалт тус бүрийн шалгалтын мэдээлэл.
- Hotel Admin/Manager-д зориулсан зочин–байрлалтын pagination жагсаалт болон зөвшөөрөгдсөн баганатай Excel export.
- Зөвхөн Hotel Admin-д зориулсан өрөө, minibar, expense болон payment breakdown-ийн тусдаа financial Excel export.

## 7. Батлагдсан шийдвэр

### RC-DEC-001 — Нэгдсэн тооцооны мөчлөг

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Байрлалт бүр нэгдсэн тооцоотой байна. Өрөөний төлбөрийг эхэлж авч болох ба минибар болон бусад хэрэглээг дараа нэмнэ. Check-out үед нийт хэрэглээнээс өмнө төлсөн дүнг хасаж үлдэгдлийг тооцно.

### RC-DEC-002 — Барьцааны үндсэн шаардлага

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Manager, эсвэл 30,000₮ багцын Manager Plus барьцааны дүнг 50,000–100,000 төгрөгийн хооронд тохируулна. Hotel Admin-д тохирох operational role тусдаа шаардлагатай (DEP-DEC-008). Reception уг дүнг дур мэдэн өөрчлөхгүй. Өөрчлөлт шалтгаан/аудиттай байна. Барьцаа нь борлуулалтын орлого биш байна.

### RC-DEC-003 — Захиалгын эх үүсвэрт суурилсан барьцаа

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Шууд ирсэн зочин барьцаа төлнө. Өөрийн платформын баталгаажсан онлайн захиалгаар ирсэн зочин барьцаа төлөхгүй. Систем энэ шийдвэрийг өөрийн онлайн захиалгын бүртгэлээр автоматаар гаргана.

### RC-DEC-004 — Барьцааны төлбөр ба суутгал

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Барьцааг QPay, карт эсвэл бэлэн мөнгөөр авч, буцааж эсвэл төлбөрт суутгаж болно. Барьцаанаас суутгал хийхэд шалтгаан, нотолгоо болон тусдаа эрхийн баталгаа шаардахгүй. Систем үйлдлийн аудитын түүхийг автоматаар хадгална.

### RC-DEC-005 — Онлайн захиалгын эх үүсвэр

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Онлайн захиалгын системийг уг платформын нэг хэсэг болгон өөрсдөө хөгжүүлнэ. MVP-ийн Reception хэсэг баталгаажсан дотоод онлайн захиалгын бүртгэлийг ашиглана.

### RC-DEC-006 — Картын төлбөрийн хэлбэр

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Картын төлбөрийг банкны POS төхөөрөмжөөр авч гараар бүртгэх болон системтэй шууд холбогдсон гарцаар баталгаажуулах хэлбэрийг хоёуланг дэмжинэ.

### RC-DEC-007 — ХУР-ийн нөөц ажиллагаа

- **Төлөв:** Батлагдсан
- **Шийдвэр:** ХУР ажиллахгүй эсвэл мэдээлэл олдохгүй үед Reception овог, нэр, регистрийн дугаарыг гараар бүртгэнэ. Систем баталгаажуулалтын эх үүсвэрийг ялгаж хадгална.

### RC-DEC-008 — Цэвэрлэгээний төлөвийн эрх

- **Төлөв:** Батлагдсан
- **Шийдвэр:** 25,000₮ болон 30,000₮ багцад өрөөний цэвэрлэгээний төлөвийг зөвхөн Cleaner өөрчилнө. 20,000₮ багцад Cleaner байхгүй тул Manager өөрчилнө. Reception бүх багцад төлөвийг зөвхөн харна.

### RC-DEC-009 — Ээлж хаалтын эрх

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Ердийн горимд ээлжээс бууж буй Reception хаалтаа илгээж, ээлж авч буй Reception-ийн бодитоор хүлээн авсан дүнгээр шинэ ээлж шууд эхэлнэ. Manager/Manager Plus financial review хийж, exception үед Hotel Admin орлоно; review хүлээлт ажиллагааг зогсоохгүй. Нэг ажилтантай горимын `Өөрөө хаасан` нь operational terminal: зөрүүгүй бол review шаардахгүй, зөрүүтэй бол Hotel Admin review шаардлагатай. Шинэ ээлж эхэлсний дараа хуучин ээлж/opening balance-ийг дахин нээж overwrite хийхгүй; correction нь холбоостой шинэ хөдөлгөөн байна. Дэлгэрэнгүйг SHIFT-DEC-001–007-гоор тодорхойлсон.

### RC-DEC-010 — Cleaner dashboard ба минибарын тайлан

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Зөвхөн 25,000₮ болон 30,000₮ багцад Cleaner mobile responsive dashboard ашиглана. Check-out эхлэхэд тухайн өрөөний минибар шалгах ажил Cleaner-д харагдана. Cleaner хэрэглэсэн бүтээгдэхүүн, тоо ширхэгийг илгээх бөгөөд Reception уг мэдээлэлд үндэслэсэн минибарын төлбөрийг эцсийн тооцоонд оруулна. Эцсийн check-out-ын дараа Cleaner өрөөний цэвэрлэгээний төлөвийг удирдана.

### RC-DEC-011 — Cleaner ба minibar-ын багцын хязгаарлалт

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Cleaner role, Cleaner dashboard болон minibar-ын бүх боломж зөвхөн 25,000₮ болон 30,000₮ багцад идэвхжинэ. 20,000₮ багцад эдгээр боломж харагдахгүй, API түвшинд мөн ашиглах боломжгүй байна.

### RC-DEC-012 — Цагаар болон хоногоор байрлуулах

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Reception check-in хийх үед байрлалтыг `цагаар` эсвэл `хоногоор` сонгоно. Хоногоор байрлалтыг 24 цагаар бус, Manager-ийн буудлын хэмжээнд тохируулсан тогтсон check-out цаг болон эерэг бүхэл `N` шөнийн тоогоор тооцно. Planned checkout нь hotel-local check-in календарийн огноо + `N` өдөр, snapshot хийсэн тогтсон check-out цаг байна; check-in уг цагаас өмнө байсан ч нэг шөнө маргаашийн check-out цагт дуусна. Тухайн өдрийн check-out хүртэлх богино stay-г цагаар сонгоно. Хоногийн төлбөр `effective нэг шөнийн үнэ × N`, цагийн төлбөр `effective нэг цагийн үнэ × сонгосон цагийн тоо` байна. Сервер дараагийн booking/cleaning buffer-ийг дахин шалгаж, баталгаажсан хугацаа, үнэ болон check-out snapshot-ийг дараагийн config edit-ээр өөрчлөхгүй. Өрөөний дэлгэцэд одоогийн байрлалтын дуусах цаг, үлдсэн хугацаа болон дараагийн баталгаажсан захиалгын цагийн мэдээллийг харуулна. Систем давхардсан хугацаанд нэг өрөөг дахин захиалах эсвэл check-in хийхээс хамгаална. Early-morning cutoff энэ шийдвэрт ороогүй, түр хойшлогдсон (`STAY-DEC-007`).

### RC-DEC-013 — Хугацаа хэтрэлтийн төлбөр

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Төлөвлөсөн check-out цагаас хэтэрсэн тохиолдолд систем нэмэлт төлбөр, торгууль эсвэл хэсэг цагийн төлбөр автоматаар тооцохгүй. Өрөөг `Хугацаа хэтэрсэн` гэж Reception-д анхааруулж, бодитоор хэтэрсэн хугацааг харуулна. MVP-д extension/planned-end change action, нэмсэн цаг/хоногийн pricing болон amendment байхгүй; өрөө actual checkout хүртэл occupied хэвээр байна (`STAY-DEC-012`).

### RC-DEC-014 — Захиалгын хоорондох цэвэрлэгээний зай

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Manager буудлын үндсэн цэвэрлэгээний хамгийн бага хугацааг тохируулна. Шаардлагатай бол өрөөний ангилал бүрд өөр хугацаа тохируулж болно. Reception уг хугацааг өөрчлөхгүй. Booking/stay нь `[start, end)` interval ашиглаж, хүчинтэй cleaning buffer-ийг тухайн stay/booking-д snapshot хадгална. Future booking-ийн planning availability-д `planned checkout + snapshotted cleaning buffer`, actual checkout-оос хойших earliest readiness-д `actual checkout + ижил snapshotted cleaning buffer` ашиглана. Бодит check-in/reuse хийхэд сервер уг хугацаанд хүрсэн эсвэл өнгөрсөн, өрөөний actual cleaning state `Цэвэр`, мөн applicable minibar readiness хангагдсан эсэхийг authoritative байдлаар шалгана. Cleaning state-ийг 20,000₮ багцад Manager, 25,000₮/30,000₮ багцад Cleaner existing эрхээр өөрчилж, Reception зөвхөн харна. Early actual checkout дараагийн confirmed booking-ийг урагшлуулахгүй; late actual checkout buffer-ийг хойшлуулж, overdue fee автоматаар үүсгэхгүй (`STAY-DEC-008`).

### RC-DEC-015 — Өрөөний тусдаа төлөвүүд

- **Төлөв:** Үндсэн харагдац болон minibar нөхөн дүүргэх эрх батлагдсан
- **Шийдвэр:** Reception өрөөний карт дээр захиалгын эх үүсвэр, байрлалтын төлөв, цаг/хоногийн төрөл, хугацаа, цэвэрлэгээний төлөв, мөн боломжтой багцад minibar-ын дүүргэлт ба шалгалтын явцыг тусдаа badge-аар харна. `Walk-in` нь эх үүсвэр, `Check-in хийсэн` нь байрлалтын төлөв тул нэг өрөөнд зэрэг харагдаж болно.

### RC-DEC-016 — Cleaner-ийн минибар нөхөн дүүргэлт

- **Төлөв:** Батлагдсан
- **Шийдвэр:** 25,000₮ болон 30,000₮ багцын minibar-enabled өрөөнд Cleaner цэвэрлэх явцдаа боломжит warehouse stock-ийн lifecycle `ACTIVE` product-оос дутуу minibar-ыг нөхөж, бүтээгдэхүүн/тоог бүртгэнэ. Retiring/inactive product-ийг дараагийн stay-д зориулж нөхөхгүй; room configuration blocker-тэй байна. Нөхөлт warehouse-аас room руу атомик transfer үүсгэнэ; нөөц сөрөг болохгүй. Active configuration-ийн зорилтот тоо бүрдвэл `Бүтэн`, хүрэхгүй бол `Дутуу` байна.

### RC-DEC-017 — Өрөө шинэ зочинд бэлэн болох нөхцөл

- **Төлөв:** Батлагдсан
- **Шийдвэр:** 20,000₮ болон minibar-disabled өрөөнд check-out дууссан, actual checkout + тухайн stay-ийн snapshotted cleaning buffer хугацаа өнгөрсөн, өрөө `Цэвэр` болсон үед check-in зөвшөөрнө. Minibar-enabled өрөө ердийн үед дээрх хугацаа + `Цэвэр` + minibar `Бүтэн` байх ёстой. Minibar `Дутуу` бол зөвхөн Manager/Manager Plus-ийн дараагийн stay-д хүчинтэй шалтгаан, бодит эхний snapshot болон audit-тай shortage override-аар check-in зөвшөөрнө. `Тодорхойгүй` үед хориглоно. Planning үед actual checkout хараахан байхгүй бол planned checkout + ижил snapshot buffer ашиглана (`STAY-DEC-008`).

### RC-DEC-018 — Өрөө ба minibar category

- **Төлөв:** Батлагдсан
- **Шийдвэр:** 25,000₮/30,000₮ багцын бүх өрөөнд minibar заавал биш. Manager/Manager Plus өрөөг `Minibar ашиглана/ашиглахгүй` гэж тохируулна. Ашиглах өрөөнд нэг `ACTIVE` template entity болон бүтээгдэхүүн бүрийн immutable зорилтот тоотой exact `PUBLISHED` version заавал; ашиглахгүй өрөөнд routine guest minibar task/charge үүсэхгүй, төлөв `Хамаарахгүй` байна. OFF → ON pending change-ийн assigned reconciliation task үүнд хамаарахгүй.

### RC-DEC-019 — Restaurant бүртгэл ба хандалт

- **Төлөв:** Батлагдсан
- **Шийдвэр:** 30,000₮ багцын Manager-д нэмэгдэх Manager Plus эрхээр цайны газар/Restaurant бүртгэж, тухайн буудалтай холбогдсон идэвхтэй эсвэл идэвхгүй төлөвийг удирдана. Restaurant-д тусдаа хандалт үүсгэж өгөх бөгөөд Restaurant хэрэглэгч зөвхөн өөрийн меню, хоол/уух зүйлийн зураг, үнэ болон ангиллыг удирдана.

### RC-DEC-020 — Хоолны захиалга ба QPay баталгаажуулалт

- **Төлөв:** Батлагдсан; буцаалт/state machine нь REST-DEC-001–006-аар хаагдсан
- **Шийдвэр:** Буудалд идэвхтэй байрлаж буй зочин идэвхтэй Restaurant-аас хоол захиална. Захиалга QPay төлбөр амжилттай баталгаажсаны дараа л `Баталгаажсан` болж Restaurant-д өрөөний дугаар, бүтээгдэхүүн болон тоо ширхэгийн мэдээлэлтэй мэдэгдэнэ. Restaurant өөрийн QPay merchant дансаар мөнгөө шууд хүлээн авна. Платформ мөнгийг дамжуулан хадгалахгүй. QPay-аар тусдаа төлөгдсөн хоолны дүнг өрөө/минибарын нэгдсэн тооцоонд дахин нэмэхгүй.

### RC-DEC-021 — Restaurant-ийн QPay merchant

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Restaurant бүр өөрийн QPay merchant тохиргоотой байна. Хоолны захиалгын invoice тухайн Restaurant-ийн merchant-аар үүсэж, мөнгө Restaurant-д шууд орно. Платформ зөвхөн захиалга, invoice болон баталгаажсан төлбөрийн төлөвийг хадгална; Restaurant-ийн мөнгөнд settlement хийхгүй.

### RC-DEC-022 — Restaurant-ийн захиалга авах цагийн хуваарь

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Restaurant долоо хоногийн өдөр бүрийн захиалга авах эхлэх, дуусах цагтай байна. Захиалга авах цаг дууссан үед зочны `Захиалах` button идэвхгүй болж, Restaurant хаасан болон дараагийн нээх цагийг анхааруулж харуулна. Сервер шинэ захиалга болон QPay invoice үүсгэхийг мөн хориглоно. Өмнө төлөгдөж баталгаажсан захиалга хэвийн үргэлжилнэ.

### RC-DEC-023 — Restaurant хаалтын үеийн QPay invoice

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Restaurant хаахаас өмнө үүссэн боловч төлөгдөөгүй QPay invoice-ийн хүчинтэй хугацаа Restaurant-ийн тухайн өдрийн захиалга авах дуусах цагаас хэтрэхгүй. Хаалт/invoice expiry-ийн дараа баталгаажсан payment order-г reopen/production queue-д оруулахгүй: order/fulfillment `CANCELLED`, payment `PAID`, refund policy `MANDATORY`, request `APPROVED`, reason `PAID_AFTER_INVOICE_EXPIRY` байна. Restaurant Manager refund эхлүүлэхэд Refund `PENDING`; QPay/merchant success болоход Refund `REFUNDED` + request `RESOLVED`, алдаанд Refund `FAILED` + request `APPROVED` хэвээр байна. Payment `PAID` түүхээ хадгална (`REST-DEC-005`).

### RC-DEC-024 — Restaurant захиалгын QPay буцаалтын эрх

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Хоолны төлбөр Restaurant-ийн өөрийн QPay merchant дансанд ордог тул Restaurant Manager буцаалтыг эхлүүлнэ. Давхар баталгаа шаардахгүй. Manager Plus төлөв, дүн, түүхийг харж/link pause хийж болох ч мөнгө буцаахгүй; Hotel Admin-д энэ operational харагдац/үйлдэлд Manager Plus role тусдаа шаардлагатай. QPay/merchant success-гүйгээр Refund axis `REFUNDED` болохгүй; Payment axis `PAID` хэвээр байна (`REST-DEC-006`).

### RC-DEC-025 — Restaurant-ийн холбоо барих дугаарын харагдац

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Restaurant бүр захиалга хариуцсан холбоо барих дугаартай байна. Зочин тухайн Restaurant-д өөрийн захиалгыг үүсгэсний дараа захиалгын дэлгэрэнгүйгээс уг дугаарыг харж, шууд залгах боломжтой байна. Дугаарыг нийтэд нээлттэй Restaurant жагсаалт болон ердийн меню дээр харуулахгүй; зөвхөн өөрийн захиалгатай, баталгаажсан guest session-д сервер талын эрхийн шалгалтаар өгнө.

### RC-DEC-026 — Өрөөний QR ба нэг удаагийн guest access код

- **Төлөв:** Батлагдсан
- **Шийдвэр:** 30,000₮ багцын өрөө бүр дотроо дахин ашиглах тогтмол QR кодтой байна. QR нь өрөөний дугаар болон stay ID-г ил бичихгүй, таах боломжгүй opaque token ашиглана. Check-in бүрд 4–6 оронтой нэг удаагийн код шинээр үүсэж, зочин QR уншуулсны дараа кодоо нэг удаа оруулж тухайн `hotel + room + stay`-тай холбоотой guest session авна. Код олон удаа буруу оруулахад түр блоклоно. Check-out, Reception-ийн хүчингүй болголт эсвэл QR token солигдоход холбогдох код/session хүчингүй болно.

### RC-DEC-027 — Нэг stay-ийн олон төхөөрөмжийн guest session

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Нэг stay-д дээд тал нь 5 идэвхтэй guest session зөвшөөрнө. Reception нэмэлт төхөөрөмж бүрд тусдаа нэг удаагийн код үүсгэж өгнө. Идэвхтэй session болон хүчинтэй, ашиглагдаагүй нэмэлт кодын нийлбэр 5-аас хэтрэхгүй. Код үүсгэх болон баталгаажуулж session болгох хоёр агшинд сервер хязгаарыг дахин шалгана. Хязгаар хүрсэн үед Reception ашиглагдахгүй session-ийг эхлээд хүчингүй болгоно. Reception нэг session эсвэл тухайн stay-ийн бүх session-ийг хүчингүй болгож чадна. Check-out дуусмагц бүх session автоматаар хаагдана. Код үүсгэсэн болон session хүчингүй болгосон үйлдлийг аудитын түүхэд хадгалах боловч кодын эх утгыг log/audit-д хадгалахгүй.

### RC-DEC-028 — Дуусаагүй Restaurant захиалгатай check-out

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Төлөгдсөн боловч эцсийн төлөвт ороогүй Restaurant захиалга нь check-out-ыг хатуу хориглохгүй. Check-out эхлэхэд болон эцсийн баталгаажуулалтын өмнө систем дуусаагүй захиалгыг сервер талд шалгаж, Reception-д захиалгын дугаар, Restaurant, төлөв болон холбоо барих дугаарыг анхааруулгаар харуулна. Reception зочинд мэдэгдсэнээ баталгаажуулсны дараа check-out үргэлжилнэ. Захиалга автоматаар цуцлагдахгүй, Restaurant талд үргэлжилж, зочин check-out хийснийг Restaurant-д мэдэгдэнэ. Баталгаажуулсан Reception хэрэглэгч болон огноо/цагийг аудитын түүхэд хадгална.

### RC-DEC-029 — Check-out үеийн Restaurant захиалга хүлээн авах сонголт

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Check-out үед төлөгдсөн боловч дуусаагүй Restaurant захиалга бүрд Reception зочны хүсэлтээр `Reception дээр хүлээн авах`, `Зочин Restaurant-аас өөрөө авах`, `Цуцлалт/буцаалт хүсэх` гэсэн гурван сонголтын аль нэгийг заавал бүртгэнэ. Сонголт Restaurant dashboard-д шууд харагдана. `Цуцлалт/буцаалт хүсэх` нь захиалгыг автоматаар цуцлахгүй, төлбөрийг автоматаар буцаахгүй; Restaurant-ийн эрх бүхий хэрэглэгчийн буцаалтын урсгалыг эхлүүлэх хүсэлт болно. Сонголт бүр хэрэглэгч, огноо/цаг болон захиалгын дугаартай аудитын түүхтэй байна. Хоолны захиалгын төлбөр ямар ч сонголтын үед буудлын check-out тооцоо, барьцаа, касс болон ээлжийн орлогод орохгүй.

### RC-DEC-030 — Restaurant захиалга хүлээн авах 5/10 минутын SLA

- **Төлөв:** Батлагдсан
- **Шийдвэр:** QPay payment server-side баталгаажсан цагаас Restaurant acceptance SLA-г тоолно. 5 минутад зочин/Restaurant-д warning; 10 минутад Reception-д мэдэгдэж refund request action нээнэ. Босго өөрөө cancel/refund хийхгүй. Request commit үед accept хийгдээгүй бөгөөд deadline өнгөрсөн бол refund policy `MANDATORY`, request `APPROVED`, order/fulfillment `CANCELLED`; accept түрүүлсэн бол policy `DISCRETIONARY`, request `OPEN` байна. Row lock авсан эхний valid transition ялна (`REST-DEC-002`).

### RC-DEC-031 — Restaurant цуцлалт/буцаалтын хүсэлт шийдвэрлэх SLA

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Refund request committed цагаас шийдвэрлэх хугацааг тоолно. `MANDATORY` policy + `APPROVED` request-д Restaurant татгалзахгүй; accept эхэлж committed бол `DISCRETIONARY` policy + `OPEN` request үүсэж, Restaurant урьдчилан тодорхойлсон шалтгаанаар зөвшөөрөх/татгалзах боломжтой. 5 минутад Restaurant-д, 10 минутад Reception/Manager Plus-д мэдэгдэнэ. 30 минут unresolved бол зөвхөн тухайн Hotel–Restaurant холбоосын шинэ order-г түр хаана. Provider refund амжилттай (`Refund=REFUNDED`, request `RESOLVED`) эсвэл discretionary request `REJECTED` terminal болоход SLA pause арилна; manual inactive state өөрчлөгдөхгүй. SLA мөнгийг автоматаар шилжүүлэхгүй (`REST-DEC-002`, `REST-DEC-006`).

### RC-DEC-032 — Зочдын жагсаалт ба Excel export

- **Төлөв:** Батлагдсан; filter/export/temporary-file/retention нь GUEST-DEC-005–008-аар хаагдсан
- **Шийдвэр:** Hotel Admin, Manager болон 30,000₮-ийн Manager Plus зөвхөн өөрийн hotel-ийн үндсэн зочдын server-paginated жагсаалт/Excel-д хандана. Зургаан багана нь `Дэс дугаар`, `Овог`, `Нэр`, `Нас`, `Өрөө`, `Хугацаа`; identifier/утас/төлбөр нэмэхгүй. Нас editable биш, identity type-ээс үл хамааран баталгаажсан төрсөн огноо болон check-in өдрөөс server-side бодогдоно. Filter, 10,000 мөрийн background export, private TTL болон retention-ийг GUEST-DEC-005–008 мөрдөнө.

### RC-DEC-033 — Нэг stay-ийн бүртгэлтэй үйлчлүүлэгч

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Нэг өрөөний stay бүрд зөвхөн нэг үндсэн үйлчлүүлэгчийг бүртгэнэ. Хамт байрлаж буй бусад хүнийг тус бүрээр бүртгэхгүй бөгөөд Hotel Admin/Manager-ийн жагсаалт, Excel болон зочны тайланд тусдаа мөр болгохгүй.

### RC-DEC-034 — Үндсэн үйлчлүүлэгчийн Police match

- **Төлөв:** Батлагдсан; identity/matching ба Police state/permission нь RC-DEC-044, POL-DEC-017–022-оор хаагдсан
- **Шийдвэр:** Зөвхөн үндсэн зочны structurally valid normalized `MN_REG_NO` нь active Wanted Person/Case-тэй exact таарвал Police portal-д Match/alert үүснэ. Passport/other ID/no-document дээр fuzzy match хийхгүй. Match нь `Олдсон` биш; бодитоор илрүүлсэн дурын scope-той идэвхтэй Police хэрэглэгч өөрийн account-аар Found outcome батална. Match/Police data hotel хэрэглэгч болон зочинд харагдахгүй.

### RC-DEC-035 — Cleaner checkout exception ба minibar маргаан

- **Төлөв:** Батлагдсан
- **Шийдвэр:** 25,000₮/30,000₮ багцын minibar-enabled өрөөний ердийн checkout Cleaner-ийн хэрэглээ эсвэл `Хэрэглээгүй` тайлангүйгээр хаагдахгүй. Reception тайланг засахгүй; төлбөрөөс өмнө Cleaner-д буцааж шинэ хувилбар авна. Cleaner боломжгүй үед Manager/Manager Plus шалтгаантай онцгой тайлан үүсгэнэ. Төлбөр эхлэхэд ашигласан хувилбар түгжигдэж, төлбөрийн дараах алдааг reversal/adjustment-аар залруулна. Зочны маргааныг Manager/Manager Plus шийдтэл checkout хүлээнэ. Minibar-disabled өрөөнд энэ report үүсэхгүй.

### RC-DEC-036 — Minibar stock, cost болон shortage override

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Manager quantity нь warehouse opening stock байна. Warehouse/room balance тусдаа immutable movement-ээр хөтлөгдөж, нөөц сөрөг болохгүй. Худалдах үнэ, худалдан авалтын өртгийг тусад нь хадгалж, weighted average cost ашиглана. Waste/adjustment reason болон audit-тай. Minibar `Дутуу` өрөөг зөвхөн Manager/Manager Plus бодит эхний snapshot, шалтгаан болон audit-тайгаар дараагийн stay-д нээж болно. Дэлгэрэнгүйг INV-DEC-001–008-аар тодорхойлсон.

### RC-DEC-037 — Hotel Admin financial reporting

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Баталгаажсан борлуулалт, орж ирсэн мөнгө, авлага болон хадгалж буй deposit-ийг тусдаа хэмжинэ. Restaurant payment hotel-ийн тайланд орохгүй. Minibar gross profit нь weighted average COGS ашиглаж, inventory purchase cash-outflow болон COGS-ийг operational result-д давхар хасахгүй. Manager/Manager Plus expense хүсэлт submit хийж, Hotel Admin approved-for-payment/rejected болгоно; зөвхөн бодитоор execute хийж `Paid` болсон expense KPI/Excel/cash-outflow-д орно. Cash method active drawer movement үүсгэж, Card/POS болон bank/QPay reference-тэй боловч drawer movement үүсгэхгүй. Paid record-ийг edit/delete хийхгүй, reversal/correction ашиглана. 7 хоног, энэ сар, custom хугацаа, top-5 өрөө болон financial Excel-ийг зөвхөн Hotel Admin ашиглана. Canonical дүрэм нь FIN-DEC-001–010 болон CASH-DEC-005 байна.

### RC-DEC-038 — Cash drawer ба physical cash ledger

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel activation-д бүх багцад нэг default drawer үүсэж, Hotel Admin multiple drawer/optional safe удирдана. Анхны болон дараагийн shift actual opening snapshot ашиглаж, opening/closed shift-ийг overwrite хийхгүй. Customer cash, `PAID_CASH_EXPENSE`, top-up, linked transfer, bank/owner withdrawal болон effective-date correction нь typed immutable movement байна. Нэг drawer-д нэг active shift, нэг Reception-д нэг active drawer shift байна. Card/POS болон bank/QPay expense payment cash movement үүсгэхгүй. Transfer/top-up/withdrawal revenue/expense биш; Restaurant/QPay/Card drawer balance-д орохгүй. Дэлгэрэнгүйг CASH-DEC-001–010-аар тодорхойлсон.

### RC-DEC-039 — Minibar selling price snapshot

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Minibar-enabled check-in үед current configuration-д заасан exact template version-ийн бүх product-ийн selling price stay price book-д түгжигдэнэ. Active stay-ийн normal/exception/corrected report, payment lock болон post-payment correction ижил snapshot price ашиглана. Opening quantity `0` product-ийг Reception/Manager/Manager Plus-ийн хүсэлтээр Cleaner task-аар баримтжуулан refill хийсэн бол check-in price-аар тооцно; price book-д байгаагүй product charge болохгүй. Active stay-ийн non-guest stock-out billable quantity-гаас хасагдана. Selling price болон consumption үеийн weighted average cost тусдаа байна. Дэлгэрэнгүйг PRICE-DEC-001–008-аар тодорхойлсон.

### RC-DEC-040 — Room/minibar entity lifecycle

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Room/category/product/template entity нь `ACTIVE → RETIRING → INACTIVE` lifecycle ашиглана; template version lifecycle, Publish/Default болон Archive дүрмийг RML-DEC-015–021-д тодорхойлсон. Default, room current/pending, active stay эсвэл non-terminal task-д reference-тэй exact version archive болохгүй; historical reference хадгалагдах ч blocker биш. Archive нь operational side effect үүсгэхгүй, Archived version-ийг clone хийж шинэ Draft үүсгэж болно. Deactivation шинэ booking/check-in/assignment-ийг шууд хаах боловч active stay болон өмнө баталгаажсан future booking-г автоматаар cancel/reprice хийхгүй; future booking-г reactivate/active entity рүү шилжүүлэх/cancellation-аар шийдтэл check-in хориглоно. Minibar-enabled room-ийн template/product dependency active биш бол configuration blocker үйлчилнэ. Referenced entity hard-delete болохгүй; never-used, reference/task/stock/movement-гүй entity-д л зөвшөөрнө. Manager/Manager Plus lifecycle action удирдаж, Reception state/blocker-ийг read-only харна. Entity дүрмийг RML-DEC-001–006-аар тодорхойлсон.

### RC-DEC-041 — Room minibar configuration change

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Room нэг current configuration, хамгийн ихдээ нэг non-terminal pending mode/template change-тай байна; ON configuration бүр template entity болон exact version-ийг хамтад нь заана. Active stay current snapshot-аараа дууссаны дараа Cleaner assigned task-аар ON → OFF return, OFF → ON refill эсвэл Template A/version → Template B/version delta reconciliation хийнэ. Manager/Manager Plus request/cancel/shortage/variance/rollback шийдэж, Reception current/pending config/blocker-ийг read-only харна. Pending physical room шинэ assignment/check-in авахгүй; future booking cancel/reprice болохгүй, config booking үед pin болохгүй. Movement эхэлсний дараа immutable rollback шаардлагатай бөгөөд apply cleaning status-ийг өөрчлөхгүй. Дэлгэрэнгүйг RML-DEC-007–014 болон exact version binding-ийг RML-DEC-015–017-д тодорхойлсон.

### RC-DEC-042 — Explicit exact-version Rollout

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Эрхтэй Manager нэг hotel-ийн ижил `ACTIVE` template-тэй eligible minibar-enabled room-д өөр exact `PUBLISHED` version рүү шилжих room-level Rollout эхлүүлнэ. Confirm нь target-ийг түгжсэн pending request болон check-in/assignment blocker-ийг атомикаар үүсгэх боловч current version, stock, үнэ болон stay price book-ийг өөрчлөхгүй. Safe/vacant room-д Cleaner reconciliation task шууд үүсэж, active stay эсвэл дуусаагүй checkout/payment/minibar report/refill-тэй room `SCHEDULED_AFTER_STAY` болж safe point-д task авна. Later Publish/Default target-ийг солихгүй, pending target Archive blocker байна. Permission болон lifecycle-ийн дэлгэрэнгүйг RML-DEC-022–024-т тодорхойлсон.

### RC-DEC-043 — Multi-room Rollout batch

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Нэг exact target version, нэг hotel/template-ийн олон room бүхий batch parent болон room бүрийн тусдаа child request ашиглана. Preview side effect-гүйгээр room-ийг одоо хийх/scheduled/ineligible гэж ангилна. Confirm room бүрийг дахин шалгаж partial success хэрэглэнэ: accepted child pending request + blocker-оо атомикаар авч, invalid child `SKIPPED` болно. Child failure бусдыг rollback хийхгүй; batch төлөв child-үүдээс автоматаар бодогдоно. `Cancel remaining` нь movement-free child-ийг unblock хийж, movement эхэлснийг existing rollback урсгалд оруулан, `APPLIED` room-ийг хэвээр үлдээнэ. Retry нь `retry_of_batch_id`-тай шинэ batch байна. Exact target pin, Archive blocker, idempotency/concurrency/tenant guard болон package-role gate-ийг RML-DEC-025–028-д тодорхойлсон. Ингэснээр P0-37 бүрэн хаагдсан.

### RC-DEC-044 — Монгол/гадаад/баримтгүй үндсэн зочны identity

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Үндсэн зочин `MN_REG_NO`, `FOREIGN_PASSPORT`, `OTHER_GOV_ID`, `NO_DOCUMENT` identity type-ийн нэгтэй байна. Бүх төрөлд нэр, төрсөн огноо, nationality, provenance; төрөлд тохирох identifier эсвэл no-document reason хадгална. 18-аас доош үндсэн зочинд guardian metadata шаардлагатай боловч guardian тусдаа stay/Excel мөр болохгүй. Нас server-side DOB-оос тооцогдоно. Police automatic matching зөвхөн structurally valid normalized Монгол РД дээр exact ажиллаж, бусад төрөлд fuzzy match хийхгүй. Raw identifier encrypted, lookup keyed token-той, correction append-only revision байна; шинэ valid РД revision батлагдвал matching дахин ажиллана.

## 8. Хаагдсан canonical scope

P0-37, P0-38, P0-39A–D болон primary guest identity P0-40 бүрэн хаагдсан. `STAY-DEC-008`–`014`, `RC-DEC-044`-ийг мөрдөнө. Confirmed booking/active stay-ийн planned end amendment/extension/shortening/conversion MVP-д байхгүй; early/late actual checkout existing checkout урсгалаар явагдана. Early-morning cutoff түр хойшлогдсон. Guest registry filter/export/retention-ийг [12-hotel-guest-registry-report.md](./12-hotel-guest-registry-report.md)-ийн `GUEST-DEC-005`–`008` тодорхойлно.

## 9. Барьцааны төрлийг хамгаалах дүрэм

Барьцааг зориудаар алгасах эрсдэлээс хамгаалахын тулд дараах урсгалыг санал болгож байна:

1. Check-in эхлэхэд систем хүчинтэй, баталгаажсан онлайн захиалга байгаа эсэхийг шалгана.
2. Баталгаажсан захиалга олдвол байрлалтыг `ONLINE` эх үүсвэртэй үүсгэж, барьцааг `шаардахгүй` гэж автоматаар тогтооно.
3. Баталгаажсан захиалга олдохгүй бол байрлалтыг `WALK_IN` гэж үүсгэж, тохируулсан барьцааг автоматаар тооцно.
4. Reception хэрэглэгч `ONLINE/WALK_IN` төлөв болон барьцааны шаардлагыг гараар солихгүй.
5. Initial check-in баталгаажихаас өмнө source/exemption алдааг зөвхөн Manager, эсвэл 30,000₮ багцын Manager Plus mandatory reason-тэй засна. Hotel Admin хийх бол Manager/Manager Plus operational role тусдаа авна. Баталгаажуулалт эсвэл мөнгөн хөдөлгөөний дараа direct edit хийхгүй; reversal/refund/correction lifecycle ашиглана (`DEP-DEC-008`).

## 10. Дараагийн боловсруулах хэсэг

Ээлж хаах, батлах болон хүлээлцэх ажиллагааг [03-reception-shift-handover.md](./03-reception-shift-handover.md) баримт бичигт тусад нь боловсруулна.

Cleaner dashboard болон ердийн minibar шалгах ажиллагааг [04-cleaner-dashboard.md](./04-cleaner-dashboard.md)-д, checkout exception, report correction/payment lock болон маргааныг [21-cleaner-checkout-exception-and-dispute.md](./21-cleaner-checkout-exception-and-dispute.md)-д тодорхойлно.

Цагаар/хоногоор байрлалт болон өрөөний цагийн төлөвийг [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md) баримт бичигт тусад нь боловсруулна.

Room тарифын Walk-in/Online шатлал, planned checkout, interval/readiness, initial actual check-in, immutable actual-time correction, planned-checkout direct-overwrite хамгаалалт болон MVP planned-end no-change дүрмийг [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md)-ийн `STAY-DEC-005`–`STAY-DEC-012`-д тодорхойлно.

Reception-д харагдах өрөөний бүх төлөвийг [06-room-status-model.md](./06-room-status-model.md) баримт бичигт нэгтгэнэ.

Manager-ийн өрөө/minibar тохиргоог [07-manager-room-minibar.md](./07-manager-room-minibar.md)-д, warehouse/room stock, weighted average cost, optional minibar болон shortage override-ийг [22-minibar-stock-inventory.md](./22-minibar-stock-inventory.md)-д тодорхойлно.

Minibar check-in price book, active stay-ийн locked selling price болон report/refill/correction-ийн price source-ийг [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md)-д canonical байдлаар тодорхойлно.

Hotel Admin-ийн санхүүгийн KPI, expense lifecycle, top-5 room, график болон financial Excel-ийг [23-admin-financial-reporting.md](./23-admin-financial-reporting.md)-д canonical байдлаар тодорхойлно.

Default/multiple drawer, optional safe, cash expense execution, transfer/withdrawal/top-up болон physical correction-ийг [24-cash-drawer-ledger.md](./24-cash-drawer-ledger.md)-д canonical байдлаар тодорхойлно.

Restaurant бүртгэл, меню, зочны захиалга болон QPay урсгалыг [08-restaurant-ordering.md](./08-restaurant-ordering.md) баримт бичигт боловсруулна.

Нийтийн буудал хайлт, e-Mongolia/утасны бүртгэл, online booking төлбөр болон hotel settlement-ийг [09-online-booking-system.md](./09-online-booking-system.md) баримт бичигт боловсруулна.

Hotel Admin/Manager-ийн зочдын pagination жагсаалт, Excel export болон хувийн мэдээллийн хамгаалалтыг [12-hotel-guest-registry-report.md](./12-hotel-guest-registry-report.md) баримт бичигт боловсруулна.

Эрэн сурвалжлах бүртгэл, Police account, match, alert, dashboard болон Excel export-ийг [13-police-monitoring-system.md](./13-police-monitoring-system.md) баримт бичигт боловсруулна.
