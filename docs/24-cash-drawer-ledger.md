# Cash drawer, safe болон бэлэн мөнгөний ledger

**Хувилбар:** 0.16  
**Төлөв:** P0-35 батлагдсан; P0-37, P0-38 болон P0-39A–P0-39C-2 батлагдсан  
**Хамаарах үе шат:** MVP — Reception / Shift / Finance / Cash control

## 1. Зорилго

Hotel-ийн физик бэлэн мөнгө яг аль касс/сейфэд, ямар хөдөлгөөнөөр, хэдийд нэмэгдсэн эсвэл хасагдсаныг immutable ledger-ээр хөтөлнө. Борлуулалт, deposit liability, expense болон мөнгийг нэг location-оос нөгөөд шилжүүлсэн ажиллагааг хооронд нь хольж тайлагнахгүй.

Restaurant order-ийн мөнгө hotel-ийн cash drawer-д орохгүй. QPay, Card/POS болон банкны дансны үлдэгдлийг cash drawer balance-д нэмэхгүй.

## 2. Cash location-ийн бүтэц

### 2.1 Төрөл

| Төрөл | Зориулалт | Reception shift нээх эсэх |
| --- | --- | ---: |
| `DRAWER` | Reception-ийн физик касс/ажлын цэг | ✓ |
| `SAFE` | Hotel-ийн optional дотоод сейф | — |

- Hotel subscription амжилттай activation болох үед нэг `Үндсэн касс` автоматаар үүснэ.
- Жижиг hotel нэг drawer-тай ажиллаж болно.
- Hotel Admin шаардлагатай бол `Reception 1`, `Reception 2` зэрэг олон drawer болон нэг optional safe үүсгэнэ.
- Cash drawer-ийн үндсэн ажиллагаа бүх 20,000₮/25,000₮/30,000₮ багцад байна.
- Drawer бүрийн balance тусдаа; мөнгө автоматаар холилдохгүй.
- Drawer/safe нэр, hotel дотор давхцахгүй code, physical location, status болон audit хадгална.

### 2.2 Constraint

- Нэг drawer дээр нэг агшинд зөвхөн нэг active shift байна.
- Нэг Reception account нэг hotel дотор нэг агшинд зөвхөн нэг active drawer shift-тэй байна.
- Drawer movement нь initial opening-оос бусад тохиолдолд тухайн drawer-ийн active shift-тэй холбоотой байна.
- Тухайн drawer оролцсон pending transfer байвал shift-ийг close/handover хийхгүй; transfer-ийг complete эсвэл мөнгийг source drawer-д бодитоор буцаан тоолж cancel болгосны дараа үргэлжлүүлнэ.
- Safe movement shift шаардахгүй боловч actor/effective time/reference-тэй байна.
- Ашиглагдсан drawer/safe-г hard delete хийхгүй; шинэ ажиллагаанд хаах бол `Inactive` болгоно.
- Active shift, pending transfer эсвэл бодит үлдэгдэлтэй location-ийг идэвхгүй болгохгүй.

## 3. Анхны opening balance

1. Hotel Admin drawer-ийг идэвхжүүлж, анхны expected float-ийг тохируулна.
2. Анхны Reception shift эхлүүлэхдээ кассан дахь мөнгийг бодитоор тоолно.
3. Бодитоор тоолсон дүн нь анхны actual opening balance болон drawer-ийг 0-ээс эхлүүлэх нэг удаагийн `INITIAL_FLOAT` movement болно.
4. Expected float-тай зөрвөл actual дүнгээр shift эхэлж, зөрүү нь Hotel Admin review-д орно.
5. `INITIAL_FLOAT` нь борлуулалт, deposit receipt эсвэл expense биш.

Жишээ:

```text
Hotel Admin-ийн configured float: 200,000₮
Reception-ийн actual count:       190,000₮

Анхны shift opening balance:      190,000₮
Анхны review variance:            -10,000₮
```

Анхны shift-ээс хойш opening balance-ийг гараар overwrite хийхгүй. Дараагийн shift нь SHIFT-DEC-001–007-ийн дагуу бодитоор хүлээн авсан/self-close үед тоолсон дүнгээр эхэлнэ. Нэмэлт мөнгийг `CASH_TOP_UP` хөдөлгөөнөөр бүртгэнэ.

