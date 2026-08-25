# Minibar selling price snapshot

**Хувилбар:** 0.16  
**Төлөв:** P0-36 minibar price snapshot, P0-37 lifecycle isolation, P0-38 болон P0-39A–P0-39C-2 батлагдсан  
**Хамаарах үе шат:** MVP — Reception / Manager / Cleaner / Inventory / Finance

## 1. Зорилго

Зочин check-in хийснээс хойш Manager minibar бүтээгдэхүүний одоогийн үнийг өөрчилсөн ч тухайн stay-ийн төлбөр буцаад өөрчлөгдөхгүй байна. Cleaner-ийн үндсэн тайлан, Manager/Manager Plus-ийн онцгой тайлан, төлбөрийн өмнөх шинэ report version болон төлбөрийн дараах correction бүгд нэг stay-д ижил борлуулах үнэ ашиглана. Booking хийх үед minibar version pin хийхгүй; check-in амжилттай батлагдах үед room-ийн exact current `PUBLISHED` version-оос stay snapshot үүсгэнэ.

Minibar selling price болон inventory-ийн weighted average cost нь тусдаа snapshot байна:

- **Selling price:** check-in амжилттай батлагдах үеийн stay price book;
- **Cost/COGS:** зочны хэрэглээний inventory movement үүсэх үеийн weighted average unit cost.

## 2. Хамрах хүрээ

- Зөвхөн 25,000₮/30,000₮ багцын `Minibar ашиглана` өрөөнд үйлчилнэ.
- 20,000₮ багц болон `Minibar ашиглахгүй` өрөөнд price book, minibar report эсвэл minibar charge үүсэхгүй.
- Walk-in stay болон online nightly booking-д minibar snapshot-ийн ижил дүрэм үйлчилнэ. Online hourly байхгүй (`BK-DEC-012`).
- Room charge-ийн тарифын snapshot-оос тусдаа minibar price book байна.

### 2.1 Room тарифын snapshot-аас тусгаарлах

P0-38A-ийн `STAY-DEC-005`-аар room charge-ийн цагийн болон хоногийн тарифыг тус тусад нь resolve хийж snapshot болгоно. Walk-in үед `room override → category override → hotel default`, Online quote үед room override-гүй `category override → hotel default` дараалал ашиглана. Override тохируулаагүй бол дараагийн түвшнийг өвлөнө. Paid/confirmed Online booking-ийн room unit price, source level + source ID болон configuration version нь өрөө оноох/check-in хийхэд өөрчлөгдөхгүй; Walk-in stay check-in баталгаажихдаа ижил талбаруудаа snapshot болгоно. Reception room unit price-ийг гараар override хийхгүй бөгөөд Manager-ийн дараагийн tariff edit өмнөх booking/stay-г reprice хийхгүй.

Энэ room-rate snapshot нь minibar stay price book-тэй нэг хүснэгт, нэг source version эсвэл нэг unit price талбар болохгүй. Minibar price book нь зөвхөн энэ баримт бичгийн exact minibar template/product ба selling-price эх үүсвэрээ хадгална. Canonical room тарифын дүрэм: [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md)-ийн `STAY-DEC-005`.

## 3. Check-in үеийн stay price book

Reception check-in-ийг батлах үед сервер нэг атомик ажиллагаагаар:

1. room-ийн minibar mode, lifecycle `ACTIVE` template entity, exact `current_version_id` нь `PUBLISHED` эсэх болон бодит opening stock snapshot-ийг шалгана;
2. тухайн exact version-ийн immutable product list/target quantity-г ашиглаж, **бүх бүтээгдэхүүн** lifecycle `ACTIVE` эсэхийг шалган selling price-ийг уншина;
3. opening actual quantity `0` байсан бүтээгдэхүүнийг ч price book-д оруулна;
4. exact template/version холбоос болон price book бүрэн үүссэний дараа stay-г active болгоно.

Price book-ийн мөр бүр дор хаяж:

- hotel, stay, room;
- template entity ID болон exact template version ID;
- product ID;
- snapshot product name, category болон хэмжих нэгж;
- MNT selling unit price;
- opening actual болон template target quantity-ийн холбоос;
- source price/version;
- server `snapshot_at`

хадгална.

Minibar-enabled stay-д price book бүрэн үүсэхгүй бол check-in амжилттай батлагдахгүй. Active stay дээр snapshot байхгүй/эвдэрсэн бол current catalog price-аар нөхөж бодохгүй; payment-ийг түр зогсоож Manager/Hotel Admin-д system exception харуулна.

### 3.1 Backdated `actual_check_in_at` ба recorded-at snapshot

`STAY-DEC-009`-ийн дагуу Reception зөвхөн initial confirmation дээр mandatory reason-тэй, server time-оос 120 минутын дотор, current open shift болон hotel-local ижил өдөрт, Online booking бол `planned_checkin_at`-аас өмнө биш `actual_check_in_at` сонгож болно. `check_in_recorded_at` нь check-in-ийг server амжилттай баталгаажуулсан immutable цаг байна.

Backdated `actual_check_in_at` нь occupancy-ийн эхлэлийг тэмдэглэхээс historical snapshot time болохгүй. Minibar price book, exact current template/version, opening actual stock, product lifecycle болон selling price-ийг `check_in_recorded_at` дахь current authoritative state-аар нэг атомик confirmation дээр snapshot хийнэ. Систем actual timestamp руу буцаж хуучин catalog/configuration/stock/price сэргээх, historical opening snapshot зохиох, current snapshot-ийг өмнөх үнээр reprice хийхгүй.

