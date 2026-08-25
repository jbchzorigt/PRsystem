# Operation Dashboard — Буудал, багц, хугацаа ба SMS сануулга

**Хувилбар:** 1.1  
**Төлөв:** MVP dashboard, KPI/filter, explicit Operation permission, subscription/contact lifecycle, account recovery, manual-only SMS болон onboarding application/provisioning recovery батлагдсан; CallPro production specification external gate хэвээр  
**Хамаарах үе шат:** MVP — Platform Operations

## 1. Зорилго

Платформын эрх бүхий Operation хэрэглэгч систем ашиглаж буй буудлууд, сонгосон үйлчилгээний багц болон систем ашиглах эрхийн дуусах хугацааг нэг dashboard-оос хянаж, хугацааны сануулгыг SMS-ээр илгээнэ.

Энэ dashboard нь Hotel Admin, Manager болон Police portal-аас тусдаа платформын дотоод удирдлагын хэсэг байна.

## 2. Operation role ба тусгаарлалт

MVP-д `Operation Admin` гэсэн платформын дотоод role болон action бүрийн explicit permission ашиглана.

- Системд бүртгэлтэй бүх буудлын subscription-ийн зөвшөөрөгдсөн мэдээллийг харна.
- Буудлын зочин, регистр, өрөөний идэвхтэй stay, Police Match, эрэн сурвалжлах бүртгэл болон хэргийн мэдээллийг харахгүй.
- `OPERATION_READ` permission-тэй бол KPI, subscription жагсаалт болон SMS түүхийг маскласан хүрээнд харна.
- `SUBSCRIPTION_REMINDER_SEND` permission-тэй бол SMS draft/preview үүсгэж, гараар баталгаажуулан илгээнэ.
- Тусгай `SUBSCRIPTION_PASSWORD_RESET_INITIATE` эрхтэй бол subscription-ийн үндсэн account-д password reset хүсэлт эхлүүлнэ; нууц үг, reset token/кодыг харах эсвэл өмнөөс нь тохируулахгүй.
- `ONBOARDING_PROVISION_RETRY` permission-тэй бол зөвхөн төлбөр нь баталгаажсан `PROVISIONING_FAILED` application-ийн ижил immutable provisioning job-ийг дахин ажиллуулна; application/payment/package/owner/term-ийг засахгүй.
- `SUBSCRIPTION_EBARIMT_RETRY` permission-тэй бол subscription payment-ийн eBarimt retry/email delivery task-ийг ажиллуулна; payment/receipt amount болон recipient email-ийг өөрчлөхгүй.
- Hotel Admin/Manager/Reception/Cleaner/Restaurant болон Police хэрэглэгч Operation Dashboard-д хандахгүй.
- Operation хэрэглэгч бүр тусдаа нэрлэсэн account ашиглана; shared account зөвшөөрөхгүй.
- Operation account/permission үүсгэх, өөрчлөх, түдгэлзүүлэхийг зөвхөн `PLATFORM_OPERATION_ACCESS_MANAGE` permission-тэй Platform Super Admin хийнэ.
- `Operation Admin` эсвэл `Platform Super Admin` role-ийн нэр дангаараа дээрх data/action эрхийг нээхгүй; API бүр explicit permission шалгана.
- Operation хэрэглэгч password + TOTP эсвэл батлагдсан SSO/MFA ашиглана. Session idle 30 минут, absolute 8 цаг; SMS send, password-reset initiate, provisioning/eBarimt retry, paid reconciliation, subscription suspend/reactivate болон contact/recovery exception approve хийхэд сүүлийн 10 минутын step-up MFA шаардана.
- Account suspension, password reset эсвэл permission өөрчлөлтөд тухайн account-ийн бүх session/token-ийг нэн даруй revoke хийж auth epoch нэмнэ.

### 2.1 Subscription account-ийн нууц үг сэргээхэд туслах

Энэ урсгал нь тухайн буудлын subscription-д бүртгэлтэй үндсэн Hotel Admin/эзэмшигчийн account-д хамаарна. Hotel-ийн staff account-ийн reset-ийг hotel-ийн өөрийн эрхийн удирдлагын урсгалаар шийднэ.

1. Хэрэглэгч password reset тусламж хүснэ.
2. `SUBSCRIPTION_PASSWORD_RESET_INITIATE` эрхтэй Operation хэрэглэгч буудал болон үндсэн subscription account-ийг сонгоно.
3. Систем бүртгэлтэй email-ийг зөвхөн маскласан хэлбэрээр харуулна.
4. Operation хэрэглэгч `Нууц үг сэргээх хүсэлт илгээх` үйлдлийг баталгаажуулна.
5. Систем богино хугацаатай, нэг удаагийн reset холбоос/кодыг зөвхөн өмнө бүртгэлтэй email рүү илгээнэ.
6. Operation хэрэглэгч зөвхөн `Илгээгдсэн` эсвэл `Илгээхэд алдаа гарсан` үр дүн харна; холбоос, код болон шинэ нууц үгийг харахгүй.
7. Хэрэглэгч холбоос/кодоор өөрийгөө баталгаажуулж шинэ нууц үгээ өөрөө тохируулна.
8. Амжилттай сольсны дараа өмнөх бүх идэвхтэй session болон ашиглагдаагүй reset token/code хүчингүй болно.

Хамгаалалтын дүрэм:

- Operation хэрэглэгч одоогийн нууц үгийг харах, буцааж сэргээх, temporary/permanent нууц үг зохиох болон хэрэглэгчийн өмнөөс reset form бөглөхгүй.
- Reset холбоос/код нэг удаагийн, богино хугацаатай, оролдлого болон дахин илгээх rate limit-тэй байна. Бодит хугацаа/оролдлогын тоог authentication policy-той хамт батална.
- Password reset нь subscription төлөв, багц, хугацаа, hotel ownership болон account-ийн suspension-ийг өөрчлөхгүй.
- Operation Dashboard-оос бүртгэлтэй email-ийг энэ урсгалын үеэр засах эсвэл шинэ email рүү reset явуулахгүй.
- Бүртгэлтэй email-д хандах боломжгүй бол Operation хэрэглэгч password reset-ийг өөр сувгаар тойрч гарахгүй; тусдаа identity recovery урсгалд шилжүүлнэ.
- Хүсэлт эхлүүлсэн Operation хэрэглэгч, hotel/account ID, огноо/цаг, хүргэлтийн masked destination, үр дүн болон хэрэглэгч reset-ээ амжилттай дуусгасан эсэхийг аудитад хадгална.
- Нууц үг, reset token/code болон email-ийн бүтэн утгыг audit, application log, analytics болон URL query-д хадгалахгүй.
- CallPro reminder SMS сувгийг password reset-д ашиглахгүй; батлагдсан email суваг хэвээр байна.

