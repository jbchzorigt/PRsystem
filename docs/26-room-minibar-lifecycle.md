# Room, category, product болон template lifecycle

**Хувилбар:** 0.14  
**Төлөв:** P0-37 Room–Minibar lifecycle, P0-38 stay pricing/config болон P0-39A–P0-39C-2 батлагдсан  
**Хамаарах үе шат:** MVP — Manager / Reception / Booking / Cleaner / Inventory

## 1. Зорилго

Room, room category, minibar product болон minibar template-ийг идэвхгүй болгох үед active stay, өмнө баталгаажсан future booking, inventory, price book болон санхүүгийн түүхийг эвдэхгүй байна. Шинэ ажиллагааг шууд зогсоох боловч аль хэдийн эхэлсэн эсвэл баталгаажсан ажиллагааг автоматаар устгахгүй.

Энэ хувилбар P0-37-ийн **A, B, C-1, C-2A, C-2B-1/2 болон C-3 хэсгийг** батална:

- lifecycle state;
- deactivation үеийн шинэ ажиллагааны хориг;
- active stay/future booking хамгаалалт;
- hard-delete-ийн хязгаар;
- reactivation, permission болон audit;
- нэг room-ийн minibar mode/template өөрчлөлтийн `current + pending` загвар;
- Cleaner-ийн physical reconciliation, check-in blocker болон rollback;
- template entity-ээс тусдаа `DRAFT → PUBLISHED → ARCHIVED` version lifecycle, immutable Published version болон exact room-version холбоос;
- Publish validation, анхны/дараагийн Default дүрэм, Publish/Set default isolation болон package/role gate;
- version Archive blocker, historical reference хамгаалалт, terminal behavior болон permission;
- exact Published target-тай room-level explicit Rollout, eligibility, pending request/check-in blocker trigger болон safe-point Cleaner task;
- multi-room Rollout preview, partial success, batch parent/room child progress, `Cancel remaining`, immutable retry/rollback болон permission.

P0-37 Room/Minibar lifecycle-ийн кодын өмнөх бизнесийн шийдвэрүүд энэ баримтаар бүрэн хаагдсан.

## 2. Нэгдсэн lifecycle state

```text
CREATE
  → Идэвхтэй (ACTIVE), эсвэл
  → Идэвхгүй (INACTIVE)

Идэвхтэй (ACTIVE)
  → Идэвхгүй болгохоор хүлээгдэж буй (RETIRING)
  → Идэвхгүй (INACTIVE)

RETIRING/INACTIVE
  → шаардлага хангасан reactivation
  → ACTIVE
```

Шинээр үүсгэх үед Manager зөвхөн `ACTIVE` эсвэл `INACTIVE` initial state сонгоно. `RETIRING`-ийг form/API-аар шууд сонгохгүй; зөвхөн active entity-ийн deactivation хүсэлт амжилттай болоход сервер үүсгэнэ.

| Төлөв | Шинэ ажиллагаа | Өмнөх/идэвхтэй ажиллагаа | Түүх |
| --- | --- | --- | --- |
| `ACTIVE` | Зөвшөөрөгдөнө | Үргэлжилнэ | Хадгалагдана |
| `RETIRING` | Шинэ booking/check-in/assignment хориглоно | Active stay-г дуусгана; confirmed booking-г reactivate/move/cancel-аар шийдвэрлэнэ | Хадгалагдана |
| `INACTIVE` | Шинэ sales/check-in/assignment/refill/configuration хориглоно | Historical reporting болон inactive stock-ийн controlled return/waste/adjustment л зөвшөөрөгдөнө | Жагсаалт, тайлан, invoice, inventory болон audit-д хадгалагдана |

Manager/Manager Plus deactivation хүсэлт батлахад entity шууд `RETIRING` болно. Blocker байхгүй бол сервер нэг ажиллагаагаар `INACTIVE` болгож болно. Blocker байгаа бол жагсаалтыг харуулж, хамгийн сүүлийн blocker шийдэгдсэний дараа сервер deactivation хүсэлтийн дагуу `INACTIVE` болгоно.

`RETIRING` төлөв нь алдаа биш. Энэ нь шинэ хэрэглээг хаасан боловч өмнөх үүрэг, бодит нөөц болон түүхийг аюулгүй дуусгаж байгаа төлөв байна.

## 3. Шинэ ажиллагааг шууд хаах дүрэм

Deactivation хүсэлт амжилттай болмогц:

- шинэ online booking болон walk-in assignment-д entity-г санал болгохгүй;
- existing booking ID байсан ч ямар ч шинэ check-in-д ашиглахгүй;
- шинэ room/template/product assignment-д сонголт болгон харуулахгүй;
- client хуучин ID илгээсэн ч backend/API `ENTITY_NOT_ACTIVE` алдаагаар хориглоно;
- public availability, search болон operational selector-оос нууна;
- Reception-д `Идэвхгүй болгохоор хүлээгдэж буй` badge болон blocker-ийн товч мэдээлэл read-only харагдана.

Deactivation-оос өмнө баталгаажсан booking/stay-г энэ дүрмээр автоматаар cancel, reprice эсвэл өөр entity рүү шилжүүлэхгүй. Гэхдээ `RETIRING/INACTIVE` entity дээр check-in хийхгүй. Booking-г:

1. шаардлага хангасны дараа entity-г reactivate хийж биелүүлэх;
2. lifecycle `ACTIVE` өөр room/category руу шилжүүлэх; эсвэл
3. батлагдсан relocation/cancellation урсгалаар шийдвэрлэх

хүртэл operational blocker-тэй confirmed хэвээр хадгална. Relocation/cancellation-ийн нарийн дүрэм P0-15-д батлагдана.

### 3.1 Minibar configuration-ийн дам gate

Minibar-enabled room шинэ booking/check-in-д eligible байхын тулд:

- room болон category `ACTIVE`;
- effective template entity `ACTIVE`;
- current configuration нь exact `PUBLISHED` version заасан;
- template-ийн check-in price book-д орох бүх product `ACTIVE`

байна. Аль нэг entity dependency `RETIRING/INACTIVE`, эсвэл current exact version `PUBLISHED` биш бол room өөрөө active байсан ч `Configuration blocker`-тай болж, шинэ availability/check-in-д орохгүй. Manager §§14–23-т батлагдсан P0-37B room-level шилжилтээр active configuration бүрдүүлэх эсвэл room minibar mode-ийг хүчинтэйгээр өөрчлөх хүртэл blocker үргэлжилнэ. P0-37C-2B-1 archive validation нь current/pending room reference-тэй version-ийг archive хийхийг хориглох тул хэвийн transition-оор room `ARCHIVED` current version-тэй болохгүй. Version lifecycle, Publish/Default, Archive, room-level болон multi-room explicit Rollout-ийг §§24–38-д баталсан.

## 4. Room lifecycle

Room-ийг `INACTIVE` болгохын өмнө:

- active stay байхгүй;
- check-out/payment/Cleaner/refill task pending биш;
- тухайн physical room-д өмнө баталгаажсан future assignment үлдээгүй, эсвэл уг booking-г өөр room руу шилжүүлсэн/цуцалсан;
- minibar-enabled бол room stock/config reconciliation дууссан

байна.

Active stay байгаа үед room `RETIRING` болж, current guest хэвийн checkout хийнэ. Энэ stay-ийн room tariff, minibar template, opening quantity, price book, report болон payment snapshot өөрчлөгдөхгүй.

Өмнө баталгаажсан booking тухайн physical room-д аль хэдийн оноогдсон бол автоматаар цуцлахгүй. Гэхдээ room `RETIRING` байх хугацаанд check-in хийхгүй. Hotel room-г шаардлага хангасны дараа reactivate хийх, booking-г өөр `ACTIVE` room/category руу шилжүүлэх эсвэл cancellation урсгалаар шийдвэрлэнэ. Online booking нь category inventory эзэлж, physical room-ийг check-in үед онооно (`BK-DEC-013`).

## 5. Room category lifecycle

Category `RETIRING` болмогц:

- шинэ online booking, шинэ walk-in check-in болон шинэ room assignment-д сонгохгүй;
- өмнө баталгаажсан booking болон active stay-г автоматаар цуцлах/reprice хийхгүй;
- child room, historical stay болон тайлангийн category snapshot-ийг өөрчлөхгүй.

Category-г `INACTIVE` болгохын өмнө active stay/future booking-ийн холбоос шийдэгдэж, operational child room-ууд өөр active category руу шилжсэн эсвэл өөрсдөө inactive болсон байна.

## 6. Minibar product lifecycle

Product `RETIRING` болмогц:

- шинэ template/template version-д нэмэхгүй;
- шинэ active-stay refill request болон дараагийн stay-ийн refill-д сонгохгүй;
- шинэ check-in price book-д оруулах active configuration үлдээхгүй;
- өмнө price book-д орсон active/historical stay-ийн нэр, үнэ, report, charge болон correction-ийг устгахгүй.

Шинэ active-stay refill request үүсгэх үед product `ACTIVE` байх ёстой. Deactivation-оос өмнө үүссэн pending refill task нь `RETIRING` үед complete/cancel/боломжгүй гэсэн terminal төлөвт орж болно; task үүссэн цаг болон deactivation time-ийг сервер шалгана. `INACTIVE` product дээр refill completion хийхгүй.

Өрөөнд өмнө байршуулсан product-ийг active stay-ийн checkout дээр тухайн stay-ийн locked price-аар тайлагнаж болно. Room-д үлдсэн тоог warehouse return, consumption, waste эсвэл reason-тэй adjustment-аар шийдвэрлэнэ. Pending refill task болон product шаардсан active room/template configuration шийдэгдтэл product `RETIRING` хэвээр байна.

Warehouse-д үлдсэн stock-ийг устгахгүй. `INACTIVE` product inventory жагсаалт, valuation болон audit-д харагдсан хэвээр байх бөгөөд Manager буцаалт/waste/adjustment хийх эсвэл шаардлага хангаад product-ийг reactivate хийж болно.