Paid/confirmed Online booking-ийн locked room-rate snapshot өөрчлөгдөхгүй; room-rate snapshot нь minibar price book-оос тусдаа хэвээр. Backdate өөрөө stock/price/payment/financial movement эсвэл нэмэлт approval үүсгэхгүй. Stay `Active` болсны дараа Reception timestamp-ийг шууд edit хийхгүй; зөвхөн `STAY-DEC-010`-ын approved immutable amendment ашиглана. Audit нь actor/role, mandatory reason, `actual_check_in_at`, `check_in_recorded_at`, applied current exact version, opening snapshot болон server validation result-ийг хадгална.

### 3.2 Active stay actual-time amendment price book-ийг өөрчлөхгүй

Check-out эхлээгүй active stay дээр Reception reason-тэй actual-time correction request үүсгэж, Manager approve/reject хийнэ. Reception+Manager multi-role self-approve хийвэл `self-approved` flag хадгална. Нэг pending request check-out initiation-ийг блоклож, `Approved`/`Rejected` terminal болтол minibar report/payment workflow эхлэхгүй; check-out эхэлсэн/дууссан үед request/approval хориглоно.

Approved үед original check-in event болон price book overwrite болохгүй; immutable amendment-аас зөвхөн `effective_actual_check_in_at` derivation хийнэ. Requested time original `check_in_recorded_at`, original shift/local day, Online `planned_checkin_at`-аар anchored `STAY-DEC-009` window дотор байна.

Amendment нь planned checkout/duration/type, room-rate snapshot, minibar selling-price book, exact template/configuration, opening quantity, stock/refill/report/payment snapshot, deposit/payment/cash/recognized time-ийг өөрчлөхгүй. Current эсвэл historical price/config/stock сэргээхгүй, movement/reprice/reconstruction үүсгэхгүй (`STAY-DEC-010`).

### 3.3 Planned checkout minimal guard price book-д нөлөөлөхгүй

Confirmed booking эсвэл `ACTIVE` stay-ийн `planned_checkout_at`-ийг generic direct edit/PATCH-аар overwrite хийхгүй. MVP-д change байхгүй; STAY-DEC-011-ийн append-only history/revalidation нь зөвхөн post-MVP change хожим тусдаа батлагдвал мөрдөх invariant байна.

Minimal guard одоогоор хугацаа өөрчлөх button/API/action, taxonomy, permission/approval, eligibility, pricing/repricing, refund/payment дүрэм нээхгүй. Room-rate snapshot, minibar price book, exact template/configuration, opening quantity, stock/refill/report/payment snapshot болон event time immutable хэвээр; guard өөрөө reprice, movement, task, charge эсвэл financial side effect үүсгэхгүй.

### 3.4 P0-39C-2 — Planned-end complete lock price snapshot isolation

`STAY-DEC-012`-оор confirmed booking/active stay-ийн planned checkout MVP-д огт өөрчлөгдөхгүй. Amendment/action/button/API, extension, planned-end shorten болон hourly ↔ nightly conversion байхгүй. Early/late actual checkout зөвхөн `actual_checkout_at` бүртгэж original planned end-ийг өөрчлөхгүй.

Early actual checkout room/minibar charge-ийг auto reprice хийхгүй, refund үүсгэхгүй; overdue нь status/time л харуулж fee/penalty, charge/payment автоматаар үүсгэхгүй. Room actual checkout хүртэл occupied, дараа нь snapshot buffer + clean + applicable minibar readiness gate үйлчилнэ. Room-rate snapshot, minibar price book, exact config/version, opening quantity, stock/refill/report/payment snapshot, task/movement/event time immutable хэвээр.

## 4. Active stay-ийн үнэ өөрчлөгдөхгүй

- Manager/Manager Plus product-ийн одоогийн selling price-ийг өөрчилж болно.
- Шинэ үнэ зөвхөн өөрчлөлтөөс хойш server дээр амжилттай баталгаажиж `check_in_recorded_at` авсан check-in-үүдэд үйлчилнэ; зөвшөөрсөн actual-time backdate нь өмнөх үнийг сэргээхгүй.
- Active stay-ийн price book, template version болон өмнөх charge/report буцаад шинэчлэгдэхгүй.
- Үнэ өөрчлөх UI дээр `Шинэ үнэ зөвхөн дараагийн check-in-ээс үйлчилнэ` гэж анхааруулна.
- Price edit нь old/new price, actor болон server time-тэй аудиттай байна.

Жишээ:

```text
Check-in үеийн усны үнэ: 3,000₮
Active stay үргэлжилж байхад шинэ үнэ: 4,000₮
Cleaner-ийн батлагдсан хэрэглээ: 2 ус

Тухайн stay-ийн charge: 2 × 3,000₮ = 6,000₮
4,000₮ үнэ дараагийн check-in-ээс үйлчилнэ.
```

## 5. Cleaner болон Manager report-ийн үнэ

- Cleaner бүтээгдэхүүн болон хэрэглэсэн quantity-г тайлагнана; selling price харах, илгээх, сонгох эсвэл өөрчлөхгүй.
- Manager/Manager Plus-ийн `Онцгой minibar тайлан` мөн price override хийхгүй.
- Сервер report line бүрийн unit price-ийг зөвхөн тухайн stay-ийн price book-оос авна.
- Client request-д unit price ирсэн ч сервер үл тооно.
- Price book-д байхгүй product-ийг report/charge line болгон батлахгүй.

```text
Minibar line amount
= Батлагдсан хэрэглэсэн quantity
× Stay price book-ийн selling unit price
```

