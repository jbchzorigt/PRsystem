# Operation ба subscription contact — implementation candidate

## Хэрэгжүүлсэн

`/operation` тусдаа Platform нэвтрэлттэй. Explicit permission бүр серверт
шалгагдана; account permission revision өөрчлөгдвөл session хүчингүй болно.
Idle 30 минут, absolute 8 цаг. Operation-ийн өөрчлөх үйлдэлд 10 минутын MFA;
өмнөх өндөр эрсдэлтэй Platform finance/security үйлдлүүдийн 5 минутын
илүү хатуу босго хэвээр.

Нэг as_of болон repeatable-read snapshot-аар нийт PROVISIONED буудал,
ACTIVE/EXPIRING/GRACE/EXPIRED/SUSPENDED, хэрэгжсэн багцын нийлбэр, paid боловч
идэвхжээгүй application, тухайн сарын SMS recipient-ийн сүүлийн төлөвийг
тооцно. Жагсаалт expiry/name/tenant дараалалтай, серверийн cursor pagination,
шүүлтүүртэй. Холбоо барих имэйл, утсыг масклана. Guest search байхгүй.

SMS нь draft → canonical recipient/quote preview → recent MFA + explicit
confirmation → durable job/recipient → worker урсгалтай. Текст 1–300 тэмдэгт;
давхардлыг normalized phone-оор хасна. Preview өөрчлөгдсөн contact/status/quote
эсвэл expiry дээр хүчингүй болно. Confirmation нь contact солих ажилтай
түгжээ хуваалцана. Хүлээн авагчийн алдаа бусад recipient-ийг зогсоохгүй.
UNKNOWN/SENDING interruption үед lookup хийж, сохроор дахин илгээхгүй.
Definitive FAILED дээр оператор ижил intent-ийн шинэ attempt хүснэ;
QUEUED recipient-ийг цуцалж болно. Үйлдэл бүрийн immutable event байна.

Development mock: 100 recipient cap, 3 attempt, UTF-16 70/67-unit tariff,
0₮ simulation quote. Эдгээр нь **CallPro-ийн бодит гэрээ, үнэ, SLA биш**.
Production adapter нь батлагдсан quote/encoding/throughput/retry contract-тай
байх ёстой. Mock gateway production startup-д хориглогдоно.

Primary Admin password reset нь canonical email рүү existing reset queue
үүсгэнэ; Operation имэйл эсвэл reset token авахгүй. Paid provisioning retry
өмнөх canonical onboarding workflow-г ашиглана. Payment reconciliation болон
subscription eBarimt нь immutable source/job snapshot-тай, recent MFA,
permission, reason, idempotency, bounded manual retry-тай. UNKNOWN tax receipt
lookup-only. Mock eBarimt нь **татварын хүчинтэй баримт биш**, бодит email
явуулахгүй; receipt amount/recipient-ийг client өөрчлөх боломжгүй.

`/subscription/contact`: Primary Admin password reauthentication, old+new
phone OTP, 5 минут, 60 секунд resend, 5 attempt, account/phone/IP throttling.
Contact version, proof, exception, notification history append-only.
Original onboarding contact өөрчлөгдөхгүй. Offline old-phone exception нь
`SUBSCRIPTION_CONTACT_CHANGE_APPROVE` + recent MFA + reason/reference-тай;
new-phone OTP заавал үлдэнэ. Өөрчлөлт old email + old phone notice outbox-той
нэг transaction-аар commit хийнэ. Notice worker ижил ID-г deduplicate хийнэ.

## Баталгаажуулалт ба зааг

- 9 policy/durable mock тест амжилттай.
- Operation Chromium: 7 API request, preview invalidation, lost-response retry,
  cancellation, canonical reset, receipt enqueue, 320px table overflow.
- Contact Chromium: 6 API request, primary login, reauthentication, two proofs,
  final confirmation, 320px layout. Хүсэлтүүд бодит API model-уудтай таарсан.
- 19 PostgreSQL acceptance тест нэмсэн; локалд PostgreSQL байхгүй тул
  **гүйцэтгээгүй**. RLS/trigger/locking/migration acceptance нь GitHub CI gate.
- Live provider acceptance, audited offline ownership evidence, approved
  retention matrix болон pilot measurements нь release gate хэвээр.

Development worker: `python -m prsystem.development operation-tick --limit 25`;
notice worker: `python -m prsystem.development contact-notices HOTEL_ID`.
Орчны тохиргоо нь existing development launcher-ийнхтай ижил. Нууц түлхүүр,
OTP болон credential-ийг audit/result-д хэвлэхгүй.

## Runtime эрхийн нэмэлт

Migration owner-ийг app credential болгон ашиглахгүй. Existing Platform grants
дээр `platform_session.last_seen_at` UPDATE хэрэгтэй. Operation service-д
subscription/onboarding/renewal projections SELECT, canonical password reset
INSERT, Operation immutable draft/job/recipient/event/billing/result/retry
SELECT+INSERT, delivery SELECT+INSERT+UPDATE өгнө. Delivery DELETE өгөхгүй.
Contact service-д tenant RLS дотор contact history SELECT+INSERT, зөвхөн
`subscription_contact_change.state` UPDATE хэрэгтэй; history UPDATE/DELETE
өгөхгүй. Exact restricted-role fixture grants нь `tests/operation_support.py`
болон `tests/test_subscription_contact.py`-д байна. Production runtime grants
нь PostgreSQL acceptance болон deployment security review-ээр баталгаажина.
