# Reception барьцаа ба payment correction lifecycle

**Хувилбар:** 1.13  
**Төлөв:** MVP deposit/payment correction, reserved-balance concurrency/idempotency, late-refund reconciliation болон operational permission батлагдсан; deposit/payment correction-ийн P0 шийдвэрүүд хаагдсан  
**Хамаарах үе шат:** MVP — Reception / Payment / Shift

## 1. Үндсэн хүрээ

- Зөвхөн баталгаажсан online booking-гүй `Walk-in` stay барьцаатай байна.
- Өөрийн платформын баталгаажсан online booking барьцаагүй байна.
- Барьцааны дүн 50,000–100,000₮ хооронд байна.
- Manager, эсвэл 30,000₮ багцын Manager Plus hotel default барьцааг тохируулж, room category override байвал category-ийн дүн precedence авна. Hotel Admin-д энэ operational action хийх бол тухайн багцад зөвшөөрөгдсөн Manager/Manager Plus role тусдаа байна.
- Reception source/deposit requirement болон тохируулсан дүнг дур мэдэн алгасах/солихгүй.
- Барьцаа нь авах мөчдөө room/minibar борлуулалтын орлого биш; зочинд буцаах эсвэл эцсийн тооцоонд ашиглах тусдаа liability/үлдэгдэл байна.

## 2. Барьцаа авах суваг

Барьцааг:

- QPay;
- card gateway эсвэл гар POS;
- бэлэн мөнгөөр

авна.

Provider/server баталгаажуулаагүй QPay/card payment-ийг авсан барьцаа гэж үзэхгүй. Гар POS transaction-ийг Reception reference/approval code болон terminal/огноо/дүнгээр бүртгэнэ. Бэлэн барьцаа нь shift/cash drawer transaction-тай холбоотой байна.

### 2.1 Initial check-in backdate ба deposit/payment

`STAY-DEC-009`-ийн initial confirmation backdate нь deposit/payment-ийн огноо, shift эсвэл effective time-ийг буцаах ажиллагаа биш. Reception `actual_check_in_at`-ийг заавал шалтгаантайгаар 120 минутын дотор, current open shift-ийн хүрээнд, hotel-local ижил өдөрт, Online booking бол `planned_checkin_at`-аас өмнө бишээр сонгож болох ч `check_in_recorded_at` нь server confirmation time байна.

- Walk-in deposit requirement анхны баталгаажуулалтын current authoritative тохиргоогоор хангагдсан байна; backdate нь deposit-ийг алгасахгүй.
- Online booking backdate хийсэн ч Online source хэвээр, deposit шинээр үүсгэхгүй, paid/confirmed room-rate snapshot-ийг reprice хийхгүй.
- Cash deposit/refund/payment тухайн бодит үйлдлийн current drawer/shift болон server effective time-д; QPay/Card/POS нь provider/server success time/reference-тэй үлдэнэ.
- Backdate хийхэд өмнөх shift-д deposit/payment/cash movement нөхөн үүсгэхгүй, historical configuration эсвэл financial snapshot дахин байгуулахгүй, шинэ financial movement/approval шаардахгүй.
- Stay `Active` болсны дараа Reception `actual_check_in_at`-ийг шууд edit хийхгүй; зөвхөн `STAY-DEC-010`-ын immutable amendment lifecycle ашиглана.

### 2.2 Active stay actual-time amendment санхүүд нөлөөлөхгүй

Check-out эхлээгүй active stay-ийн actual start буруу бол Reception reason-тэй correction request үүсгэж, Manager approve/reject хийнэ. Reception+Manager multi-role account өөрийн request-ийг approve хийж болох ч `self-approved` flag-тай байна. Нэг pending request check-out initiation-ийг блоклож, `Approved` эсвэл `Rejected` terminal болсны дараа л checkout үргэлжилнэ; check-out эхэлсэн/дууссан үед request/approval хориглоно.

Approved бол original check-in event overwrite болохгүй, immutable amendment-аас `effective_actual_check_in_at` derivation хийнэ. New time нь original `check_in_recorded_at`/shift/local-day/Online `planned_checkin_at`-д anchored `STAY-DEC-009` window-оос гарахгүй.

