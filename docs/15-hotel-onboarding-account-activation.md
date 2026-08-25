# Hotel onboarding ба анхны account activation

**Хувилбар:** 0.4  
**Төлөв:** MVP onboarding-ийн payment gate, ownership proof, durable/idempotent provisioning, canonical application state болон анхны account activation батлагдсан; onboarding-ийн P0 шийдвэрүүд хаагдсан  
**Хамаарах үе шат:** MVP — Hotel onboarding / Subscription

## 1. Зорилго

Буудлын мэдээлэл бөглөсөн төдийд бодит hotel account үүсгэхгүй. Зөвхөн төлбөр provider/server талаас амжилттай баталгаажсаны дараа тухайн буудлын тусдаа орон зай, subscription, анхны Hotel Admin account-ийн activation урсгалыг үүсгэнэ.

Энэ дүрмийн зорилго нь төлбөр төлөөгүй олон хуурамч hotel account, role, subscription болон нийтийн буудлын бүртгэл үүсэхээс хамгаалах юм.

## 2. Бүртгэлийн төрөл

MVP-д захиалагч дараах хоёр төрлийн аль нэгээр бүртгүүлнэ:

1. **Иргэн** — хувь хүн өөрийн нэрээр hotel subscription эзэмшинэ.
2. **Байгууллага** — хуулийн этгээд өөрийн эрх бүхий төлөөлөгчөөр дамжуулан hotel subscription эзэмшинэ.

Бүртгэлийн төрөл нь заавал сонгогдож, төлбөр баталгаажсаны дараа үүсэх subscription owner дээр snapshot болон хадгалагдана. Төрлийг дараа нь энгийн profile edit-ээр солихгүй; ownership change-ийн тусдаа хяналттай урсгал шаардана.

### 2.1 Иргэнээр бүртгүүлэх заавал талбар

| Талбар | Дүрэм |
| --- | --- |
| Овог | Заавал |
| Нэр | Заавал |
| Регистрийн дугаар | Заавал; сервер талд бүтцийн шалгалттай, ердийн log/URL-д бичихгүй |
| Утасны дугаар | Заавал; OTP баталгаажуулалттай |
| Email | Заавал; анхны Hotel Admin activation link энэ email-д очно |
| Subscription contact утас | Заавал; үндсэн утастай ижил байж болно |
| Hotel-ийн нийтэд харагдах нэр | Заавал |
| Hotel-ийн нийтэд харагдах утас | Заавал |
| Дүүрэг, хороо | Заавал |
| Дэлгэрэнгүй хаяг | Заавал |
| Газрын зураг дээрх байршил | Заавал; coordinate-ийг сервер талд хадгална |
| Багц | 20,000₮, 25,000₮ эсвэл 30,000₮ |
| Хугацаа | 1, 3, 7 эсвэл 12 сар |

Гэрийн хаяг, хүйс, нас зэрэг onboarding-ийн зорилгод шаардлагагүй мэдээллийг авахгүй.

### 2.2 Байгууллагаар бүртгүүлэх заавал талбар

| Талбар | Дүрэм |
| --- | --- |
| Байгууллагын албан ёсны нэр | Заавал |
| Улсын бүртгэлийн/регистрийн дугаар | Заавал; сервер талд бүтцийн шалгалттай |
| Эрх бүхий төлөөлөгчийн овог, нэр | Заавал |
| Төлөөлөгчийн албан тушаал | Заавал |
| Төлөөлөгчийн утас | Заавал; OTP баталгаажуулалттай |
| Hotel Admin email | Заавал; activation link энэ email-д очно |
| Subscription contact утас | Заавал |
| Hotel-ийн нийтэд харагдах нэр | Заавал |
| Hotel-ийн нийтэд харагдах утас | Заавал |
| Дүүрэг, хороо | Заавал |
| Дэлгэрэнгүй хаяг | Заавал |
| Газрын зураг дээрх байршил | Заавал |
| Багц | 20,000₮, 25,000₮ эсвэл 30,000₮ |
| Хугацаа | 1, 3, 7 эсвэл 12 сар |

Байгууллагын гэрчилгээ болон төлөөлөх эрхийн баримтыг төлбөрийн дараах Hotel account activation-д заавал шаардахгүй. Харин public online booking-д нийтлэх болон platform settlement авахын өмнө шаардлагатай business/KYC баталгаажуулалтад оруулна.

