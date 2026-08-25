# Role бүрийн action-level permission matrix

**Хувилбар:** 1.19  
**Төлөв:** MVP action-level permission matrix, deposit/correction, suspended-work takeover, review/guest registry, online cancellation/no-show/overbooking болон Police canonical permission бүрэн батлагдсан  
**Хамаарах үе шат:** MVP — Бүх системийн authorization

## 1. Үндсэн зарчим

Role нь зөвхөн ямар tab харахыг бус, тухайн хэрэглэгч яг ямар үйлдэл хийхийг тодорхойлно.

```text
Hotel staff action зөвшөөрөгдөх
= Account идэвхтэй + active hotel membership
+ Subscription хүчинтэй эсвэл 48 цагийн grace period-д
+ Package тухайн feature-ийг агуулсан
+ Hotel role тухайн action-ийг зөвшөөрсөн
+ Resource тухайн хэрэглэгчийн hotel/restaurant/unit scope-д хамаарсан
```

Guest, Operation болон Police action нь өөрийн realm-ийн authentication, permission, state болон scope gate-ийг ашиглана. Тухайлбал authenticated Guest review report хийхэд hotel membership, subscription, package эсвэл hotel role шаардахгүй.

Тухайн realm-д хамаарах нөхцөлийн аль нэг хангагдахгүй бол UI button харагдахгүй/disabled байхаас гадна backend/API хүсэлтийг хориглоно.

## 2. Account ба role-ийн дүрэм

- Нэг hotel хэрэглэгч нэг account дээр хэд хэдэн hotel role авч болно.
- Жижиг буудлын нэг хүн `Hotel Admin + Manager + Reception` зэрэг role-той байж болно.
- Зөвшөөрөгдсөн role-уудын action permission нийлж үйлчилнэ.
- Hotel Admin нь Manager/Reception-ийн operational эрхийг автоматаар өвлөхгүй; шаардлагатай role-ийг тусад нь авна.
- Нэг хүн хэд хэдэн ажил хийсэн ч shared account ашиглахгүй; бүх үйлдэл өөрийн нэрлэсэн account-аар хийгдэнэ.
- Hotel Admin зөвхөн өөрийн hotel-ийн, package-д зөвшөөрөгдсөн hotel role-ийг олгоно.
- MVP-д Hotel Admin staff invitation-аар өөр Primary Hotel Admin үүсгэхгүй; Primary transfer тусдаа offline recovery байна.
- Hotel Admin Operation, Platform Super Admin, Police Admin/Officer role олгохгүй.
- Hotel, Operation болон Police realm-ийн account/permission-ийг автоматаар нэгтгэхгүй.
- Нэг account олон hotel-д холбогдох шаардлага гарвал hotel бүрийн role/scope-ийг тусдаа холбоосоор хадгална.

## 3. Hotel role-ийн canonical matrix

Тэмдэглэгээ:

- `✓` — үндсэн role-оор зөвшөөрнө.
- `—` — үндсэн role-оор хориглоно.
- `Нэмэлт role` — тухайн account-д өөр role тусад нь олгосон үед зөвшөөрнө.
- `20/25/30` — package entitlement давхар шаардана.
- `Manager Plus` role нь зөвхөн 30,000₮ багцад үүснэ; энэ баган дахь package тэмдэглэгээгүй `✓` ч `✓ 30` гэсэн утгатай.

| Үйлдэл | Hotel Admin | Manager | Manager Plus | Reception | Cleaner | Restaurant Manager |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Subscription төлөх/сунгах | ✓ | — | — | — | — | — |
| Hotel owner/profile, хаяг, public listing | ✓ | — | — | — | — | — |
| Hotel staff урих/түдгэлзүүлэх | ✓ | — | — | — | — | — |
| Hotel role олгох/цуцлах | ✓ | — | — | — | — | — |
| Suspended Reception shift takeover / Cleaner task reassign | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — | — | — |
| Suspended Restaurant order/task reassign | Нэмэлт Manager Plus role | — | ✓ 30 | — | — | — |
| Өрөө, room category, үнэ удирдах | Нэмэлт Manager role | ✓ | ✓ | — | — | — |
| Hourly/nightly hotel default, category override, walk-in room override тохируулах | Нэмэлт Manager role | ✓ 20/25/30 | ✓ 30 | — | — | — |
| Hotel/category deposit дүн тохируулах | Нэмэлт Manager/Manager Plus role | ✓ 20/25/30 | ✓ 30 | Read-only | — | — |
| Confirmation-оос өмнөх Walk-in source/deposit exemption correction | Нэмэлт Manager/Manager Plus role | ✓ 20/25/30 | ✓ 30 | — | — | — |
| Server-resolved stay tariff/source ба confirmed snapshot харах | ✓ | ✓ | ✓ | Read-only | — | — |
| Room/category deactivation/reactivation | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — | — | — |
| Never-used room/category hard-delete | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — | — | — |
| Minibar product/category/худалдах үнэ | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Product/template deactivation/reactivation | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Never-used product/template hard-delete | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Minibar template version Draft үүсгэх/засах | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Minibar template version Publish/Set default | Тухайн багцад зөвшөөрөгдсөн нэмэлт role | ✓ 25/30 | ✓ 30 | — | — | — |
| Minibar template version Archive | Тухайн багцад зөвшөөрөгдсөн нэмэлт role | ✓ 25/30 | ✓ 30 | — | — | — |
| Eligible room-ийг exact Published version рүү Rollout хийх | Тухайн багцад зөвшөөрөгдсөн нэмэлт role | ✓ 25/30 | ✓ 30 | — | — | — |
| Multi-room Rollout Preview/Confirm/Cancel remaining/Retry | Тухайн багцад зөвшөөрөгдсөн нэмэлт role | ✓ 25/30 | ✓ 30 | — | — | — |
| Multi-room batch/child төлөв ба blocker харах | ✓ 25/30 | ✓ 25/30 | ✓ 30 | Read-only 25/30 | Зөвхөн өөрийн child task | — |
| Room/entity lifecycle state/blocker харах | ✓ | ✓ | ✓ | Read-only, room хүрээнд | Зөвхөн өөрийн task | — |
| Stay minibar locked price харах | ✓ 25/30, financial/report | ✓ 25/30 | ✓ 30 | ✓ 25/30 | — | — |
| Худалдан авалтын өртөг/opening stock/stock receipt | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Waste/stock adjustment | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Initial room setup-ийн mode/template, эсвэл config request-ийн pending target сонгох | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Room minibar config change үүсгэх/товлох/хөдөлгөөнгүй cancel | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Config shortage/variance/rollback шийдэх | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Assigned config reconciliation/rollback room ↔ warehouse transfer | Нэмэлт Cleaner role | Нэмэлт Cleaner role | Нэмэлт Cleaner role | — | ✓ 25/30 | — |
| Current/pending config-ийн exact template version ба check-in blocker харах | ✓ 25/30 | ✓ 25/30 | ✓ 30 | Read-only 25/30 | Зөвхөн өөрийн task | — |
| `Дутуу minibar-тайгаар нээх` override | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Active-stay refill request үүсгэх/цуцлах | Нэмэлт Reception/Manager role | ✓ 25/30 | ✓ 30 | ✓ 25/30 | — | — |
| Active-stay refill task гүйцэтгэх/боломжгүй болгох | Нэмэлт Cleaner role | Нэмэлт Cleaner role | Нэмэлт Cleaner role | — | ✓ 25/30 | — |
| Active-stay non-guest stock-out | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Restaurant бүртгэх/идэвхжүүлэх | Нэмэлт Manager Plus role | — | ✓ 30 | — | — | — |
| Restaurant Manager account/invitation үүсгэх | Нэмэлт Manager Plus role | — | ✓ 30 | — | — | — |
| Restaurant menu, schedule, item availability | — | — | — | — | — | ✓, зөвхөн өөрийн Restaurant |
| Restaurant order боловсруулах | — | — | — | — | — | ✓, зөвхөн өөрийн Restaurant |
| Check-in | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ | — | — |
| Initial check-in confirmation-оос өмнө actual time сонгох | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓, STAY-DEC-009 bound + reason | — | — |
| Activated stay-ийн `actual_check_in_at`-ийг direct edit/backdate хийх | — | — | — | — | — | — |
| ACTIVE stay/checkout эхлээгүй үед actual-time correction request submit хийх | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓, corrected time + reason | — | — |
| Actual-time correction request approve/reject хийх | Нэмэлт Manager role | ✓ | Нэмэлт Manager role | Нэмэлт Manager role; өөрийн request бол `self_approved` | — | — |
| Confirmed booking/ACTIVE stay-ийн `planned_checkout_at`-ийг direct edit/overwrite хийх | — | — | — | — | — | — |
| Planned/effective end amendment, extension, shortening, hourly ↔ nightly conversion хийх | —, MVP | —, MVP | —, MVP | —, MVP | — | — |
| Early/on-time/late actual checkout бүртгэх, room/minibar тооцоо | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ | — | — |
| Барьцаа авах/суутгах/буцаах | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ | — | — |
| Alternate-channel deposit refund / financial correction хүсэлт гаргах | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ | — | — |
| Alternate-channel deposit refund / financial correction approve/reject | Нэмэлт Manager/Manager Plus role | ✓ 20/25/30 | ✓ 30 | — | — | — |
| Failed/pending deposit refund cancel ба reservation release | Нэмэлт Manager/Manager Plus role | ✓ 20/25/30 | ✓ 30 | Request | — | — |
| Reception shift нээх/хаах/хүлээлцэх | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ | — | — |
| Ердийн shift-ийн санхүүгийн review/хаалт | Exception review | ✓ | ✓ | — | — | — |
| Зөрүүтэй self-close review | ✓ | — | — | — | — | — |
| Cleaner task авах | — | — | — | — | ✓ 25/30 | — |
| Cleaning status — 20,000₮ | Нэмэлт Manager role | ✓ 20 | — | — | — | — |
| Cleaning status — 25,000/30,000₮ | — | — | — | — | ✓ | — |
| Minibar usage/refill report | — | — | — | — | ✓ 25/30 | — |
| Minibar тайланг Cleaner-д залруулгад буцаах | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ 25/30 | — | — |
| Онцгой minibar тайлан үүсгэх | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Minibar маргаантай мөр тэмдэглэх | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ 25/30 | — | — |
| Төлбөрөөс өмнөх minibar маргаан шийдэх | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — | — |
| Төлбөрийн дараах minibar correction/refund | ✓ 25/30, батлах | ✓ 25/30, батлах | ✓ 30, батлах | Хүсэлт/гүйцэтгэл 25/30 | — | — |
| Guest registry list/filter/pagination харах | ✓ 20/25/30 | ✓ 20/25/30 | ✓ 30 | — | — | — |
| Guest registry background Excel export үүсгэх/татах | ✓ 20/25/30 | ✓ 20/25/30 | ✓ 30 | — | — | — |
| Hotel role-оор review report/moderation хийх | — | — | — | — | — | — |
| Өөрийн hotel-ийн review-д official reply үүсгэх/засах/soft-delete/restore | ✓ 20/25/30 | ✓ 20/25/30 | ✓ 30 | — | — | — |
| Review moderation queue/нуух/сэргээх/report шийдвэрлэх | — | — | — | — | — | — |
| Full income/expense/top-5 financial dashboard | ✓ | — | — | — | — | — |
| Room income-expense financial Excel | ✓ 20/25/30 | — | — | — | — | — |
| Minibar income-expense financial Excel | ✓ 25/30 | — | — | — | — | — |
| Expense category үүсгэх/идэвхгүй болгох | ✓ | — | — | — | — | — |
| Expense хүсэлт үүсгэх/submit | ✓ | ✓ | ✓ | — | — | — |
| Expense approve for payment/reject | ✓ | — | — | — | — | — |
| Approved expense payment execute | ✓ | ✓ | ✓ | ✓, approved request | — | — |
| Expense reversal/correction батлах | ✓ | — | — | — | — | — |
| Өөрийн expense request харах | ✓ | ✓ | ✓ | — | — | — |
| Drawer/safe үүсгэх, initial configured float | ✓ | — | — | — | — | — |
| Actual cash count | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ | — | — |
| Drawer transfer initiate/cancel request | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — | — | — |
| Drawer transfer receive/confirm | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ | — | — |
| Drawer transfer cancel return confirm | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ | — | — |
| Drawer ↔ Safe transfer | ✓ | ✓ | ✓ | — | — | — |
| Bank deposit request | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — | — | — |
| Owner/other withdrawal request | ✓ | ✓ | ✓ | — | — | — |
| Bank/owner withdrawal approve | ✓ | — | — | — | — | — |
| Cash top-up | ✓ | ✓ | ✓ | — | — | — |
| Shift cash correction review | Exception/self-review | ✓, original actor биш | ✓, original actor биш | — | — | — |
| Full cash drawer/safe report/export | ✓ | — | — | — | — | — |
| Өөрийн shift/payment-ийн operational мэдээлэл | Хязгаартай review | ✓, батлах хүрээнд | ✓, батлах хүрээнд | ✓, өөрийн shift | — | — |
| `takeover_id`-тай old shift-ийн pre-suspension pending item status query болон Reception terminal confirmation | Claim/read: нэмэлт Manager/Manager Plus; execute: +Reception | Claim/read; execute бол Reception role | Claim/read; execute бол Reception role | ✓, зөвхөн assigned replacement | — | — |
| Hotel audit/security тайлан | ✓ | Зөвхөн өөрийн удирдсан operational event | Зөвхөн өөрийн удирдсан operational event | — | — | — |

