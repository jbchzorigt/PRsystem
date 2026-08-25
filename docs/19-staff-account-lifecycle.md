# Hotel staff account lifecycle

**Хувилбар:** 0.4  
**Төлөв:** MVP staff invitation, activation, password reset, role change, suspension/session revoke, open-work takeover/reassignment болон Primary Hotel Admin-ийн дүрэм батлагдсан; staff lifecycle-ийн P0 шийдвэрүүд хаагдсан  
**Хамаарах үе шат:** MVP — Hotel/Restaurant staff identity and access

## 1. Хамрах хүрээ

Энэ баримт нь Hotel Admin, Manager, Manager Plus, Reception, Cleaner болон Restaurant Manager account/membership-ийн lifecycle-ийг тодорхойлно.

Operation/Platform болон Police account-ийн provisioning/authentication нь тусдаа хамгаалалтын realm/журамтай байна. Зочны booking account мөн staff lifecycle-д хамаарахгүй.

## 2. Account ба membership-ийн ялгаа

- **User account:** Нэг хүний баталгаажсан email, password, global account status болон session.
- **Hotel membership:** Тухайн account ямар `hotel_id`-д, ямар role-уудтай, идэвхтэй/түдгэлзсэн/ажлаас гарсан эсэх.
- **Restaurant membership:** Тухайн account ямар `restaurant_id`-д Restaurant Manager эрхтэй эсэх.

Нэг email нэг user account-тай байна. Нэг account хэд хэдэн hotel membership болон нэг hotel дотор хэд хэдэн role-той байж болно. Нэг hotel-ийн membership түдгэлзсэн нь өөр hotel-ийн идэвхтэй membership-ийг автоматаар хаахгүй.

## 3. Хэн invitation үүсгэх вэ?

### Hotel Admin

- Өөрийн hotel-д Manager, Manager Plus, Reception болон Cleaner invitation үүсгэнэ.
- Package-д байхгүй role-ийг урихгүй: Cleaner зөвхөн 25,000/30,000₮; Manager Plus зөвхөн 30,000₮.
- Scheduled upgrade effective болохоос өмнө шинэ package-ийн role invitation үүсгэхгүй.
- Өөр hotel, Operation эсвэл Police role олгохгүй.
- MVP-д өөр Primary Hotel Admin invitation үүсгэхгүй.

### Manager Plus

- 30,000₮ package-д өөрийн hotel-тэй холбоотой, өөрийн бүртгэсэн Restaurant-д Restaurant Manager invitation үүсгэнэ.
- Ерөнхий hotel staff role олгохгүй.
- Restaurant Manager-ийг зөвхөн тухайн `restaurant_id` scope-д холбоно.

## 4. Invitation урсгал

1. Эрх бүхий inviter staff-ийн нэр, email болон role/restaurant scope сонгоно.
2. Систем email format, existing account/membership, package болон inviter permission-ийг server талд шалгана.
3. Давхар active/pending membership байвал шинэ давхардсан invitation үүсгэхгүй.
4. Хугацаатай, нэг удаагийн invitation token үүсгэж staff-ийн email рүү илгээнэ.
5. Membership `Урилга хүлээж байгаа` төлөвтэй хадгалагдах боловч operational permission өгөхгүй.
6. Invitation resend хийвэл өмнөх ашиглагдаагүй token хүчингүй болно.
7. Invitation хугацаа дууссан бол access үүсэхгүй; inviter шинэ link илгээнэ.

Hotel Admin/Manager Plus staff-ийн бэлэн/түр password зохиох, харах, email/SMS-ээр дамжуулахгүй. Invitation token-ийг эх утгаар нь database/log/audit-д хадгалахгүй.

Invitation token lifecycle нь membership-ээс тусдаа байна:

```text
ACTIVE → ACCEPTED
ACTIVE → SUPERSEDED | EXPIRED | REVOKED
```

