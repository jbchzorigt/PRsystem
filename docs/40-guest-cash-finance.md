# Reception guest cash ledger — v0.10.0

**Үе шат 3/6 · Reception багц 4/6, cash хэсэг.** Батлагдсан source: documents 20, 24, 05. Бодит provider-үүдийг mock-оор орлуулах хэрэглэгчийн шийдвэр хүчинтэй. Энэ continuation нь бэлэн барьцаа, cash payment, allocation, cash refund reserve/complete/release-г холбосон; provider/POS, alternate-channel болон financial correction хэсэг хараахан дуусаагүй.

## Check-in and deposit configuration

Manager (эсвэл 30,000₮ багцын Manager Plus) hotel default deposit-ийг 50,000–100,000 integer MNT хүрээнд тохируулна. Category override precedence авна; `null` бол hotel default руу шилжинэ. Hotel Admin болон Reception operational Manager permission-ийг автоматаар өвлөхгүй. CAS revision, idempotency, before/after audit-тай.

019 migration нь explicit `deposit_hotel_settings` / `deposit_category_settings` үүсгэнэ. Хуучин catalog-ийн `room_category.deposit` нь 0/invalid дүн зөвшөөрдөг байсан тул тэр талбарыг live санхүүгийн authority болгохгүй, чимээгүй migrate/rewrite хийхгүй. `/deposit-settings` API-аар зөв configuration үүсгэх шаардлагатай. Effective read API нь шинэ source/version-ийг өгнө; current UI integration дараагийн багцад байна.

Production walk-in check-in одоо дараах explicit cash declaration-тай ажиллана:

```json
"deposit": {"channel": "CASH", "amount_mnt": 60000, "received": true}
```

`received` нь эрхтэй Reception-ийн **бодитоор бэлэн мөнгө хүлээн авсан тухай мэдүүлэг**, provider success flag биш. Сервер өөрийн current OPEN shift/drawer, authoritative deposit amount, room readiness/interval, identity, active/grace/security-г шалгана. Source amount/version, actual/recorded time, charge болон deposit snapshot immutable. Cash receipt, initial deposit balance, room charge, typed cash event, projections, financial/cash outbox/audit, stay/identity/guest-code болон command receipt нь **нэг transaction**-д commit хийнэ. Алдаа/commit failure үед бүгд rollback болно. Backdate нь cash-ийг original shift эсвэл historical time руу шилжүүлэхгүй.

Funding байхгүй production check-in 503 хэвээр. QPay/card/POS-ийг CASH payload болгон submit хийх боломжгүй. Explicit development mock-ийн өмнөх funding-гүй `DEFERRED_MOCK` stay-г real ledger рүү adopt хийхгүй. Development/test runtime-д actual cash ledger-ийг туршвал snapshot `MOCK_CASH_LEDGER`; production runtime-д `CASH_LEDGER`. Runtime хооронд source adoption хаалттай. Development нь production мөнгө хөдөлгөхгүй.

## Ledger and conservation

`guest_finance` нь нэг stay-ийн versioned deposit aggregate. Immutable receipt/charge/allocation/refund source болон append-only financial event-үүдтэй; balance columns нь projection байна.

```
available deposit = received − reversed − allocated − refund_reserved − refunded
```

Aggregate болон original deposit receipt бүрд available >= 0; charge paid <= original charge. Cash drawer posted/reserved constraint давхар үйлчилнэ. Бүх money command authenticated, tenant-scoped, positive integer, finance revision + idempotency key-тай. Lock order: account → command receipt → cash book → stay → finance → source rows. Room/config check-in нь catalog → room lock-ийг өмнөх contract-оор авна.

- Initial deposit нь liability; room charge төлөгдсөн эсвэл орлого хүлээн зөвшөөрсөн гэж шууд үзэхгүй.
- Normal allocation нь original deposit receipt + exact existing charge-д хийгдэнэ. Reason, зураг, Manager approval шаардахгүй. Cash дахин нэмэгдэхгүй.
- Subsequent cash receipt (`purpose=PAYMENT`) нь exact existing charge-ийн unpaid amount-аас хэтрэхгүй, charge-д нэг удаа allocate хийнэ. Энэ нь deposit liability-г өсгөхгүй. Generic unbound receipt/charge үүсгэх API байхгүй; Minibar/approved-other-charge producer дараа холбогдоно.
- Financial statement нь exact aggregate/charge totals, эхний 100 receipt/charge/refund item-тай (`item_limit=100`). Full timeline/export pagination дараагийн UI/report integration; энэ endpoint-ийг full export гэж үзэхгүй. Guest raw identity, confirmation text, code эсвэл Police мэдээлэл өгөхгүй.

## Cash refund lifecycle

1. Reception original **cash deposit** receipt-ээс available amount reserve хийнэ. Original drawer-ийн current өөрийн OPEN shift шаардана. Deposit болон drawer cash availability хоёуланд reserve нэмнэ; posted cash/refunded amount өөрчлөгдөхгүй.
2. Existing `shift_obligation`-д pending cash refund root үүсэж shift close/takeover-г блоклоно. Existing cash spending/transfer нь drawer reserved balance-г ашиглаж чадахгүй.
3. Бодитоор буцааж өгсөн recipient confirmation-тай Reception `complete` хийнэ: reserved → refunded, posted cash буурч, pending shift obligation terminal болно. Confirmation нь encrypted; audit/receipt-д plaintext хадгалахгүй.
4. Cash бодитоор өгөгдөөгүй үед Manager/valid Manager Plus `release` хийнэ: `cash_not_handed=true` declaration + mandatory reason; хоёр reservation чөлөөлөгдөнө. Original refund history хэвээр. Reception/Hotel Admin дангаараа release хийхгүй.
5. Completed/released refund terminal. Retry ижил үр дүн буцаана; өөр key-ээр давхар complete/release хийхгүй. Cash-only API нь provider UNKNOWN/timeout/failure дээр reservation release хийх зам үүсгэхгүй.

