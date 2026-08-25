# Hotel Admin financial dashboard ба Excel тайлан

**Хувилбар:** 1.10  
**Төлөв:** MVP financial reporting, P0-37, P0-38 болон P0-39A–P0-39C-2 батлагдсан  
**Хамаарах үе шат:** MVP — Hotel Admin / Reporting / Finance

## 1. Зорилго

Hotel-ийн борлуулалт, бодитоор орж ирсэн мөнгө, авлага, барьцаа, буцаалт, зарлага болон ашгийг хооронд нь хольж буруу тайлагнахаас хамгаална.

Full financial dashboard болон financial Excel-ийг зөвхөн **Hotel Admin** харна. Manager/Manager Plus, Reception болон Cleaner-ийн operational мэдээллийг full financial тайлантай адилтгахгүй.

## 2. Тусдаа хадгалах санхүүгийн ойлголтууд

### 2.1 Баталгаажсан борлуулалт

```text
Баталгаажсан нийт борлуулалт
= Finalized room charge
+ Finalized minibar charge
+ Бусад батлагдсан hotel service charge

Цэвэр борлуулалт
= Баталгаажсан нийт борлуулалт
− Хөнгөлөлт
− Төлбөрөөс чөлөөлсөн adjustment
− Sales reversal/refund adjustment
```

- Борлуулалт нь төлөгдсөн эсэхээс үл хамааран finalized charge line байна.
- Room charge-ийн `recognized_at` нь тухайн charge эцэслэгдсэн мөч; ердийн үед checkout, харин өрөөний төлбөрийг урьдчилан эцэслэн авсан бол тухайн баталгаажсан мөч байна.
- Finalized room charge нь тухайн Walk-in confirmation эсвэл paid/confirmed Online booking-д хадгалсан room-rate snapshot-ийг ашиглана. Цагийн/хоногийн unit price, source level + source ID болон configuration version-ийг current tariff table-аас дахин resolve хийж historical charge-ийг reprice хийхгүй.
- Actual check-out эрт/орой болсон эсвэл cleaning-buffer readiness шилжсэн нь дангаараа finalized charge, refund/reversal эсвэл payment үүсгэхгүй. Early actual checkout automatic reprice/refund хийхгүй; overdue status/time automatic fee/penalty нэмэхгүй (`STAY-DEC-012`).
- `STAY-DEC-010`-ын approved active-stay actual-time amendment нь operational actual-start field-ийг л өөрчилнө. Room/minibar charge, tariff/price/config/stock snapshot, deposit/payment/cash эсвэл тэдгээрийн recognized/effective/shift time-ийг өөрчлөхгүй, шинэ financial movement/reprice/reconstruction үүсгэхгүй.
- `STAY-DEC-011`-ийн дагуу confirmed booking эсвэл `ACTIVE` stay-ийн `planned_checkout_at` direct overwrite хоригтой; append-only amendment invariant нь зөвхөн post-MVP change хожим тусдаа батлагдвал үйлчилнэ. `STAY-DEC-012`-оор MVP-д amendment/action/button/API, extension, planned-end shorten болон hourly ↔ nightly conversion бүхэлдээ байхгүй. Өмнөх charge/payment/cash/recognized time болон room/minibar/config/stock snapshot immutable хэвээр.
- Early/late actual checkout зөвхөн `actual_checkout_at` бүртгэж original planned end-ийг өөрчлөхгүй. Room actual checkout хүртэл occupied; дараа нь snapshot buffer + clean + applicable minibar readiness gate үйлчилнэ. Энэ дүрэм financial/reporting side effect үүсгэхгүй.
- Minibar charge-ийн `recognized_at` нь хүчинтэй report/payment line эцэслэгдсэн мөч байна.
- Restaurant order/payment энэ hotel борлуулалтад орохгүй.

### 2.2 Орж ирсэн үйлчилгээний төлбөр

```text
Орж ирсэн үйлчилгээний төлбөр
= SUCCESS болсон QPay/Card/бэлэн service payment
− Тухайн хугацаанд SUCCESS болсон service refund
```

- Payment-ийг зөвхөн provider/server эсвэл cash transaction амжилттай баталгаажсан үед тооцно.
- Pending/failed/cancelled payment-ийг орж ирсэн мөнгө гэж үзэхгүй.
- QPay, Card/POS, бэлэн мөнгийг тусдаа breakdown-аар харуулна.
- Барьцаа авахыг service payment/revenue гэж тооцохгүй.
- Барьцааг room/minibar charge-д allocation хийх нь шинэ cash receipt биш; борлуулалтын төлбөрт хуваарилсан liability conversion байна.