`INITIAL_FLOAT` нь анхны shift эхлэхээс өмнөх location movement бөгөөд shift-ийн opening balance дээр дахин нэмэгдэхгүй. Дараагийн shift-үүдийн opening нь шинэ cash inflow/movement биш, өмнөх handover-ийн actual snapshot байна.

## 4. Immutable cash ledger

Cash movement бүр:

- positive amount;
- `IN` эсвэл `OUT` direction;
- батлагдсан movement type;
- cash location;
- drawer бол active shift;
- effective огноо/цаг;
- actor;
- шаардлагатай reason/reference;
- source business transaction эсвэл linked movement

хадгална.

Posted/Completed movement-ийг edit/delete хийхгүй. Алдааг reversal + зөв шинэ movement-ээр засна. Client тал balance илгээж overwrite хийхгүй.

- Active drawer-ийн expected balance = тухайн shift-ийн immutable actual opening snapshot + уг shift-ийн posted movement-ийн нийлбэр.
- Shift хоорондын handover actual count нь дараагийн shift-ийн шинэ immutable opening snapshot болохоос cash inflow movement биш.
- Safe shift-гүй тул safe balance нь posted IN − OUT movement-ийн нийлбэр байна.
- Өмнөх shift-ийн expected, actual, variance болон дараагийн opening snapshot бүгд тусдаа хадгалагдана.

### 4.1 Initial check-in backdate cash ledger-ийг буцаахгүй

`STAY-DEC-009`-өөр Reception initial confirmation дээр зөвшөөрөгдсөн нөхцөлөөр `actual_check_in_at`-ийг backdate хийсэн ч cash ledger-ийн source of time нь өөрчлөгдөхгүй:

- `check_in_recorded_at` нь server confirmation time бөгөөд backdate reason/actor/current shift-тэй аудитад хадгалагдана;
- deposit/payment/refund cash movement нь мөнгө бодитоор авсан/гаргасан үеийн active drawer, current open shift болон server effective time-д post хийгдэнэ;
- movement-ийг `actual_check_in_at` руу backdate хийхгүй, өмнөх shift-д нөхөн post хийхгүй;
- closed-shift expected/actual, current opening balance болон historical movement-ийг дахин байгуулахгүй;
- initial check-in backdate өөрөө cash movement, correction эсвэл нэмэлт approval үүсгэхгүй;
- stay active болсны дараа Reception direct edit хийхгүй; `STAY-DEC-010`-ын approved immutable amendment cash ledger-д side effect үүсгэхгүй.

### 4.2 Active stay actual-time amendment cash side effectгүй

Check-out эхлээгүй active stay дээр Reception actual-time correction request үүсгэж, Manager approve/reject хийнэ; Reception+Manager multi-role self-approval `self-approved` гэж тэмдэглэгдэнэ. Нэг pending request checkout initiation-ийг блоклож, terminal болохоос өмнө cash checkout/payment урсгал эхлэхгүй.

Approved amendment original event-ийг overwrite хийхгүй бөгөөд зөвхөн `effective_actual_check_in_at` derivation-д орно. Original `check_in_recorded_at`, original shift/local-day/Online planned-start anchor бүхий `STAY-DEC-009` window хэвээр. Cash movement-ийн original effective time, active/closed shift, drawer, payment/deposit/refund link, expected/actual cash болон opening/closing snapshot өөрчлөгдөхгүй. Amendment өөрөө cash movement, correction, reprice, historical reconstruction эсвэл financial approval үүсгэхгүй. Check-out эхэлсэн/дууссан stay-д request/approval хориглоно (`STAY-DEC-010`).

### 4.3 Planned checkout minimal guard cash side effectгүй

Confirmed booking эсвэл `ACTIVE` stay-ийн `planned_checkout_at`-ийг generic direct edit/PATCH-аар overwrite хийхгүй. MVP-д change байхгүй; STAY-DEC-011-ийн append-only history/revalidation нь зөвхөн post-MVP change хожим тусдаа батлагдвал мөрдөх invariant байна.

Minimal guard одоогоор хугацаа өөрчлөх button/API/action, taxonomy, permission/approval, eligibility, pricing/repricing, refund/payment дүрэм нээхгүй. Cash movement, drawer/shift/effective time, expected/actual cash, opening/closing snapshot, deposit/payment/refund transaction болон linked financial event immutable хэвээр; guard өөрөө ledger movement, correction, reclassification эсвэл reconciliation үүсгэхгүй.

