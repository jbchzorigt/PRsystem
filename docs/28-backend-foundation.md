# Backend foundation — эхний хэрэгжүүлэлт ба дараагийн gate

**Огноо:** 2026-09-06
**Төлөв:** Domain core хэрэгжүүлсэн; persistence/API/UI болон production integration хийгдээгүй.

## Architecture decision

Нэг backend application дотор domain module-уудаа заагласан modular monolith-оор эхэлнэ. Эхний Python 3.12+ package runtime dependency-гүй: subscription expiry policy, cash reservation state transition, settlement assessment/commission/batch time. Эдгээр нь HTTP framework-аас хамаарахгүй тул батлагдсан дүрмийг эхэлж тестэлнэ. Transport framework болон frontend сонголт энэ commit-д хийгдээгүй.

Production persistence target нь PostgreSQL; worker нь provider event inbox, transactional outbox, reconciliation болон export delivery ажиллуулна. Police нь commercial/hotel scope-оос тусдаа service identity, API boundary, key/access policy-тай байна. Final hosting/physical database isolation нь EXT-10-ын нөхцөлөөс хамаарна. Энэ repository-д database server, credential, migration эсвэл production deployment үүсгээгүй.

`AccessFacts`, `Obligation`, `CashContext`, `SettlementFacts` нь **trusted adapter input**. HTTP body-оос эдгээр dataclass-ийг шууд байгуулж болохгүй. Domain gate дангаараа authentication, role matrix, approved refund/expense, provider verification эсвэл tenant isolation implementation биш.

## Persistence contract

Дараах нь migration бэлтгэх design contract; ажиллуулсан SQL schema гэж үзэхгүй.

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

Cash reducer энэ эхний хувилбарт immutable hotel snapshot ашиглана. Production adapter нь бүх hotel history-г command бүрд уншихгүй: involved locations/transfer, balance projection, receipt-ийг л authoritative байдлаар load хийнэ. Aggregate root-ийн CAS protocol эсвэл involved-row lock strategy-г сонгож, database integration-аар баталгаажуулсны дараа adapter нэмнэ. Pure function-ийг in-memory singleton-д хадгалаад web process олон болгохыг production implementation гэж үзэхгүй.

## Application command boundary

1. Authentication ба active account/membership-ийг сервер шалгана.
2. Role/package/action/resource scope, financial approval болон remaining obligation state-ийг database-аас шалгана.
3. Subscription gate-ийг immutable recorded-at root evidence-тай ажиллуулна.
4. Transaction дотор idempotency receipt, authoritative revision/balance/provider facts-ийг дахин уншина.
5. Domain transition/assessment хийнэ. Cash paired movement ба source state, audit, receipt, outbox нэг commit-д байна.
6. CAS/serialization conflict бол transaction rollback хийж bounded retry; stale client command-ийг шинэ balance дээр дахин validate хийнэ.
7. Provider network call-ийг урт cash/booking database lock дотор хүлээхгүй. Durable intent → verified outcome → transaction protocol ашиглана. UNKNOWN outcome-ийг success эсвэл failure гэж таахгүй.

Cash reducer-ийн `authorized` flag нь дээрх шалгалтууд **аль хэдийн** амжилттай болсны trusted үр дүн. `SpendCash` generic domain debit нь public endpoint биш; expense/refund/customer type, approval болон source-state validation-ийг adapter заавал нэмнэ. System reconciliation нь тусдаа service principal; hotel role-оор system action дуудахгүй.

## Одоо шалгаж болох зүйл

Repository root-оос:

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
```

Тестүүд integer money/rounding, exclusive grace boundary, old-root allowlist, role/package/security/tenant deny, transfer reservation/count/shift binding, immutable failure, replay/payload conflict, unique cash source, stale revision, test-only concurrent CAS, zero-refund/other-hold settlement, Ulaanbaatar midnight/year boundary-г шалгана. Provider request болон бодит мөнгөн шилжүүлэг хийхгүй.

## Үлдсэн backlog ба release gate

| Дараалал | Ажил | Acceptance gate |
| --- | --- | --- |
| 1 | PostgreSQL adapter, migrations, RLS/scope, inbox/outbox/idempotency | Real database concurrent last-cash/last-room test; crash rollback; unique posting |
| 2 | Authentication, membership/session revoke, explicit action permission | Hotel A → B access deny; suspended session/API/export deny; no client authorization flags |
| 3 | Reception vertical slice: room, open shift, deposit, check-in, checkout, cleaning, handover | Synthetic end-to-end; old-obligation expiry completion; no new-sale bypass |
| 4 | Online booking/payment/refund/payout adapters | Last-unit concurrency; duplicate/late callback; zero-refund exactly-once eligibility; no duplicate payout |
| 5 | Minibar/Restaurant/Operation modules | Stock conservation, snapshot prices, task claim, refund/fulfillment state tests |
| 6 | Police + production readiness | EXT evidence, security test, restore/load drills, retention/key lifecycle |

P1-10-д ачааллын хэмжээ, p95, uptime, RPO/RTO болон provider outage procedure; P1-19-д Cleaner atomic claim; P1-09-д retention matrix-ийг architecture/pilot gate болгон эрт хаана. Тоон SLA, багийн хугацаа/төсөв, provider гэрээ энэ turn-д шинээр зохиож батлаагүй. EXT-01–11 бодит интеграцийн хязгаар хэвээр.