### 2.3 Авлага

```text
Авлага
= max(0,
     Цэвэр finalized charge
     − Амжилттай payment allocation
     − Төлбөрт ашигласан deposit allocation)
```

Илүү төлөлт болон буцаах барьцааг авлагыг сөрөг болгохгүй; тусдаа liability/refund balance болгоно.

### 2.4 Барьцаа

- Авсан боловч ашиглаагүй/буцаагаагүй deposit нь `Хадгалж буй барьцаа` байна.
- Deposit receipt нь revenue биш.
- Room/minibar charge-д ашигласан дүн борлуулалтын төлөлт болно, гэхдээ тухайн өдөр дахин cash inflow үүсгэхгүй.
- Буцаасан deposit нь service refund/expense биш; deposit liability буурсан хөдөлгөөн байна.

### 2.5 Буцаалт ба залруулга

- Refund/reversal нь амжилттай болсон огноондоо сөрөг хөдөлгөөнөөр харагдана.
- Өмнөх өдөр/сарын original transaction-ийг буцааж edit/delete хийхгүй.
- Original, reversal, corrected transaction болон report/export мөрүүд холбоостой байна.

## 3. Profit ба margin

### 3.1 Minibar gross profit

```text
Minibar net sales
= Minibar finalized sales
− Minibar discount/waiver/reversal

Minibar COGS
= Борлуулсан бүтээгдэхүүний тоо
× Inventory movement-ийн weighted average unit cost snapshot

Minibar gross profit
= Minibar net sales − Minibar COGS

Minibar gross margin %
= Minibar gross profit / Minibar net sales × 100
```

Minibar net sales 0 эсвэл түүнээс бага бол margin%-ийг `N/A` гэж харуулна.

Weighted average cost-ийн canonical дүрмийг [22-minibar-stock-inventory.md](./22-minibar-stock-inventory.md)-д тодорхойлно.

Minibar finalized sales-ийн selling unit price нь [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md)-д баталсан check-in stay price book-оос ирнэ. Current product price active/historical sale-г reprice хийхгүй.

### 3.2 Үйл ажиллагааны тооцоолсон үр дүн

```text
Үйл ажиллагааны тооцоолсон үр дүн
= Hotel-ийн цэвэр борлуулалт
− Minibar COGS
− Paid болсон P&L operating expense
```

```text
Үйл ажиллагааны margin %
= Үйл ажиллагааны тооцоолсон үр дүн
 / Hotel-ийн цэвэр борлуулалт × 100
```

Цэвэр борлуулалт 0 эсвэл түүнээс бага бол margin%-ийг `N/A` гэж харуулна.

Энэ үзүүлэлтийг албан ёсны нягтлан бодох бүртгэлийн `Цэвэр ашиг` гэж нэрлэхгүй. Татвар, элэгдэл, цалин/өглөг, settlement, provider fee болон бусад бүртгэл бүрэн батлагдаагүй үед **`Үйл ажиллагааны тооцоолсон үр дүн`** гэж харуулна.

### 3.3 Inventory purchase ба COGS-ийг давхар хасахгүй

Minibar бараа худалдан авсан мөнгө нь cash-outflow болон inventory value байна. Ашиг тооцоход бүх худалдан авалтыг тэр даруй дахин P&L expense болгохгүй; борлуулсан барааны weighted average COGS-ийг ашиглана.

Жишээ:

```text
100 ус худалдаж авсан cash-outflow: 100,000₮
Тухайн хугацаанд борлуулсан: 10 ус
Нэгж weighted average cost: 1,000₮

Profit calculation-д орох COGS: 10,000₮
100,000₮ болон 10,000₮-ийг зэрэг хасахгүй.
```

Room minibar configuration reconciliation-ийн room ↔ warehouse return/refill/rollback transfer нь hotel-ийн нийт нөөцийг өөрчлөхгүй бөгөөд guest consumption, sale, revenue эсвэл sales COGS үүсгэхгүй. Reconciliation үеийн эвдэрсэн/алга болсон stock-ийг Manager тусдаа reason-тэй waste/adjustment болгосон бол existing inventory loss дүрмээр тайлагнана. Иймээс Template A → B, ON → OFF эсвэл OFF → ON хийхэд барааны байршил солигдсоныг minibar борлуулалт гэж financial dashboard-д нэмэхгүй.

