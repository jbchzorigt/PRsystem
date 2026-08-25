# Minibar stock ба inventory lifecycle

**Хувилбар:** 0.22  
**Төлөв:** MVP inventory, P0-37 Room–Minibar lifecycle, P0-38 stay pricing/config болон P0-39A–P0-39C-2 батлагдсан  
**Хамаарах үе шат:** MVP — Manager / Cleaner / Reception / Reporting

## 1. Хамрах хүрээ

Энэ дүрэм нь minibar боломжтой **25,000₮** болон **30,000₮** багцад үйлчилнэ. **20,000₮** багцад minibar product, stock, template, usage/refill болон inventory API ашиглах боломжгүй байна.

Энэ баримт бичиг дараах асуудлыг canonical байдлаар тодорхойлно:

- Manager-ийн оруулах тоо яг ямар нөөц болох;
- агуулах болон өрөөний minibar-ын үлдэгдэл;
- худалдах үнэ, худалдан авалтын өртөг болон жигнэсэн дундаж өртөг;
- stock receipt, transfer, consumption, waste болон adjustment;
- сөрөг үлдэгдлийн хориг;
- нөөц хүрэлцэхгүй үеийн Manager-ийн хяналттай check-in exception;
- өрөө бүр minibar-тай байх эсэх болон template-ийн шаардлага;
- нэг room-ийн ON/OFF/template change-д хийх return/refill/rollback reconciliation;
- template entity ба version-ийн тусдаа lifecycle, room current/pending configuration-ийн exact version binding;
- template version Publish validation, Default сонголт болон тэдгээрийн side-effectгүй ажиллагаа;
- eligible Published version-ийн Archive blocker, history retention болон inventory isolation;
- exact Published version рүү хийх нэг-room Rollout-ийн eligibility, safe-point scheduling, blocker болон stock isolation;
- multi-room Rollout-ийн read-only Preview, partial-success child request, batch cancel/rollback/retry болон inventory isolation.

## 2. Нөөцийн хоёр байршил

Бүтээгдэхүүний нөөцийг нэг нийлбэр тоогоор удирдахгүй. Hotel бүрд дараах хоёр түвшний байршил байна:

1. **Агуулахын нөөц** — өрөөнд нөхөхөөс өмнөх, Manager-ийн хариуцах үндсэн үлдэгдэл.
2. **Өрөөний minibar-ын нөөц** — тухайн өрөөнд бодитоор байгаа бүтээгдэхүүний тоо.

```text
Hotel-ийн нийт бодит нөөц
= Агуулахын үлдэгдэл
+ Бүх өрөөний minibar-ын үлдэгдлийн нийлбэр
```

Агуулахаас өрөө рүү шилжүүлэх нь hotel-ийн нийт бодит нөөцийг өөрчлөхгүй; зөвхөн байршлыг өөрчилнө.

Жишээ:

```text
Агуулахад ус: 100
Өрөө 201: 2
Өрөө 202: 2
Hotel-ийн нийт бодит ус: 104

Өрөө 203-д 2 ус нөхөхөд:
Агуулах: 100 → 98
Өрөө 203: 0 → 2
Нийт: 104 хэвээр
```

## 3. Бүтээгдэхүүн ба анхны нөөц

Manager/Manager Plus бүтээгдэхүүн бүрд:

- бүтээгдэхүүний нэр;
- бүтээгдэхүүний ангилал;
- хэмжих нэгж;
- худалдах нэгж үнэ;
- худалдан авалтын нэгж өртөг;
- агуулахын анхны тоо;
- үүсгэх үеийн төлөв: `Идэвхтэй` эсвэл `Идэвхгүй`; `Идэвхгүй болгохоор хүлээгдэж буй` нь system-managed lifecycle төлөв

бүртгэнэ.

Manager-ийн оруулсан `тоо` нь зөвхөн **агуулахын нөөц** байна. Өрөөнүүдэд байгаа тоог үүнд оруулахгүй.

Бүтээгдэхүүн үүсгэхэд агуулахын анхны тоог `Анхны үлдэгдэл` хөдөлгөөн болгон нэг удаа бүртгэнэ. Үүнээс хойш үлдэгдлийг нэг талбар дээр дарж солихгүй; stock movement-ээр өөрчилнө.

Худалдах үнэ болон худалдан авалтын өртөг нь тусдаа талбар байна. Худалдан авалтын өртөг заавал, 0-ээс багагүй байна. Selling price-ийг minibar-enabled check-in үед stay price book болгон, cost-ийг consumption movement үед weighted average snapshot болгон тусад нь хадгална. Selling price-ийн canonical дүрэм: [25-minibar-selling-price-snapshot.md](./25-minibar-selling-price-snapshot.md).

Product `RETIRING` болмогц шинэ template, refill болон check-in configuration-д ашиглахгүй. Өмнөх active/historical stay-ийн price book/report/correction хэвээр байна. Room stock болон pending dependency шийдэгдтэл product inactive болохгүй; warehouse stock нь inactive болсон ч inventory/report-д хадгалагдана. Canonical lifecycle: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md).

## 4. Inventory хөдөлгөөний төрөл

| Хөдөлгөөн | Агуулах | Өрөө | Hotel-ийн нийт нөөц |
| --- | ---: | ---: | ---: |
| `Анхны үлдэгдэл` | Нэмэгдэнэ | — | Нэмэгдэнэ |
| `Худалдан авалт/орлого` | Нэмэгдэнэ | — | Нэмэгдэнэ |
| `Өрөө рүү шилжүүлсэн` | Хасагдана | Нэмэгдэнэ | Өөрчлөгдөхгүй |
| `Агуулахад буцаасан` | Нэмэгдэнэ | Хасагдана | Өөрчлөгдөхгүй |
| `Зочны хэрэглээ` | — | Хасагдана | Хасагдана |
| `Waste` — эвдэрсэн, асгарсан, хугацаа дууссан | Warehouse сонгосон бол хасагдана | Room сонгосон бол хасагдана | Хасагдана |
| `Тооллогын нэмэх залруулга` | Warehouse сонгосон бол нэмэгдэнэ | Room сонгосон бол нэмэгдэнэ | Нэмэгдэнэ |
| `Тооллогын хасах залруулга` | Warehouse сонгосон бол хасагдана | Room сонгосон бол хасагдана | Хасагдана |

- Waste болон adjustment бүрд шалтгаан заавал байна.
- Нотлох зураг/файл болон хоёр дахь хэрэглэгчийн approval шаардахгүй.
- Өмнөх хөдөлгөөнийг edit/delete хийхгүй; буруу хөдөлгөөнийг холбоостой reversal болон шинэ зөв хөдөлгөөнөөр залруулна.
- Нэг transfer нь агуулахын хасалт, өрөөний нэмэлтийг нэг атомик ажиллагаагаар үүсгэнэ. Нэг тал нь амжилтгүй бол нөгөө тал дангаараа хадгалагдахгүй.
- Configuration reconciliation-ийн `Өрөө рүү шилжүүлсэн`, `Агуулахад буцаасан` болон rollback transfer бүр `configuration_change_id + task_id + original_movement_id` шаардлагатай бол original холбоостой байна; guest consumption/sale/revenue/charge үүсгэхгүй.
- Active stay-тэй room-ийн refill, warehouse return, room waste болон room adjustment бүр `stay_id`-тай байна. Guest charge-д refill-ийг нэмэх, non-guest stock-out-ийг хасах бөгөөд generic positive adjustment billable quantity-г нэмэхгүй.

## 5. Жигнэсэн дундаж өртөг

MVP-д бүтээгдэхүүний өртгийг hotel-ийн хэмжээнд **тасралтгүй жигнэсэн дундаж өртгөөр** хөтөлнө.

