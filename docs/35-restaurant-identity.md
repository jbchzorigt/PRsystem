# Restaurant staff identity ба эрхийн тусгаарлалт

**Үе шат 2/6 · Үлдсэн 9 багцын №9.** [Staff lifecycle](19-staff-account-lifecycle.md), [permission matrix](18-action-level-permission-matrix.md) болон [Restaurant scope](08-restaurant-ordering.md)-ийн identity хэсэг. Migration `007_restaurant_identity.sql`; өмнөх migration-ууд өөрчлөгдөөгүй.

## Account, membership, session

Нэг canonical email/account нь Hotel болон нэгээс олон Restaurant membership-тэй байж болно. `restaurant_membership` нь `(restaurant_id, account_id)` unique, status/revision-тэй; role нь server талд тогтмол `RESTAURANT_MANAGER`. Энэ membership нь Hotel staff membership, Hotel Admin/Manager/Manager Plus permission үүсгэхгүй.

`staff_session` бүр **яг нэг** `tenant_id` эсвэл `restaurant_id`-тай. DB CHECK болон realm-specific composite FK нь mixed-scope session-ийг хориглоно. Authentication membership/revision/status-ийг session-ийн database scope-оос сонгоно; HTTP role/realm override байхгүй. Hotel operational endpoint tenant-аа, Restaurant endpoint restaurant-аа explicit шаардана.

- `GET /auth/me`: account, nullable `tenant_id`/`restaurant_id`, role, current revision, session expiry. Identity endpoint нь operational package access олгохгүй.
- `POST /auth/logout`: тухайн session; Restaurant scope auth event-тай, idempotent.
- `POST /auth/logout-all`, password change/reset: shared account epoch өсөж Hotel/Restaurant **бүх** session хүчингүй болно.
- Hotel membership suspension нь Restaurant membership/session-ийг өөрчлөхгүй; Restaurant membership suspension нь Hotel болон бусад Restaurant-ийг өөрчлөхгүй.
- Global account security suspension/verification change бүх realm-д үйлчилнэ. Reactivation хуучин session-ийг сэргээхгүй.
- Login throttling нь ижил email/IP bucket-ийг хоёр realm-д хамт ашиглана; realm солих замаар retry budget нэмэхгүй.

## Registration ба Hotel–Restaurant холбоос

`POST /hotels/{tenant_id}/restaurants` нь тухайн hotel-ийн **Manager Plus + 30,000₮** entitlement шаарддаг. Primary Hotel Admin дангаараа Restaurant бүртгэх/урихгүй. Registration нь Restaurant identity/config, creator, hotel link, canonical pending manager membership, invitation/mail intent, audit, idempotency receipt-ийг нэг transaction-д үүсгэнэ. Deferred commit алдаа бүгдийг буцаана.

```json
{
  "name": "Жишээ ресторан", "category": "Restaurant", "description": "Хоолны үйлчилгээ",
  "address": "Улаанбаатар", "latitude": 47.92, "longitude": 106.92, "phone": "+976 99112233",
  "weekly_hours": [
    {"day":0,"closed":false,"opens":"10:00","closes":"22:00"},
    {"day":1,"closed":false,"opens":"10:00","closes":"22:00"},
    {"day":2,"closed":false,"opens":"10:00","closes":"22:00"},
    {"day":3,"closed":false,"opens":"10:00","closes":"22:00"},
    {"day":4,"closed":false,"opens":"18:00","closes":"02:00"},
    {"day":5,"closed":false,"opens":"18:00","closes":"02:00"},
    {"day":6,"closed":true}
  ],
  "email": "manager@example.com", "manager_name": "Ажилтны нэр", "idempotency_key": "restaurant-001"
}
```

Monday=0…Sunday=6, өдөр тус бүр яг нэг бичлэгтэй. Closed өдөр цаггүй; нээлттэй өдөр HH:MM форматтай ялгаатай opening/closing цагтай. Overnight цаг хадгалж болно; order acceptance/schedule evaluator нь дараагийн Restaurant модулийн ажил. Coordinates finite/range check, phone/name/mandatory fields болон unknown-field reject server model-д байна.

