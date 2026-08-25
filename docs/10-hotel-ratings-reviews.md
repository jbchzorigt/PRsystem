# Hotel Rating & Review — Үнэлгээ ба сэтгэгдэл

**Хувилбар:** 1.0  
**Төлөв:** MVP verified-stay review, input/edit/soft-delete, authenticated report, Platform moderation/restore болон нэг official hotel reply бүрэн батлагдсан  
**Хамаарах үе шат:** MVP — Online Booking

## 1. Зорилго

Нэвтэрсэн хэрэглэгч сонгосон буудалдаа үнэлгээ болон сэтгэгдэл үлдээж, бусад хэрэглэгч буудлын дундаж үнэлгээ болон нийтлэгдсэн сэтгэгдлүүдийг харах боломж бүрдүүлнэ.

## 2. Батлагдсан үндсэн шаардлага

- Үнэлгээ, сэтгэгдэл илгээхийн тулд хэрэглэгч нэвтэрсэн байна.
- Нэвтрээгүй хэрэглэгч үнэлгээ, сэтгэгдлийг харах боломжтой байна.
- Review үүсгэх эрхийг browser-ийн харагдацаар бус сервер талд authenticated account-аар шалгана.
- Review нь account, hotel болон үүсгэсэн огноо/цагтай холбогдоно.
- Буудал өөрт таалагдаагүй үнэлгээг шууд засах эсвэл устгах эрхгүй байна.

## 3. Батлагдсан verified-stay дүрэм

Зөвхөн нэвтэрсэн байх нь spam, хуурамч эерэг үнэлгээ болон өрсөлдөгчийн сөрөг үнэлгээнээс хангалттай хамгаалахгүй. MVP-д дараах батлагдсан дүрмийг хэрэглэнэ:

```text
Account = Нэвтэрсэн
Booking owner/booker = Тухайн account
Booking status = Дууссан / Check-out хийсэн
Review for booking = Өмнө үүсээгүй
```

- Нэг completed booking-ээр нэг review үүсгэнэ.
- Нэг хэрэглэгч дахин бодитоор байрласан бол шинэ completed booking-ээр дахин review өгч болно.
- Цуцлагдсан, no-show, төлбөргүй эсвэл зөвхөн хайж үзсэн хэрэглэгч review өгөхгүй.
- Review дээр `Баталгаажсан байрлалт` тэмдэглэгээ харагдана.
- e-Mongolia account эсвэл phone account гэдгээс үл хамааран completed booking/stay холбоосоор эрхийг шалгана.

Review eligibility-г client-ийн илгээсэн booking status-аар бус сервер талын booking/account холбоос болон бодит төлвөөр шалгана.

## 4. Review үүсгэх урсгал

1. Хэрэглэгч `Миний захиалга` хэсгээс дууссан booking-ээ нээнэ.
2. `Үнэлгээ, сэтгэгдэл үлдээх` үйлдэл сонгоно.
3. Систем authenticated account, booking owner, hotel, booking status болон өмнөх review-г сервер талд шалгана.
4. Хэрэглэгч үнэлгээ болон сэтгэгдлээ оруулна.
5. Илгээхийн өмнө систем утга, урт болон аюултай content-ийг шалгана.
6. Review нийтлэгдэж, буудлын дундаж үнэлгээ болон review count шинэчлэгдэнэ.

Нэвтрээгүй хэрэглэгч review товч дарахад login/register урсгал руу орж, амжилттай нэвтэрсний дараа эхэлсэн hotel/booking дэлгэцдээ буцна.

## 5. Батлагдсан review input

- `rating`: 1–5 бүхэл од, заавал; бутархай утга зөвшөөрөхгүй;
- `comment`: эхлэл/төгсгөлийн хоосон зайг хассаны дараа 10–1000 тэмдэгт, заавал;
- `hotel_id`;
- `booking_id`;
- `account_id`;
- `display_name_snapshot`: олон нийтэд харуулах масклагдсан нэр;
- `status`: `Нийтлэгдсэн`, `Нуусан`, `Устгасан`;
- `created_at`, `updated_at`.

Review өгөх хугацааг тухайн booking-ийн бодит `actual_checkout_at` цагаас тоолж, 30 хоногийн дараа хаана. Хугацааг серверийн цагаар шалгаж, хэрэглэгчийн timezone-д ойлгомжтой харуулна.

- Form-ийг хугацаа дуусахаас өмнө нээсэн боловч дараа нь илгээсэн бол сервер deadline-ийг илгээх агшинд дахин шалгана.
- Зөвхөн зай, мөр шилжилтээс бүрдэх comment-ийг хоосон гэж үзнэ.
- Rating болон comment-ийн шалгалтыг зөвхөн UI дээр бус API/server түвшинд хийнэ.
- Client-ийн илгээсэн `actual_checkout_at`, deadline болон booking status-д итгэхгүй.

