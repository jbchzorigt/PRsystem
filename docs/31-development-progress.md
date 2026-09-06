# Хөгжүүлэлтийн явц

**Шинэчилсэн:** 2026-09-06. **Branch:** `feat/approved-risk-controls`. **Review:** [Draft PR #1](https://github.com/jbchzorigt/PRsystem/pull/1).

## Нийт 6 үндсэн үе шат

Дугаар нь [backend backlog](28-backend-foundation.md)-ийн дараалал. **Одоогийн төв ажил: 2/6-р үе шат.** Энэ нь төслийн 33% дууссан эсвэл хоёр үе шат бүрэн хаагдсан гэсэн хэмжүүр биш. Хөндлөн суурийн ажлууд дараагийн module-тай хамт гүйцээгдэнэ; нийт жижиг task-ийн эцсийн тоог зохиож тогтоогоогүй.

| № | Үе шат | Одоогийн төлөв |
| --- | --- | --- |
| 1 | PostgreSQL, migration, tenant scope, idempotency, inbox/outbox | Кассын суурь, RLS, atomic persistence бэлэн. Booking persistence, provider inbox болон delivery worker үлдсэн |
| **2** | **Нэвтрэлт, ажилтны эрх ба lifecycle** | **Идэвхтэй:** auth/session, invitation/reset API бэлэн. Role/suspension/reactivation, takeover, бодит email холболт үлдсэн |
| 3 | Reception: өрөө, ээлж, deposit, check-in/out, cleaning, handover | Эхлээгүй; cash/domain суурийг ашиглана |
| 4 | Online booking, payment/refund/payout | Settlement domain rule бэлэн; booking/provider implementation үлдсэн |
| 5 | Minibar, Restaurant, Operation | Эхлээгүй |
| 6 | Police ба production readiness | Эхлээгүй; EXT, security/restore/load/retention gate-тай |

## Энэ удаагийн 5 багц ажил — 5/5

| № | Багц | Үр дүн |
| --- | --- | --- |
| 1 | Урилга/reset-ийн canonical дүрэм шалгах | Дууссан: нэг membership, current token, package/role, existing account, session revoke |
| 2 | Migration ба service | Дууссан: `003_staff_links.sql`, hash-only token, receipt/audit/mail intent, async reset request |
| 3 | API | Дууссан: invite, resend, revoke, accept, reset request/complete |
| 4 | Integration тест | Дууссан: 22 шинэ тест; нийт 88 тест CI PostgreSQL 17 дээр амжилттай |
| 5 | Баримт, явц, branch/PR | Дууссан: contract, minimum grants, энэ явцын хүснэгт болон Draft PR шинэчлэгдсэн |

Бодит email илгээсэн гэж тооцоогүй: тест нь memory transport ашигласан. Email provider/worker deployment, Primary Admin paid onboarding, lifecycle mutation болон takeover нь дараагийн багцууд.

## Тестийн бүрэлдэхүүн

| Suite | Тоо |
| --- | ---: |
| Domain: subscription/cash/settlement | 30 |
| PostgreSQL cash | 14 |
| Staff authentication API | 22 |
| Invitation/reset/email boundary | 22 |
| **Нийт** | **88** |

`PRSYSTEM_TEST_ADMIN_DSN` байхгүй local run integration тестүүдийг skip хийнэ. [Бодит PostgreSQL дээрх CI шалгалт](https://github.com/jbchzorigt/PRsystem/actions/runs/34014542132) бүх 88 тестийг ажиллуулсан.

Дараагийн багц: Primary Hotel Admin-ийн хамгаалалттай role change, suspension/termination/reactivation; эдгээрийг open-work takeover/reassignment queue-тай нэг transaction-д холбох. Явцын дараагийн update мөн `үе шат N/6` болон тухайн багцын дууссан/нийт тоог харуулна.