## 7. Minibar template lifecycle

Template `RETIRING` болмогц:

- шинэ room assignment-д сонгохгүй;
- шинэ check-in-д уг template-ийг шинээр оноохгүй;
- active stay дээр pinned болсон template version, target quantity болон price book өөрчлөгдөхгүй;
- historical stay/report/invoice тухайн snapshot-оо хадгална.

Existing room assignment, active stay болон pending reconciliation шийдэгдтэл template entity `RETIRING` хэвээр байна. Нэг room-ийн template assignment/reconciliation-ийг §§14–23-т, template version-ийн immutable lifecycle, exact binding, Publish/Default, Archive, room-level болон multi-room explicit Rollout-ийг §§24–38-д баталсан.

## 8. Hard-delete дүрэм

Дараах бүх нөхцөл зэрэг хангагдсан үед л entity record-ийг hard-delete хийж болно:

- entity огт operational ашиглалтад ороогүй;
- active/historical stay, booking, room/category/template assignment, price book, report, invoice/payment эсвэл export reference байхгүй;
- product/room бол opening stock, room stock болон inventory movement огт үүсээгүй;
- pending task, deactivation/reactivation request болон бусад business dependency байхгүй.

Эдгээрийн аль нэг үүссэн бол hard-delete хориглож, `RETIRING → INACTIVE` lifecycle ашиглана. Hard-delete зөвшөөрөгдсөн ч actor, entity ID/type, reason болон server time бүхий security audit event хадгална.

## 9. Reactivation

Manager/Manager Plus `RETIRING` deactivation хүсэлтийг цуцлах эсвэл `INACTIVE` entity-г reactivate хийж болно. Сервер:

- шаардлагатай field бүрэн;
- hotel scope болон package entitlement хүчинтэй;
- холбоотой category/product/template active;
- room configuration болон inventory invariant зөрчөөгүй;
- тухайн entity-д тохируулсан uniqueness constraint, үүнд hotel-scoped room number, зөрчөөгүй

эсэхийг шалгасны дараа `ACTIVE` болгоно.

Reactivation нь өмнөх active stay, booking, report, invoice, price book эсвэл audit-ийг сэргээж засахгүй. Шинэ ажиллагаа зөвхөн reactivation-ийн server time-оос хойш entity-г ашиглана.

## 10. Эрх ба харагдац

| Үйлдэл | Hotel Admin | Manager | Manager Plus | Reception | Cleaner |
| --- | ---: | ---: | ---: | ---: | ---: |
| Room/category/product/template deactivation хүсэх | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — | — |
| Deactivation хүсэлт цуцлах/reactivate хийх | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — | — |
| Never-used entity hard-delete хийх | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — | — |
| Lifecycle state/blocker харах | ✓ | ✓ | ✓ | Read-only, room operation хүрээнд | Зөвхөн өөрийн task хүрээнд |

Hotel Admin operational lifecycle action хийх бол Manager/Manager Plus role тусдаа шаардлагатай. UI button нуух/disabled болгохоос гадна backend бүх state transition, dependency болон hotel scope-ийг шалгана.

## 11. Audit ба concurrency хамгаалалт

- Deactivation/reactivation/hard-delete request бүр entity type/ID, hotel, old/new state, reason, actor болон server time-тэй байна.
- `RETIRING` болсон үеийн blocker snapshot болон дараа нь blocker бүр шийдэгдсэн event хадгална.
- Автомат `RETIRING → INACTIVE` transition нь original requester болон system actor-ийг хамтад нь хадгална.
- Нэг entity дээр зэрэг өөр state transition хийхийг version/optimistic lock-оор хамгаална.
- State transition болон шинэ booking/check-in/assignment зэрэгцвэл нэг transaction-ийн authoritative state-аар inactive entity ашиглагдахгүй.
- Historical query нь current entity name/status-аас бус тухайн үеийн snapshot-ийг ашиглана.
- Cross-hotel entity ID ашиглахыг бүх API дээр server-side хориглоно.

## 12. MVP acceptance criteria

- Deactivation хүсэлт амжилттай болмогц entity шинэ booking/check-in/assignment-д ашиглагдахгүй.
- Active stay болон өмнө баталгаажсан booking автоматаар cancel/reprice болохгүй.
- Confirmed booking автоматаар цуцлагдахгүй боловч retiring/inactive entity-г reactivate хийх эсвэл booking-г active entity рүү шилжүүлэх хүртэл check-in хийхгүй.
- Minibar-enabled room-ийн room/category/template болон бүх template product active биш бол configuration blocker үүсэж, шинэ booking/check-in-д орохгүй.
- Active stay-тай room `RETIRING` болж, checkout болон шаардлагатай task дууссаны дараа л `INACTIVE` болно.
- Future physical room assignment автоматаар устахгүй; resolve хийх хүртэл room `RETIRING` байна.
- Category-ийн child room, active stay болон future booking түүх хадгалагдана.
- Retiring product шинэ template/refill/check-in configuration-д ашиглагдахгүй боловч өмнө snapshot болсон stay checkout дээр тайлагдана.
- Inactive product-ийн warehouse stock inventory/report-оос алга болохгүй.
- Retiring template шинэ room assignment-д ашиглагдахгүй, active stay-ийн pinned version өөрчлөгдөхгүй.
- Referenced entity hard-delete болохгүй; never-used entity л батлагдсан permission-ээр delete хийгдэнэ.
- Reactivation нь бүх dependency/invariant шалгалт амжилттай үед л хэрэгжинэ.
- Reception lifecycle state-ийг харна, operational transition хийхгүй.
- State transition, blocker resolution болон hard-delete audit-тай байна.
- Confirmed booking/active stay-ийн planned checkout change MVP-д байхгүй; STAY-DEC-011 append-only amendment rule нь зөвхөн post-MVP invariant.
- Minimal guard өөрөө lifecycle/configuration transition, pointer/blocker, task/movement/snapshot, action/permission, pricing/repricing/refund/payment үүсгэхгүй.
- Early/late actual checkout original planned end-ийг өөрчлөхгүй; room actual checkout хүртэл occupied, дараа нь snapshot buffer + clean + applicable minibar readiness gate үйлчилнэ.
- Early auto reprice/refund, overdue auto fee/penalty болон lifecycle/config/task/movement/snapshot side effect үүсэхгүй.

## 13. Батлагдсан шийдвэр

### RML-DEC-001 — Нэгдсэн lifecycle state

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Room, category, minibar product болон template нь `ACTIVE → RETIRING → INACTIVE` lifecycle ашиглана. Deactivation хүсэлт шинэ ажиллагааг шууд хааж, dependency байхгүй бол шууд, байгаа бол шийдэгдсэний дараа inactive болно.

### RML-DEC-002 — Active stay болон future booking хамгаалалт

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Active stay болон deactivation-оос өмнө баталгаажсан booking-г автоматаар cancel, reprice, delete эсвэл өөр entity рүү шилжүүлэхгүй. Active stay current snapshot-аараа үргэлжилнэ; future booking confirmed хэвээр боловч entity-г reactivate хийх эсвэл active entity рүү шилжүүлэх/цуцлах хүртэл check-in хийхгүй.

### RML-DEC-003 — Entity-specific deactivation

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Room нь stay/booking/task/reconciliation, category нь dependent room/stay/booking, product нь pending refill/room stock/active configuration, template нь room assignment/stay/reconciliation blocker-оо шийдсэний дараа `INACTIVE` болно. Retiring entity шинэ operational selection-д ашиглагдахгүй. Minibar-enabled room-ийн room/category/template/product dependency бүгд active биш бол шинэ booking/check-in-д configuration blocker үйлчилнэ.

### RML-DEC-004 — Historical snapshot хамгаалалт

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Deactivation/reactivation нь өмнөх stay, booking, price book, report, invoice/payment, inventory movement, export болон audit-ийг өөрчлөхгүй. Historical data тухайн үеийн snapshot-оо ашиглана.

### RML-DEC-005 — Hard-delete-ийн хязгаар

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Огт ашиглагдаагүй, reference/task/stock/movement-гүй entity-г л эрх бүхий Manager/Manager Plus hard-delete хийж болно. Бусад бүх entity-г lifecycle-аар inactive болгож, deletion audit хадгална.

### RML-DEC-006 — Reactivation, permission ба audit

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Manager/Manager Plus dependency, package, configuration болон uniqueness шалгалт амжилттай үед deactivation-ийг цуцлах/reactivate хийж болно. Hotel Admin-д operational role тусдаа шаардлагатай; Reception read-only байна. Transition бүр reason, actor, time болон blocker audit-тай байна.

## 14. Room configuration-ийн `current + pending` загвар

Room бүр:

- яг нэг **current configuration**-тай байна: `Minibar ашиглана/ашиглахгүй` mode болон ашиглана бол одоо хүчинтэй template entity + exact `PUBLISHED` version;
- нэг агшинд хамгийн ихдээ нэг **non-terminal pending configuration change**-тай байна;
- pending change нь current configuration-ийг шууд солихгүй;
- pending change үүссэнээс эхлэн тухайн physical room шинэ check-in болон шинэ physical-room assignment авахгүй.

Template entity/version-ийн lifecycle-ийг хооронд нь ялгана. P0-37B target template entity-г сонгох болон нэг room-ийн бодит stock-ийг тааруулахыг баталсан. P0-37C-1-ийн дагуу current configuration болон pending target нь exact `PUBLISHED` version ID-г заана; default өөрчлөгдсөн ч өмнө үүссэн холбоос автоматаар солигдохгүй.

### 14.1 Pending change state

```text
SCHEDULED_AFTER_STAY
  → READY_FOR_RECONCILIATION
  → IN_PROGRESS
  → APPLIED

READY_FOR_RECONCILIATION / IN_PROGRESS
  → BLOCKED_STOCK
  → IN_PROGRESS

READY_FOR_RECONCILIATION / IN_PROGRESS
  → BLOCKED_VARIANCE
  → IN_PROGRESS

Хөдөлгөөн эхлээгүй pending
  → CANCELLED

Хөдөлгөөн эхэлсэн pending
  → ROLLBACK_REQUIRED
  → ROLLED_BACK
```