- Нэг `hotel_id/restaurant_id + normalized_email/account` scope-д нэг canonical membership row байна; `PENDING`, `ACTIVE`, `SUSPENDED` эсвэл `TERMINATED` түүхтэй ижил membership-ийг давхар үүсгэхгүй. Rehire нь §8-ын reactivation ашиглана.
- Нэг membership-д хамгийн ихдээ нэг `ACTIVE` invitation token байна; database unique constraint энэ invariant-ийг хамгаална.
- Invitation create, resend болон revoke нь membership row/revision-ийг түгжиж current membership, actor permission, package entitlement болон active token-ийг commit дээр дахин шалгана.
- Create давтан ирвэл idempotency key-ээр existing pending membership/active invitation-ийг буцаана. Resend нь хуучин `ACTIVE` token-ийг нэг transaction-д `SUPERSEDED` болгож шинэ `ACTIVE` token үүсгэнэ. Revoke нь token-ийг `REVOKED` болгох бөгөөд operational permission үүсгэхгүй; дараа дахин урих бол ижил membership row дээр шинэ token үүсгэнэ.
- Accept зөвхөн тухайн membership-ийн current `ACTIVE` token дээр хийгдэнэ. Resend/revoke/suspension/termination түрүүлж revision өөрчилсөн бол хуучин token-оор accept хийх хүсэлт `CONFLICT/INVALID_INVITATION` болно.

## 5. Activation

### Шинэ user account

1. Staff invitation link нээнэ.
2. Link-ийн email, хугацаа, нэг удаагийн төлөв болон membership scope шалгагдана.
3. Staff нууц үгээ өөрөө үүсгэнэ.
4. Invitation зөвшөөрнө.
5. User account болон membership `Идэвхтэй` болно.
6. Token дахин ашиглагдахгүй.

Invitation accept нь membership row/revision-ийг transaction-аар түгжиж, commit хийх агшинд membership `Урилга хүлээж байгаа`, invitation хүчинтэй, account/membership suspend/terminate болоогүй, package/role entitlement хэвээр эсэхийг дахин шалгана.

### Өмнө account-тай email

- Шинэ user account/password үүсгэхгүй.
- Хэрэглэгч өмнөх account-аараа нэвтэрч invitation-ийг зөвшөөрнө.
- Invitation email болон нэвтэрсэн account-ийн баталгаажсан email таарах ёстой.
- Зөвшөөрсний дараа шинэ hotel/restaurant membership нэмэгдэнэ.

Role action нь зөвхөн account, membership, package болон subscription/grace gate бүгд хангагдсаны дараа ажиллана.

## 6. Password reset

- Staff бүртгэлтэй email-ээр self-service password reset хүснэ.
- Hotel Admin тухайн staff-д reset email дахин явуулах хүсэлт эхлүүлж болох боловч token/link, одоогийн болон шинэ password-ийг харахгүй.
- Reset link зөвхөн account-ийн бүртгэлтэй email-д очно; Hotel Admin өөр email сонгохгүй.
- Staff шинэ password-аа өөрөө үүсгэнэ.
- Password reset амжилттай бол account-ийн бүх төхөөрөмж, бүх hotel membership-ийн session хүчингүй болно.
- Password reset нь role/membership/subscription status-ийг өөрчлөхгүй.
- Email-д хандах боломжгүй ownership recovery-г Hotel Admin шийдэхгүй; батлагдсан Platform Super Admin offline process-д шилжүүлнэ.

## 7. Role нэмэх/хасах

- Зөвхөн Hotel Admin өөрийн hotel-ийн staff role-ийг нэмэх/хасна.
- Manager Plus зөвхөн өөрийн Restaurant Manager membership-ийг удирдана.
- Role change хийх бүрд package, inviter permission болон target membership-ийг server дахин шалгана.
- Role change нь membership revision compare-and-set ашиглаж suspension/termination/reactivation/invitation acceptance-тай нэг lock дээр serialize хийгдэнэ.
- Өөрчлөлт тухайн hotel/restaurant scope-д шууд хүчинтэй болно.
- Тухайн scope-ийн идэвхтэй session/permission cache-ийг хүчингүй болгож хэрэглэгчээр дахин нэвтрүүлнэ.
- Role өөрчлөгдсөн ч өмнөх stay, shift, payment, cleaning, order болон audit record дахь actor identity өөрчлөгдөхгүй.

## 8. Suspension, ажлаас гарах ба reactivation

Membership-ийн үндсэн төлөв:

```text
Урилга хүлээж байгаа
→ Идэвхтэй
→ Түдгэлзсэн → Идэвхтэй
Идэвхтэй | Түдгэлзсэн → Ажлаас гарсан
Ажлаас гарсан → Идэвхтэй (explicit rehire/reactivation)
```