```text
Шинэ дундаж өртөг
= (Өмнөх нийт үлдэгдэл × Өмнөх дундаж өртөг
   + Шинээр орсон тоо × Шинэ нэгж өртөг)
  / (Өмнөх нийт үлдэгдэл + Шинээр орсон тоо)
```

- Анхны үлдэгдэл болон худалдан авалт дундаж өртгийг шинэчилнэ.
- Өмнөх нийт үлдэгдэл 0 бол шинэ дундаж өртөг нь шинэ stock receipt-ийн нэгж өртөгтэй тэнцүү байна.
- Тооллогын нэмэх adjustment одоогийн дундаж өртгийг ашиглана. Өмнөх нийт үлдэгдэл 0, өртөг тогтоогдоогүй бол Manager нэгж өртөг заавал оруулна.
- Тооллогын хасах adjustment болон waste тухайн movement-ийн үеийн дундаж өртгийг ашиглана.
- Агуулах–өрөөний transfer дундаж өртгийг өөрчлөхгүй.
- Зочны хэрэглээ, waste болон stock-out хөдөлгөөнд тухайн хөдөлгөөний үеийн дундаж өртгийг snapshot болгон хадгална.
- Өмнөх борлуулалт, waste болон тайлангийн cost snapshot шинэ худалдан авалтаас болж буцаад өөрчлөгдөхгүй.
- Minibar-ын орлого, weighted average COGS, gross profit болон gross margin-ийн тайлангийн томьёог [23-admin-financial-reporting.md](./23-admin-financial-reporting.md)-д FIN-DEC-001–010-аар баталсан.

Жишээ:

```text
10 ус × 1,000₮ = 10,000₮
10 ус × 1,200₮ = 12,000₮

Шинэ дундаж өртөг = 22,000₮ / 20 = 1,100₮
Худалдах үнэ 3,000₮ бол нэг усны урьдчилсан gross profit = 1,900₮
```

## 6. Cleaner-ийн хэрэглээ ба нөхөн дүүргэлт

### 6.1 Зочны хэрэглээ

- Cleaner minibar-enabled өрөөний бодит үлдэгдлийг шалгаж хэрэглэсэн тоог тайлагнана.
- Хүчинтэй physical report нь өрөөний нөөцөөс `Зочны хэрэглээ` хөдөлгөөн үүсгэнэ.
- Report залруулбал хуучин stock movement-ийг дарж засахгүй; зөрүүгээр холбоостой нэмэх/хасах хөдөлгөөн үүсгэнэ.
- Зочны төлбөрөөс чөлөөлсөн маргаан нь бүтээгдэхүүн бодитоор алга болсон бол inventory consumption-ийг автоматаар буцаахгүй. Санхүүгийн adjustment болон физик нөөц тусдаа байна.

### 6.2 Нөхөн дүүргэлт

- Pending configuration change байхгүй үед Cleaner өрөөг цэвэрлэхдээ дараагийн stay-д зориулсан room-ийн exact current `PUBLISHED` version-ийн immutable product/target quantity-аар ердийн нөхөлтийг хийнэ.
- Зөвхөн уг exact current version-д байгаа lifecycle `ACTIVE` product-ийг warehouse → room refill-д сонгоно. `RETIRING/INACTIVE` product-ийг шинэ stay-д зориулж нөхөхгүй. Харин removed/excess product-ийг P0-37B-ын assigned reconciliation task-аар room → warehouse буцааж болно.
- Систем агуулахын боломжит үлдэгдлийг сервер талд шалгана.
- Хангалттай бол агуулахаас өрөө рүү нэг холбоостой transfer үүсгэнэ.
- Хүрэлцэхгүй бол байгаа хэмжээнээс илүүг шилжүүлэхгүй, нөөцийг сөрөг болгохгүй, үлдсэн дутуу тоог Manager-д харуулна.
- Бодит тоо exact current version-ийн зорилтот хэмжээнд хүрвэл minibar `Бүтэн`, хүрээгүй бол `Дутуу` байна.
- Non-terminal pending change байгаа бол хуучин exact current version-оор routine refill хийхгүй; safe point-ийн дараа request-д pinned болсон exact target `PUBLISHED` version-ийн reconciliation task ашиглана.

### 6.3 Active stay үеийн нөхөлт

1. Reception эсвэл Manager/Manager Plus идэвхтэй stay дээр lifecycle `ACTIVE` product-оор `Minibar нөхөх хүсэлт` үүсгэнэ. Room нь тухайн active stay-г дуусгаж буй `ACTIVE` эсвэл `RETIRING` төлөвтэй байж болно; `INACTIVE` room-д хүсэлт үүсгэхгүй.
2. Cleaner өөрт оноогдсон task-аар бодитоор нөхсөн quantity-г батална. Request нь өөрөө stock movement биш.
3. Сервер stay/room, check-in үед түгжсэн exact template version, minibar mode, price-book product, product lifecycle болон warehouse stock-ийг шалгаж, warehouse → room transfer-ийг атомикаар үүсгэнэ.
4. Movement нь `stay_id + room_id + product_id + price_book_line_id + task_id`, requester, Cleaner, actual quantity болон server time-тэй байна.
5. Price book-д байхгүй product, шинэ request үед `RETIRING/INACTIVE` product, `INACTIVE`/өөр room-ийн stay, сөрөг/0 quantity болон warehouse-аас их quantity-г хориглоно.
6. `Check-out эхлүүлэх`-ээс өмнө pending refill task complete/cancel болно; check-out эхэлсний дараа active-stay refill шинээр үүсгэхгүй.

Active stay үед room-оос warehouse-д буцаах, waste болон negative adjustment хийх бол Manager/Manager Plus шалтгаантай, stay-scoped non-guest movement үүсгэнэ. Эдгээрийг зочны хэрэглээ гэж тооцохгүй. Generic positive adjustment billable availability нэмэхгүй; зочинд борлуулах нэмэлт бүтээгдэхүүнийг зөвхөн active-stay refill task-аар оруулна.

Product deactivation-оос өмнө үүссэн pending refill task нь product `RETIRING` үед complete/cancel/боломжгүй гэсэн terminal төлөвт орж болно. Completion үед original task-ийн `created_at < deactivation_requested_at` холбоосыг шалгаж, өөр product/task-аар сольж болохгүй. Pending task шийдэгдтэл product `INACTIVE` болохгүй; inactive product дээр completion хийхгүй.

### 6.4 Room configuration reconciliation

Room яг нэг current configuration, хамгийн ихдээ нэг non-terminal pending change-тай байна. Minibar ашигладаг current configuration нь exact `current_template_id + current_version_id`, pending target нь exact `pending_target_template_id + pending_target_version_id` хадгална. Active stay байгаа үед exact current version, opening quantity, price book болон guest charge хэвээр үлдэж, checkout/payment/minibar report/refill task бүр terminal болсны дараа reconciliation эхэлнэ.

| Change | Cleaner task-ийн stock ажиллагаа | Apply нөхцөл |
| --- | --- | --- |
| ON → OFF | Бүх usable stock room → warehouse; unusable/variance-г Manager шийднэ | Room product balance бүр `0`; shortage override хэрэглэхгүй |
| OFF → ON | Pinned exact target version-ийн added/short product warehouse → room | Exact target version `PUBLISHED`, target бүрэн эсвэл бодит snapshot-тэй хүчинтэй shortage override |
| Template/version A → B | Actual count; exact B version-оос removed/excess room → warehouse; added/short warehouse → room | Exact B version `PUBLISHED`, removed/excess/variance шийдэгдсэн + target бүрэн, эсвэл зөвхөн shortage-д бодит snapshot-тэй хүчинтэй override |

