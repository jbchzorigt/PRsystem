# Guest cash correction, POS ба provider mock — v0.11

Үе шат 3/6, Reception-ийн 4-р багцын үргэлжлэл. Cash receipt correction,
manual POS charge payment, QPay/Khaan charge-payment mock болон bounded financial
timeline хэрэгжүүлэв. Provider deposit/refund, alternate-channel refund,
late-refund reconciliation, POS/channel correction, checkout ба operational UI
энэ хувилбараар бүрэн болсон гэж тооцохгүй.

## Бэлэн мөнгөний залруулга

`POST /hotels/{hotel}/stays/{stay}/cash-corrections` — тухайн hotel-ийн current,
active verified Reception, өөрийн OPEN shift, original cash drawer шаардлагатай.

```json
{"receipt_id":"original","replacement_amount_mnt":50000,"reason":"Анхны дүнг буруу бүртгэсэн","expected_revision":1,"idempotency_key":"request-1"}
```

`POST /hotels/{hotel}/stays/{stay}/cash-corrections/{correction}/decision` — current
Manager эсвэл хүчинтэй Manager Plus. Hotel Admin-д operational role тусдаа.

```json
{"approve":true,"reason":"Баримт болон бодит тооллоготой тулгасан","expected_revision":2,"idempotency_key":"decision-1"}
```

- Нэг original receipt-д нэг PENDING хүсэлт; хүсэлт нь source allocation/refund
  болон тухайн shift-ийн хаалтыг блоклоно. Cash/deposit balance өөрчлөхгүй.
- Батлалт нь requester's current eligibility, original shift/drawer болон
  original source snapshot-ийг дахин шалгана. Requester эрхгүй болсон үед
  мөнгө post хийхгүй; Manager мөнгөн хөдөлгөөнгүйгээр reject хийж болно.
- Original immutable receipt → immutable reversal → replacement receipt.
  PAYMENT бол original allocation-ийг устгахгүй: linked allocation reversal
  болон шинэ allocation post хийж charge paid projection-ийг шинэчилнэ.
- Cash movement нь `replacement − original` net дүн. Хуучин receipt timestamp,
  check-in price/deposit requirement snapshot болон хуучин тайлангийн event-ийг
  overwrite хийхгүй. Audit, cash outbox, receipt, projections бүгд нэг commit.
- `replacement_amount_mnt=0` нь duplicate receipt-ийн reversal-only outcome;
  zero-value payment эсвэл refund үүсгэхгүй. Энэ нь мөнгийг зочинд өгсөн гэсэн
  бүртгэл биш: бодит cash handover нь refund API-ийн тусдаа үйлдэл.
- DEPOSIT дээр allocated/refund-reserved/refunded/reversed source байвал fail
  closed. PAYMENT дээр зөвхөн нэг exact charge-д бүрэн allocated cash receipt
  дэмжинэ. Downstream-used deposit, POS/provider/channel correction тусдаа
  implementation шаардлагатай; өмнөх history-г эвдэх bypass байхгүй.
- Rejection нь immutable terminal decision; шинэ хүсэлт тусдаа ID-тай байж
  болно. Duplicate approval/execution нэг receipt-ийг дахин reverse хийхгүй.

## POS ба mock charge payment

Эдгээр top-up нь existing charge-ийг төлнө. Анхны walk-in deposit requirement-ийг
орлуулах, шинэ unbound deposit liability үүсгэх endpoint биш.

| Method / stay prefix | Contract |
| --- | --- |
| POST `/pos-payments` | `charge_id`, positive integer `amount_mnt`, `reference`, `terminal_id`, offset-тай `transacted_at`, expected finance revision, idempotency key |
| POST `/payment-intents` | `charge_id`, amount, provider `QPAY`/`KHAAN`, expected finance revision, idempotency key; durable intent л үүсгэнэ |
| POST `/payment-intents/{intent}/reconcile` | Body `{}`; server mock invoice үүсгэх/дахин query хийх, verified success post хийх |
| GET `/finance` | Balance/charges/receipts/refunds дээр correction/reversal болон provider intents, pending amount нэмэгдсэн |
| GET `/finance/events` | `after_revision`, optional `through_revision`, `limit` 1–100; stable watermark бүхий keyset timeline |

