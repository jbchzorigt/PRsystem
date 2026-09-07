# Хөгжүүлэлтийн явц

**Шинэчилсэн:** 2026-09-07. **Branch:** `feat/approved-risk-controls`. **Review:** [Draft PR #1](https://github.com/jbchzorigt/PRsystem/pull/1).

## Нийт 6 үндсэн үе шат

Дугаар нь [backend backlog](28-backend-foundation.md)-ийн дараалал. **Одоогийн төв ажил: 2/6-р үе шат.** Энэ нь төслийн 33% дууссан эсвэл хоёр үе шат бүрэн хаагдсан гэсэн хэмжүүр биш. Хөндлөн суурийн ажлууд дараагийн module-тай хамт гүйцээгдэнэ; нийт жижиг task-ийн эцсийн тоог зохиож тогтоогоогүй.

| № | Үе шат | Одоогийн төлөв |
| --- | --- | --- |
| 1 | PostgreSQL, migration, tenant scope, idempotency, inbox/outbox | Кассын суурь, RLS, atomic persistence бэлэн. Booking persistence, provider inbox болон delivery worker үлдсэн |
| **2** | **Нэвтрэлт, ажилтны эрх ба lifecycle** | **Идэвхтэй:** auth/session, invitation/reset API бэлэн. Role/suspension/reactivation ба takeover queue claim нэмэгдсэн; бодит takeover execution, email холболт үлдсэн |
| 3 | Reception: өрөө, ээлж, deposit, check-in/out, cleaning, handover | Эхлээгүй; cash/domain суурийг ашиглана |
| 4 | Online booking, payment/refund/payout | Settlement domain rule бэлэн; booking/provider implementation үлдсэн |
| 5 | Minibar, Restaurant, Operation | Эхлээгүй |
| 6 | Police ба production readiness | Эхлээгүй; EXT, security/restore/load/retention gate-тай |

## 2-р шатны үлдсэн 9 багц — 3/9 дууссан; №9 final CI хүлээгдэж байна

Энэ тогтмол дугаарлалт нь 2026-09-06-нд хэрэглэгчид тайлбарласан үлдсэн 9 багц. Өмнөх 4/4 нь өмнөх implementation багцын явц байсан. Доорх тоо нь төслийн completion хувь биш.

| № | Ажил | Төлөв |
| --- | --- | --- |
| 1 | Бодит email transport/worker | Хэсэгчлэн: TLS SMTP, lease/retry/dead letter код болон тест нэмсэн; SMTP/sender, HTTPS page, deployment ба бодит хүргэлт хүлээгдэж байна |
| 2 | Paid onboarding → Primary Admin | Үлдсэн: OTP/ownership proof, authoritative provider payment, durable provisioning/activation |
| **3** | **Hotel Admin reset email хүсэлт** | **Дууссан:** canonical recipient, current scope/revision, idempotency, audit; бодит хүргэлт №1-ээс хамаарна |
| **4** | **Unverified suspended invite recovery** | **Дууссан:** ижил membership → PENDING, шинэ нэг удаагийн invite, mandatory reason, хуучин link/session revoke |
| 5 | Reception takeover execution | Үлдсэн: source/shift lifecycle, replacement, count/variance, pending item terminalization, close/new shift |
| 6 | Cleaner reassignment/continuation | Үлдсэн: бодит task/stock/room reference, assignment version, immutable movement ба remaining-action guard |
| 7 | Hotel/account/package-related recovery | Хэсэгчлэн: эрхгүй claimant-ийг current Manager авах API бэлэн; tenant lock-ийн billing/Platform recovery холболт үлдсэн |
| **8** | **Denied-action security audit** | **Дууссан:** 401/403 denial нь rollback-аас тусдаа хадгалагдана; raw request/secret агуулахгүй |
| 9 | Restaurant invitation/access realm | Код/26 тест бэлэн: restaurant identity/link, creator permission, тусдаа membership/session/invitation, lifecycle; final CI хүлээгдэж байна |

**3 дууссан + 2 хэсэгчлэн + 1 final CI хүлээж буй + 3 үлдсэн = 9.** Дуусаагүй код/интеграцийг blocker гэсэн нэрээр дууссан гэж тооцохгүй. SMTP credential хэрэгтэй хэсгээс гадна өөр хэрэгжүүлэх ажил байгаа; бүх үлдсэн ажил гадаад тохиргооноос блоклогдоогүй.

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
| **Нийт** | **164** |

API dependencies/`PRSYSTEM_TEST_ADMIN_DSN` байхгүй local run 134 тестийг skip хийнэ; 30 domain тест ажиллана. [Recovery CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34069208439) 127 тестийг skip-гүй амжилттай ажиллуулсан. [Mail worker орсон PostgreSQL CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34069567087) бүх 138 тестийг skip-гүй амжилттай ажиллуулсан.

№9-ийн contract: [Restaurant identity](35-restaurant-identity.md). Дараагийн хэрэгжүүлэлт: №5–6-ийн operational source/shift/task суурь; №1-ийн HTTPS acceptance UI болон SMTP deployment; №2/7-ийн payment/ownership/Platform recovery. Явцын update **«Үе шат 2/6 · Үлдсэн 9 багцаас X/9 дууссан»** гэсэн тогтмол хэмжүүрийг ашиглана.