### 3.1 Shift exception

- Өдөр тутмын shift-ийн үндсэн санхүүгийн баталгаажуулагч Manager/Manager Plus байна.
- Manager өөрөө Reception байдлаар тухайн shift-д ердийн горимоор ажилласан бол Hotel Admin exception reviewer байна.
- Hotel Admin-аар урьдчилан идэвхжүүлсэн нэг ажилтантай горимд Reception + Manager/Manager Plus role-той нэг account self-close хийж болно.
- Зөрүүгүй self-close-д approver/review шаардахгүй. Зөрүүтэй self-close-г Hotel Admin review хийнэ; өөр review actor байхгүй бол `self-reviewed` аудиттай өөрөө review хийж болно.
- Шинэ ээлж эхэлсний дараах reject/dispute хуучин shift-ийг reopen/edit хийх эрх өгөхгүй; reason-тэй variance acceptance эсвэл холбоостой correction ашиглана.
- Эдгээр exception нь Hotel Admin-д бүх Reception action-ийг автоматаар өгөхгүй.

### 3.2 Suspension дараах takeover/reassignment

- Suspension/termination нь permission, тухайн scope-ийн session/token/cache-ийг **шууд** revoke хийнэ. Нээлттэй shift/task/order байгаа нь security suspension-ийг хойшлуулахгүй.
- Suspended Reception-ийн open shift дээр `TAKEOVER_REQUIRED` item үүсэж, Manager/Manager Plus claim хийж active Reception replacement сонгоно. Hotel Admin queue-г удирдах бол Manager/Manager Plus, өөрөө cash count/shift үргэлжлүүлэх бол Reception role тусдаа байна.
- Assigned replacement Reception `takeover_id`-аар old shift-ийн зөвхөн pre-suspension pending payment provider status query/reconciliation trigger болон drawer transfer receive/return confirmation хийнэ. Transfer initiate/cancel/approval, Manager decision болон шинэ customer movement өвлөхгүй; claimant тэдгээрийг existing Manager/Manager Plus permission-ээр хийж, нэг actor execution хийх бол Reception role мөн тусдаа байна.
- Movement эхлээгүй Cleaner task-ийг Manager/Manager Plus active, entitlement-тэй Cleaner рүү reassign хийнэ. Immutable movement/partial completion эхэлсэн бол өмнөх actor/history-г солихгүй, remaining work-д linked continuation task үүсгэнэ. Hotel Admin-д Manager/Manager Plus role тусдаа байна.
- Suspended Restaurant Manager-ийн unfinished order/task-ийг 30,000₮-ийн Manager Plus active Restaurant Manager рүү reassign хийнэ. Hotel Admin-д Manager Plus, order-ийг өөрөө боловсруулах бол тухайн Restaurant-ийн Restaurant Manager membership тусдаа шаардлагатай.
- Takeover/reassignment нь ажил гүйцэтгэх operational role-ийг орлохгүй: cash/shift-д Reception, Cleaner task-д Cleaner, order боловсруулахад Restaurant Manager шаардлагатай. Нэг item нэг claimant/assignee-тай, same-scope, version/idempotency болон append-only audit хамгаалалттай байна.

### 3.3 Online booking cancellation/no-show/overbooking

| Үйлдэл | Guest account | Hotel Admin | Manager | Manager Plus | Reception |
| --- | ---: | ---: | ---: | ---: | ---: |
| Check-in-ээс өмнө өөрийн booking цуцлах | ✓, зөвхөн booking owner | — | — | — | — |
| Arrival date-ийн 23:59:59 cutoff өнгөрсний дараа `NO_SHOW` батлах | — | Нэмэлт Reception эсвэл Manager role | ✓ | Нэмэлт Reception эсвэл Manager role | ✓ |
| Conflict үед ижил category-ийн eligible room оноох | — | Нэмэлт Reception role | Нэмэлт Reception role | Нэмэлт Reception role | ✓ |
| Higher-category room-ийг нэмэлт төлбөргүй зөвшөөрөх | — | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | Нэмэлт Manager/Manager Plus role; өөрийн assignment бол `self_approved` |
| Eligible room байхгүй үед `CANCELLED_HOTEL` болгох | — | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | Нэмэлт Manager/Manager Plus role |
| Provider refund-ийг гараар `Амжилттай/REFUNDED` болгох | — | — | — | — | — |

- Guest cancellation зөвхөн authenticated booking owner-ийн action байна; hotel staff зочны өмнөөс `CANCELLED_GUEST` болгохгүй.
- `NO_SHOW`-г автоматаар үүсгэхгүй. Cutoff, booking state болон concurrent check-in-ийг server row-lock-оор дахин шалгана. Manager Plus role дангаараа Manager-ийн no-show permission-ийг өвлөхгүй.
- Occupied room-д давхар check-in хийхгүй. Higher-category approval болон `CANCELLED_HOTEL`-ийг Manager/Manager Plus хийнэ; ижил category physical room assignment нь Reception action хэвээр байна.
- `CANCELLED_GUEST`, `NO_SHOW` болон `CANCELLED_HOTEL` terminal transition нь refund obligation үүсгэж болох боловч provider/server success иртэл тусдаа Refund axis `REFUNDED` болохгүй; captured Payment `PAID` хэвээр. Hotel role provider success-ийг гараар тэмдэглэхгүй.
- Booking row lock, idempotency key, actor/role, өмнөх/шинэ төлөв, reason, room болон refund холбоосыг append-only audit-д хадгална.

## 4. Package entitlement matrix

| Feature | 20,000₮ | 25,000₮ | 30,000₮ |
| --- | ---: | ---: | ---: |
| Reception | ✓ | ✓ | ✓ |
| Manager / room management | ✓ | ✓ | ✓ |
| Cash drawer/shift ledger | ✓ | ✓ | ✓ |
| Guest registry list/background Excel | ✓ | ✓ | ✓ |
| Hotel official reply | ✓ | ✓ | ✓ |
| Cleaner role/API | — | ✓ | ✓ |
| Minibar management/usage | — | ✓ | ✓ |
| Minibar template Draft/Publish/Default/Archive/Rollout | — | ✓ | ✓ |
| Manager Plus / Restaurant registration | — | — | ✓ |
| Restaurant Manager/menu/order | — | — | ✓ |

- 20,000₮ package-д Manager cleaning status өөрчилнө.
- 25,000₮/30,000₮ package-д зөвхөн Cleaner operational cleaning status өөрчилнө.
- Role database-д байсан ч package тухайн feature-ийг зөвшөөрөөгүй бол UI/API ажиллахгүй.
- Hotel Admin role нь package entitlement-ийг давж гарахгүй. Minibar template-ийн Draft/Publish/Default/Archive болон room Rollout action-д тухайн үед хүчинтэй entitlement болон багцад зөвшөөрөгдсөн operational role хоёулаа шаардлагатай: 25,000₮-д зөвхөн Manager, 30,000₮-д Manager эсвэл Manager Plus.
- 25,000₮ багцын Hotel Admin Manager Plus role үүсгэж 30,000₮-ийн эрхийг тойрохгүй; role assignment болон action API хоёул package gate-ээр хориглогдоно.
- Upgrade дараагийн service month-оос хэрэгжих хүртэл шинэ package role/action нээгдэхгүй.