### 2.3 Нэг эзэмшигчийн олон буудал

- Нэг иргэн хэд хэдэн hotel эзэмшиж болно.
- Нэг байгууллага хэд хэдэн hotel/салбартай байж болно.
- Эзэмшигч бүрт давхар profile үүсгэхийн оронд өмнөх owner profile-тэй шинэ hotel-ийг холбоно.
- Hotel бүр тусдаа tenant/data scope, subscription, сонгосон багц, хугацаа болон төлбөртэй байна.
- Нэг hotel-ийн subscription төлбөрөөр өөр hotel-ийн эрхийг идэвхжүүлэхгүй.

## 3. Төлбөрөөс өмнөх бүртгэл

Хэрэглэгч дараах алхмыг төлбөрөөс өмнө гүйцэтгэнэ:

1. `Иргэн` эсвэл `Байгууллага` төрлөө сонгоно.
2. Эзэмшигч/төлөөлөгчийн шаардлагатай мэдээллийг оруулна.
3. Буудлын нэр, холбоо барих мэдээлэл, хаягийг оруулна.
4. Газрын зураг дээр байршлаа сонгоно.
5. 20,000₮, 25,000₮ эсвэл 30,000₮ багцыг сонгоно.
6. 1, 3, 7 эсвэл 12 сарын хугацааг сонгоно.
7. Оруулсан мэдээлэл, багц, хугацаа болон төлөх нийт дүнг шалгана.
8. Систем payment invoice/intent үүсгэнэ.

Энэ үед хадгалагдах зүйл нь зөвхөн `Төлбөр хүлээж байгаа бүртгэлийн хүсэлт` байна.

Төлбөрөөс өмнө дараах зүйлсийг **үүсгэхгүй**:

- бодит Hotel tenant/account;
- идэвхтэй subscription;
- Hotel Admin role;
- ажилтны account;
- login session;
- нийтийн booking жагсаалтын hotel record;
- activation email/link.

Төлбөр хүлээж буй хүсэлтийг hotel account-ийн тоо, идэвхтэй subscription болон Operation Dashboard-ийн идэвхтэй буудлын KPI-д оруулахгүй.

### 3.1 Existing account/owner-ийг төлбөрөөс өмнө батлах

- Оруулсан email өмнө user account-д бүртгэлтэй бол шинэ user үүсгэхгүй. Хэрэглэгч тухайн account-аараа нэвтрэх эсвэл бүртгэлтэй email-ийн password recovery-г амжилттай дуусгасны дараа л шинэ hotel-ийн хүсэлтийг үргэлжлүүлнэ.
- Иргэний регистр эсвэл байгууллагын улсын бүртгэлийн дугаар existing owner profile-тэй таарвал шинэ owner үүсгэхгүй, зөвхөн ownership proof амжилттай болсны дараа уг owner-т шинэ hotel холбоно.
- Ownership proof нь дараахын аль нэг байна:
  1. authenticated account тухайн owner profile-тэй өмнө нь баталгаажсан холбоотой;
  2. owner profile-д **өмнө хадгалсан**, баталгаажсан contact суваг руу илгээсэн challenge амжилттай;
  3. Platform Super Admin-ийн гэрээ/эрх бүхий төлөөлөгчийг шалгасан offline recovery/verification.
- Шинэ application дээр оруулсан email/утсыг existing owner-ийн proof суваг гэж үзэхгүй, өмнөх owner-ийн contact-ийг автоматаар overwrite хийхгүй.
- Proof хүлээгдэж байвал application `OWNER_VERIFICATION_REQUIRED` төлөвтэй бөгөөд payment invoice/intent үүсгэхгүй. Operation хэрэглэгч proof-ийг тойрч гарах, owner холбоосыг гараар солих эрхгүй.
- Pre-payment шалгалтаас хойш concurrency/race-аар ижил owner шинээр үүссэн нь payment callback дээр илэрвэл payment-ийг дахин авахгүй; application-ийг `PAID_OWNER_VERIFICATION_REQUIRED` болгон, proof дуусах хүртэл owner link, Hotel Admin membership болон public listing үүсгэхгүй.

## 4. Төлбөр баталгаажуулах дүрэм