Cleaner зөвхөн server-generated, өөрт оноогдсон task-д pinned exact target version, room/product/direction/max quantity-н хүрээнд transfer батална. Cleaner generic warehouse balance, waste/adjustment, target template/version, shortage override эсвэл count variance шийдэхгүй. Reconciliation movement нь stay consumption биш тул minibar revenue/COGS-г sales хэлбэрээр үүсгэхгүй; waste/adjustment бол existing inventory loss дүрмээр тусдаа тайлагнана.

Stock хүрэлцэхгүй бол pending `BLOCKED_STOCK`, шийдээгүй count variance байвал `BLOCKED_VARIANCE` хэвээр. Successful apply-ын өмнө server request-д pinned exact target version `PUBLISHED`, target template entity/product dependency `ACTIVE`, balance/override/concurrency хүчинтэй эсэхийг дахин шалгаж, `current_version_id` switch болон pending completion-ийг атомикаар хийнэ. Configuration apply cleaning status-ийг автоматаар өөрчлөхгүй.

Movement эхлээгүй request-ийг Manager/Manager Plus direct cancel хийж болно. Movement post болсон бол silent cancel хийхгүй: server original delta-аар rollback task үүсгэж, Cleaner usable stock-ийн compensating transfer баталж, Manager variance-г шийднэ. Original movement-ийг edit/delete хийхгүй; baseline сэргэсэн хүртэл room check-in/assignment blocker-тэй байна. Applied config-г буцаах бол шинэ request үүсгэнэ.

## 7. Өрөөний minibar mode ба template

25,000₮/30,000₮ багцын бүх өрөөнд minibar заавал байхгүй. Manager/Manager Plus өрөө бүрд:

- `Minibar ашиглана`; эсвэл
- `Minibar ашиглахгүй`

гэсэн mode сонгоно.

### `Minibar ашиглана`

- Lifecycle `ACTIVE` нэг minibar template entity болон түүний exact `PUBLISHED` version заавал онооно.
- Бүтээгдэхүүний бүрдэл болон зорилтот тоо нь template entity дээр биш, exact immutable version дээр хадгалагдана.
- Check-in үеийн бодит эхний тоо, exact current template version болон уг version-ийн бүх product selling price-ийг stay дээр snapshot болгоно; opening quantity `0` product мөн price book-д орно.
- Cleaner-ийн usage/refill task болон minibar төлбөрийн урсгал үйлчилнэ.

### `Minibar ашиглахгүй`

- Minibar template шаардахгүй.
- Routine guest minibar шалгах/нөхөх task үүсэхгүй. Харин OFF → ON pending change-д target configuration reconciliation task үүсч болно.
- Minibar төлбөрийн мөр үүсэхгүй.
- Өрөөний minibar төлөв `Хамаарахгүй` байна.
- Cleaner-ийн өрөө цэвэрлэх task хэвийн үргэлжилнэ.

Existing room-ийн current mode/template/version-г шууд edit хийхгүй; Manager/Manager Plus exact target `PUBLISHED` version-ийг заасан pending change request үүсгэж reconciliation-аар солино. Өөрчлөлт active stay болон өмнөх snapshot-ийг буцааж өөрчлөхгүй.

`STAY-DEC-009`-ийн зөвшөөрсөн initial `actual_check_in_at` backdate нь inventory/configuration time travel биш. Check-in-ийн exact current version, opening actual quantity, selling-price book болон product lifecycle-ийг immutable `check_in_recorded_at` үеийн authoritative state-аар snapshot хийнэ. Past actual time руу хуучин config/stock сэргээх, opening movement нөхөн үүсгэх эсвэл existing movement-ийн server time-ийг өөрчлөхгүй. Historical readiness validation нь өмнө бодитоор үүссэн immutable cleaning/minibar/stock event-үүдийг ашиглана.

`STAY-DEC-010`-ын approved correction нь зөвхөн effective actual start-ийг өөрчилнө; inventory/configuration snapshot, opening/other stock movement болон event-ийн server time-ийг өөрчлөх, нөхөн үүсгэхгүй. Approval historical readiness-ийг existing immutable event-үүдээр дахин шалгана.

`STAY-DEC-011`-ийн дагуу confirmed booking эсвэл `ACTIVE` stay-ийн `planned_checkout_at` direct overwrite хоригтой. MVP-д change байхгүй; append-only history/revalidation нь зөвхөн post-MVP change хожим тусдаа батлагдвал мөрдөх invariant. Minimal guard inventory/configuration pointer, opening/price snapshot, stock balance/movement/task/event-ийг үүсгэх, өөрчлөх, re-time хийхгүй.

`STAY-DEC-012`-оор confirmed/active planned checkout MVP-д бүрэн түгжээтэй: amendment/action/button/API, extension, planned-end shorten, hourly ↔ nightly conversion байхгүй. Early/late actual checkout нь original planned end-ийг өөрчлөхгүйгээр зөвхөн `actual_checkout_at` бүртгэнэ; early auto reprice/refund, overdue auto fee/penalty үүсэхгүй. Room actual checkout хүртэл occupied/blocking хэвээр бөгөөд дараа нь P0-39A-ийн snapshot buffer + clean + applicable minibar readiness gate үйлчилнэ. Энэ lock inventory/configuration/price/opening snapshot, stock balance/movement, task/event эсвэл lifecycle side effect үүсгэхгүй.

Template entity болон version нь тусдаа lifecycle-тэй:

```text
Template entity: ACTIVE → RETIRING → INACTIVE
Template version: DRAFT → PUBLISHED → ARCHIVED
```

- `DRAFT` version-ийн product list/target quantity-г Manager/Manager Plus засаж болох боловч room current/pending target, Default, check-in эсвэл reconciliation task-д ашиглахгүй.
- `PUBLISHED` version-ийн product list/target quantity immutable; өөрчлөлтийг шинэ Draft болон дараагийн Published version-оор хийнэ.
- `ARCHIVED` version terminal/history-only бөгөөд шинэ configuration-д ашиглахгүй, шууд Published болгохгүй; reuse хийх бол шинэ `DRAFT` version болгон clone хийнэ.
- Нэг template entity дотор олон Published version зэрэг байж болно. Published version байгаа үед шинэ configuration-д анх санал болгох яг нэг Default Published version байна.
- Default солигдсон ч existing room-ийн exact current/pending version, active stay болон future booking автоматаар өөрчлөгдөхгүй.
- Future booking-ийн minibar version booking үед pin болохгүй; check-in амжилттай болох үеийн room-ийн exact current version ашиглагдана.

Зөвхөн `DRAFT` version-ийг `Publish` хийх бөгөөд сервер дараах validation-ийг нэгэн зэрэг шалгана:

- parent template entity `ACTIVE`;
- version-д дор хаяж нэг product байгаа;
- version-ийн бүх product тухайн template-тэй ижил hotel-д хамаарч, lifecycle `ACTIVE` байгаа;
- нэг product version дотор давхардаагүй;
- product бүрийн target quantity эерэг бүхэл тоо байгаа.

Аль нэг validation бүтэлгүй бол хэсэгчилсэн Publish хийхгүй, version `DRAFT` хэвээр үлдэнэ. Template entity-ийн анхны Published version автоматаар түүний цорын ганц Default болно. Дараагийн version Publish болоход одоогийн Default хэвээр үлдэнэ; Manager/Manager Plus зөвхөн тусдаа `Set default` action-аар ижил template-ийн eligible exact Published version-ийг сонгож, яг нэг Default invariant-ийг атомикаар хадгална.

`Publish` болон `Set default` нь existing room-ийн exact `current_version_id`, `pending_target_version_id`, active stay, booking pointer эсвэл price snapshot-ийг өөрчлөхгүй. Мөн stock movement хийхгүй, Cleaner task, configuration request болон check-in blocker үүсгэхгүй. Эдгээр action-ийг зөвхөн тухайн үед хүчинтэй minibar entitlement-тэй hotel-д 25,000₮ багцын Manager, эсвэл 30,000₮ багцын Manager/Manager Plus хийнэ; Hotel Admin-д тохирох operational role тусдаа шаардлагатай. Энэ нь `RML-DEC-018`–`RML-DEC-020`-ийн inventory хэрэгжилт байна.