### 4.4 P0-39C-2 — Planned-end complete lock cash side effectгүй

`STAY-DEC-012`-оор confirmed booking/active stay-ийн planned checkout MVP-д огт өөрчлөгдөхгүй. Amendment/action/button/API, extension, planned-end shorten болон hourly ↔ nightly conversion байхгүй. Early/late actual checkout зөвхөн `actual_checkout_at` бүртгэж original planned end-ийг өөрчлөхгүй.

Early actual checkout auto reprice/refund хийхгүй; overdue нь status/time л харуулж automatic fee/penalty, cash charge/payment/refund movement үүсгэхгүй. Room actual checkout хүртэл occupied, дараа нь snapshot buffer + clean + applicable minibar readiness gate үйлчилнэ. Cash movement, drawer/shift/effective time, expected/actual cash, opening/closing snapshot, deposit/payment/refund болон linked financial event immutable хэвээр.

## 5. Movement type

| Movement type | Direction | Drawer balance | Revenue/expense treatment |
| --- | ---: | ---: | --- |
| `INITIAL_FLOAT` | IN | Нэмэгдэнэ | Revenue/expense биш |
| `SERVICE_CASH_PAYMENT` | IN | Нэмэгдэнэ | Finalized service charge-ийн payment |
| `DEPOSIT_CASH_RECEIPT` | IN | Нэмэгдэнэ | Revenue биш; deposit liability |
| `SERVICE_CASH_REFUND` | OUT | Буурна | Service refund |
| `DEPOSIT_CASH_REFUND` | OUT | Буурна | Expense биш; deposit liability буурна |
| `PAID_CASH_EXPENSE` | OUT | Буурна | Paid expense/cash-outflow |
| `CASH_TOP_UP` | IN | Нэмэгдэнэ | Revenue биш |
| `DRAWER_TRANSFER_IN/OUT` | IN/OUT | Нэмэгдэнэ/буурна | Revenue/expense биш |
| `SAFE_TRANSFER_IN/OUT` | IN/OUT | Location-оор өөрчлөгдөнө | Hotel total physical cash өөрчлөгдөхгүй |
| `BANK_DEPOSIT_OUT` | OUT | Буурна | Expense биш |
| `OWNER_OTHER_WITHDRAWAL` | OUT | Буурна | Expense биш |
| `CASH_CORRECTION_IN/OUT` | IN/OUT | Нэмэгдэнэ/буурна | Шууд revenue/expense биш |

Deposit-ийг room/minibar payment-д allocation хийх нь шинэ cash movement үүсгэхгүй. QPay/Card/POS transaction cash ledger movement үүсгэхгүй.

## 6. Expected cash

```text
Expected drawer cash
= Opening balance
 + SERVICE_CASH_PAYMENT
 + DEPOSIT_CASH_RECEIPT
 + CASH_TOP_UP
 + DRAWER/SAFE_TRANSFER_IN
 + CASH_CORRECTION_IN
 - SERVICE_CASH_REFUND
 - DEPOSIT_CASH_REFUND
 - PAID_CASH_EXPENSE
 - DRAWER/SAFE_TRANSFER_OUT
 - BANK_DEPOSIT_OUT
 - OWNER_OTHER_WITHDRAWAL
 - CASH_CORRECTION_OUT
```

Shift close variance:

```text
Variance = Actual counted cash − Expected drawer cash
```

Drawer → Safe transfer drawer balance-ийг бууруулж safe balance-ийг нэмэх боловч hotel-ийн нийт physical cash-ийг өөрчлөхгүй. Bank/owner withdrawal physical cash-ийг бууруулах боловч business expense гэж автоматаар ангилахгүй.

### 6.1 Зарцуулж болох үлдэгдэл

`Available to spend = Posted balance − Active outgoing reservations`.