- Hotel Admin staff membership-ийг шууд түдгэлзүүлж эсвэл `Ажлаас гарсан` болгоно.
- Suspension/termination/reactivation нь membership row/revision-ийг transaction-аар түгжиж current state, actor permission, package entitlement болон target role-ийг commit дээр дахин шалгана.
- Suspension/termination тухайн hotel/restaurant scope-ийн permission, server session/token болон permission cache-ийг нэг transaction-аар шууд хүчингүй болгоно.
- Security suspension-ийг нээлттэй shift/task/order байгаа шалтгаанаар хойшлуулахгүй.
- Reception-ийн нээлттэй shift `TAKEOVER_REQUIRED` exception queue-д орж, зөвхөн Manager/Manager Plus claim хийнэ. Hotel Admin энэ queue-г claim/resolve хийх бол Manager/Manager Plus role тусдаа авна.
- Cleaner-ийн unfinished assigned task Manager/Manager Plus-ийн reassignment queue-д орно. Hotel Admin reassign хийх бол Manager/Manager Plus role тусдаа авна.
- Restaurant Manager-ийн unfinished order/task-ийг Manager Plus өөр active Restaurant Manager рүү шилжүүлнэ. Hotel Admin-д Manager Plus role, order өөрөө боловсруулах бол Restaurant Manager membership тусдаа шаардлагатай.
- User account, membership болон өмнөх operational/audit history-г hard delete хийхгүй.
- `Түдгэлзсэн` эсвэл `Ажлаас гарсан` хүнийг дахин ажилд авбал Hotel Admin mandatory reason-тэй explicit reactivation хийж өмнөх account/membership-ийг `Идэвхтэй` болгоно; package-д хориглосон role-ийг сэргээхгүй, шинэ давхардсан account үүсгэхгүй.
- Reactivation нь хуучин session-ийг сэргээхгүй; хэрэглэгч дахин нэвтэрнэ.

### 8.1 Нээлттэй Reception shift takeover

1. Reception membership түдгэлзмэгц тухайн хэрэглэгч шинэ payment/cash/shift action хийхгүй бөгөөд open shift дээр `TAKEOVER_REQUIRED` exception item атомикаар үүснэ.
2. Ижил hotel-ийн active Manager/Manager Plus exception item-ийг compare-and-set байдлаар claim хийнэ. Нэг item нэг current claimant-тай; duplicate claim өмнөх үр дүнг буцаана.
3. Claimant active Reception role-той replacement-ийг сонгоно. Claimant өөрөө replacement болох бол Reception role мөн тусдаа байна.
4. Replacement кассын мөнгийг бодитоор тоолж existing handover/cash-ledger guard-аар батална. Suspended actor-ийн expected/actual/transaction history-г replacement нэрээр overwrite хийхгүй.
5. Old shift suspension-оос хойш шинэ movement авахгүй; pending payment/transfer existing дүрмээр terminal болох хүртэл takeover close дуусахгүй. Actual count/variance хадгалагдаж, шаардлагатай review existing Manager/Hotel Admin review урсгалд орно.
6. New shift зөвхөн replacement-ийн Reception permission болон бодитоор баталсан opening balance-аар нээгдэнэ.

Takeover commit болсны дараа replacement Reception нь `takeover_id`-тайгаар зөвхөн old shift-д suspension-оос өмнө эхэлсэн pending payment-ийн provider status query/reconciliation trigger болон drawer transfer-ийн receive/return confirmation зэрэг **Reception-д canonical-аар зөвшөөрөгдсөн terminal confirmation**-ийг гүйцэтгэж болно. Provider/server result л payment success/failure authority байна. Transfer initiate/cancel request, approval эсвэл Manager-д хамаарах terminal decision-ийг replacement Reception өвлөхгүй; тэдгээрийг claimant Manager/Manager Plus өөрийн existing permission-ээр хийнэ. Нэг actor хоёр төрлийн action хийх бол Manager/Manager Plus + Reception role хоёул тусдаа байна. Энэ нь шинэ customer movement эхлүүлэх эрх биш; original initiator, source shift, provider/transfer reference өөрчлөгдөхгүй, replacement action тусдаа audit event болно.

Hotel Admin queue-г харах/удирдах болон replacement сонгохдоо Manager/Manager Plus role, өөрөө cash count/shift execution хийхдээ Reception role тусдаа авна. Primary/Hotel Admin role дангаараа operational takeover permission биш.

### 8.2 Cleaner task reassignment ба linked continuation