Шинэ холбоос **active=false**; public ordering/merchant/payment readiness-г хийлгүй идэвхжүүлэх endpoint байхгүй. `active`, `created_by`, role/permission override request талбар биш. Энэ нь membership acceptance-ийг хаахгүй: staff эхлээд identity-гаа баталгаажуулж болно.

Нэг Restaurant-ийг олон hotel-тэй холбох өгөгдлийн загвар тусдаа `hotel_restaurant` хүснэгттэй. `POST /hotels/{hotel}/restaurants/{restaurant}/link` нь `idempotency_key` авч, зөвхөн restaurant creator account тухайн destination hotel-д current Manager Plus/30,000₮ эрхтэй үед холбоно. Өөр хүний restaurant-ийг ID мэдсэн төдийд холбохгүй. Link мөн inactive үүснэ.

## Invitation ба membership API

Manager Plus нь **өөрөө бүртгэсэн**, өөрийн current hotel-тэй холбоотой Restaurant дээр л staff удирдана. Ижил hotel-ийн өөр Manager Plus creator-ийн эрхийг өвлөхгүй. Receipt нь actor+hotel+command-той; command дотор restaurant ID заавал орно.

| Method / path | Body / утга |
| --- | --- |
| POST `/hotels/{hotel}/restaurants/{restaurant}/staff/invitations` | `email`, `name`, `idempotency_key`; role fixed |
| POST `/hotels/{hotel}/restaurants/{restaurant}/staff/{account}/invitations/resend` | `expected_revision`, `idempotency_key` |
| POST `/hotels/{hotel}/restaurants/{restaurant}/staff/{account}/invitations/revoke` | Дээрхтэй ижил |
| POST `/hotels/{hotel}/restaurants/{restaurant}/staff/{account}/suspend` | revision/key + mandatory `reason` |
| POST `/hotels/{hotel}/restaurants/{restaurant}/staff/{account}/terminate` | Дээрхтэй ижил |
| POST `/hotels/{hotel}/restaurants/{restaurant}/staff/{account}/reactivate` | Verified active account; өмнөх suspended/terminated membership |
| POST `/hotels/{hotel}/restaurants/{restaurant}/staff/{account}/recover` | Unverified suspended/terminated account → PENDING + шинэ invite |
| POST `/auth/restaurants/invitations/accept` | `token`, recipient-ийн `password` |
| POST `/auth/restaurants/login` | `email`, `password`, `restaurant_id` |
| GET `/hotels/{hotel}/restaurants/{restaurant}/profile` | Тухайн Restaurant-ийн session; холбоос, package/subscription/security gate |

Invitation purpose нь `RESTAURANT_INVITE`; Hotel INVITE болон RESET endpoint-ууд энэ token-ийг хүлээн авахгүй. Token hash-only, mail intent identifier-only. Restaurant + account-д нэг active invite; нэг canonical membership. Inviter email/password/link харахгүй. Existing account нь existing password-оор reauthenticate хийнэ; password overwrite хийхгүй.

Accept нь account-уудын sorted lock, sponsor Hotel membership, target Restaurant membership/revision, creator identity, Hotel–Restaurant холбоос, current Manager Plus/package/subscription болон current unexpired token-ийг шалгана. Password hashing-ийн дараа token expiry дахин шалгана. Resend/accept/suspension/termination зэрэг ирвэл stale revision/consumed token commit болохгүй.

Scope mutation нь зөвхөн тухайн Restaurant-ийн session-ууд болон invitation-ийг revoke хийнэ; audit/receipt нэг transaction. New operational assignment хийдэггүй. Restaurant unfinished order/task reassignment нь бодит order/source adapter-тай **5-р үндсэн үе шатанд** холбогдоно; энэ API түүхэн order actor/stock/payment-г өөрчлөхгүй.