`APPLIED`, `CANCELLED`, `ROLLED_BACK` нь terminal төлөв. Бусад төлөв room-ийн `Configuration change pending` blocker-ийг идэвхтэй байлгана. Нэг room-д non-terminal pending байхад хоёр дахь request үүсгэхийг backend хориглоно.

## 15. Active stay ба safe point

Active stay байгаа үед Manager/Manager Plus өөрчлөлтийг `SCHEDULED_AFTER_STAY` байдлаар товлож болно. Ингэхэд:

- current stay-ийн mode, exact template version, opening snapshot болон selling-price book өөрчлөгдөхгүй;
- тухайн stay-ийн хэрэглээ, refill, charge болон санхүүгийн тайлан current stay snapshot-аараа дуусна;
- current guest-ийн stay-г хүчээр зогсоохгүй;
- room шинэ check-in/assignment авахгүй.

Active stay байхгүй бөгөөд initial dependency validation амжилттай бол request шууд `READY_FOR_RECONCILIATION` болно. Аль ч тохиолдолд pending үүссэнээс terminal болох хүртэл physical room blocker-тэй байна.

Дараах бүх нөхцөл хангагдсаны дараа л request `READY_FOR_RECONCILIATION` болно:

1. checkout болон эцсийн төлбөрийн урсгал дууссан;
2. шаардлагатай Cleaner/Manager minibar usage report terminal болсон;
3. тухайн stay-ийн pending active-stay refill task бүр complete/cancel/боломжгүй гэсэн terminal төлөвтэй болсон;
4. stay-ийн guest consumption болон төлбөрт орох inventory movement түгжигдсэн.

Pending config байгаа room-д ердийн next-stay refill-ийг хуучин current template-р хийхгүй. Safe point-ийн дараа server pending target-д зориулсан тусдаа configuration reconciliation task үүсгэнэ.

## 16. `Minibar ашиглана → ашиглахгүй`

1. Cleaner зөвхөн өөрт оноогдсон reconciliation task-аас өрөөнд бодитоор байгаа бүх бүтээгдэхүүний тоог батална.
2. Ашиглах боломжтой бүтээгдэхүүнийг room → warehouse immutable transfer-аар буцаана.
3. Эвдэрсэн, дутсан, хугацаа дууссан эсвэл бодит тооллого зөрсөн мөрийг Cleaner санхүүгийн утгаар шийдэхгүй; Manager/Manager Plus reason-тэй waste/adjustment-аар шийднэ.
4. Room stock бүх product дээр `0` болсон үед сервер current mode-ийг `Ашиглахгүй`, template-ийг `null`, minibar status-ийг `Хамаарахгүй` болгон нэг ажиллагаагаар шилжүүлнэ.

Room stock `0` болоогүй бол OFF configuration-г apply хийхгүй. Shortage override нь ON → OFF үеийн үлдэгдлийг алга болгох shortcut биш.

## 17. `Minibar ашиглахгүй → ашиглана`

1. Manager/Manager Plus lifecycle `ACTIVE` target template entity болон exact `PUBLISHED` target version сонгоно.
2. Server тухайн exact version-ийн immutable product/target quantity бүхий reconciliation task үүсгэнэ.
3. Cleaner өөрт оноогдсон task-аар бодитоор тавьсан quantity-г баталж, warehouse → room transfer үүсгэнэ.
4. Бүх target quantity бүрдвэл configuration apply болж, minibar status `Бүтэн` болно.

Warehouse stock хүрэлцэхгүй бол request `BLOCKED_STOCK` хэвээр байна. Manager/Manager Plus existing `Дутуу minibar-тайгаар нээх` дүрмийн шаардлагыг хангасан shortage override үүсгэвэл бодит quantity snapshot-тайгаар configuration-г apply хийж болно; persisted minibar status `Дутуу`, тусдаа exception flag `Manager зөвшөөрсөн` байх бөгөөд UI-д нийлмэл `Дутуу — Manager зөвшөөрсөн` badge харагдана. Сөрөг warehouse stock хэзээ ч үүсгэхгүй.

## 18. `Template A/version → Template B/version`

Cleaner эхлээд room-ийн product бүрийн бодит тоог task-аар батална. Server уг бодит тоог pending request-д pinned болсон Template B-ийн exact `PUBLISHED` target version-тэй product тус бүрээр харьцуулна:

- B-д байхгүй product болон B target-аас илүү quantity-г room → warehouse буцаана;
- B-д шинээр орсон product болон B target-аас дутуу quantity-г warehouse → room нөхнө;
- ижил product-ийн target-тэй тэнцүү бодит quantity-г байранд нь үлдээнэ;
- ашиглах боломжгүй бараа болон тооллогын зөрүүг Manager/Manager Plus reason-тэй waste/adjustment-аар шийднэ.

Эдгээр movement нь configuration reconciliation бөгөөд guest consumption, minibar sale, revenue эсвэл current/previous stay-ийн charge үүсгэхгүй. Removed/excess stock болон count variance бүр шийдэгдсэн байна; үүний дараа target бүрэн таарсан, эсвэл зөвхөн дутуу target quantity-д хүчинтэй shortage override-аар зөвшөөрөгдсөн үед л Template B current configuration болно.

## 19. Future booking ба check-in blocker

- Future confirmed booking-г pending configuration change үүссэнээр автоматаар cancel эсвэл reprice хийхгүй.
- Minibar configuration-ийг booking үүсэх үед pin хийхгүй; check-in амжилттай болох үеийн effective current configuration-г ашиглана.
- Category-level booking confirmed хэвээр байж болно. Харин pending change-тэй physical room-ийг availability count болон шинэ assignment candidate-оос хасна.
- Тухайн physical room-д өмнө нь assignment хийсэн booking-г автоматаар салгахгүй. Check-in-ээс өмнө change-г `APPLIED`, `CANCELLED` эсвэл `ROLLED_BACK` болгох, эсвэл booking-г өөр eligible room руу шилжүүлэх ёстой.
- Check-in request болон config apply зэрэгцвэл server-side lock/version check ашиглаж, pending room дээр stay нээхгүй.
- `STAY-DEC-009`-ийн initial `actual_check_in_at` backdate нь historical lifecycle/configuration сонгохгүй. Room-ийн exact current version, blocker, product lifecycle болон opening/price snapshot-ийг immutable `check_in_recorded_at` үеийн authoritative state-аар шалгаж/үүсгэнэ; past actual time руу pointer, stock, task эсвэл movement сэргээхгүй. Сонгосон actual агшны historical readiness нь зөвхөн өмнө үүссэн immutable events-ээр нотлогдоно.
- `STAY-DEC-010`-ын approved correction зөвхөн effective actual start-ийг өөрчилнө; room current pointer, blocker, product/template lifecycle, opening/price snapshot, task/stock movement үүсгэх, сэргээх эсвэл retimestamp хийхгүй. Approval existing immutable event-үүдээр historical readiness/overlap-ийг дахин шалгана.
- `STAY-DEC-011`-ийн дагуу confirmed booking эсвэл `ACTIVE` stay-ийн `planned_checkout_at` direct overwrite хоригтой. MVP-д change байхгүй; append-only history/revalidation нь зөвхөн post-MVP change хожим тусдаа батлагдвал мөрдөх invariant.
- Minimal guard хугацаа өөрчлөх button/API/action, taxonomy, permission/approval, eligibility, pricing/repricing, refund/payment эсвэл lifecycle transition нээхгүй. Room/category/product/template lifecycle, current/pending/default/exact-version pointer, blocker, opening/price/config/stock snapshot, Cleaner task болон movement immutable хэвээр.
- `STAY-DEC-012`-оор confirmed/active planned checkout MVP-д бүрэн түгжээтэй: amendment/action, extension, planned-end shorten, hourly ↔ nightly conversion байхгүй. Early/late actual checkout зөвхөн `actual_checkout_at` бүртгэж original planned end-ийг өөрчлөхгүй; early auto reprice/refund, overdue auto fee/penalty үүсэхгүй.
- Room actual checkout хүртэл occupied/blocking хэвээр; дараа нь P0-39A-ийн snapshot buffer + clean + applicable minibar readiness gate үйлчилнэ. C2 room/category/product/template lifecycle, current/pending/default pointer, blocker, configuration/price/opening/stock snapshot, task/movement/apply/rollback/reconciliation-д side effect үүсгэхгүй.

## 20. Cancellation, rollback ба apply

Inventory movement огт post хийгдээгүй бол Manager/Manager Plus pending request-ийг шууд `CANCELLED` болгож болно. Current configuration болон room stock өөрчлөгдөхгүй, blocker арилна.

Ядаж нэг movement post хийгдсэн бол silent cancel хийхгүй:

1. request `ROLLBACK_REQUIRED` болно;
2. server original reconciliation movement бүрээс буцаах шаардлагатай delta-г тооцож, Cleaner-д server-bounded rollback task үүсгэнэ;
3. Cleaner зөвхөн task-ийн хүрээнд usable stock-ийн эсрэг чиглэлийн room ↔ warehouse transfer-ийг батална;
4. waste, missing stock эсвэл тооллогын зөрүүг Manager/Manager Plus reason-тэй шийднэ;
5. original baseline сэргэсэн үед request `ROLLED_BACK` болж blocker арилна.

Posted movement-ийг edit/delete хийхгүй; compensating movement-ээр засна. `APPLIED` болсон configuration-г “cancel” хийхгүй, буцаах шаардлагатай бол шинэ configuration change request үүсгэнэ.

Successful apply хийхэд server:

- removed/excess/variance бүр шийдэгдэж, room-ийн бодит balance target-тай таарсан эсэх, эсвэл зөвхөн target shortage-д хүчинтэй override байгаа эсэх;
- target template entity/product dependency lifecycle `ACTIVE`, target version `PUBLISHED` бөгөөд request-д pinned exact ID мөн эсэх;
- pending request/version болон room дээр check-in зэрэгцээгүй эсэх

