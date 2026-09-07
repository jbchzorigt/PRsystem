# PRsystem

Hotel operations, online booking, subscription, restaurant болон тусгаарлагдсан Police portal-ийн систем.

Одоогийн ажил: **6 үндсэн үе шатны 2-р шат — staff identity/lifecycle**. Нэвтрэлт, invitation/reset, membership lifecycle, Restaurant identity дээр нэмээд Reception takeover, Cleaner continuation, Platform MFA recovery, paid onboarding/provisioning болон renewal-ийн серверийн хэрэгжилт нэмэгдсэн. Email-ийн дөрвөн веб хуудас бэлэн. Бодит provider transport, operational source producer болон production deployment бүрэн холбогдоогүй; **MVP бүрэн дуусаагүй**. [Явцын хүснэгт](docs/31-development-progress.md), [шинэ implementation ба үлдсэн integration gate](docs/36-staff-execution-and-onboarding.md).

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

Module input нь server-аас баталгаажсан фактууд байна. Authorization boolean, tenant/root холбоос, cash count эсвэл provider status-ийг browser request-ээс шууд дамжуулж болохгүй. PostgreSQL adapter cash projection, transfer, journal, receipt, outbox-ийг нэг transaction-д хадгална. Cash write endpoint гаргахаас өмнө бодит expense/refund source approval/posting, shift lifecycle болон command-specific authorization-ийг холбоно.

Staff API ажиллуулах:

```bash
python -m pip install '.[api]'
# Owner credential-ээр migration; minimum-grant app credential-ийг PRSYSTEM_APP_DSN-д тохируулна.
python -m prsystem.postgres.migrate
uvicorn prsystem.api:create_app --factory --host 127.0.0.1 --port 8000 --no-proxy-headers
```

Migration нь `PRSYSTEM_MIGRATION_DSN` хэрэглэнэ. Runtime grants, staff fixture/provisioning хязгаар болон HTTPS deployment нөхцөлийг [API contract](docs/30-staff-auth-api.md)-оос үзнэ.

Domain-only ажиллуулахад PostgreSQL тестүүд skip хийнэ. CI-ийн тусдаа `postgres` job бодит PostgreSQL 17 дээр бүх тестийг ажиллуулна; local ажиллуулах заавар [энд](docs/29-postgres-cash.md).