- Claim/completion/stock movement эхлээгүй assigned Cleaner task-ийг Manager/Manager Plus ижил hotel-ийн active, package-д эрхтэй Cleaner рүү атомикаар reassign хийнэ.
- Reassignment нь task-ийн `assignment_version`-ийг нэмэгдүүлж, previous/new assignee, actor, reason, server time болон task/request/room reference-тэй append-only event үүсгэнэ. Suspended Cleaner хуучин task payload-аар retry хийсэн ч server membership/version check хориглоно.
- Immutable stock movement, actual count эсвэл partial completion аль хэдийн post болсон task-ийн assignee/history-г солихгүй. Үлдсэн зөвшөөрөгдсөн quantity/action-д original request, exact room/config/version болон өмнөх movement-тэй холбоостой шинэ `CONTINUATION` task үүсгэн replacement Cleaner-д онооно.
- Continuation task өмнөх movement-ийг edit/delete/repost хийхгүй; нэг remaining action хоёр task-аар зэрэг гүйцэтгэгдэхгүй idempotency/concurrency guard-тай байна.
- Active replacement Cleaner байхгүй бол task `UNASSIGNED_REQUIRES_ACTION` хэвээр, checkout/config/readiness blocker existing дүрмээр үргэлжилнэ; автоматаар complete/bypass хийхгүй.
- Hotel Admin Cleaner task reassign/continuation үүсгэх бол тухайн багцад зөвшөөрөгдсөн Manager/Manager Plus role тусдаа авна.

### 8.3 Restaurant unfinished work

- Order/transaction нь Restaurant-ийн resource хэвээр; suspended actor-ийн өмнөх accept/update/audit-г өөрчлөхгүй.
- Manager Plus unfinished assigned task/claim-ийг ижил Restaurant-ийн active Restaurant Manager рүү reassign хийнэ. Active Restaurant Manager байхгүй бол queue unresolved хэвээр байна.
- Manager Plus order processing action-ийг автоматаар өвлөхгүй. Order-г өөрөө боловсруулах бол тухайн `restaurant_id`-ийн Restaurant Manager membership тусдаа авна. Hotel Admin мөн Manager Plus/Restaurant Manager role-ийн ижил огтлолцлыг мөрдөнө.

### 8.4 Нийтлэг reassignment хамгаалалт

- Replacement нь ижил `hotel_id`/`restaurant_id`, active membership, required role болон package entitlement-тэй байна.
- Нэг task/exception-д нэг current assignee/claimant байна; `assignment_version + idempotency_key` duplicate/cross-tenant transition-оос хамгаална.
- `created_by`, historical assignee, posted movement, payment, shift transaction болон audit actor-г overwrite хийхгүй.
- Reassignment/takeover нь security suspension-ийг буцаахгүй, suspended session-ийг сэргээхгүй.

### 8.5 Membership lifecycle concurrency

- Membership бүр monotonic `membership_revision`-тай. Invitation create/resend/revoke/accept, role add/remove, suspension, termination болон reactivation бүгд ижил row lock + expected revision ашиглана.
- Commit бүр current membership state, account state, inviter/actor permission, package entitlement болон scope-ийг дахин шалгана; stale request `CONFLICT` болж шинэ state-ийг overwrite хийхгүй.
- Suspension/termination transaction түрүүлбэл зэрэг ирсэн invitation acceptance/role addition/reactivation commit болохгүй. Reactivation түрүүлбэл зөвхөн шинэ revision дээр дараагийн role action хийгдэнэ.
- Idempotency key давтан submit-ийг өмнөх үр дүн рүү буцааж, нэг event/role/session revoke-г хоёр удаа үүсгэхгүй.

## 9. Primary Hotel Admin

- MVP-д hotel бүр төлбөрөөр onboarding provision хийсэн нэг `Primary Hotel Admin`-тай байна.
- Primary Hotel Admin өөрийгөө suspend/delete хийх, Primary эрхээ буулгах эсвэл өөр Primary Admin урихгүй.
- Hotel staff invitation-аар Primary Hotel Admin role олгохгүй.
- Primary owner/admin солих шаардлага нь Operation-ийн энгийн staff action биш; Platform Super Admin-ийн гэрээ/ownership шалгасан offline transfer/recovery урсгал байна.
- Primary Hotel Admin Manager/Reception ажиллагаа хийх бол canonical matrix-ийн дагуу нэмэлт operational role авна.

## 10. Session цуцлах matrix