Hotel account provisioning эхлүүлэх цорын ганц payment trigger нь **төлбөр provider/server талаас амжилттай баталгаажсан үр дүн** байна. Existing-owner match илэрсэн бол 3.1-ийн ownership proof нь тусдаа заавал хангах precondition бөгөөд payment success дангаараа owner холбоосыг зөвшөөрөхгүй.

- Browser дээр `Амжилттай` дэлгэц харагдах, screenshot үзүүлэх, хэрэглэгч буцаж ирэх эсвэл client талын утгыг дангаар нь баталгаа гэж үзэхгүй.
- Backend нь provider-ийн callback болон шаардлагатай status query/reconciliation-аар төлбөрийг шалгана.
- Нэг payment callback давтан ирсэн ч нэг hotel, subscription эсвэл Hotel Admin invitation-ийг дахин үүсгэхгүй.
- Төлбөр амжилтгүй, цуцлагдсан, хугацаа дууссан эсвэл үр дүн тодорхойгүй бол activation хийхгүй.
- Үр дүн тодорхойгүй payment-ийг автоматаар амжилттай гэж үзэхгүй; provider status-аар дахин тулгана.

### 4.1 Payment retry, late success ба давхар суутгал

- Нэг application-д нэг мөчид нэг active/non-terminal payment attempt байна. `PAYMENT_UNCERTAIN` attempt provider reconciliation-аар `PAID`, definitive `FAILED` эсвэл `EXPIRED` болохоос өмнө replacement invoice үүсгэхгүй.
- `PAYMENT_FAILED`/`PAYMENT_EXPIRED` application-аас хэрэглэгч retry хийхэд шинэ unique attempt-тай `PENDING_PAYMENT` рүү орж болно; хуучин attempt immutable terminal хэвээр байна.
- Application row/payment slot-ийг lock хийж амжилттай баталгаажсан **эхний** provider payment л application-ийг paid state рүү шилжүүлнэ. Дараах өөр provider payment success нь hotel/subscription хугацааг дахин үүсгэхгүй, payment attempt `PAID_REQUIRES_RECONCILIATION` болж Operation/finance exception queue-д орно.
- Хуучин expired attempt-ийн late success application төлөгдөөгүй хэвээр бол шинэ unpaid attempt-ийг cancel/supersede хийж application-ийг paid state рүү нэг удаа шилжүүлж болно. Шинэ attempt мөн дараа нь paid бол хоёр дахь payment нь дээрх reconciliation queue-д орно.
- Provider payment ID нь provider/merchant scope-д unique, attempt callback/status query idempotent байна. Reconciliation queue-ийн шийдвэр hotel, subscription, package, term эсвэл `starts_at/expires_at`-ийг автоматаар өөрчлөхгүй.

## 5. Төлбөр баталгаажсаны дараах durable provisioning

Provider/server payment success-ийг эхлээд application болон provider payment ID-тай immutable байдлаар хадгална. Дараа нь application бүрийн нэг logical provisioning job ижил payment-ийг ашиглан дараах database ажиллагааг нэг transaction-аар гүйцэтгэнэ:

1. Бүртгэлийн хүсэлтийг canonical `PAID_PENDING_PROVISIONING` болгоно; existing-owner race илэрсэн бол `PAID_OWNER_VERIFICATION_REQUIRED` болж proof хүртэл provisioning эхлэхгүй.
2. Тухайн буудлын тусдаа Hotel tenant/account үүсгэнэ.
3. Шинэ owner бол `Иргэн` эсвэл `Байгууллага` subscription owner-ийг үүсгэнэ; existing owner proof амжилттай бол шинэ owner үүсгэхгүй, баталгаажсан existing owner-ийг hotel-той холбоно.
4. Сонгосон багц болон сарын хугацаатай subscription-ийг идэвхжүүлнэ.
5. Subscription-ийн `starts_at` нь төлбөр provider/server талаас баталгаажсан мөч байна.
6. Батлагдсан календарь сарын дүрмээр `expires_at`-ийг тооцно.
7. Шинэ user шаардлагатай бол account болон анхны Hotel Admin membership-ийг `PENDING_ACTIVATION` төлөвтэй үүсгэнэ. Existing, proof хийсэн active user бол account/password-ийг өөрчлөхгүй, анхны Hotel Admin membership-ийг тухайн account-д `ACTIVE`-аар холбоно.
8. Шинэ user-д бүртгэлтэй email рүү хугацаатай, нэг удаагийн account activation link илгээх outbox event үүсгэнэ; existing user-д шинэ password/token/activation link үүсгэхгүй.