Энэ amendment deposit requirement, source, amount, allocation, refund, payment channel/status/reference, cash drawer/shift, provider success/effective time эсвэл financial recognized time-ийг өөрчлөхгүй. Deposit/payment/cash movement үүсгэхгүй, хуучныг буцааж шилжүүлэхгүй, financial correction approval-ийг орлохгүй. Actual-start correction зөвхөн timestamp field тул planned checkout/duration/type/rate/minibar/config/stock-д мөн хүрэхгүй (`STAY-DEC-010`).

### 2.3 Planned checkout minimal guard санхүүгийн side effectгүй

Confirmed booking эсвэл `ACTIVE` stay-ийн `planned_checkout_at`-ийг generic direct edit/PATCH-аар overwrite хийхгүй. MVP-д change байхгүй; STAY-DEC-011-ийн append-only history/revalidation нь зөвхөн post-MVP change хожим тусдаа батлагдвал мөрдөх invariant байна.

Энэ minimal guard одоогоор хугацаа өөрчлөх button/API/action, action төрөл, permission/approval, eligibility, pricing/repricing, refund эсвэл payment дүрэм нээхгүй. Deposit requirement/balance/allocation, charge, payment/refund/provider transaction, cash movement/shift/effective/recognized time болон өмнөх snapshot/event immutable хэвээр; guard өөрөө financial movement, correction эсвэл reconciliation үүсгэхгүй.

### 2.4 P0-39C-2 — MVP complete lock ба санхүүгийн isolation

`STAY-DEC-012`-оор `CONFIRMED` booking/`ACTIVE` stay-ийн planned checkout MVP-д огт өөрчлөгдөхгүй. Amendment/action/button/API, extension, planned-end shorten, hourly ↔ nightly conversion болон тэдгээрийн payment action байхгүй. Early/late actual checkout зөвхөн `actual_checkout_at` бүртгэж original planned end-ийг өөрчлөхгүй.

Early actual checkout автоматаар room charge reprice хийхгүй, refund үүсгэхгүй. Planned end өнгөрсөн active stay overdue status/time-тай болохоос fee/penalty, charge/payment/cash movement автоматаар үүсэхгүй. Room actual checkout хүртэл occupied; дараа нь snapshot buffer + clean + applicable minibar readiness gate үйлчилнэ. Deposit balance/allocation, charge, payment/refund/provider record, cash/shift/effective/recognized time болон бүх snapshot/event immutable хэвээр.

### 2.5 Deposit config, source ба snapshot permission

| Үйлдэл | Hotel Admin | Manager | Manager Plus | Reception |
| --- | ---: | ---: | ---: | ---: |
| Hotel/category deposit дүн тохируулах | Нэмэлт Manager/Manager Plus role | ✓ 20/25/30 | ✓ 30 | Read-only |
| Initial confirmation-оос өмнөх source/deposit-exemption correction | Нэмэлт Manager/Manager Plus role | ✓ 20/25/30 | ✓ 30 | — |
| Deposit авах/ердийн суутгал/үндсэн сувгийн refund execute | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ |
| Alternate-channel refund approve/reject | Нэмэлт Manager/Manager Plus role | ✓ 20/25/30 | ✓ 30 | Request |
| Failed/pending refund cancel ба reservation release | Нэмэлт Manager/Manager Plus role | ✓ 20/25/30 | ✓ 30 | Request |
| Financial correction approve/reject | Нэмэлт Manager/Manager Plus role | ✓ 20/25/30 | ✓ 30 | Request |

- Deposit config нь 50,000–100,000₮ бүхэл MNT байна. Category override unset бол hotel default үйлчилнэ.
- Config edit зөвхөн дараагийн unconfirmed Walk-in stay-д үйлчилнэ. Initial confirmation амжилттай болмогц source, deposit required/exempt, amount болон config version snapshot immutable болно.
- Reception source/deposit exemption/config amount-ийг өөрчлөхгүй. Initial confirmation-оос өмнөх exceptional correction-ийг Manager/Manager Plus mandatory reason болон audit-тай хийнэ.
- Confirmation эсвэл deposit/payment movement үүссэний дараа source/exemption/config snapshot-ийг direct edit хийхгүй; шаардлагатай мөнгөн залруулгыг existing reversal/refund/correction lifecycle-аар шийднэ.
- Hotel Admin role нь эдгээр operational permission-ийг автоматаар өвлөхгүй; тохирох Manager/Manager Plus, deposit cash/customer action хийх бол Reception role тусдаа авна.