Зөвхөн Default биш exact `PUBLISHED` version-ийг Archive хийж болно. Default version-ийг Archive хийхийн өмнө өөр eligible Published version-ийг `Set default` хийнэ; өөр eligible version байхгүй бол Archive хийхгүй. Сервер дараах reference-ийн аль нэг байвал transition-ийг хориглоно:

- аль нэг room-ийн `current_version_id` эсвэл `pending_target_version_id`;
- тухайн exact version-ийг ашиглаж буй active stay;
- тухайн exact version-тэй холбоотой nonterminal configuration request, reconciliation/rollback эсвэл Cleaner task.

Historical stay, report, price book, invoice/export, inventory movement болон audit reference нь Archive-ийг хориглохгүй бөгөөд өөрчлөгдөхгүй хадгалагдана. Future booking version pin хийдэггүй тул Archive blocker болохгүй, booking автоматаар өөрчлөгдөхгүй. Archive transition дангаараа room/pending/stay/booking pointer эсвэл price snapshot-ийг өөрчлөхгүй, stock movement хийхгүй, Cleaner task, configuration request, Rollout болон check-in blocker үүсгэхгүй.

Archive action-ийг хүчинтэй entitlement-тэй үед 25,000₮ багцын Manager, 30,000₮ багцын Manager/Manager Plus хийнэ; Hotel Admin-д багцад зөвшөөрөгдсөн operational role тусдаа шаардлагатай. Энэ нь `RML-DEC-021`-ийн inventory хэрэгжилт байна.

### 7.1 Exact Published version рүү хийх Rollout

Explicit Rollout нь room-ийн minibar mode эсвэл template entity-г солих action биш. Нэг room-ийг өөрийнх нь current version-тэй ижил hotel, ижил `ACTIVE` template entity-ийн өөр exact `PUBLISHED` version рүү шилжүүлэхдээ ашиглана. ON/OFF mode болон өөр template рүү шилжих бол P0-37B-ийн existing configuration-change урсгалыг хэрэглэнэ.

Rollout confirm хийхийн өмнө сервер:

- target version тухайн room-тэй ижил hotel болон ижил template entity-д хамаарч, `PUBLISHED` байгаа;
- target template entity болон target version-ийн бүх product `ACTIVE` байгаа;
- room `ACTIVE`, minibar `ON`, ижил template-ийн өөр current version-тэй байгаа;
- room-д өөр nonterminal pending configuration request байхгүй

эсэхийг нэгэн зэрэг шалгана. Active stay-тай room eligible хэвээр боловч шууд reconciliation эхлэхгүй.

Confirm амжилттай болоход тухайн room-д exact `pending_target_version_id`-аар pin хийсэн pending configuration request болон шинэ check-in/assignment blocker шууд үүснэ. Дараа нь Default солигдох эсвэл өөр version Publish болох нь target-ийг автоматаар өөрчлөхгүй; энэ pending exact reference нь target version-ийг Archive хийх blocker байна.

- Room vacant бөгөөд active stay, checkout, payment, minibar report, refill бүгд terminal safe point-д байвал Cleaner reconciliation task шууд үүснэ.
- Active stay эсвэл дээрх safe-point item-ийн аль нэг дуусаагүй бол request `SCHEDULED_AFTER_STAY` байна. Бүгд terminal болсны дараа л Cleaner task үүснэ.
- Confirm дангаараа stock movement хийхгүй, room-ийн `current_version_id`, stay price snapshot эсвэл үнэ өөрчлөхгүй.
- Cleaner exact target-аар actual count/return/refill reconciliation хийж, P0-37B-ийн target state, dependency, stock/variance/override болон concurrency validation амжилттай болоход `current_version_id` switch ба request completion нэг атомик ажиллагаагаар хийгдэнэ.

Rollout action-ийг 25,000₮ багцад зөвхөн Manager, 30,000₮ багцад Manager эсвэл Manager Plus хийнэ. Hotel Admin-д багцад зөвшөөрөгдсөн operational role тусдаа шаардлагатай. 20,000₮/minibar entitlement-гүй hotel болон 25,000₮ багцын Manager Plus role action gate-ийг тойрохгүй. Эдгээр нь `RML-DEC-022`–`RML-DEC-024`-ийн inventory хэрэгжилт.

### 7.2 Multi-room Rollout batch

Нэг batch parent нь зөвхөн нэг `hotel_id`, нэг `template_id`, нэг exact `PUBLISHED target_version_id` болон ижил scope-ийн олон selected room-ийг бүлэглэнэ. Target exact ID-аар pinned байх бөгөөд дараагийн Default солилт эсвэл Publish target-ийг өөрчлөхгүй.

`Preview` нь room бүрийг дахин ашиглагдах eligibility дүрмээр шалгаж:

- `READY_NOW`;
- `SCHEDULE_AFTER_STAY`;
- `INELIGIBLE` + тодорхой reason

гэж харуулна. Preview нь read-only: pending request, blocker, Cleaner task, stock movement, inventory ledger, room/current version, stay/price/financial өөрчлөлт үүсгэхгүй бөгөөд target Archive-ийг блоклохгүй.

`Confirm` room бүрийг authoritative state дээр дахин шалгаж partial success хэрэглэнэ:

- eligible room бүрт P0-37C-2B-2-ын exact target-т pinned child pending request болон immediate check-in/assignment blocker нэг атомик ажиллагаагаар үүснэ;
- invalid room `SKIPPED` + reason болж, pending request/blocker/stock movement авахгүй;
- нэг child-ийн validation/task/reconciliation failure бусад accepted child-ийг зогсоохгүй, автоматаар rollback хийхгүй;
- child бүр `READY_FOR_RECONCILIATION`, `SCHEDULED_AFTER_STAY`, stock/variance blocker, rollback болон applied урсгалаар бие даан явна.

Batch parent нь grouping/progress-only бөгөөд өөрийн inventory ledger, guest consumption, sale, revenue, COGS эсвэл financial side effect үүсгэхгүй. Parent төлөв child-үүдээс derivation хийнэ:

- дор хаяж нэг accepted child non-terminal бол `IN_PROGRESS`;
- сонгосон room бүр accepted болж, accepted child бүр `APPLIED` бол `COMPLETED`;
- дор хаяж нэг room accepted болсон бөгөөд accepted child бүр movement эхлэхээс өмнө `CANCELLED` бол `CANCELLED`;
- нэг ч room accepted болоогүй бол `FAILED_VALIDATION`;
- accepted child бүр terminal боловч дээрх terminal нөхцөлд орохгүй, тухайлбал `SKIPPED`, `CANCELLED`, `ROLLED_BACK` эсвэл бусад non-`APPLIED` outcome холилдсон бол `PARTIALLY_COMPLETED`.

`Cancel remaining` хийхэд movement эхлээгүй child `CANCELLED` болж blocker арилна. Movement эхэлсэн child existing immutable compensating rollback-д орж terminal болтол blocked хэвээр; `APPLIED` child өөрчлөгдөхгүй бөгөөд өмнөх exact version рүү буцаах бол шинэ Rollout үүсгэнэ. Retry хуучин parent/child/movement-ийг edit хийхгүй, `retry_of_batch_id` холбоостой шинэ batch үүсгэж exact target болон room eligibility-г дахин шалгана.