## 5. Operation ба Platform Super Admin matrix

| Үйлдэл | Operation Admin | Platform Super Admin |
| --- | ---: | ---: |
| Hotel/subscription жагсаалт | `OPERATION_READ` | `OPERATION_READ` тусдаа |
| Subscription reminder SMS | `SUBSCRIPTION_REMINDER_SEND` | `SUBSCRIPTION_REMINDER_SEND` тусдаа |
| Hotel Admin password reset эхлүүлэх | `SUBSCRIPTION_PASSWORD_RESET_INITIATE` | `SUBSCRIPTION_PASSWORD_RESET_INITIATE` тусдаа |
| Paid failed onboarding provisioning retry | `ONBOARDING_PROVISION_RETRY` | `ONBOARDING_PROVISION_RETRY` тусдаа |
| eBarimt manual retry/email task | `SUBSCRIPTION_EBARIMT_RETRY` | `SUBSCRIPTION_EBARIMT_RETRY` тусдаа |
| Stale/duplicate paid billing reconciliation | Зөвхөн `SUBSCRIPTION_PAYMENT_RECONCILE` | `SUBSCRIPTION_PAYMENT_RECONCILE` тусдаа |
| Released deposit refund-ийн late-success reconciliation | Зөвхөн `DEPOSIT_REFUND_RECONCILE` | `DEPOSIT_REFUND_RECONCILE` тусдаа |
| Subscription suspend/reactivate | — | Зөвхөн `SUBSCRIPTION_SUSPEND` permission-тэй |
| Subscription contact offline exception approve | — | Зөвхөн `SUBSCRIPTION_CONTACT_CHANGE_APPROVE` permission-тэй |
| Operation хэрэглэгч үүсгэх/түдгэлзүүлэх | — | `PLATFORM_OPERATION_ACCESS_MANAGE` |
| Operation permission олгох/цуцлах | — | `PLATFORM_OPERATION_ACCESS_MANAGE` |
| Email ownership offline recovery | — | `ACCOUNT_OWNERSHIP_RECOVERY_APPROVE`, тусдаа журам |
| Review moderation queue/нуух/сэргээх/report шийдвэрлэх | Зөвхөн explicit `REVIEW_MODERATE` permission-тэй бол | Зөвхөн explicit `REVIEW_MODERATE` permission-тэй бол |
| Hotel operational data удирдах | — | — |
| Hotel guest registry харах | — | — |
| Police wanted/match/check-in data харах | — | — |
| Хэрэглэгчийн одоогийн/шинэ password, OTP/token харах | — | — |

Platform Super Admin гэдэг нэр нь бүх business data-г автоматаар харах эрх биш. Тусгай Operation action хэрэгтэй бол permission-ийг тусад нь олгоно. Operation Admin contact утгыг шууд солих, subscription suspend/reactivate хийхгүй. Эдгээр high-risk action recent step-up MFA, mandatory reason/reference болон append-only audit-тай байна (`OPS-DEC-015`, `OPS-DEC-016`). Үүнтэй адил `Operation Admin` эсвэл `Platform Super Admin` role-ийн нэр review moderation эрх үүсгэхгүй; `REVIEW_MODERATE`-ийг нэрлэсэн account-д тусад нь олгож, цуцална.

`ONBOARDING_PROVISION_RETRY` зөвхөн immutable paid application job-ийг retry хийх бөгөөд package/owner/term/payment засахгүй. `DEPOSIT_REFUND_RECONCILE` зөвхөн `LATE_REFUND_SUCCESS` case-ийг provider evidence-тэй terminal болгоно; Hotel role уг Platform finance permission-ийг өвлөхгүй. Эдгээр permission болон eBarimt/recovery action recent step-up MFA, idempotency, mandatory reference/reason болон append-only audit-тай байна.

## 6. Police matrix

| Үйлдэл | Police Officer | Police Admin |
| --- | ---: | ---: |
| Police account үүсгэх/түдгэлзүүлэх, role/unit тохируулах | — | ✓ |
| Wanted Person/Case draft, ХУР/manual identity үүсгэх | ✓ | Зөвхөн `WANTED_CASE_CREATE` permission-тэй бол |
| Active Wanted мэдээлэл харах | ✓ | ✓ |
| Match alert харах | ✓, өөрийн scope/approved exact search | ✓ |
| Exact РД/Match ID хайлт | ✓ | ✓ |
| Бүх hotel-ийн check-in үндсэн зочдын жагсаалт | — | ✓ |
| Бүх hotel check-in Excel/CSV/bulk export | — | —, MVP-д хаалттай |
| Match-ийг хүлээн авсан гэж тэмдэглэх | ✓ | ✓ |
| Өөрийн account-аар `Олдсон` батлах | ✓ | ✓ |
| Өөрийн `Олдсон` залруулгын хүсэлт гаргах | ✓ | ✓ |
| `Олдсон` залруулга батлах/татгалзах | `FOUND_CORRECTION_APPROVE`; requester-ээс өөр actor | `FOUND_CORRECTION_APPROVE`; requester-ээс өөр actor |
| `Худал Match` хүсэлт гаргах | ✓ | ✓ |
| `Худал Match` хүсэлт батлах/татгалзах | `FALSE_MATCH_APPROVE`; requester-ээс өөр actor | `FALSE_MATCH_APPROVE`; requester-ээс өөр actor |
| Manual identity батлах | `WANTED_IDENTITY_APPROVE`; creator-оос өөр actor | `WANTED_IDENTITY_APPROVE`; creator-оос өөр actor |
| Case идэвхжүүлэх/түдгэлзүүлэх/сэргээх/хаах/цуцлах | Зөвхөн `WANTED_CASE_STATE_MANAGE` permission-тэй бол | Зөвхөн `WANTED_CASE_STATE_MANAGE` permission-тэй бол |
| Dashboard-ийн үндсэн тоо | ✓ | ✓ |
| Ангилал/дүүргийн graph, Police access audit | — | ✓ |
| Wanted Case Excel export | — | Зөвхөн `WANTED_CASE_EXPORT` permission-тэй бол |

- Дурын идэвхтэй Police хэрэглэгч өөрийн account-аар exact search хийж active Match-ийг нээж, бодитоор илрүүлсэн бол `Олдсон` батална.
- Энэ exact search нь Police Officer-д бүх hotel check-in жагсаалт нээхгүй.
- Police Admin-ийн бүх check-in list эрх нь Hotel/Operation/Platform account-д дамжихгүй.
- Police Admin нь Officer-ийн mutation permission-ийг автоматаар өвлөхгүй. Draft create, manual identity approval, case lifecycle, Found/False Match correction approval болон export action бүрд хүснэгтийн explicit permission, scope болон separation-of-duties шалгалт үйлчилнэ.
- Police Officer Wanted/Case Excel export хийхгүй; зөвхөн `WANTED_CASE_EXPORT` permission-тэй Police Admin батлагдсан purpose/audit/retention дүрмээр export хийнэ. Бүх hotel check-in bulk export MVP-д аль ч role-д байхгүй.

## 7. Subscription ба account state gate

- Subscription `Идэвхтэй`, `Удахгүй дуусна` эсвэл 48 цагийн `Grace period` төлөвтэй үед package/role action хэвийн ажиллана.
- Grace дуусаж `Дууссан` болсон hotel-д operational permission matrix бүхэлдээ deny болно.
- Hard lock үед Hotel Admin-д `Subscription сунгах/төлөх`, `Тусламж`, `Гарах`; бусад staff-д expired notice, тусламж, гарах л үлдэнэ.
- Account түдгэлзсэн/идэвхгүй бол subscription хүчинтэй байсан ч action зөвшөөрөхгүй.
- User/role/package/subscription төлөв client cache-аар бус backend-ийн authoritative state-аар шалгагдана.

## 8. Scope, server enforcement ба audit