## 3. Checkout тооцоо ба барьцааны суутгал

```text
Эцсийн үйлчилгээний төлбөр
= Өрөөний төлбөр
+ Minibar
+ Бусад батлагдсан төлбөр

Барьцаанаас ашиглах дүн
= min(Идэвхтэй барьцааны үлдэгдэл, Эцсийн төлбөрийн үлдэгдэл)
```

- Reception барьцааг бүхэлд нь эсвэл хэсэгчлэн room/minibar/батлагдсан бусад payment line-д ашиглана.
- Ердийн суутгалд шалтгаан, нотлох зураг/баримт болон Manager/Hotel Admin-ийн нэмэлт approval шаардахгүй.
- Систем ямар payment line-д хэдэн төгрөг шилжүүлсэн, actor, stay, огноо/цагийг автоматаар хадгална.
- Барьцаа хүрэлцэхгүй бол үлдсэн дүнг QPay, Card/POS эсвэл бэлнээр авч болно; top-up payment барьцааны анхны сувагтай ижил байх шаардлагагүй.
- Барьцаанаас төлбөрт шилжүүлэх нь кассанд шинээр мөнгө орсон үйлдэл биш тул cash/revenue-г давхар нэмэхгүй.

Жишээ:

```text
Барьцаа: 100,000₮
Room: 60,000₮
Minibar: 20,000₮

Тооцоонд ашиглах: 80,000₮
Буцаах үлдэгдэл: 20,000₮
```

### 3.1 Reserved balance, concurrency ба idempotency

Stay бүр нэг version-тэй deposit balance aggregate ашиглана:

```text
Available deposit
= Successful receipt
− Receipt reversal
− Allocated amount
− Refund reserved amount
− Successful refunded amount
```

- `Available deposit >= 0`; allocated + refund-reserved + refunded дүн нь reversal-ийг хассан successful receipt-ээс хэтрэхгүй.
- Allocation, refund reserve/release/success болон financial correction нь deposit aggregate row/version-ийг transaction-аар түгжиж, balance invariant-ийг commit-ийн өмнө дахин шалгана.
- Refund request `Хүлээгдэж байгаа`, provider result `UNKNOWN` эсвэл retryable `Амжилтгүй` бол тухайн дүн `refund_reserved` хэвээр. Timeout/transport error дангаараа cancel/release хийх үндэслэл биш; provider-оос late success ирж болох хугацаанд өөр payment line-д давхар allocate хийхгүй.
- Provider success болоход reserved дүн нэг удаа `refunded` болно. Explicit cancel/release-ийг зөвхөн cash бодитоор хүлээлгээгүй, provider request огт илгээгдээгүй, эсвэл provider authoritative `VOIDED/NOT_PROCESSED/FINAL_FAILED` гэж баталсан үед Manager/Manager Plus deposit aggregate row lock дээр reason-тэй хийнэ; original request/history устахгүй.
- `RELEASED` болсон provider request дээр санаандгүй late success ирвэл deposit refund-ийг дахин post хийхгүй. Aggregate-г lock/freeze хийж original request/provider reference-тэй цорын ганц `LATE_REFUND_SUCCESS` reconciliation case үүсгэн §3.2-оор terminal болтол шинэ refund/allocation хориглоно.
- Money command бүр client/server idempotency key-тэй; QPay/card/POS provider reference нь provider/merchant scope-д unique байна. Duplicate submit/callback/retry өмнөх үр дүнг буцааж, шинэ allocation/refund/reversal/correction үүсгэхгүй.
- Amount нь эерэг бүхэл MNT. Client-ийн илгээсэн available balance, direction, provider success эсвэл aggregate total-д итгэхгүй; сервер immutable transaction-аас бодно.
- Нэг original financial transaction-д нэгээс олон non-terminal correction request байхгүй. Correction approve/reject/execute нь original version/status-ийг түгжиж, duplicate approval/execution өмнөх үр дүнг буцаана.

### 3.2 Released refund-ийн late-success reconciliation