| Event | Session-д үзүүлэх нөлөө |
| --- | --- |
| Password амжилттай reset/change | Account-ийн бүх төхөөрөмж, бүх membership session хаагдана |
| Hotel membership suspension/termination | Зөвхөн тухайн hotel scope-ийн session/permission шууд хаагдана |
| Restaurant membership suspension/termination | Зөвхөн тухайн restaurant scope хаагдана |
| Role нэмэх/хасах | Тухайн scope-ийн session хаагдаж дахин login шаардана |
| Хэрэглэгч `Бүх төхөөрөмжөөс гарах` | Account-ийн бүх session хаагдана |
| Subscription 48 цагийн grace дуусах | Hotel-ийн бүх operational action deny; renewal/help/logout дүрэм үйлчилнэ |
| Subscription renewal | Account/membership идэвхтэй бол permission дахин тооцогдоно; хаагдсан session автоматаар сэрэхгүй |

Logout болон session revoke-ийг зөвхөн frontend local storage цэвэрлэх байдлаар хийхгүй; server талын session/token state-ийг хүчингүй болгоно.

## 11. Audit

Дараах event-үүдийг actor, target account/membership, hotel/restaurant scope, огноо/цаг болон үр дүнтэй хадгална:

- invitation create/resend/expire/accept/revoke;
- account activation;
- role add/remove;
- suspension, termination, reactivation;
- password reset request болон амжилттай reset;
- session revoke/all-device logout;
- permission/package/subscription-аар хориглосон өндөр эрсдэлтэй action.
- suspension-аар үүссэн exception item, queue claim/release, replacement сонголт, Cleaner reassignment/continuation болон Restaurant reassignment.

Password, invitation/reset token, OTP болон session secret-ийг log/audit-д эх утгаар нь хадгалахгүй.

## 12. MVP acceptance criteria

- Staff-д бэлэн password илгээхгүй; нэг удаагийн email invitation ашиглана.
- Invitation accept хийгдээгүй membership operational permission авахгүй.
- Existing email-д давхардсан user account үүсгэхгүй.
- Нэг account олон hotel membership/role-той байж болно.
- Package-д зөвшөөрөөгүй role invitation болон API request хориглогдоно.
- Role change тухайн scope-д шууд үйлчилж session-ийг хаана.
- Suspension/termination permission-ийг шууд хааж, түүхийг устгахгүй.
- Concurrent invitation create/resend/revoke/accept, role/reactivation request suspension/termination-ийг overwrite хийхгүй; нэг scope membership + нэг active invitation unique constraint болон membership revision/row lock хамгаална.
- Suspension/termination server session/token/cache-ийг тухайн scope-д шууд revoke хийж, suspended actor unfinished work-ээ retry хийж дуусгахгүй.
- Suspended Reception-ийн open shift `TAKEOVER_REQUIRED` queue-д орж, Manager/Manager Plus нэг claimant-аар авч, active Reception replacement existing cash/handover guard-аар үргэлжлүүлнэ.
- Hotel Admin shift takeover queue удирдах бол Manager/Manager Plus, cash/shift execution хийх бол Reception role тусдаа авна.
- Takeover replacement suspension-оос өмнөх pending payment-ийн provider status query/reconciliation trigger болон Reception-д зөвшөөрөгдсөн transfer receive/return confirmation-ийг `takeover_id`-тай хийж, original actor/reference-г өөрчлөхгүй; Manager cancel/approval permission өвлөхгүй.
- Movement эхлээгүй Cleaner task active Cleaner рүү атомикаар reassign; movement/partial completion эхэлсэн бол original history-г өөрчлөхгүй linked continuation task үүснэ.
- Active Cleaner байхгүй бол task/blocker автоматаар complete болохгүй.
- Reassignment бүр same-scope/role/package, assignment version, idempotency болон append-only audit шалгалттай байна.
- Password reset account-ийн бүх session-ийг хүчингүй болгоно.
- Restaurant Manager зөвхөн invitation-д заасан Restaurant scope-д хандана.
- Hotel staff invitation-аар Primary Hotel Admin үүсгэхгүй.
- Staff history болон actor identity hard delete/overwrite болохгүй.

## 13. Батлагдсан шийдвэр

### STAFF-DEC-001 — Email invitation, user-created password

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Hotel/Restaurant staff-д бэлэн/түр password өгөхгүй. Хугацаатай, нэг удаагийн email invitation-аар staff өөрөө password үүсгэж membership-ээ идэвхжүүлнэ.

