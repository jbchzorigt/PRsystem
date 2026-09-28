# Membership mutation ба үлдсэн ажлын queue

**Түүхэн checkpoint:** Энэ баримтын source/FK, claim-only болон recovery үлдэгдлийн тайлбар нь migration 004 үеийн хүрээ. Дараах хэрэгжилтээр шинэчлэгдсэн: [recovery/worker](34-staff-recovery-mail-worker.md), [Restaurant](35-restaurant-identity.md), [takeover/continuation/onboarding](36-staff-execution-and-onboarding.md). Одоогийн acceptance төлөв: [явц](31-development-progress.md).

Энэ багц [STAFF-DEC-004/007/008](19-staff-account-lifecycle.md)-ийн hotel membership өөрчлөлт, үлдсэн ажлыг бүртгэх болон Manager claim хийх хэсгийг хэрэгжүүлнэ. **Бодит shift takeover/cleaner reassignment дуусаагүй.** `004_membership_work.sql` нь өмнөх migration-уудыг өөрчлөхгүй.

## API contract

Bearer session нь зам дахь hotel-тэй таарна. Membership endpoint бүр Hotel Admin эрх шаарддаг; email token key тохируулаагүй үед ч ажиллана.

| Method / path | Body / үр дүн |
| --- | --- |
| POST `/hotels/{hotel}/staff/{account}/roles` | `roles`, `expected_revision`, `idempotency_key`, `reason` |
| POST `/hotels/{hotel}/staff/{account}/suspend` | `expected_revision`, `idempotency_key`, `reason` |
| POST `/hotels/{hotel}/staff/{account}/terminate` | Дээрхтэй ижил |
| POST `/hotels/{hotel}/staff/{account}/reactivate` | Дээрхтэй ижил |
| GET `/hotels/{hotel}/staff-work/exceptions` | Manager/Manager Plus; `limit` 1–100, дараагийн хуудас `after=<сүүлийн id>` |
| POST `/hotels/{hotel}/staff-work/exceptions/{id}/claim` | Manager/Manager Plus; `expected_revision`, `idempotency_key` |

Жишээ role request:

```json
{"roles":["RECEPTION"],"expected_revision":0,"idempotency_key":"staff-role-001","reason":"Шинэ ажлын үүрэг"}
```

Membership result нь `account_id`, `status`, `roles`, өссөн `revision`, шинээр үүссэн `exception_ids` агуулна. `reason` хоосон/зөвхөн whitespace байж болохгүй; audit-д орно. Password, bearer, link token audit/receipt-д орохгүй.

- Account-уудыг ID дарааллаар, дараа нь current session/membership-ийг түгжинэ. Invite accept/resend болон lifecycle mutation нэг membership revision дээр serialize хийнэ. Хуучирсан revision 409.
- Membership revision өсөх, тухайн hotel-ийн бүх session revoke, идэвхтэй invite revoke, open-work blocker/queue, audit, receipt **нэг transaction**. Commit алдаа бүх өөрчлөлтийг буцаана.
- Ижил actor/key/body retry өмнөх result-ийг буцаана; өөр command 409. Authentication ба current permission replay-ээс өмнө шалгагдана. Өөрийн role-ийг сольсон Primary дахин login хийсний дараа retry хийнэ.
- Global account/password/auth epoch, өөр hotel-ийн session болон түүхэн actor-ууд өөрчлөгдөхгүй. Reactivation хуучин session сэргээхгүй.
- `ACTIVE/PENDING → SUSPENDED`; `ACTIVE/PENDING/SUSPENDED → TERMINATED`; `SUSPENDED/TERMINATED → ACTIVE` зөвхөн active, verified account ба одоогийн package-д зөвшөөрсөн role-той үед. Бусад transition 409.
- Role засвар status-ийг өөрчлөхгүй. Pending membership-ийн role засварын дараа шинэ revision-ээр invite resend хэрэгтэй. Suspended/terminated membership-ийн role-ийг засаж байж package-д нийцүүлэн reactivate хийж болно.
- Primary-г suspend/terminate хийх, HOTEL_ADMIN role хасах болон өөр staff-д HOTEL_ADMIN олгохгүй. Primary өөртөө package-д тохирсон operational role нэмж/хасаж болно.
- Role grant/reactivation нь target-ийн бүх role-ийн package entitlement шалгана. Downgrade-ын дараах stale role нь **эрх цуцлалтыг зогсоохгүй**. Actor болон hotel-ийн CONFIGURE subscription/security gate бүх mutation-д үйлчилнэ; expired/security-locked hotel recovery нь энэ endpoint-ийн bypass биш.

## Operational adapter boundary

`MembershipService.register_open_work(conn, tenant, owner, kind, source_id)` нь **internal method**, HTTP endpoint биш. Ирээдүйн shift/task adapter нь source үүсгэхтэйгээ нэг transaction-д, source row lock-оос өмнө холбогдох account-уудыг sorted order-оор түгжиж дуудна. Membership/account active/verified, role/package/subscription шалгана. Suspension-тай нэг account lock хэрэглэснээр шинээр нээгдэх ажил suspension scan-аас зөрж гарахгүй.