Cash refund нь original drawer-ийн held shift дээр шийдэгдэнэ. Suspended cashier-ийн pending refund-ийг Manager зөвхөн not-handed release rule-аар шийднэ; cash handover нотлогдоогүй үед release гэж зохиохгүй. Alternate drawer/channel, provider late-success case болон correction/reversal нь дараагийн тусдаа canonical workflow шаарддаг.

Expiry lock-ын дараах allocation/payment/refund нь immutable `check_in_recorded_at`-тай өмнөх stay root-д тулгуурлана. Шинэ check-in нээгдэхгүй; security/account/membership/current-role хоригууд хэвээр.

## API

All routes are under `/hotels/{tenant_id}`.

| Method/path | Actor and purpose |
| --- | --- |
| PUT `/deposit-settings` | Manager hotel default; amount, expected_revision, key |
| PUT `/room-categories/{id}/deposit-settings` | Manager override/unset |
| GET `/room-categories/{id}/deposit-settings` | Reception/Manager effective source/version |
| POST `/stays/check-in` | Reception; optional explicit cash declaration now enables authoritative cash path |
| GET `/stays/{id}/finance` | Reception/Manager existing-obligation statement |
| POST `/stays/{id}/cash-receipts` | Reception received cash PAYMENT, charge_id, amount, revision/key |
| POST `/stays/{id}/deposit-allocations` | Reception original receipt_id, charge_id, amount, revision/key |
| POST `/stays/{id}/cash-refunds` | Reception original cash receipt_id, amount, revision/key |
| POST `/stays/{id}/cash-refunds/{refund}/complete` | Reception recipient_confirmation, revision/key |
| POST `/stays/{id}/cash-refunds/{refund}/release` | Manager reason, cash_not_handed=true, revision/key |

## Migration and grants

Apply owner migration 019 after 001–018; all applied migrations remain unchanged. Example additions after the existing Reception grants:

```sql
GRANT SELECT, INSERT ON prsystem.deposit_hotel_settings,
  prsystem.deposit_category_settings, prsystem.guest_finance,
  prsystem.guest_charge, prsystem.guest_receipt, prsystem.guest_allocation,
  prsystem.guest_refund, prsystem.guest_finance_event, prsystem.shift_obligation TO app_role;
GRANT UPDATE (amount_mnt, revision) ON prsystem.deposit_hotel_settings,
  prsystem.deposit_category_settings TO app_role;
GRANT UPDATE (revision, received, reversed, allocated, refund_reserved, refunded)
  ON prsystem.guest_finance TO app_role;
GRANT UPDATE (allocated, refund_reserved, refunded, reversed) ON prsystem.guest_receipt TO app_role;
GRANT UPDATE (paid_mnt) ON prsystem.guest_charge TO app_role;
GRANT UPDATE (state, completed_at, released_at, confirmation_envelope) ON prsystem.guest_refund TO app_role;
GRANT UPDATE (state) ON prsystem.shift_obligation TO app_role;
GRANT UPDATE (reserved) ON prsystem.cash_drawer TO app_role;
-- Row-lock privilege only; immutable stay trigger rejects snapshot mutation.
GRANT UPDATE (snapshot) ON prsystem.stay TO app_role;
```

Existing cash-only runtime roles also need `GRANT SELECT (tenant_id,id,drawer_id,shift_id,amount_mnt,state) ON prsystem.guest_refund TO cash_role;` so the adapter loads canonical pending refund holds. Missing source access must fail closed; never infer an unnamed reservation from a projection difference.

Cash tables retain FORCE RLS and immutable event/receipt history. New application tables use explicit tenant predicates and composite tenant/stay FKs, with column-scoped grants and immutable-source triggers. No runtime role may own tables or bypass RLS.

## Verification and remaining work

28 new tests: 6 dependency-free deposit/cash-hold policy, 22 PostgreSQL/API integration. Local: **327 discovered, 64 executed, 263 PostgreSQL-dependent skipped**. Initial CI on `4893b8c` ran 324 tests: 323 passed and the cross-module cash-spend test caught a missing refund source in CashBook validation. The fix adds explicit source-bound RefundHold records, preserves them across cash commands, and keeps the strict transfer + refund reservation sum invariant. Final source **`02013d6ea696113db68f5d5cdb304f1b75af0831`** passed **all 327 tests without skips in 120.297s**, plus Chromium browser, design and token checks: [final CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34102001483). Subsequent documentation-only commits preserve this tested implementation. Cases include production cash check-in, config precedence/unset/permissions, forged channels/confirmation, double-spend concurrency, duplicate refund, original drawer/current shift, expiry/security, cross-tenant FKs, immutable history, CashBook spending against refund holds, source simulation isolation, posting rollback and actual deferred-COMMIT failure.

Reception fixed count remains **2 complete, package 3 partial, package 4 partial, packages 5–6 pending**. Package 4 remaining: guest QPay/card/POS evidence/callback/reconciliation, alternate-channel approval, financial correction/reversal, provider release/late-success freeze and Platform MFA resolution, other charge producers and financial reporting. No fake provider success or financial correction is exposed to bypass these gaps.


v0.11 continuation: [cash correction, POS/provider payment mock, timeline](41-guest-corrections-and-provider-mocks.md) болон [checkout/cleaning](42-checkout-cleaning.md) нэмэгдэв. Энэхүү v0.10 contract-ийн original cash source/hold хамгаалалт хэвээр.