## 4. Зарлагын төрөл ба lifecycle

### 4.1 Хоёр тайлагналын төрөл

| Төрөл | Cash-outflow | Operational profit-д expense болох эсэх |
| --- | ---: | ---: |
| `Inventory purchase` | Бодитоор төлсөн бол ✓ | Шууд биш; борлуулсан үед COGS |
| `Operating expense` | Бодитоор төлсөн бол ✓ | `Paid` болсон дүнгээр ✓ |

Stock receipt-ийн quantity/cost нь inventory value үүсгэнэ. Cash-outflow тайланд оруулах inventory purchase expense нь тухайн stock receipt-тэй холбоотой байна. Нэг stock receipt-ийг давхар expense болгон бүртгэхгүй.

MVP-д financial report-д орох expense нь **бодитоор төлөгдсөн cash-outflow** байна. Expense date нь `Paid` болсон бодит payment/effective огноо байна. `Approved for payment` боловч төлөгдөөгүй хүсэлтийг expense KPI/cash-outflow-д оруулахгүй; өглөгийн тусдаа lifecycle нь MVP-ийн энэ тайлангийн scope-д орохгүй. Stock receipt нь бараа бодитоор орж ирэхэд үүсэж болох боловч түүнтэй холбоотой cash-outflow нь төлбөр бодитоор хийгдсэн үед л expense тайланд орно.

### 4.2 Expense төлөв

```text
Draft → Submitted → Approved for payment → Paid
                  ↘ Rejected
Paid → Reversal/Correction, хэрэв алдаатай бол
```

- Manager/Manager Plus expense хүсэлт үүсгэж `Submitted` болгоно.
- Hotel Admin `Approved for payment` эсвэл `Rejected` болгоно.
- Approval нь мөнгө бодитоор гарсныг илэрхийлэхгүй.
- Reception, Manager/Manager Plus эсвэл Hotel Admin approved request-ийн бодит төлбөрийг execute хийнэ.
- Бэлэн төлбөр бол active drawer-аас execute хийх үед expense `Paid` болж, `PAID_CASH_EXPENSE` movement атомикаар үүснэ.
- Card/POS эсвэл bank/QPay төлбөр бол transaction/provider reference заавал хадгалж, expense `Paid` болно; cash drawer movement үүсэхгүй. Provider-тэй integrated гүйлгээнд provider/server success шаардана.
- Approved amount, expense type/category эсвэл payment method-ийг executor өөрчлөхгүй; өөрчлөх бол request-ийг дахин submit/approve хийнэ.
- Draft/Submitted/Approved for payment/Rejected хүсэлт financial expense KPI болон paid cash-outflow-д орохгүй.
- Paid expense-ийг edit/delete хийхгүй; correction reason-тэй reversal + шинэ зөв expense ашиглана.
- Жижиг hotel-д Hotel Admin өөрийн үүсгэсэн expense-ийг approve хийж бодитоор төлж болно; audit-д self-approved болон execution actor-ийг ялгана.

### 4.3 Expense-ийн заавал талбар

- requested/created date;
- expense type: `Inventory purchase` эсвэл `Operating expense`;
- category;
- 0-ээс их дүн;
- payment method: бэлэн, карт/POS, банк/QPay;
- тайлбар;
- submitted/created user;
- status;
- approved/rejected user болон огноо/цаг;
- Paid бол payment effective date болон executor;
- cash payment бол drawer/shift/cash movement ID;
- Card/POS эсвэл bank/QPay бол transaction/provider reference.

Нийлүүлэгч болон зураг/баримт нь optional байна.

### 4.4 Default category

- Minibar бараа татан авалт;
- Цэвэрлэгээний материал;
- Засвар үйлчилгээ;
- Цахилгаан, ус, дулаан;
- Түрээс;
- Цалин/урамшуулал;
- Татвар, хураамж;
- Бусад.

Hotel Admin custom category үүсгэж, нэр/төрлийг удирдана. Ашиглагдсан category-г hard delete хийхгүй; идэвхгүй болгоно.

## 5. Dashboard-ийн KPI карт

Hotel Admin сонгосон хугацаанд:

1. Баталгаажсан нийт борлуулалт;
2. Цэвэр борлуулалт;
3. Орж ирсэн үйлчилгээний төлбөр;
4. Авлага;
5. Амжилттай refund/reversal;
6. Paid operating expense;
7. Inventory purchase cash-outflow;
8. Minibar COGS;
9. Minibar gross profit ба margin%;
10. Үйл ажиллагааны тооцоолсон үр дүн ба margin%;
11. Хадгалж буй барьцаа

харна.

Payment breakdown нь QPay, Card/POS, бэлэн болон deposit allocation-ийг тусдаа харуулна. Deposit allocation-ийг шинэ cash inflow-д нэмэхгүй.

## 6. Огноо, хугацаа болон график

### 6.1 Quick filter

- **Сүүлийн 7 хоног:** hotel-ийн өнөөдөр болон өмнөх 6 календарь өдөр.
- **Энэ сар:** тухайн сарын 1-нээс өнөөдрийн төгсгөл хүртэл.
- **Custom:** эхлэх болон дуусах календарь огноо.

Бүх тайлан hotel-ийн timezone ашиглана. Улаанбаатарын hotel-д `Asia/Ulaanbaatar` байна. Сервер дотроо хугацааг давхцалгүй `[start_at, end_at)` интервалаар query хийнэ.

### 6.2 Огнооны суурь

| Тайлан | Ашиглах огноо |
| --- | --- |
| Борлуулалт | Charge-ийн `recognized_at` |
| Орж ирсэн мөнгө | Payment success/effective time |
| Expense | Payment/effective time; зөвхөн Paid |
| Refund/reversal | Success/effective time |
| Top-5 room | Stay-ийн actual checkout time |
| Deposit held | Сонгосон хугацааны төгсгөлийн үлдэгдэл snapshot |

### 6.3 График

7 хоног, сар болон custom хугацааг календарь өдрөөр aggregate хийнэ. Өдөр бүр:

- room net sales;
- minibar net sales;
- paid operating expense;
- inventory purchase cash-outflow;
- refund/reversal;
- үйл ажиллагааны тооцоолсон үр дүн

тусдаа series байна. Үйлдэлгүй өдрийг 0 гэж харуулна.

Нэмэлт payment-channel breakdown нь QPay, Card/POS, бэлэн болон deposit allocation-ийг харуулна.

## 7. Top-5 өрөө

### 7.1 `Эрэлтээр` үндсэн эрэмбэ

Сонгосон хугацаанд actual checkout нь багтсан, `Completed`, цуцлагдаагүй stay-ийн тоогоор буурахаар эрэмбэлнэ.

- Cancelled/no-show stay орохгүй.
- Төлөгдөөгүй авлагатай боловч бодитоор completed stay нь demand count-д орно.
- Ижил stay count-тай бол room net sales ихийг эхэнд тавина.
- Дахин тэнцвэл өрөөний дугаараар тогтвортой эрэмбэлнэ.

### 7.2 `Орлогоор` сонголт

Room net sales-аар буурахаар эрэмбэлж top-5 харуулна. UI-д `Эрэлтээр` default, `Орлогоор` toggle байна.

### 7.3 Харагдах багана

- өрөөний дугаар;
- room category;
- completed stay count;
- hourly stay count;
- nightly stay count;
- нийт ашигласан хугацаа;
- room gross sales;
- room net sales.

## 8. Excel export

Hotel Admin дараах дөрвөн тусдаа Excel export ашиглана. Export бүр Hotel ID, сонгосон filter, timezone, generated time болон actor-той audit record үүсгэнэ.

Financial export-д guest-ийн регистр, утас, гэрийн хаяг болон шаардлагагүй хувийн мэдээлэл оруулахгүй.

### 8.1 Room sales Excel

Багана:

- Дэс дугаар;
- Stay/booking дугаар;
- Өрөөний дугаар, category;
- Hourly/nightly төрөл;
- Snapshot unit price;
- Tariff source level, source ID болон configuration version;
- Effective actual check-in/check-out (`effective_actual_check_in_at`/`actual_checkout_at`);
- Room gross charge;
- Discount/waiver/adjustment;
- Room net sales;
- Allocated payment amount;
- Receivable amount;
- Payment status;
- Payment channel;
- Charge recognized date.