POS reference/terminal-ийг trim/uppercase normalize хийнэ. Merchant scope нь
серверийн `POS:{tenant}`; өөр terminal/stay сонгон нэг reference-г давхар
ашиглахгүй. Transaction time нь charge үүссэн цагаас server current time хүртэл,
offset-тай байна. Баримтын original proof immutable; POS нь staff-ийн гар
бүртгэл бөгөөд integrated card provider success гэж нэрлэхгүй.

QPay/Khaan нь зөвхөн development/test + isolated `prsystem_dev*` эсвэл
`prsystem_test_*` database + `MockPaymentGateway`-тай ажиллана. Production
provider endpoint `503 GUEST_PROVIDER_UNAVAILABLE`. Development factory-ийн
хариу `X-PRsystem-Mode: MOCK_ONLY`; simulation receipt нь `MOCK_CASH_LEDGER`
stay-д л хамаарна. Live finance simulation stay-г adopt хийхгүй.

1. Reception payment intent үүсгэнэ; exact charge-ийн capacity болон original
   shift obligation PENDING болно. Энэ үед provider call, payment, cash movement
   байхгүй.
2. Reconcile нь DB transaction-оос гадуур persisted intent ID-гаар mock invoice
   үүсгэж/query хийнэ. Lost response/restart үед ижил ID давхар invoice үүсгэхгүй.
3. Local operator [mock CLI](37-development-mocks.md)-гаар payment state-ийг
   солино; public HTTP status/evidence payload байхгүй.
4. Дахин reconcile хийхэд merchant, invoice, amount/type, MNT currency, payment
   reference болон confirmed server time-ийг шалгана. Verified success нь
   receipt/evidence/allocation/charge projection/audit/shift terminalization-тай
   нэг commit. DB fail бол provider success хадгалагдаж, ижил capture retry болно.

`PENDING`, `UNKNOWN`, `FAILED`, `EXPIRED` нь charge capacity/shift hold-ийг суллахгүй.
Late success ирэх боломжтой тул өөр receipt тэр дүнг давхар төлөхгүй. Provider
refund/cancel-ийн authoritative release workflow энэ хувилбарт байхгүй.

POS болон provider payment нь кассын posted/reserved дүн, deposit liability-г
нэмэхгүй. Shared `billing_capture` key provider + merchant + payment reference
дээр onboarding/renewal/guest payment хооронд ч reuse хориглоно.

## Migration, grants, verification

Шинэ 020, 021 migration; 001–019-г өөрчлөөгүй. 020 нь immutable correction,
reversal source болон net cash event; 021 нь immutable non-cash evidence,
payment intent/charge hold болон shared capture namespace нэмнэ.

Restricted role-д өмнөх cash/guest grants дээр:

```sql
GRANT SELECT, INSERT ON prsystem.guest_correction,
  prsystem.guest_receipt_reversal, prsystem.guest_allocation_reversal,
  prsystem.guest_payment_intent, prsystem.guest_payment_evidence,
  prsystem.billing_capture TO application_role;
GRANT UPDATE (state,decider_id,decision_reason,decided_at)
  ON prsystem.guest_correction TO application_role;
GRANT UPDATE (invoice_id,state,last_provider_state,receipt_id)
  ON prsystem.guest_payment_intent TO application_role;
```

Cash allocation/payment одоо pending payment-intent capacity-г уншдаг тул
`guest_payment_intent` SELECT grant нь бүх guest-finance runtime-д хэрэгтэй.
Exact fixture: `tests/guest_finance_support.py`. History UPDATE/DELETE grant
өгөхгүй; owner ч immutable trigger-ийг тойрон edit хийхгүй.

Тестүүд: cash correction 15, POS/provider mock 12. Хуучин finance fixture-ийг
тест метод өвлүүлэхгүйгээр салгасан; duplicated test count үүсгээгүй. Concurrent
request/approval/reconcile, original source/tenant/role, pending source-spend
block, commit rollback, immutable SQL history, shared capture, lost response,
provider evidence, no cash effect болон timeline watermark хамрагдсан.
