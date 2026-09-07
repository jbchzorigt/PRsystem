# Staff invitation ба password reset

**Хамрах хүрээ:** hotel staff; [19-staff-account-lifecycle.md](19-staff-account-lifecycle.md)-ийн invitation/reset дүрэм. Restaurant, Operation, Police-ийн provisioning/auth realm тусдаа хэвээр.

## API

| Method / path | Input / эрх | Үр дүн |
| --- | --- | --- |
| `POST /hotels/{tenant_id}/staff/invitations` | Hotel Admin bearer; `email`, `name`, `roles`, `idempotency_key` | Canonical PENDING membership, current invitation metadata; 201 |
| `POST /hotels/{tenant_id}/staff/{account_id}/invitations/resend` | Hotel Admin bearer; `expected_revision`, `idempotency_key` | Өмнөх token SUPERSEDED, membership revision нэмэгдэж шинэ token/mail intent |
| `POST /hotels/{tenant_id}/staff/{account_id}/invitations/revoke` | Hotel Admin bearer; `expected_revision`, `idempotency_key` | Current token REVOKED; membership operational permission авахгүй |
| `POST /auth/invitations/accept` | Recipient `token`, `password` | Current eligible invitation нэг удаа ACCEPTED, membership ACTIVE |
| `POST /auth/password/reset/request` | `email` | Existing/unknown email-д адил async enqueue ба 202; account байгаа эсэхийг response-аар хэлэхгүй |
| `POST /auth/password/reset/complete` | `token`, `password` | Password өөрчлөгдөж account-ийн бүх session invalid; 204 |

Inviter response нь account/invitation ID, revision, state, expiry зэрэг metadata агуулна; token, link, password агуулахгүй. Body нэмэлт field-ийг reject хийнэ. Reset recipient-ийг client override хийхгүй.

Шинэ account нь эхлээд unverified placeholder (`password_hash='!'`) байна; usable/default password байхгүй. Link-ийн эзэмшигч accept хийхдээ 12–128 тэмдэгт шинэ password сонгоно. Token possession нь урьсан email-д хандах боломжийн баталгаа болно.

Өмнөх verified account-ийн хувьд accept request-ийн `password` нь **одоо ашиглаж буй password**. Өмнөх account-аараа нэвтрэх/reauthentication ба acceptance-ийг нэг transaction-д хийдэг; password-г шинэчилж эсвэл давхар account үүсгэхгүй. Үүгээр өмнөх hotel membership-үүд идэвхгүй байсан ч өөр hotel-ийн хүчинтэй урилгыг өөрийн credential-аар хүлээн авч болно. Accept дараа target hotel-д ердийн login хийнэ; invitation нь өөрөө browser session биш.

## Canonical state ба concurrency

- Нэг normalized ASCII email → нэг account; tenant/account → нэг canonical membership. Existing ACTIVE/SUSPENDED/TERMINATED/PENDING membership-ийг create endpoint давхардуулахгүй. Pending token-ийг resend, хуучин employment-ийг дараагийн explicit reactivation workflow ашиглана.
- Нэг membership-д нэг ACTIVE invite; нэг account-д нэг ACTIVE reset token database unique constraint-тай.
- Create/resend/revoke нь actor, tenant, current membership, role/package/subscription/security болон revision-ийг шалгана. Manager/Manager Plus ерөнхий hotel staff урихгүй; Hotel Admin-аар өөр Hotel Admin, Restaurant/Operation/Police role олгохгүй. Cleaner зөвхөн 25/30, Manager Plus зөвхөн 30 мянгын багцад.
- Resend/revoke нь membership revision-ийг нэмнэ. Accept current revision, target account/membership, inviter-ийн одоогийн Hotel Admin эрх, package болон subscription-ийг дахин шалгана. Resend/revoke/suspension түрүүлж commit хийсэн бол хуучин token access үүсгэхгүй.
- Existing account-уудыг ID дарааллаар lock хийсний дараа session/membership/hotel lock авна. Concurrent create, accept/resend, reset consume нь PostgreSQL дээр serialize хийгдэнэ. Email account creation болон command receipt-д transaction advisory lock нэмсэн.
- Idempotency receipt tenant/key дээр unique; actor/command зөрвөл 409. Replay өмнөх metadata-г буцаана; шинэ token/event/email intent үүсгэхгүй. Replay metadata нь current invitation хүчинтэй гэсэн баталгаа биш.
- Expiry-г password hashing болон lock wait-ийн дараа consume хийх SQL дээр дахин шалгана. Хугацаа дуусвал account/password/membership өөрчлөлт бүгд rollback хийнэ.