- Physical debit болон шинэ transfer reservation бүр `amount <= available_to_spend` нөхцөлтэй. Бүх involved location-ийг тогтмол ID дарааллаар lock хийж, ижил transaction-д дахин шалгана.
- Transfer initiation reservation үүсгэнэ. Recipient confirm үед reservation release + source OUT + destination IN + terminal state нэг атомик commit байна.
- Cancel нь source Reception бодит буцсан мөнгийг бүрэн тоолж баталсны дараа reservation release хийнэ. Partial/missing return үед pending хэвээр; variance/reconciliation шаардлагатай, мөнгийг суллахгүй.
- Source/destination shift өөрчлөгдөхгүй; pending transfer-тай shift хаагдахгүй. Hotel total posted cash transfer-ээр өөрчлөгдөхгүй.
- Idempotency key нь hotel + command scope-д unique; ижил key/өөр payload conflict. Duplicate submit/retry balance, reservation, movement, audit-ийг давхар үүсгэхгүй.
- Posted balance, reserved/in-transit amount, available balance-ийг тусад нь харуулна. Accounting-only correction энэ physical debit дүрмээр хийсвэр бэлэн мөнгө бий болгохгүй.

## 7. Customer payment, deposit болон refund

- Reception existing payment/deposit permission-ийн хүрээнд cash receipt/refund movement үүсгэнэ.
- Cash movement нь stay/invoice/deposit/refund record-тэй 1:1 эсвэл тодорхой allocation холбоостой байна.
- Refund нь батлагдсан refund lifecycle-ийн дараа effective болно.
- Provider payment/refund амжилттай болсон ч cash drawer movement үүсэхгүй.
- Restaurant payment/refund ямар ч hotel drawer/shift movement үүсгэхгүй.

## 8. Cash expense execution

### 8.1 Lifecycle

```text
Draft → Submitted → Approved for payment → Paid
                  ↘ Rejected
```

- Manager/Manager Plus expense хүсэлт үүсгэж `Submitted` болгоно.
- Hotel Admin `Approved for payment` эсвэл `Rejected` шийдвэр гаргана.
- Approval нь мөнгө кассаас гарсан гэсэн үг биш.
- Reception, Manager/Manager Plus эсвэл Hotel Admin батлагдсан хүсэлтийг active drawer-аас бодитоор төлөх үед `PAID_CASH_EXPENSE` movement болон `Paid` төлөв нэг атомик ажиллагаагаар үүснэ.
- Execution actor approved amount/category/expense type-ийг өөрчлөхгүй. Дүн өөр бол шинэ approval шаардана.
- Зөвхөн `Paid` expense financial KPI/Excel болон cash-outflow-д орно.
- `Approved for payment` боловч төлөгдөөгүй хүсэлт drawer balance, expense KPI болон cash-outflow-д орохгүй.
- Hotel Admin өөрийн expense-ийг үүсгэж approve хийж, бодитоор төлж болно; `self-approved` болон execution actor аудиттай байна.
- Card/POS болон bank/QPay expense payment нь [23-admin-financial-reporting.md](./23-admin-financial-reporting.md)-ийн ижил `Paid` lifecycle-ийг ашиглах боловч `PAID_CASH_EXPENSE` болон бусад cash movement үүсгэхгүй.

## 9. Transfer, top-up болон withdrawal

### 9.1 Drawer → Drawer

1. Manager/Manager Plus transfer эхлүүлнэ.
2. Хүлээн авах drawer-ийн Reception мөнгийг бодитоор тоолно.
3. Дүн зөв бол recipient confirm хийхэд source `OUT` болон destination `IN` movement нэг атомик completion болно.
4. Pending transfer posted balance-д орохгүй боловч source available balance-аас reservation-аар хасагдана (CASH-DEC-011). Дүн зөрвөл confirm хийхгүй, дахин тоолно эсвэл cancel хийнэ.

Transfer үүсэхэд source/destination drawer болон тухайн үеийн хоёр active shift ID immutable холбоостой хадгалагдана; confirm үед өөр shift-ээр сольж post хийхгүй. Source болон destination drawer хоёул active shift-тэй байна. Хоёр movement нэг transfer ID-тай байна.

Pending transfer оролцсон source/destination shift-ийг хаахгүй. Cancel хийх бол initiator Manager/Manager Plus хүсэлт гаргаж, мөнгө source drawer-д бодитоор буцсан дүнг source Reception дахин тоолж батална. Дараа нь transfer `Cancelled` болох бөгөөд cash movement үүсгэхгүй; reason/actor/time аудиттай байна.

### 9.2 Drawer ↔ Safe

- Manager/Manager Plus эсвэл Hotel Admin гүйцэтгэнэ.
- Нэмэлт approval шаардахгүй.
- Amount, source/destination, reason, actor болон effective time заавал.
- Drawer side active shift-тэй, safe side shift-гүй байна.
- Transfer хоёр linked movement-ээр атомик posted болно.