### 2.2 Бүртгэлтэй email-д хандах боломжгүй account recovery

- Operation хэрэглэгч subscription account-ийн бүртгэлтэй email-ийг солих, өөр email рүү reset холбоос/код явуулах болон баталгаажуулалтыг тойрч гарах эрхгүй байна.
- Operation Dashboard-ийн MVP-д email ownership/identity recovery хийх form болон email солих endpoint үүсгэхгүй.
- Operation хэрэглэгч зөвхөн support хүсэлтийг бүртгэж Platform Super Admin-ийн тусдаа офлайн recovery журам руу шилжүүлнэ.
- Зөвхөн `ACCOUNT_OWNERSHIP_RECOVERY_APPROVE` permission-тэй Platform Super Admin recent step-up MFA, case reference болон mandatory reason-тэйгээр гэрээ, буудлын эзэмшигч/эрх бүхий төлөөлөгчийн мэдээллийг батлагдсан дотоод журмаар шалгасны дараа recovery-г шийднэ.
- Офлайн шалгалтад яг ямар баримт, хэдэн баталгаажуулагч, хуучин/шинэ email-д ямар мэдэгдэл өгөхийг production support/security журмаар тусад нь батална; Operation хэрэглэгч дур мэдэн шийдэхгүй.
- Recovery хүсэлт, шилжүүлсэн Operation хэрэглэгч, hotel/account ID, огноо/цаг, шийдвэрлэсэн Super Admin болон үр дүнг аудитад хадгална. Баталгаажуулах баримтын эмзэг агуулгыг ердийн application log-д бичихгүй.

### 2.3 Subscription contact утас өөрчлөх

- Нэг subscription нэг current contact revision болон хамгийн ихдээ нэг non-terminal change request-тэй байна.
- Primary Hotel Admin recent authentication/MFA-тайгаар шинэ дугаар оруулна. Систем хуучин болон шинэ дугаарт тус бүр 6 оронтой, 5 минутын нэг удаагийн OTP илгээж, **хоёуланг** баталгаажуулсны дараа current contact-ийг атомикаар солино.
- OTP resend 60 секунд, нэг code-д 5 оролдлого, account/phone/IP rate limit-тэй; шинэ code өмнөхийг хүчингүй болгоно. Code-ийг plaintext хадгалахгүй.
- Operation Admin contact утгыг шууд засах, OTP харах/дамжуулах эсвэл нэг талын баталгаажуулалтыг алгасахгүй; зөвхөн support request бүртгэнэ.
- Хуучин дугаарт хандах боломжгүй бол `SUBSCRIPTION_CONTACT_CHANGE_APPROVE` permission-тэй Platform Super Admin бичгээр батлагдсан owner/offline recovery reference, mandatory reason болон recent MFA-тай exception approve хийнэ. Шинэ дугаарын OTP заавал хэвээр; бүртгэлтэй email болон хуучин дугаарт өөрчлөлтийн мэдэгдэл явуулна.
- Change request, хуучин/шинэ masked утас, verification event, requester/approver, reason/reference, before/after revision болон server time append-only audit-тай байна. SMS send job аль хэдийн үүссэн бол recipient snapshot өөрчлөгдөхгүй; дараагийн job шинэ current contact ашиглана.

### 2.4 Operation action permission

| Үйлдэл | Operation Admin | Platform Super Admin |
| --- | ---: | ---: |
| KPI/subscription/SMS history харах | `OPERATION_READ` | `OPERATION_READ` тусдаа |
| Reminder SMS илгээх | `SUBSCRIPTION_REMINDER_SEND` | `SUBSCRIPTION_REMINDER_SEND` тусдаа |
| Hotel Admin reset эхлүүлэх | `SUBSCRIPTION_PASSWORD_RESET_INITIATE` | `SUBSCRIPTION_PASSWORD_RESET_INITIATE` тусдаа |
| Failed paid onboarding provisioning retry | `ONBOARDING_PROVISION_RETRY` | `ONBOARDING_PROVISION_RETRY` тусдаа |
| Subscription eBarimt retry/email delivery | `SUBSCRIPTION_EBARIMT_RETRY` | `SUBSCRIPTION_EBARIMT_RETRY` тусдаа |
| Stale/duplicate paid billing reconciliation харах/хаах | `SUBSCRIPTION_PAYMENT_RECONCILE` | `SUBSCRIPTION_PAYMENT_RECONCILE` тусдаа |
| Subscription suspend/reactivate | — | `SUBSCRIPTION_SUSPEND` |
| Contact offline exception approve | — | `SUBSCRIPTION_CONTACT_CHANGE_APPROVE` |
| Email ownership offline recovery approve | — | `ACCOUNT_OWNERSHIP_RECOVERY_APPROVE` |
| Operation account/permission удирдах | — | `PLATFORM_OPERATION_ACCESS_MANAGE` |

## 3. Dashboard-ийн үндсэн харагдац

### 3.1 Canonical KPI карт ба filter

KPI-г `Asia/Ulaanbaatar` серверийн нэг `as_of` мөчөөр бодно. `Нийт буудал` нь зөвхөн `PROVISIONED` Hotel/Subscription бөгөөд дараах mutually-exclusive current status картуудын нийлбэр байна:

- `Идэвхтэй`: suspended биш, `expires_at - as_of > 168 цаг`;
- `Удахгүй дуусна`: suspended биш, `0 < expires_at - as_of <= 168 цаг`;
- `Grace period`: suspended биш, `expires_at <= as_of < expires_at + 48 цаг`;
- `Дууссан`: suspended биш, `as_of >= expires_at + 48 цаг`;
- `Түдгэлзсэн`: active suspension override-тэй бүх provisioned hotel; detail-д suspension-гүй байсан үеийн underlying time status давхар харагдана.

`Идэвхжээгүй` нь total hotel/status-ийн хэсэг биш. Энэ нь зөвхөн paid боловч provision дуусаагүй §3.4 application-ийн тусдаа count бөгөөд card дарахад onboarding queue нээгдэнэ.

- `20,000₮`/`25,000₮`/`30,000₮` package карт нь бүх provisioned hotel-ийн **одоогийн хэрэгжсэн** package-ийг тоолно; pending upgrade дараагийн service month-д apply болтол target package-д орохгүй. Гурван package count-ийн нийлбэр `Нийт буудал`-тай тэнцэнэ.
- `Нийт буудал` card жагсаалтын status filter-ийг цэвэрлэнэ; status card тухайн exact current status, package card тухайн exact package filter тавина. Бусад идэвхтэй filter хэвээр үлдэж, page 1 рүү буцна.
- SMS-ийн `Илгээсэн`, `Хүрсэн`, `Амжилтгүй` карт нь current hotel-local calendar month-д үүссэн recipient-message бүрийн latest mutually-exclusive delivery state-ийг тоолно. Card дарахад SMS tab тухайн сарын огноо + exact status filter-тэй нээгдэнэ; send job бус recipient message нь тооллогын нэгж байна.