### STAFF-DEC-002 — Account ба membership

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Нэг email нэг user account-тай. Нэг account олон hotel membership болон олон role-той байж болно. Suspension/role change hotel/restaurant scope-д үйлчилнэ.

### STAFF-DEC-003 — Password reset ба session

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Staff password-аа бүртгэлтэй email-ээр өөрөө reset хийнэ. Hotel Admin зөвхөн reset email эхлүүлж болох бөгөөд password/token харахгүй. Амжилттай reset account-ийн бүх session-ийг хаана.

### STAFF-DEC-004 — Role change ба suspension

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Role change болон suspension тухайн scope-д шууд хүчинтэй болж session-ийг хаана. Нээлттэй operational ажил exception/reassignment queue-д орно; security suspension хойшлохгүй.

### STAFF-DEC-005 — Hard delete хийхгүй

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Staff account, membership болон actor history-г hard delete хийхгүй. Ажлаас гарсан төлөв, reactivation болон append-only audit ашиглана.

### STAFF-DEC-006 — Нэг Primary Hotel Admin

- **Төлөв:** Батлагдсан
- **Шийдвэр:** MVP-д hotel бүр нэг Primary Hotel Admin-тай. Staff invitation-аар Primary Admin үүсгэх/солихгүй. Ownership/Admin transfer нь Platform Super Admin-ийн offline баталгаажуулсан урсгал байна.

### STAFF-DEC-007 — Suspension дараах operational takeover/reassignment

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Suspension/termination permission болон тухайн scope-ийн server session/token/cache-ийг нэн даруй revoke хийх бөгөөд unfinished work security suspension-ийг хойшлуулахгүй. Suspended Reception-ийн open shift `TAKEOVER_REQUIRED` queue-д орж Manager/Manager Plus atomically claim хийн, active Reception replacement existing cash/handover guard-аар үргэлжлүүлнэ. Cleaner task movement эхлээгүй бол active Cleaner рүү reassign; immutable movement/partial completion эхэлсэн бол original history-г хэвээр хадгалж remaining work-д linked continuation task үүсгэнэ. Restaurant unfinished task-ийг Manager Plus active Restaurant Manager рүү reassign хийнэ. Hotel Admin эдгээр operational action-д тохирох Manager/Manager Plus, шаардлагатай бол Reception/Restaurant Manager role-ийг тусад нь авна. Бүх claim/reassignment same-scope, one-assignee, version/idempotency болон append-only audit хамгаалалттай байна.

### STAFF-DEC-008 — Membership revision, reactivation ба takeover terminalization

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Invite accept, role change, suspension, termination болон reactivation нэг membership row/revision lock дээр serialize хийгдэнэ; suspension/termination түрүүлбэл stale accept/role request commit болохгүй. `SUSPENDED` болон `TERMINATED` membership-ийг Hotel Admin reason-тэй explicit reactivation хийж existing account-аар сэргээнэ. Takeover replacement нь `takeover_id`-тайгаар suspension-оос өмнөх pending item-ийн зөвхөн Reception canonical terminal confirmation/status-query action-ийг гүйцэтгэж, Manager cancel/approval эрх өвлөхгүй; original actor/history-г overwrite хийхгүй.

### STAFF-DEC-009 — Invitation concurrency ба нэг membership invariant

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Нэг hotel/restaurant scope + normalized email/account-д нэг canonical membership, нэг membership-д хамгийн ихдээ нэг `ACTIVE` invitation байна. Create/resend/revoke/accept нь ижил membership revision lock, unique constraint болон idempotency key ашиглана; resend хуучин token-ийг `SUPERSEDED`, revoke `REVOKED` болгоод хуучин token-оор accept хийхийг хориглоно. Rehire шинэ давхардсан membership бус explicit reactivation ашиглана.

## 14. Хаагдсан төлөв

Staff lifecycle-ийн P0 үндсэн шийдвэрүүд STAFF-DEC-001–009-өөр хаагдсан. Invitation/reset link-ийн TTL, resend interval, attempt/rate limit болон password security-ийн тоон утга нь P1 authentication security configuration бөгөөд membership/session/reassignment schema-г дахин нээхгүй. Automatic task timeout/SLA escalation нь P1; MVP-ийн manual atomic claim/reassignment батлагдсан.