ийг дахин шалгана. Дараа нь current configuration-г солих, pending request-ийг `APPLIED` болгох болон completion audit үүсгэхийг атомикаар гүйцэтгэнэ. Өмнө post болсон stock movement тус бүр immutable хэвээр байна.

## 21. Эрх, task boundary ба audit

| Үйлдэл | Hotel Admin | Manager | Manager Plus | Reception | Cleaner |
| --- | ---: | ---: | ---: | ---: | ---: |
| Configuration change үүсгэх/товлох | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — | — |
| Хөдөлгөөн эхлээгүй request цуцлах | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — | — |
| Stock/variance/shortage/rollback шийдэх | Нэмэлт Manager/Manager Plus role | ✓ | ✓ | — | — |
| Assigned reconciliation/rollback task-ийн room ↔ warehouse transfer батлах | Нэмэлт Cleaner role | Нэмэлт Cleaner role | Нэмэлт Cleaner role | — | ✓ |
| Current/pending configuration, state, blocker харах | ✓ | ✓ | ✓ | Read-only | Зөвхөн өөрийн task/room хүрээнд |

Cleaner generic warehouse adjustment, waste, price, target, mode/template болон shortage override өөрчлөхгүй. Task payload-ийг server room/request/target/product/allowed direction/max quantity-аар хязгаарлана; client өөр product эсвэл quantity нэмэхийг хориглоно.

Request, task claim/completion, actual count, movement, blocker, override, variance resolution, cancel, rollback болон apply бүр hotel, room, request ID, old/target config, actor, role, шаардлагатай бол reason, server time болон idempotency key-тэй audit event байна. Cross-hotel ID, duplicate submission болон negative stock-ийг backend хориглоно.

Configuration reconciliation completion нь room-ийн cleaning status-ийг автоматаар `Цэвэр` болгохгүй. Cleaning болон minibar configuration нь тусдаа readiness хэмжээс хэвээр байна.

## 22. P0-37B acceptance criteria

- Room нэг current configuration, хамгийн ихдээ нэг non-terminal pending change-тай байна.
- Active stay current snapshot-аараа дуусаж, safe point хүртэл physical reconciliation эхлэхгүй.
- Pending change үүссэн physical room шинэ check-in/assignment авахгүй.
- Pending change байгаа үед хуучин template-р routine next-stay refill хийхгүй.
- ON → OFF нь usable stock-ийг буцааж, variance/waste-г шийдэж, room balance `0` болсны дараа `Хамаарахгүй` болно.
- OFF → ON болон Template A → B нь server-generated task, бодит count, immutable return/refill movement-тэй байна.
- Configuration reconciliation movement guest consumption, sale, revenue эсвэл stay charge үүсгэхгүй.
- Stock хүрэлцэхгүй үед apply блоклогдох эсвэл батлагдсан shortage override-аар үндсэн `Дутуу` status + тусдаа `Manager зөвшөөрсөн` flag-тай apply хийнэ.
- Future booking автоматаар cancel/reprice болохгүй; minibar config check-in үед effective current configuration-оос тогтоно.
- Movement эхлээгүй request шууд cancel болж, movement эхэлсэн request зөвхөн compensating rollback-аар terminal болно.
- Apply нь final validation, current config switch, pending completion болон audit-ийг атомикаар гүйцэтгэнэ.
- Cleaner зөвхөн assigned reconciliation/rollback task-ийн хүрээнд хоёр чиглэлийн transfer батална; Manager/Manager Plus exception шийднэ.
- Configuration apply нь cleaning status-ийг өөрчлөхгүй.

## 23. P0-37B батлагдсан шийдвэр

### RML-DEC-007 — Current configuration ба нэг pending change

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Room яг нэг current configuration, хамгийн ихдээ нэг non-terminal pending configuration change-тай байна. Pending change нь current config-ийг шууд солихгүй бөгөөд physical room-ийн шинэ check-in/assignment-ийг terminal болтол блоклоно.

### RML-DEC-008 — Active stay safe point

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Active stay үед өөрчлөлтийг товлож болно. Current stay mode/template/opening/price-book snapshot-аараа дуусна; checkout, payment, minibar report болон pending refill task бүр terminal болсны дараа л reconciliation эхэлнэ.

### RML-DEC-009 — ON → OFF reconciliation

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Cleaner assigned task-аар usable room stock-ийг warehouse-д буцааж, Manager/Manager Plus waste/variance-г шийднэ. Room balance `0` болсон үед mode `Ашиглахгүй`, template `null`, minibar status `Хамаарахгүй` болно.

### RML-DEC-010 — OFF → ON ба shortage

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Active target template-ийн product-ийг Cleaner assigned task-аар нөхөж байж ON configuration apply хийнэ. Нөөц хүрэлцэхгүй бол request блоклогдох эсвэл existing controlled shortage override-аар бодит quantity snapshot, үндсэн `Дутуу` status болон тусдаа `Manager зөвшөөрсөн` flag-тай apply хийнэ.

### RML-DEC-011 — Template A → B delta reconciliation

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Cleaner actual count баталсны дараа B target-аас removed/excess product-ийг warehouse-д буцааж, added/short product-ийг нөхнө. Movement нь config reconciliation бөгөөд guest consumption, sale, revenue эсвэл stay charge үүсгэхгүй; removed/excess/variance шийдэгдэж, target бүрдэх эсвэл зөвхөн shortage-д хүчинтэй override үүссэний дараа B current болно.

### RML-DEC-012 — Future booking ба effective config

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Future booking автоматаар cancel/reprice болохгүй, minibar configuration booking үед pin болохгүй. Check-in үеийн effective current config ашиглагдах бөгөөд non-terminal change-тэй physical room check-in/assignment blocker-тэй байна; booking-г өөр eligible room руу шилжүүлж болно.

### RML-DEC-013 — Action permission ба task boundary

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Manager/Manager Plus request/cancel/shortage/variance-г удирдана. Cleaner зөвхөн өөрт оноогдсон server-bounded reconciliation/rollback task-аар room ↔ warehouse transfer батална. Reception current/pending config болон blocker-ийг read-only харна; Hotel Admin operational action-д тусдаа role авна.

### RML-DEC-014 — Cancel, rollback, atomic apply ба audit

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Movement эхлэхээс өмнө шууд cancel хийж болно; эхэлсний дараа posted movement-ийг устгалгүй compensating rollback хийнэ. Final validation амжилттай үед current config switch, pending completion болон audit атомикаар хийгдэнэ. Applied config-г буцаах бол шинэ request үүсгэнэ; cleaning status тусдаа хэвээр байна.

## 24. P0-37C-1 — Template version lifecycle-ийн суурь

Template entity болон template version нь тусдаа түвшин байна:

```text
Template entity: ACTIVE → RETIRING → INACTIVE

Template version: DRAFT → PUBLISHED → ARCHIVED

Room configuration:
  current_template_id + current_version_id
  pending_target_template_id + pending_target_version_id, байвал
```

- **Template entity lifecycle** нь `Standard Minibar` зэрэг template-ийг бүхэлд нь шинэ ажиллагаанд ашиглаж болох эсэхийг удирдана.
- **Template version lifecycle** нь нэг template-ийн бүтээгдэхүүний бүрдэл болон target quantity цаг хугацааны явцад хэрхэн өөрчлөгдөхийг удирдана.
- **Room current + pending configuration** нь тухайн physical room яг аль version дээр байгааг болон аль exact version рүү reconciliation хийхийг удирдана.

Эдгээр нь бие биеэ орлохгүй. Template entity `INACTIVE` бол дотор нь `PUBLISHED` version байсан ч шинэ assignment хийхгүй. Version `DRAFT` бол parent entity `ACTIVE` байсан ч room/check-in-д ашиглахгүй.

### 24.1 Version state

| Version state | Засварлах | Шинэ room/current эсвэл pending target-д ашиглах | Түүх |
| --- | ---: | ---: | --- |
| `DRAFT` | ✓ | — | Publish болоогүй working copy |
| `PUBLISHED` | — | ✓, бусад dependency хүчинтэй үед | Immutable version snapshot |
| `ARCHIVED` | — | — | Terminal historical version; дахин шууд идэвхжүүлэхгүй |

`DRAFT` version-ийн product list болон target quantity-г Manager/Manager Plus засаж болно. Draft нь Default болохгүй, room current/pending target, reconciliation task эсвэл check-in snapshot-д ашиглагдахгүй.

`PUBLISHED` болсны дараа version-ийн product list болон target quantity-г in-place edit хийхгүй. Өөрчлөх шаардлагатай бол тухайн version-оос шинэ Draft үүсгэж, дараагийн version болгон publish хийх урсгал ашиглана. Draft edit болон шинэ publish нь existing room current version, pending target, active stay, price book эсвэл stock balance-ийг автоматаар өөрчлөхгүй.

`ARCHIVED` нь terminal, immutable historical state байна. Archived version-ийг шууд `PUBLISHED` болгохгүй; дахин ашиглах бүтэц хэрэгтэй бол clone/new Draft үүсгэнэ. Archive transition-ийн exact blocker болон permission-ийг §30-д баталсан.

### 24.2 Multiple Published ба Default version

- Gradual migration хийхийн тулд нэг template entity дотор хэд хэдэн `PUBLISHED` version зэрэг оршиж болно.
- Template дор хаяж нэг Published version-тэй болсон бол шинэ configuration-д анх санал болгох яг нэг **Default Published version** байна.
- Анхны version амжилттай publish болоход тэр version яг нэг Default болж атомикаар тогтоно.
- Дараагийн version publish болох нь Default-ийг автоматаар солихгүй; өмнөх Default хэвээр байна. Солих бол тусдаа `Set default` action ашиглана.
- Default нь шинэ room setup эсвэл шинэ configuration request-д аль Published version-ийг initial candidate болгохыг заана. Өөр eligible exact Published version-ийг room-level explicit Rollout-д сонгох validation-ийг §33-т баталсан.
- Default солигдох нь existing room-ийн `current_version_id`, өмнө үүссэн `pending_target_version_id`, active stay эсвэл future booking-г автоматаар өөрчлөхгүй.

