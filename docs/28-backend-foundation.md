# Backend foundation — эхний хэрэгжүүлэлт ба дараагийн gate

**Шинэчилсэн:** 2026-09-07
**Төлөв:** Domain core, PostgreSQL cash, staff lifecycle, Reception/Cleaner execution, paid onboarding/renewal, Platform MFA, SMTP worker болон email link UI хэрэгжүүлсэн. Room catalog болон initial opening source producer нэмэгдсэн. Бодит SMS/payment adapter/deployment-ийг mock болгон хойшлуулж, Reception stay/check-in source integration рүү шилжсэн. [Нийт 6 үе шатны явц](31-development-progress.md).

## Architecture decision

Нэг backend application дотор domain module-уудаа заагласан modular monolith ашиглана. Python 3.12+ domain core runtime dependency-гүй: subscription expiry policy, cash reservation state transition, settlement assessment/commission/batch time. PostgreSQL adapter optional dependency; staff transport нь FastAPI, password hashing нь Argon2id. Domain module-ууд HTTP framework-аас хамаарахгүй. Staff email-link form нь shared HTML/CSS/JavaScript ашиглана; үндсэн operational UI-ийн framework сонголт хараахан хийгдээгүй.

Production persistence target нь PostgreSQL; worker нь provider event inbox, transactional outbox, reconciliation болон export delivery ажиллуулна. Police нь commercial/hotel scope-оос тусдаа service identity, API boundary, key/access policy-тай байна. Final hosting/physical database isolation нь EXT-10-ын нөхцөлөөс хамаарна. Cash migration болон CI-ийн disposable PostgreSQL service нэмсэн; production database/credential/deployment үүсгээгүй.

`AccessFacts`, `Obligation`, `CashContext`, `SettlementFacts` нь **trusted adapter input**. HTTP body-оос эдгээр dataclass-ийг шууд байгуулж болохгүй. Domain gate дангаараа authentication, role matrix, approved refund/expense, provider verification эсвэл tenant isolation implementation биш.

## Persistence contract

Дараах нь нийт backend-ийн design contract. Cash хэсгийн хэрэгжүүлэлт, бусад үлдсэн хязгаарыг [29-postgres-cash.md](29-postgres-cash.md)-д тодорхойлсон.

| Aggregate/table | Identity / хамгаалалт | Transaction хамрах хүрээ |
| --- | --- | --- |
| Membership/permission | tenant + account unique; auth epoch/revision | Invite, role change, suspension, session invalidation |
| Subscription/obligation root | tenant + immutable root reference; recorded-at + state history | Boundary/revision, authoritative root eligibility |
| Cash location/shift | tenant + location; нэг location нэг active shift | Debit/reserve/confirm/cancel бүгд ижил balance lock |
| Transfer/reservation | tenant + transfer unique; pinned source/destination shift | Reserve creation; terminal paired posting + release |
| Cash ledger/source posting | tenant + movement/source reference unique; append-only | Financial source state, balance, audit болон ledger нэг commit |
| Idempotency receipt | tenant + command key unique; actor + payload fingerprint | Replay conflict check, state transition-тэй хамт хадгалах |
| Payment/refund/payout | provider + merchant + transaction unique; booking payable unique | Verified capture/refund, eligibility first event, conditional payout transition |
| Inbox/outbox | provider-event/source-event unique | Business commit ба durable delivery intent; retry/dead-letter |

Өгөгдлийн бүх foreign key-д same-tenant invariant хэрэгтэй. Application query scope + database policy давхар хэрэглэнэ. RLS ашиглавал runtime role table owner/superuser bypass-гүй байх нөхцөлийг тусад нь тестэлнэ.

Cash reducer immutable snapshot ашиглана. PostgreSQL adapter hotel cash root-ийн row lock ба expected revision-ийг хамтад нь хэрэглэнэ. Тухайн hotel's drawer projection, pending transfers, command-д хамаарах transfer/receipt/financial reference-ийг уншина; бүх түүхийг load хийхгүй. Нэг hotel's cash command-ууд дараалан commit хийнэ, өөр hotel-ууд тусдаа root lock-тай. Энэ хялбар serialization-ийн throughput-ийг P1-10 load gate дээр хэмжинэ; involved-row locking руу шилжих нь дараагийн optimization.