- `DEPOSIT_REFUND_RECONCILE` permission-тэй нэрлэсэн Platform Operation/finance account л recent step-up MFA-тайгаар case claim/resolve хийнэ. Hotel Admin/Manager/Reception role дангаараа resolve эрх үүсгэхгүй; Hotel Admin өөрийн hotel-ийн дүн, provider reference-ийн маскласан утга, төлөв болон terminal outcome-ийг read-only харна.
- Case нь deposit aggregate row/version-ийг lock хийж, provider status query/reference, original refund/request/release event болон amount-ийг тулгана. Нэг case нэг claimant, нэг terminal resolution, idempotency key болон append-only audit-тай байна.
- Provider authoritative байдлаар мөнгө гараагүйг баталбал `PROVIDER_STATUS_CORRECTED_NOT_SUCCESS` terminal outcome үүсгэж aggregate-г мөнгөн хөдөлгөөнгүй unfreeze хийнэ.
- Provider late refund success-ийг баталбал `covered_amount = min(current_available_deposit, provider_refunded_amount)`-ийг original request-тэй холбоотой immutable `LATE_REFUND_COVERED` refunded movement болгоно. Үлдсэн `shortfall_amount`-ийг deposit balance-ийг сөрөг болголгүй `LATE_REFUND_SHORTFALL` hotel finance loss/receivable event болгон бүртгээд case-ийг `PROVIDER_SUCCESS_POSTED` terminal outcome-оор хааж aggregate-г unfreeze хийнэ.
- Terminal posting нь guest рүү дахин refund command явуулахгүй, өмнөх allocation/charge/payment-ийг edit/delete/reopen хийхгүй. Provider reference + original refund ID unique бөгөөд duplicate callback/resolve өмнөх terminal үр дүнг буцаана.
- Provider result нотлогдоогүй case `RECONCILING` хэвээр, aggregate freeze үргэлжилнэ; timeout дангаараа unfreeze хийхгүй.

## 4. Үлдэгдэл буцаах үндсэн суваг

Боломжтой тохиолдолд unused deposit-ийг анх авсан сувгаар буцаана.

| Авсан суваг | Үндсэн буцаах суваг |
| --- | --- |
| Бэлэн | Бэлнээр, тухайн cash drawer/shift-ээс |
| QPay | Анхны QPay payment-тэй холбоотой refund |
| Card gateway | Анхны card transaction refund |
| Гар POS | Тухайн POS/картын refund эсвэл void |

- Refund recipient/transaction нь анхны payment-тэй холбоотой байна.
- Provider request илгээснээр шууд `Буцаагдсан` болгохгүй; provider/server success шаардана.
- Бэлэн refund-д recipient confirmation, Reception, shift болон цаг/дүн хадгалагдана.

## 5. Өөр сувгийн refund exception

Анхны сувгаар техникийн/бодит шалтгаанаар буцаах боломжгүй үед:

1. Reception alternate-channel refund хүсэлт үүсгэнэ.
2. Manager/Manager Plus батална. Hotel Admin батлах бол Manager/Manager Plus role тусдаа байна.
3. Буцаах суваг, дүн, recipient/reference болон анхны deposit transaction-ийг холбоно.
4. Provider/server эсвэл cash handover бодитоор амжилттай болсны дараа refund complete болно.
5. Actor, approver, шалтгаан, цаг болон холбоотой transaction аудитад хадгалагдана.

Энэ approval нь ердийн deposit deduction-д хамаарахгүй; зөвхөн буцаалтын сувгийг өөрчлөх exception байна.

## 6. POS/reference дүрэм

Гар POS payment/refund бүрд:

- reference/approval code;
- amount;
- transaction date/time;
- Reception user;
- боломжтой бол terminal ID;
- refund/void бол анхны payment reference

заавал хадгална.

QPay болон integrated card gateway-ийн provider reference автоматаар орно. Бэлэн transaction external reference-гүй боловч cash drawer, shift, receipt болон actor-той холбоотой байна.

## 7. Refund төлөв

```text
Буцаалт үүсгэсэн
→ Буцаалт хүлээгдэж байгаа
→ Буцаалт амжилттай
эсвэл
→ Буцаалт амжилтгүй → Буцаалт хүлээгдэж байгаа (retry)
эсвэл authoritative cancel
→ Цуцлагдсан / Reservation released
→ Late success илэрвэл `RECONCILING`
  → `PROVIDER_STATUS_CORRECTED_NOT_SUCCESS`
  эсвэл `PROVIDER_SUCCESS_POSTED`
```