### 9.3 Bank deposit

- Manager/Manager Plus хүсэлт үүсгэнэ.
- Hotel Admin approve хийнэ.
- Банкны transaction/reference эсвэл deposit receipt заавал байна.
- Drawer эсвэл safe-аас `BANK_DEPOSIT_OUT` үүснэ.
- Банкны balance-ийг cash ledger хөтлөхгүй; энэ movement нь physical cash location-оос гарсныг л тэмдэглэнэ.
- Bank deposit нь expense биш.

### 9.4 Owner/other withdrawal

- Manager/Manager Plus хүсэлт үүсгэж болно; Hotel Admin approve хийнэ.
- Hotel Admin шууд үүсгэж approve хийж болно; self-approved audit хадгална.
- Destination/recipient болон reason заавал.
- Expense гэж автоматаар тооцохгүй.

### 9.5 Cash top-up

- Manager/Manager Plus эсвэл Hotel Admin бүртгэнэ.
- Source болон reason заавал.
- `CASH_TOP_UP` revenue биш.
- Opening balance-ийг overwrite хийхгүй.

## 10. Correction-ийн shift ба reporting date

- Хаагдсан shift, original expected/actual cash болон дараагийн opening balance-ийг буцааж өөрчлөхгүй.
- Correction бодитоор хэрэгжсэн effective огноо/цагт бүртгэгдэнэ; backdate хийхгүй.
- Drawer-д бодитоор мөнгө нэмэгдсэн/хасагдсан correction нь тухайн үеийн active drawer shift-д `CASH_CORRECTION_IN/OUT` болно.
- Original shift/movement ID, reason, actor, reviewer/approver болон effective time хадгална.
- Ердийн shift correction-ийг Manager/Manager Plus review actor шийднэ. Тухайн Manager өөрөө original cash actor байсан эсвэл self-close correction бол Hotel Admin review хийнэ. Өөр review actor байхгүй жижиг hotel-д батлагдсан `self-reviewed` fallback аудиттай үйлчилнэ.
- Зөвхөн accounting classification өөрчлөгдөж, физик cash хөдөлгөөнгүй бол cash movement үүсгэхгүй; холбогдох financial ledger correction л үүснэ.
- Cash correction нь sales/expense-ийг автоматаар өөрчлөхгүй. Source нь payment/refund/expense-ийн алдаа болох нь тогтоогдвол тухайн source ledger-ийн reversal/correction урсгалыг давхар ашиглана.

## 11. Эрхийн хуваарилалт

| Үйлдэл | Hotel Admin | Manager | Manager Plus | Reception |
| --- | ---: | ---: | ---: | ---: |
| Drawer/safe үүсгэх, идэвхгүй болгох | ✓ | — | — | — |
| Configured initial float тохируулах | ✓ | — | — | — |
| Анхны/shift actual cash count | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ |
| Customer cash receipt/refund | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ |
| Approved cash expense execute | ✓ | ✓ | ✓ | ✓, approved request only |
| Drawer → Drawer transfer initiate/cancel request | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — |
| Drawer → Drawer cancel return confirm | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ |
| Drawer → Drawer receive/confirm | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ |
| Drawer ↔ Safe transfer | ✓ | ✓ | ✓ | — |
| Bank deposit request | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — |
| Bank deposit approve | ✓ | — | — | — |
| Owner/other withdrawal request | ✓ | ✓ | ✓ | — |
| Owner/other withdrawal approve | ✓ | — | — | — |
| Cash top-up | ✓ | ✓ | ✓ | — |
| Shift cash correction review | Exception/self-review | ✓, original actor биш | ✓, original actor биш | — |
| Full cash report/export | ✓ | — | — | — |
| Өөрийн operational drawer/shift | Review | ✓ | ✓ | ✓ |

Hotel Admin customer cash operational action хийх бол Reception role тусдаа шаардлагатай. Manager/Manager Plus customer receipt/refund хийх бол мөн Reception role шаардлагатай.

## 12. Reporting

Hotel Admin дараахыг тусдаа харна:

- drawer бүрийн current balance;
- optional safe balance;
- hotel-ийн нийт physical cash = бүх drawer + safe;
- movement type/date/actor/location breakdown;
- pending transfer болон approved-for-payment боловч unpaid expense;
- bank deposit болон owner/other withdrawal;
- cash correction ба original холбоос.