Profile нь зөвхөн тухайн Restaurant-ийн config болон сонгосон hotel-ийн link active flag буцаана. Restaurant–hotel холбоосыг lock/check хийсний дараа package/subscription шалгана; холбоогүй hotel-ийн entitlement/security төлөвийг error code-оор илчлэхгүй. Hotel session нь эзэн байсан ч Restaurant execution session-ийг орлохгүй. Menu/order/refund endpoint энэ багцад үүсээгүй.

## Audit ба email

`restaurant_staff_event` нь creator/actor/target/restaurant/sponsor hotel, event kind, revision/reason/time хадгална; runtime UPDATE/DELETE эрхгүй. Auth event нь Restaurant scope-ийг хадгална. Denied-action audit Hotel болон Restaurant session-ийг current revision/epoch-оор resolve хийнэ; `actor_restaurant_id`, `requested_restaurant_id` нэмэгдсэн. Raw request/token/password audit-д орохгүй.

Одоо байгаа mail worker Restaurant invite-г current pending revision-тэй үед dispatch хийнэ. HTTPS UI path `/staff/restaurant-accept#token=...`; UI нь fragment-ийг уншиж арилгаад `/auth/restaurants/invitations/accept` рүү POST хийх шаардлагатай. Энэ UI болон бодит email хүргэлт **үлдсэн №1 багцад** хэвээр; memory transport test-ийг бодит recipient хүргэлт гэж тооцоогүй.

## Migration / minimum grants

API credential-д өмнөх auth, link, membership grants-ийн дээр:

```sql
-- Auth/denial reader now resolves either realm, including Hotel-only denials.
GRANT SELECT ON prsystem.restaurant_membership TO prsystem_api;
GRANT SELECT ON prsystem.restaurant, prsystem.hotel_restaurant TO prsystem_api;
GRANT INSERT ON prsystem.restaurant, prsystem.hotel_restaurant,
    prsystem.restaurant_membership, prsystem.restaurant_staff_event TO prsystem_api;
GRANT UPDATE (revision) ON prsystem.restaurant, prsystem.hotel_restaurant TO prsystem_api;
GRANT UPDATE (status, revision) ON prsystem.restaurant_membership TO prsystem_api;
-- Existing mail worker also reads Restaurant membership revision:
GRANT SELECT ON prsystem.restaurant_membership TO prsystem_mail;
```

`revision` UPDATE grants нь row lock-д шаардлагатай; API нь creator/identity, hotel link activation, restaurant config засварын endpoint олгохгүй. Scope/owner/source ID, audit/receipt, token hash-г UPDATE/DELETE хийх runtime grant нэмэхгүй. Private identity tables explicit scope predicates + composite FK ашигладаг; cash FORCE RLS өөрчлөгдөөгүй. Migration owner credential-ийг API/worker-д ашиглахгүй.

## Acceptance

26 шинэ integration тест: pending registration, ownership/package/realm checks, canonical account, strict form/schedule, token purpose/expiry, resend/revoke/recovery, per-restaurant and global revocation, multi-hotel links, cross-scope denial, email boundary, concurrent registration/accept/mutation, deferred commit rollback ба minimum-grant/DB constraint tests. Өмнөх Hotel/cash/recovery/worker тестүүдийг хамтад нь ажиллуулна.

№9 нь Restaurant **staff identity/invitation/access** багцын acceptance. Restaurant activation, меню/үнэ/хуваарийн evaluator, order/claim/reassignment, QPay/refund болон guest UI дууссан гэсэн үг биш; эдгээр нь үндсэн roadmap-ийн 5-р үе шатанд үлдсэн.

[Эцсийн PostgreSQL CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34071168507) implementation commit `ee774883d7fe3e495dfd3575ff6f7f76aaa03338` дээр нийт **164 тестийг skip-гүй амжилттай** ажиллуулсан. №9 identity багц дууссан; нийт үлдсэн 9 багцаас 4 дууссан.