Reception болон Manager/Manager Plus report line дээр `Check-in үнэ` гэсэн read-only unit price болон line amount харна. Hotel Admin financial report/Excel-д мөн энэ snapshot үнэ ашиглагдана.

## 6. Opening quantity `0` болон active-stay refill

Template-д байсан боловч shortage-ийн улмаас opening actual quantity `0` болсон product price book-д хэвээр байна.

- Stay үеэр уг product-ийг бодитоор нөхөөгүй бол зочинд хэрэглээ тооцохгүй.
- Stay үеэр warehouse → room refill movement-ээр баримтжуулан нөхсөн бол check-in price book-ийн unit price хэрэглэнэ.
- Хэд хэдэн refill эсвэл өөр purchase batch байсан ч тухайн stay-ийн selling price өөрчлөгдөхгүй.
- Purchase batch болон weighted average cost-ийн өөрчлөлт нь зөвхөн COGS-д нөлөөлнө.

### 6.1 Баримтжуулсан active-stay refill task

`Баримтжуулсан refill` гэдэг нь гараар бичсэн тайлбар биш, дараах серверийн урсгалаар үүссэн хөдөлгөөн байна:

1. Reception эсвэл Manager/Manager Plus идэвхтэй stay дээр lifecycle `ACTIVE` product-оор `Minibar нөхөх хүсэлт` үүсгэнэ. Room нь тухайн stay-г дуусгаж буй `ACTIVE` эсвэл `RETIRING` төлөвтэй байж болно; `INACTIVE` room-д хүсэлт үүсгэхгүй.
2. Cleaner өөрт оноогдсон хүсэлтийг авч, бодитоор нөхсөн бүтээгдэхүүн болон quantity-г батална. Manager/Manager Plus refill-ийг өөрөө хийх бол Cleaner role тусдаа шаардлагатай.
3. Сервер stay `Active`, room/stay холбоос зөв, minibar enabled, шинэ request үед product `ACTIVE`, product тухайн stay price book-д байгаа болон warehouse stock хүрэлцээтэй эсэхийг шалгана.
4. Амжилттай батлахад warehouse → room transfer нэг атомик хөдөлгөөнөөр үүсэж, `stay_id`, `room_id`, `product_id`, `price_book_line_id`, task/request ID, requester, Cleaner, actual quantity болон server time-тай холбогдоно.
5. Cleaner selling price харахгүй. Refill request/task нь unit price авч явахгүй бөгөөд сервер тухайн stay-ийн locked price-ийг хэвээр ашиглана.

Нэмэлт Manager approval шаардахгүй; хүсэлт гаргасан нь stock movement биш, Cleaner-ийн бодитоор баталсан quantity л movement болно. Retry/давхар даралт нэг transfer-ийг дахин үүсгэхгүй.

Product deactivation-оос өмнө үүссэн pending task нь product `RETIRING` үед complete/cancel/боломжгүй гэсэн terminal төлөвт орж болно. Completion нь original task-ийн `created_at < deactivation_requested_at` холбоосыг шалгана. Pending task terminal болтол product `INACTIVE` болохгүй; inactive product дээр completion хийхгүй.

`Check-out эхлүүлэх`-ээс өмнө pending active-stay refill task-ийг дуусгах эсвэл цуцлах ёстой. Check-out эхэлсний дараа шинэ active-stay refill үүсгэхгүй; checkout report/payment lock-тэй өрсөлдөх inventory movement-ийг сервер хориглоно.

### 6.2 Зочны хэрэглээ биш stock-out

Active stay үед room-оос warehouse-д буцаасан, waste болгосон эсвэл тооллогын хасах adjustment хийсэн бүтээгдэхүүнийг зочны хэрэглээ гэж автоматаар тооцохгүй. Ийм movement-ийг зөвхөн Manager/Manager Plus шалтгаантайгаар stay-д холбож үүсгэнэ. Нотлох зураг болон хоёр дахь approval шаардахгүй.

Active stay үеийн generic эерэг adjustment нь billable quantity-г нэмэхгүй. Зочинд борлуулах боломжтой бодит нэмэлт бүтээгдэхүүнийг зөвхөн дээрх active-stay refill task-аар оруулна.

```text
Тухайн stay-д зочинд боломжтой quantity
= Opening actual quantity
  + Батлагдсан active-stay refill quantity
  − Stay-д холбосон non-guest room stock-out quantity

Тооцож болох хэрэглээ
= max(0, зочинд боломжтой quantity − Check-out үеийн actual quantity)
```

`Non-guest room stock-out` нь warehouse return, room waste болон room negative adjustment байна. Report version бүр тооцоонд орсон refill/non-guest movement ID болон cutoff time-ийг snapshot болгоно. Cleaner report-ийн quantity дээрх physical movement-үүдтэй нийцэхгүй бол report correction эсвэл Manager/Manager Plus-ийн батлагдсан exception урсгал ашиглана; current price-аар дахин үнэ тогтоохгүй.

## 7. Snapshot-д байгаагүй бүтээгдэхүүн

- Check-in price book-д ороогүй шинэ product-ийг active stay дунд нэмээд автоматаар charge хийхгүй.
- Client, Cleaner, Reception эсвэл Manager current product catalog-оос шинэ мөр оруулж active stay-г reprice хийхгүй.
- Ийм product-ийн inventory movement шаардлагатай бол санхүүгийн charge-аас тусдаа exception байдлаар аудиттай бүртгэж болно.
- Шинэ product эсвэл шинэ `PUBLISHED` template version үүссэн нь existing room-д автоматаар үйлчлэхгүй. Room-ийн exact current version батлагдсан configuration change/rollout-аар амжилттай солигдсоны **дараах check-in** л тухайн шинэ exact version-оор price book үүсгэнэ.

