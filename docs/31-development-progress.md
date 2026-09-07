# Хөгжүүлэлтийн явц

**Шинэчилсэн:** 2026-09-07. **Branch:** `feat/approved-risk-controls`. **Review:** [Draft PR #1](https://github.com/jbchzorigt/PRsystem/pull/1).

## Нийт 6 үндсэн үе шат

Дугаар нь [backend backlog](28-backend-foundation.md)-ийн дараалал. **Одоогийн төв ажил: 2/6-р үе шат.** Энэ нь төслийн 33% дууссан эсвэл хоёр үе шат бүрэн хаагдсан гэсэн хэмжүүр биш. Хөндлөн суурийн ажлууд дараагийн module-тай хамт гүйцээгдэнэ; нийт жижиг task-ийн эцсийн тоог зохиож тогтоогоогүй.

| № | Үе шат | Одоогийн төлөв |
| --- | --- | --- |
| 1 | PostgreSQL, migration, tenant scope, idempotency, inbox/outbox | Кассын суурь, RLS, atomic persistence бэлэн. Booking persistence, provider inbox болон delivery worker үлдсэн |
| **2** | **Нэвтрэлт, ажилтны эрх ба lifecycle** | **Идэвхтэй:** auth/session, invitation/reset API бэлэн. Role/suspension/reactivation, Restaurant identity, takeover/continuation execution, onboarding/renewal, Platform MFA болон link UI нэмэгдсэн; provider ба canonical operational source integration үлдсэн |
| 3 | Reception: өрөө, ээлж, deposit, check-in/out, cleaning, handover | Эхлээгүй; cash/domain суурийг ашиглана |
| 4 | Online booking, payment/refund/payout | Settlement domain rule бэлэн; booking/provider implementation үлдсэн |
| 5 | Minibar, Restaurant, Operation | Эхлээгүй |
| 6 | Police ба production readiness | Эхлээгүй; EXT, security/restore/load/retention gate-тай |

## 2-р шатны үлдсэн 9 багц — 4/9 дууссан

Энэ тогтмол дугаарлалт нь 2026-09-06-нд хэрэглэгчид тайлбарласан үлдсэн 9 багц. Өмнөх 4/4 нь өмнөх implementation багцын явц байсан. Доорх тоо нь төслийн completion хувь биш.

| № | Ажил | Төлөв |
| --- | --- | --- |
| 1 | Бодит email transport/worker | Хэсэгчлэн: TLS SMTP worker + дөрвөн link UI бэлэн; SMTP/sender, HTTPS deployment ба бодит хүргэлт үлдсэн |
| 2 | Paid onboarding → Primary Admin | Хэсэгчлэн: OTP/stored-owner proof ports, paid provisioning/activation, bounded worker бэлэн; бодит SMS/QPay/Khaan adapter, tax/eBarimt болон screening integration үлдсэн |
| **3** | **Hotel Admin reset email хүсэлт** | **Дууссан:** canonical recipient, current scope/revision, idempotency, audit; бодит хүргэлт №1-ээс хамаарна |
| **4** | **Unverified suspended invite recovery** | **Дууссан:** ижил membership → PENDING, шинэ нэг удаагийн invite, mandatory reason, хуучин link/session revoke |
| 5 | Reception takeover execution | Хэсэгчлэн: shift/takeover, replacement recovery, count/variance, transfer terminalization, close/new shift/review API бэлэн; expiry-locked close бэлэн; opening/payment producers болон reconciliation delivery үлдсэн |
| 6 | Cleaner reassignment/continuation | Хэсэгчлэн: source/task/stock, versioned reassignment, immutable continuation ба remaining-action guard бэлэн; canonical room/config/product/readiness/guest-charge producer integration үлдсэн |
| 7 | Hotel/account/package-related recovery | Хэсэгчлэн: claimant/replacement recovery, Platform MFA security resume, paid renewal/floor бэлэн; enrollment/provider deployment, offline account-email recovery procedure болон billing integration үлдсэн |
| **8** | **Denied-action security audit** | **Дууссан:** 401/403 denial нь rollback-аас тусдаа хадгалагдана; raw request/secret агуулахгүй |
| **9** | **Restaurant invitation/access realm** | **Дууссан:** restaurant identity/link, creator permission, тусдаа membership/session/invitation, lifecycle; 26 шинэ тест CI дээр амжилттай |

**4 бүрэн дууссан + 5 хэсэгчлэн хэрэгжсэн = 9.** Дуусаагүй код/интеграцийг blocker гэсэн нэрээр дууссан гэж тооцохгүй. Энэ удаа бүх таван багцад серверийн код нэмсэн. Гэхдээ source producer/integration code болон provider deployment-ийг unit test/mock амжилтаар дууссан гэж тооцохгүй. Бүх үлдэгдэл зөвхөн credential биш. Дэлгэрэнгүй: [implementation ба integration gates](36-staff-execution-and-onboarding.md).

[Recovery/worker contract ба minimum grants](34-staff-recovery-mail-worker.md). [Membership/queue boundary](33-membership-work.md).

## Тестийн бүрэлдэхүүн

| Suite | Тоо |
| --- | ---: |
| Domain: subscription/cash/settlement | 30 |
| PostgreSQL cash | 14 |
| Staff authentication API | 22 |
| Invitation/reset/email boundary | 22 |
| Membership/queue API | 25 |
| Recovery/security audit | 14 |
| SMTP transport | 4 |
| Mail worker PostgreSQL | 7 |
| Restaurant identity/access | 26 |
| Cleaner execution | 13 |
| Reception takeover execution/recovery | 12 |
| TOTP RFC vectors | 2 |
| Platform MFA/security recovery | 8 |
| Billing calendar/price | 3 |
| Paid onboarding/provisioning/API | 18 |
| Subscription renewal | 8 |
| **Нийт** | **228** |

API dependencies/`PRSYSTEM_TEST_ADMIN_DSN` байхгүй local run 193 тестийг skip хийнэ; 35 dependency-free тест ажиллана. [Recovery CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34069208439) 127 тестийг skip-гүй амжилттай ажиллуулсан. [Mail worker орсон PostgreSQL CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34069567087) бүх 138 тестийг skip-гүй амжилттай ажиллуулсан. [Restaurant identity эцсийн PostgreSQL CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34071168507) нийт **164 тестийг skip-гүй** амжилттай ажиллуулсан.

[v0.7.0 эцсийн CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34076421615) (`6bb5e70`) дээр **228 backend тест skip-гүй**, Chromium browser tests, design lint болон token check бүгд амжилттай. Энэ turn-д 64 backend тест нэмэгдсэн. Chromium CI нь дөрвөн purpose route, 204 success, давхар submit, password reveal, field/status focus, error/retry, 320px layout болон storage isolation-ийг шалгана.

№9-ийн contract: [Restaurant identity](35-restaurant-identity.md). Дараагийн ажил: docs/36 дахь canonical source producers, provider adapters/acceptance, deployment болон offline recovery policy gate. Явцын update **«Үе шат 2/6 · Үлдсэн 9 багцаас X/9 дууссан»** гэсэн тогтмол хэмжүүрийг ашиглана.