Confirm-оор accepted болсон nonterminal child/batch target version-ийг бүх холбоотой child terminal болтол Archive хийхийг хориглоно. `FAILED_VALIDATION` болон accepted child-гүй batch blocker биш. Duplicate Confirm idempotent; room бүрийн one-nonterminal-pending invariant/concurrency lock үйлчилж, cross-hotel room/version deny болно. Preview/Confirm/Cancel remaining/Retry-г 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus хийнэ; Hotel Admin-д тохирох role тусдаа, 20,000₮/unentitled болон 25,000₮-ийн Manager Plus deny байна. Cleaner зөвхөн assigned child task-аар inventory transfer баталж, Reception batch/child state ба blocker-ийг read-only харна (`RML-DEC-025`–`RML-DEC-028`). Canonical lifecycle: [26-room-minibar-lifecycle.md](./26-room-minibar-lifecycle.md).

## 8. Нөөц хүрэлцэхгүй үеийн controlled override

Ердийн нөхцөлд minibar-enabled өрөө check-in-ээс өмнө `Бүтэн` байна. Нөөц хүрэлцэхгүйгээс `Дутуу` хэвээр бол Manager/Manager Plus **`Дутуу minibar-тайгаар нээх`** онцгой зөвшөөрөл үүсгэж болно.

1. Өрөө `Цэвэр`, өмнөх check-out дууссан байна.
2. Manager/Manager Plus өрөөнд бодитоор байгаа бүтээгдэхүүн бүрийн тоог шалгана.
3. Override-ийн шалтгааныг заавал оруулна.
4. Систем бодит эхний тоо, exact current `PUBLISHED` version-ийн зорилтот тоо, дутуу бүтээгдэхүүн, actor болон цагийг snapshot болгоно.
5. Override нь зөвхөн холбоотой дараагийн stay/check-in-д үйлчилнэ; template entity/version болон агуулахын тоог өөрчлөхгүй.
6. Reception `Дутуу — Manager зөвшөөрсөн` badge болон эхний snapshot-ийг харж check-in үргэлжлүүлнэ. Reception өөрөө override үүсгэхгүй.
7. Opening actual quantity `0` байсан product-ийг stay үеэр баримтжуулан refill хийгээгүй бол зочинд тооцохгүй. Баримтжуулсан refill хийсэн бол тухайн stay-ийн check-in price-аар бодит хэрэглээг тооцож болно. Check-in price book-д байгаагүй product charge болохгүй.

```text
Тооцож болох хэрэглээ
= max(0,
    Stay эхлэх бодит тоо
  + Батлагдсан active-stay refill
  − Stay-д холбосон warehouse return / room waste / negative adjustment
  − Check-out үеийн бодит тоо)
```

Хэрэв stay үеэр баримтжуулсан нэмэлт нөхөлт хийсэн бол уг нэмэгдсэн тоог эхний боломжит тоонд нэмж тооцно. Generic positive adjustment нь billable quantity-г нэмэхгүй. Report version нь ашигласан refill/non-guest movement ID болон cutoff time-ийг snapshot болгоно.

Override нь minibar-ын үндсэн төлөвийг `Бүтэн` болгож хуурч өөрчлөхгүй. Үндсэн төлөв `Дутуу`, тусдаа `Manager зөвшөөрсөн` exception flag-тай байна.

Hotel Admin энэ operational override-ийг автоматаар хийхгүй; Manager эсвэл Manager Plus role тусад нь авсан байна.

## 9. Өрөө бэлэн болох шинэчилсэн дүрэм

Booking/stay occupancy нь `[start_at, end_at)` байна. Actual checkout-оос өмнө planning availability-д `planned checkout + snapshotted cleaning buffer`, actual checkout бүртгэгдсэнээс хойш бодит readiness-д `actual checkout + ижил snapshotted cleaning buffer` ашиглана. Доорх `buffer өнгөрсөн` нөхцөл нь server time уг actual readiness заагт хүрсэн эсвэл өнгөрснийг илэрхийлнэ; cleaning болон minibar readiness-ийг орлохгүй (`STAY-DEC-008`).

Planned checkout өнгөрсөн ч stay `ACTIVE`, actual checkout байхгүй бол room occupied бөгөөд inventory/readiness gate-ээр суллахгүй. Actual checkout бүртгэгдсэний дараа л actual anchor-д шилжинэ (`STAY-DEC-012`).

| Нөхцөл | Check-in зөвшөөрөх эсэх |
| --- | --- |
| Room эсвэл category `RETIRING/INACTIVE` | Хориглоно |
| Minibar-enabled room-ийн current template entity эсвэл exact version-ийн product `RETIRING/INACTIVE` | Configuration blocker — хориглоно |
| Minibar-enabled room-ийн exact `current_version_id` байхгүй эсвэл version нь `PUBLISHED` биш | Configuration blocker — хориглоно |
| Room-ийн minibar configuration change non-terminal | Configuration change blocker — шинэ assignment/check-in хориглоно |
| 20,000₮; check-out дууссан + actual buffer өнгөрсөн + өрөө `Цэвэр` | Зөвшөөрнө |
| 25,000₮/30,000₮; minibar mode `Ашиглахгүй`; check-out дууссан + actual buffer өнгөрсөн + өрөө `Цэвэр` | Зөвшөөрнө |
| 25,000₮/30,000₮; minibar `Бүтэн`; check-out дууссан + actual buffer өнгөрсөн + өрөө `Цэвэр` | Зөвшөөрнө |
| Minibar `Дутуу`, хүчинтэй Manager override байхгүй | Хориглоно |
| Minibar `Дутуу`, дараагийн stay-д хүчинтэй Manager override + эхний snapshot байгаа | Зөвшөөрнө |
| Minibar `Тодорхойгүй` | Хориглоно |

Энэ нь өмнөх `minibar Бүтэн` үндсэн дүрмийг хүчингүй болгохгүй; minibar ашиглахгүй өрөө болон Manager-ийн аудиттай shortage exception-ийг тодруулж байна.

## 10. Эрхийн хуваарилалт