Report date нь movement-ийн effective time-ийг hotel timezone-аар ашиглана. Cash transfer/top-up/withdrawal-ийг revenue/expense KPI-д автоматаар оруулахгүй. Зөвхөн `Paid` болсон cash expense нь expense KPI/Excel болон cash-outflow-д орно.

Manager/Manager Plus өөрийн удирдсан operational drawer/shift болон approval ажилд шаардлагатай breakdown-ийг харна. Reception зөвхөн өөрийн active shift, түүнтэй холбоотой хөдөлгөөн болон expected/actual cash-ийг харна. Full cash report/export зөвхөн Hotel Admin-д байна.

## 13. Аудит ба хамгаалалт

- Hotel ID/location ID/shift ID бүх query/action-д server-side шалгагдана.
- Amount `> 0`; direction болон type-ийг server тогтооно.
- Idempotency key/source reference давхар cash movement-ээс хамгаална.
- Completed movement, completed transfer болон Paid expense-ийг edit/delete хийхгүй.
- Drawer, shift, expense, payment, deposit, refund, transfer болон correction холбоосыг ID-аар хадгална.
- Drawer/location create/update/deactivate, initial float, count, receipt/refund, expense execution, transfer, withdrawal, top-up, correction/reversal болон approval бүр аудиттай байна.
- Backdated initial check-in-тэй cash source link нь `actual_check_in_at`, server `check_in_recorded_at`, reason/actor болон тухайн бодит movement-ийн shift/effective time-ийг тусад нь хадгална.
- Active-stay actual-time amendment link нь original/requested/effective actual time, requester/Manager decision, reason, boundary anchors болон `self-approved` flag-ийг хадгалж, cash movement/shift/effective time өөрчлөгдөөгүйг нотлоно.
- Sensitive full cash report/export зөвхөн Hotel Admin permission, hotel scope болон export audit-тай байна.

## 14. MVP acceptance criteria

- Hotel activation-д нэг `Үндсэн касс` автоматаар үүснэ.
- Hotel Admin олон drawer болон optional safe үүсгэж чадна.
- Нэг drawer-д нэг active shift, нэг Reception-д нэг active drawer shift байна.
- First actual count анхны opening болно; configured float-ийн зөрүү review-д орно.
- Initial float, top-up, transfer, bank/owner withdrawal revenue/expense гэж автоматаар тооцогдохгүй.
- Customer cash payment/deposit/refund source transaction-тай холбоотой movement үүсгэнэ.
- QPay/Card/POS болон Restaurant transaction drawer balance-д орохгүй.
- Expected cash approved movement type-уудаар зөв бодогдоно.
- Drawer transfer recipient confirmation үед linked IN/OUT-оор атомик complete болно.
- Pending drawer transfer complete/cancel болоогүй бол оролцсон shift хаагдахгүй.
- Transfer-ийн source/destination drawer/shift initiation үед түгжигдэнэ; cancel хийхэд source Reception буцсан cash-ийг дахин тоолж батална.
- Drawer ↔ Safe transfer hotel total physical cash-ийг өөрчлөхгүй.
- Bank deposit reference/receipt болон Hotel Admin approval-тай байна.
- Expense approval мөнгө гарсныг илэрхийлэхгүй; cash method-ийг active drawer-аас execute хийх үед Paid + cash movement үүснэ.
- Зөвхөн Paid expense KPI/Excel/cash-outflow-д орно.
- Opening/closed shift overwrite хийхгүй; correction effective өдөр/current active shift-д орно.
- Physical movement-гүй accounting correction cash ledger-д орохгүй.
- Initial check-in-ийн backdated `actual_check_in_at` нь cash movement-ийг prior shift/historical effective time руу шилжүүлэхгүй, opening/closing snapshot дахин байгуулахгүй, өөрөө шинэ movement/approval үүсгэхгүй.
- Approved active-stay actual-time amendment cash movement/shift/drawer/effective time/expected cash/opening balance-ийг өөрчлөхгүй; pending request checkout initiation-ийг блоклоно.
- Confirmed booking/active stay-ийн planned checkout change MVP-д байхгүй; STAY-DEC-011 amendment invariant зөвхөн post-MVP-д үйлчилнэ.
- Minimal guard өөрөө cash/payment/refund action, permission/approval, repricing, movement эсвэл opening/closing snapshot өөрчлөхгүй.
- Early/late actual checkout original planned end-д хүрэхгүй; early auto reprice/refund, overdue auto fee/penalty/cash movement үүсгэхгүй.
- Room actual checkout хүртэл occupied; C2 cash/shift/drawer/snapshot side effectгүй.
- Completed movement immutable, бүх action audit болон server scope enforcement-тэй байна.