- `Хүлээгдэж байгаа`/`Амжилтгүй` refund үед deposit liability хаагдсан гэж үзэхгүй; authoritative cancel/release хийгдээгүй бол тухайн дүн reserved хэвээр, өөр charge-д давхар ашиглагдахгүй.
- Амжилтгүй refund Manager/Manager Plus-ийн exception жагсаалтад орно. Hotel Admin уг queue-г шийдэх бол Manager/Manager Plus role тусдаа байна.
- Reception cancel/release хүсэлт гаргаж болно. Manager/Manager Plus provider/cash final status-ийг баталгаажуулж approve/execute хийнэ; Hotel Admin-д Manager/Manager Plus role тусдаа байна.
- Retry бүр original refund request болон provider reference-тэй холбоотой байна.
- Давтан callback/retry давхар refund үүсгэхгүй.
- Shift/financial report-д зөвхөн бодитоор амжилттай болсон refund нөлөөлнө.
- Released request-ийн late success нь §3.2-ын terminal reconciliation-гүйгээр refunded/closed болохгүй; `PROVIDER_SUCCESS_POSTED` үед covered refund болон shortfall financial event тайланд тусдаа харагдана.

## 8. Financial correction

Буруу amount, payment channel, duplicate record эсвэл буруу reference-ийг өмнөх transaction-ийг edit/delete хийж засахгүй.

```text
Буруу transaction
→ Холбоостой reversal
→ Шинэ зөв correction transaction
```

- Reception correction хүсэлт гаргаж болно.
- Manager/Manager Plus батална. Hotel Admin батлах бол Manager/Manager Plus role тусдаа байна.
- Correction reason заавал байна.
- Нэг original transaction-д хамгийн ихдээ нэг non-terminal correction request байна.
- Original, reversal болон corrected transaction бүгд immutable түүхтэй үлдэнэ.
- Correction-ийн cash drawer, shift, revenue/liability болон report effect-ийг шинэ event-ийн effective/reporting date-аар тусгана; хуучин тайлангийн мөрийг чимээгүй дарж өөрчлөхгүй.
- Approval/execution original transaction болон deposit aggregate version-ийг түгжиж, reversal + corrected transaction + balance effect-ийг нэг атомик ажиллагаагаар post хийнэ. Retry/давтан approval давхар reversal/correction үүсгэхгүй.

Correction reason/approval нь **энгийн барьцааны суутгалд** шаардахгүй гэсэн дүрмийг өөрчлөхгүй. Энэ нь зөвхөн санхүүгийн алдааг залруулах хамгаалалт юм.

## 9. Shift/cash нөлөө

```text
Бэлэн барьцаа авах       → expected cash нэмэгдэнэ
Бэлэн барьцаа буцаах     → expected cash хасагдана
Барьцааг төлбөрт суутгах → expected cash дахин нэмэгдэхгүй
```

QPay/card deposit/refund cash drawer-ийн бэлэн үлдэгдэлд орохгүй боловч shift payment summary болон reconciliation-д тусдаа харагдана.

Cash drawer movement, optional safe, transfer/withdrawal/top-up болон physical correction-ийн canonical дүрмийг [24-cash-drawer-ledger.md](./24-cash-drawer-ledger.md)-д мөрдөнө.

## 10. Аудит

Deposit бүрд дараах timeline хадгалагдана:

- шаардлага болон дүнг тооцсон source/config snapshot;
- авсан channel, amount, provider/POS/cash reference;
- room/minibar line-д ашигласан allocation;
- unused balance;
- refund request/status/channel/reference;
- alternate-channel approver;
- correction/reversal chain;
- deposit aggregate before/after version, idempotency key, reserved/released amount болон duplicate result;
- late-success reconciliation case, provider evidence, claimant/resolver, covered amount, shortfall event болон terminal outcome;
- actor, approver болон server date/time;
- initial check-in backdate ашигласан бол Reception actor/role, mandatory reason, `actual_check_in_at`, `check_in_recorded_at`, current shift болон server validation result.
- active-stay actual-time request/decision бүрд original/effective actual time, requester, Manager approver/rejector, reason, status/time, original boundary anchors болон `self-approved` flag; financial transaction ID/time/shift өөрчлөгдөөгүй холбоос.

Card data, provider credential болон authentication secret-ийг audit/log-д хадгалахгүй.

## 11. MVP acceptance criteria