Product/template entity deactivation, hard-delete болон reactivation нь P0-37A-д батлагдсан: `RETIRING`/`INACTIVE` product эсвэл template entity шинэ configuration-д ашиглагдахгүй боловч өмнө үүссэн price book, report, invoice болон Excel нь current product нэр/үнэ/status-аас хамааралгүй snapshot мэдээллээ хадгална. Нэг room-ийн mode/template reassignment ба physical reconciliation нь P0-37B-д батлагдсан. P0-37C-1-ийн дагуу template version `DRAFT → PUBLISHED → ARCHIVED` lifecycle ашиглаж, Published version immutable байна; room current болон pending target exact version ID-г заана. P0-37C-2A-ийн дагуу Publish нь `ACTIVE` parent template, дор хаяж нэг ижил hotel-ийн `ACTIVE` product, давхардалгүй product болон эерэг бүхэл target quantity шаардана; анхны Published version автоматаар цорын ганц Default болж, дараагийн Publish Default-ийг өөрчлөхгүй. Publish/Set default existing price book эсвэл exact pointer-т нөлөөлөхгүй. P0-37C-2B-1-ийн дагуу Default биш Published version-ийг live operational reference байхгүй үед Archive хийж болох ба historical stay/report/price book/audit snapshot хэвээр хадгалагдана. P0-37C-2B-2-ийн explicit Rollout нь eligible room-ийг exact target version рүү pending reconciliation-аар шилжүүлэх боловч existing stay price book-ийг өөрчлөхгүй.

P0-37C-3-ийн multi-room Rollout нь нэг hotel/template/exact Published target-тай batch parent болон room бүрийн тусдаа child pending request ашиглана. Batch parent grouping/progress-only бөгөөд stay price book, report/payment snapshot, guest charge, room price эсвэл financial ledger үүсгэх/өөрчлөхгүй. Canonical lifecycle: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md).

### 7.1 Pending room configuration change ба stay snapshot

- Manager/Manager Plus active stay үргэлжилж байх үед room-ийн mode/template/exact `PUBLISHED` version өөрчлөлтийг pending байдлаар төлөвлөж болно.
- Pending request нь exact `pending_target_version_id` хадгална. Дараа өөр version publish/default болсон ч target автоматаар солигдохгүй бөгөөд тухайн active stay-ийн locked price book, pinned exact version, opening stock snapshot, report version болон charge-ийг өөрчлөхгүй; stay-г current catalog/configuration-аар дахин үнэ тогтоохгүй.
- Тохиргооны reconciliation амжилттай дуусаж, pending exact target version нь room-ийн `current_version_id` болсон **дараагийн check-in** тухайн exact current version-ийг ашиглан өөрийн шинэ stay price book-ийг үүсгэнэ.
- `Scheduled`, reconciliation-д бэлэн, ажиллаж буй, stock/variance-аар blocked эсвэл rollback шаардлагатай зэрэг **аль ч nonterminal pending configuration change** тухайн physical room-д шинэ check-in болон шинэ room assignment хийхийг хориглоно.
- Pending өөрчлөлт `Applied`, хөдөлгөөнгүйгээр `Cancelled`, эсвэл immutable нөхөн rollback хөдөлгөөнүүдээр `Rolled back` terminal болсны дараа л бусад check-in readiness шалгалт үргэлжилнэ.
- Future booking-ийг автоматаар цуцлах/дахин үнэлэхгүй бөгөөд minibar template/version-ийг booking хийх үед pin хийхгүй. Check-in үеийн амжилттай applied exact current configuration authoritative байна; өөрчлөлт дуусаагүй бол booking-ийг өөр eligible room-д шилжүүлэх буюу өөрчлөлтийг эхлээд шийднэ.

P0-37C-1-ийн дагуу `DRAFT` version room current/pending/check-in-д ашиглагдахгүй, `PUBLISHED` version-ийн product list/target quantity in-place edit болохгүй. P0-37C-2A-ийн `Publish` болон `Set default` action нь existing current/pending/stay/booking pointer болон stay price book-ийг өөрчлөхгүй, stock movement хийхгүй, Cleaner task, configuration request эсвэл check-in blocker үүсгэхгүй.

P0-37C-2B-1-ийн Archive нь зөвхөн Default биш exact `PUBLISHED` version дээр хийгдэнэ. Room current/pending reference, active stay эсвэл nonterminal configuration request/reconciliation/rollback/Cleaner task reference байвал хориглоно. Historical stay/report/price book/invoice/export/inventory/audit reference нь blocker биш бөгөөд snapshot-ийг устгахгүй; future booking version pin хийдэггүй тул blocker болохгүй. Archive өөрөө pointer/price snapshot/stock-ийг өөрчлөхгүй, task/configuration request/Rollout/check-in blocker үүсгэхгүй. `ARCHIVED` terminal; reuse хийх бол шинэ `DRAFT` clone үүсгэнэ.

P0-37C-2B-2-ийн explicit Rollout нь room-ийн current version-тэй ижил hotel, ижил `ACTIVE` template entity-ийн өөр exact `PUBLISHED` target version-ийг сонгож, target product бүр `ACTIVE` эсэхийг шалгана. Room нь `ACTIVE`, minibar `ON`, өөр nonterminal pending configuration-гүй байна; mode/template switch нь Rollout биш, existing configuration-change урсгал байна. Active stay-тай room сонгогдож болох боловч `SCHEDULED_AFTER_STAY` төлөвт орно.