Registry нь `(hotel, kind, source_id)` unique, original owner болон assignment version-ийг хадгална. SHIFT нь тухайн hotel-ийн бодит `cash_drawer.shift_id` composite FK-тай. CLEANING_TASK source table хараахан байхгүй тул existence/assignment/progress баталгааг дараагийн cleaning adapter заавал хариуцна. Одоогоор production source adapter энэ method-ийг дууддаггүй; тест source transaction-ийг төлөөлнө.

Suspension/termination эсвэл тохирох role алдагдахад нээлттэй ажлыг `BLOCKED` болгож SHIFT → `TAKEOVER_REQUIRED`, CLEANING_TASK → `REASSIGNMENT_REQUIRED` queue item атомикаар үүсгэнэ. Ажил дуусахыг хүлээж suspension-ийг хойшлуулахгүй. Reactivation blocker-ийг арилгахгүй.

Manager/Manager Plus queue-г харж, revision/idempotency бүхий claim хийнэ. Нэг current claimant байна. Hotel Admin дангаараа claim хийхгүй. Claim нь original owner, assignment version, posted/reserved cash, source shift болон түүхийг өөрчлөхгүй. Claimant-ийг suspend/terminate хийх эсвэл Manager permission-ийг хасахад claim-ууд released болж revision өснө; өөр идэвхтэй Manager авч болно.

**Үлдсэн:** source completion/block guards-ийн бодит холболт, replacement selection, physical cash count/variance, pending transfer/payment terminalization, shift close/new shift, cleaning reassignment/continuation ба immutable stock linkage. Claim хийгдсэн нь takeover дууссан гэсэн үг биш. Existing-obligation subscription exception-ийг source нотолгоогүйгээр нээгээгүй. Random ID keyset pagination нь snapshot биш; шинэ item нэмэгдсэн үед эхний хуудсаас refresh хийнэ.

## Minimum runtime grants

[Auth grants](30-staff-auth-api.md) болон invite integration ашиглавал [link grants](32-staff-invitations-reset.md)-ийн дээр:

```sql
GRANT SELECT ON prsystem.staff_link, prsystem.staff_command_receipt,
    prsystem.staff_open_work, prsystem.staff_work_exception TO prsystem_api;
GRANT INSERT ON prsystem.staff_command_receipt, prsystem.staff_change_event,
    prsystem.staff_work_exception TO prsystem_api;
GRANT UPDATE (status, roles) ON prsystem.staff_membership TO prsystem_api;
GRANT UPDATE (state) ON prsystem.staff_link, prsystem.staff_open_work TO prsystem_api;
GRANT UPDATE (claimant_id, revision) ON prsystem.staff_work_exception TO prsystem_api;
-- Зөвхөн source adapter-ийг энэ credential-ээр ажиллуулахад шаардлагатай:
GRANT INSERT ON prsystem.staff_open_work TO prsystem_api;
```

Identity/queue table-ууд private server table: HTTP handler tenant predicate, composite FK болон authentication-аар scope шалгана; cash-ийн FORCE RLS хэвээр. Runtime-д `is_primary`, original owner/source, audit/receipt UPDATE/DELETE, cash mutation grant өгөхгүй. Migration owner нь API credential биш.

## Баталгаажуулалт ба үлдсэн эрсдэл

25 шинэ PostgreSQL/API тест: scope/session revoke, role/package/Primary, transition validation, idempotency, concurrent mutation/claim, source registration-vs-suspension lock ordering, queue permissions/pagination, claimant release, pending invite invalidation, deferred commit rollback болон minimum grants. Dependency-free local run эдгээрийг skip хийнэ; [бодит PostgreSQL CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34015694845) нийт 113 тестийг skip-гүй амжилттай ажиллуулсан.

Unverified pending invite-ийг suspend/terminate хийсний дараах дахин урих recovery энэ багцад байхгүй: хуучин invite хүчингүй, generic reactivate account verification-ийг тойрохгүй. Tenant lock recovery, package/account өөрчлөлтөөс болж эрхгүй болсон claimant-ийн recovery, denied-action security audit, Restaurant scope, paid Primary provisioning, real email transport/worker болон operational adapters дараагийн ажлууд. Эдгээр нь 2-р үе шатыг хаах/production-д гаргах gate хэвээр.

2026-09-07: Unverified invite recovery, эрхгүй claimant recovery болон denied-action audit [34-р contract](34-staff-recovery-mail-worker.md)-д нэмэгдсэн. Tenant lock recovery ба actual operational takeover энэ нэмэлтэд хаагдаагүй. Package-ийн lower-entitlement fixture нь downgrade үйлчилгээ хэрэгжүүлсэн гэсэн үг биш; canonical subscription downgrade хоригтой.
