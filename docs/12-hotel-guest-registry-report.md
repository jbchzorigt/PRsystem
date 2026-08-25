# Hotel Guest Registry — Admin/Manager жагсаалт ба Excel export

**Хувилбар:** 1.0  
**Төлөв:** MVP guest registry-ийн бүх багцын эрх, filter/pagination, DOB-based age, 10,000 мөрийн background Excel, private temporary download болон 365 хоногийн product retention батлагдсан  
**Хамаарах үе шат:** MVP — Hotel Admin/Manager

## 1. Зорилго

Тухайн зочид буудлын бүртгэлтэй зочдын байрлалтын мэдээллийг Hotel Admin болон Manager өдөр тутмын ажиллагаа, дотоод тайлангийн зорилгоор хуудаслаж харах, зөвшөөрөгдсөн мэдээллээр Excel файл татах боломжийг тодорхойлно.

## 2. Эрх ба өгөгдлийн хамрах хүрээ

- **Hotel Admin:** Өөрийн буудлын зочин–байрлалтын жагсаалтыг харах, Excel татах эрхтэй.
- **Manager:** Өөрийн буудлын зочин–байрлалтын жагсаалтыг харах, Excel татах эрхтэй.
- **Manager Plus:** Зөвхөн энэ role үүсэх боломжтой 30,000₮ багцад өөрийн буудлын зочин–байрлалтын жагсаалтыг харах, Excel татах эрхтэй.
- **Reception:** Check-in/check-out хийхэд шаардлагатай тухайн зочны мэдээллийг харна; энэ бөөн жагсаалт болон Excel export эрхийг автоматаар авахгүй.
- **Cleaner, Restaurant:** Жагсаалт болон export-д хандахгүй.
- Нэг буудлын Admin/Manager өөр буудлын өгөгдлийг ID солих, URL өөрчлөх, API шууд дуудах ямар ч хэлбэрээр харахгүй.
- Platform Admin-д бүх буудлын зочдын мэдээллийг автоматаар нээлттэй болгохгүй. MVP-д support bulk access байхгүй; ирээдүйн тусгай хандлага нь тусдаа хууль ёсны үндэслэл, хугацаатай permission болон аудиттай change request байна.

Guest registry жагсаалт болон export нь feature-ийн хувьд **20,000₮/25,000₮/30,000₮ бүх багцад** нээлттэй: Hotel Admin болон Manager бүх багцад, Manager Plus зөвхөн role нь зөвшөөрөгдсөн 30,000₮ багцад ашиглана.

## 3. Нэг мөрийн утга

Жагсаалтын нэг мөр нь **нэг stay-д бүртгэсэн нэг үндсэн үйлчлүүлэгч** байна.

- Нэг зочин өөр хугацаанд дахин байрлавал тусдаа мөр үүснэ.
- Нэг өрөөний stay бүрд зөвхөн нэг үндсэн үйлчлүүлэгчийг бүртгэнэ.
- Үндсэн үйлчлүүлэгчтэй хамт байрлаж буй бусад хүнийг системд тус бүрээр бүртгэхгүй, жагсаалт болон Excel-д тусдаа мөр болгохгүй.
- Цагдаагийн matching мөн зөвхөн энэ бүртгэлтэй үндсэн үйлчлүүлэгчийн регистр дээр ажиллана; бүртгэгдээгүй хамт байрлагчдыг match хийх боломжгүй.
- Check-in хийгдээгүй, цуцлагдсан эсвэл no-show болсон online booking хэрэглэгчийг буудалд бодитоор үйлчлүүлсэн зочны жагсаалтад оруулахгүй.
- Stay initial confirmation амжилттай болж immutable `actual_check_in_at` болон `check_in_recorded_at` үүссэний дараа л зочны мөр жагсаалт/Excel-д орно.

## 4. Pagination жагсаалт