Confirm амжилттай болоход exact target-т pinned room-level pending request болон шинэ check-in/assignment blocker шууд үүснэ. Confirm өөрөө current version, existing stay price book, report/payment snapshot, stock эсвэл selling price-ийг өөрчлөхгүй. Vacant safe-point room-д Cleaner reconciliation task шууд; active stay эсвэл checkout/payment/minibar report/refill unfinished бол эдгээр нь бүгд terminal болсны дараа task үүснэ. Cleaner reconciliation болон P0-37B validation амжилттай дуусахад exact target current version болж атомикаар applied болно; зөвхөн үүний **дараах check-in** шинэ exact version-оор өөрийн price book үүсгэнэ. Дараа Default солигдох эсвэл өөр version Publish болох нь pinned target-ийг өөрчлөхгүй бөгөөд pending target Archive blocker байна (`RML-DEC-022`–`RML-DEC-024`).

Multi-room `Preview` нь room бүрийг `READY_NOW`, `SCHEDULE_AFTER_STAY`, `INELIGIBLE + reason` гэж read-only ангилна; pending request/blocker/task/stock/current version/stay price book/report/payment/financial өөрчлөлт үүсгэхгүй. Confirm room бүрийг дахин шалгаж partial success хэрэглэнэ: accepted room бүр exact target-т pinned child request + immediate blocker, invalid room `SKIPPED` + reason/no blocker авна. Нэг child failure бусад child эсвэл тэдний price isolation-д нөлөөлөхгүй.

Child бүр existing room Rollout урсгалаар independently хэрэгжиж, шинэ exact version нь зөвхөн тухайн child `APPLIED` болсны **дараах check-in**-ийн шинэ price book-д орно. Batch parent-ийн `IN_PROGRESS`, `COMPLETED`, `PARTIALLY_COMPLETED`, `CANCELLED`, `FAILED_VALIDATION` төлөв нь child-үүдээс derivation хийнэ; parent өөрөө ямар ч price/charge/ledger side effectгүй.

`Cancel remaining` нь movement эхлээгүй child-ийг cancel/unblock хийх боловч existing/historical price book-д хүрэхгүй. Movement эхэлсэн child existing compensating rollback-аар terminal болтол blocked; `APPLIED` child price snapshot хэвээр бөгөөд өмнөх exact version рүү буцаах бол шинэ Rollout үүсгэнэ. Retry хуучин price/book/batch history-г edit хийхгүй, `retry_of_batch_id`-тай шинэ batch үүсгэн дахин шалгана. Exact target pinned; Default/Publish retarget хийхгүй. Preview alone Archive blocker биш, confirmed nonterminal child/batch blocker; accepted child-гүй `FAILED_VALIDATION` blocker биш. Duplicate Confirm idempotent, one-pending/concurrency болон cross-hotel scope server-side байна (`RML-DEC-025`–`RML-DEC-028`).

## 8. Report version, payment lock болон correction

### 8.1 Төлбөрөөс өмнө

- Reception report-ийг Cleaner-д залруулгад буцаахад шинэ immutable report version үүснэ.
- Manager/Manager Plus Cleaner-ийн оронд онцгой report version үүсгэсэн ч ижил stay price book ашиглана.
- Payment attempt эхлэхэд report version болон түүний product/quantity/unit price/line amount хамт түгжигдэнэ.
- Retry эсвэл шинэ report version current product price руу шилжихгүй.

### 8.2 Төлбөрийн дараа

- Илүү quantity тооцсон бол original snapshot unit price-аар reversal/refund хийнэ.
- Дутуу quantity тооцсон бол original snapshot unit price-аар шинэ receivable/payment request үүсгэнэ.
- Буруу product тооцсон бол original line-ийг reversal хийнэ. Зөв product нь тухайн stay price book-д байсан үед л түүний snapshot price-аар шинэ line үүсгэнэ.
- Original report, invoice, payment болон snapshot price-ийг edit/delete хийхгүй.

Correction бүр original report/payment, product, original unit price, quantity difference, amount, reason, actor болон effective time-тэй холбоотой байна.

## 9. Эрх ба харагдац

| Үйлдэл | Hotel Admin | Manager | Manager Plus | Reception | Cleaner |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current product selling price удирдах | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — |
| Template version Publish/Set default | Тухайн багцад зөвшөөрөгдсөн нэмэлт role | ✓ 25/30 | ✓ 30 | — | — |
| Eligible Published template version Archive | Тухайн багцад зөвшөөрөгдсөн нэмэлт role | ✓ 25/30 | ✓ 30 | — | — |
| Eligible room-ийг exact Published version рүү Rollout хийх | Тухайн багцад зөвшөөрөгдсөн нэмэлт role | ✓ 25/30 | ✓ 30 | — | — |
| Multi-room Rollout Preview/Confirm/Cancel remaining/Retry | Тухайн багцад зөвшөөрөгдсөн нэмэлт role | ✓ 25/30 | ✓ 30 | — | — |
| Multi-room batch/child төлөв ба blocker харах | ✓ | ✓ 25/30 | ✓ 30 | Read-only 25/30 | Зөвхөн assigned child task |
| Stay price book/report-ийн locked price харах | Financial/report хүрээнд | ✓ 25/30 | ✓ 30 | ✓ 25/30 | — |
| Active-stay refill request үүсгэх/цуцлах | Нэмэлт Reception/Manager role | ✓ 25/30 | ✓ 30 | ✓ 25/30 | — |
| Active-stay refill task гүйцэтгэх/боломжгүй болгох | Нэмэлт Cleaner role | Нэмэлт Cleaner role | Нэмэлт Cleaner role | — | ✓ |
| Active-stay non-guest stock-out бүртгэх | Нэмэлт Manager/Manager Plus role | ✓ 25/30 | ✓ 30 | — | — |
| Report quantity илгээх | Нэмэлт Manager/Manager Plus role | Онцгой report | Онцгой report | — | ✓ |
| Unit price override хийх | — | — | — | — | — |
| Full financial Excel-д snapshot price харах | ✓ | — | — | — | — |