### 3.2 Буудлын subscription жагсаалт

Жагсаалт серверийн pagination-тай байна. Батлагдсан баганууд:

1. Дэс дугаар;
2. Буудлын нэр;
3. Бүртгэлийн төрөл: `Байгууллага` эсвэл `Хувь хүн`;
4. Дүүрэг/хаяг;
5. Subscription contact утас;
6. Бүртгэлтэй email — маскласан хэлбэрээр;
7. Сонгосон багц: `20,000₮`, `25,000₮`, `30,000₮`;
8. Сонгосон хугацаа: `1`, `3`, `7`, `12` сар;
9. Эрх эхэлсэн огноо/цаг;
10. Эрх дуусах огноо/цаг;
11. Үлдсэн хоног;
12. Subscription төлөв;
13. Үйлдэл: `Дэлгэрэнгүй`, `SMS илгээх`, `Password reset`.

- `Password reset` үйлдэл зөвхөн `SUBSCRIPTION_PASSWORD_RESET_INITIATE` эрхтэй Operation хэрэглэгчид идэвхтэй байна.
- `SMS илгээх` нь тухайн буудлыг recipient draft-д нэмээд SMS preview урсгал руу оруулна; шууд илгээхгүй.
- Email-ийг жагсаалт болон дэлгэрэнгүйд маскласан хэвээр харуулна. Password reset үр дүнгээр бүтэн email задруулахгүй.
- Default эрэмбэ нь `expires_at` өсөх дарааллаар буюу хугацаа хамгийн түрүүнд дуусах буудлыг эхэнд харуулна. Ижил `expires_at`-тай бол буудлын нэрээр тогтвортой эрэмбэлнэ.

### 3.3 Filter ба хайлт

- Буудлын нэр — хэсэгчилсэн, том/жижиг үсгээс үл хамаарах хайлт;
- Subscription contact утас — стандарт форматад оруулсан exact хайлт;
- Бүртгэлтэй email — зайг цэвэрлэж, том/жижиг үсгээс үл хамаарах exact хайлт; үр дүнд email масклагдсан хэвээр байна;
- Бүртгэлийн төрөл — `Байгууллага` эсвэл `Хувь хүн`;
- Дүүрэг;
- Багц — `20,000₮`, `25,000₮`, `30,000₮`;
- Сонгосон хугацаа — `1`, `3`, `7`, `12` сар;
- Subscription төлөв;
- Дуусах огнооны эхлэх/дуусах интервал.

- Filter-үүдийг хооронд нь хослуулж хэрэглэнэ; сонгосон бүх нөхцөлийг хангах үр дүн гарна.
- Хайлт/filter болон pagination-ийг сервер талд гүйцэтгэнэ. Бүх буудлын жагсаалтыг browser руу татаж client талд шүүхгүй.
- Filter өөрчлөгдөх бүрд жагсаалт эхний page рүү буцна.
- `Цэвэрлэх` үйлдэл бүх filter/search утгыг авч, батлагдсан default эрэмбэ болох эрх дуусах огноо хамгийн ойр буудлыг эхэнд харуулна.
- Exact утас/email хайлтын оролдлого болон үр дүнг эрх бүхий хэрэглэгчтэй нь аудитад хадгална; хайлтын raw утгыг ердийн analytics/application log-д бичихгүй.

### 3.4 Onboarding application queue-ийн тусгаарлалт

- Төлбөр баталгаажаагүй onboarding application нь `Hotel` эсвэл `Subscription` entity биш; hotel жагсаалт, нийт буудлын KPI, package KPI болон public listing-д орохгүй.
- `DRAFT`, `OWNER_VERIFICATION_REQUIRED`, `PENDING_PAYMENT`, `PAYMENT_UNCERTAIN`, `PAYMENT_FAILED`, `PAYMENT_EXPIRED` application-ийг зөвхөн тусдаа onboarding application queue-д харуулна.
- Төлбөр баталгаажсан боловч provisioning/owner verification дуусаагүй `PAID_PENDING_PROVISIONING`, `PROVISIONING`, `PROVISIONING_FAILED`, `PAID_OWNER_VERIFICATION_REQUIRED` application-ийг энэ queue-д `Идэвхжээгүй` гэж бүлэглэнэ.
- `PROVISIONED` болсон мөчөөс Hotel болон Subscription canonical жагсаалт/KPI-д орно. Нэг application-ийг application болон hotel KPI-д зэрэг тоолохгүй.
- Зөвхөн `ONBOARDING_PROVISION_RETRY` permission + recent step-up MFA-тай Operation хэрэглэгч `PROVISIONING_FAILED` application дээр manual retry хийнэ. Retry нь payment/package/owner/term мэдээллийг засахгүй; application row/revision болон idempotency key-ээр ижил provisioning job-ийг дахин ажиллуулна (`ONB-DEC-006`, `ONB-DEC-007`).

## 4. Subscription хугацаа ба төлөв

Эрх дуусах хугацааг сервер талд тооцож, бүх дэлгэцэд нэг ижил дүрэм хэрэглэнэ. Subscription жагсаалтад зөвхөн `PROVISIONED` hotel орж, дараах derived төлөвийг ашиглана:

| Төлөв | Утга |
| --- | --- |
| `Идэвхтэй` | Эрх эхэлсэн, дуусахад 7 хоногоос их хугацаа үлдсэн |
| `Удахгүй дуусна` | Эрх дуусахад 7 буюу түүнээс цөөн хоног үлдсэн боловч дуусаагүй |
| `Grace period` | `expires_at` болсон боловч 48 цагийн grace дуусаагүй; бүх package эрх хэвийн |
| `Дууссан` | 48 цагийн grace period дууссан бөгөөд renewal төлбөр баталгаажаагүй |
| `Түдгэлзсэн` | Эрх бүхий Platform хэрэглэгч журмын дагуу түр хаасан |

`Идэвхжээгүй` нь subscription төлөв биш. Энэ нь зөвхөн §3.4-ийн төлбөр баталгаажсан боловч provisioning/owner verification дуусаагүй application-ийн UI бүлэглэл байна. Төлбөргүй application-ийг `Идэвхжээгүй буудал` гэж тоолохгүй.