## Password reset

Public request нь email/account lookup хийхгүй; normalized email бүхий queue row үүсгэнэ. Existing/unknown email-ийн response path ижил. Email/IP throttle нь PostgreSQL-ийн shared counter ашиглана. `process_reset_request(request_id)` internal worker нь зөвхөн verified existing account-д reset link/mail intent үүсгэж, unknown/unverified email-ийг processed болгоод дуусна.

Worker нэг email-ийн хамгийн шинэ хүсэлтийг боловсруулна; хуучин job-ийг хожуу replay хийж шинэ link-ийг дарж болохгүй. Шинэ token issue хийхэд хуучин active token SUPERSEDED болно. Password change/reset, account security epoch өөрчлөгдвөл өмнөх reset token тохирохоо болино.

Reset амжилттай үед password hash өөрчлөгдөж auth epoch нэмэгдэнэ; бүх hotel/device session invalid. Account/membership status, role, subscription өөрчлөгдөхгүй. Suspended account email-ээр password-оо шинэчилсэн ч suspended хэвээр бөгөөд login эрх сэргэхгүй. Invite ба reset token purpose хооронд солигдохгүй.

## Нууц token ба email boundary

`PRSYSTEM_LINK_KEY` нь secret manager-аас өгөх **base64 URL-safe encoded, дор хаяж 32 random byte** key. Source code, SQL migration, log эсвэл Git-д бодит key хадгалахгүй. Key байхгүй үед шинэ link endpoint-ууд 503; үндсэн login/session API ажиллана. API factory-ийн `token_key=` argument нь тест/dependency injection-д ашиглагдана.

Token = random 128-bit public ID + purpose-scoped HMAC-SHA256. Database нь зөвхөн бүтэн token-ийн SHA-256 hash, public ID, purpose, state болон expiry хадгална. Mail intent нь зөвхөн link ID; secret сэргээж илгээх key database-аас тусдаа байна. Token-ийг SQL/audit/access log-д эх утгаар нь хадгалахгүй.

Internal `prepare_delivery(link_id)` нь зөвхөн trusted mail adapter-д recipient/purpose/token envelope өгнө; public API route байхгүй. Recipient нь account-ийн canonical email. Revoked/superseded/expired token, stale membership revision-тэй invite, stale account epoch-тэй reset intent илгээгдэхгүй. Accept/complete үед permission/state gate-үүд дахин шалгагдана. Key тохирохгүй бол fail closed; буруу token илгээхгүй. Token/key нь envelope-ийн `repr`-д харагдахгүй.

`deliver(link_id, transport)` нь database lock-оос гадуур injected transport дуудаж, амжилтын дараа delivered acknowledgement хадгална. Exception гарвал retry хийх intent хэвээр; crash after send нь ижил нэг удаагийн token-ийг дахин хүргэж болно. Энэ нь at-least-once delivery бөгөөд exactly-once email гэсэн баталгаа биш. Delivery ба revoke зэрэгцсэн ч consume current state/expiry-ийг шалгана.