| Үйлдэл | Reception | Cleaner | Manager | Manager Plus | Hotel Admin |
| --- | ---: | ---: | ---: | ---: | ---: |
| Product/category/худалдах үнэ удирдах | — | — | ✓ 25/30 | ✓ 30 | Нэмэлт Manager/Manager Plus role |
| Худалдан авалтын өртөг, opening stock, stock receipt | — | — | ✓ 25/30 | ✓ 30 | Нэмэлт Manager/Manager Plus role |
| Waste/stock adjustment бүртгэх | — | — | ✓ 25/30 | ✓ 30 | Нэмэлт Manager/Manager Plus role |
| Template Draft version үүсгэх/засах | — | — | ✓ 25/30 | ✓ 30 | Нэмэлт Manager/Manager Plus role |
| Template version Publish/Set default | — | — | ✓ 25/30 | ✓ 30 | Тухайн багцад зөвшөөрөгдсөн нэмэлт role |
| Eligible Published template version Archive | — | — | ✓ 25/30 | ✓ 30 | Тухайн багцад зөвшөөрөгдсөн нэмэлт role |
| Eligible room-ийг exact Published version рүү Rollout хийх | — | — | ✓ 25/30 | ✓ 30 | Тухайн багцад зөвшөөрөгдсөн нэмэлт role |
| Multi-room Rollout Preview/Confirm/Cancel remaining/Retry | — | — | ✓ 25/30 | ✓ 30 | Тухайн багцад зөвшөөрөгдсөн нэмэлт role |
| Multi-room batch/child төлөв, blocker харах | Read-only 25/30 | Зөвхөн assigned child task | ✓ 25/30 | ✓ 30 | ✓ |
| Initial room setup-ийн mode + exact Published version, эсвэл pending exact target version сонгох | — | — | ✓ 25/30 | ✓ 30 | Нэмэлт Manager/Manager Plus role |
| Configuration change үүсгэх/товлох/хөдөлгөөнгүй cancel | — | — | ✓ 25/30 | ✓ 30 | Нэмэлт Manager/Manager Plus role |
| Configuration shortage/variance/rollback шийдэх | — | — | ✓ 25/30 | ✓ 30 | Нэмэлт Manager/Manager Plus role |
| Assigned reconciliation/rollback room ↔ warehouse transfer | — | ✓ 25/30 | Нэмэлт Cleaner role | Нэмэлт Cleaner role | Нэмэлт Cleaner role |
| `Дутуу minibar-тайгаар нээх` override | — | — | ✓ 25/30 | ✓ 30 | Нэмэлт Manager/Manager Plus role |
| Хэрэглээ тайлагнах | — | ✓ 25/30 | Онцгой тайлан | Онцгой тайлан | Нэмэлт Manager/Manager Plus role |
| Агуулахаас өрөө рүү ердийн нөхөлт хийх | — | ✓ 25/30 | Нэмэлт Cleaner role | Нэмэлт Cleaner role | Нэмэлт Cleaner role |
| Active-stay refill хүсэлт үүсгэх/цуцлах | ✓ 25/30 | — | ✓ 25/30 | ✓ 30 | Нэмэлт Reception/Manager role |
| Active-stay refill task гүйцэтгэх/боломжгүй болгох | — | ✓ 25/30 | Нэмэлт Cleaner role | Нэмэлт Cleaner role | Нэмэлт Cleaner role |
| Active-stay non-guest stock-out бүртгэх | — | — | ✓ 25/30 | ✓ 30 | Нэмэлт Manager/Manager Plus role |
| Product/template entity deactivation/reactivation | — | — | ✓ 25/30 | ✓ 30 | Нэмэлт Manager/Manager Plus role |
| Never-used product/template entity hard-delete | — | — | ✓ 25/30 | ✓ 30 | Нэмэлт Manager/Manager Plus role |
| Room minibar status/shortage exception харах | ✓ | Ажлын хүрээнд | ✓ | ✓ | ✓ |
| Exact current/pending version, configuration/blocker харах | Read-only | Task хүрээнд | ✓ | ✓ | ✓ |
| Warehouse/room inventory ledger харах | — | Зөвхөн өөрийн task-ийн бүтээгдэхүүн | ✓ | ✓ | Нэмэлт Manager/Manager Plus role |

`Publish`, `Set default`, blocker шалгалт хангасан `Archive`, eligible exact-version `Rollout` болон multi-room Preview/Confirm/Cancel remaining/Retry дээрх эрхээр хийгдэнэ. Эдгээр version action-д 25,000₮ багцад зөвхөн Manager, 30,000₮ багцад Manager эсвэл Manager Plus зөвшөөрөгдөнө; Hotel Admin-д тухайн багцад зөвшөөрөгдсөн operational role тусдаа шаардлагатай. Cleaner зөвхөн өөрт assigned child task-аар, Reception read-only хүрээнд ажиллана. Бүх батлагдсан action package, subscription/account state, hotel scope болон server-side permission шалгалттай байна.

## 11. Аудит ба системийн хамгаалалт

- Stock balance-ийг movement ledger-ээс бодно; дур мэдэн overwrite хийхгүй.
- Location бүрийн үлдэгдэл 0-ээс бага болохгүй.
- Нэг movement request-ийн retry/давхар даралт давхар нөөц нэмэх/хасахгүй.
- Transfer, consumption, correction болон payment/report холбоосыг ID-аар хадгална.
- Waste/adjustment/override бүр actor, role, hotel, room/product, өмнөх/шинэ тоо, шалтгаан болон server time-тэй байна.
- Product, template эсвэл room ID-г сольж өөр hotel-ийн stock-д хандахыг server талд хориглоно.
- Inventory cost болон борлуулалтын price snapshot-ийг тусдаа хадгална. Selling price check-in price book-оос, cost consumption movement-ийн weighted average-аас ирнэ.
- Нөөц хүрэлцэхгүй алдаа гарвал partial transfer зөвхөн бодитоор шилжсэн тоогоор нэг удаа үүснэ.
- Нэг room-д нэгээс олон non-terminal config change үүсгэхгүй; check-in/config apply зэрэгцвэл authoritative lock/version-оор pending room-д stay нээхгүй.
- Configuration request, task болон apply audit нь exact current/target template/version ID-г хадгална; default эсвэл шинэ Published version гарсан ч pinned ID-г автоматаар солихгүй.
- Publish audit нь validation result болон version/product/target snapshot-ийг; Set default audit нь өмнөх/шинэ exact Default version ID, actor болон server time-ийг хадгална. Аль аль нь stock/configuration movement үүсгэсэн мэт бүртгэгдэхгүй.
- Archive-ийн final blocker recheck, `PUBLISHED → ARCHIVED` transition болон audit нэг атомик ажиллагаа байна. Audit нь exact version, өмнөх/шинэ state, blocker шалгалтын үр дүн, actor, role, reason, package entitlement болон server time-ийг хадгална. Historical reference-г устгахгүй, inventory/configuration movement үүсгэсэн мэт бүртгэхгүй.
- Rollout confirm audit нь room, current exact version, pinned target exact version, eligibility/safe-point result, request status, immediate blocker, actor, role, package болон server time-ийг хадгална. Confirm-ийг stock/current-version movement мэт бүртгэхгүй; Cleaner task, reconciliation movement болон atomic apply тус бүр existing configuration audit холбоостой байна.
- Multi-room audit нь immutable batch parent, child request бүрийн Preview/Confirm eligibility ба reason, child/result state, exact target, `retry_of_batch_id`, Cancel/Retry actor-role-package/server time болон idempotency key-г хадгална. Batch parent-д inventory movement зохиож бичихгүй; actual movement бүр зөвхөн холбогдох child task/configuration audit дээр байна.
- Configuration request, actual count, return/refill, shortage/variance, cancel, rollback болон apply бүр immutable audit холбоостой байна.

## 12. MVP acceptance criteria