## 15. Батлагдсан шийдвэр

### CASH-DEC-001 — Default ба multiple drawer

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel activation-д нэг `Үндсэн касс` үүснэ. Бүх багцад олон тусдаа drawer дэмжиж, нэг drawer-д нэг active shift, нэг Reception-д нэг active drawer shift байна.

### CASH-DEC-002 — Optional safe

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel Admin optional safe cash location үүсгэж болно. Safe shift нээхгүй; drawer ↔ safe нь linked movement бөгөөд hotel total physical cash өөрчлөхгүй.

### CASH-DEC-003 — Actual initial opening

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel Admin configured float тохируулж, анхны Reception бодитоор тоолсон дүн actual opening/INITIAL_FLOAT болно. Зөрүү review-д орно; initial float revenue/expense биш.

### CASH-DEC-004 — Typed immutable ledger

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Cash balance-ийг approved typed movement-ээр бодно. Completed movement edit/delete хийхгүй; reversal + corrected movement ашиглана.

### CASH-DEC-005 — Paid expense execution

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Expense `Approved for payment` болсон нь cash-outflow биш. Active drawer-аас бодитоор execute хийхэд `Paid` + `PAID_CASH_EXPENSE` атомик үүсэж, зөвхөн тэр үед KPI/Excel-д орно.

### CASH-DEC-006 — Transfer

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Drawer transfer-ийн source/destination drawer/shift initiation үед immutable холбоостой болно. Recipient confirm үед linked OUT/IN-оор атомик complete болно. Drawer ↔ safe linked movement байна; pending transfer posted balance-д орохгүй боловч source available balance-аас reservation-аар хасагдаж, complete/cancel болоогүй transfer оролцсон shift хаагдахгүй. Cancel хийхэд source Reception буцсан cash-ийг дахин тоолж батална.

### CASH-DEC-007 — Bank ба owner withdrawal

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Bank deposit болон owner/other withdrawal Hotel Admin approval-тай, expense биш. Bank deposit reference/receipt, owner withdrawal recipient/reason заавал байна.

### CASH-DEC-008 — Top-up

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Top-up source/reason-тэй шинэ IN movement байна; opening balance-ийг overwrite хийхгүй, revenue гэж тооцохгүй.

### CASH-DEC-009 — Effective-date correction

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Physical cash correction backdate хийхгүй; effective өдөр/current active shift-д linked movement болно. Accounting-only correction cash movement үүсгэхгүй, generic correction sales/expense-ийг автоматаар өөрчлөхгүй.

### CASH-DEC-010 — Permission ба reporting

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel Admin location/full report/approval, Manager/Manager Plus operational transfer/request/review, Reception өөрийн shift/customer cash/approved payout execution хүрээтэй. Hotel Admin drawer transfer болон bank-deposit request хийх бол нэмэлт Manager/Manager Plus role авна; owner/other withdrawal-ийг self-approved audit-тай өөрөө үүсгэж болно. Full cash report/export зөвхөн Hotel Admin-д байна.

### CASH-DEC-011 — Outgoing reservation ба concurrent cash debit

- **Төлөв:** 2026-09-06 хэрэглэгчийн зөвшөөрлөөр батлагдсан (R02).
- **Шийдвэр:** §6.1-ийн available invariant бүх physical debit-д үйлчилнэ. Pending transfer source reservation-тай; confirm linked OUT/IN + release, cancel бодит cash return-ийн дараах release байна. Нэг transaction/version хамгаалалт, canonical shift binding болон idempotency шаардлагатай. 100,000₮ posted, 80,000₮ reserved үед 50,000₮ debit reject; 20,000₮ debit зөвшөөрнө.

## 16. Дараагийн баталгаажуулах нэг асуудал

P0-35–P0-39 хаагдсан. Selling price-ийн source of truth нь [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md), stay time/conflict-ийн canonical шийдвэр нь [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md)-ийн `STAY-DEC-008`–`014`. Amendment, planned-end lock, overdue conflict болон fractional hourly precision нь өмнөх cash ledger/shift event-д side effectгүй.