- Hotel action бүр `hotel_id` scope-той; нэг hotel-ийн хэрэглэгч ID/URL сольж өөр hotel-ийн data харахгүй.
- Hotel Admin болон Manager өөрийн hotel-ийн guest registry list/background Excel-д бүх багцад, Manager Plus зөвхөн 30,000₮ багцад хандана. Job create/download бүрд active membership, subscription, role болон `hotel_id` scope-ийг дахин шалгана; Reception/Cleaner/Restaurant болон Platform role-д bulk access автоматаар үүсэхгүй.
- Online Booking realm-ийн дурын authenticated Guest account нийтлэгдсэн review-г report хийж болно; completed stay, hotel role эсвэл package шаардахгүй. Hotel Admin болон Manager бүх багцад, Manager Plus зөвхөн 30,000₮ багцад өөрийн hotel-ийн нэг official reply-г удирдана. Hotel/Operation/Police role дангаараа report эрх нээхгүй; report review-г автоматаар нуухгүй. Hotel role review нуух, сэргээх, хэрэглэгчийн content засах/устгах эрхгүй. Queue/hide/restore/report resolution нь зөвхөн explicit `REVIEW_MODERATE` permission-тэй Platform account-ын action байна.
- Restaurant Manager зөвхөн өөрийн `restaurant_id` болон холбоотой order-ыг удирдана.
- Reception minibar тайлангийн бүтээгдэхүүн/тоо/дүнг засахгүй; зөвхөн Cleaner-д буцаах, маргаан тэмдэглэх болон батлагдсан correction/refund-ийг гүйцэтгэх хүрээнд ажиллана.
- Manager/Manager Plus онцгой minibar тайлан үүсгэхдээ өрөөг бодитоор шалгаж, шалтгаан оруулна. Hotel Admin-д энэ operational action автоматаар үүсэхгүй; Manager role тусдаа байна.
- Product cost, warehouse receipt, waste/adjustment, initial room minibar mode/template, pending target болон shortage override нь Manager/Manager Plus action байна. Existing room-ийн current config болон түүнд заасан exact template version-ийг шууд edit хийхгүй; config change request + reconciliation-аар солино. Hotel Admin-д эдгээр action автоматаар үүсэхгүй.
- Stay-ийн hourly/nightly tariff нь тусдаа config байна. Бүх багцын Manager, мөн 30,000₮-ийн Manager Plus hotel default, category override болон зөвхөн walk-in-д ашиглах room override-ийг create/update/unset хийж болно; Hotel Admin-д Manager role тусдаа шаардлагатай. Reception tariff config өөрчлөх, нэгж үнэ зохиох эсвэл override хийхгүй.
- Walk-in effective rate-ийг сервер `room override → category override → hotel default`, online quote-ийг `category override → hotel default` дарааллаар бодно. `null`/unset override дараагийн түвшинг өвлөнө; online booking физик room дараа оноодог тул room override-ийг quote-д ашиглахгүй.
- Walk-in check-in/online booking confirmation үед unit price, source level/ID болон config version snapshot хадгална. Paid/confirmed online booking-ийн snapshot room assignment/check-in үед хэвээр байх бөгөөд өөр room override болон дараагийн tariff edit reprice хийхгүй. Tariff edit, resolution/confirmation болон denied override attempt аудиттай байна (`STAY-DEC-005`).
- P0-38B нь Manager-д hourly minimum/maximum/increment тохируулах шинэ permission эсвэл field үүсгэхгүй. Reception хугацааны одоогийн сонголтоо ашиглаж, сервер effective нэг цагийн үнийг сонгосон цагийн тоогоор үржүүлэх `STAY-DEC-002` томьёог `STAY-DEC-006`-ын дагуу хэвээр мөрдөнө.
- P0-38C нь шинэ role permission үүсгэхгүй. Reception хоногийн stay-д эерэг бүхэл `N` шөнө сонгоно; сервер planned checkout-ийг hotel-local check-in date + `N` календарийн өдөр дээр snapshot хийсэн fixed check-out цагаар бодож, nightly total-ийг effective unit rate × `N` гэж тооцно. Confirmation/check-in үед дараагийн booking/cleaning buffer-ийг дахин шалгаж, nights, rate/source/config version, fixed checkout time болон planned checkout snapshot хадгална. Later tariff/check-out config edit confirmed booking/active stay-г өөрчлөхгүй (`STAY-DEC-007`). Early-morning cutoff түр хойшлогдсон.
- P0-39A нь шинэ role/action permission үүсгэхгүй. Booking/stay overlap-ийг сервер `[start, end)` interval-аар шалгаж, actual checkout-оос өмнө `planned checkout + snapshotted cleaning buffer`, дараа нь `actual checkout + ижил snapshotted cleaning buffer` ашиглана. Check-in үед server time уг хугацаанд хүрсэн эсвэл өнгөрсөн, actual cleaning state `Цэвэр`, applicable minibar readiness хангагдсан эсэхийг authoritative байдлаар шалгана. Cleaning state-ийг 20,000₮ багцад Manager, 25,000₮/30,000₮ багцад Cleaner existing эрхээр өөрчилнө; Reception зөвхөн харна. Early checkout confirmed next booking-ийг автоматаар урагшлуулахгүй, late checkout overdue fee автоматаар үүсгэхгүй (`STAY-DEC-008`).
- P0-39B-1 нь existing Reception check-in action-ийн initial-confirmation input байна. Default actual time server now; past actual time сонгох бол 120 минут, current open shift, current hotel-local day болон online booking planned start-ын `max` доод хязгаар, server-now дээд хязгаар, reason code шаардлагатай. Current open shift байхгүй бол confirmation хориглоно. Note optional; Manager approval/evidence шаардахгүй. Manager/Hotel Admin зөвхөн Reception role тусдаа авсан үед энэ operational action хийнэ.
- Confirmation transaction нь `[actual, planned_checkout)` overlap, historical previous-checkout + snapshotted buffer, requested-time `Цэвэр`/applicable minibar readiness, lifecycle/blocker, next booking + buffer болон `planned_checkout > server_now`-г server-side шалгана. Historical readiness нотлогдохгүй бол past time хориглож server-now сонголт өгнө.
- `actual_check_in_at`/`check_in_recorded_at` immutable. Activation-аас хойш ямар ч role original field-ийг direct edit хийхгүй; approved correction нь зөвхөн `STAY-DEC-010` immutable amendment ашиглана. Tariff/current room-minibar config/minibar price/opening snapshot recorded-at current state ашиглаж, paid online reprice болохгүй; payment/cash current shift-д, Police matching recorded-at үед үүснэ. Bound, reason/note, actor, refs болон validation бүрэн audit-тай (`STAY-DEC-009`).
- P0-39B-2-т Reception зөвхөн `ACTIVE`, checkout эхлээгүй stay-д corrected time + mandatory reason-тэй request submit хийнэ. Нэг stay-д нэг pending request checkout initiation-ийг блоклоно. Manager role approve/reject хийнэ; Hotel Admin болон Manager Plus-д Manager role тусдаа шаардлагатай. Reception + Manager role нэг account өөрийн request-ийг баталбал `self_approved` audit хадгална.
- Correction bound original `check_in_recorded_at`/original shift/recorded-at local day/online planned start дээр түгжигдэж, approved effective time-ээс гулсахгүй. Server unchanged planned checkout-аар previous-stay buffer, historical `Цэвэр`/minibar readiness, overlap/lifecycle/blocker/next booking-ийг дахин шалгана.
- Original event/field overwrite болохгүй; approved immutable amendment latest effective actual start гаргана. Planned checkout, selected hours/nights, stay type, prices, deposit/payment/cash shift, config/stock snapshots болон Police original Match/alert/detected timestamps өөрчлөгдөхгүй, duplicate alert үүсэхгүй. Guest registry/Excel latest approved effective time ашиглана.
- Submit/approve idempotent, decision concurrency-safe. Checkout эхэлсэн/дууссан, fixed original bound-аас гадуур эсвэл өөр pending request-тэй үед хориглоно. Original/amendment/requester/approver/self-approved/Police link бүрэн audit-тай (`STAY-DEC-010`).
- P0-39C-1-ийн `STAY-DEC-011` direct-overwrite guard хэвээр. P0-39C-2-ын `STAY-DEC-012`-оор confirmed booking/`ACTIVE` stay-ийн `planned_checkout_at`/effective planned end-ийг MVP-д огт өөрчлөхгүй; amendment, request/approve/execute action, button/API, extension, planned-end shorten/lengthen болон hourly ↔ nightly conversion permission аль ч role-д үүсэхгүй.
- Initial stay type/duration choice нь confirmation-оос өмнөх existing booking/check-in input хэвээр. Confirmation-оос хойш бүх role-д immutable planned end үйлчилнэ.
- Existing Reception checkout permission зочны early/on-time/late бодит checkout-ийг `actual_checkout_at`-аар бүртгэхэд хэвээр. Энэ нь original planned checkout, үнэ/төлбөр/cash, room/minibar configuration, price/opening/stock snapshot-ийг өөрчлөхгүй.
- Early actual checkout automatic reprice/refund, overdue automatic fee/penalty үүсгэхгүй; overdue үед status/time л харагдана. Room actual checkout хүртэл occupied бөгөөд дараа нь P0-39A-ийн snapshotted buffer + actual cleaning + applicable minibar readiness gate үйлчилнэ.
- Overdue stay–next confirmed booking conflict `STAY-DEC-013`-ын hard blocker, same-category Reception reassignment, Manager/Manager Plus higher-category approval болон hotel-caused cancellation урсгалаар хаагдсан. Online cancellation/no-show permission-ийг §3.3 болон `PAY-DEC-007`-оор мөрдөнө.
- Хүчинтэй minibar entitlement-тэй hotel-д 25,000₮-ийн Manager, 30,000₮-ийн Manager/Manager Plus template version-ийн `DRAFT` үүсгэж, бүтээгдэхүүн болон target тоог засна. Draft нь room config-д assign хийх боломжгүй; `PUBLISHED` version-ийн бүтээгдэхүүн/target immutable бөгөөд өөрчлөх бол түүнээс шинэ Draft үүсгэнэ.
- Зөвхөн `DRAFT` version-ийг Publish хийнэ. Сервер parent template entity `ACTIVE`, дор хаяж нэг ижил hotel-ийн `ACTIVE` product-той, давхардсан product-гүй, product бүрийн target quantity эерэг бүхэл тоо эсэхийг шалгана. Нөхцөл хангахгүй бол хэсэгчилсэн Publish хийхгүй, version Draft хэвээр үлдэнэ.
- Template entity-ийн анхны Published version автоматаар цорын ганц Default болно. Дараагийн version publish хийхэд одоогийн Default өөрчлөгдөхгүй; Manager/Manager Plus тусдаа `Set default` action-аар ижил template-ийн eligible exact Published version-ийг сонгож, яг нэг Default invariant-ийг атомикаар хадгална.
- `Publish` болон `Set default` нь existing room-ийн exact current/pending version, active stay эсвэл booking pointer болон price snapshot-ийг өөрчлөхгүй, stock movement хийхгүй, Cleaner task, configuration request эсвэл check-in blocker үүсгэхгүй. Эдгээр action-ийг 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus хийнэ. Hotel Admin-д хүчинтэй entitlement дээр тохирох operational role тусдаа шаардлагатай.
- Зөвхөн Default биш `PUBLISHED` version-ийг Archive хийж болно. Default version-ийг Archive хийхийн өмнө өөр eligible Published version-ийг Default болгоно; өөр version байхгүй бол Archive хийхгүй. Exact version-ийг аль нэг room current/pending байдлаар заасан, active stay ашиглаж байгаа, эсвэл түүнтэй холбоотой nonterminal configuration request, reconciliation/rollback эсвэл Cleaner task байвал Archive-ийг сервер хориглоно.
- Historical stay, report, price book, invoice/export, inventory movement болон audit reference нь Archive-ийг хориглохгүй бөгөөд Archive хийсний дараа бүрэн хадгалагдана. Future booking version pin хийдэггүй учраас Archive blocker болохгүй, booking-д өөрчлөлт оруулахгүй.
- Archive нь room/pending/stay/booking pointer болон price snapshot-ийг өөрчлөхгүй, stock movement хийхгүй, Cleaner task, configuration request, Rollout эсвэл check-in blocker үүсгэхгүй. `ARCHIVED` terminal; дахин ашиглах бол шинэ `DRAFT` болгон clone хийнэ.
- Archive action-ийг хүчинтэй entitlement-тэй үед 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus хийнэ; Hotel Admin-д багцад зөвшөөрөгдсөн operational role тусдаа шаардлагатай.
- Explicit Rollout нь room-ийн current version-тэй ижил hotel, ижил `ACTIVE` template entity-ийн exact `PUBLISHED` target version-ийг сонгоно. Target version-ийн бүх product `ACTIVE`; eligible room нь `ACTIVE`, minibar `ON`, ижил template-ийн өөр current version-тэй бөгөөд өөр nonterminal pending configuration-гүй байна. ON/OFF mode эсвэл өөр template рүү шилжих нь Rollout биш, P0-37B-ийн existing configuration-change урсгалыг ашиглана.
- Per-room Rollout confirm хийхэд тухайн room-д exact target version-оор pin хийсэн pending configuration request болон шинэ check-in/assignment blocker шууд үүснэ. Active stay-тай room-ийг сонгож болох ч `SCHEDULED_AFTER_STAY` төлөвт орно; active stay эсвэл checkout/payment/minibar report/refill-ийн аль нэг дуусаагүй үед Cleaner task үүсэхгүй. Room vacant бөгөөд эдгээр safe-point item бүгд terminal бол Cleaner reconciliation task шууд үүснэ.
- Rollout confirm дангаараа stock movement хийхгүй, current version эсвэл stay price snapshot/үнэ өөрчлөхгүй. Cleaner reconciliation болон P0-37B-ийн final validation амжилттай дуусахад exact target нь room-ийн current version болж pending request атомикаар terminal болно. Дараа нь Default солигдох эсвэл өөр version Publish болох нь pinned target-ийг өөрчлөхгүй; nonterminal pending target нь тухайн version-ийг Archive хийхийг хориглоно.
- Rollout action-ийг 25,000₮-д зөвхөн Manager, 30,000₮-д Manager эсвэл Manager Plus хийнэ. Hotel Admin-д тохирох operational role тусдаа шаардлагатай; 20,000₮, minibar entitlement-гүй hotel болон 25,000₮-ийн Manager Plus role-оор action хийхийг UI/API аль алинд хориглоно. Нэг room-ийн дүрэм P0-37C-2B-2-т батлагдсан (`RML-DEC-022`–`RML-DEC-024`).
- Multi-room Rollout batch нь нэг `hotel_id + template_id + exact PUBLISHED target_version_id` болон олон selected room-оос бүрдэнэ. Preview нь read-only бөгөөд room бүрийг `READY_NOW`, `SCHEDULE_AFTER_STAY`, эсвэл reason-тэй `INELIGIBLE` гэж ангилна; pending request, blocker, Cleaner task, stock movement, price/room/stay өөрчлөлт үүсгэхгүй.
- Confirm үед сервер room бүрийг дахин шалгаж partial success хэрэглэнэ. Eligible room бүр existing P0-37C-2B-2 дүрмээр өөрийн атомик child pending request болон immediate check-in/assignment blocker авна; invalid room `SKIPPED` + reason болж blocker авахгүй. Нэг child-ийн failure бусдыг зогсоохгүй, rollback хийхгүй; batch parent зөвхөн grouping/progress бөгөөд inventory ledger, guest эсвэл financial side effect үүсгэхгүй.
- Child бүр independently явна. Batch parent нь дор хаяж нэг accepted non-terminal child байвал `IN_PROGRESS`; сонгосон room бүр accepted болж, accepted child бүр `APPLIED` бол `COMPLETED`; дор хаяж нэг room accepted болсон бөгөөд accepted child бүр movement эхлэхээс өмнө `CANCELLED` бол `CANCELLED`; нэг ч room accepted болоогүй бол `FAILED_VALIDATION`; accepted child бүр terminal боловч эдгээр terminal нөхцөлд орохгүй бол `PARTIALLY_COMPLETED` байна.
- `Cancel remaining` нь movement эхлээгүй child-ийг cancel хийж blocker-ийг арилгана; movement эхэлсэн child existing compensating rollback урсгалд орж terminal болтол blocked байна; `APPLIED` child өөрчлөгдөхгүй бөгөөд өмнөх exact version рүү буцаах бол шинэ Rollout үүсгэнэ. Retry нь хуучин түүхийг засахгүй, `retry_of_batch_id` холбоостой шинэ batch үүсгэж target/room eligibility-г дахин шалгана.
- Batch exact target-т pinned байна; дараагийн Default/Publish target-ийг солихгүй. Preview alone Archive blocker биш; Confirm-оор accepted болсон nonterminal child/batch target Archive-ийг terminal болтол блоклоно. `FAILED_VALIDATION` эсвэл accepted child-гүй batch blocker биш.
- Duplicate Confirm нь idempotent; нэг room-д нэг nonterminal pending invariant болон authoritative concurrency lock үйлчилнэ. Cross-hotel room/version хүсэлтийг сервер deny хийнэ. Preview/Confirm/Cancel remaining/Retry эрхийг 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus хийнэ; Hotel Admin-д тохирох operational role тусдаа шаардлагатай, 20,000₮/unentitled hotel болон 25,000₮-ийн Manager Plus-аар gate тойрохгүй. Cleaner зөвхөн өөрт оноогдсон child task-ийг гүйцэтгэж, Reception batch/child state ба blocker-ийг read-only харна (`RML-DEC-025`–`RML-DEC-028`).
- Manager-ийн current selling price edit active stay-г reprice хийхгүй. Stay price book/report line-ийн unit price-ийг ямар ч role эсвэл client override хийхгүй; сервер check-in snapshot-оос бодно.
- Room/category/product/template lifecycle action нь Manager/Manager Plus permission-тэй. Deactivation шинэ operation-ийг шууд хаах боловч active stay/future booking-г автоматаар cancel/reprice хийхгүй. Referenced entity hard-delete болохгүй; Hotel Admin-д operational role тусдаа шаардлагатай.
- Room minibar configuration change request/cancel/shortage/variance/rollback шийдвэр нь Manager/Manager Plus action. Current болон pending config нь exact template version заана. Cleaner зөвхөн өөрт оноогдсон server-bounded reconciliation/rollback task-аар actual count болон room ↔ warehouse transfer батална; generic waste/adjustment/mode/template/override өөрчлөхгүй. Reception current/pending exact version болон blocker-ийг read-only харна.
- Configuration movement эхлэхээс өмнө Manager/Manager Plus direct cancel хийж болно. Нэг movement post болсон бол silent cancel хийхгүй, immutable compensating rollback шаардлагатай; terminal болтол physical room check-in/assignment blocker-тэй байна.
- Reception эсвэл Manager/Manager Plus active-stay refill request үүсгэж болно; request дангаараа stock movement биш. Зөвхөн Cleaner role-той хэрэглэгч өөрийн task-аар actual refill movement үүсгэнэ.
- Active stay-ийн warehouse return, room waste болон negative adjustment-ийг зөвхөн Manager/Manager Plus reason-тэй, stay-scoped non-guest movement болгоно. Cleaner warehouse balance, cost, waste/adjustment болон override-ийг шууд өөрчлөхгүй.
- Reception minibar `Хамаарахгүй/Бүтэн/Дутуу/Тодорхойгүй` болон хүчинтэй exception-ийг харна; override үүсгэхгүй.
- Manager/Manager Plus expense submit хийж зөвхөн өөрийн request/status-ийг харна; full financial KPI/graph/Excel харахгүй.
- Hotel Admin expense category болон approved-for-payment/rejected шийдвэрийг удирдана. Approval нь cash-outflow биш; approved request-ийг бодитоор execute хийхэд `Paid` болно. Cash method active drawer movement үүсгэж, Card/POS болон bank/QPay reference-тэй боловч drawer movement үүсгэхгүй. Жижиг hotel-д Hotel Admin self-approved/self-executed хийж болно.
- Hotel Admin drawer/safe болон full cash report-ийг удирдана. Manager/Manager Plus transfer/top-up/request/review, Reception өөрийн shift/customer cash болон approved payout execution хүрээтэй байна.
- Hotel Admin, Manager/Manager Plus customer cash receipt/refund хийх бол Reception role тусдаа шаардлагатай.
- Deposit hotel/category config болон confirmation-оос өмнөх source/exemption correction нь Manager/Manager Plus operational action; Hotel Admin-д тохирох role тусдаа байна. Deposit авах, ердийн суутгал/үндсэн сувгийн refund execute болон correction/refund/cancel хүсэлт нь Reception action; alternate-channel refund, authoritative failed/pending refund release болон financial correction approve/reject нь Manager/Manager Plus action байна. Ердийн барьцааны суутгалд нэмэлт approval шаардахгүй.
- Bank/owner withdrawal Hotel Admin approval-тай; drawer ↔ safe transfer нэмэлт approval-гүй боловч reason/audit-тай байна.
- Pending drawer transfer complete эсвэл бодитоор буцааж cancel болоогүй бол оролцсон shift close/handover хийхгүй.
- Police action нь Police scope/ABAC дүрэмтэй; Hotel tenant scope-оос тусдаа байна.
- Permission-г зөвхөн button нуух байдлаар хэрэгжүүлэхгүй; API/action бүр шалгана.
- Role/permission олгосон, цуцалсан, action зөвшөөрсөн/хориглосон чухал үйлдлийг хэрэглэгч, scope, цаг болон шалтгаантай аудитад хадгална.
- Multi-room Rollout audit нь immutable batch parent, child request бүрийн room/eligibility/reason/result, exact target, `retry_of_batch_id`, Confirm/Cancel/Retry actor-role-package/server time болон idempotency key-г хадгална. Batch parent-ийг stock, guest эсвэл financial movement мэт бүртгэхгүй; child reconciliation/rollback movement existing configuration audit-тай холбоотой байна.
- Нууц үг, OTP, activation/reset token болон provider secret audit/log-д хадгалахгүй.