- Manager-ийн product form дахь quantity нь зөвхөн агуулахын анхны үлдэгдэл байна.
- Агуулах болон өрөө бүрийн үлдэгдэл тусдаа харагдаж, нийлбэр нь hotel-ийн бодит нөөцтэй таарна.
- Худалдах үнэ болон худалдан авалтын өртөг тусдаа хадгалагдана.
- Шинэ stock receipt жигнэсэн дундаж өртгийг автоматаар шинэчилнэ.
- Transfer hotel-ийн нийт нөөцийг өөрчлөхгүй.
- Consumption/waste hotel-ийн нийт нөөцийг бууруулна.
- Waste/adjustment reason болон audit-тай; хуучин хөдөлгөөнийг edit/delete хийхгүй.
- Агуулах болон өрөөний нөөц сөрөг болохгүй.
- Cleaner нөхөхөд агуулах ба өрөөний movement атомик үүснэ.
- Active-stay refill нь Reception/Manager/Manager Plus-ийн request, Cleaner-ийн actual confirmation болон stay/price-book холбоостой байна.
- Pending active-stay refill complete/cancel болохоос өмнө check-out эхлэхгүй; check-out эхэлсний дараа шинэ refill task үүсэхгүй.
- Шинэ active-stay refill request зөвхөн active product-оор үүснэ; deactivation-оос өмнөх task retiring үед terminal болж болох ч inactive product дээр completion хийхгүй.
- Active stay-ийн warehouse return, room waste болон negative adjustment billable availability-гаас хасагдаж, generic positive adjustment зочны charge нэмэхгүй.
- Бүх 25,000₮/30,000₮ өрөөнд minibar заавал биш.
- Minibar-enabled өрөө `ACTIVE` template entity, exact `PUBLISHED` current version болон уг version-ийн бүх `ACTIVE` product-гүй check-in хийхгүй.
- Minibar-disabled өрөөнд routine guest minibar task/charge үүсэхгүй, төлөв `Хамаарахгүй` байна; OFF → ON pending change-ийн reconciliation task тусдаа байж болно.
- Minibar `Дутуу` өрөөг зөвхөн Manager/Manager Plus шалтгаан, эхний snapshot болон audit-тайгаар дараагийн stay-д нээж чадна.
- Reception shortage override үүсгэхгүй бөгөөд баримтжуулсан active-stay refill хийгээгүй өмнөөс дутуу бүтээгдэхүүнийг зочинд тооцохгүй.
- Opening quantity `0` product stay үеэр баримтжуулан refill хийсэн бол check-in selling price-аар бодит хэрэглээг тооцно; price book-д байгаагүй product-ийг charge хийхгүй.
- Manager current selling price өөрчилсөн ч active stay-ийн price book болон charge reprice болохгүй.
- Retiring product/template entity шинэ refill/configuration-д ашиглагдахгүй, active/historical snapshot болон warehouse stock устахгүй.
- Referenced product/template entity/version hard-delete болохгүй.
- Draft version current/pending/default/check-in/reconciliation target болохгүй; Published version-ийн product list/target quantity in-place edit болохгүй; Archived version history-only байна.
- Нэг template entity-ийн олон Published version зэрэг байж болох бөгөөд Published version байгаа үед яг нэг Default байна; Default солигдсон ч existing current/pending/stay/booking автоматаар өөрчлөгдөхгүй.
- Publish зөвхөн `ACTIVE` parent template, дор хаяж нэг ижил hotel-ийн `ACTIVE` product, давхардалгүй product болон эерэг бүхэл target quantity-тай Draft дээр атомикаар амжилттай болно; validation бүтэлгүй бол Draft хэвээр үлдэнэ.
- Анхны Published version автоматаар цорын ганц Default болно; дараагийн Publish Default-ийг өөрчлөхгүй бөгөөд солих бол тусдаа `Set default` action ашиглана.
- Publish/Set default existing current/pending/stay/booking exact pointer, price snapshot, stock balance/movement, Cleaner task, configuration request болон check-in blocker үүсгэх эсвэл өөрчлөхгүй.
- Publish/Set default-ийг хүчинтэй entitlement-тэй үед 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus хийнэ; Hotel Admin-д тухайн operational role тусдаа шаардлагатай.
- 25,000₮ багцад Manager Plus role үүсгэж 30,000₮-ийн Publish/Set default permission-ийг тойрохгүй.
- Archive зөвхөн Default биш Published version дээр зөвшөөрөгдөж, room current/pending, active stay эсвэл nonterminal reconciliation/Cleaner/configuration task reference байвал хориглогдоно.
- Historical stay/report/price book/invoice/export/inventory/audit reference Archive-ийг хориглохгүй, устахгүй; future booking version pin хийдэггүй тул blocker болохгүй.
- Archive current/pending/stay/booking pointer, price snapshot болон stock-ийг өөрчлөхгүй, task/configuration request/Rollout/check-in blocker үүсгэхгүй; Archived version terminal бөгөөд reuse хийх бол шинэ Draft clone үүсгэнэ.
- Archive blocker final recheck, state transition болон audit атомик байна.
- Archive action-ийг хүчинтэй entitlement-тэй үед 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus хийнэ; Hotel Admin-д тохирох role тусдаа шаардагдаж, 25,000₮ багцад Manager Plus-аар gate тойрохгүй.
- Rollout target нь room-ийн current version-тэй ижил hotel, ижил `ACTIVE` template-ийн өөр exact `PUBLISHED` version бөгөөд target product бүр `ACTIVE` байна; mode/template switch existing configuration-change урсгалаар хийгдэнэ.
- Зөвхөн `ACTIVE`, minibar `ON`, өөр nonterminal pending configuration-гүй eligible room Rollout-д сонгогдоно. Active stay-тай room сонгогдож болох ч `SCHEDULED_AFTER_STAY` байна.
- Rollout confirm exact target-т pinned room-level pending request болон check-in/assignment blocker шууд үүсгэх боловч stock movement, current version эсвэл price snapshot өөрчлөхгүй.
- Vacant safe-point room-д Cleaner reconciliation task шууд үүснэ; active stay эсвэл checkout/payment/minibar report/refill unfinished бол бүгд terminal болсны дараа task үүснэ.
- Cleaner reconciliation болон P0-37B validation амжилттай дуусахад current version атомикаар солигдоно. Дараагийн Default/Publish pinned target-ийг өөрчлөхгүй бөгөөд pending target Archive blocker байна.
- Rollout permission нь 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus; Hotel Admin-д тохирох role тусдаа байна. 20,000₮/entitlement-гүй hotel болон 25,000₮-ийн Manager Plus action deny болно.
- Multi-room batch нэг hotel/template/exact Published target-тай; Preview room бүрийг `READY_NOW`, `SCHEDULE_AFTER_STAY`, `INELIGIBLE + reason` гэж side effectгүй ангилж, Confirm дахин шалгана.
- Confirm partial success хэрэглэж accepted room бүрт тусдаа атомик child pending request + immediate blocker үүсгэнэ; invalid room `SKIPPED` + reason бөгөөд blocker/stock movement-гүй, нэг child failure бусдад нөлөөлөхгүй.
- Batch parent grouping/progress-only бөгөөд inventory ledger, guest charge/revenue/COGS үүсгэхгүй; `IN_PROGRESS`, `COMPLETED`, `PARTIALLY_COMPLETED`, `CANCELLED`, `FAILED_VALIDATION` төлөв child-үүдээс derivation хийнэ.
- `Cancel remaining` movement-гүй child-ийг cancel/unblock хийж, movement-started child-ийг compensating rollback-д оруулан terminal болтол blocked байлгана; applied child зөвхөн өмнөх exact version рүү шинэ Rollout-аар буцна.
- Retry нь `retry_of_batch_id` холбоостой шинэ batch бөгөөд хуучин parent/child/movement-г edit хийхгүй. Duplicate Confirm idempotent, per-room one-pending/concurrency хамгаалалттай, cross-hotel scope deny байна.
- Preview alone Archive blocker биш; confirmed nonterminal child/batch target Archive-ийг terminal болтол блоклоно, `FAILED_VALIDATION`/accepted child-гүй batch блоклохгүй.
- Batch Preview/Confirm/Cancel remaining/Retry нь 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus; Hotel Admin-д тохирох role тусдаа, 20,000₮/unentitled hotel болон 25,000₮-ийн Manager Plus deny байна. Cleaner assigned child task-аар, Reception read-only ажиллана.
- Room current болон pending target exact version ID хадгалж, active stay check-in үеийн exact version snapshot-аараа дуусна; future booking version-ийг booking үед pin хийхгүй.
- Pending config үед exact current version-оор routine next-stay refill хийхгүй; request-д pinned exact target Published version-ийн reconciliation task үүснэ.
- ON → OFF room balance `0` болсны дараа apply болно. OFF → ON/Template-version A → B үед exact target version заавал `PUBLISHED` байх ба target бүрэн эсвэл хүчинтэй shortage override хангасны дараа apply болно.
- Configuration return/refill нь guest consumption/sale/revenue/charge биш; Cleaner зөвхөн assigned task-аар хоёр чиглэлийн transfer батална.
- Future booking config booking үед pin болохгүй, existing booking автоматаар cancel/reprice болохгүй; non-terminal pending physical room check-in/assignment blocker-тэй байна.
- Movement эхэлсний дараа config request silent cancel болохгүй; immutable compensating rollback бүрэн дуусна.
- Configuration apply cleaning status-ийг автоматаар өөрчлөхгүй.
- Confirmed booking/active stay-ийн planned checkout change MVP-д байхгүй; STAY-DEC-011 append-only rule нь зөвхөн post-MVP invariant.
- Minimal guard өөрөө inventory/configuration/price/opening snapshot, stock movement/task/event, price/reprice/refund/payment эсвэл change action/permission үүсгэхгүй.
- Early/late actual checkout original planned end-ийг өөрчлөхгүй; room actual checkout хүртэл occupied, дараа нь snapshot buffer + clean + minibar readiness gate үйлчилнэ.
- Early auto reprice/refund, overdue auto fee/penalty болон inventory/config/stock/snapshot side effect үүсэхгүй.
- 20,000₮ багцад inventory UI/API ашиглах боломжгүй байна.