**Энэ milestone бодит email илгээгээгүй.** CI нь memory sink/failing transport ашигласан. Production-д approved provider, fixed HTTPS frontend URL, sender/template, retry/dead-letter worker болон monitoring холбоно. URL-ийг incoming Host header-аас байгуулахгүй. UI token-ийг API руу request body-оор дамжуулна; no-store/no-referrer хэвээр.

Key rotation хийхэд queued хуучин token-ийг derive хийх хуучин key хэрэгтэй. Одоогийн single-key implementation дээр key-ийг сольж queued intent-үүдийг орхихгүй: хуучин хүргэлтийг дуусгах эсвэл resend/reissue хийнэ. Өмнө хүргэсэн token нь stored hash, state, expiry-аар шалгагдах тул зөвхөн key солигдсоноор автоматаар revoke болохгүй. Versioned keyring/rotation runbook нь production gate.

## Migration ба grant

`003_staff_links.sql`-ийг existing migration runner owner credential-ээр apply хийнэ. `001`/`002` applied SQL өөрчлөгдөөгүй. [Staff API role-ийн өмнөх grants](30-staff-auth-api.md) дээр доорх шаардлагатай нэмэлтийг өгнө:

```sql
GRANT SELECT ON prsystem.staff_link, prsystem.staff_mail_intent, prsystem.password_reset_request,
    prsystem.staff_command_receipt TO prsystem_staff_api;
GRANT INSERT ON prsystem.staff_link, prsystem.staff_mail_intent, prsystem.password_reset_request,
    prsystem.staff_command_receipt, prsystem.staff_lifecycle_event TO prsystem_staff_api;
GRANT INSERT (id, email, password_hash, display_name) ON prsystem.staff_account TO prsystem_staff_api;
GRANT INSERT (tenant_id, account_id, status, roles) ON prsystem.staff_membership TO prsystem_staff_api;
GRANT UPDATE (verified_at) ON prsystem.staff_account TO prsystem_staff_api;
GRANT UPDATE (status) ON prsystem.staff_membership TO prsystem_staff_api;
GRANT UPDATE (state) ON prsystem.staff_link TO prsystem_staff_api;
GRANT UPDATE (delivered_at) ON prsystem.staff_mail_intent TO prsystem_staff_api;
GRANT UPDATE (processed_at) ON prsystem.password_reset_request TO prsystem_staff_api;
```

Role нь table owner/superuser/BYPASSRLS биш; audit/receipt rewrite, token hash өөрчлөх, cash write эрхгүй. Token consumption-д ашигласан UPDATE эрх нь public staff suspension endpoint байгаа гэсэн үг биш. Worker-ийг салгахдаа тусдаа minimum-grant credential хэрэглэнэ; request/link/email queue болон шинэ audit retention/cleanup deployment gate хэвээр.

## Acceptance ба үлдсэн ажил

22 шинэ integration тест: шинэ/хуучин account, canonical membership, replay/conflict, resend/revoke/expiry, package/role/tenant deny, accept-vs-resend болон duplicate create, reset session revoke, suspended account, stale/out-of-order reset job, purpose isolation, concurrent consume, delivery retry, wrong key, audit integrity, deferred commit rollback.

Primary Admin paid provisioning, Hotel Admin-аас staff reset email эхлүүлэх action, takeover/reassignment execution, denied-action security audit өргөтгөл, Restaurant invitation realm, actual email provider болон worker deployment дараагийн багц. Эдгээр дуусаагүй тул 2-р үе шат бүхэлдээ хаагдаагүй.

Reference: [OWASP password recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

Role/status mutation, scope session revoke, Primary хамгаалалт ба queue claim нь [дараагийн багцад](33-membership-work.md) нэмэгдсэн.

2026-09-07: Admin reset хүсэлт, unverified invite recovery, denied-action audit болон TLS mail worker [34-р contract](34-staff-recovery-mail-worker.md)-д нэмэгдсэн. Worker transport код нь бодит delivery/deployment acceptance-ийг орлохгүй.
