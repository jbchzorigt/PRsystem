# Staff authentication ба эхний API

**Огноо:** 2026-09-06. **Хамаарах шаардлага:** [staff lifecycle](19-staff-account-lifecycle.md), [action matrix](18-action-level-permission-matrix.md), LIFE-DEC-008. Дараагийн нэмэлт invitation/reset API-г [32-staff-invitations-reset.md](32-staff-invitations-reset.md)-д тайлбарлав.

## Хэрэгжүүлсэн хүрээ

Python/FastAPI staff realm: verified account password login, hotel-scoped opaque session, logout, бүх төхөөрөмжөөс гарах, current password-аар баталгаажуулсан password change, өөрийн session/role мэдээлэл, Hotel Admin-ийн cash drawer balance read. Guest, Restaurant, Operation, Police realm-ийг энэ API-д оруулаагүй.

| Method / path | Шалгалт ба үр дүн |
| --- | --- |
| `GET /health` | Нууц мэдээлэлгүй liveness; database readiness биш |
| `POST /auth/login` | Email/password/tenant; verified active account + active membership; session secret зөвхөн энэ response-д |
| `GET /auth/me` | Current account/session/membership epoch/revision/expiry; өөрийн scoped role мэдээлэл |
| `POST /auth/logout` | Current token server-side revoke; expired/revoked token дээр idempotent |
| `POST /auth/logout-all` | Valid session; account auth epoch нэмэгдэж бүх hotel/device token хүчингүй болно |
| `POST /auth/password/change` | Valid session + current password; Argon2id hash шинэчлэгдэж бүх session хаагдана |
| `GET /hotels/{tenant_id}/cash/drawers` | Session-ийн tenant-тай ижил, Hotel Admin role, subscription/grace ба security gate; revision болон drawer posted/reserved/available |

Cash write endpoint байхгүй. Full financial visibility-г Manager/Manager Plus/Reception өвлөхгүй. Cash read нь report access тул grace дууссаны дараах old-obligation exception авахгүй; өмнөх completion domain policy өөрчлөгдөөгүй. `/auth/me` нь identity мэдээлэл болохоос operational entitlement/permission snapshot биш. Expired/security-suspended hotel-ийн active account login/me/logout боломжтой хэвээр.

JSON login body: `email`, `password`, `tenant_id`. Password change body: `current_password`, `new_password`. Бусад body field, тэр дундаа `authorized`, `roles`, `account_id`-г reject хийнэ. Protected endpoint нь `Authorization: Bearer <opaque token>` ашиглана; client-supplied authorization fact байхгүй.

## Session ба revoke

Session secret нь 32 random byte-аас URL-safe үүснэ, санд SHA-256 hash хадгална. Password нь Argon2id-аар хадгалагдана. JWT дахь хуучирсан role/status-д найдахгүй: хүсэлт бүр current account, session, membership-ийг санд дахин шалгана.

- Membership status/role өөрчлөгдөхөд DB trigger monotonic revision нэмнэ. Тухайн hotel-ийн хуучин session шууд invalid болно; өөр hotel session хэвээр.
- Account status/verified identity/password hash өөрчлөгдөхөд auth epoch нэмэгдэнэ. Password change болон logout-all нь бүх session-ийг хүчингүй болгоно. Password parameter rehash ч epoch нэмэгдүүлнэ.
- Reactivation хуучин token-ийг сэргээхгүй. Шинэ login шаардлагатай.
- Identity transaction-ууд account → session → membership → hotel lock order ашиглана. Membership/security change commit хийсэн бол дараагийн protected request/login хуучин эрхээр үргэлжлэхгүй. Өмнө нь lock авсан request эхэлж дуусч болно; revocation тэр transaction-тай serialize хийнэ.
- Session idle/absolute expiry нь database clock-оор exclusive шалгагдана. Expired session refresh хийхгүй.

`AuthSettings`-ийн staff implementation defaults: absolute 8 цаг, idle 30 минут; 5 минутын цонхонд email бүр 5, peer IP бүр 30 login оролдлого; шинэ password 12–128 тэмдэгт. Эдгээр нь staff implementation config бөгөөд Operation/Police-ийн өөр realm-ийн батлагдсан policy-г орлохгүй. `create_app(..., settings=AuthSettings(...))`-аар timeout/rate config өгнө; production policy/load target P1 gate хэвээр.

Rate counter PostgreSQL-д shared/atomic, failed login transaction-аас тусдаа commit хийнэ. App instance солих, X-Forwarded-For header эсвэл email солих нь email/IP counter-ийг тэглэхгүй. Fixed window дууссаны дараах дараагийн attempt counter reset хийнэ. Password change нь тусдаа token/IP throttle ашиглана.

Бүх response `Cache-Control: no-store`-той, cookie автоматаар үүсгэхгүй. Validation response нь input утгыг echo хийхгүй; database error нь generic 503. Login error account/email/membership байгаа эсэхийг текстээр ялгахгүй. Successful login/logout/password change болон role/subscription-аар хориглосон cash read нь append-only auth audit-тай; password/session secret хадгалахгүй.

## Migration ба runtime role