Hotel Admin-д operational Manager action автоматаар үүсэхгүй. Current price өөрчлөх эсвэл Publish/Set default/Archive/Rollout, multi-room Preview/Confirm/Cancel remaining/Retry хийх бол багцад зөвшөөрөгдсөн role тусад нь авна. Version action-ийг хүчинтэй entitlement-тэй үед 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus хийнэ; 20,000₮/entitlement-гүй hotel болон 25,000₮ багцын Manager Plus role-оор gate тойрохгүй. Cleaner зөвхөн assigned child task-ийг гүйцэтгэж, Reception batch/child төлөв болон blocker-ийг read-only харна.

## 10. Аудит ба хамгаалалт

- Price lookup бүр `hotel_id + stay_id + product_id` scope-той байна.
- Client-supplied price болон line amount-ийг authoritative гэж үзэхгүй; сервер дахин бодно.
- Price book болон report/payment line retry нь idempotency хамгаалалттай байна.
- Price book, report line, invoice line болон correction line-ийг hard edit/delete хийхгүй.
- Template/product/current price өөрчлөгдсөн ч active/historical stay current catalog руу join хийж reprice хийхгүй.
- Audit нь snapshot actor/server time, source price/version, report version, payment attempt болон correction холбоосыг хадгална.
- Initial confirmation backdate ашигласан бол audit-д Reception actor/role, mandatory reason, `actual_check_in_at`, server `check_in_recorded_at`, current shift validation болон тухайн recorded-at authoritative price/config/opening snapshot холбоос орно.
- Active-stay actual-time request/amendment нь original/requested/effective actual time, requester, Manager decision, reason, boundary anchors, status/time болон `self-approved` flag-тай; price book/config/opening/report/payment snapshot өөрчлөгдөөгүй холбоосыг хадгална.
- Version Archive хийсэн ч historical price book/report/invoice/audit холбоос, exact version ID болон snapshot price хэвээр үлдэнэ; current catalog-аар reprice хийхгүй.
- Rollout confirm, safe-point scheduling, Cleaner reconciliation болон atomic apply тус бүр current/pinned target exact version болон actor/server time-тай аудиттай байна. Confirm/apply нь existing stay price book-ийг шинэчилсэн мэт бүртгэгдэхгүй.
- Multi-room audit нь batch/child ID, exact target, eligibility/reason/result, `retry_of_batch_id`, Confirm/Cancel/Retry actor-role-package/server time болон idempotency key-г хадгална. Batch parent/Preview/Confirm-ийг price book, charge, payment эсвэл financial movement мэт бүртгэхгүй.
- Selling price snapshot болон weighted average cost snapshot-ийг нэг талбарт холихгүй.
- Room-rate snapshot болон minibar selling-price book тусдаа source/configuration version, lifecycle болон audit холбоостой байна; нэгийг current тохиргоогоор reprice хийх нь нөгөөд нөлөөлөхгүй.

## 11. MVP acceptance criteria