Provisioning-ийн хамгаалалт:

- Нэг `provider_payment_id` зөвхөн нэг onboarding application-д, нэг application зөвхөн нэг hotel-д, нэг hotel зөвхөн нэг initial subscription болон нэг Primary Hotel Admin membership-д холбогдоно.
- Hotel, owner link, subscription болон Primary Admin membership-ийн database transaction бүхэлдээ амжилттай болох эсвэл rollback хийнэ. Partial tenant/subscription/membership үлдээхгүй.
- Transaction техникийн алдаатай бол application `PROVISIONING_FAILED` болно. Payment-ийг дахин авахгүй; ижил application/payment/provisioning job-ийг exponential backoff-тай хамгийн ихдээ 5 удаа автоматаар retry хийнэ. Дараа нь тусгай `ONBOARDING_PROVISION_RETRY` permission-тэй Operation хэрэглэгч manual retry хийнэ.
- Retry нь package, term, amount, owner identifier болон provider payment-ийг edit хийхгүй. Unique constraint болон idempotency key давхар hotel/subscription/Admin membership үүсгэхээс хамгаална.
- Activation email нь database transaction-аас тусдаа outbox delivery байна. Email түр амжилтгүй болсон нь амжилттай provisioning-ийг rollback хийхгүй; Admin `PENDING_ACTIVATION` хэвээр, delivery-г ижил outbox event-ээр idempotent retry хийнэ.
- Provisioning retry болон email retry subscription-ийн existing `starts_at = payment_confirmed_at` болон `expires_at`-ийг урагш/хойш өөрчлөхгүй.

Анхны Hotel Admin-д системээс зохиосон бэлэн болон түр нууц үгийг email, SMS эсвэл Operation хэрэглэгчээр дамжуулан өгөхгүй. Activation link-ээр орсон хэрэглэгч нууц үгээ өөрөө үүсгэнэ. Нууц үг амжилттай үүссэний дараа link дахин ашиглагдахгүй бөгөөд өмнөх activation link-үүд хүчингүй болно. Link-ийн яг хүчинтэй хугацаа, resend interval болон request limit-ийг security configuration шийдвэрээр батална.

### 5.1 Давхардлаас хамгаалах дүрэм

- Нэг баталгаажсан email нэг хэрэглэгчийн account-тай байна.
- Email өмнө account-д бүртгэлтэй бол шинэ хэрэглэгч үүсгэхгүй; 3.1-ийн existing-account proof амжилттай болсны дараа шинэ hotel membership-ийг тухайн account-д холбоно.
- Иргэний регистр өмнө owner profile-д бүртгэлтэй бол шинэ owner үүсгэхгүй; 3.1-ийн ownership proof амжилттай болсны дараа шинэ hotel-ийг өмнөх owner-той холбоно.
- Байгууллагын улсын бүртгэлийн/регистрийн дугаар өмнө бүртгэлтэй бол шинэ organization owner үүсгэхгүй; эрх бүхий төлөөлөгчийн 3.1-ийн proof амжилттай болсны дараа шинэ hotel-ийг тухайн байгууллагатай холбоно.
- Утасны дугаар нэг эзэмшигчийн хэд хэдэн hotel-ийн subscription contact байж болох тул global unique гэж хориглохгүй; тухайн дугаар баталгаажсан эсэхийг тусад нь хадгална.
- Hotel нэр, хаяг, нийтэд харагдах утас болон coordinate өмнөх hotel-тэй ойролцоо/таарсан бол `Давхардал шалгах шаардлагатай` flag үүсгэнэ.
- Сэжигтэй давхардал байсан ч төлбөр амжилттай баталгаажсан бол hotel tenant/subscription үүснэ; харин шалгалт дуусахаас өмнө public online booking-д нийтлэхгүй.
- Нэг provider payment ID зөвхөн нэг onboarding application, hotel болон subscription provisioning-д ашиглагдана.

## 6. Hotel account, Admin account, subscription, public listing-ийн ялгаа

Дараах дөрвөн төлөвийг нэг `active` талбарт нэгтгэхгүй:

- **Hotel account:** Тухайн буудлын систем дэх тусдаа өгөгдлийн орон зай үүссэн эсэх.
- **Hotel Admin account:** Анхны Admin activation хийж нэвтрэх боломжтой болсон эсэх.
- **Subscription:** Төлбөртэй багцын ашиглах хугацаа хүчинтэй эсэх.
- **Public listing:** Online booking хайлтад тухайн буудал нийтлэгдсэн эсэх.

Төлбөр баталгаажиж, existing-owner proof шаардлагатай бол тэр нь амжилттай болсны дараа durable provisioning эхний hotel account болон subscription-ийг үүсгэнэ. `PAID_OWNER_VERIFICATION_REQUIRED` үед payment хүчинтэй хадгалагдах боловч hotel/owner/Admin холбоосын provisioning proof хүртэл түр зогсоно. Provisioning дууссан буудал ч нийтийн online booking жагсаалтад автоматаар гарахгүй; өрөө, үнэ, зураг, нийтэд харагдах утас, байршил болон бусад заавал мэдээлэл бүрдсэний дараа тусдаа publish шалгалт хийнэ.

Ингэснээр төлбөр нь төлбөргүй хуурамч account-аас хамгаалж, publish gate нь төлбөр төлсөн боловч бодит мэдээлэлгүй/хуурамч listing нийтэд харагдахаас хамгаална.

## 7. Canonical application болон activation state

### Бүртгэлийн хүсэлт

- `DRAFT`
- `OWNER_VERIFICATION_REQUIRED`
- `PENDING_PAYMENT`
- `PAYMENT_UNCERTAIN`
- `PAYMENT_FAILED`
- `PAYMENT_EXPIRED`
- `PAID_OWNER_VERIFICATION_REQUIRED`
- `PAID_PENDING_PROVISIONING`
- `PROVISIONING`
- `PROVISIONING_FAILED`
- `PROVISIONED`

### Анхны Hotel Admin account

- `PENDING_ACTIVATION`
- `ACTIVE`
- `SUSPENDED`

Үндсэн transition:

```text
DRAFT
→ OWNER_VERIFICATION_REQUIRED → PENDING_PAYMENT
эсвэл
DRAFT → PENDING_PAYMENT

PENDING_PAYMENT
→ PAYMENT_UNCERTAIN | PAYMENT_FAILED | PAYMENT_EXPIRED
эсвэл
→ PAID_PENDING_PROVISIONING

PAYMENT_UNCERTAIN
→ PAID_PENDING_PROVISIONING | PAYMENT_FAILED | PAYMENT_EXPIRED

PAYMENT_FAILED | PAYMENT_EXPIRED
→ PENDING_PAYMENT (new payment attempt)

Race-аар existing owner илэрвэл:
PAID_PENDING_PROVISIONING
→ PAID_OWNER_VERIFICATION_REQUIRED
→ PAID_PENDING_PROVISIONING

PAID_PENDING_PROVISIONING
→ PROVISIONING
→ PROVISIONED
эсвэл
→ PROVISIONING_FAILED → PROVISIONING
```

- Paid state-ээс unpaid state рүү буцаахгүй. Duplicate callback/retry өмнөх terminal үр дүнг буцааж, давхар transition үүсгэхгүй.
- Application paid болсны дараах second/late successful attempt application state-ийг өөрчлөхгүй; attempt `PAID_REQUIRES_RECONCILIATION` queue-д орно.
- `PROVISIONED` нь Hotel tenant/subscription/Admin membership database-д бүрэн үүссэнийг хэлнэ. Шинэ user-ийн activation email delivery болон Admin-ийн `PENDING_ACTIVATION → ACTIVE` төлөв тусдаа; proof хийсэн existing active user-ийн membership provisioning transaction-аар `ACTIVE` болж болно.
- `PAID_OWNER_VERIFICATION_REQUIRED` үед payment хүчинтэй хэвээр боловч ownership proof дуусах хүртэл operational access/public listing үүсэхгүй.

## 8. Аудит

Дараах үйлдлийг аудитад хадгална:

- бүртгэлийн хүсэлт үүсгэсэн огноо/цаг;
- сонгосон бүртгэлийн төрөл, багц, хугацаа болон үнийн snapshot;
- payment invoice/intent ID;
- provider-ийн баталгаажсан payment ID, огноо/цаг, дүн;
- provisioning эхэлсэн/дууссан/алдаатай төлөв;
- үүссэн hotel, subscription owner, subscription болон анхны Admin account-ийн ID;
- activation email хүссэн болон хүргэлтийн төлөв;
- давтан callback/provisioning retry.
- application-ийн before/after canonical state, provisioning job/attempt ID, error code болон idempotency result;
- existing owner proof-ийн төрөл, masked destination, шийдвэрлэсэн actor, result болон server time.

Нууц үг, activation token, provider secret болон OTP-г audit/application log-д эх утгаар нь хадгалахгүй.

## 9. MVP acceptance criteria

- Мэдээлэл бүрэн бөглөсөн ч төлбөр баталгаажаагүй бол Hotel account, subscription болон Hotel Admin үүсэхгүй.
- `Иргэн` болон `Байгууллага` гэсэн хоёр бүртгэлийн төрлөөс заавал сонгоно.
- Бүртгэлийн төрөл тус бүрийн батлагдсан заавал талбар бүрэн бус бол payment invoice/intent үүсгэхгүй.
- Зөвхөн provider/server баталгаажуулсан амжилттай төлбөр activation/provisioning-ийг эхлүүлнэ.
- Давтан callback нэг hotel, subscription эсвэл Admin account-ийг давхар үүсгэхгүй.
- Provisioning transaction fail бол partial hotel/subscription/Admin membership үлдэхгүй, payment дахин авахгүй, ижил job/payment-ээр retry хийнэ.
- Activation email fail болсон ч provisioned hotel/subscription rollback болохгүй; outbox retry давхар invitation үүсгэхгүй.
- Төлбөр амжилтгүй, хугацаа дууссан эсвэл тодорхойгүй үед login/activation боломжгүй байна.
- `PAYMENT_UNCERTAIN` үед replacement invoice үүсэхгүй; definitive failed/expired бол шинэ attempt-аар retry хийж болно.
- Эхний valid successful payment л application-ийг paid болгоно; late/duplicate second capture давхар hotel/subscription/хугацаа үүсгэхгүй, reconciliation queue-д орно.
- Subscription төлбөр баталгаажсан мөчөөс эхэлнэ.
- Шинэ Hotel Admin user тусдаа activation хийсний дараа нэвтэрнэ; proof хийсэн existing active user өмнөх account/password-аараа нэвтэрч шинэ hotel membership-ээ ашиглана.
- Шинэ анхны Hotel Admin-д бэлэн нууц үг илгээхгүй; бүртгэлтэй email-д очсон хугацаатай, нэг удаагийн activation link-ээр нууц үгээ өөрөө үүсгэнэ. Existing user-д шинэ password/token/link үүсгэхгүй.
- Activation амжилттай дууссан link-ийг дахин ашиглах боломжгүй байна.
- Нэг иргэн/байгууллагад олон hotel холбож болох боловч hotel бүр тусдаа tenant, subscription болон төлбөртэй байна.
- Давхардсан email шинэ user үүсгэхгүй; давхардсан owner identifier шинэ owner үүсгэхгүй.
- Existing email/owner-ийг шинэ application-ийн contact мэдээллээр шууд холбоход хориглоно; authenticated/stored-contact/offline proof-ийн аль нэг амжилттай байна.
- Existing owner proof хүлээгдэж байвал төлбөрийн өмнө invoice үүсэхгүй; payment-ийн дараах race бол `PAID_OWNER_VERIFICATION_REQUIRED`-д access/publication блоклогдоно.
- Canonical application state-ээс гадуур client status-аар provisioning/activation хийхгүй.
- Сэжигтэй давхардсан hotel public booking-д шалгалтгүй нийтлэгдэхгүй.
- Төлбөр баталгаажсан hotel ч шаардлагатай мэдээлэл бүрдээгүй бол public booking жагсаалтад автоматаар нийтлэгдэхгүй.

## 10. Батлагдсан шийдвэр

### ONB-DEC-001 — Payment-gated activation

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel бүртгэлийн бүх мэдээлэл бөглөгдсөн байсан ч төлбөр provider/server талаас амжилттай баталгаажаагүй бол Hotel account, subscription, Hotel Admin болон activation урсгал үүсгэхгүй. Төлбөр баталгаажсаны дараа л provisioning/activation эхэлнэ.