- Online booking stay deposit үүсгэхгүй; Walk-in stay тохируулсан deposit-гүй check-in хийхгүй.
- Deposit revenue-д шууд орохгүй.
- Reception normal deduction хийхэд reason/evidence/additional approval шаардахгүй.
- Deposit allocation payment line бүрээр аудиттай байна.
- Unused deposit үндсэндээ анхны сувгаар буцна.
- Alternate-channel refund Manager/Manager Plus approval болон audit-тай; Hotel Admin-д Manager/Manager Plus role тусдаа байна.
- Гар POS payment/refund reference-гүй баталгаажихгүй.
- Provider success-гүй refund `Буцаагдсан` болохгүй.
- Failed/pending/unknown refund liability-г хаахгүй; зөвхөн cash not-handed эсвэл provider authoritative void/not-processed/final-failed батлагдсан Manager/Manager Plus cancel/release хүртэл reserved байна.
- Released refund дээр unexpected late provider success ирвэл aggregate freeze + unique `LATE_REFUND_SUCCESS` case үүснэ. Зөвхөн `DEPOSIT_REFUND_RECONCILE` permission + MFA-тай account provider evidence-ээр no-money terminal unfreeze эсвэл covered refund + shortfall posting terminal unfreeze хийж, давхар refund/allocation үүсгэхгүй.
- Financial transaction edit/delete хийхгүй; reversal + correction хэрэглэнэ.
- Correction Manager/Manager Plus approval болон reason-тэй; Hotel Admin-д Manager/Manager Plus role тусдаа байна.
- Нэг original transaction-д нэг non-terminal correction request байна; duplicate approval/execution нэг reversal/correction-ийг дахин үүсгэхгүй.
- Deposit aggregate available balance сөрөг болохгүй; concurrent allocation/refund/correction version/transaction lock-оор serialize хийгдэнэ.
- Provider reference болон command idempotency key duplicate receipt/refund/allocation/correction-оос хамгаална.
- Deposit config/source/exemption snapshot initial confirmation-оос хойш direct edit болохгүй; config edit зөвхөн дараагийн unconfirmed stay-д үйлчилнэ.
- Deposit allocation cash/revenue-г давхар нэмэхгүй.
- Initial check-in backdate нь Walk-in/Online deposit rule-ийг солихгүй, deposit/payment/refund-ийг prior shift буюу historical effective time руу шилжүүлэхгүй.
- Backdate өөрөө шинэ financial movement/approval үүсгэхгүй; active stay-ийн timestamp-ийг Reception шууд засахгүй.
- Active stay actual-time amendment pending үед checkout эхлэхгүй; approved amendment original event болон deposit/payment/refund/cash record-ийг overwrite/reprice/re-time хийхгүй.
- Checkout эхэлсэн/дууссан stay-д actual-time correction request/approval хийхгүй.
- Confirmed booking/active stay-ийн planned checkout change MVP-д байхгүй; STAY-DEC-011-ийн amendment invariant зөвхөн post-MVP-д тусдаа change батлагдвал үйлчилнэ.
- Minimal guard өөрөө deposit/payment/refund/cash action, permission/approval, repricing, transaction эсвэл snapshot/event correction үүсгэхгүй.
- Early/late actual checkout original planned end-ийг өөрчлөхгүй; early үед auto reprice/refund, overdue үед auto fee/penalty үүсэхгүй.
- Actual checkout хүртэл room occupied; C2 нь deposit/payment/refund/cash/financial snapshot event-д side effectгүй.

## 12. Батлагдсан шийдвэр

### DEP-DEC-001 — Deposit source ба дүн

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Зөвхөн Walk-in stay 50,000–100,000₮ тохируулсан deposit-тэй; баталгаажсан online booking deposit-гүй. Room category override нь hotel default дүнгээс precedence авна.

### DEP-DEC-002 — Normal deduction

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Reception deposit-ийг room/minibar/батлагдсан төлбөрт бүхэлд нь эсвэл хэсэгчлэн ашиглахад reason, evidence болон нэмэлт approval шаардахгүй. Allocation автоматаар аудиттай байна.

### DEP-DEC-003 — Original-channel refund

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Unused deposit-ийг боломжтой бол анх авсан cash/QPay/card/POS сувгаар буцаана. Provider/server success-гүй refund complete болохгүй.

### DEP-DEC-004 — Alternate-channel exception

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Анхны сувгаар буцаах боломжгүй үед alternate-channel refund-ийг Manager/Manager Plus баталж, шалтгаан/reference/audit-тай гүйцэтгэнэ. Hotel Admin-д Manager/Manager Plus role тусдаа шаардлагатай.

