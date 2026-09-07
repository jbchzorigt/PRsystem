# PRsystem

Hotel operations, online booking, subscription, restaurant болон тусгаарлагдсан Police portal-ийн систем.

Одоогийн ажил: **6 үндсэн үе шатны 3-р шат — Reception**. Staff lifecycle, takeover/continuation, onboarding/renewal, Platform MFA болон email link хуудсуудын суурь дээр room/category, тарифын тохиргоо ба анхны касс/ээлжийн нээлт, canonical cleaning readiness, immutable walk-in check-in, шифрлэсэн зочны мэдээлэл, cash deposit/payment/allocation/refund ledger нэмэгдсэн. Хэрэглэгчийн шийдвэрээр бэлэн болоогүй SMS/payment/email provider-ийг **development mock** горимоор орлуулж дараагийн хөгжүүлэлт рүү шилжсэн. [Явц](docs/31-development-progress.md), [mock ажиллуулах](docs/37-development-mocks.md), [Reception API](docs/38-reception-foundation.md), [walk-in check-in](docs/39-walkin-check-in.md), [guest cash finance](docs/40-guest-cash-finance.md). Production cash check-in нь зөв deposit тохиргоо, хүлээн авсан cash declaration болон identity vault-тай ажиллана; funding-гүй check-in хаалттай. Provider/POS integration үлдсэн; өмнөх төлбөргүй mock stay-г real finance рүү adopt хийхгүй. Бодит provider acceptance/deployment болон MVP-ийн үлдсэн урсгалууд дуусаагүй.

- [Шаардлагын baseline ба P1/EXT](docs/00-mvp-open-decisions.md)
- [Зөвшөөрсөн засвар, action/command contract](docs/27-approved-risk-controls.md)
- [Backend architecture, persistence contract, backlog](docs/28-backend-foundation.md)
- [PostgreSQL migration, runtime role, integration tests](docs/29-postgres-cash.md)
- [Staff authentication ба API contract](docs/30-staff-auth-api.md)
- [Урилга, password reset, email delivery contract](docs/32-staff-invitations-reset.md)
- [Membership өөрчлөлт, Primary хамгаалалт, queue claim](docs/33-membership-work.md)
- [Admin reset, invite/claim recovery, security audit, mail worker](docs/34-staff-recovery-mail-worker.md)
- [Restaurant identity, invitation, session scope](docs/35-restaurant-identity.md)

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