### 24.3 Exact room-version binding

- Minibar-enabled room-ийн current configuration нь template entity-гээс гадна exact `current_version_id` хадгална.
- Pending mode/template/version change үүсэх үед тухайн request exact `pending_target_version_id` хадгална; дараа өөр version publish/default болсон ч target автоматаар шилжихгүй.
- Active stay check-in үед room-ийн exact current version, opening quantity болон selling price book snapshot түгжигдэнэ.
- Future booking дээр version pin хийхгүй; P0-37B-ын дагуу check-in үеийн room current version ашиглагдана.
- Room-ийн `current_version_id` зөвхөн P0-37B configuration reconciliation амжилттай apply болсны дараа солигдоно. `Publish` болон `Set default` нь current/pending/stay/booking pointer-ийг шууд mutate хийхгүй, inventory movement, Cleaner task, rollout request эсвэл check-in blocker автоматаар үүсгэхгүй. Room шилжүүлэх бол эдгээрээс тусдаа explicit Rollout эсвэл батлагдсан room configuration change ашиглана.

### 24.4 History ба hard-delete

- Active/historical stay, room config, pending request, reconciliation task, inventory movement, price book, invoice/report/export эсвэл audit reference-тэй version-ийг hard-delete хийхгүй.
- Published/Archived version-ийн immutable product/target snapshot болон version lineage түүхэнд хадгалагдана.
- Огт publish хийгдээгүй, reference/task-гүй Draft-ийг л existing never-used hard-delete дүрмээр устгаж болно.
- Ашиглагдсан эсвэл historical reference-тэй Published version-ийг hard-delete хийхгүй; §30-ын blocker хангагдвал archive хийж immutable түүхийг хадгална.

## 25. P0-37C-1 acceptance criteria

- Template entity lifecycle болон version lifecycle тусдаа хадгалагдана.
- Draft version room/default/check-in/reconciliation target болж чадахгүй.
- Published version-ийн product list болон target quantity in-place edit болохгүй.
- Өөрчлөлт бүр шинэ Draft болон шинэ Published version үүсгэнэ.
- Нэг template-ийн олон Published version зэрэг хадгалагдаж болох бөгөөд Published version байгаа үед яг нэг Default байна.
- Default өөрчлөгдөх нь existing current/pending room, active stay болон booking-г автоматаар өөрчлөхгүй.
- Room current болон pending target exact version ID хадгална.
- Active stay pinned version/snapshot-аараа дуусна; future booking version booking үед pin хийхгүй.
- Archived version terminal/history-only бөгөөд direct reactivation хийхгүй.
- Referenced/used version hard-delete болохгүй; never-published, reference-гүй Draft л existing delete gate-аар устаж болно.
- Publish/default нь existing room current/pending/stay/booking pointer-ийг шууд mutate хийхгүй, stock movement, Cleaner task, rollout request эсвэл check-in blocker автоматаар үүсгэхгүй.

## 26. P0-37C-1 батлагдсан шийдвэр

### RML-DEC-015 — Entity, version болон room configuration тусдаа

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Template entity `ACTIVE → RETIRING → INACTIVE`, template version `DRAFT → PUBLISHED → ARCHIVED`, room configuration `current + хамгийн ихдээ нэг pending` гэсэн гурван тусдаа lifecycle ашиглана. Entity state, version state болон room assignment бие биеэ орлохгүй.

### RML-DEC-016 — Draft, immutable Published ба Archived history

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Draft editable боловч assignment/check-in-д ашиглагдахгүй. Published version-ийн product list/target quantity-г in-place edit хийхгүй; өөрчлөлтийг шинэ Draft/version-оор хийнэ. Archived terminal/history-only бөгөөд direct reactivation хийхгүй. Referenced/used version болон historical snapshot hard-delete болохгүй.

### RML-DEC-017 — Multiple Published, Default ба exact binding

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Gradual migration-д нэг template-ийн олон Published version зэрэг байж болох боловч Published version байгаа үед шинэ configuration-д зориулсан яг нэг Default байна. Room current болон pending target exact version ID хадгална. Draft/publish/default өөрчлөлт existing room/stay/booking-г автоматаар өөрчлөхгүй; future booking version-ийг booking үед pin хийхгүй.

## 27. P0-37C-2A — Publish ба Default activation

`Publish`, `Set default`, room configuration change болон `Rollout` нь тусдаа action байна.

### 27.1 Publish validation

Зөвхөн `DRAFT` version-ийг publish хийнэ. Сервер дараах бүх нөхцөлийг authoritative байдлаар шалгана:

1. parent template entity lifecycle `ACTIVE`;
2. hotel-ийн subscription нь 25,000₮/30,000₮ minibar entitlement-тэй, тухайн мөчид ашиглах эрхтэй;
3. version дор хаяж нэг бүтээгдэхүүний мөртэй;
4. бүтээгдэхүүн бүр тухайн hotel-д харьяалагдсан, lifecycle `ACTIVE`;
5. нэг product нэг version-д давхардаагүй;
6. product бүрийн target quantity эерэг бүхэл тоо.

Аль нэг validation амжилтгүй бол ямар ч хэсэгчилсэн publish хийхгүй, version `DRAFT` хэвээр үлдэж алдаатай мөрийг Manager/Manager Plus-д харуулна. Амжилттай бол product list/target quantity-г immutable snapshot болгон version-ийг `PUBLISHED` болгоно.

### 27.2 Анхны ба дараагийн Default

- Template entity-ийн **анхны** Published version нь publish transaction дотроо автоматаар яг нэг Default болно.
- Хоёр дахь болон дараагийн Published version үүсэхэд одоогийн Default өөрчлөгдөхгүй.
- Manager/Manager Plus өөр eligible exact Published version-ийг тусдаа `Set default` action-аар сонгоно.
- `Set default` нь нэг template entity дотор яг нэг Default invariant-ийг атомикаар хадгалж, old/new version, actor болон server time-тай audit үүсгэнэ.

### 27.3 Existing room болон inventory-д нөлөөлөхгүй

`Publish` болон `Set default` дангаараа:

- existing room-ийн `current_version_id`-г солихгүй;
- өмнө үүссэн `pending_target_version_id`-г солихгүй;
- active stay, future booking эсвэл stay price book-ийг өөрчлөхгүй;
- warehouse/room stock movement үүсгэхгүй;
- Cleaner task, configuration request эсвэл check-in blocker үүсгэхгүй.

Room-уудыг шинэ Published version рүү шилжүүлэх нь тусдаа explicit `Rollout` ажиллагаа байна. Archive transition P0-37C-2B-1-ээр, room-level Rollout-ийн selection/task/blocker trigger P0-37C-2B-2-оор, multi-room partial success, batch cancel/rollback/retry P0-37C-3-аар батлагдсан.

### 27.4 Permission ба package gate

- `Publish` болон `Set default`-ийг зөвхөн minibar entitlement хүчинтэй үед хийнэ: 25,000₮ багцад Manager, 30,000₮ багцад Manager эсвэл Manager Plus.
- 25,000₮ багц Hotel Admin-д Manager Plus role/permission үүсгэж өгөхгүй; 30,000₮-ийн эрхийг role assignment-аар тойрох боломжгүй.
- 20,000₮, төлбөрөөр идэвхжээгүй эсвэл subscription lifecycle-ээр minibar entitlement хаагдсан hotel-д UI/API action нээхгүй.
- Hotel Admin энэ operational permission-ийг автоматаар өвлөхгүй; Manager эсвэл Manager Plus role тусдаа авсан байна.
- Reception болон Cleaner publish/default хийхгүй; өөрийн ажиллагааны хүрээнд exact version-ийг read-only харна.
- Package entitlement нь role permission-оос дээгүүр хатуу gate бөгөөд backend action бүрд хоёуланг шалгана.

48 цагийн батлагдсан grace period-д сүүлд төлсөн багцын entitlement хэвээр үйлчилнэ; grace дууссаны дараа operational action хаагдана. Upgrade төлбөр баталгаажсаны дараа шинэ багцын entitlement subscription lifecycle-ийн батлагдсан дүрмээр нээгдэнэ.

## 28. P0-37C-2A acceptance criteria

- Validation бүрэн амжилттай болоогүй Draft publish болохгүй.
- Published version дор хаяж нэг unique, same-hotel, `ACTIVE` product-тэй бөгөөд target бүр эерэг бүхэл тоо байна.
- Анхны Published version автоматаар Default болно.
- Дараагийн Published version одоогийн Default-ийг автоматаар солихгүй.
- `Set default` нэг template-д яг нэг Default invariant-ийг атомикаар хадгална.
- Publish/Set default нь existing room/pending/stay/booking pointer, stock, Cleaner task болон check-in blocker-ийг өөрчлөхгүй.
- 20,000₮ эсвэл minibar entitlement-гүй hotel role байсан ч Publish/Set default хийхгүй; 25,000₮ багцад Manager Plus role үүсгэж gate тойрохгүй.
- Hotel Admin 25,000₮-д Manager, 30,000₮-д Manager эсвэл Manager Plus role тусдаа авсан үед уг action-ийг хийнэ.
- Transition болон Default change бүр actor, role, hotel, template/version, old/new state болон server time-тэй audit-тай байна.

## 29. P0-37C-2A батлагдсан шийдвэр

### RML-DEC-018 — Publish validation

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Зөвхөн `ACTIVE` parent template-ийн Draft, дор хаяж нэг same-hotel lifecycle `ACTIVE` product-тэй, duplicate product-гүй, product бүрийн target quantity эерэг бүхэл үед атомикаар Published болно. Validation бүтэлгүй бол Draft хэвээр үлдэнэ.

### RML-DEC-019 — Анхны ба дараагийн Default

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Анхны Published version автоматаар тухайн template-ийн яг нэг Default болно. Дараагийн publish одоогийн Default-ийг солихгүй; өөрчлөх бол Manager/Manager Plus тусдаа `Set default` action ашиглана.

