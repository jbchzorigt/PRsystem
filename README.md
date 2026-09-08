# PRsystem

Hotel operations, online booking, subscription, restaurant болон тусгаарлагдсан Police portal-ийн систем.

Одоогийн milestone: **v0.12.0 · 3/6-р шат — Reception-ийн 6/6 багц дууссан**. Өрөө/тариф, анхны ээлж,
funded check-in, booking adapter, guest QR/session, санхүүгийн ledger/correction/refund,
checkout/cleaning/lifecycle, handover болон `/reception` дэлгэц холбогдсон.
[Зургаан багцын acceptance ба тестийн дүн](docs/43-reception-stage3-acceptance.md),
[явц](docs/31-development-progress.md), [mock ажиллуулах](docs/37-development-mocks.md).

Бодит гадаад үйлчилгээ хэрэглэгчийн шийдвэрээр **development mock** хэвээр.
Booking marketplace, full Minibar/Restaurant module болон Police/production readiness
нь дараагийн 4–6-р шат. Mock нотолгоо production санхүүгийн бүртгэл болохгүй.
Production cash check-in нь configured deposit, physical receipt болон identity vault
шаардана. Бодит provider acceptance/deployment нь тусдаа release gate.

- [Шаардлагын baseline ба P1/EXT](docs/00-mvp-open-decisions.md)
- [Зөвшөөрсөн засвар, action/command contract](docs/27-approved-risk-controls.md)
- [Backend architecture, persistence contract, backlog](docs/28-backend-foundation.md)
- [PostgreSQL migration, runtime role, integration tests](docs/29-postgres-cash.md)
- [Staff authentication ба API contract](docs/30-staff-auth-api.md)
- [Урилга, password reset, email delivery contract](docs/32-staff-invitations-reset.md)
- [Membership өөрчлөлт, Primary хамгаалалт, queue claim](docs/33-membership-work.md)
- [Admin reset, invite/claim recovery, security audit, mail worker](docs/34-staff-recovery-mail-worker.md)
- [Restaurant identity, invitation, session scope](docs/35-restaurant-identity.md)

## 4-р шатны эхний багц

Online booking-ийн хоногийн quote, гэрээний commission, cancellation/no-show,
10 минутын hold deadline болон capture decision-ийн domain суурь нэмэгдсэн.
[Implementation ба үлдсэн integration](docs/45-online-booking-policy.md).
Энэ багц database hold эсвэл нийтийн booking API-г нээхгүй.

## Шалгах

Python 3.12+ шаардлагатай. Domain тестүүд external package/database шаардахгүй. Linux/macOS:

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
```

Windows PowerShell:

```powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
```

`Asia/Ulaanbaatar` zoneinfo өгөгдөл OS дээр байх ёстой. Windows зэрэг IANA timezone database байхгүй орчинд `python -m pip install tzdata` хэрэглэнэ.

## Хэрэгжүүлсэн дүрэм

| Module | Үүрэг |
| --- | --- |
| `prsystem.subscription` | Grace дууссан ч өмнөх eligible obligation-ийг existing эрх дотор дуусгах; шинэ үйлчилгээг deny |
| `prsystem.cash` | Pending outgoing reservation, available balance, immutable transfer/debit, replay/revision guard |
| `prsystem.settlement` | Zero-refund eligibility, бусад hold, integer commission, D+1 local batch time |
| `prsystem.postgres` | Versioned migration, tenant RLS, cash transaction, append-only journal/receipt/outbox |
| `prsystem.auth`, `prsystem.api` | Staff password/session, scope revocation, login throttling, authorized cash read |
| `prsystem.restaurant_identity` | Creator/Manager Plus registration ба invitation, тусдаа Restaurant membership/session |
| `prsystem.membership` | Primary хамгаалалттай role/status, scope session revoke, atomic exception queue/claim |
| `prsystem.staff_lifecycle` | Canonical invitation, resend/revoke/accept, reset, secret-free email intent |
| `prsystem.cleaning`, `prsystem.shifts` | Immutable source/task continuation, physical count, takeover transfer/close/review |
| `prsystem.platform`, `prsystem.mfa` | Тусдаа Platform realm, TOTP replay guard, recent MFA ба security recovery |
| `prsystem.onboarding`, `prsystem.billing`, `prsystem.renewal` | Phone/owner proof port, paid provisioning, calendar renewal, floor/entitlement |
| `prsystem.mock_providers`, `prsystem.development` | Opt-in SQLite-backed OTP/payment/local-mail simulation; production factory reject |
| `prsystem.opening` | Configured float, atomic one-time INITIAL_FLOAT, physical opening, Admin variance review |
| `prsystem.rooms` | Same-tenant room/category catalog, versioned hourly/nightly tariffs, Reception read |

Module input нь server-аас баталгаажсан фактууд байна. Authorization boolean, expected balance, tenant/root холбоос эсвэл provider status-ийг browser request-ээс authority болгон дамжуулж болохгүй. Reception-ийн actual physical count бол зөвшөөрсөн input; expected/variance болон source/shift/permission-ийг сервер шалгана. PostgreSQL adapter cash projection, transfer, journal, receipt, outbox-ийг нэг transaction-д хадгална. Initial opening болон takeover write API бэлэн. Бусад expense/refund/customer cash write-д canonical source approval/posting, shift lifecycle болон command-specific authorization-ийг тусад нь холбоно.

Staff API ажиллуулах:

```bash
python -m pip install '.[api]'
# Owner credential-ээр migration; minimum-grant app credential-ийг PRSYSTEM_APP_DSN-д тохируулна.
python -m prsystem.postgres.migrate
uvicorn prsystem.api:create_app --factory --host 127.0.0.1 --port 8000 --no-proxy-headers
```

Migration нь `PRSYSTEM_MIGRATION_DSN` хэрэглэнэ. Runtime grants, staff fixture/provisioning хязгаар болон HTTPS deployment нөхцөлийг [API contract](docs/30-staff-auth-api.md)-оос үзнэ.

Domain-only ажиллуулахад PostgreSQL тестүүд skip хийнэ. CI-ийн тусдаа `postgres` job бодит PostgreSQL 17 дээр бүх тестийг ажиллуулна; local ажиллуулах заавар [энд](docs/29-postgres-cash.md).

Guest finance v0.11: [cash correction, POS болон provider mock contract](docs/41-guest-corrections-and-provider-mocks.md), [checkout/cleaning](docs/42-checkout-cleaning.md).

Reception v0.12: [API, QR, санхүү болон mock integration contract](docs/44-reception-integration-contract.md).