### ONB-DEC-002 — Бүртгэлийн төрөл

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Захиалагч MVP-д `Иргэн` эсвэл `Байгууллага` гэсэн хоёр төрлийн аль нэгээр бүртгүүлнэ.

### ONB-DEC-003 — Анхны Hotel Admin activation

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Шинэ анхны Hotel Admin user-д бэлэн болон түр нууц үг email/SMS-ээр илгээхгүй. Төлбөр баталгаажсаны дараа бүртгэлтэй email-д хугацаатай, нэг удаагийн activation link илгээж, хэрэглэгч нууц үгээ өөрөө үүсгэнэ; амжилттай activation хийсний дараа link дахин ашиглагдахгүй. Email нь existing, proof хийсэн active account-д харьяалагддаг бол шинэ user/password/token/link үүсгэхгүй, анхны Hotel Admin membership-ийг өмнөх account-д холбоно.

### ONB-DEC-004 — Бүртгэлийн заавал талбар

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Иргэн болон байгууллагын заавал талбарыг 2.1, 2.2-т зааснаар авна. Onboarding зорилгод шаардлагагүй гэрийн хаяг, хүйс, нас зэрэг мэдээллийг авахгүй. Байгууллагын баримт/KYC-г Hotel account activation-д бус, public listing болон settlement-ийн өмнөх шалгалтад хэрэглэнэ.

### ONB-DEC-005 — Ownership ба давхардал

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Нэг иргэн/байгууллага олон hotel-той байж болох боловч hotel бүр тусдаа tenant, subscription болон төлбөртэй байна. Email нэг user account-тай; иргэний регистр/байгууллагын дугаар нэг owner profile-тэй байна. Сэжигтэй hotel давхардал төлбөрийн дараах account provisioning-ийг цуцлахгүй боловч public listing-ийг шалгалт хүртэл хориглоно.

### ONB-DEC-006 — Durable, idempotent provisioning

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Provider/server payment success-ийг immutable хадгалсны дараа нэг application/payment-ийн logical provisioning job hotel, owner link, subscription болон Primary Hotel Admin membership-ийг нэг database transaction-аар all-or-nothing үүсгэнэ. Failure үед payment дахин авахгүй, partial entity үлдээхгүй, ижил idempotency/unique key-ээр retry хийнэ. Activation email тусдаа outbox delivery тул email failure provisioning-ийг rollback хийхгүй; retry нь subscription хугацааг өөрчлөхгүй.

### ONB-DEC-007 — Existing account/owner proof ба canonical state

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Existing email/owner identifier-ийг шинэ application-ийн contact утгаар шууд attach/overwrite хийхгүй. Authenticated existing account, owner profile-ийн өмнө баталгаажсан contact challenge эсвэл Platform Super Admin-ийн audited offline verification-ийн аль нэг proof шаардлагатай. Proof төлбөрөөс өмнө дутуу бол invoice үүсэхгүй; payment-ийн дараах race бол `PAID_OWNER_VERIFICATION_REQUIRED` төлөвт access/public listing блоклогдож, proof дууссаны дараа ижил payment-аар provisioning үргэлжилнэ. Application нь 7-р хэсгийн canonical state/transition-оос гадуур шилжихгүй.

### ONB-DEC-008 — Payment attempt retry ба late/duplicate success

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Нэг application-д нэг active payment attempt байна. `PAYMENT_UNCERTAIN` reconcile хийгдэх хүртэл replacement invoice үүсгэхгүй; definitive failed/expired бол шинэ attempt-аар retry хийнэ. Application row lock дээр эхний valid successful payment л paid/provisioning transition үүсгэнэ. Дараагийн late/duplicate capture `PAID_REQUIRES_RECONCILIATION` болж hotel/subscription/package/хугацааг автоматаар өөрчлөхгүй.

## 11. Хаагдсан төлөв

Onboarding-ийн P0 үндсэн шийдвэрүүд ONB-DEC-001–008-аар хаагдсан. Activation/invitation link-ийн TTL, resend interval болон request/attempt rate limit нь нэгдсэн authentication security configuration-ийн P1 тоон тохиргоо бөгөөд onboarding entity/state/provisioning schema-г дахин нээхгүй.