### RML-DEC-020 — Publish/Default isolation, entitlement ба Rollout separation

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Publish/Set default existing room current/pending, stay, booking, stock болон price snapshot-ийг өөрчлөхгүй, Cleaner task/configuration request/check-in blocker автоматаар үүсгэхгүй. Action нь хүчинтэй entitlement + тухайн багцад зөвшөөрөгдсөн role permission-ийн огтлолцлоор зөвшөөрөгдөнө: 25,000₮-д Manager, 30,000₮-д Manager/Manager Plus; Hotel Admin operational role-ийг автоматаар өвлөхгүй. Room шилжүүлэх Rollout тусдаа ажиллагаа байна.

## 30. P0-37C-2B-1 — Version Archive

Archive нь ашиглалтаас гарсан Published version-ийг immutable historical state-д оруулах тусдаа action байна. Энэ нь room migration эсвэл stock reconciliation хийх shortcut биш.

### 30.1 Archive blocker

Зөвхөн `PUBLISHED` version-д Archive хүсэлт гаргана. Сервер transition хийхийн өмнө дараах нөхцөлийг шалгана:

1. version тухайн template-ийн Default биш;
2. ямар ч room-ийн exact `current_version_id` биш;
3. ямар ч room-ийн exact `pending_target_version_id` биш;
4. active stay уг exact version-ийг snapshot/reference болгож ашиглаагүй;
5. non-terminal configuration request, reconciliation/rollback эсвэл Cleaner task уг exact version-ийг ашиглаагүй.

Default version-ийг archive хийх бол Manager/Manager Plus эхлээд өөр eligible Published version-ийг `Set default` хийнэ. Өөр Published version байхгүй бол Default хэвээр тул archive хийхгүй.

Future booking version pin хийдэггүй учраас booking дангаараа Archive blocker болохгүй. Гэхдээ room current/pending reference байгаа бол дээрх room blocker хэвээр үйлчилнэ.

### 30.2 Historical reference ба side-effect isolation

- Terminal historical stay, report, price book, invoice/export, inventory movement болон audit reference нь Archive-г хориглохгүй.
- Эдгээр historical record exact version ID болон immutable product/target snapshot-оо хадгална; archive хийснээр reprice, recalculate эсвэл delete болохгүй.
- Archive дангаараа room current/pending pointer, active/historical stay, booking, price book болон stock balance-ийг өөрчлөхгүй.
- Archive нь warehouse/room stock movement, Cleaner task, configuration request, Rollout эсвэл check-in blocker үүсгэхгүй.

### 30.3 Transition, terminal behavior ба audit

Final blocker check амжилттай үед сервер `PUBLISHED → ARCHIVED` transition болон audit-ийг нэг атомик ажиллагаагаар хийнэ. Шалгалттай зэрэг room/pending/task reference үүсэхээс lock/version check-ээр хамгаална.

`ARCHIVED` version:

- шинэ room current/pending target, Default, check-in эсвэл reconciliation target болохгүй;
- in-place edit болон direct `PUBLISHED` reactivation хийхгүй;
- дахин ашиглах шаардлагатай бол immutable version-оос шинэ `DRAFT` clone үүсгэнэ;
- historical query/export-д exact version ID-тайгаа хадгалагдана.

Archive audit нь hotel, template/version ID, өмнөх/шинэ state, actor, role, reason болон server time-ийг хадгална.

### 30.4 Permission ба package gate

- 25,000₮ багцад Manager, 30,000₮ багцад Manager эсвэл Manager Plus Archive хийнэ.
- Hotel Admin тухайн багцад зөвшөөрөгдсөн operational role-ийг тусдаа авсан байна.
- 20,000₮, төлбөрөөр идэвхжээгүй эсвэл entitlement хаагдсан hotel-д Archive UI/API нээхгүй.
- 25,000₮ багцад Manager Plus role үүсгэж gate тойрохгүй.
- Reception болон Cleaner Archive хийхгүй; historical/task хүрээнд state-ийг read-only харна.

## 31. P0-37C-2B-1 acceptance criteria

- Default, current room, pending target, active stay эсвэл non-terminal task reference-тэй version archive болохгүй.
- Default version-ийг archive хийхийн өмнө өөр eligible Published version Default болсон байна.
- Future booking дангаараа blocker болохгүй, учир нь version booking үед pin хийхгүй.
- Зөвхөн historical reference-тэй Published version archive болж болох бөгөөд түүх өөрчлөгдөхгүй.
- Archive stock movement, Cleaner task, configuration request, Rollout эсвэл check-in blocker үүсгэхгүй.
- Archived version terminal/history-only; direct Published reactivation хийхгүй, шаардлагатай бол шинэ Draft clone үүсгэнэ.
- Archive transition blocker recheck болон state/audit бичилт атомик байна.
- Archive-д 25,000₮-ийн Manager, 30,000₮-ийн Manager/Manager Plus зөвшөөрөгдөж, Hotel Admin-д тохирох role тусдаа шаардлагатай.

## 32. P0-37C-2B-1 батлагдсан шийдвэр

### RML-DEC-021 — Version Archive blocker, history ба permission

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Default, room current/pending, active stay эсвэл non-terminal reconciliation/Cleaner/configuration task reference-тэй Published version-ийг archive хийхгүй. Historical stay/report/price book/inventory/audit reference blocker болохгүй бөгөөд immutable түүхээ хадгална. Archive side effect-ээр pointer, price, stock, task/request эсвэл check-in blocker өөрчлөхгүй. Archived terminal бөгөөд дахин ашиглах бол шинэ Draft clone үүсгэнэ. Action нь хүчинтэй entitlement + 25,000₮-ийн Manager эсвэл 30,000₮-ийн Manager/Manager Plus permission шаарддаг; Hotel Admin-д тохирох role тусдаа байна.

## 33. P0-37C-2B-2 — Room-level explicit Rollout

Explicit `Rollout` нь minibar ашиглаж байгаа нэг room-ийг тухайн template entity-ийн өөр exact Published version рүү шилжүүлэх хүсэлтийг эхлүүлэх тусдаа action байна. Энэ нь `Publish`, `Set default`, `Archive`, minibar mode ON/OFF өөрчлөх эсвэл өөр template entity рүү шилжүүлэх action биш. Mode болон template entity солиход §§14–23-ын existing configuration-change урсгалыг ашиглана.

### 33.1 Target version ба eligible room

Manager Rollout хийхдээ exact target version сонгоно. Сервер Confirm хийх мөчид дараах бүх нөхцөлийг authoritative байдлаар шалгана:

1. target version тухайн hotel-д харьяалагдсан exact `PUBLISHED` version;
2. target version-ийн parent template entity room-ийн current template-тэй ижил бөгөөд lifecycle `ACTIVE`;
3. target version-ийн бүх product тухайн hotel-д харьяалагдсан, lifecycle `ACTIVE`;
4. room entity lifecycle `ACTIVE`, minibar mode `Ашиглана`;
5. room-ийн current exact version target-аас өөр бөгөөд ижил template entity-д харьяалагдсан;
6. room-д өөр non-terminal pending configuration change байхгүй.

Target нь Default байх албагүй; дээрх gate-ийг хангасан exact Published version байж болно. Current version-тэй ижил target сонгох нь no-op тул UI-д disabled харагдаж, API мөн хориглоно. Cross-hotel ID, `DRAFT/ARCHIVED` version, өөр template, minibar OFF эсвэл `RETIRING/INACTIVE` room/template/product-ийг client ID-аар илгээсэн ч backend зөвшөөрөхгүй.

Active stay байгаа room сонгогдож болно, гэхдээ current stay-ийн snapshot-ийг өөрчлөхгүйгээр `SCHEDULED_AFTER_STAY` төлөвт товлогдоно. Future booking автоматаар cancel/reprice болохгүй; pending blocker terminal болохоос өмнө тухайн physical room-д шинэ check-in/assignment хийхгүй.

### 33.2 Confirm, pending request, blocker ба Cleaner task

Final eligibility recheck амжилттай үед Confirm нь нэг атомик ажиллагаагаар:

- room-level configuration request үүсгэж exact `pending_target_template_id` болон `pending_target_version_id`-г pin хийх;
- тухайн physical room-ийн `Configuration change pending` check-in/assignment blocker-ийг шууд хүчинтэй болгох;
- request-ийн эхний төлөв болон audit event-ийг бичих

ажиллагааг гүйцэтгэнэ. Pending үүсэх болон blocker хүчинтэй болохын хооронд room check-in авах завсар үүсгэхгүй. Нэг room-д аль хэдийн non-terminal pending байвал шинэ Rollout request бүхэлдээ reject болно.

- Active stay байхгүй, checkout/payment/minibar report/refill-ийн safe-point dependency бүр terminal бол request `READY_FOR_RECONCILIATION` болж, server exact target version-д зориулсан Cleaner reconciliation task-ийг шууд үүсгэнэ.
- Active stay байгаа эсвэл checkout, эцсийн payment, required minibar report, pending refill task-ийн аль нэг terminal болоогүй бол request `SCHEDULED_AFTER_STAY` байна. Энэ үед Cleaner reconciliation task үүсгэхгүй.
- §15-ын safe point бүрэн хангагдахад server request-ийг `READY_FOR_RECONCILIATION` болгож, exact pinned target version бүхий Cleaner task-ийг нэг удаа үүсгэнэ.

Task үүсгэх нь idempotent байна. Давхар event/callback нэг request-д хоёр Cleaner task үүсгэхгүй.

### 33.3 Reconciliation, isolation ба atomic apply

Rollout Confirm дангаараа:

- `current_version_id`-г солихгүй;
- active stay, future booking эсвэл price book-ийг өөрчлөх/reprice хийхгүй;
- warehouse/room stock movement үүсгэхгүй;
- room-ийн cleaning status-ийг өөрчлөхгүй.