## 13. Батлагдсан шийдвэр

### INV-DEC-001 — Manager quantity нь агуулахын нөөц

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Product form-д Manager-ийн оруулах quantity нь зөвхөн hotel-ийн агуулахын анхны үлдэгдэл байна. Өрөөний тоог нийлүүлэхгүй; дараагийн өөрчлөлтийг movement-ээр хөтөлнө.

### INV-DEC-002 — Агуулах ба өрөөний тусдаа нөөц

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Warehouse болон room minibar balance-ийг тусдаа хөтөлж, transfer-ийг холбоостой атомик movement болгоно.

### INV-DEC-003 — Immutable inventory ledger

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Opening, purchase, transfer, return, consumption, waste болон adjustment бүр immutable movement байна. Waste/adjustment reason ба audit-тай, нотлох зураг болон хоёр дахь approval шаардахгүй. Active stay-ийн refill/non-guest room movement stay-д холбогдож, guest charge-ийн formula-д төрлөөрөө зөв нэмэгдэж/хасагдана; generic positive adjustment billable quantity нэмэхгүй.

### INV-DEC-004 — Худалдан авалтын өртөг ба weighted average

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Худалдах үнэ болон худалдан авалтын өртгийг тусад нь бүртгэж, MVP-д hotel-ийн хэмжээнд тасралтгүй жигнэсэн дундаж өртөг хэрэглэнэ. Өмнөх cost snapshot буцаад өөрчлөгдөхгүй.

### INV-DEC-005 — Сөрөг нөөцийн хориг

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Warehouse болон room location-ийн үлдэгдэл сөрөг болохгүй. Хүрэлцэхгүй refill нь байгаа тооноос илүү шилжүүлэхгүй бөгөөд Manager-д shortage харуулна.

### INV-DEC-006 — Controlled shortage override

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Minibar-enabled өрөө ердийн үед `Бүтэн` байна. Нөөц хүрэлцэхгүй үед Manager/Manager Plus шалтгаан, бодит эхний тооны snapshot болон audit-тайгаар `Дутуу minibar-тайгаар нээх` зөвшөөрлийг зөвхөн дараагийн stay-д үүсгэнэ. Reception override үүсгэхгүй. Opening quantity `0` барааг active-stay refill task-аар баримтжуулан нөхөөгүй бол зочинд тооцохгүй; нөхсөн бол check-in price book-ийн үнээр бодит хэрэглээг тооцно.

### INV-DEC-007 — Minibar өрөө бүрд optional

- **Төлөв:** Батлагдсан
- **Шийдвэр:** 25,000₮/30,000₮ багцын бүх өрөөнд minibar заавал биш. `Minibar ашиглана` өрөөнд нэг `ACTIVE` template entity болон exact `PUBLISHED` current version заавал; product/target quantity нь immutable version дээр байна. Current mode `Ашиглахгүй` өрөөнд routine guest task/charge үүсэхгүй, төлөв `Хамаарахгүй` байна. OFF → ON pending change exact Published target version-ийг pin хийж, reconciliation task тусдаа үүсгэж болно.

### INV-DEC-008 — Inventory action permission

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Product/cost/warehouse/waste/adjustment/mode, template Draft, батлагдсан validation-тай Publish, тусдаа Set default, blocker шалгасан Archive, eligible exact-version Rollout, config change/variance/rollback/shortage override-ийг хүчинтэй entitlement болон role-ийн огтлолцлоор Manager/Manager Plus удирдана. Publish/Set default/Archive/Rollout-д 25,000₮-д зөвхөн Manager, 30,000₮-д Manager/Manager Plus зөвшөөрөгдөнө. Hotel Admin-д тохирох operational role тусдаа шаардлагатай бөгөөд 20,000₮/entitlement-гүй hotel эсвэл 25,000₮-ийн Manager Plus package gate-ийг давж гарахгүй. Анхны Published version автоматаар цорын ганц Default болох ба дараагийн Publish Default-ийг өөрчлөхгүй. Archive зөвхөн Default биш Published version дээр room current/pending, active stay болон nonterminal configuration request/reconciliation/rollback/Cleaner task reference байхгүй үед хийгдэнэ; historical stay/report/price book/invoice/export/inventory/audit болон version pin-гүй future booking blocker болохгүй. Publish/Set default/Archive existing exact pointer, price snapshot, stock, Cleaner task, configuration request, Rollout болон check-in blocker-т нөлөөлөхгүй; Archived version terminal тул reuse хийхдээ шинэ Draft clone үүсгэнэ. Explicit Rollout нь `ACTIVE`, minibar `ON`, өөр pending change-гүй room-ийг ижил hotel, ижил `ACTIVE` template-ийн өөр exact `PUBLISHED`, бүх product нь `ACTIVE` version рүү pinned pending request-аар шилжүүлнэ. Confirm check-in/assignment blocker шууд үүсгэх боловч stock/current version/price өөрчлөхгүй; safe room-д Cleaner task шууд, active stay эсвэл unfinished checkout/payment/minibar report/refill-тэй room-д `SCHEDULED_AFTER_STAY` бөгөөд safe point-ийн дараа task үүснэ. Cleaner reconciliation ба P0-37B validation амжилттай болоход current version атомикаар солигдоно; дараагийн Default/Publish target-ийг өөрчлөхгүй, pending target Archive blocker байна. Mode/template switch existing configuration-change урсгалаар хийгдэнэ (`RML-DEC-022`–`RML-DEC-024`). Reception эсвэл Manager/Manager Plus active-stay refill request үүсгэж, зөвхөн Cleaner role-той хэрэглэгч exact-version-scoped task-аар actual refill movement батална. Cleaner assigned configuration task-аар room ↔ warehouse transfer баталж болох боловч generic warehouse/adjustment/target/override-ийг өөрчлөхгүй; Reception exact current/pending config, төлөв болон хүчинтэй exception-ийг read-only харна.

- **P0-37C-3 нэмэлт:** Нэг hotel/template/exact Published target-ийн multi-room Preview нь side effectгүй; Confirm room бүрийг дахин шалган partial success-аар тусдаа pinned child request + blocker үүсгэнэ. Invalid room `SKIPPED` + reason, batch parent progress-only бөгөөд inventory ledger/guest/financial movement үүсгэхгүй. Cancel remaining нь movement-гүй child-ийг unblock хийж, хөдөлгөөнтэй child-ийг immutable rollback-д оруулна; applied child-ийг шинэ Rollout-аар буцаана. Retry шинэ linked batch, target pinned, confirmed nonterminal child Archive blocker, duplicate Confirm idempotent, per-room concurrency болон exact package-role gate-ийг `RML-DEC-025`–`RML-DEC-028`-аар мөрдөнө.

## 14. Холбоотой дараагийн асуудал

P0-08, P0-09 болон P0-34–P0-39 хаагдсан. `STAY-DEC-008`–`014` нь readiness, actual-time, immutable planned end, overdue conflict болон fractional hourly duration-ийг баталсан; эдгээр нь inventory/config/stock/snapshot/movement-ийн түүхийг overwrite хийхгүй. Shift, cash ledger, financial тайлан, selling price snapshot болон entity/version lifecycle тусдаа canonical баримтад батлагдсан; early-morning cutoff түр хойшлогдсон.
