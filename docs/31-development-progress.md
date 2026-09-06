# Хөгжүүлэлтийн явц

**Шинэчилсэн:** 2026-09-06. **Branch:** `feat/approved-risk-controls`. **Review:** [Draft PR #1](https://github.com/jbchzorigt/PRsystem/pull/1).

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

## Энэ удаагийн 4 багц ажил — 4/4

| № | Багц | Үр дүн |
| --- | --- | --- |
| 1 | Membership/Primary/takeover canonical дүрэм | Дууссан |
| 2 | Migration, service, API | Дууссан: role/status, scope revoke, atomic queue, Manager claim |
| 3 | Integration тест | Дууссан: 25 шинэ тест; нийт 113 тест бодит PostgreSQL CI дээр амжилттай |
| 4 | Баримт, CI, branch/PR | Дууссан: contract/grants/явц болон Draft PR шинэчлэгдсэн |

Claim нь касс тоолох, ээлж хаах эсвэл Cleaner ажлыг өөр хүнд шилжүүлсэн гэсэн үг биш. Source adapter-ууд, replacement/physical takeover, paid onboarding болон бодит email deployment үлдсэн. [Хэрэгжүүлэлтийн хязгаар ба contract](33-membership-work.md).

## Тестийн бүрэлдэхүүн

| Suite | Тоо |
| --- | ---: |
| Domain: subscription/cash/settlement | 30 |
| PostgreSQL cash | 14 |
| Staff authentication API | 22 |
| Invitation/reset/email boundary | 22 |
| Membership/queue API | 25 |
| **Нийт** | **113** |

`PRSYSTEM_TEST_ADMIN_DSN` байхгүй local run 83 integration тестийг skip хийнэ; 30 domain тест ажиллана. [PostgreSQL 17 CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34015694845) бүх 113 тестийг skip-гүй амжилттай ажиллуулсан.

Дараагийн ажил: actual source/shift integration, replacement selection, physical takeover/cleaning continuation, email delivery болон invite recovery. Явцын update мөн `үе шат N/6` болон тухайн багцын дууссан/нийт тоог харуулна.
