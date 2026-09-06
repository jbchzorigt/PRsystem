# PRsystem

Hotel operations, online booking, subscription, restaurant болон тусгаарлагдсан Police portal-ийн систем.

Одоогийн milestone: **батлагдсан R01–R03 эрсдэлийн засвар, domain core, PostgreSQL cash persistence**. API, UI, authentication болон бодит provider integration хараахан хэрэгжээгүй.

- [Шаардлагын baseline ба P1/EXT](docs/00-mvp-open-decisions.md)
- [Зөвшөөрсөн засвар, action/command contract](docs/27-approved-risk-controls.md)
- [Backend architecture, persistence contract, backlog](docs/28-backend-foundation.md)
- [PostgreSQL migration, runtime role, integration tests](docs/29-postgres-cash.md)

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

Module input нь server-аас баталгаажсан фактууд байна. Authorization boolean, tenant/root холбоос, cash count эсвэл provider status-ийг browser request-ээс шууд дамжуулж болохгүй. PostgreSQL adapter cash projection, transfer, journal, receipt, outbox-ийг нэг transaction-д хадгална. Production-д ашиглахын өмнө authentication/authorization, бодит expense/refund source approval/posting, shift lifecycle болон outbox worker-ийг холбоно.

Domain-only ажиллуулахад PostgreSQL тестүүд skip хийнэ. CI-ийн тусдаа `postgres` job бодит PostgreSQL 17 дээр бүх тестийг ажиллуулна; local ажиллуулах заавар [энд](docs/29-postgres-cash.md).