`Actual check-in` багана нь original value эсвэл latest approved immutable amendment-аас derivation хийсэн `effective_actual_check_in_at`-ийг харуулна. Original `actual_check_in_at`, `check_in_recorded_at` болон amendment chain аудитад хэвээр байна. Харин sale/charge recognized date, payment/refund/cash effective time болон shift нь өөрсдийн immutable server event time-ийг ашиглана. `STAY-DEC-009` initial backdate болон `STAY-DEC-010` active-stay amendment эдгээр санхүүгийн event-ийг өмнөх өдөр/shift/тайлангийн хугацаанд шилжүүлэхгүй; тайлангийн шүүлтүүр бүр сонгосон business date source-оо ил тод хэрэглэнэ.

`Planned checkout` багана MVP-д confirmation үеийн original locked value-г л харуулна; effective amendment/projected value байхгүй. Early/late үед тусдаа `Actual checkout` болон overdue status/time харагдаж болох ч planned end, historical row/amount/date, KPI/Excel-ийг rewrite хийхгүй (`STAY-DEC-012`).

Filter: date range, room, room category, stay type, payment status/channel.

### 8.2 Minibar sales ба profit Excel

Багана:

- Дэс дугаар;
- Stay/receipt дугаар;
- Өрөө;
- Product, product category;
- Quantity;
- Selling unit price;
- Gross sales;
- Discount/waiver/reversal;
- Net sales;
- Weighted average unit cost snapshot;
- COGS;
- Gross profit;
- Gross margin %;
- Payment status;
- Charge recognized date.

Filter: date range, room, product/category, payment status.

### 8.3 Expense Excel

Багана:

- Дэс дугаар;
- Expense дугаар, огноо;
- Expense type/category;
- Тайлбар;
- Нийлүүлэгч, хэрэв оруулсан бол;
- Amount;
- Payment method;
- Status;
- Холбоотой stock receipt, хэрэв байгаа бол;
- Submitted/created by;
- Approved/rejected by болон огноо;
- Paid at, payment reference, executor болон cash бол drawer/shift.

Filter: date range, expense type/category, payment method, status, submitted user.

### 8.4 Payment breakdown Excel

Багана:

- Дэс дугаар;
- Payment/provider/POS reference;
- Stay/invoice дугаар;
- Channel;
- Gross payment;
- Room allocation;
- Minibar allocation;
- Other hotel service allocation;
- Deposit allocation;
- Refund/reversal;
- Net successful payment;
- Status;
- Success/effective date.

Filter: date range, channel, status, room болон allocation type.

## 9. Эрхийн хуваарилалт

| Үйлдэл | Hotel Admin | Manager | Manager Plus | Reception | Cleaner |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full financial dashboard/KPI/graph/top-5 | ✓ | — | — | — | — |
| Financial Excel export | ✓ | — | — | — | — |
| Expense category үүсгэх/идэвхгүй болгох | ✓ | — | — | — | — |
| Expense хүсэлт үүсгэх/submit | ✓ | ✓ | ✓ | — | — |
| Expense approve for payment/reject | ✓ | — | — | — | — |
| Approved expense payment execute | ✓ | ✓ | ✓ | ✓ | — |
| Expense reversal/correction батлах | ✓ | — | — | — | — |
| Өөрийн expense request харах | ✓ | ✓ | ✓ | — | — |
| Өөрийн shift/payment operational мэдээлэл | Хязгаартай review | Батлах хүрээнд | Батлах хүрээнд | ✓ | — |
| Minibar stock purchase operational мэдээлэл | Full report | Өөрийн удирдсан хүрээнд | Өөрийн удирдсан хүрээнд | — | Task quantity only |

Hotel Admin full financial эрхээр Manager-ийн room/product/stock operational action-ийг автоматаар өвлөхгүй. Manager/Manager Plus full dashboard/Excel харахгүй.

## 10. Scope, audit ба засвар

- Financial query/export бүр зөвхөн actor-ийн `hotel_id` scope-д байна.
- UI button нуухаас гадна server/API дээр Hotel Admin permission шалгана.
- Export actor, filter, row count, generated time болон status-тай audit record байна.
- Expense approval/rejection/payment execution/reversal, category change болон financial correction аудиттай байна.
- Room tariff edit нь old/new value, hourly/nightly type, source level/ID, configuration version, Manager actor болон server time-тэй аудиттай; Hotel Admin full financial тайлангаас баталгаажсан charge-ийн snapshot эх үүсвэрийг шалгаж чадна.
- Finalized charge, successful payment, Paid expense болон refund-ийг hard delete хийхгүй.
- Correction нь original record-той холбоотой шинэ reversal/adjustment байна.
- Өмнөх хаагдсан тайлангийн aggregate-г чимээгүй overwrite хийхгүй; correction хэрэгжсэн огноондоо тусна.