Cleaner assigned task-аар actual room quantity-г баталсны дараа §§18, 20–21-ийн existing reconciliation boundary үйлчилнэ: target-аас removed/excess stock warehouse-д буцаж, added/short stock warehouse-аас room-д нөхөгдөнө; variance, shortage, cancel болон rollback нь P0-37B-ын батлагдсан дүрмээр шийдэгдэнэ. Эдгээр movement нь guest consumption, sale, revenue эсвэл stay charge биш.

Final apply хийхэд target exact version одоо ч `PUBLISHED`, template/product dependency `ACTIVE`, room дээр шинэ stay үүсээгүй, variance шийдэгдсэн, target balance бүрдсэн эсвэл хүчинтэй shortage override байгаа эсэхийг дахин шалгана. Амжилттай үед current version switch, pending request `APPLIED` болох болон completion audit нэг атомик ажиллагаагаар хийгдэнэ. Өмнөх current version болон posted movement түүхэнд хадгалагдана.

Request-д pinned target exact ID нь дараагийн `Publish` эсвэл `Set default`-оор өөрчлөгдөхгүй. Pending target reference байгаа хугацаанд RML-DEC-021-ийн дагуу уг target version Archive болохгүй.

### 33.4 Permission ба multi-room boundary

- 25,000₮ багцад Manager, 30,000₮ багцад Manager эсвэл Manager Plus Rollout Confirm хийнэ.
- Hotel Admin тухайн багцад зөвшөөрөгдсөн operational role-ийг тусдаа авсан байна.
- 20,000₮, төлбөрөөр идэвхжээгүй эсвэл entitlement хаагдсан hotel-д Rollout UI/API нээхгүй; 25,000₮ багцад Manager Plus role үүсгэж gate тойрохгүй.
- Reception current/pending version, request state болон blocker-ийг read-only харна. Cleaner зөвхөн өөрт оноогдсон server-bounded reconciliation/rollback task-ийг гүйцэтгэнэ.
- Энэ шийдвэрийн atomic business unit нь нэг room-ийн нэг pending request байна. Олон room сонгосон үеийн batch parent, partial success/failure, batch cancel/rollback болон retry semantics-ийг §§36–38-д баталсан.

## 34. P0-37C-2B-2 acceptance criteria

- Rollout зөвхөн нэг hotel, нэг `ACTIVE` template entity доторх exact eligible `PUBLISHED` target version рүү хийгдэнэ.
- Eligible room `ACTIVE`, minibar ON, өөр current version-тэй, non-terminal pending request-гүй байна.
- Current version-тэй ижил, cross-hotel, өөр template, Draft/Archived эсвэл inactive dependency-тэй target reject болно.
- Active stay байгаа room Rollout-д сонгогдож болох боловч `SCHEDULED_AFTER_STAY` байна; current stay snapshot өөрчлөгдөхгүй.
- Confirm амжилттай болоход exact pending target болон check-in/assignment blocker завсаргүйгээр шууд үүснэ.
- Safe-point dependency бүр terminal бол Cleaner task шууд үүснэ; үгүй бол safe point хүртэл task үүсэхгүй.
- Confirm нь current version, active stay/booking/price book, stock болон cleaning status-ийг өөрчлөхгүй.
- Cleaner reconciliation болон final validation амжилттай үед current version switch, pending completion болон audit атомикаар хийгдэнэ.
- Default/Publish өөрчлөлт pinned target-ийг солихгүй; pending reference target version-ийн Archive-ийг хориглоно.
- Rollout action-д 25,000₮-ийн Manager, 30,000₮-ийн Manager/Manager Plus зөвшөөрөгдөж, Hotel Admin-д тохирох role тусдаа шаардлагатай.
- Per-room cancel/rollback P0-37B-ын дүрмийг ашиглана; multi-room partial/batch semantics-ийг P0-37C-3-аар баталсан.

## 35. P0-37C-2B-2 батлагдсан шийдвэр

### RML-DEC-022 — Rollout target ба eligible room

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Room-level Rollout нь `ACTIVE`, minibar ON, non-terminal pending-гүй room-ийг ижил hotel болон ижил `ACTIVE` template entity-ийн өөр exact `PUBLISHED` version рүү шилжүүлэх хүсэлт байна. Target product dependency бүр `ACTIVE` байна. Current version-тэй ижил, cross-hotel, өөр template, Draft/Archived эсвэл inactive dependency-тэй target хориглогдоно. Active stay байгаа room-ийг сонгож болох боловч safe point хүртэл scheduled байна; mode/template entity солих нь Rollout биш, existing configuration-change урсгал байна.

### RML-DEC-023 — Pending, blocker ба safe-point task trigger

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Confirm eligibility-г дахин шалгаад exact target-тай room-level pending request болон шинэ check-in/assignment blocker-ийг атомикаар шууд үүсгэнэ. Safe point бүрэн хангагдсан бол request `READY_FOR_RECONCILIATION` болж Cleaner task шууд үүснэ; active stay эсвэл checkout/payment/report/refill dependency дуусаагүй бол `SCHEDULED_AFTER_STAY` байж, бүх dependency terminal болсны дараа task нэг удаа үүснэ.

### RML-DEC-024 — Rollout isolation, apply, permission ба batch boundary

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Rollout Confirm дангаараа current version, stay/booking/price book, stock эсвэл cleaning status-ийг өөрчлөхгүй. Existing P0-37B Cleaner reconciliation ба final validation амжилттай үед current version switch, pending completion болон audit атомикаар хийгдэнэ. Target exact ID pinned бөгөөд Publish/Default өөрчлөлтөөр солигдохгүй, pending байхдаа Archive-г блоклоно. Action нь хүчинтэй entitlement + 25,000₮-ийн Manager эсвэл 30,000₮-ийн Manager/Manager Plus permission шаарддаг; Hotel Admin-д тохирох role тусдаа байна. Нэг room-ийн request энэ шийдвэрээр, multi-room partial/batch ажиллагаа RML-DEC-025–028-аар хаагдсан.

## 36. P0-37C-3 — Multi-room Rollout batch consistency

Multi-room Rollout нь нэг hotel, нэг `ACTIVE` template entity болон нэг exact eligible `PUBLISHED` target version-ийг олон room-д хэрэгжүүлэх урт хугацааны grouping action байна. **Batch parent** нь сонголт, target, progress болон audit-ийг нэгтгэнэ; **room child request** бүр §§33–35-ын room-level lifecycle, blocker, Cleaner task, stock reconciliation болон terminal outcome-аа тусдаа хадгална. Batch parent нь child request-ийг орлохгүй, inventory ledger эсвэл бүх room-ийг хамарсан нэг global stock transaction болохгүй.

### 36.1 Read-only preview ба batch input

Manager batch эхлүүлэхдээ:

1. нэг hotel болон нэг template entity-ийн exact `PUBLISHED` target version;
2. тухайн hotel/template-ийн хоёр буюу түүнээс олон physical room

сонгоно. Preview хийхэд сервер target болон room бүрийг P0-37C-2B-2-ын eligibility gate-аар шалгаж:

- `READY_NOW` — `Одоо хийх боломжтой`;
- `SCHEDULE_AFTER_STAY` — `Stay дууссаны дараа`;
- `INELIGIBLE` — `Сонгох боломжгүй`, machine-readable code болон хэрэглэгчид ойлгогдох шалтгаантай

гэж ангилна. Current target-тай ижил, өөр pending request-тэй, cross-hotel/template, minibar OFF, `DRAFT/ARCHIVED` target эсвэл inactive dependency зэрэг шалтгааныг room бүрээр харуулна.

Preview нь authoritative reservation биш бөгөөд:

- batch/child pending configuration request;
- check-in/assignment blocker;
- Cleaner task;
- stock movement, current version, booking/stay/price book эсвэл cleaning status өөрчлөлт;
- Archive blocker

үүсгэхгүй. Preview гарснаас хойш room state өөрчлөгдөж болох тул Confirm бүх target/room-ийг дахин шалгана.

### 36.2 Confirm, partial success ба room child

Confirm нь request-level idempotency key-тэй байна. Сервер exact target болон сонгосон room бүрийг final байдлаар дахин шалгаж, нэг batch parent дотор immutable selection/result мөр хадгална.

Room бүр тусдаа atomic business unit байна:

- final validation амжилттай room-д exact target-тай child pending configuration request болон check-in/assignment blocker нэг атомик ажиллагаагаар шууд үүснэ;
- safe-point dependency бүр terminal бол child `READY_FOR_RECONCILIATION`, бусад eligible active-stay/unfinished room `SCHEDULED_AFTER_STAY` эхний төлөвтэй байна;
- validation бүтэлгүй room `SKIPPED` result, reason code/detail-тай хадгалагдаж, child pending request, blocker эсвэл Cleaner task үүсгэхгүй.

Batch нь **partial success** ашиглана. Нэг room reject, stock/variance blocker эсвэл task failure болсон нь бусад accepted child-ийг зогсоох, cancel хийх эсвэл rollback хийх шалтгаан болохгүй. Global all-or-nothing rollback байхгүй; accepted child бүр P0-37B/C-2B-2 урсгалаар бие даан үргэлжилнэ.

Confirm өөрөө batch түвшинд stock, current version, selling price, stay/booking/price book, revenue/charge эсвэл cleaning status өөрчлөхгүй. Давхар Confirm ижил idempotency key-ээр шинэ batch/child үүсгэхгүй; batch + room unique guard болон room-ийн one-non-terminal-pending invariant зэрэгцээ хүсэлтийг хамгаална.

### 36.3 Progress summary ба derived batch state

Batch dashboard дор хаяж дараах тоололтыг харуулна:

- нийт сонгосон;
- accepted;
- `READY_FOR_RECONCILIATION`;
- `SCHEDULED_AFTER_STAY`;
- `IN_PROGRESS`;
- `BLOCKED_STOCK`;
- `BLOCKED_VARIANCE`;
- `APPLIED`;
- `SKIPPED`;
- `CANCELLED`;
- `ROLLBACK_REQUIRED`;
- `ROLLED_BACK`.

Batch state нь child/result-ээс derive хийгдэнэ; хэрэглэгч гараар overwrite хийхгүй:

| Batch state | Нөхцөл |
| --- | --- |
| `IN_PROGRESS` | Дор хаяж нэг accepted child non-terminal |
| `COMPLETED` | Сонгосон room бүр accepted болж, accepted child бүр `APPLIED` |
| `CANCELLED` | Дор хаяж нэг child accepted болсон бөгөөд accepted child бүр movement эхлэхээс өмнө `CANCELLED` |
| `FAILED_VALIDATION` | Confirm үед нэг ч room accepted болоогүй |
| `PARTIALLY_COMPLETED` | Accepted child бүр terminal боловч дээрх `COMPLETED`, `CANCELLED`, `FAILED_VALIDATION` нөхцөлд орохгүй; `SKIPPED`, `CANCELLED`, `ROLLED_BACK` эсвэл бусад non-APPLIED outcome холилдсон |

State-ийг хүснэгтийн нөхцөлийн дарааллаар бус, дээрх нөхцөлүүдийг харилцан үл давхцах байдлаар derive хийнэ. `IN_PROGRESS` нь terminal биш. Бусад дөрвөн batch state terminal бөгөөд historical parent/child/result record-ийг edit/delete хийхгүй.

### 36.4 `Cancel remaining`, rollback ба applied room

Batch action-ийг `Бүгдийг буцаах` бус **`Үлдсэн ажлуудыг цуцлах` (`Cancel remaining`)** гэж нэрлэнэ. Энэ action хийх мөчид accepted child бүрийг дахин шалгаж:

- movement эхлээгүй `SCHEDULED_AFTER_STAY`/`READY_FOR_RECONCILIATION` child-ийг `CANCELLED` болгож room blocker-ийг арилгана;
- ядаж нэг movement post болсон non-terminal child-ийг `ROLLBACK_REQUIRED` болгож, P0-37B-ын immutable compensating rollback урсгалаар шийднэ; `ROLLED_BACK` болтол blocker хэвээр байна;
- аль хэдийн `APPLIED` child-ийг өөрчлөхгүй, movement-ийг edit/delete хийхгүй.

Нэг child-ийн rollback бусад child-д rollback trigger болохгүй. `APPLIED` room-ийг өмнөх version рүү буцаах шаардлагатай бол өмнөх exact eligible Published version-ийг target болгосон **шинэ Rollout** үүсгэнэ.

### 36.5 Retry, target/archive, permission ба audit

`SKIPPED` эсвэл terminal non-APPLIED outcome-той room-ийг дахин оролдохдоо source batch/result-ийг засах эсвэл terminal batch-ийг reopen хийхгүй. Non-terminal child-ийг эхлээд existing урсгалаар resolve/cancel/rollback хийж terminal болгоно. Дараа нь сонгосон room-уудаар шинэ batch үүсгэж `retry_of_batch_id` холбоос хадгална. Шинэ batch exact target болон room eligibility-г Preview/Confirm дээр дахин шалгана; target тухайн үед eligible Published биш болсон бол retry батлагдахгүй.

Batch parent болон accepted child exact target version ID хадгална. Дараагийн `Publish` эсвэл `Set default` target-ийг солихгүй.

- Preview дангаараа target version-ийн Archive blocker биш.
- Confirm амжилттай болж accepted non-terminal child үүссэнээс бүх accepted child terminal болох хүртэл exact target Archive болохгүй.
- `FAILED_VALIDATION` буюу accepted child-гүй batch Archive blocker болохгүй.
- Terminal batch/child нь immutable historical reference болон хадгалагдах боловч RML-DEC-021-ийн дагуу өөр active blocker байхгүй бол Archive-г хориглохгүй.

Batch Preview/Confirm/`Cancel remaining`/Retry action бүр хүчинтэй entitlement болон permission-ийн огтлолцол шаардана:

- 25,000₮ багцад Manager;
- 30,000₮ багцад Manager эсвэл Manager Plus;
- Hotel Admin тухайн багцад зөвшөөрөгдсөн operational role-ийг тусдаа авсан байна;
- 20,000₮, entitlement хаагдсан hotel болон 25,000₮-ийн Manager Plus role-оор gate тойрохыг UI/API аль алинд хориглоно.

Cleaner зөвхөн өөрт оноогдсон room child reconciliation/rollback task-ийг гүйцэтгэнэ. Reception batch action хийхгүй; өөрийн operational хүрээнд room-ийн current/pending state болон blocker-ийг read-only харна.

Batch audit нь batch ID, exact target, selected room snapshot, preview/confirm time, room бүрийн eligibility/result/reason, child request ID, state transition, cancel/retry link, actor, role, hotel, server time болон idempotency key-г хадгална. Cross-hotel ID, duplicate child, second non-terminal pending болон unauthorized action-ийг backend хориглоно.

## 37. P0-37C-3 acceptance criteria

- Нэг batch parent нэг hotel/template болон нэг exact eligible Published target version-тэй байна.
- Preview room бүрийг ready/scheduled/ineligible гэж reason-тэй ангилах боловч ямар ч pending, blocker, task, stock эсвэл Archive blocker үүсгэхгүй.
- Confirm target/room бүрийг дахин шалгаж, room бүрээр atomic accepted child эсвэл `SKIPPED` result үүсгэнэ.
- Partial success ашиглах бөгөөд нэг room-ийн failure бусад accepted child-ийг stop/cancel/rollback хийхгүй.
- Accepted child бүр exact target, pending state, blocker, Cleaner reconciliation болон terminal outcome-аа тусдаа хадгална.
- Batch parent stock, price, stay/booking, revenue/charge, current version эсвэл cleaning status-ийг өөрчлөхгүй.
- Batch progress accepted/scheduled/blocked/applied/skipped/cancelled/rollback тоололтыг харуулна.
- Batch state child/result-ээс derive хийгдэж, terminal batch/history overwrite/delete болохгүй.
- `Cancel remaining` movement-гүй child-ийг cancel/unblock хийж, movement-тэй child-ийг compensating rollback-д оруулан, Applied child-ийг өөрчлөхгүй.
- Applied room-ийг буцаахдаа өмнөх exact version рүү шинэ Rollout үүсгэнэ.
- Retry source history-г өөрчлөхгүй, `retry_of_batch_id`-тай шинэ batch үүсгэж eligibility-г дахин шалгана.
- Default/Publish exact target-ийг солихгүй; preview/zero-accepted batch Archive blocker биш, accepted non-terminal child target Archive-ийг хориглоно.
- Duplicate Confirm шинэ batch/child үүсгэхгүй; room-ийн one-pending invariant болон cross-hotel guard үйлчилнэ.
- Preview/Confirm/Cancel/Retry-д 25,000₮-ийн Manager, 30,000₮-ийн Manager/Manager Plus зөвшөөрөгдөж, Hotel Admin-д тохирох role тусдаа шаардлагатай.

## 38. P0-37C-3 батлагдсан шийдвэр

### RML-DEC-025 — Batch parent, exact target ба read-only preview

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Multi-room Rollout нэг hotel/template-ийн нэг exact eligible Published target болон олон selected room-той batch parent ашиглана; room бүр тусдаа child/result байна. Preview room бүрийг ready/scheduled/ineligible гэж reason-тэй ангилах боловч pending request, blocker, Cleaner task, stock/current pointer/price/stay/booking/cleaning өөрчлөлт эсвэл Archive blocker үүсгэхгүй. Confirm бүх eligibility-г дахин шалгана.

### RML-DEC-026 — Partial success, independent child ба derived progress

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Confirm room бүрээр final validation хийж, eligible room-д exact target-тай pending request + immediate blocker-ийг атомикаар, ineligible room-д `SKIPPED` result/no blocker үүсгэнэ. Нэг child-ийн failure бусдыг stop/cancel/rollback хийхгүй. Batch progress child/result-ээс derive хийгдэж `IN_PROGRESS`, `COMPLETED`, `PARTIALLY_COMPLETED`, `CANCELLED` эсвэл `FAILED_VALIDATION` байна; batch parent өөрөө inventory/financial side effect үүсгэхгүй.

### RML-DEC-027 — Cancel remaining, rollback ба linked retry

- **Төлөв:** Батлагдсан
- **Шийдвэр:** `Cancel remaining` movement-гүй child-ийг cancel/unblock, movement эхэлснийг existing compensating rollback-д оруулж, Applied child-ийг өөрчлөхгүй. Applied room-ийг буцаах бол өмнөх exact version рүү шинэ Rollout үүсгэнэ. Retry хуучин batch/child/history-г засахгүй, eligibility-г дахин шалгах `retry_of_batch_id` холбоостой шинэ batch байна.

### RML-DEC-028 — Target/Archive, concurrency, permission ба audit

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Batch/child exact target pinned бөгөөд Publish/Default өөрчлөлтөөр солигдохгүй. Preview болон zero-accepted batch Archive blocker биш; accepted non-terminal child байх хугацаанд target Archive болохгүй, terminal түүх хадгалагдана. Confirm idempotent, room child atomic, one-pending/cross-hotel guard-тай. Preview/Confirm/Cancel/Retry нь хүчинтэй entitlement + 25,000₮-ийн Manager эсвэл 30,000₮-ийн Manager/Manager Plus permission шаарддаг; Hotel Admin-д тохирох role тусдаа байна. Cleaner assigned child task, Reception read-only boundary болон parent/child/result/retry audit хадгалагдана.

## 39. P0-37 хаагдсан төлөв

P0-37A/B/C бүх хэсэг RML-DEC-001–028-аар хаагдсан. Room/Minibar lifecycle-ийн кодын өмнөх нээлттэй бизнесийн асуудал үлдээгүй. P0-38A–C нь `STAY-DEC-005`–`007`, P0-39A–D болон fractional hourly precision нь `STAY-DEC-008`–`014`-өөр батлагдсан. Planned checkout MVP-д change-гүй бөгөөд бүх lifecycle/config/stock/task/snapshot side effect хоригтой. Overdue conflict-ийн canonical remedy `STAY-DEC-013`; early-morning cutoff түр хойшлогдсон.