## Application command boundary

1. Authentication ба active account/membership-ийг сервер шалгана.
2. Role/package/action/resource scope, financial approval болон remaining obligation state-ийг database-аас шалгана.
3. Subscription gate-ийг immutable recorded-at root evidence-тай ажиллуулна.
4. Transaction дотор idempotency receipt, authoritative revision/balance/provider facts-ийг дахин уншина.
5. Domain transition/assessment хийнэ. Cash paired movement ба source state, audit, receipt, outbox нэг commit-д байна.
6. CAS/serialization conflict бол transaction rollback хийж bounded retry; stale client command-ийг шинэ balance дээр дахин validate хийнэ.
7. Provider network call-ийг урт cash/booking database lock дотор хүлээхгүй. Durable intent → verified outcome → transaction protocol ашиглана. UNKNOWN outcome-ийг success эсвэл failure гэж таахгүй.

Cash reducer-ийн `authorized` flag нь дээрх шалгалтууд **аль хэдийн** амжилттай болсны trusted үр дүн. PostgreSQL adapter нь transaction дотор mandatory `authorize` callback ажиллуулж, түүний үр дүнгээр domain flag-ийг тогтооно; caller-ийн boolean-д итгэхгүй. `SpendCash` generic domain debit нь public endpoint биш; expense/refund/customer type, approval болон source-state validation/posting application service-д хэрэгжинэ. System reconciliation нь тусдаа service principal; hotel role-оор system action дуудахгүй.

## Одоо шалгаж болох зүйл

Repository root-оос:

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
```

Тестүүд integer money/rounding, exclusive grace boundary, old-root allowlist, role/package/security/tenant deny, transfer reservation/count/shift binding, immutable failure, replay/payload conflict, unique cash source, stale revision, test-only concurrent CAS, zero-refund/other-hold settlement, Ulaanbaatar midnight/year boundary-г шалгана. Provider request болон бодит мөнгөн шилжүүлэг хийхгүй.

## Үлдсэн backlog ба release gate

| Дараалал | Ажил | Acceptance gate |
| --- | --- | --- |
| 1 | Cash adapter/migration/RLS/receipt/outbox intent нэмсэн; booking persistence, provider inbox, outbox delivery үлдсэн | Cash concurrency/commit-failure rollback integration tests; дараа нь last-room, process-crash recovery, delivery retry |
| 2 | Hotel/Restaurant staff identity, invitation/reset/recovery, protected membership mutation, queue claim, audit, mail worker нэмсэн; takeover/continuation, expiry completion, Platform MFA болон paid onboarding/renewal нэмсэн; бодит delivery, provider болон source integration үлдсэн | Tenant/revoke/throttling, invitation/reset, Primary guard, mutation/claim concurrency ба rollback tests; takeover/continuation/expiry, MFA болон provisioning/renewal tests; дараа нь live provider/source acceptance |
| 3 | Reception: room catalog/default tariffs ба initial opening нэмсэн; stay/check-in, deposit, checkout, cleaning, handover үргэлжилнэ | Synthetic end-to-end; old-obligation expiry completion; no new-sale bypass |
| 4 | Online booking/payment/refund/payout adapters | Last-unit concurrency; duplicate/late callback; zero-refund exactly-once eligibility; no duplicate payout |
| 5 | Minibar/Restaurant/Operation modules | Stock conservation, snapshot prices, task claim, refund/fulfillment state tests |
| 6 | Police + production readiness | EXT evidence, security test, restore/load drills, retention/key lifecycle |

P1-10-д ачааллын хэмжээ, p95, uptime, RPO/RTO болон provider outage procedure; P1-19-д Cleaner atomic claim; P1-09-д retention matrix-ийг architecture/pilot gate болгон эрт хаана. Тоон SLA, багийн хугацаа/төсөв, provider гэрээ энэ turn-д шинээр зохиож батлаагүй. EXT-01–11 бодит интеграцийн хязгаар хэвээр.