- Pagination-ийг зөвхөн browser дээр бүх мэдээллийг ачаалаад хуваахгүй; сервер/database түвшинд хийнэ.
- Нийт мөрийн тоо, одоогийн хуудас, нийт хуудас, өмнөх/дараагийн хуудасны үйлдэл харагдана.
- Үр дүнгийн дараалал хуудас солих үед давхцах эсвэл алгасахгүй тогтвортой байна.
- Анхны дарааллыг latest approved `effective_actual_check_in_at` буурахаар, ижил цагтай үед дотоод давтагдашгүй ID-аар тогтооно. Approved amendment байхгүй бол original immutable `actual_check_in_at` effective утга байна. Audit/recording time болох `check_in_recorded_at`-аар зочны байрласан хугацааг орлуулахгүй.
- Нэг хуудсанд харуулах default хэмжээ **20**, зөвшөөрөгдсөн сонголт `20 / 50 / 100` байна. Client өөр page size илгээсэн ч сервер зөвшөөрөгдсөн утгаас бусдыг хүлээн авахгүй.

## 5. Батлагдсан баганууд

| № | Багана | Дэлгэц болон Excel-ийн утга |
| --- | --- | --- |
| 1 | **Дэс дугаар** | Одоогийн шүүлтүүр, эрэмбийн нийт үр дүн дэх дараалал; database ID биш. Дараагийн page дээр дугаар үргэлжилнэ. |
| 2 | **Овог** | Check-in үед баталгаажсан эсвэл гараар бүртгэсэн овог. |
| 3 | **Нэр** | Check-in үед баталгаажсан эсвэл гараар бүртгэсэн нэр. |
| 4 | **Нас** | `effective_actual_check_in_at`-ийн hotel-local огноонд тухайн identity-ийн баталгаажсан/бүртгэсэн төрсөн огнооноос серверийн тооцсон бүхэл насны snapshot; identity type-ээс үл хамаарна, насыг гараар чөлөөт текстээр оруулахгүй. |
| 5 | **Өрөө** | Тухайн байрлалтад ашигласан өрөөний дугаар/нэр. Түүхэн тайланд stay дээр хадгалсан snapshot ашиглана. |
| 6 | **Хугацаа** | Check-in болон check-out огноо/цагийн интервал. Эхлэл нь latest approved `effective_actual_check_in_at`; amendment байхгүй бол original `actual_check_in_at`. Идэвхтэй stay-д effective actual check-in–төлөвлөсөн check-out, дууссан stay-д effective actual check-in–бодит check-out харуулна. Original/recorded цаг энэ баганад давхар орохгүй. |

Регистрийн дугаар, утас, имэйл, гэрийн хаяг, төлбөр, барьцаа, иргэний мэдээллийн эх сурвалж болон бусад талбарыг жагсаалт/Excel-д автоматаар нэмэхгүй. Нэмэх шаардлага гарвал зорилго, эрх, хууль зүйн үндэслэлийг тусад нь батална.

### 5.1 Actual check-in timestamp-ийн эх сурвалж

- Default `actual_check_in_at` нь initial confirmation-ийн server time. Reception зөвхөн confirmation-оос өмнө `STAY-DEC-009`-ийн 120 минут, current open shift, hotel local day болон online booking байвал planned start-ын хязгаарт reason code-той past time сонгож болно.
- `check_in_recorded_at` нь initial confirmation бодитоор серверт бүртгэгдсэн immutable цаг бөгөөд Police matching/alert болон audit timing-д хэрэглэгдэнэ; зочны stay эхэлсэн цагийн оронд жагсаалт/Excel-д харуулахгүй.
- Backdate historical readiness болон overlap validation-д тэнцээгүй бол stay идэвхжихгүй, guest registry мөр үүсэхгүй. Server-now check-in амжилттай болсны дараа л мөр үүснэ.
- Activation-оос хойш Reception original `actual_check_in_at`-ийг direct edit хийхгүй. Correction нь зөвхөн P0-39B-2 / `STAY-DEC-010` immutable amendment-аар effective actual time үүсгэнэ; original time audit-д хэвээр байна.
- Тариф, room/minibar configuration, price/opening snapshot болон payment/cash time-ийг report гаргахдаа past actual time руу буцаан зохиохгүй; stay/payment дээр recorded-at/current-shift байдлаар хадгалсан authoritative snapshot/reference-ийг ашиглана.

### 5.2 Approved correction ба effective actual time