## 11. Scope-оос тусдаа үлдэх хамаарал

- Online booking-ийн gross hotel sale-г харуулж болох боловч commission, hotel payable, payout/settlement-ийн final net formula P0-14-өөр батлагдана.
- Platform хариуцах booking gateway fee-г hotel expense/net payout-аас хасахгүй.
- Cash expense, cash drawer/shift, safe, transfer болон withdrawal-ийн canonical дүрмийг [24-cash-drawer-ledger.md](./24-cash-drawer-ledger.md)-д баталсан.
- Minibar selling price-ийн check-in snapshot, report version болон correction-ийн дүрмийг [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md)-д PRICE-DEC-001–008-аар баталсан.
- Room charge-ийн тусдаа цагийн/хоногийн тариф, Walk-in `room → category → hotel`, Online `category → hotel` resolution, confirmed snapshot болон reprice хамгаалалтыг [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md)-ийн `STAY-DEC-005`-аар баталсан.
- Stay/booking-ийн end-exclusive `[start_at, end_at)` интервал, planned/actual checkout + snapshot cleaning buffer болон full room readiness-ийг мөн баримтын `STAY-DEC-008`-аар баталсан. Эдгээр operational readiness event нь өөрөө санхүүгийн гүйлгээ биш.
- Tax/eBarimt-ийн салангид дүн ба албан ёсны accounting treatment P1-11/татварын зөвлөхийн баталгаажуулалтад үлдэнэ.

Эдгээр dependency нь core sales/payment/expense/top-5/export data grain болон Hotel Admin permission-ийг дахин нээхгүй.

## 12. MVP acceptance criteria

- Баталгаажсан борлуулалт болон орж ирсэн мөнгийг тусдаа KPI-аар харуулна.
- Room sale нь server-resolved confirmation snapshot unit price ашиглаж, дараагийн tariff edit эсвэл Online booking-д өрөө оноосноор reprice болохгүй.
- Pending/failed payment орж ирсэн мөнгөнд орохгүй.
- Авлага, хадгалж буй deposit болон service payment тусдаа байна.
- Restaurant payment hotel financial report-д орохгүй.
- Minibar gross profit weighted average COGS ашиглана.
- Minibar net sales check-in selling price snapshot ашиглаж, active stay current product price-аар reprice болохгүй.
- Inventory purchase cash-outflow болон COGS-ийг operational profit-д давхар хасахгүй.
- Operational result-ийг албан ёсны `Цэвэр ашиг` гэж нэрлэхгүй.
- Manager/Manager Plus expense submit хийж, Hotel Admin approved-for-payment/rejected болгоно.
- Approval нь cash-outflow биш; бодит execution үед expense `Paid` болно. Зөвхөн бэлэн төлбөр active drawer-ийн cash movement үүсгэнэ; Card/POS болон bank/QPay drawer-д нөлөөлөхгүй.
- Hotel Admin expense-ийг өөрөө үүсгэж approve/execute хийж чадна; audit self-approved болон executor-ийг тэмдэглэнэ.
- Paid expense-ийг edit/delete хийхгүй; reversal/correction ашиглана.
- Зөвхөн Paid expense cash-outflow/KPI/Excel-ийн paid дүнд орно.
- Dashboard 7 хоног, энэ сар болон custom хугацаагаар ажиллана.
- Борлуулалт/payment/expense/refund/top-5 тус бүр батлагдсан date basis ашиглана.
- Top-5 default нь completed non-cancelled stay count; revenue toggle ажиллана.
- Room, minibar, expense болон payment breakdown дөрвөн тусдаа Excel export байна.
- Financial Excel-д шаардлагагүй guest PII орохгүй.
- Full financial dashboard болон Excel зөвхөн Hotel Admin-д байна.
- Refund/correction хэрэгжсэн огноондоо сөрөг хөдөлгөөнөөр харагдаж, хуучин record хадгалагдана.
- Early/late actual check-out болон cleaning-buffer readiness өөрчлөгдсөнөөр automatic charge/refund үүсэхгүй; зөвхөн тусдаа finalized financial record тайланд орно.
- Guest/room report-ийн actual-start field latest approved `effective_actual_check_in_at`-ийг харуулж болох ч financial recognized/effective/shift time болон amount/snapshot өөрчлөгдөхгүй.
- Confirmed booking/active stay-ийн planned checkout direct overwrite хоригтой; minimal guard өөрөө report/Excel amount/date, charge/payment/cash event, price/config/stock snapshot эсвэл repricing/refund/payment movement үүсгэхгүй.
- Planned checkout MVP-д amendment/action/extension/shorten/conversion-гүй original value хэвээр; report/Excel effective planned-end projection хийхгүй.
- Early/late actual checkout original planned end-ийг өөрчлөхгүй; early auto reprice/refund, overdue auto fee/penalty байхгүй, room actual checkout хүртэл occupied.

