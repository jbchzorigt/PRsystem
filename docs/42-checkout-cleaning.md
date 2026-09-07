# Minibar-OFF checkout ба canonical cleaning — v0.11

Reception багц 5-ийн эхний implementation. Cash эсвэл MOCK_CASH_LEDGER stay-ийн
өр төлбөрийг бүрэн төлж, deposit-ийг allocate/refund хийж дууссаны дараа checkout
хийнэ. Room/category lifecycle, minibar-enabled checkout, guest session болон
ordinary handover/UI тусдаа үлдсэн ажил хэвээр.

| Method / path | Contract |
| --- | --- |
| POST `/hotels/{hotel}/stays/{stay}/checkout` | Current Reception + own OPEN shift; expected finance revision, idempotency key |
| GET `/hotels/{hotel}/cleaning/checkouts` | Current Cleaner; unclaimed болон өөрт assigned checkout cleaning, bounded keyset list |
| POST `/hotels/{hotel}/stays/{stay}/checkout-cleaning/claim` | Current Cleaner + idempotency key; нэг source нэг atomic claimant |
| POST `/hotels/{hotel}/cleaning/tasks/{task}/start` | Existing assigned Cleaner/version gate; room DIRTY → CLEANING |
| POST `/hotels/{hotel}/cleaning/tasks/{task}/post` | Existing source/action/version gate; physical CLEAN completion → room CLEAN |

Checkout нь client time/paid flag/balance/retention policy авахгүй. Unpaid charge,
unused deposit, pending refund/correction/provider intent эсвэл frozen finance
байвал 409. Cash/top-up/allocate/refund бүгд өмнөх source-bound API-аар terminal
болсон байна. Original check-in amount, deposit requirement, duration, planned
end болон source snapshot өөрчлөгдөхгүй; early departure automatic refund,
late departure automatic fee үүсгэхгүй.

Account → receipt → cash book → catalog → room → stay/finance → shift/work гэсэн
дарааллаар lock хийнэ. Нэг commit дотор:

- stay CLOSED + actual_checkout_at нь server clock;
- room DIRTY, revision нэмэгдэнэ;
- initial guest code-ууд revoke;
- immutable financial snapshot/checkout event;
- 365 хоногийн MVP retention policy version/days/expiry snapshot;
- 25k/30k package-д exact stay/room/version/buffer snapshot-тай CHECKOUT cleaning
  source, нэг CLEAN action, OPEN room bridge;
- command receipt болон audit

хадгална. Checkout нь cash movement үүсгэхгүй. DB алдаа гарвал бүгд rollback.
Retention deletion/legal-hold worker болон production policy override энэ
implementation-д ороогүй; snapshot нь тэдгээрийн future source болно.

25k/30k cleaning source эхлээд unclaimed; Cleaner queue-оос атомикаар claim
хийнэ. Давхар claim нэг л owner-той; owner membership suspended бол existing
staff-work exception/continuation guard үйлчилнэ. Canonical checkout source
ID-г immutable stay checkout-той тулгаж, pre-lock stay-ийн completion-д
subscription expiry-гийн нарийн allowlist хэрэглэнэ. Security suspension болон
current role/package шалгалтыг алгасахгүй. Existing initial/configuration
cleaning source энэ completion root-ийг зээлж ашиглахгүй.

20k package-д Cleaner source үүсгэхгүй. Room DIRTY хэвээр; existing Manager
`/rooms/{room}/manager-clean` flow ашиглана. Тэр setup endpoint-ийн expired
hotel completion болон lifecycle integration нь дараагийн gate хэвээр.

`earliest_ready_at` нь actual checkout + original cleaning buffer-ийн доод
хязгаар. Үүнээс гадна actual CLEAN, room/category ACTIVE болон interval conflict
шалгана. Cleaning эрт дууссан ч buffer өнгөрөөгүй өрөөнд check-in хийхгүй.
RETIRING room-ийн өмнөх checkout cleaning-г дуусгаж болно; шинэ initial cleaning
request нь ACTIVE room шаардсан хэвээр.

Migration 022 нь append-only `stay_checkout`; original stay/finance/room/shift,
financial event revision болон cleaning source-д same-tenant FK-тай.
Restricted role-ийн нэмэлт grants:

```sql
GRANT SELECT, INSERT ON prsystem.stay_checkout TO application_role;
GRANT UPDATE (state,actual_checkout_at) ON prsystem.stay TO application_role;
GRANT UPDATE (revoked_at) ON prsystem.stay_guest_code TO application_role;
```

Cleaner task completion нь canonical checkout root-ийг уншихад `stay_checkout`
SELECT ба stay-ийн tenant/id/check_in_recorded_at SELECT шаардлагатай. Өмнөх
cleaning source/action/task/work grants хэвээр. Exact runtime fixture нь
`tests/guest_finance_support.py`.

`tests/test_checkout.py`: 9 PostgreSQL/API tests — atomic checkout, cash/price/end
unchanged, retention/code revocation, financial guards, exact cleaning source,
claim concurrency/queue scope, original-root expiry completion, buffer,
rollback болон immutable history.