## 9. MVP acceptance criteria

- Hotel Admin operational action хийхийн тулд тохирох Manager/Reception role-ийг тусад нь авсан байна.
- Бүх багцын Manager hourly/nightly stay tariff-ийг тусад нь тохируулж, Hotel Admin зөвхөн нэмэлт Manager role-той үед энэ config-г өөрчилнө.
- Walk-in тариф room → category → hotel, online тариф category → hotel дарааллаар server-resolved байна; unset override inheritance-тай, online quote room override ашиглахгүй.
- Reception/client нэгж үнэ зохиох/override хийхгүй; confirmation unit price, source level/ID, config version snapshot-тай, дараагийн edit/room assignment confirmed booking болон active stay-г reprice хийхгүй.
- Хоногийн stay-ийн nights эерэг бүхэл байна; planned checkout нь hotel-local check-in date + nights өдөр дээр snapshotted fixed checkout time бөгөөд нэг шөнө check-in цагаас үл хамааран дараагийн календарийн өдрийн checkout цагт дуусна.
- Nightly total effective unit rate × nights байна. Сервер next booking/cleaning buffer-ийг recheck хийж, nights/rate source/config/fixed checkout/planned checkout snapshot хадгалан later config edit-ээс хамгаална.
- Booking/stay interval `[start, end)` байна. Сервер planning үед planned checkout + snapshotted buffer, actual checkout бүртгэгдсэний дараа actual checkout + ижил snapshotted buffer ашиглаж, check-in агшинд buffer + actual cleaning `Цэвэр` + applicable minibar readiness-ийг хамтад нь шалгана.
- P0-39A нь шинэ permission үүсгэхгүй; 20,000₮ багцын Manager болон 25,000₮/30,000₮ багцын Cleaner existing cleaning-state эрхээ хэвээр ашиглана. Early checkout next confirmed booking-ийг автоматаар урагшлуулахгүй. `STAY-DEC-012`-оор early automatic reprice/refund болон overdue automatic fee/penalty байхгүй; next-booking conflict `STAY-DEC-013`-аар хаагдсан.
- Reception initial confirmation-оос өмнө л STAY-DEC-009 bound-д reason code-той actual time сонгоно; Manager approval/evidence шаардахгүй. Confirmation-оос хойш direct edit хийх эрх аль ч role-д байхгүй.
- Historical readiness нотлогдоогүй backdate fail болж server-now сонголт өгнө; immutable actual/recorded timestamps, recorded-at snapshot, current-shift cash, recorded-at Police match болон full audit хадгалагдана.
- Reception ACTIVE stay/checkout эхлээгүй үед mandatory reason-тэй correction request submit хийж, нэг pending request checkout initiation-ийг блоклоно.
- Manager approve/reject хийнэ; Hotel Admin/Manager Plus-д Manager role тусдаа. Reception+Manager self-approval `self_approved` audit-тай байна.
- Approved immutable amendment fixed original bound/historical recheck-ээр зөвхөн effective actual start өөрчилнө; original field, planned duration/checkout, price/financial/config/stock болон Police timestamps unchanged байна. Registry/Excel latest approved effective time ашиглана.
- Confirmed booking/`ACTIVE` stay-ийн planned/effective end direct edit болон amendment/extension/shortening/conversion permission бүх role-д MVP турш deny; change action/button/API байхгүй.
- Reception existing checkout permission early/on-time/late `actual_checkout_at` бүртгэх боловч original planned checkout болон financial/config/stock snapshot өөрчлөхгүй.
- Early actual checkout automatic reprice/refund, overdue automatic fee/penalty үүсгэхгүй; room actual checkout хүртэл occupied, дараа нь snapshotted buffer + actual cleaning + applicable minibar readiness gate үйлчилнэ.
- Нэг хэрэглэгчийн олон hotel role-ийн permission зөв нийлж үйлчилнэ.
- Hotel Admin Manager/Manager Plus role-гүйгээр deposit config, pre-confirm source/exemption correction эсвэл alternate-channel refund/financial correction approval хийхгүй; customer deposit/refund/request action-д Reception role тусдаа байна.
- Ердийн deposit deduction нэмэлт approval-гүй боловч server-computed balance, actor, allocation болон audit-тай байна.
- Suspension security revoke нэн даруй хүчинтэй; unfinished Reception/Cleaner/Restaurant work нь эрх бүхий Manager/Manager Plus-аар reassign/takeover хийгдэж, бодит execution-д Reception/Cleaner/Restaurant Manager role тусдаа шалгагдана.
- Hotel Admin болон Manager guest registry/list Excel болон official reply-г 20/25/30 бүх багцад, Manager Plus зөвхөн 30,000₮ багцад ашиглана. Нийтлэгдсэн review report хийх эрх нь зөвхөн Online Booking realm-ийн дурын authenticated Guest account-д package-аас үл хамааран нээлттэй; hotel staff role дангаараа уг эрхийг нээхгүй.
- Hotel role review нуух/сэргээхгүй; explicit `REVIEW_MODERATE`-гүй Operation/Platform account moderation action хийхгүй.
- Guest booking owner өөрийн booking-ийг check-in-ээс өмнө цуцалж, cutoff өнгөрсний дараах no-show-г Reception эсвэл Manager л батална; Manager Plus role дангаараа no-show хийхгүй.
- Conflict үед ижил category room-ийг Reception оноож, higher category болон `CANCELLED_HOTEL`-ийг Manager/Manager Plus шийднэ. Provider refund success-ийг hotel role гараар батлахгүй.
- 20,000₮ package-д Cleaner/Minibar/Restaurant UI/API ажиллахгүй.
- 25,000₮ package-д Restaurant UI/API ажиллахгүй.
- Restaurant Manager өөр Restaurant-аас бусад menu/order харахгүй.
- Reception өрөөний үнэ, product, stock болон role өөрчлөхгүй.
- Reception minibar report-ийн бүтээгдэхүүн, тоо болон дүнг засахгүй.
- Онцгой minibar тайлан болон төлбөрөөс өмнөх маргааны шийдвэр зөвхөн Manager/Manager Plus permission-тэй байна.
- Reception inventory balance, cost, waste/adjustment, room minibar mode/template болон shortage override өөрчлөхгүй.
- Hotel Admin Manager role-гүйгээр minibar inventory operational action хийхгүй.
- Cleaner minibar selling price харахгүй; Reception/Manager locked check-in price-ийг read-only харна.
- Active stay-ийн report/correction current product price-аар reprice болохгүй.
- Active-stay refill request-ийг Reception/Manager/Manager Plus үүсгэж, зөвхөн Cleaner task actual warehouse → room movement болгоно.
- Active stay-ийн non-guest room stock-out-ийг Reception/Cleaner хийхгүй, зочны хэрэглээ гэж автоматаар тооцохгүй.
- Manager/Manager Plus room config change-г үүсгэх/товлох/цуцлах, shortage/variance/rollback шийдэх эрхтэй; Hotel Admin-д operational role тусдаа байна.
- Хүчинтэй minibar entitlement-тэй үед 25,000₮-ийн Manager, 30,000₮-ийн Manager/Manager Plus template version Draft үүсгэж/засах боловч Draft-ийг room config-д assign хийхгүй, Published version-ийн бүтээгдэхүүн/target-ийг шууд засахгүй.
- Зөвхөн Draft дээрх Publish validation нь `ACTIVE` parent template, дор хаяж нэг ижил hotel-ийн `ACTIVE` product, давхардалгүй product болон эерэг бүхэл target quantity-г шаардана; бүтэлгүй бол хэсэгчилсэн transition хийхгүй.
- Анхны Published version автоматаар цорын ганц Default болох ба дараагийн Publish Default-ийг өөрчлөхгүй; `Set default` тусдаа action байна.
- Publish/Set default existing exact room/pending/stay/booking pointer, price snapshot, stock, Cleaner task, configuration request болон check-in blocker-т нөлөөлөхгүй; 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus зөвшөөрөгдөж, Hotel Admin-д тохирох role тусдаа шаардана.
- 25,000₮ багцад Manager Plus role үүсгэж Publish/Set default/Archive/Rollout permission авах боломжгүй.
- Archive зөвхөн Default биш Published version дээр зөвшөөрөгдөж, room current/pending, active stay эсвэл nonterminal reconciliation/Cleaner/configuration task reference байвал хориглогдоно.
- Historical stay/report/price book/invoice/export/inventory/audit reference Archive-ийг хориглохгүй, устахгүй; future booking version pin хийдэггүй тул Archive blocker болохгүй.
- Archive ямар ч pointer/price snapshot/stock-ийг өөрчлөхгүй, task/configuration request/Rollout/check-in blocker үүсгэхгүй; Archived version terminal бөгөөд reuse хийх бол шинэ Draft clone үүсгэнэ.
- Archive blocker-ийн final recheck, `PUBLISHED → ARCHIVED` state change болон audit нэг атомик ажиллагаа байна.
- Archive permission нь Publish/Set default-тэй ижил package-role gate ашиглана: 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus; Hotel Admin-д тохирох role тусдаа байна.
- Rollout target нь room-ийн current version-тэй ижил hotel, ижил `ACTIVE` template-ийн exact `PUBLISHED` version бөгөөд target product бүр `ACTIVE` байна; mode/template switch нь Rollout action-аар хийгдэхгүй.
- Зөвхөн `ACTIVE`, minibar `ON`, ижил template-ийн өөр current version-тэй, өөр nonterminal pending configuration-гүй room Rollout-д eligible байна. Active stay-тай room-ийг сонгож болох ч `SCHEDULED_AFTER_STAY` төлөвт хүлээнэ.
- Rollout confirm хийхэд exact target-т pinned room-level pending request болон check-in/assignment blocker шууд үүснэ. Safe/vacant room-д Cleaner reconciliation task шууд, active stay эсвэл unfinished checkout/payment/minibar report/refill-тэй room-д бүх safe-point item terminal болсны дараа үүснэ.
- Rollout confirm stock/current version/price snapshot-ийг өөрчлөхгүй; Cleaner reconciliation болон P0-37B validation амжилттай дуусахад exact target current version болж атомикаар applied болно. Дараагийн Default/Publish pinned target-ийг солихгүй, pending target Archive blocker байна.
- Rollout permission нь 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus; Hotel Admin-д тохирох operational role тусдаа байна. 20,000₮/entitlement-гүй hotel болон 25,000₮-ийн Manager Plus action deny болно.
- Multi-room Preview нь нэг hotel/template/exact Published target-ийн room бүрийг side effectгүйгээр `READY_NOW`, `SCHEDULE_AFTER_STAY`, `INELIGIBLE + reason` гэж харуулж, Confirm дээр дахин шалгана.
- Multi-room Confirm partial success хэрэглэнэ: eligible room бүр тусдаа атомик child pending request + immediate blocker авна; invalid room `SKIPPED` + reason бөгөөд blocker-гүй; нэг child-ийн failure бусдыг stop/rollback хийхгүй.
- Batch parent grouping/progress-only байна. Дор хаяж нэг accepted non-terminal child байвал `IN_PROGRESS`; сонгосон room бүр accepted болж, accepted child бүр applied бол `COMPLETED`; дор хаяж нэг room accepted болсон бөгөөд accepted child бүр movement-ээс өмнө cancel бол `CANCELLED`; accepted room огт байхгүй бол `FAILED_VALIDATION`; accepted child бүр terminal боловч дээрх terminal нөхцөлд орохгүй, тухайлбал skipped/cancelled/rolled-back/non-applied үр дүн холилдвол `PARTIALLY_COMPLETED` байна.
- `Cancel remaining` movement-гүй child-ийг cancel/unblock хийж, movement-started child-ийг existing compensating rollback-д оруулан terminal болтол blocked байлгана; `APPLIED` child өөрчлөгдөхгүй бөгөөд reverse хийхдээ өмнөх exact version рүү шинэ Rollout үүсгэнэ.
- Retry хуучин child/batch түүхийг edit хийхгүй; `retry_of_batch_id` холбоостой шинэ batch үүсгэж exact target болон rooms-ийг дахин шалгана. Duplicate Confirm idempotent, per-room one-pending invariant-тай, cross-hotel scope deny байна.
- Preview alone target Archive-ийг блоклохгүй; Confirm-оор accepted болсон nonterminal child/batch terminal болтол pinned target Archive blocker байна. `FAILED_VALIDATION`/accepted child-гүй batch blocker биш.
- Batch Preview/Confirm/Cancel remaining/Retry нь 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus; Hotel Admin-д тохирох operational role тусдаа, 20,000₮/unentitled hotel болон 25,000₮-ийн Manager Plus deny байна. Cleaner зөвхөн assigned child task, Reception read-only байна.
- Cleaner зөвхөн assigned configuration reconciliation/rollback task-аар хоёр чиглэлийн transfer батална; Reception current/pending exact template version болон blocker-ийг read-only харна.
- Existing current config/exact version ямар ч role-ийн direct edit-ээр солигдохгүй; config change request + reconciliation шаардана.
- Posted configuration movement-тэй request silent cancel болохгүй, linked compensating rollback movement шаардана.
- Reception entity lifecycle state/blocker-ийг room operation хүрээнд read-only харна; deactivate/reactivate/hard-delete хийхгүй.
- Retiring/inactive entity-г client хуучин ID-аар илгээсэн ч шинэ booking/check-in/assignment-д server талд хориглоно.
- Full sales/payment/receivable/deposit/expense/profit/top-5 dashboard болон financial Excel зөвхөн Hotel Admin-д байна.
- Manager/Manager Plus expense submit хийсэн нь full financial report харах эрх үүсгэхгүй.
- Expense approval дангаараа drawer balance/KPI-д нөлөөлөхгүй; Paid execution л expense KPI-д орно. Drawer balance-д зөвхөн cash method нөлөөлнө.
- Full cash drawer/safe report/export зөвхөн Hotel Admin-д байна.
- Reception зөвхөн өөрийн active drawer/shift болон approved execution хүрээнд ажиллана.
- Pending drawer transfer-тэй source/destination shift complete/cancel хийхээс өмнө хаагдахгүй.
- Cleaner guest identity, payment, deposit болон financial report харахгүй.
- Operation/Platform хэрэглэгч Hotel guest болон Police data харахгүй.
- Police Officer бүх hotel check-in list болон check-in export-д хандахгүй.
- Police Admin бүх hotel check-in list харах боловч bulk export хийхгүй; Officer mutation-ийг автоматаар өвлөхгүй. Found/False Match correction, manual identity, case lifecycle болон Wanted export нь canonical explicit permission/separation-of-duties шалгалттай байна.
- UI disabled байсан ч шууд API request эрхгүй action гүйцэтгэхгүй.
- Grace дууссан hotel-ийн operational action deny болно.
- Role/permission өөрчлөлт болон хамгаалагдсан action аудиттай байна.