- P0-39B-2 correction нь original `actual_check_in_at`/`check_in_recorded_at`-ийг overwrite хийхгүй. Manager-approved immutable amendment байвал жагсаалт болон шинээр үүсгэх Excel latest approved `effective_actual_check_in_at`-ийг duration эхлэл, filter болон sort-д ашиглана.
- Pending эсвэл rejected request нь registry/Excel-ийн effective time-ийг өөрчлөхгүй. Нэг pending request stay-ийн checkout initiation-ийг блоклох боловч шинэ guest мөр үүсгэхгүй.
- Reception ACTIVE stay/checkout эхлээгүй үед corrected time + mandatory reason submit хийнэ; Manager approve/reject хийнэ. Hotel Admin болон Manager Plus-д Manager role тусдаа, Reception+Manager self-approval нь `self_approved` audit-тай байна.
- Approved correction зөвхөн effective actual start-ийг өөрчилнө. Planned checkout, hours/nights, stay type, room/minibar price, deposit/payment/cash shift, config/stock snapshot болон Police original Match/alert/detected timestamps report/export-д өөрчлөгдөхгүй.
- Original time, fixed original-recorded-at bound, request/decision, requester/approver болон Police audit link хадгалагдана. Excel-д original/correction audit-ийг шинэ нууц баганаар автоматаар нэмэхгүй (`STAY-DEC-010`).

### 5.3 Active хугацааны immutable planned end

- Confirmed booking болон `ACTIVE` stay-ийн `planned_checkout_at`/effective planned end-ийг MVP-д аль ч role/UI/API өөрчлөхгүй. `STAY-DEC-011` direct-overwrite guard хэвээр; `STAY-DEC-012`-оор amendment, change action/button/API, extension, planned-end shorten/lengthen болон hourly ↔ nightly conversion байхгүй.
- Иймээс MVP-д planned-end amendment эсвэл effective planned-end projection үүсэхгүй. Active stay-ийн `Хугацаа` баганын төгсгөл нь confirmation үед хадгалсан immutable original `planned_checkout_at` байна.
- Зочин эрт/орой бодитоор checkout хийвэл `actual_checkout_at` бодит төгсгөлийг хадгална. Stay дууссаны дараа жагсаалт/Excel-ийн `Хугацаа` багана existing дүрмээр effective actual check-in–actual checkout-ийг харуулах бөгөөд original planned checkout audit-д хэвээр үлдэнэ.
- Early actual checkout automatic reprice/refund, overdue automatic fee/penalty үүсгэхгүй; price/payment/cash/config/stock snapshot өөрчлөгдөхгүй. Энэ report шинэ financial багана нэмэхгүй.
- Room actual checkout хүртэл occupied хэвээр; дараа нь P0-39A-ийн snapshotted buffer + actual cleaning + applicable minibar readiness gate үйлчилнэ. Overdue-next-booking conflict `STAY-DEC-013`-ын hard blocker/reassignment/hotel-cancellation урсгалаар шийдэгдэнэ.
- STAY-DEC-011-ийн immutable-amendment invariant нь ирээдүйн post-MVP дахин хэлэлцүүлэгт л хамаарна; одоогийн MVP-д amendment үүсгэх зөвшөөрөл биш. Booking cancellation/no-show тусдаа scope бөгөөд check-in хийгдээгүй booking guest registry-д орохгүй гэсэн existing дүрэм хэвээр.

## 6. Насны тооцоолол

Насны canonical эх үүсвэр нь check-in үед тухайн үндсэн зочны identity record-д хадгалсан **төрсөн огноо (`date_of_birth`)** байна. Монгол регистртэй зочинд төрсөн огноог хүчинтэй регистр/XYP мэдээллээс гаргаж баталгаажуулж болно; passport, foreign ID болон бусад гараар бүртгэсэн identity-д батлагдсан check-in form-ийн төрсөн огноог ашиглана. Ямар ч Hotel role насны тоог гараар оруулах/засахгүй.

```text
Age at check-in = effective_actual_check_in_at-ийн hotel-local огноонд гүйцсэн бүтэн жилийн тоо
```

- Тооцооллыг browser/Excel formula-аар бус, нэг ижил баталгаажсан серверийн дүрмээр check-in үед snapshot хийнэ. Дараа жагсаалт харах эсвэл Excel татах огнооноос болж түүхэн нас өөрчлөгдөхгүй.
- Төрсөн огноо байхгүй, хүчинтэй бус эсвэл утга эргэлзээтэй бол нас таахгүй; `Тодорхойгүй` гэж харуулж identity мэдээллийг шалгах анхааруулга өгнө.
- Төрсөн огнооны source болон ХУР/XYP-ээр баталгаажсан эсвэл гараар бүртгэсэн эсэхийг ялгаж хадгална.
- Төрсөн огноог Excel-д тусдаа баганаар оруулахгүй.