- `Inactive` гэдэг тусдаа subscription төлөв MVP-д байхгүй. `Идэвхжээгүй` application grouping болон `Түдгэлзсэн` access override-ийг subscription time status-тай холихгүй.
- Үлдсэн хоногийг Operation Dashboard үзэх мөчид `max(0, ceil((expires_at - server_now) / 24 цаг))` гэж тооцно. Grace үед `0 хоног` болон grace дуусах хүртэлх цагийг тусад нь харуулна.
- Улаанбаатарын цагийн бүс (`Asia/Ulaanbaatar`)-ийг бизнесийн огноо/цагийн үндсэн бүс болгоно.
- Subscription-ийн төлбөр баталгаатай эх үүсвэрээр `Амжилттай` болсон огноо/цагийг `starts_at` болгоно. Зөвхөн хэрэглэгчийн browser буцаж ирсэн үйлдлээр төлбөр баталгаажсан гэж үзэхгүй.
- `expires_at`-ийг `starts_at` дээр сонгосон `1`, `3`, `7`, `12` календарь сарыг нэмж тооцно. Огнооны цаг/минут/секундыг хадгална.
- Зорилтот сард эхэлсэн өдрийн дугаар байхгүй бол тухайн сарын сүүлийн өдрийг ижил цагт сонгоно. Жишээ нь 1 дүгээр сарын 31-нд эхэлсэн 1 сарын эрх 2 дугаар сарын сүүлийн өдөр ижил цагт дуусна.
- Төлбөрийн webhook/status query давтан ирэхэд нэг төлбөрөөр subscription-ийг дахин эхлүүлэхгүй idempotency хамгаалалттай байна.
- Subscription хугацаа дуусаагүй байхад сунгалтын төлбөр амжилттай баталгаажвал сонгосон календарь саруудыг одоогийн `expires_at`-ээс үргэлжлүүлэн нэмнэ. Үлдсэн хугацааг алдагдуулахгүй.
- Subscription-ийн `expires_at`-аас хойших 48 цагийн grace period дотор renewal төлбөр амжилттай баталгаажвал сонгосон саруудыг анхны `expires_at`-ээс үргэлжлүүлэн нэмнэ.
- Grace period дууссаны дараа renewal төлбөр амжилттай баталгаажвал шинэ `starts_at` нь тухайн төлбөр баталгаажсан мөч болж, сонгосон саруудыг түүнээс нэмнэ.
- Нэг renewal payment-ийг давтан callback/status query боловсруулахад хугацааг дахин нэмэхгүй; payment ID болон renewal transaction-аар idempotent байна.
- Дуусах хүртэлх хугацаа 7 хоног буюу 168 цагаас их бол `Идэвхтэй`, 0-ээс их бөгөөд 168 цагтай тэнцүү эсвэл бага бол `Удахгүй дуусна`, `expires_at`-аас `expires_at + 48 цаг` хүртэл `Grace period`, түүнээс хойш `Дууссан` байна.
- Өгөгдлийн санд төлөвийг зөвхөн нэг удаа бичиж хуучруулахгүй; `expires_at`, одоогийн серверийн цаг болон түдгэлзүүлсэн төлөвөөс бодож харуулна.
- Package-ийн эрх болон үнэ нь одоогийн project/package дүрэмтэй нэг эх үүсвэрээс уншигдана; dashboard тусдаа үнэ зохиохгүй.

### 4.1 Subscription suspension

- Зөвхөн `SUBSCRIPTION_SUSPEND` permission-тэй Platform Super Admin recent step-up MFA, reason code болон mandatory note-тойгоор provisioned hotel-ийг suspend/reactivate хийнэ. Operation Admin хийхгүй.
- Suspension нь security/access override: hotel-ийн бүх operational API, staff session болон public listing-ийг нэн даруй хааж hotel auth epoch нэмнэ. Hotel Admin-д reason reference, support болон logout харагдана; renewal төлбөр төлж болох боловч төлбөр suspension-ийг автоматаар цуцлахгүй.
- Suspension нь `starts_at`, `expires_at`, renewal base болон package schedule-ийг pause/сунгахгүй; календарийн хугацаа хэвийн үргэлжилнэ. Reactivate хийхэд тухайн мөчийн underlying `Идэвхтэй/Удахгүй/Grace/Дууссан` төлөв шууд үйлчилнэ.
- Auto-reactivate хийхгүй. Reactivate нь мөн permission, recent MFA, mandatory reason болон append-only audit шаарддаг тусдаа event байна.
- Staff/account suspension нь subscription suspension-оос тусдаа record; account suspension hotel-ийн төлбөрийн хугацаа эсвэл бусад account-ийн эрхийг өөрчлөхгүй.

### 4.2 Paid reconciliation queue

- Onboarding эсвэл upgrade/renewal-ийн stale, expired, superseded буюу second payment бодитоор paid болсон ч hotel/subscription-д автоматаар apply болоогүй record `PAID_REQUIRES_RECONCILIATION` queue-д орно.
- Зөвхөн `SUBSCRIPTION_PAYMENT_RECONCILE` permission-тэй нэрлэсэн Operation/finance account recent step-up MFA-тайгаар provider/reference, amount, application/subscription болон ledger event-ийг тулгаж terminal outcome сонгоно.
- Outcome нь `PROVIDER_STATUS_CORRECTED_NOT_PAID`, `DUPLICATE_OR_SYSTEM_PAYMENT_EXTERNAL_REVERSAL`, `CHARGEBACK_LINKED`, `FINANCE_EXCEPTION_CLOSED` байна; provider/bank/finance reference болон mandatory note шаардана.
- Энэ queue-гээс package, term, `starts_at`, `expires_at`, pending target эсвэл provisioning-ийг гараар apply/edit хийхгүй. Entitlement авах шаардлагатай бол хэрэглэгч шинэ authoritative quote/intent ашиглана; duplicate/system payment-ийн мөнгөн exception-ийг `SUB-DEC-009`-ийн external reversal/chargeback хүрээнд шийднэ.
- Нэг payment record нэг terminal resolution-тэй; queue claim/resolve нь row lock, idempotency key, actor, before/after state болон append-only audit-тай байна.

## 5. SMS сануулгын tab

### 5.1 Зорилго ба хүлээн авагч

SMS tab нь систем ашиглах эрхийн хугацаа болон үйлчилгээний үйл ажиллагааны сануулга илгээхэд ашиглагдана.

- SMS-ийг зочид болон hotel staff бүрт бус, тухайн subscription-ийн бүртгэлтэй үндсэн холбоо барих утсанд илгээнэ.
- Нэг буудал хэд хэдэн дугаартай бол SMS хүлээн авах нэг үндсэн дугаарыг тусдаа `Subscription contact` болгон баталгаажуулж хадгална.
- Subscription contact өөрчлөхөд §2.3-ын old+new phone OTP, controlled offline exception болон append-only audit дүрэм үйлчилнэ.
- Marketing сурталчилгааны SMS-ийг MVP-ийн энэ tab-аар илгээхгүй; subscription/service reminder-д хязгаарлана.