## 10. Батлагдсан шийдвэр

### RBAC-DEC-001 — Multi-role ба explicit operational role

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Нэг hotel хэрэглэгч олон hotel role авч болно. Hotel Admin Manager/Reception operational action-ийг автоматаар өвлөхгүй; тохирох role-ийг тусад нь олгоно. Permission-үүд account + hotel scope дээр нийлж үйлчилнэ.

### RBAC-DEC-002 — Hotel action matrix

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel Admin, Manager, Manager Plus, Reception, Cleaner болон Restaurant Manager-ийн үндсэн action permission-ийг 3-р хэсгийн хүснэгтээр мөрдөнө. Full financial dashboard болон financial Excel зөвхөн Hotel Admin-д байна.

- **P0-38A нэмэлт:** Stay tariff config-ийг бүх багцын Manager, 30,000₮-ийн Manager Plus удирдана; Hotel Admin-д Manager role тусдаа шаардлагатай. Reception server-resolved tariff/snapshot-ийг read-only харж, үнэ зохиох/override хийхгүй. Effective rate precedence, online room-override хориг, confirmation snapshot болон no-reprice дүрмийг `STAY-DEC-005`-аар мөрдөнө.
- **P0-38B нэмэлт:** Hourly minimum/maximum/increment тохируулах шинэ action үүсгэхгүй. Өмнөх hourly price formula-г хэвээр хадгалах шийдвэрийг `STAY-DEC-006`-аар мөрдөнө.
- **P0-38C нэмэлт:** Reception existing check-in action-аар эерэг бүхэл nights сонгоно; server hotel-local date, snapshotted fixed checkout, nightly rate болон availability/cleaning rule-ээр authoritative planned checkout/total-ийг бодно. Шинэ permission үүсгэхгүй, early-morning cutoff түр хойшлогдсон (`STAY-DEC-007`).
- **P0-39A нэмэлт:** Existing booking/check-in/checkout/cleaning actions хэвээр байна; шинэ action эсвэл role permission нэмэхгүй. Server `[start, end)` overlap, planned/actual checkout-аас тооцсон snapshotted cleaning buffer болон actual readiness-ийн нийлмэл gate-ийг authoritative хэрэгжүүлнэ (`STAY-DEC-008`).
- **P0-39B-1 нэмэлт:** Reception existing initial Check-in action дотроо server-now default эсвэл STAY-DEC-009-ийн bound/reason-тэй past actual time сонгоно. Manager approval/evidence шаардахгүй; Reception role-гүй Manager/Hotel Admin хийхгүй. Activation-оос хойш direct-edit permission аль ч role-д үүсэхгүй (`STAY-DEC-009`).
- **P0-39B-2 нэмэлт:** Reception correction request submit; Manager approve/reject. Hotel Admin/Manager Plus-д Manager role тусдаа, Reception+Manager self-approval `self_approved` audit-тай. Original event direct edit болохгүй, pending checkout initiation-ийг блоклоно (`STAY-DEC-010`).
- **P0-39C-1 нэмэлт:** Confirmed booking/`ACTIVE` stay-ийн planned checkout direct edit бүх role-д deny; original planned end direct mutation-гүй байна (`STAY-DEC-011`).
- **P0-39C-2 нэмэлт:** MVP-д planned/effective end amendment/change/extension/shortening/conversion action эсвэл permission байхгүй. Initial type/duration зөвхөн pre-confirm input. Existing Reception checkout early/late actual time бүртгэх боловч planned end болон snapshots өөрчлөхгүй; early automatic refund/reprice, overdue automatic fee байхгүй, actual checkout хүртэл occupied, дараа нь P0-39A readiness gate үйлчилнэ (`STAY-DEC-012`).
- **P0-39D нэмэлт:** Overdue room-д давхар assignment/check-in хийхгүй. Ижил category reassignment нь Reception, higher-category нэмэлт төлбөргүй approval болон `CANCELLED_HOTEL` нь Manager/Manager Plus action; Hotel Admin-д тохирох operational role тусдаа байна (`STAY-DEC-013`).