- Minibar-enabled check-in амжилттай болохоос өмнө room-ийн exact current version `PUBLISHED`, parent template entity болон бүх version product `ACTIVE` байж, exact version-ийн бүх product price book-д орсон байна.
- Initial confirmation-ийн зөвшөөрсөн backdate үед minibar price book/config/opening stock snapshot нь historical `actual_check_in_at` бус server `check_in_recorded_at` дахь current authoritative state ашиглана; prior catalog/stock/price сэргээхгүй.
- Opening actual quantity `0` product ч price book-д байна.
- Manager price өөрчилсний дараа active stay-ийн minibar charge өөрчлөгдөхгүй.
- Active stay үед үүссэн pending room configuration change locked stay price book/template/opening/report snapshot-ийг өөрчлөхгүй.
- `DRAFT`/`ARCHIVED` version room current, pending target эсвэл check-in source болж чадахгүй; Published version-ийн product/target in-place edit нь existing snapshot-д нөлөөлөх зам болохгүй.
- Publish нь `ACTIVE` parent template, дор хаяж нэг ижил hotel-ийн `ACTIVE` product, давхардалгүй product болон эерэг бүхэл target quantity шаардана; анхны Published version автоматаар цорын ганц Default болж, дараагийн Publish Default-ийг өөрчлөхгүй.
- Шинэ product/version publish хийх эсвэл Default солих нь existing room current/pending/stay pointer-ийг шууд өөрчлөхгүй.
- Publish/Set default нь existing booking pointer/price book, stock, Cleaner task, configuration request болон check-in blocker үүсгэх эсвэл өөрчлөхгүй; хүчинтэй entitlement-тэй үед 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus хийнэ, Hotel Admin-д тохирох operational role тусдаа шаардлагатай.
- Archive зөвхөн Default биш Published version дээр зөвшөөрөгдөж, room current/pending, active stay эсвэл nonterminal reconciliation/Cleaner/configuration task reference байвал хориглогдоно.
- Historical stay/report/price book/invoice/export/inventory/audit reference Archive-ийг хориглохгүй бөгөөд snapshot price/exact version холбоос устахгүй; future booking version pin хийдэггүй тул blocker болохгүй.
- Archive ямар ч pointer/price snapshot/stock-ийг өөрчлөхгүй, task/configuration request/Rollout/check-in blocker үүсгэхгүй; Archived version terminal бөгөөд reuse хийх бол шинэ Draft clone үүсгэнэ.
- Archive permission нь хүчинтэй entitlement-тэй 25,000₮-ийн Manager, 30,000₮-ийн Manager/Manager Plus-д байна; Hotel Admin-д тохирох role тусдаа шаардлагатай, package gate тойрохгүй.
- Rollout target нь room-ийн current version-тэй ижил hotel, ижил `ACTIVE` template-ийн өөр exact `PUBLISHED` version бөгөөд target product бүр `ACTIVE`; room нь `ACTIVE`, minibar `ON`, өөр nonterminal pending configuration-гүй байна. Mode/template switch Rollout биш.
- Active stay-тай room Rollout-д сонгогдож болох ч `SCHEDULED_AFTER_STAY` байна. Confirm exact target-т pinned pending request болон check-in/assignment blocker шууд үүсгэх боловч current version, stock, existing stay price book/report/payment snapshot болон үнэ өөрчлөхгүй.
- Vacant safe-point room-д Cleaner task шууд, active stay эсвэл checkout/payment/minibar report/refill unfinished бол бүгд terminal болсны дараа үүснэ. Cleaner reconciliation ба P0-37B validation амжилттай дууссаны дараах check-in л шинэ current exact version-оор price book үүсгэнэ.
- Дараагийн Default/Publish pinned Rollout target-ийг өөрчлөхгүй; pending target Archive blocker байна. Rollout permission нь 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus бөгөөд Hotel Admin-д тохирох role тусдаа шаардлагатай.
- Multi-room Preview нэг hotel/template/exact Published target-ийн room бүрийг side effectгүй `READY_NOW`, `SCHEDULE_AFTER_STAY`, `INELIGIBLE + reason` гэж ангилж, Confirm authoritative state дээр дахин шалгана.
- Confirm partial success хэрэглэж accepted room бүрт exact target-т pinned атомик child request + immediate blocker үүсгэнэ; invalid room `SKIPPED` + reason/no blocker, нэг child failure бусдыг rollback/stop хийхгүй.
- Batch parent grouping/progress-only бөгөөд stay price book, report/payment snapshot, guest charge, inventory эсвэл financial ledger өөрчлөхгүй; batch state child-үүдээс derivation хийнэ.
- `Cancel remaining`/compensating rollback/retry нь historical price snapshot-ийг edit/reprice хийхгүй; applied child-ийг буцаах бол өмнөх exact version рүү шинэ Rollout, retry бол `retry_of_batch_id`-тай шинэ batch ашиглана.
- Preview target Archive-ийг блоклохгүй; confirmed nonterminal child/batch блоклоно, accepted child-гүй `FAILED_VALIDATION` блоклохгүй. Duplicate Confirm idempotent, per-room one-pending/concurrency болон cross-hotel scope deny байна.
- Batch Preview/Confirm/Cancel remaining/Retry-г 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus хийнэ; Hotel Admin-д тохирох role тусдаа, 20,000₮/unentitled болон 25,000₮-ийн Manager Plus deny байна. Cleaner assigned child task, Reception read-only байна.
- Шинэ exact version нь room configuration change/rollout амжилттай applied болсны дараах check-in-ээс л тухайн room-ийн price book-д орно.
- Future booking template/version pin хийхгүй; check-in үеийн exact room current version-ийг ашиглана.
- Шинэ үнэ зөвхөн дараагийн check-in-ээс үйлчилнэ.
- Nonterminal room configuration change байхад тухайн physical room-д check-in болон шинэ assignment батлагдахгүй.
- Configuration change амжилттай applied болсны дараах check-in л шинэ current configuration-оор өөрийн price book үүсгэнэ.
- Cleaner/Reception/client unit price илгээж эсвэл override хийж чадахгүй.
- Cleaner report болон Manager/Manager Plus exception report ижил stay price book ашиглана.
- Төлбөрөөс өмнөх бүх report version ижил snapshot price ашиглана.
- Payment attempt report version болон price line-ийг хамт түгжинэ.
- Төлбөрийн дараах quantity correction original snapshot price ашиглана.
- Active-stay documented refill нь check-in price ашиглаж, weighted average cost зөвхөн COGS-д нөлөөлнө.
- Active-stay refill зөвхөн stay/room/price-book line-тэй Cleaner task-аар warehouse → room movement үүсгэнэ.
- Pending refill task дуусах/цуцлагдахаас өмнө check-out эхлэхгүй; check-out эхэлсний дараа шинэ active-stay refill үүсэхгүй.
- Шинэ refill request зөвхөн active product-оор үүснэ; pre-deactivation task retiring үед terminal болж болох ч inactive product дээр completion хийхгүй.
- Warehouse return, room waste болон negative adjustment нь stay-д холбогдож billable availability-гаас хасагдана; generic positive adjustment billable quantity нэмэхгүй.
- Price book-д байгаагүй product тухайн stay-д автоматаар charge болохгүй.
- Snapshot missing/corrupt үед current price fallback хийхгүй.
- Historical report/invoice/Excel current product price өөрчлөгдсөн ч хэвээр байна.
- Room tariff edit, Online room assignment эсвэл check-in нь paid/confirmed booking-ийн room-rate snapshot-ийг өөрчлөхгүй бөгөөд minibar price book-тэй нийлүүлж overwrite хийхгүй.
- Backdate өөрөө price/stock/payment/financial movement эсвэл approval үүсгэхгүй; stay active болсны дараа Reception `actual_check_in_at`-ийг direct edit хийхгүй.
- Active-stay actual-time amendment pending үед checkout эхлэхгүй; approval original price book/config/opening stock/report/payment snapshot-ийг overwrite/reprice/reconstruct хийхгүй.
- Checkout эхэлсэн/дууссан stay-д actual-time request/approval хийхгүй.
- Confirmed booking/active stay-ийн planned checkout change MVP-д байхгүй; STAY-DEC-011 amendment invariant зөвхөн post-MVP-д үйлчилнэ.
- Minimal guard өөрөө price/config/opening/stock/report/payment snapshot, charge, repricing/refund/payment, action эсвэл permission үүсгэхгүй.
- Early/late actual checkout original planned end-д хүрэхгүй; early auto reprice/refund, overdue auto fee/penalty/charge үүсгэхгүй.
- Room actual checkout хүртэл occupied; C2 нь price book/config/opening/stock/report/payment snapshot, task/movement/event-д side effectгүй.

