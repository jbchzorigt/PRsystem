# Үлдсэн модулиудын acceptance — 2026-09-15

**Mock boundary-тай implementation баталгаажсан.**
[Source e2011fa3a9c8b956dd82620ec8b9b8f546e76c1d](https://github.com/jbchzorigt/PRsystem/commit/e2011fa3a9c8b956dd82620ec8b9b8f546e76c1d) ·
[Бүтэн CI 34936880122](https://github.com/jbchzorigt/PRsystem/actions/runs/34936880122).
Source tree `45ef45a65513b2d2808e324a5dca459fc6df9ece` нь PR CI-ийн merge tree-тэй яг таарсан.

## Баталгаажуулалт

| PostgreSQL багц | Тест | Skip | Хугацаа |
| --- | ---: | ---: | ---: |
| 0 | 194 | 0 | 247.992 секунд |
| 1 | 239 | 0 | 299.369 секунд |
| 2 | 244 | 0 | 446.027 секунд |
| 3 | 257 | 0 | 268.562 секунд |
| **Нийт** | **934** | **0** | Зэрэг ажилласан |

Шалгалт бүх discovered module-ийг яг нэг багцад онооно. Original test ID-ийн
олонлог ба давтамжийг дөрвөн багцын нийлбэртэй тулгана; нэг ч skip гарвал
acceptance fail болно. Шалгалтыг хасах, assertion сулруулах өөрчлөлт хийгээгүй.

**23 Chromium suite, 159 бодит API-model command** давсан. Domain, token,
design lint шалгалтууд амжилттай; design lint нь 0 error, өмнөх 6 warning-тай.
Browser HTTP mock нь database proof-ийг орлохгүй; дээрх PostgreSQL үр дүн тусдаа.

Өмнөх source `3ba4e5567fe5375ab5567a134efd6b828a792c22` нь
[933 тестийг skip-гүй 1087.717 секундэд](https://github.com/jbchzorigt/PRsystem/actions/runs/34935044711)
давсан. Тэр run-д шинэ модулиуд/restore-ийн 48 focused болон өмнөх бүх focused
gate мөн давсан. Эцсийн source нь SMS-ийн хоцорсон хариуны нэг шинэ тесттэй.

## Хэрэгжүүлсэн scope

- Restaurant захиалга, menu/image/profile/schedule, fulfillment/refund,
  delayed notification/SLA, checkout handoff ба durable mock reconciliation.
- Original task/assignment, baseline, stock/COGS history-тай bounded Minibar
  partial movement/remaining apply/compensating rollback, batch cancellation.
- Operation explicit permission/session limit, consistent dashboard/keyset,
  reviewed canonical SMS outbox/retry, canonical reset/provisioning/billing.
- Primary contact old+new OTP, restricted offline exception, versioned contact,
  immutable proof/history, old-contact notice ба recipient preview invalidation.
- Release evidence validator, encrypted restore, local load tool, read-only
  retention inventory ба production acceptance runbook.

## Илэрсэн алдааны засвар ба recovery proof

1. Platform fixture имэйлийг accepted syntax-д тааруулсан; validator сулруулаагүй.
2. Contact commit-ийн шинэ audit event-ийг forward migration **077**-оор
   bounded constraint-д бүртгэсэн. Contact, audit, notice атомикаар хадгалагдана.
3. Restaurant profile-ийн байхгүй helper дуудлагыг bounded reason validation-аар
   сольсон; хоосон шалтгаан болон permission denial-ийн тестүүд давсан.
4. Хуучин SMS attempt-ийн удаж ирсэн reply шинэ retry-ийн төлөв/provider ID-г
   өөрчлөхгүй. Тухайн interleaving-ийг PostgreSQL тестээр баталсан.

Restore test нь disposable synthetic fixture дээр AES-GCM encrypted backup,
data/migration checksums, identity-key decrypt, restricted non-superuser role
болон tenant RLS-ийг шалгасан. Production off-site backup/key custody/RPO/RTO
acceptance гэсэн утгатай биш.

## Release зааг

Бүх гадаад provider зөвшөөрөгдсөн **development mock** заагтай. Live SMS/email,
payment, татварын хүчинтэй eBarimt илгээгээгүй. PR draft хэвээр; merge болон
production deployment хийгээгүй. Centralized cross-hotel Police guest tracking/
wanted matching хэрэгжүүлээгүй.

Production-д live-provider contract/credential/acceptance, independent security
review, pilot load/RPO/RTO, approved retention/legal holds/deletion/backup expiry
шаардлагатай. [Release runbook](71-release-readiness.md). Энэ баримтыг нийтлэх
follow-up нь зөвхөн docs; дээрх accepted source нь application/test/CI code-ийн
баталгаажсан revision болно.