### RBAC-DEC-003 — Package gate

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Role permission-ээс гадна 20,000/25,000/30,000₮ package entitlement-ийг UI/API түвшинд заавал шалгана.

### RBAC-DEC-004 — Platform/Operation separation

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Operation болон Platform Super Admin нь Hotel guest/operational болон Police data-г автоматаар харахгүй. SMS/reset/eBarimt, paid provisioning retry болон financial reconciliation зэрэг өндөр эрсдэлтэй Operation action бүр тусгай permission-тэй байна.

### RBAC-DEC-005 — Police үндсэн matrix

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Police Officer бүх hotel check-in list/export-д хандахгүй. Police Admin list харах боловч check-in bulk export MVP-д аль ч role-д байхгүй. Wanted Case Excel зөвхөн `WANTED_CASE_EXPORT` permission-тэй Police Admin-д байна. Exact active Match хайлт, acknowledge, өөрийн account-аар `Олдсон` батлах болон False Match хүсэлт гаргах эрх идэвхтэй Police Admin/Officer-д байна. Police Admin Officer-ийн mutation-ийг автоматаар өвлөхгүй; draft, manual identity, case lifecycle, Found/False Match correction approval болон export нь тус бүр canonical explicit permission, scope болон requester/approver separation-тэй байна.

### RBAC-DEC-006 — Server-side enforcement

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Permission, package, subscription/account state болон resource scope-ийг backend/API action бүр шалгана. UI button нуух/disabled болгох нь дангаараа authorization биш.

### RBAC-DEC-007 — Full financial report зөвхөн Hotel Admin-д

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Бүх hotel-ийн full income/expense, top-5 room, room/minibar financial dashboard болон financial Excel export-ийг зөвхөн Hotel Admin харна. Manager/Manager Plus энэ full тайланд хандахгүй; shift батлах, кассын зөрүү болон өөрийн хариуцсан ажиллагаанд шаардлагатай operational payment breakdown-ийг харсан хэвээр байна.

### RBAC-DEC-008 — Cleaner checkout exception-ийн эрх

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Reception minibar тайланг засахгүй, Cleaner-д залруулгад буцааж эсвэл маргаантай мөр тэмдэглэнэ. Manager/Manager Plus шалтгаантай онцгой minibar тайлан үүсгэж, төлбөрөөс өмнөх маргааныг шийдвэрлэнэ. Hotel Admin эдгээр operational үйлдлийг зөвхөн Manager/Manager Plus role тусад нь авсан үед хийнэ. Төлбөрийн дараах immutable correction/refund нь Manager/Manager Plus/Hotel Admin approval-тай байна.

