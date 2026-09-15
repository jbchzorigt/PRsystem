# Үлдсэн ажлын candidate review — 2026-09-15

## Нийтлэх багц

| Багц | Үр дүн |
| --- | --- |
| Restaurant | Canonical захиалга/fulfillment/refund, checkout handoff, delayed notification/SLA, menu зураг/profile/цагийн хуваарь, тусдаа merchant ба durable mock reconciliation |
| Minibar partial rollback | Bounded physical movement, remaining apply, original baseline руу буцаалт, бодит final count, batch cancellation, original task/assignment ба immutable stock history |
| Operation | Explicit Platform permissions, idle/absolute session expiry, snapshot dashboard, keyset list, canonical SMS preview/confirm/outbox/retry, reset/provisioning/payment/eBarimt recovery |
| Subscription contact | Primary password reauthentication, old/new phone proofs, хязгаартай offline exception, versioned contact, old-contact notices, preview invalidation |
| Release бэлтгэл | Evidence validator, encrypted disposable restore drill, bounded local load measurement, read-only retention inventory, retention draft ба security/release runbook |

Бодит SMS/email/payment/eBarimt явуулаагүй. Provider-ууд зөвшөөрсөн mock
заагтай. Centralized cross-hotel Police guest tracking/wanted matching
хэрэгжүүлээгүй.

## Баталгаажуулалтын түүх

2026-09-14: 933 тестээс 152 локал тест давсан; 781 PostgreSQL skip.
23 Chromium suite, 22 request artifact дахь 159 хүсэлт бодит FastAPI model-уудтай
таарсан. Strict premium audit 0 finding; token/Python/JavaScript шалгалт давсан.
Browser HTTP mock нь PostgreSQL acceptance биш. SQL 074/075/076 parser нь
38/29/18 statement; live migration/RLS/locking баталгаа биш.

2026-09-15: workspace өмнөх snapshot-оос сэргэсэн тул алга болсон эцсийн
Restaurant request method artifact, release evidence strict-type guard,
хоёр negative тест, тайлан ба docs өөрчлөлтийг ярианы кодоос сэргээсэн.
Өмнөх `e8712d6` commit объект байхгүй тул сэргээсэн source шинэ commit авна.
Dependencies-гүй локал discovery: 933 тест, 146 pass, 787 skip; шинэ source-ийн
бүрэн CI-г нийтлэлийн дараа ажиллуулна. Өмнөх browser үр дүнг шинэ remote SHA-ийн
acceptance гэж тооцохгүй.

## Нийтлэл ба CI

Public remote baseline `9cc88a65079df371f7e39c1283b6f64f58da9d13`.
[CI 34823856657](https://github.com/jbchzorigt/PRsystem/actions/runs/34823856657)
нь эхний Restaurant 11 focused тестийг давсан ч full regression 30 минутын
cap дээр CANCELLED болсон. Шинэ workflow cap 60 минут; restore test нь
service container-ийн PostgreSQL 17 client ашиглана.

Өмнөх автомат approval review шинэ source tree-г public repository руу
upload хийхийг хориглосон. 2026-09-15-нд хэрэглэгч тодорхой багцыг public
`jbchzorigt/PRsystem`-ийн `feat/approved-risk-controls`, Draft PR #1-д нийтэлж,
PostgreSQL/restore CI ажиллуулах хүсэлтэд “үргэжлүүл” гэж зөвшөөрсөн.
Merge, production deployment, live provider илгээлт зөвшөөрөгдсөн scope биш.

## Production хүртэлх үлдсэн gate

Exact candidate-ийн PostgreSQL/restore CI; security review ба key/role/backup
recovery; баталсан pilot load/error/RPO/RTO хэмжилт; class-specific retention,
legal holds ба backup expiry/deletion; live provider contract/credentials/
acceptance. [Хэрэгсэл ба runbook](71-release-readiness.md) бэлэн боловч эдгээрийг
гүйцэтгээгүй байхад production-ready гэж тооцохгүй.