## 12. Батлагдсан шийдвэр

### PRICE-DEC-001 — Check-in price book

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Minibar-enabled check-in батлагдах үед room-ийн exact current `PUBLISHED` template version-ийн бүх product, opening quantity `0` мөрийг оролцуулан, exact template/version холбоос болон selling price-ийг stay price book болгон атомикаар snapshot хийнэ. Booking үед version pin хийхгүй.

### PRICE-DEC-002 — Active stay isolation

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Manager-ийн дараагийн price edit active/historical stay-г reprice хийхгүй. Шинэ үнэ зөвхөн дараагийн амжилттай check-in-ээс үйлчилнэ.

### PRICE-DEC-003 — Normal ба exception report

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Cleaner-ийн үндсэн report болон Manager/Manager Plus-ийн онцгой report-ын unit price-ийг сервер тухайн stay price book-оос авна; аль ч role гараар price override хийхгүй.

### PRICE-DEC-004 — Report version ба correction

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Төлбөрөөс өмнөх report version, payment lock, төлбөрийн дараах reversal/refund/new receivable бүгд original stay snapshot price ашиглана; current price fallback хийхгүй.

### PRICE-DEC-005 — Opening zero ба refill

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Template-д байсан opening quantity `0` product-ийн price snapshot хадгалагдана. Stay үеийн refill нь Reception/Manager/Manager Plus-ийн хүсэлт, Cleaner-ийн бодит баталгаа, stay/room/price-book line холбоостой warehouse → room movement байна. Refill-д check-in selling price ашиглаж, purchase batch/weighted average cost зөвхөн COGS-д нөлөөлнө. Stay-д холбосон non-guest stock-out-ийг хэрэглээнээс хасаж, generic positive adjustment-аар billable quantity нэмэхгүй.

### PRICE-DEC-006 — Snapshot-д байгаагүй product

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Check-in price book-д байгаагүй product active stay-д автоматаар charge болохгүй. Шинэ product/template version Publish болсон, Default солигдсон эсвэл blocker-гүй eligible version Archive болсон төдийд existing room, pending target, stay/booking pointer, stock, Cleaner task, configuration request, Rollout, check-in blocker болон price book өөрчлөгдөхгүй. Active stay reference Archive-ийг хориглох боловч historical stay/report/price book/invoice/export/inventory/audit reference blocker болохгүй, exact version болон price snapshot-ийг хэвээр хадгална. Explicit Rollout нь eligible room-д ижил hotel/template-ийн exact Published target-т pinned pending request ба check-in/assignment blocker үүсгэнэ; active stay/unfinished checkout-payment-report-refill үед `SCHEDULED_AFTER_STAY`, safe point-д Cleaner reconciliation task болно. Confirm existing stay price book/current version/stock/үнэ өөрчлөхгүй; P0-37B validation-тай reconciliation амжилттай applied болсны дараах check-in л шинэ exact version-ийг snapshot хийнэ. Дараагийн Default/Publish pinned target-ийг солихгүй, pending target Archive blocker байна (`RML-DEC-022`–`RML-DEC-024`).

- **P0-37C-3 нэмэлт:** Multi-room Preview/Confirm/batch parent ямар ч stay price book, report/payment snapshot, guest charge эсвэл financial ledger-ийг өөрчлөхгүй. Partial-success child бүр independently applied болсны дараах check-in л шинэ exact version/price book авна. Cancel remaining, compensating rollback, applied child-ийн шинэ reverse Rollout болон linked Retry нь historical snapshot-ийг edit/reprice хийхгүй; target pin, Archive blocker, idempotency/concurrency болон exact package-role gate-ийг `RML-DEC-025`–`RML-DEC-028`-аар мөрдөнө.

### PRICE-DEC-007 — Server authoritative price

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Client/Cleaner/Reception/Manager unit price override хийхгүй. Сервер stay-scoped price book-оос line amount бодож, snapshot байхгүй/эвдэрсэн үед current catalog fallback хийхгүй.

### PRICE-DEC-008 — Selling price ба cost тусдаа

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Selling price нь check-in snapshot, COGS unit cost нь consumption movement үеийн weighted average snapshot байна. Хоёрыг тусдаа хадгалж тайлагнана.

## 13. Дараагийн баталгаажуулах асуудал

P0-36–P0-39 хаагдсан. Minibar lifecycle/price isolation хэвээр бөгөөд stay timestamp/conflict/fractional-hour canonical шийдвэрийг [05-room-stay-and-time-status.md](./05-room-stay-and-time-status.md)-ийн `STAY-DEC-008`–`014`-өөр баталсан. Эдгээр transition өмнөх minibar price/config/stock/snapshot-д side effectгүй.