### 5.2 Хүлээн авагч сонгох

Operation Admin recipient-ийг дараах аргаар сонгоно:

- жагсаалтаас нэг буюу хэд хэдэн буудал сонгох;
- багцаар шүүх;
- subscription төлөвөөр шүүх;
- эрх дуусах огнооны интервалаар шүүх.

`Бүх хэрэглэгч` гэсэн нэг даралтаар шууд илгээхгүй. Эхлээд filter-ийн үр дүн, давхардалгүй утасны тоо болон recipient-ийн тоог preview-д харуулна.

### 5.3 Текстийн дүрэм

- SMS текст **1–300 тэмдэгттэй** байна.
- Эхлэл болон төгсгөлийн илүүдэл хоосон зайг цэвэрлэсний дараа тэмдэгтийн тоог шалгана. Дундах хоосон зай, шинэ мөр болон тэмдэгтүүд тоонд орно.
- Хоосон эсвэл 300 тэмдэгтээс урт текст илгээхгүй.
- Текст бичих явцад тэмдэгтийн тоог `ашигласан / 300` хэлбэрээр шууд харуулна.
- CallPro-ийн нийтэд нээлттэй нөхцөлөөр кирилл SMS нэг segment-д 70 тэмдэгт, латин SMS 160 тэмдэгт бөгөөд хязгаараас хэтэрвэл хэд хэдэн мессеж болон хуваагдана.
- Текст өөрчлөгдөх бүрд үүсэх CallPro SMS segment-ийн тоо болон гэрээний тарифт тулгуурласан тооцоолсон зардлыг шууд шинэчилж харуулна.
- Илгээхийн өмнөх preview-д тэмдэгтийн тоо, нэг recipient-д ногдох segment, нийт recipient, нийт segment болон тооцоолсон нийт зардлыг дахин харуулна.
- Монгол Unicode болон латин текстийн segment багтаамж өөр байж болох тул provider-ийн техникийн нөхцөлтэй тулгана.
- UI-ийн тэмдэгтийн тоолуур болон CallPro-ийн billing segment тооцоолол нь хоёр өөр ойлголт байна. Segment-ийн эцсийн алгоритм/үнэ CallPro-ийн гэрээ/API specification-ийг дагана.

### 5.4 Илгээх үндсэн урсгал

1. Operation Admin SMS tab нээнэ.
2. Буудал/багц/төлөв/дуусах огноогоор хүлээн авагч сонгоно.
3. 1–300 тэмдэгтийн текст оруулж, тэмдэгт/segment/тооцоолсон зардлыг шууд харна.
4. Систем давхардсан болон хүчингүй утсыг ялгана.
5. Preview дэлгэцэд текст, recipient-ийн тоо, хасагдсан дугаарын тоо, segment болон боломжтой бол зардлыг харуулна.
6. Operation Admin `Илгээхийг баталгаажуулах` үйлдэл хийнэ.
7. Систем send job үүсгэж, provider руу давхардалгүй recipient бүрээр илгээнэ.
8. `Хүлээгдэж буй`, `Илгээсэн`, `Хүрсэн`, `Амжилтгүй` үр дүнг SMS түүхэд харуулна.

- MVP-д subscription `Удахгүй дуусна`, `Дууссан` эсвэл өөр төлөвт шилжсэнээр SMS автоматаар илгээхгүй.
- Scheduler/cron, background trigger болон auto-send campaign MVP-д байхгүй.
- Preview нээснээр SMS илгээгдсэн гэж үзэхгүй. Operation хэрэглэгч тухайн preview дээр `Илгээхийг баталгаажуулах` үйлдэл амжилттай хийсний дараа л send job үүснэ.
- Баталгаажуулах үед recipient/filter болон текст өөрчлөгдсөн бол хуучин preview-г хүчингүй болгож шинэ preview шаардана.
- Нэг удаагийн илгээх recipient-ийн дээд хязгаар болон амжилтгүй илгээлтийн retry дүрэм одоогоор батлагдаагүй.

### 5.5 Давхардал ба алдааны хамгаалалт

- Ижил send job дотор нэг утсанд нэг л удаа илгээнэ.
- Илгээх товчийг давтан дарах, network retry хийхэд duplicate SMS үүсгэхгүй idempotency хамгаалалттай байна.
- Хүчингүй, байхгүй эсвэл provider татгалзсан дугаарыг бусад амжилттай илгээлтийг буцаалгүй тусдаа алдаатай тэмдэглэнэ.
- Амжилтгүй дугаарт автоматаар хэдэн удаа retry хийхийг provider болон Operation дүрэмтэй батална.
- Provider-ийн callback давтан ирсэн ч нэг SMS-ийн төлөвийн түүхийг эвдэхгүй.

### 5.6 CallPro Text API интеграц

- SMS provider нь **CallPro Text** байна.
- Hotel Booking Platform-ийн backend CallPro-ийн API service-тэй server-to-server холбогдоно. Browser/mobile client CallPro credential хүлээн авахгүй, CallPro API-г шууд дуудахгүй.
- CallPro Text үйлчилгээний гэрээ байгуулж, API integration эрхтэй тохирох багцыг сонгосны дараа production credential авна.
- Нийтийн бүтээгдэхүүний хуудсаар API integration, автомат/масс/OTP мессеж, тайлан болон нэг/хоёр чиглэлийн сонголт дэмжигддэг нь баталгаажсан.
- CallPro-ийн нийтэд нээлттэй мэдээллээр SMS нь байгууллагын 8 оронтой IP72 дугаараас илгээгдэнэ; байгууллагын нэрийг sender болгон шууд харуулахгүй. Иймээс шаардлагатай бол платформын нэр болон эргэн холбогдох дугаарыг SMS template-д оруулна.
- Төслийн document-д CallPro-ийн бодит endpoint, request/response schema, authentication төрөл, IP allowlist, rate/throughput limit болон callback гарын үсгийг таамгаар зохиохгүй. CallPro-оос олгох гэрээ/API specification-оор батална.
- CallPro delivery callback дэмжвэл гарын үсэг/эх үүсвэрийг шалгаж status update авна. Callback дэмжихгүй бол гэрээнд зөвшөөрсөн status query/polling ашиглана.
- Дотоод `send_job_id` болон recipient бүрийн `message_id`-г provider reference-тэй холбож, timeout эсвэл retry үед duplicate SMS үүсгэхгүй.
- Timeout-ийн дараа үр дүн тодорхойгүй бол шууд шинэ SMS илгээхгүй; provider status-аар reconciliation хийсний дараа retry шийднэ.
- CallPro credential-ийг нууц хадгалалтад байршуулж, environment бүрд тусгаарлана. Log, audit, frontend болон source code-д credential бичихгүй.
- Reminder module нь **one-way SMS** горимтой байна: платформ subscription contact руу сануулга илгээх боловч тухайн дугаараас ирэх SMS хариуг Hotel Booking Platform хүлээн авч, хадгалж эсвэл боловсруулахгүй.
- One-way гэдэг нь delivery status авахгүй гэсэн утга биш. CallPro-ийн батлагдсан callback/status query-гаар `Илгээсэн`, `Хүрсэн`, `Амжилтгүй` төлөвийг тайланд шинэчилнэ.
- Operation Dashboard-д inbound SMS inbox, conversation болон reply хийх UI/API үүсгэхгүй.