## 6. Харагдац ба тооцоолол

Буудлын жагсаалт болон дэлгэрэнгүйд:

- нийтлэгдсэн review-үүдийн дундаж үнэлгээ;
- нийт үнэлгээний тоо;
- үнэлгээ бүрийн од, сэтгэгдэл, масклагдсан нэр, огноо;
- `Баталгаажсан байрлалт` тэмдэглэгээ

харагдана.

Дундаж үнэлгээнд зөвхөн `Нийтлэгдсэн` төлөвтэй review орно. Дундаж болон тоог client өөрөө бодохгүй, серверийн баталгаажсан aggregate ашиглана. Review нуусан эсвэл сэргээсэн үед aggregate-г найдвартай дахин тооцно.

## 7. Засвар, устгал ба moderation

### 7.1 Батлагдсан хэрэглэгчийн засвар ба устгал

- Хэрэглэгч зөвхөн өөрийн review-г засна.
- Rating/comment-ийн засварыг бодит check-out-оос хойших 30 хоногийн review deadline хүртэл зөвшөөрнө.
- Засвар илгээх агшинд owner, deadline, rating болон comment-ийн дүрмийг сервер дахин шалгана.
- Засварласан review дээр `Засварласан` тэмдэглэгээ болон хамгийн сүүлийн шинэчилсэн огноо харагдана.
- Өмнөх rating/comment-ийг аудитын түүхэд хадгална.
- Хэрэглэгч өөрийн review-г 30 хоног өнгөрсөн эсэхээс үл хамааран хүссэн үедээ устгаж болно.
- Устгахын өмнө `Энэ booking-ээр дахин шинэ review үүсгэх боломжгүй` гэсэн анхааруулга харуулж, хэрэглэгчээс баталгаажуулна.
- Устгал нь soft-delete байна: review-г нийтийн жагсаалт, review count болон дундаж үнэлгээнээс хасах боловч database/audit-аас шууд hard-delete хийхгүй.
- Soft-delete хийсэн review-г ижил booking-ээр шинэ review болгон дахин үүсгэхгүй.
- Устгал хийсэн account, огноо/цаг болон review ID аудитын түүхтэй байна.

### 7.2 Authenticated Guest report

- Online Booking realm-ийн дурын authenticated Guest account нийтлэгдсэн review-г report хийж болно. Completed stay, hotel membership, hotel staff role болон subscription package шаардахгүй. Hotel staff өөрийн тусдаа Guest account/session-аар орсон бол бусад Guest-тэй ижил ердийн report урсгал ашиглана; staff/Operation/Police role дангаараа report эсвэл moderation эрх биш.
- Report нь review-г автоматаар нуух, aggregate-аас хасах, хэрэглэгчийн content-ийг засах эсвэл устгах үйлдэл биш.
- Report reason нь `PERSONAL_DATA`, `ABUSE_ILLEGAL`, `SPAM_FRAUD`, `OTHER`-ын аль нэг байна. `OTHER` үед trim хийсний дараа 10–500 тэмдэгтийн тайлбар заавал байна.
- Нэг `account_id + review_id` дээр хамгийн ихдээ нэг open report байна; давтан submit duplicate report үүсгэхгүй.
- Report submit/resolve бүр report хийсэн account, hotel, review, reason/note, server time болон шийдвэртэй аудитын түүхтэй байна.

### 7.3 Platform moderation ба restore

- Review report queue харах, review нуух, сэргээх болон report шийдвэрлэх эрх нь зөвхөн Platform realm-ийн explicit `REVIEW_MODERATE` permission-тэй нэрлэсэн account-д байна.
- `Platform Super Admin`, `Operation Admin` эсвэл өөр Platform role гэсэн нэр дангаараа moderation эрх үүсгэхгүй.
- Moderator зөвхөн батлагдсан report reason болон заавал moderation note-тойгоор `Нийтлэгдсэн → Нуусан` transition хийнэ. Сөрөг rating/comment дангаараа нуух шалтгаан биш.
- `Нуусан` review нийтийн жагсаалт, review count болон дундаж үнэлгээнд орохгүй боловч content, owner, booking холбоос болон аудитын түүхээс устахгүй.
- Explicit `REVIEW_MODERATE` permission-тэй moderator заавал restore reason оруулж `Нуусан → Нийтлэгдсэн` transition хийж болно. Restore хийхэд aggregate-г сервер найдвартай дахин тооцно.
- Owner-ийн soft-delete хийсэн `Устгасан` review-г moderation restore хийхгүй. Moderator review-г hard-delete хийхгүй, owner-ийн rating/comment-ийг засахгүй.
- Hide/restore/report resolution бүр idempotent, concurrency-safe бөгөөд actor, permission, reason/note, өмнөх/шинэ төлөв, server time-тай append-only audit байна.