## 13. Батлагдсан шийдвэр

### FIN-DEC-001 — Борлуулалт ба орж ирсэн мөнгө тусдаа

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Finalized charge-д суурилсан баталгаажсан борлуулалт болон SUCCESS payment-д суурилсан орж ирсэн мөнгийг тусдаа KPI/ledger-аар харуулна. Авлагыг payment/deposit allocation-аар бодно.

### FIN-DEC-002 — Deposit ба Restaurant exclusion

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Deposit receipt revenue биш; charge-д allocation хийхэд payment allocation болно, шинэ cash inflow болохгүй. Restaurant payment hotel financial report-д орохгүй.

### FIN-DEC-003 — Minibar weighted average COGS

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Minibar gross profit/margin-д sales snapshot болон weighted average unit cost snapshot-аар COGS бодно.

### FIN-DEC-004 — Inventory purchase-ийг давхар expense болгохгүй

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Inventory purchase бодитоор төлөгдвөл cash-outflow-д орно. Operational profit-д бүх purchase-ийг шууд дахин хасахгүй; борлуулсан бүтээгдэхүүний COGS-ийг хасна.

### FIN-DEC-005 — Expense submission, approval ба payment execution

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Manager/Manager Plus expense submit хийж, Hotel Admin approved-for-payment/rejected болгоно. Approval cash-outflow биш; Reception, Manager/Manager Plus эсвэл Hotel Admin бодит төлбөрийг execute хийх үед `Paid` болж санхүүгийн тайланд орно. Cash method active drawer-д атомик cash movement үүсгэнэ; Card/POS болон bank/QPay transaction/provider reference-тэй боловч drawer movement үүсгэхгүй. Hotel Admin self-approved/self-executed хийж болно. Paid expense immutable, correction нь reversal + new record байна.

### FIN-DEC-006 — 7 хоног, сар, custom хугацаа

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Dashboard сүүлийн 7 календарь өдөр, энэ сар болон custom date range-тай; hotel timezone болон metric бүрийн батлагдсан date basis ашиглана.

### FIN-DEC-007 — Top-5 room

- **Төлөв:** Батлагдсан
- **Шийдвэр:** `Эрэлтээр` default нь actual checkout нь хугацаанд багтсан completed, non-cancelled stay count. Tie-break нь room net sales, дараа нь room number. `Орлогоор` toggle room net sales ашиглана.

### FIN-DEC-008 — Дөрвөн financial Excel

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Room sales, minibar sales/profit, expense болон payment breakdown-ийг тусдаа Excel-ээр батлагдсан багана/filter-тэй татна. Guest-ийн шаардлагагүй PII оруулахгүй, export аудиттай байна.

### FIN-DEC-009 — Effective-date correction

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Refund/reversal/correction original record-ийг өөрчлөхгүй; амжилттай/effective болсон огноондоо сөрөг/шинэ хөдөлгөөнөөр тайланд тусна.

### FIN-DEC-010 — Full financial эрх зөвхөн Hotel Admin-д

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Full dashboard, KPI, graph, top-5 болон financial Excel зөвхөн Hotel Admin-д байна. Manager/Manager Plus expense/stock operational хүрээ, Reception өөрийн shift/payment хүрээтэй, Cleaner financial access-гүй байна.

## 14. Дараагийн баталгаажуулах нэг асуудал

P0-09, P0-34–P0-39 хаагдсан. Shift, cash drawer болон minibar selling price snapshot тусдаа canonical баримтад батлагдсан. `STAY-DEC-008`–`014`-ийн effective actual time, immutable planned end, overdue conflict болон fractional hourly duration нь өмнөх financial event-ийг өөрчлөхгүй; hotel-caused online cancellation/refund/commission нь `BK-DEC-014`, `PAY-DEC-008/009`-ийн тусдаа ledger event байна.