Албан ёсны лавлагаа: [CallPro Text үйлчилгээ](https://www.callpro.mn/service/text). Public API endpoint/authentication specification олдоогүй тул production интеграцийн техникийн үнэн зөв эх сурвалж нь CallPro-оос гэрээгээр өгөх API document байна.

## 6. SMS түүх ба тайлан

SMS илгээлтийн жагсаалт серверийн pagination-тай байна. Үндсэн талбар:

- send job ID;
- илгээсэн Operation хэрэглэгч;
- үүсгэсэн болон баталгаажуулсан огноо/цаг;
- ашигласан filter/сонголтын snapshot;
- recipient-ийн нийт, давхардалгүй, хасагдсан тоо;
- segment-ийн нийт тоо;
- илгээсэн, хүрсэн, амжилтгүй, хүлээгдэж буй тоо;
- provider reference;
- job төлөв.

SMS-ийн бүтэн текстийг түүхэнд хэдий хугацаагаар хадгалах, recipient-ийн утсыг бүтнээр эсвэл масклаж харуулах болон дахин илгээх үйлдлийг тусад нь батална.

## 7. Аудит ба хамгаалалт

Дараах үйлдлийг аудитад хадгална:

- Operation Dashboard-д нэвтрэх;
- буудлын subscription жагсаалт нээх, хайх, filter хийх, дэлгэрэнгүй үзэх;
- SMS draft үүсгэх/засах/устгах;
- recipient сонгох болон preview үүсгэх;
- SMS илгээхийг баталгаажуулах;
- job үүсэх, provider-д дамжих, хүргэлтийн төлөв өөрчлөгдөх;
- дахин оролдох болон цуцлах боломж нэмэгдсэн бол тэдгээр үйлдэл;
- role/permission болон subscription-ийн хугацааны тохиргоо өөрчлөх.

- Нууц үг, OTP, access token болон provider secret-ийг log/audit-д хадгалахгүй.
- Утас, SMS body болон subscription мэдээллийг URL, analytics болон ердийн application log-д бичихгүй.
- SMS provider-тэй мэдээлэл боловсруулах, хадгалалт, устгал болон дэд боловсруулагчийн нөхцөлийг production гэрээнд тодорхойлно.
- Operation Dashboard-оос Police data болон hotel guest data руу эрх дамжихгүй.

## 8. MVP acceptance criteria — эхний хувилбар

- Зөвхөн эрх бүхий Operation хэрэглэгч dashboard-д хандана.
- Систем ашиглаж буй буудлууд server-side pagination-тай харагдана.
- Төлбөр баталгаажаагүй onboarding application hotel/subscription жагсаалт, KPI болон public listing-д орохгүй; төлбөртэй боловч provisioning дуусаагүй application тусдаа queue-д `Идэвхжээгүй` гэж харагдана.
- Subscription жагсаалт батлагдсан 13 баганатай, email масклагдсан бөгөөд default-аар хугацаа хамгийн түрүүнд дуусах буудлаас эхэлж эрэмбэлэгдэнэ.
- Буудал бүрийн сонгосон багц, хугацаа болон дуусах огноо харагдана.
- Subscription төлбөр амжилттай баталгаажсан мөчөөс эхэлж, сонгосон календарь сарын тоогоор `expires_at`-ийг `Asia/Ulaanbaatar` цагаар зөв тооцно.
- Сарын ижил өдөр байхгүй тохиолдолд зорилтот сарын сүүлийн өдрийг ашиглаж, давтан payment callback эрхийг давхар эхлүүлэхгүй байна.
- Хугацаа дуусаагүй эсвэл `expires_at`-аас хойших 48 цагийн grace period дотор subscription-ийг сунгахад шинэ сарууд анхны/одоогийн `expires_at`-ээс нэмэгдэнэ; grace дууссаны дараах renewal төлбөр баталгаажсан мөчөөс шинэ хугацаа эхэлнэ.
- Үлдсэн хоног/цаг болон `Идэвхтэй`, `Удахгүй дуусна`, `Grace period`, `Дууссан` төлөвийг сервер талд тооцно.
- `Нийт буудал` нь status partition-ийн нийлбэртэй, package count-ийн нийлбэртэй тэнцэж, card дарахад exact filter/page 1 үйлчилнэ; `Идэвхжээгүй` application total-д орохгүй.
- Suspension-г зөвхөн тусгай permission-тэй Platform Super Admin reason/MFA-тай хийж, хугацааг pause/сунгахгүй; reactivation автомат биш байна.
- Үлдсэн хоногийг ceiling-аар, grace үед 0 хоног + үлдсэн grace цагаар харуулна; `Inactive` subscription state байхгүй.
- Grace period-ийн турш hotel-ийн package эрх хэвийн үргэлжилж, 48 цаг дууссаны дараа төлбөргүй бол hard lock болон public listing hide болно.
- Эрх дуусахад 7 буюу түүнээс цөөн хоног үлдсэн, дуусаагүй subscription `Удахгүй дуусна` төлөвтэй болж dashboard/SMS filter-д орно.
- Багц, төлөв, дүүрэг болон дуусах огноогоор шүүнэ.
- Буудлын нэр, exact утас/email, бүртгэлийн төрөл, дүүрэг, багц, сарын хугацаа, төлөв болон дуусах огнооны filter-үүдийг хослуулж server-side ашиглана.
- SMS tab-аас 1–300 тэмдэгтийн текст оруулж, 300 тэмдэгтээс хэтэрвэл илгээхийг хориглоно.
- Бичих явц болон илгээхийн өмнө recipient-ийн давхардалгүй тоо, тэмдэгт, SMS segment болон тооцоолсон зардлыг харуулна.
- SMS нь зөвхөн Operation хэрэглэгч хүчинтэй preview-г гараар баталгаажуулсны дараа илгээгдэж, subscription төлөв өөрчлөгдөхөд автоматаар илгээгдэхгүй байна.
- Нэг send job нэг дугаарт duplicate SMS илгээхгүй.
- Илгээсэн болон хүргэлтийн үр дүнг түүхээр харна.
- SMS нь one-way байна; хэрэглэгчийн SMS хариуг платформ хүлээн авч боловсруулахгүй боловч provider-ийн delivery status-ийг тайланд авна.
- Hotel/Police хэрэглэгч Operation Dashboard болон SMS илгээх endpoint-д хандаж чадахгүй байна.
- SMS болон subscription-ийн хамгаалагдсан үйлдлүүд аудиттай байна.
- Тусгай эрхтэй Operation хэрэглэгч үндсэн subscription account-д reset хүсэлт эхлүүлж чаддаг боловч email-ийн бүтэн утга, код/холбоос болон нууц үгийг харах/тохируулах боломжгүй байна.
- Reset амжилттай дуусахад өмнөх session-ууд хүчингүй болж, password reset нь subscription болон account status-ийг өөрчлөхгүй байна.
- Бүртгэлтэй email-д хандах боломжгүй үед Operation хэрэглэгч email солихгүй, хүсэлтийг Platform Super Admin-ийн тусдаа офлайн recovery журам руу шилжүүлнэ.
- Subscription contact солиход old+new phone OTP шаардаж, offline exception-ийг зөвхөн explicit Platform permission owner reference/reason/MFA-тай approve хийнэ; Operation Admin дугаарыг шууд солихгүй.
- `PROVISIONING_FAILED` application-ийн manual retry-г зөвхөн `ONBOARDING_PROVISION_RETRY` permission + MFA-тай account хийж, immutable payment/package/owner/term-ийг өөрчлөхгүй; duplicate retry давхар hotel/subscription/Admin membership үүсгэхгүй.

## 9. Батлагдсан болон бүртгэгдсэн шийдвэр

### OPS-DEC-001 — Operation Dashboard-ийн үндсэн зорилго

- **Төлөв:** Хэрэглэгчийн эхний шаардлага бүртгэгдсэн
- **Шийдвэр:** Систем ашиглаж буй буудлууд, сонгосон багц болон систем ашиглах хугацаа дуусаж буй эсэхийг Operation Dashboard-д харуулна.

### OPS-DEC-002 — SMS сануулгын tab

- **Төлөв:** Tab, recipient болон текстийн хязгаар/preview батлагдсан
- **Шийдвэр:** Operation Dashboard-д 1–300 тэмдэгттэй текст бэлтгэж, тухайн буудлын subscription-д бүртгэсэн нэг үндсэн холбоо барих утсанд сануулга SMS илгээх тусдаа tab байна. Зочид болон бүх hotel staff-д илгээхгүй. Текст бичихэд тэмдэгт, CallPro segment болон тооцоолсон зардал шууд харагдаж, илгээхийн өмнө recipient/нийт segment/нийт зардлын preview гарна.

### OPS-DEC-003 — CallPro SMS provider

- **Төлөв:** Provider батлагдсан; гэрээ/API specification хүлээгдэж байгаа
- **Шийдвэр:** Operation Dashboard-ийн сануулга SMS-ийг CallPro Text API service-ээр дамжуулна. Холболтыг backend server-to-server хийж, credential болон endpoint/auth/callback-ийн бодит нөхцөлийг CallPro-ийн гэрээ, албан API document-оор батална.

### OPS-DEC-004 — One-way SMS

- **Төлөв:** Батлагдсан
- **Шийдвэр:** MVP-д CallPro SMS нь one-way байна. Платформ subscription contact руу сануулга илгээх боловч хэрэглэгчийн SMS хариуг хүлээн авч боловсруулах inbox/conversation урсгалгүй байна. Delivery callback/status query-г илгээлтийн тайланд ашиглана.

### OPS-DEC-005 — Удахгүй дуусах хугацааны босго

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Subscription дуусахад 7 буюу түүнээс цөөн хоног үлдсэн боловч хугацаа нь дуусаагүй бол `Удахгүй дуусна` төлөвтэй байна. Улаанбаатарын цагаар сервер талд тооцож, dashboard болон SMS recipient filter-д ашиглана.

### OPS-DEC-006 — Subscription эхлэх ба дуусах мөч

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Төлбөр амжилттай баталгаажсан мөчөөс subscription эхэлнэ. `starts_at` дээр сонгосон `1`, `3`, `7`, `12` календарь сарыг `Asia/Ulaanbaatar` цагаар нэмж `expires_at`-ийг тооцно. Зорилтот сард ижил өдрийн дугаар байхгүй бол тухайн сарын сүүлийн өдрийг ижил цагт ашиглана. Давтан payment callback нэг subscription-ийг дахин эхлүүлэхгүй.

### OPS-DEC-007 — Subscription сунгалтын хугацаа

- **Төлөв:** 48 цагийн grace дүрмээр шинэчлэн батлагдсан
- **Шийдвэр:** Хугацаа дуусахаас өмнө болон `expires_at`-аас хойших 48 цагийн grace period дотор renewal төлбөр баталгаажвал шинэ саруудыг анхны/одоогийн `expires_at`-ээс үргэлжлүүлэн нэмнэ. Grace дууссаны дараа renewal төлбөр баталгаажвал төлбөр баталгаажсан мөч шинэ `starts_at` болно. Нэг payment-ийн давтан callback хугацааг дахин нэмэхгүй.

### OPS-DEC-008 — Operation-оос password reset эхлүүлэх

- **Төлөв:** Үндсэн email reset урсгал батлагдсан; email ownership recovery нь MVP-ийн Operation scope-оос гадуур production procedure
- **Шийдвэр:** Тусгай эрхтэй Operation хэрэглэгч буудлын үндсэн subscription account-д password reset хүсэлт эхлүүлнэ. Нэг удаагийн холбоос/код зөвхөн өмнө бүртгэлтэй email-д очиж, хэрэглэгч шинэ нууц үгээ өөрөө тохируулна. Оператор одоогийн/шинэ нууц үг болон reset code/link-ийг харахгүй. Амжилттай reset-ийн дараа өмнөх session-ууд хүчингүй болно. CallPro SMS-ийг энэ урсгалд ашиглахгүй.

### OPS-DEC-009 — Email-д хандах боломжгүй recovery

- **Төлөв:** MVP-ийн эрхийн хил батлагдсан; офлайн recovery-ийн дэлгэрэнгүй журам production-оос өмнө хүлээгдэж байгаа
- **Шийдвэр:** Operation хэрэглэгч account-ийн бүртгэлтэй email-ийг солихгүй, өөр email рүү reset явуулахгүй. Хүсэлтийг Platform Super Admin-д шилжүүлж, гэрээ болон эзэмшигч/эрх бүхий төлөөлөгчийн мэдээллийг тусдаа офлайн журмаар баталгаажуулсны дараа шийднэ. Email ownership recovery нь Operation Dashboard-ийн MVP функц биш байна.

### OPS-DEC-010 — Manual-only SMS илгээлт

- **Төлөв:** Батлагдсан
- **Шийдвэр:** MVP-д SMS автоматаар болон хуваарьт trigger-ээр илгээгдэхгүй. Operation хэрэглэгч recipient, текст, тэмдэгт, segment болон тооцоолсон зардлыг preview-д шалгаж `Илгээхийг баталгаажуулах` үйлдэл хийсний дараа л CallPro send job үүснэ. Recipient/filter эсвэл текст өөрчлөгдвөл дахин preview шаардана.

### OPS-DEC-011 — Subscription жагсаалтын багана ба эрэмбэ

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Жагсаалтад дэс дугаар, буудлын нэр, бүртгэлийн төрөл, дүүрэг/хаяг, subscription contact утас, маскласан email, багц, хугацааны сар, эхлэх/дуусах огноо, үлдсэн хоног, төлөв болон `Дэлгэрэнгүй`/`SMS илгээх`/`Password reset` үйлдэл харагдана. Default эрэмбэ нь хугацаа хамгийн түрүүнд дуусах буудлаас эхэлнэ.

### OPS-DEC-012 — Subscription жагсаалтын filter ба хайлт

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Буудлын нэрийн хэсэгчилсэн хайлт, утас/email-ийн exact хайлт, байгууллага/хувь хүн, дүүрэг, багц, 1/3/7/12 сарын хугацаа, subscription төлөв болон дуусах огнооны интервал ашиглана. Filter-үүдийг хослуулж server-side гүйцэтгэнэ. Email үр дүнд масклагдсан хэвээр байх бөгөөд `Цэвэрлэх` үед default жагсаалт/эрэмбэ рүү буцна.

### OPS-DEC-013 — Application, идэвхжээгүй төлөв ба Hotel KPI-ийн зааг

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Төлбөр баталгаажаагүй application нь Hotel/Subscription биш бөгөөд hotel KPI, package KPI болон public listing-д орохгүй. Төлбөр баталгаажсан боловч provisioning эсвэл existing-owner verification дуусаагүй application тусдаа onboarding queue-д `Идэвхжээгүй` гэж харагдана. `PROVISIONED` болсон мөчөөс л Hotel/Subscription жагсаалт ба KPI-д нэг удаа орно. Canonical application lifecycle нь ONB-DEC-006/007 байна.

### OPS-DEC-014 — KPI formula ба card filter

- **Төлөв:** Батлагдсан
- **Шийдвэр:** `Нийт буудал` зөвхөн provisioned hotel-ийг тоолж, current status нь `Идэвхтэй`, `Удахгүй`, `Grace`, `Дууссан`, `Түдгэлзсэн` гэсэн давхардахгүй partition байна. Paid-but-not-provisioned application-ийн `Идэвхжээгүй` count тусдаа. Package KPI current applied package-аар, SMS KPI current month-ийн recipient-message latest state-аар тоологдоно. Card бүр exact filter тавьж page 1/SMS tab руу шилжинэ.

### OPS-DEC-015 — Operation security ба contact change

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Operation action бүр explicit permission, named account, MFA/session/step-up болон audit-тай; role нэр дангаараа эрх нээхгүй. Operation Admin subscription contact-ийг шууд өөрчлөхгүй. Primary Hotel Admin old+new phone 6-digit OTP-оор солино; old phone unavailable exception-ийг зөвхөн explicit Platform permission, owner/offline reference, new-phone OTP, reason болон recent MFA-тай approve хийнэ.

### OPS-DEC-016 — Subscription state ба suspension

- **Төлөв:** Батлагдсан
- **Шийдвэр:** `Inactive` subscription state ашиглахгүй; `Идэвхжээгүй` нь application grouping. `Түдгэлзсэн` нь Platform Super Admin-ийн explicit permission/reason/MFA-тай access override бөгөөд expiry/renewal хугацааг pause эсвэл сунгахгүй, auto-reactivate хийхгүй. Remaining day нь positive хугацааны ceiling; grace/expired үед 0, grace hours тусдаа. Account suspension subscription-оос тусдаа байна.

### OPS-DEC-017 — Paid reconciliation permission ба terminal outcome

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Onboarding/subscription stale эсвэл second paid payment `PAID_REQUIRES_RECONCILIATION` queue-д орно. Зөвхөн explicit `SUBSCRIPTION_PAYMENT_RECONCILE` permission + recent MFA-тай Operation/finance account provider/ledger reference болон mandatory note-той terminal outcome сонгоно; queue package, хугацаа, provisioning эсвэл entitlement-ийг гараар apply/edit хийхгүй.

### OPS-DEC-018 — Provisioning retry ба Operation recovery permission

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Paid `PROVISIONING_FAILED` onboarding job-ийг зөвхөн explicit `ONBOARDING_PROVISION_RETRY` permission + recent MFA-тай Operation account immutable application/payment snapshot-аар idempotent retry хийнэ. Subscription eBarimt retry/email delivery нь `SUBSCRIPTION_EBARIMT_RETRY`, email ownership offline recovery нь `ACCOUNT_OWNERSHIP_RECOVERY_APPROVE` permission-тэй; Operation/Platform role нэр дангаараа эдгээр эрхийг нээхгүй.

## 10. P0 хаагдсан төлөв

Operation Dashboard-ийн KPI/filter, permission/contact security, paid reconciliation ownership, provisioning recovery болон subscription suspension/state-ийн P0 асуудлыг `OPS-DEC-014`–`OPS-DEC-018`-аар хаасан. Дараах зүйлс нь provider/production configuration бөгөөд үндсэн schema/API загварыг дахин нээхгүй.

## 11. Production-оос өмнө баталгаажуулах зүйлс

- `Удахгүй дуусна` 7 хоногийн босгын boundary/timezone test;
- CallPro гэрээ, API integration багц, production credential, endpoint/authentication, sender IP72 дугаар, callback/status query, Unicode/segment, үнэ болон throughput;
- үйлчилгээний сануулга болон marketing мессежийн хууль/гэрээний ялгаа;
- нэг job-ийн recipient хязгаар, илгээх цаг, retry/cancel дүрэм;
- SMS body, delivery log болон subscription мэдээллийн retention;
- SMS provider-ийн SLA, callback баталгаажуулалт, нууц түлхүүрийн хамгаалалт болон incident response.