## 7. Excel export

- Файл `.xlsx` хэлбэртэй байна.
- Excel нь дэлгэцийн батлагдсан зургаан баганы нэр, дарааллыг ижил ашиглана.
- Export нь зөвхөн одоогийн нэг page-ийг бус, хэрэглэгчийн сонгосон шүүлтүүр болон эрэмбэд тохирсон бүх үр дүнг агуулна.
- Export бүр background job байна. Төлөв нь `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `EXPIRED` байна.
- Нэг export хамгийн ихдээ **10,000 мөр** байна. Filter snapshot-ийн нийт үр дүн 10,000-аас их бол partial/truncated файл үүсгэхгүй, job-г эхлүүлэхгүй бөгөөд filter-ээ нарийсгах мэдээлэл өгнө.
- Job үүсгэх болон файл татах бүрд хэрэглэгчийн role, active hotel membership, subscription gate болон `hotel_id` scope-ийг сервер дахин шалгана.
- Export файл private temporary storage-д хадгалагдаж, файл бэлэн болсон server time-оос хойш **1 цагийн TTL**-тэй байна. TTL дуусмагц файл устаж job `EXPIRED` болно.
- Татах signed URL **5 минут** хүчинтэй, нийтэд нээлттэй/тогтмол URL биш байна. Эрх хэвээр бөгөөд file TTL дуусаагүй бол хэрэглэгч шинэ 5 минутын URL авч болно; URL шинэчлэх нь файлын 1 цагийн TTL-г сунгахгүй.
- Export бүрд хүсэлт гаргасан хэрэглэгч, буудал, огноо/цаг, ашигласан шүүлтүүр, мөрийн тоо, амжилт/алдааны төлөвийг аудитын түүхэд хадгална.
- Файлын нэрэнд зочны овог, нэр, регистр зэрэг хувийн мэдээлэл оруулахгүй.

## 8. Батлагдсан шүүлтүүр

Жагсаалт болон Excel ижил server-side filter contract ашиглана:

- effective actual check-in огнооны эхлэх/дуусах интервал;
- stay төлөв: `Идэвхтэй` эсвэл `Дууссан`;
- өрөө;
- овог/нэрийн хайлт.

- Огнооны интервал заавал байна. Default нь hotel local timezone-аар одоогийн өдрийг оролцуулсан сүүлийн **30 календарь өдөр** байна; хамгийн урт интервал product retention-ийн одоогийн 365 хоногоос хэтрэхгүй.
- Овог/нэрийн хайлтыг trim хийж, том/жижиг үсгээс үл хамаарах partial match-аар сервер талд гүйцэтгэнэ. Raw хайлтын утгыг URL analytics болон ердийн application log-д бичихгүй.
- Filter өөрчлөгдвөл page `1` рүү буцна. Export job filter, sort, timezone болон policy version-ийн immutable snapshot ашиглана.

## 9. Хувийн мэдээллийн хамгаалалт

- Зочдын жагсаалт болон Excel нь нийтийн мэдээлэл биш байна.
- Browser дээр button нууснаар хязгаарлахгүй; role, hotel ownership болон export эрхийг сервер талд шалгана.
- Буудал хоорондын бүх query, count болон export нь `hotel_id`-гаар тусгаарлагдана.
- Зочны жагсаалт, дэлгэрэнгүй болон export хандалтад шаардлагатай аудитын мөр хадгална.
- Excel private temporary file 1 цагийн TTL дуусмагц устах бөгөөд job/audit metadata нь guest raw content-ийг дахин хуулж хадгалахгүй.
- MVP product retention default нь completed stay-ийн `actual_checkout_at`-аас хойш **365 хоног** байна. Active stay-д retention countdown эхлэхгүй.
- Checkout үед хэрэглэсэн `retention_policy_version`, `retention_days` болон `retention_expires_at`-ийг snapshot хадгална. Policy дараа өөрчлөгдсөнөөр өмнөх мөрийн хугацааг чимээгүй өөрчлөхгүй; бичгээр батлагдсан policy retroactive хэрэгжинэ гэж заасан үед л reason/audit-тай дахин тооцно.
- Хууль ёсны `legal hold` нь заасан guest/stay/scope-ийн устгал/танигдах боломжгүй болголтыг түр зогсооно. Hold нь reason, authority/reference, actor, starts/ends-at болон audit-тай; хугацаа дуусах/цуцлагдахад retention job дахин шалгана.
- 365 хоног дуусч хүчинтэй legal hold байхгүй бол guest registry-ийн raw identity/profile талбарыг батлагдсан deletion/anonymization job-оор product access-аас арилгана. Financial/audit event-ийн зайлшгүй non-identity reference өөрийн тусдаа retention policy-г дагана.
- Production-д хууль, гэрээ эсвэл ЦЕГ-ын бичгээр баталсан retention өөр хугацаа шаардвал хамгаалагдсан configuration-ийн шинэ version default 365 хоногийг override хийнэ. Owner, legal basis, effective date, retroactive эсэх болон deletion/anonymization арга заавал байна.
- Хувийн мэдээллийг анх цуглуулсан зорилгоос өөрөөр ашиглах, бусдад дамжуулах бол тусдаа хууль ёсны үндэслэл/зөвшөөрөл шаардагдана.

## 10. MVP acceptance criteria

- Hotel Admin болон Manager бүх багцад, Manager Plus зөвхөн 30,000₮ багцад өөрийн буудлын бүртгэлтэй зочин–байрлалтын мөрүүдийг page-аар харна.
- Өөр буудлын record ID ашигласан хүсэлт мэдээлэл буцаахгүй.
- Дэс дугаар page хооронд зөв үргэлжилнэ.
- Default page size 20 бөгөөд зөвхөн 20/50/100 сонголт хүлээн авна.
- Жагсаалт болон Excel-д `Дэс дугаар`, `Овог`, `Нэр`, `Нас`, `Өрөө`, `Хугацаа` ижил дарааллаар байна.
- Excel нь идэвхтэй шүүлтүүрийн бүх үр дүнг агуулж, pagination-ийн зөвхөн нэг хуудсаар хязгаарлагдахгүй.
- Filter-д effective check-in огнооны интервал заавал, default сүүлийн 30 хоног байна; stay төлөв, room болон овог/нэрийн filter server-side ажиллана.
- Export background job 10,000-аас олон мөртэй partial файл үүсгэхгүй.
- Completed export private storage-д 1 цаг хадгалагдаж, signed download URL 5 минут хүчинтэй байна.
- Регистрийн дугаар болон зөвшөөрөгдөөгүй нэмэлт мэдээлэл жагсаалт/Excel-д гарахгүй.
- Export бүр эрхийн шалгалттай, аудитын бүртгэлтэй байна.
- Identity type-ээс үл хамааран нас `date_of_birth` болон effective actual check-in-ийн hotel-local огнооноос сервер талд snapshot болж, DOB байхгүй/буруу үед нас таахгүй.
- Completed stay-ийн raw guest registry data actual checkout-оос 365 хоногийн policy snapshot-тай; legal hold deletion-г зогсоож, production legal/ЦЕГ-ийн versioned policy default-ийг override хийж болно.
- Confirmed booking/`ACTIVE` stay-ийн planned/effective end-ийг MVP-д amendment/action/button/API-аар өөрчлөх боломжгүй; active registry/Excel original planned checkout-ийг ашиглана.
- Early/late actual checkout бодит `actual_checkout_at`-ийг completed хугацааны төгсгөл болгон харуулж original planned checkout-ийг өөрчлөхгүй; early automatic refund/reprice, overdue automatic fee/penalty үүсэхгүй.
- Cleaner, Restaurant болон зөвхөн Reception эрхтэй хэрэглэгч bulk жагсаалт/Excel export-д хандахгүй.

## 11. Батлагдсан шийдвэр

### GUEST-DEC-001 — Admin/Manager guest registry

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Тухайн буудлын Hotel Admin болон Manager 20,000₮/25,000₮/30,000₮ багцад, Manager Plus зөвхөн 30,000₮ багцад өөрийн буудлын бүртгэлтэй зочдын байрлалтын мэдээллийг pagination-аар харж, Excel файл татна.

### GUEST-DEC-002 — Эхний зургаан багана

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Жагсаалт болон Excel-ийн эхний баганууд `Дэс дугаар`, `Овог`, `Нэр`, `Нас`, `Өрөө`, `Хугацаа` байна.

### GUEST-DEC-003 — Насны эх үүсвэр

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Identity type-ээс үл хамааран насыг тухайн зочны identity record-д баталгаажуулж/бүртгэсэн `date_of_birth` болон `effective_actual_check_in_at`-ийн hotel-local огнооноос сервер автоматаар тооцож snapshot хадгална. Монгол регистр/XYP, passport, foreign ID болон гараар бүртгэсэн identity бүгд ижил DOB-based дүрэмтэй; насны утгыг хэрэглэгч гараар оруулахгүй, тайлан татсан өдрөөр дахин насжуулахгүй, DOB хүчинтэй бус бол нас таахгүй.

### GUEST-DEC-004 — Зөвхөн үндсэн үйлчлүүлэгч бүртгэх

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Нэг өрөөний stay бүрд зөвхөн нэг үндсэн үйлчлүүлэгчийг бүртгэнэ. Хамт байрлагчдыг тус бүрээр бүртгэхгүй бөгөөд жагсаалт/Excel-д оруулахгүй.

### GUEST-DEC-005 — Filter ба pagination

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Guest registry server-side pagination-тай; default 20, зөвшөөрөгдсөн page size 20/50/100 байна. Effective actual check-in огнооны интервал заавал бөгөөд default сүүлийн 30 календарь өдөр, product retention-ээс урт интервал сонгохгүй. Stay төлөв, room болон case-insensitive partial овог/нэрийн filter-ийг хослуулж, filter өөрчлөгдөхөд эхний page рүү буцна.

### GUEST-DEC-006 — 10,000 мөрийн background Excel

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Excel export бүр filter/sort/policy snapshot-тай background job байна. Нэг job хамгийн ихдээ 10,000 мөр үүсгэнэ; түүнээс олон үр дүнд partial файл үүсгэхгүй, filter нарийсгахыг шаардана. Job create/download бүр role, membership, subscription болон hotel scope-ийг дахин шалгаж аудитлана.

### GUEST-DEC-007 — Private temporary export

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Completed Excel private temporary storage-д бэлэн болсон цагаас 1 цаг хадгалагдана. Signed download URL 5 минут хүчинтэй; эрх хэвээр, file TTL дуусаагүй үед шинэ URL авч болох ч file TTL сунгахгүй. TTL дуусмагц файл устаж job `EXPIRED` болно.

### GUEST-DEC-008 — Product retention ба legal hold

- **Төлөв:** Батлагдсан
- **Шийдвэр:** MVP product default retention нь completed stay-ийн `actual_checkout_at`-аас 365 хоног; active stay-д countdown эхлэхгүй. Checkout үед policy version/days/expiry snapshot хадгална. Хүчинтэй legal hold deletion/anonymization-ийг зогсооно. Production-д хууль, гэрээ эсвэл ЦЕГ-ын бичгээр баталсан versioned policy owner/legal basis/effective/retroactive нөхцөлтэйгөөр 365 хоногийн default-ийг override хийж болно.

## 12. Хаагдсан төлөв

Guest registry-ийн P0-19/P0-30 filter, pagination, export cap/job, private temporary file болон product retention `GUEST-DEC-005`–`GUEST-DEC-008`-аар хаагдсан. Stay timestamp/planned-end/overdue-conflict хамгаалалтыг `STAY-DEC-009`–`STAY-DEC-013` мөрдөнө. Production retention/legal hold/ЦЕГ override-ийн бодит legal basis болон owner нь external gate хэвээр байна.

## 13. External verification note

Монгол Улсын Хүний хувийн мэдээлэл хамгаалах тухай хуульд мэдээлэл цуглуулах, боловсруулах, ашиглах зорилго, мэдээллийн жагсаалт, ашиглах хугацаа болон бусдад дамжуулах эсэхийг мэдээллийн эзэнд танилцуулах шаардлагууд туссан. Иймээс зочдын жагсаалт, Excel export, хадгалалтын хугацаа болон ЦЕГ/бусад талд дамжуулах урсгалын хууль зүйн үндэслэлийг production-оос өмнө тусад нь баталгаажуулна: [Хүний хувийн мэдээлэл хамгаалах тухай хууль](https://legalinfo.mn/mn/detail?lawId=16390288615991).