### RBAC-DEC-009 — Minibar inventory ба shortage override-ийн эрх

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Product/current selling price/cost/opening stock/receipt/waste/adjustment, room minibar current/pending mode/template exact version, config change/cancel/variance/rollback болон `Дутуу minibar-тайгаар нээх` override-ийг Manager/Manager Plus удирдана. Тэд хүчинтэй minibar entitlement-тэй үед editable/non-assignable Draft version үүсгэж/засаж, батлагдсан validation-аар Publish болон тусдаа Set default хийнэ; Published version-ийн бүтээгдэхүүн/target immutable байна. Анхны Published version автоматаар цорын ганц Default болох бөгөөд дараагийн Publish Default-ийг өөрчлөхгүй. Publish/Set default existing exact pointer, price snapshot, stock, Cleaner task, configuration request болон check-in blocker-т нөлөөлөхгүй. Default биш Published version-ийг room current/pending, active stay болон nonterminal configuration request/reconciliation/rollback/Cleaner task reference байхгүй үед Archive хийнэ; historical stay/report/price book/invoice/export/inventory/audit болон version pin-гүй future booking blocker болохгүй. Archive ямар ч pointer/price/stock/task/configuration request/Rollout/check-in blocker side effect үүсгэхгүй, Archived terminal тул reuse хийхдээ шинэ Draft clone үүсгэнэ. Explicit Rollout нь eligible `ACTIVE`, minibar `ON` room-ийг ижил hotel, ижил `ACTIVE` template-ийн өөр exact `PUBLISHED` version рүү pinned pending request-аар шилжүүлнэ. Confirm нь check-in/assignment blocker шууд үүсгэх боловч stock/current version/price-ийг өөрчлөхгүй; safe/vacant room-д Cleaner task шууд, active stay эсвэл unfinished checkout/payment/minibar report/refill-тэй room-д `SCHEDULED_AFTER_STAY` бөгөөд safe point-ийн дараа task үүснэ. Cleaner reconciliation ба P0-37B validation амжилттай болоход current version атомикаар солигдоно; Default/Publish pinned target-ийг өөрчлөхгүй, pending target Archive blocker байна. Mode/template switch existing configuration-change урсгалаар хийгдэнэ. Publish/Set default/Archive/Rollout action-д 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus зөвшөөрөгдөнө; Hotel Admin-д тохирох operational role тусдаа шаардлагатай бөгөөд 20,000₮/entitlement-гүй hotel болон 25,000₮-ийн Manager Plus package gate-ийг давж гарахгүй (`RML-DEC-022`–`RML-DEC-024`). Reception эсвэл Manager/Manager Plus active-stay refill request үүсгэж, зөвхөн Cleaner role-той хэрэглэгч task-аар actual refill movement батална. Cleaner assigned configuration task-аар room ↔ warehouse transfer батлах боловч generic adjustment/target/override өөрчлөхгүй. Reception current/pending exact version, config/status/exception болон locked check-in price-ийг read-only харна; existing current config direct edit болохгүй, Manager price/config edit active stay-г reprice/reconfigure хийхгүй.

- **P0-37C-3 нэмэлт:** Multi-room Preview нь нэг hotel/template/exact target-ийн room-уудыг side effectгүй ангилж, Confirm room бүрийг дахин шалган partial success-аар тусдаа child request + blocker үүсгэнэ; invalid room `SKIPPED` + reason, нэг child failure бусдад нөлөөлөхгүй. Batch parent progress-only; Cancel remaining, compensating rollback, applied child-ийг шинэ Rollout-аар reverse хийх, `retry_of_batch_id`-тай шинэ retry, pinned target/Archive blocker болон idempotent per-room concurrency-г `RML-DEC-025`–`RML-DEC-028`-аар мөрдөнө. Batch Preview/Confirm/Cancel remaining/Retry нь 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus; Hotel Admin-д тохирох role тусдаа шаардлагатай. Cleaner assigned child task-аар ажиллаж, Reception batch/child state ба blocker-ийг read-only харна.

### RBAC-DEC-010 — Expense lifecycle ба financial report-ийн эрх

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Manager/Manager Plus expense хүсэлт submit хийж өөрийн operational request-ийг харна. Expense category, approved-for-payment/rejected, reversal/correction болон full financial dashboard/Excel зөвхөн Hotel Admin-д байна. Approval cash-outflow биш; Reception, Manager/Manager Plus эсвэл Hotel Admin-ийн Paid execution тусдаа. Cash method active drawer movement үүсгэнэ; Card/POS болон bank/QPay reference-тэй ч drawer movement үүсгэхгүй. Hotel Admin self-approved/self-executed хийж болно.

### RBAC-DEC-011 — Shift self-close ба review эрх

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Ердийн shift-ийн review-г Manager/Manager Plus, exception үед Hotel Admin хийнэ. Идэвхжүүлсэн нэг ажилтантай горимын Reception + Manager/Manager Plus account self-close хийж болно. Зөрүүгүй self-close нэмэлт review-гүй; зөрүүтэй self-close-г Hotel Admin review хийнэ. Review/rejection нь хаасан shift-ийг edit/reopen хийх эрх өгөхгүй.

### RBAC-DEC-012 — Cash drawer, transfer ба payout эрх

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel Admin drawer/safe/configured float/full cash report болон bank/owner approval удирдана. Drawer transfer болон bank-deposit request-д Hotel Admin нэмэлт Manager/Manager Plus role-той байна; owner/other withdrawal-ийг өөрөө үүсгэж approve хийж болох бөгөөд self-approved audit хадгална. Manager/Manager Plus drawer/safe transfer, bank/owner request, top-up, approved payout болон эрх бүхий correction review хийнэ. Reception өөрийн shift/customer cash, recipient confirmation болон approved payout execute хийнэ. Pending drawer transfer complete/cancel болоогүй бол оролцсон shift хаагдахгүй. Customer cash action-д Reception role тусдаа шаардлагатай.

### RBAC-DEC-013 — Deposit config ба correction permission

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel/category deposit config болон confirmation-оос өмнөх source/exemption correction-ийг Manager/Manager Plus хийнэ; Hotel Admin-д тохирох operational role тусдаа байна. Deposit авах, ердийн суутгал/үндсэн сувгийн refund execute болон exception/correction/cancel request нь Reception action. Alternate-channel refund, provider/cash authoritative failed refund reservation release болон financial correction approve/reject нь Manager/Manager Plus action; ердийн суутгалд нэмэлт approval шаардахгүй (`DEP-DEC-009`).

### RBAC-DEC-014 — Suspension дараах unfinished work

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Suspension/termination permission/session-ийг нэн даруй revoke хийж, unfinished work security action-ийг хойшлуулахгүй. Reception shift болон Cleaner task-ийг Manager/Manager Plus, Restaurant task-ийг 30,000₮-ийн Manager Plus same-scope queue-аар takeover/reassign хийнэ. Hotel Admin-д тохирох Manager/Manager Plus role, бодит ажлыг өөрөө гүйцэтгэхэд Reception/Cleaner/Restaurant Manager role тусдаа шаардлагатай. Previous actor/history immutable, reassignment idempotent болон audit-тай байна.

### RBAC-DEC-015 — Review ба guest registry permission

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel Admin болон Manager өөрийн hotel-ийн guest registry list/background Excel болон нэг official reply-г 20,000/25,000/30,000₮ багцад, Manager Plus зөвхөн 30,000₮ багцад ашиглана. Online Booking realm-ийн дурын authenticated Guest account нийтлэгдсэн review-г completed stay/hotel role/package-аас үл хамааран report хийж болно; hotel staff role дангаараа report эрх биш. Reception/Cleaner/Restaurant bulk guest accessгүй. Hotel role review нуух/сэргээхгүй; moderation queue/hide/restore/report resolution нь зөвхөн explicit `REVIEW_MODERATE` permission-тэй Platform account-д байна.

### RBAC-DEC-016 — Online cancellation/no-show/overbooking permission

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Authenticated booking owner check-in-ээс өмнө өөрийн booking-ийг цуцална. Cutoff өнгөрсний дараах no-show-г Reception эсвэл Manager батална; Manager Plus role дангаараа Manager permission өвлөхгүй. Conflict үед ижил category room assignment нь Reception, higher-category нэмэлт төлбөргүй approval болон `CANCELLED_HOTEL` нь Manager/Manager Plus action байна. Hotel Admin-д operational role тусдаа; provider refund success-ийг hotel/guest role гараар тэмдэглэхгүй.

### RBAC-DEC-017 — Explicit Operation permission ба takeover scope

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Operation/Platform role нэр дангаараа data/action эрх нээхгүй; onboarding provisioning retry, eBarimt retry, paid reconciliation, deposit late-refund reconciliation, access management болон offline recovery бүр explicit permission-тэй байна. Suspended Reception-ийн replacement зөвхөн `takeover_id`-тай pre-suspension pending item-ийн Reception canonical status-query/receive/return confirmation-ийг хийж, Manager cancel/approval эсвэл шинэ customer movement өвлөхгүй.

## 11. Хаагдсан төлөв ба лавлах баримтууд

Action-level permission matrix-ийн MVP P0 baseline, explicit Operation/finance permission, shift/cash drawer, Cleaner exception, minibar inventory/price snapshot, entity lifecycle, room configuration/Rollout, financial reporting, deposit correction, suspended-work takeover, review/guest registry, online cancellation/no-show/overbooking болон Police canonical permission батлагдсан. P0-39C planned-end lock-ийг `STAY-DEC-011`/`STAY-DEC-012`, overdue conflict-ийг `STAY-DEC-013`, False Match workflow/permission-ийг `POL-DEC-019`/`POL-DEC-021`-ээр мөрдөнө. Early-morning cutoff тусдаа түр хойшлогдсон P1 асуудал хэвээр байна.

Shift-ийг [03-reception-shift-handover.md](./03-reception-shift-handover.md)-д, online booking/payment-ийг [09-online-booking-system.md](./09-online-booking-system.md) болон [11-booking-payment-policy.md](./11-booking-payment-policy.md)-д, review-г [10-hotel-ratings-reviews.md](./10-hotel-ratings-reviews.md)-д, guest registry-г [12-hotel-guest-registry-report.md](./12-hotel-guest-registry-report.md)-д, Police permission-ийг [13-police-monitoring-system.md](./13-police-monitoring-system.md)-д, staff lifecycle-ийг [19-staff-account-lifecycle.md](./19-staff-account-lifecycle.md)-д, deposit/correction-ийг [20-deposit-and-payment-correction.md](./20-deposit-and-payment-correction.md)-д, cash ledger-ийг [24-cash-drawer-ledger.md](./24-cash-drawer-ledger.md)-д, entity/configuration lifecycle-ийг [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md)-д тодорхойлсон.
