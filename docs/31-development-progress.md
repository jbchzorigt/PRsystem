# Хөгжүүлэлтийн явц

**Шинэчилсэн:** 2026-09-07. **Branch:** `feat/approved-risk-controls`. **Review:** [Draft PR #1](https://github.com/jbchzorigt/PRsystem/pull/1).

## Нийт 6 үндсэн үе шат

Дугаар нь [backend backlog](28-backend-foundation.md)-ийн дараалал. **Одоогийн төв ажил: 3/6-р үе шат — Reception.** Энэ нь төслийн 50% дууссан гэсэн хэмжүүр биш. 2026-09-07-нд хэрэглэгч бодит API service-үүдийг mock болгоод дараагийн ажил руу шилжихийг зөвшөөрсөн; provider acceptance нь хойшлуулсан release gate байна. Хөндлөн суурийн ажлууд дараагийн module-тай хамт гүйцээгдэнэ; нийт жижиг task-ийн эцсийн тоог зохиож тогтоогоогүй.

| № | Үе шат | Одоогийн төлөв |
| --- | --- | --- |
| 1 | PostgreSQL, migration, tenant scope, idempotency, inbox/outbox | Кассын суурь, RLS, atomic persistence бэлэн. Booking persistence, provider inbox болон delivery worker үлдсэн |
| 2 | Нэвтрэлт, ажилтны эрх ба lifecycle | Суурь код ба development mock бэлэн: auth/session, invitation/reset API бэлэн. Role/suspension/reactivation, Restaurant identity, takeover/continuation execution, onboarding/renewal, Platform MFA болон link UI нэмэгдсэн; provider ба canonical operational source integration үлдсэн |
| **3** | **Reception: өрөө, ээлж, deposit, check-in/out, cleaning, handover** | **Идэвхтэй:** room/category/default tariffs, Reception read API болон configured float → initial opening, walk-in check-in, canonical cleaning/readiness, encrypted identity болон cash deposit/payment/allocation/refund хэрэгжүүлсэн; [6 implementation багцаас 2 бүрэн, 3 ба 4-р багц хэсэгчлэн](38-reception-foundation.md) |
| 4 | Online booking, payment/refund/payout | Settlement domain rule бэлэн; booking/provider implementation үлдсэн |
| 5 | Minibar, Restaurant, Operation | Эхлээгүй |
| 6 | Police ба production readiness | Эхлээгүй; EXT, security/restore/load/retention gate-тай |

## 2-р шатны үлдсэн 9 багц — 4/9 дууссан

Энэ тогтмол дугаарлалт нь 2026-09-06-нд хэрэглэгчид тайлбарласан үлдсэн 9 багц. Өмнөх 4/4 нь өмнөх implementation багцын явц байсан. Доорх тоо нь төслийн completion хувь биш.

| № | Ажил | Төлөв |
| --- | --- | --- |
| 1 | Бодит email transport/worker | Хэсэгчлэн: TLS SMTP worker + дөрвөн link UI + local mock mailbox бэлэн; SMTP/sender, HTTPS deployment ба бодит хүргэлт үлдсэн |
| 2 | Paid onboarding → Primary Admin | Хэсэгчлэн: OTP/stored-owner proof ports, paid provisioning/activation, bounded worker + durable SMS/QPay/Khaan mocks бэлэн; бодит SMS/QPay/Khaan adapter, tax/eBarimt болон screening integration үлдсэн |
| **3** | **Hotel Admin reset email хүсэлт** | **Дууссан:** canonical recipient, current scope/revision, idempotency, audit; бодит хүргэлт №1-ээс хамаарна |
| **4** | **Unverified suspended invite recovery** | **Дууссан:** ижил membership → PENDING, шинэ нэг удаагийн invite, mandatory reason, хуучин link/session revoke |
| 5 | Reception takeover execution | Хэсэгчлэн: shift/takeover, replacement recovery, count/variance, transfer terminalization, close/new shift/review API бэлэн; expiry-locked close бэлэн; configured float/initial opening producer нэмэгдсэн; payment producers болон reconciliation delivery үлдсэн |
| 6 | Cleaner reassignment/continuation | Хэсэгчлэн: source/task/stock, versioned reassignment, immutable continuation ба remaining-action guard бэлэн; canonical room cleaning/readiness producer нэмэгдсэн; checkout/config/product/guest-charge integration үлдсэн |
| 7 | Hotel/account/package-related recovery | Хэсэгчлэн: claimant/replacement recovery, Platform MFA security resume, paid renewal/floor бэлэн; enrollment/provider deployment, offline account-email recovery procedure болон billing integration үлдсэн |
| **8** | **Denied-action security audit** | **Дууссан:** 401/403 denial нь rollback-аас тусдаа хадгалагдана; raw request/secret агуулахгүй |
| **9** | **Restaurant invitation/access realm** | **Дууссан:** restaurant identity/link, creator permission, тусдаа membership/session/invitation, lifecycle; 26 шинэ тест CI дээр амжилттай |

**4 бүрэн дууссан + 5 хэсэгчлэн хэрэгжсэн = 9.** Дуусаагүй код/интеграцийг blocker гэсэн нэрээр дууссан гэж тооцохгүй. Өмнөх milestone бүх таван багцад серверийн код нэмсэн. Шинэ шийдвэрээр бодит provider-ийг mock горимоор орлуулж, source integration-ийг Reception/Minibar module-тай үргэлжлүүлнэ. Гэхдээ source producer/integration code болон provider deployment-ийг unit test/mock амжилтаар дууссан гэж тооцохгүй. Бүх үлдэгдэл зөвхөн credential биш. Дэлгэрэнгүй: [implementation ба integration gates](36-staff-execution-and-onboarding.md).

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
| Reception takeover execution/recovery/expiry | 21 |
| TOTP RFC vectors | 2 |
| Platform MFA/security recovery | 8 |
| Billing calendar/price | 3 |
| Paid onboarding/provisioning/API + mock integration | 20 |
| Subscription renewal | 8 |
| Development mock providers | 7 |
| Initial configured float/shift opening | 9 |
| Room catalog/tariffs | 9 |
| Stay duration/manual identity domain | 12 |
| Identity authenticated encryption | 4 |
| Walk-in check-in/readiness PostgreSQL | 19 |
| Deposit conservation/config/cash-hold domain | 6 |
| Guest cash finance PostgreSQL/API | 22 |
| **Нийт** | **327** |

Одоогийн local run: 327 discovered, crypto extra байгаа тул 64 executed, PostgreSQL-dependent 263 skipped. API/crypto extra байхгүй үед 60 dependency-free тест ажиллаж, бусад 267 skip хийнэ. [Recovery CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34069208439) 127 тестийг skip-гүй амжилттай ажиллуулсан. [Mail worker орсон PostgreSQL CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34069567087) бүх 138 тестийг skip-гүй амжилттай ажиллуулсан. [Restaurant identity эцсийн PostgreSQL CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34071168507) нийт **164 тестийг skip-гүй** амжилттай ажиллуулсан.

[v0.7.0 эцсийн CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34077680285) (`dce6585`) дээр **237 backend тест skip-гүй**, Chromium browser tests, design lint болон token check бүгд амжилттай. Тэр milestone-д 73 backend тест нэмэгдсэн. Chromium CI нь дөрвөн purpose route, 204 success, давхар submit, password reveal, field/status focus, error/retry, 320px layout болон storage isolation-ийг шалгана.

[v0.8.0 CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34084343027) (`336a14e`) дээр **264 backend тест skip-гүй**, Chromium browser болон design/token checks амжилттай. Энэ continuation нь mock providers, бодит onboarding integration, initial float/shift opening, room catalog/tariffs-ийн **27 шинэ тест** нэмсэн.

№9-ийн contract: [Restaurant identity](35-restaurant-identity.md). [Reception багц 3/6-ийн walk-in implementation](39-walkin-check-in.md) нэмэгдсэн. Online booking ба guest QR/session integration үлдсэн; дараагийн үндсэн ажил нь багц 4-ийн guest financial ledger/deposit/payment allocation/refund. Mock ажиллуулах заавар: [37-development-mocks.md](37-development-mocks.md). Явцын update **«Үе шат 3/6 · Reception-ийн 6 багцаас 2 бүрэн, 3-р багц хэсэгчлэн»** гэсэн хэмжүүрийг ашиглана; 2-р шатны анхны 9 багцын release acceptance тооллыг дээр өөрчлөлгүй хадгалав.

Walk-in financial gate: production check-in нь document 20-ийн шаардлагатай deposit satisfaction service холбогдох хүртэл 503. Development factory дахь explicit mock л `DEFERRED_MOCK` snapshot-тай simulation stay үүсгэнэ; payment/deposit received гэж бичихгүй. Энэ нь хэрэглэгчийн API service-үүдийг mock-оор орлуулж үргэлжлүүлэх шийдвэрийн хүрээнд байна.

[v0.9.0 эцсийн CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34094455494), source `2b3946b`, дээр **299 backend тест skip-гүй (111.816 секунд)**, Chromium browser/design/token checks бүгд амжилттай. Энэ continuation **35 шинэ тест** нэмсэн. Walk-in check-in нь development mock; production нь authoritative deposit service хүртэл хаалттай. Үндсэн тоолол: **6 Reception багцаас 2 бүрэн, 3-р багц хэсэгчлэн; 4–6 үлдсэн**.

## v0.10 cash finance continuation

[Cash contract](40-guest-cash-finance.md): hotel/category deposit setting → atomic cash check-in, deposit liability/room charge, cash payment, normal allocation, original-drawer refund reserve/complete болон Manager not-handed release хэрэгжсэн. Cash reservation нь өмнөх spend/transfer/shift-close guard-тай холбоотой. Production cash check-in authoritative funding-тай үед нээгдэнэ; unfunded болон unsupported provider/POS path хаалттай.

Тогтмол Reception тоолол: **2 бүрэн + 2 хэсэгчлэн (3, 4) + 2 үлдсэн (5, 6) = 6**. Багц 4-ийн provider/POS evidence, alternate-channel approval, correction/reversal, late provider reconciliation болон report integration үлдсэн. Эцсийн CI дүнг баталгаажуулсны дараа доор тэмдэглэнэ.
