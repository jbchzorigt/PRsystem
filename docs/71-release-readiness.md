# Release readiness — хэрэгсэл бэлэн, production approval хүлээгдэж буй

Нийтлэлт болон production release нь тусдаа gate. Автомат approval review
өргөтгөсөн шинэ кодыг public GitHub руу оруулахыг хориглосон тул локал
implementation-ийг production-ready гэж тэмдэглээгүй.

## Бэлтгэсэн хэрэгслүүд

- `python -m prsystem.release_readiness MANIFEST --source-revision COMMIT`:
  exact source, artifact SHA-256, хугацаа, reviewer reference болон PostgreSQL,
  browser, security, restore, load, retention, live-provider нотолгоог шалгана.
  Missing, expired, skipped, mocked, mismatched evidence нь BLOCKED. Энэ нь
  deployment permission эсвэл хүний review-г орлохгүй.
- `scripts/restore_drill.py`: зөвхөн disposable `prsystem_test_*` source;
  шинэ `prsystem_restore_*` database; consistent exported snapshot; memory-only
  plaintext dump; AES-GCM encrypted backup; table data fingerprints болон
  migration checksum харьцуулалт. Existing database-д restore/drop хийхгүй.
  Source/admin DSN ба backup key нь environment-аар орно, argv/log-д орохгүй.
  Generic result нь role/key recovery-г PASS гэж зохиохгүй.
- `tests/test_restore_drill.py`: synthetic encrypted fixture restore,
  identity-key decryption, restricted non-superuser role ба tenant RLS-ийг
  тусад нь шалгана. CI дахь PostgreSQL 17 container-ийн client-ийг хэрэглэнэ.
  Локал PostgreSQL байхгүй тул энэ drill одоогоор ажиллаагүй.
- `scripts/load_drill.py`: зөвхөн explicit local pilot-ийн authenticated GET
  dashboard; bounded samples/concurrency, errors, median/p95. P95 budget-ийг
  заавал оруулна; production SLA-г зохиогоогүй. Хэрэглэгчийн load bearer нь
  environment-д, үр дүн нь тоон хэмжилтэд л хадгалагдана.
- `scripts/retention_inventory.py`: tenant-scoped, read-only тооллого;
  365 хоногоос хуучин хаасан байрлалтын identity тоо болон encrypted/lookup
  column inventory. PII, ID жагсаалт экспортлохгүй, мөр устгахгүй.
- `deploy/retention-matrix.json`: guest PII 365 хоног, export TTL 1 цагийн
  product default-ийг тэмдэглэсэн. Financial/audit/restaurant/SMS/account
  class-ийн хугацаа ба legal-hold/storage/backup handling батлагдаагүйг ил тод
  хадгална. Матриц батлагдахаас өмнө irreversible purge хэрэгжүүлэхгүй.

## Production-д шаардлагатай бодит нотолгоо

1. Exact candidate-ийн skip-гүй PostgreSQL CI, бүх browser/API/accessibility
   шалгалт. Өмнөх 30 минутын regression timeout-ийг давтахгүйн тулд PostgreSQL
   job cap 60 минут болсон; шинэ үр дүнг хүлээж байна.
2. Pilot dataset/concurrency, p95/error budget, outage/retry exercises,
   RPO/RTO болон uptime target-ийн баталгаа. Тоон target байхгүй үед drill
   үр дүнг SLA acceptance гэж тооцохгүй.
3. Encrypted off-site backup, recovery key custody, tested restore privileges,
   key rotation/old-key availability, deletion tombstones after restore.
   Application role нь migration owner/superuser/BYPASSRLS байж болохгүй.
4. Security review: auth realm separation, revocation, privileged MFA,
   RLS/direct-write/race cases, redacted audit, rate limits, HTTP headers,
   secret rotation, high/critical finding closure. Dependency pins alone are
   security acceptance биш.
5. Батлагдсан class-specific retention, legal holds, linked encrypted copies,
   backup expiry, data-subject request болон breach handling. Shared encryption
   key-г устгаад зөвхөн нэг зочны мэдээлэл арилсан гэж тооцохгүй.
6. QPay/Khaan, bank settlement, CallPro, email, identity-verification, eBarimt
   adapter/contract/credential/acceptance. Existing mock-ууд энэ gate-ийг хангахгүй.

Police-ийн centralized cross-hotel guest tracking/wanted matching rollout
идэвхжүүлэхгүй. Тухайн scope энэ implementation-д ороогүй.

2026-09-15 шинэчлэлт: public candidate нийтлэл ба PostgreSQL/restore CI-г
хэрэглэгч зөвшөөрсөн; [одоогийн review](72-remaining-work-review.md).