### DEP-DEC-005 — POS reference

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Гар POS payment болон refund/void бүрд reference/approval code, amount, date/time, Reception болон боломжтой бол terminal ID заавал хадгална.

### DEP-DEC-006 — Immutable financial correction

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Буруу financial transaction-ийг edit/delete хийхгүй. Reception хүсэлт, Manager/Manager Plus approval, correction reason, холбоостой reversal болон шинэ corrected transaction ашиглана. Hotel Admin-д Manager/Manager Plus role тусдаа шаардлагатай. Нэг original transaction-д нэг non-terminal correction request байх бөгөөд approval/execution idempotent, атомик байна.

### DEP-DEC-007 — Reserved balance, concurrency ба idempotency

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Stay бүр version-тэй deposit aggregate ашиглаж, available balance-ийг successful receipt-ээс reversal, allocation, refund reservation болон successful refund-ийг хасаж сервер бодно; balance сөрөг болохгүй. Pending/failed-but-not-cancelled refund liability-г хаахгүй боловч reserved дүнг давхар allocate хийхгүй. Allocation/refund/correction transaction/version lock-оор serialize хийгдэж, idempotency key болон unique provider reference duplicate money event-ээс хамгаална. Нэг original transaction-д нэг non-terminal correction request байна; duplicate callback/approval/execution өмнөх үр дүнг буцаана.

### DEP-DEC-008 — Deposit operational permission ба immutable config snapshot

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Deposit default/category config, pre-confirm source/exemption correction, alternate-channel refund approval болон financial correction approval-ийг Manager, эсвэл 30,000₮-ийн Manager Plus хийнэ. Hotel Admin-д тухайн багцад зөвшөөрөгдсөн Manager/Manager Plus role тусдаа; customer receipt/deduction/refund execute хийх бол Reception role мөн тусдаа шаардлагатай. Reception config/source/exemption өөрчлөхгүй. Initial confirmation үед config/source/required/amount snapshot түгжигдэж, дараагийн config edit confirmed stay-д нөлөөлөхгүй; post-confirm алдааг direct edit бус reversal/refund/correction lifecycle-аар шийднэ.

### DEP-DEC-009 — Refund release ба late-success race

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Pending/unknown/retryable-failed refund reserved хэвээр. Reception cancel хүсэлт гаргаж, Manager/Manager Plus зөвхөн cash not-handed эсвэл provider authoritative void/not-processed/final-failed баталгаатай үед row lock дээр `RELEASED` болгоно; Hotel Admin-д operational role тусдаа. Released request-ийн unexpected late success шинэ deposit refund болохгүй, aggregate freeze + `LATE_REFUND_SUCCESS` finance reconciliation үүсгэнэ.

### DEP-DEC-010 — Late refund reconciliation owner ба terminal posting

- **Төлөв:** Батлагдсан
- **Шийдвэр:** `LATE_REFUND_SUCCESS` case-ийг зөвхөн explicit `DEPOSIT_REFUND_RECONCILE` permission + recent MFA-тай Platform Operation/finance account claim/resolve хийнэ. Provider мөнгө гараагүйг баталбал хөдөлгөөнгүй unfreeze; success батлагдвал боломжтой available дүнг immutable covered refund, хүрэлцэхгүй хэсгийг deposit-ийг сөрөг болголгүй hotel finance shortfall event болгон post хийж terminal unfreeze хийнэ. Duplicate callback/resolve дахин refund үүсгэхгүй.

## 13. Хаагдсан төлөв

Deposit/payment correction-ийн P0 шийдвэрүүд DEP-DEC-001–010-аар хаагдсан. Shift-ийг [03-reception-shift-handover.md](./03-reception-shift-handover.md)-д, cash ledger-ийг [24-cash-drawer-ledger.md](./24-cash-drawer-ledger.md)-д, Cleaner exception-ийг [21-cleaner-checkout-exception-and-dispute.md](./21-cleaner-checkout-exception-and-dispute.md)-д, financial reporting-г [23-admin-financial-reporting.md](./23-admin-financial-reporting.md)-д, minibar selling price-ийг [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md)-д мөрдөнө. Stay timing-ийн immutable amendment/no-change/conflict alert нь deposit aggregate, payment/refund/cash event-д өөрөө financial side effect үүсгэхгүй.