`002_staff_identity.sql` нь account, hotel access projection, membership, session, rate bucket, auth audit болон revocation triggers нэмнэ. Өмнө хэрэглэсэн `001_cash.sql` өөрчлөгдөөгүй; migration runner шинэ migration-ийг checksum/version-оор apply хийнэ.

Owner credential-ээр `python -m prsystem.postgres.migrate` ажиллуулна. Runtime API role нь NOSUPERUSER NOBYPASSRLS NOINHERIT, table owner/owner group биш байна. Доорх `prsystem_staff_api` role/credential-ийг administrator secret manager-аар тусад нь үүсгэнэ. Энэ нь cash command adapter-ийн write credential-ээс тусдаа minimum grant юм.

```sql
GRANT USAGE ON SCHEMA prsystem TO prsystem_staff_api;
GRANT SELECT ON prsystem.staff_account, prsystem.hotel_access, prsystem.staff_membership,
    prsystem.staff_session, prsystem.auth_rate_bucket,
    prsystem.cash_book, prsystem.cash_drawer TO prsystem_staff_api;
GRANT INSERT ON prsystem.staff_session, prsystem.auth_rate_bucket, prsystem.auth_event TO prsystem_staff_api;
GRANT UPDATE (password_hash, auth_epoch) ON prsystem.staff_account TO prsystem_staff_api;
GRANT UPDATE (last_seen_at, revoked_at) ON prsystem.staff_session TO prsystem_staff_api;
GRANT UPDATE (attempts, window_started) ON prsystem.auth_rate_bucket TO prsystem_staff_api;
-- PostgreSQL FOR SHARE requires an UPDATE privilege; no public mutation route is exposed.
GRANT UPDATE (revision) ON prsystem.staff_membership TO prsystem_staff_api;
GRANT UPDATE (security_suspended) ON prsystem.hotel_access TO prsystem_staff_api;
```

Identity tables нь tenant тогтоохоос өмнө credential resolve хийх private server schema. Cash tables-д RLS үргэлжилнэ; verified session-ийн tenant-ийг transaction-local setting болгоно. API database credential болон migration credential-ийг browser-д өгөхгүй. Shared identity schema нь credential compromise-оос tenant-уудыг физик тусгаарлах баталгаа биш.

Local server:

```bash
python -m pip install '.[api]'
# PRSYSTEM_APP_DSN нь restricted staff API role connection байна.
uvicorn prsystem.api:create_app --factory --host 127.0.0.1 --port 8000 --no-proxy-headers
```

Тест fixture нь disposable database-д synthetic verified account/membership үүсгэнэ. Production default user/password, public signup эсвэл staff-ийн өмнөөс password тохируулах endpoint байхгүй. Staff account activation нь invitation acceptance API-тай холбогдсон; бодит email transport болон анхны Primary Hotel Admin-ийн paid onboarding provisioning үлдсэн.

## Шалгалт ба үлдсэн gate

`python -m pip install '.[api,test]'` дараа isolated PostgreSQL-ийн `PRSYSTEM_TEST_ADMIN_DSN`-тэй `python -m unittest discover -s tests -v` ажиллуулна. CI нь cash болон staff API suite-уудыг тус бүр disposable database/restricted role-оор ажиллуулна.

22 staff API integration test: token hash, safe response, verified account, tenant scope, explicit Hotel Admin permission, scoped/global revoke, role change, password change, logout, idle/absolute expiry, subscription/security suspension, persisted login/IP throttle, concurrent suspension-vs-login, logout lock order, runtime grants болон unsafe owner connection rejection.

Invitation/resend/revoke/accept, password reset болон durable email intent нэмсэн. Үлдсэн ажил: бодит email transport/worker deployment, бодит takeover/reassignment execution, бүх operational action permission/shift/source validation, outbox delivery. Primary Admin хамгаалалттай membership mutation болон claim-only queue [33-р баримтад](33-membership-work.md) хэрэгжсэн. Rate/session row cleanup, auth failure monitoring/retention, request body/connection limits болон load/restore drills production gate хэвээр. Browser UI ороход token хадгалалт ба XSS/CSRF загварыг хамт шийднэ; token localStorage хадгалах default жишээ оруулаагүй.

Deployment нь HTTPS termination, тодорхой trusted proxy allowlist, request/connection limits-тэй байна. Proxy тохируулах хүртэл direct peer IP хэрэглэнэ; дурын forwarded header-д итгэхгүй. Бодит provider, MFA-required platform action эсвэл deployment хийгдээгүй.

Implementation references: [Argon2 password hashing](https://argon2-cffi.readthedocs.io/en/stable/howto.html), [FastAPI HTTP bearer security](https://fastapi.tiangolo.com/reference/security/).

401/403 security audit нь [recovery contract](34-staff-recovery-mail-worker.md)-ийн `GRANT INSERT ON prsystem.staff_denied_event` шаарддаг. Audit хадгалж чадахгүй бол API 503 буцаана.

Restaurant identity нэмэлт нь [35-р contract](35-restaurant-identity.md)-д байна. `staff_session` яг нэг Hotel эсвэл Restaurant scope-той; auth/denial reader-д `restaurant_membership` SELECT grant нэмнэ. Hotel API tenant scope-ийг заавал шаардана.