### 7.4 Нэг official hotel reply

- Hotel Admin болон Manager өөрийн hotel-ийн `Нийтлэгдсэн` review-д 20,000₮/25,000₮/30,000₮ багцад нэг official reply бичиж болно. Manager Plus нь зөвхөн энэ role үүсэх боломжтой 30,000₮ багцад ижил эрхтэй; reply feature өөрөө нэмэлт package gate-гүй.
- Нэг review-д нэг reply record байна; database/server түвшинд `review_id` unique байна. Өөр hotel-ийн review-д reply хийхгүй.
- Reply trim хийсний дараа 10–1000 тэмдэгт байна. HTML/script-ийг шууд render хийхгүй, хувийн booking/identity мэдээлэл нийтлэхгүй.
- Reply дээр hotel-ийн нийтэд харагдах нэр, `Буудлын албан ёсны хариу`, үүсгэсэн/шинэчилсэн огноо болон засварласан бол `Засварласан` тэмдэглэгээ харагдана. Staff-ийн хувийн email/утсыг нийтэд харуулахгүй.
- Эрх бүхий Hotel Admin/Manager/Manager Plus reply-г засаж эсвэл soft-delete хийж болно. Soft-delete хийсний дараа шинэ хоёр дахь record үүсгэхгүй; ижил record-ийг эрхийн шалгалттайгаар сэргээж болно.
- Review `Нуусан` эсвэл owner-оор `Устгасан` үед холбоотой reply-г нийтэд харуулахгүй, шинэ reply/create/edit хийхгүй. Review restore хийгдвэл soft-delete хийгдээгүй existing reply дахин харагдана.
- Reply create/edit/soft-delete/restore бүр actor, hotel, review, өмнөх/шинэ content, төлөв болон server time-тай аудитын түүхтэй байна.

## 8. Аюулгүй байдал ба privacy

- Review илгээх, засах, report хийх болон official reply өөрчлөх хүсэлтийг account/IP түвшинд rate limit хийнэ.
- Comment-ийг HTML/script хэлбэрээр шууд render хийхгүй; аюултай content-ийг цэвэрлэнэ.
- Нийтийн review дээр регистр, бүтэн утас, имэйл, room number болон booking ID харуулахгүй.
- Account эзэмшигч зөвхөн өөрийн review-г өөрчилнө; hotel/account ID-г client-ээс ирсэн утгаар шууд итгэхгүй.
- Нэг booking-ээр давхар review үүсэхээс database/server түвшинд хамгаална.
- Үүсгэсэн, зассан, устгасан, report хийсэн/шийдвэрлэсэн, нуусан, сэргээсэн болон official reply өөрчилсөн үйлдэл бүр аудитын түүхтэй байна.

## 9. MVP acceptance criteria

- Нэвтрээгүй хэрэглэгч review илгээж чадахгүй.
- Нэвтэрсэн хэрэглэгч үнэлгээ болон сэтгэгдлийн form нээж чадна.
- Completed booking-гүй хэрэглэгч review илгээж чадахгүй.
- Нэг completed booking-ээр нэгээс олон review үүсэхгүй.
- Rating нь зөвхөн 1, 2, 3, 4 эсвэл 5 байна.
- Comment заавал бөгөөд trim хийсний дараа 10–1000 тэмдэгт байна.
- Бодит check-out цагаас 30 хоног өнгөрсөн бол review илгээхгүй.
- Review owner 30 хоногийн deadline хүртэл rating/comment-оо засаж чадна.
- 30 хоног өнгөрсний дараа rating/comment засахгүй боловч owner review-г soft-delete хийж чадна.
- Soft-delete хийсэн review дундаж үнэлгээ болон review count-д орохгүй.
- Soft-delete хийсний дараа ижил booking-ээр шинэ review үүсэхгүй.
- Зөвшөөрөгдсөн review нийтийн hotel дэлгэрэнгүйд харагдана.
- Буудлын дундаж үнэлгээ болон review count зөв шинэчлэгдэнэ.
- Хэрэглэгч бусдын review-г засахгүй.
- Hotel Manager хэрэглэгчийн review-г шууд засах эсвэл устгахгүй.
- Review дээр хувийн booking/identity мэдээлэл нийтэд харагдахгүй.
- Дурын authenticated Guest account нийтлэгдсэн review-г report хийж болох боловч нэг account/review дээр нэг open report байна, report нь review-г автоматаар нуухгүй.
- Зөвхөн explicit `REVIEW_MODERATE` permission-тэй Platform account review-г reason/note-той нууж, сэргээж, report шийдвэрлэнэ.
- Нуусан review aggregate-аас хасагдаж, сэргээхэд дахин орно; owner soft-delete хийсэн review-г moderator сэргээхгүй.
- Hotel Admin болон Manager өөрийн hotel-ийн нийтлэгдсэн review-д бүх багцад, Manager Plus зөвхөн 30,000₮ багцад нэг 10–1000 тэмдэгтийн official reply үүсгэж/засаж/soft-delete хийж чадна.
- Нэг review-д хоёр official reply record үүсэхгүй; hidden/deleted review-ийн reply нийтэд харагдахгүй.

