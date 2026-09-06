# PRsystem

Hotel operations, online booking, subscription, restaurant болон тусгаарлагдсан Police portal-ийн систем.

Одоогийн milestone: **батлагдсан R01–R03 эрсдэлийн засвар + тесттэй domain core**. API, UI, PostgreSQL persistence, authentication болон бодит provider integration хараахан хэрэгжээгүй.

- [Шаардлагын baseline ба P1/EXT](docs/00-mvp-open-decisions.md)
- [Зөвшөөрсөн засвар, action/command contract](docs/27-approved-risk-controls.md)
- [Backend architecture, persistence contract, backlog](docs/28-backend-foundation.md)

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

Module input нь server-аас баталгаажсан фактууд байна. Authorization boolean, tenant/root холбоос, cash count эсвэл provider status-ийг browser request-ээс шууд дамжуулж болохгүй. Cash reducer-ийн үр дүнг production-д ашиглахын өмнө database transaction/CAS, ledger/source posting болон idempotency receipt-ийг атомикаар хадгалах adapter шаардлагатай.