## 10. Одоогоор бүртгэсэн шийдвэр

### RV-DEC-001 — Нэвтэрсэн хэрэглэгчийн review

- **Төлөв:** Захиалагчийн өгсөн шаардлага
- **Шийдвэр:** Зөвхөн нэвтэрсэн хэрэглэгч буудалд үнэлгээ болон сэтгэгдэл үлдээнэ. Нэвтрээгүй хэрэглэгч review үүсгэхгүй.

### RV-DEC-002 — Verified-stay review eligibility

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Тухайн буудлын `Дууссан/Check-out хийсэн` online booking-тэй нэвтэрсэн account нэг booking-ээр нэг удаа review өгнө. Цуцлагдсан, no-show, төлбөргүй болон check-out хийгдээгүй booking review эрх үүсгэхгүй.

### RV-DEC-003 — Rating, comment ба review хугацаа

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Rating нь 1–5 бүхэл од байна. Comment заавал бөгөөд trim хийсний дараа 10–1000 тэмдэгт байна. Review-г тухайн booking-ийн бодит check-out цагаас хойш 30 хоногийн дотор илгээнэ. Бүх нөхцөлийг сервер илгээх агшинд шалгана.

### RV-DEC-004 — Review засвар ба soft-delete

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Review owner бодит check-out-оос хойших 30 хоногийн цонх хаагдах хүртэл rating/comment-оо засаж болно. Өөрийн review-г хүссэн үедээ soft-delete хийж болох бөгөөд нийтэд харагдахгүй, aggregate-д орохгүй. Soft-delete хийсний дараа ижил booking-ээр шинэ review үүсгэхгүй. Засвар болон устгалын түүхийг аудитад хадгална.

### RV-DEC-005 — Authenticated report ба Platform moderation

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Online Booking realm-ийн дурын authenticated Guest account нийтлэгдсэн review-г батлагдсан reason-оор report хийж болно; completed stay, hotel role болон package шаардахгүй, нэг account/review дээр нэг open report байна, `OTHER` тайлбар 10–500 тэмдэгт. Report review-г автоматаар нуухгүй. Зөвхөн explicit `REVIEW_MODERATE` permission-тэй Platform account report queue-г шийдвэрлэж, reason/note-той review нуух эрхтэй. Hotel/Operation/Police/Platform role-ийн нэр дангаараа report эсвэл moderation permission үүсгэхгүй.

### RV-DEC-006 — Нуусан review restore

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Explicit `REVIEW_MODERATE` permission-тэй Platform moderator заавал restore reason-тойгоор зөвхөн `Нуусан` review-г `Нийтлэгдсэн` төлөвт сэргээж, aggregate-г дахин тооцно. Owner soft-delete хийсэн review-г moderation restore хийхгүй. Hide/restore нь append-only аудиттай байна.

### RV-DEC-007 — Нэг official hotel reply

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel Admin болон Manager өөрийн hotel-ийн нийтлэгдсэн review-д 20,000₮/25,000₮/30,000₮ багцад, Manager Plus зөвхөн 30,000₮ багцад нэг 10–1000 тэмдэгтийн official reply үүсгэж, засаж, soft-delete/restore хийж болно. Нэг review-д нэг reply record байна; хэрэглэгчийн review-г өөрчлөхгүй. Засвар `Засварласан` тэмдэглэгээтэй, бүх lifecycle аудиттай байна. Review hidden/deleted үед reply нийтэд харагдахгүй.

## 11. Хаагдсан төлөв

Review-ийн P0-18 moderation, restore болон official hotel reply `RV-DEC-005`–`RV-DEC-007`-оор хаагдсан. Нийтийн display-name masking-ийн нарийн UX, notification суваг болон moderation/report retention нь P1 configuration/retention ажлаар үргэлжилнэ.
