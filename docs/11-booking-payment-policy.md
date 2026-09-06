# Online Booking — Payment, Commission, Hold, Cancellation & No-show

**Хувилбар:** 1.0  
**Төлөв:** MVP gateway, hold/late-callback, cancellation/no-show, commission/rounding, refund, settlement болон overpayment хамгаалалт батлагдсан  
**Хамаарах үе шат:** MVP — Online Booking

## 1. Зорилго

Online room booking-ийн төлбөр платформд орсноос эхлэн commission тооцох, өрөөг төлбөрийн хугацаанд hold хийх, cancellation/no-show шийдвэрлэх болон буудалд net payout шилжүүлэх дүрмийг Restaurant болон subscription төлбөрөөс тусгаарлан тодорхойлно.

## 2. Батлагдсан мөнгөн урсгал

```text
Зочны booking төлбөр
  → Платформын merchant/зориулалтын данс
  → Гэрээний commission snapshot
  → Gateway fee = Платформын зардал
  → Hotel payable
  → Settlement дүрмийн дараа Hotel payout
```

Restaurant-ийн төлбөр Restaurant-ийн өөрийн merchant-д шууд ордог өмнөх дүрэм хэвээр бөгөөд online room booking ledger-т орохгүй.

## 3. Гэрээ бүрийн commission

- Тогтмол 5% default/fallback ашиглахгүй.
- 5% нь зөвхөн жишээ тооцоо байж болно.
- Буудал бүрийн хүчинтэй гэрээ commission rate-ийн explicit утгатай байна.
- Хувь хүн, байгууллага болон тусгай тохиролцсон тарифаас хамаарч rate өөр байна.
- Rate, policy/contract version болон commission base-ийг төлбөр баталгаажих үед snapshot болгоно.
- Дараа гэрээний хувь өөрчлөгдсөн ч өмнөх төлбөр, commission болон hotel payable-г дахин бодохгүй.
- Commission rate байхгүй эсвэл гэрээ хүчин төгөлдөр биш бол online booking нийтлэх, invoice үүсгэх болон төлбөр авахгүй.

```text
Commission base = Зочиноос бодитоор retained хийсэн VAT-inclusive room charge
Commission amount = ROUND_HALF_UP(Commission base × Contract rate snapshot)
Hotel payable = Commission base − Commission amount
Platform net revenue = Commission amount − Gateway/provider fee
```

Rate-ийг integer basis point-оор, бүх мөнгөн дүнг бүхэл MNT-өөр хадгална; floating-point ашиглахгүй. Full refund/hotel-caused cancellation-д commission base `0`. Late cancellation/no-show үед зөвхөн retained first-night fee commission base болно. Deposit, minibar, Restaurant болон бусад hotel-side төлбөр online booking commission base-д орохгүй.

## 4. 10 минутын payment hold

1. Зочин өрөөний ангилал сонгон төлбөр эхлүүлэхэд сервер тухайн category-ийн нэг unit inventory-д hold үүсгэнэ.
2. `hold_created_at` болон `hold_expires_at = hold_created_at + 10 минут` хадгална.
3. Үнэ, хугацаа, өрөөний ангилал болон төлөх дүнг snapshot болгоно.
4. Payment invoice/session hold дуусах цагаас хэтрэхгүй байна.
5. Зочин QPay эсвэл Khaan Bank gateway-ийн аль нэгийг сонгоно. Нэг мөчид нэг active payment attempt байна; provider солиход өмнөх attempt `SUPERSEDED` болж, шинэ provider invoice ижил hold-ийн үлдсэн хугацаанд үүснэ.
6. Callback/browser redirect/screenshot дангаараа баталгаа биш. Provider signature/reference шалгаад server-to-server status query-гаар `PAID`-ийг батална.
7. Callback болон expiry зэрэг ирвэл hold/booking мөрийг lock хийсэн эхний valid transaction ялна. Төлбөр баталгаатай бол hold `CONSUMED`, booking `CONFIRMED`; баталгаагүй бол hold/booking `EXPIRED` болж inventory шууд сулрана.
8. Expiry transaction provider status-ийг нэг удаа query хийсний дараа эцсийн шийдвэр гаргана.
9. Booking `EXPIRED` болсны дараах callback/capture booking-г дахин нээхгүй, inventory буцаан эзлэхгүй. Payment `PAID`, refund `REQUIRED`, reason `LATE_PAYMENT_AFTER_HOLD` болж бүтэн refund эхлүүлнэ.
10. Нэг provider payment/transaction ID зөвхөн нэг payment attempt-д хамаарна. Нэг booking дээр нэгээс олон attempt бодитоор төлөгдвөл эхний valid payment booking-д хэрэглэгдэж, бусад нь `DUPLICATE_CAPTURE` бүтэн refund obligation болно.

Hold үүсгэх, хугацаа дуусгах болон booking болгох ажиллагааг сервер/database түвшинд concurrency хамгаалалттай хийнэ. Нэг category-ийн үлдсэн capacity-г overlapping active hold/confirmed booking-ээс илүүгээр борлуулахгүй.

## 5. Cancellation framework

- Check-in-ээс **24 ба түүнээс олон цагийн өмнө** хэрэглэгч цуцалбал бүтэн refund хийнэ.
- Check-in-ээс **24 цагаас дотогш** хэрэглэгч цуцалбал fee нь `min(confirmed нийт room charge, first-night unit price)` байна; үлдсэнийг refund хийнэ.
- Цуцлалтын policy version, free-cancellation deadline, fee болон refund breakdown-ийг төлбөрийн өмнө харуулж booking дээр snapshot хадгална.
- `Цуцлалт хүссэн` нь шууд `Буцаагдсан` гэсэн үг биш. Provider буцаалтыг баталгаажуулсны дараа тусдаа Refund axis `REFUNDED` болно; captured Payment axis `PAID` хэвээр хадгалагдана.
- Cancellation transaction booking-г `CANCELLED_GUEST` terminal болгох мөчид inventory-г шууд суллана; refund provider дээр дуусахыг хүлээхгүй. Refund алдаа booking-г буцаан confirmed болгохгүй.

## 6. No-show framework

- Зочин төлөвлөсөн check-in өдөр/цагт ирээгүй гэдгээр шууд no-show болгохгүй.
- MVP no-show cutoff нь arrival date-ийн `23:59:59`, hotel local timezone байна.
- Cutoff өнгөрсний дараа Reception эсвэл Manager серверийн шалгалттайгаар no-show батална; автоматаар no-show болгохгүй.
- No-show fee нь late-cancellation fee-тэй адил `min(confirmed нийт room charge, first-night unit price)`; үлдсэнийг refund хийнэ.
- Check-in болон no-show зэрэг ирвэл booking row lock авсан эхний valid transition ялна.
- `NO_SHOW` terminal болох transaction-д inventory шууд сулрана; refund үр дүн booking state-ийг буцаахгүй.
- No-show болсон цаг, дүрэм, fee, хэрэглэгч/system actor болон inventory release аудитын түүхтэй байна.
- No-show policy-г төлбөрийн өмнө зочинд харуулж booking дээр snapshot хадгална.

## 7. Gateway/provider fee

- QPay/банкны gateway/provider fee-г платформ хариуцна.
- Fee-г зочны төлөх дүнд нэмэхгүй.
- Fee-г hotel net payout-аас хасахгүй.
- Provider fee-г payment ID, provider, дүн болон огноотой тусдаа ledger expense болгон хадгална.
- Платформын бодит net revenue нь commission-оос provider fee-г хассанаар гарна.

## 8. Settlement

- Stay `COMPLETED` болж actual checkout бүртгэгдэхэд тухайн booking-ийн retained room charge payout-д eligible болно.
- Guest cancellation/no-show terminal үед `refund_due = 0` бол Refund `NONE` хэвээр, provider refund command үүсгэхгүй; бусад санхүүгийн hold байхгүй бол retained fee нэн даруй eligible. `refund_due > 0` бол шаардлагатай бүх refund provider-оор дууссаны дараа eligible (`PAY-DEC-010`).
- Refund, chargeback эсвэл manual reconciliation non-terminal бол payout `HELD` байна.
- Өдөр `D`-д eligible болсон мөрийг `D+1` өдрийн `12:00 Asia/Ulaanbaatar` payout batch-д оруулна.
- Payout амжилтгүй бол хуучин мөрийг overwrite хийхгүй, шинэ retry attempt үүсгэнэ. Амралт/банк ажиллахгүйгээс саатсан нь eligibility-г өөрчлөхгүй.
- Payout дараа refund/chargeback/correction үүсвэл `ADJUSTMENT_DUE` сөрөг hotel payable болж дараагийн payout-аас суутгагдана; дараагийн payout байхгүй бол тусдаа receivable/manual reconciliation байна.
- Batch бүр gross payment, retained fee, refund, commission, adjustment, hotel payable болон bank reference-ээр тулгалттай байна. Нэг booking payable нэг successful payout-д л орно.

## 9. Санхүүгийн хамгаалалт

- Payment, commission, hotel payable, provider fee, refund, adjustment болон payout-ийг тусдаа immutable ledger event-ээр хадгална.
- Алдаа засахдаа өмнөх санхүүгийн мөрийг дарж өөрчлөхгүй; холбоостой reversal/adjustment үүсгэнэ.
- Client-ийн price, paid, fee, commission болон refund утгад итгэхгүй.
- Provider callback-ийн дараа server-to-server шалгалтаар payment/refund-ийг баталгаажуулна.
- Давхар callback, timeout болон retry нь давхар booking/refund/payout үүсгэхгүй.
- Payout-аас өмнө provider, platform ledger болон банкны орлогыг тулгана.
- Booking create/cancel, payment attempt/callback, refund request/attempt болон payout batch/write action бүр scope-тэй idempotency key ашиглана.
- Booking, hold, payment, refund болон payout төлөвийг нэг status талбарт холихгүй:

| Тэнхлэг | Canonical төлөв |
| --- | --- |
| Booking | `HOLDING`, `CONFIRMED`, `CHECKED_IN`, `COMPLETED`, `EXPIRED`, `CANCELLED_GUEST`, `CANCELLED_HOTEL`, `NO_SHOW` |
| Hold | `ACTIVE`, `CONSUMED`, `EXPIRED`, `CANCELLED` |
| Payment | `PENDING`, `PAID`, `FAILED`, `EXPIRED` |
| Payment attempt | `ACTIVE`, `SUPERSEDED`, `PAID`, `FAILED`, `EXPIRED` |
| Refund | `NONE`, `REQUIRED`, `PENDING`, `PARTIALLY_REFUNDED`, `REFUNDED`, `FAILED` |
| Payout | `NOT_ELIGIBLE`, `ELIGIBLE`, `HELD`, `BATCHED`, `PAID`, `FAILED`, `ADJUSTMENT_DUE` |

`SUPERSEDED` attempt шинэ invoice-д booking authority өгөхгүй боловч provider бодитоор capture хийснийг нуух terminal биш. Дараа verified capture ирвэл attempt `PAID` болж, booking-д өмнө хэрэглэгдсэн valid payment байгаа эсвэл hold expired бол `DUPLICATE_CAPTURE/LATE_PAYMENT_AFTER_HOLD` refund obligation үүсгэнэ; booking-г reopen хийхгүй.

## 10. Батлагдсан шийдвэрүүд

### PAY-DEC-001 — Contract-specific commission

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Буудал бүрийн хүчинтэй гэрээнд commission rate explicit байна; тогтмол 5% default ашиглахгүй.

### PAY-DEC-002 — Payment hold

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Inventory/payment hold нь сервер дээр үүссэнээс хойш 10 минут байна.

### PAY-DEC-003 — Cancellation/no-show framework

- **Төлөв:** `PAY-DEC-007`-оор тоон дүрэмтэй хаагдсан
- **Шийдвэр:** Check-in-ээс 24+ цагийн өмнөх cancellation бүтэн refund байна. 24 цагаас дотогших cancellation болон hotel-local arrival date-ийн 23:59:59-оос хойш эрх бүхий хэрэглэгчээр баталсан no-show нь first-night fee retained хийж, үлдсэнийг refund хийнэ.

### PAY-DEC-004 — Gateway fee

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Payment gateway/provider fee-г платформ хариуцаж, hotel net payout болон зочны төлбөрт нэмэхгүй.

### PAY-DEC-005 — QPay ба Khaan Bank gateway authority

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Online room booking QPay болон Khaan Bank gateway-ийг ижил provider-adapter contract-аар дэмжинэ. Нэг мөчид нэг active attempt байна; screenshot/redirect баталгаа биш, server-verified provider result л payment authority байна. Provider invoice/payment/transaction ID unique бөгөөд давтан callback idempotent байна.

### PAY-DEC-006 — Hold expiry ба late/duplicate capture

- **Төлөв:** Батлагдсан
- **Шийдвэр:** 10 минутын hold expiry/callback нэг booking row lock дээр өрсөлдөнө. Expiry status query-гаар payment батлагдаагүй бол booking terminal `EXPIRED` болж inventory сулрана. Дараах late payment booking-г reopen хийхгүй; бүтэн refund obligation үүсгэнэ. Нэмэлт duplicate capture мөн бүтэн refund obligation бөгөөд нэг captured transaction нэг л удаа ledger-т орно.

### PAY-DEC-007 — Cancellation/no-show тоон дүрэм

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Planned check-in-ээс 24+ цагийн өмнө guest cancellation бүтэн refund; 24 цагаас дотогш cancellation болон arrival date-ийн 23:59:59-оос хойш Reception/Manager баталсан no-show first-night unit price-ийг fee болгон retained хийж үлдсэнийг refund хийнэ. Terminal transition дээр inventory шууд суллаж, refund алдаа booking-г сэргээхгүй.

### PAY-DEC-008 — Commission base ба rounding

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Commission base нь guest-ээс бодитоор retained хийсэн VAT-inclusive room charge. Contract rate integer basis point snapshot бөгөөд commission-ийг `ROUND_HALF_UP` ашиглан бүхэл MNT-д нэг удаа тоймлоно. Full refund/hotel-caused cancellation base `0`; late cancellation/no-show retained first-night fee дээр commission бодно. Gateway fee платформын зардал хэвээр.

### PAY-DEC-009 — Settlement lifecycle

- **Төлөв:** Батлагдсан
- **Шийдвэр:** Completed stay эсвэл refund шаардлагагүй/шаардлагатай refund бүр дууссан cancellation/no-show-ийн retained payable `D+1 12:00 Asia/Ulaanbaatar` batch-д орно. Non-terminal refund/reconciliation payout-ийг hold хийнэ. Failed payout шинэ attempt-аар retry; payout дараах refund/chargeback immutable negative adjustment болж дараагийн payout-аас суутгагдана.

### PAY-DEC-010 — Zero-refund settlement eligibility

- **Төлөв:** 2026-09-06 хэрэглэгчийн зөвшөөрлөөр батлагдсан (R03).
- **Шийдвэр:** Нэг шөнийн late cancellation/no-show-д retained fee нийт төлбөртэй тэнцвэл refund_due=0; Refund NONE хэвээр, 0₮ provider command явуулахгүй. Terminal booking-ийн positive retained payable нь бүх refund obligation, chargeback болон reconciliation hold хаагдсан үед нэг удаа ELIGIBLE болно. Duplicate/late capture-ийн бусад нээлттэй obligation zero-refund shortcut-ийг хориглоно. Commission/eligibility immutable event, D+1 12:00 Asia/Ulaanbaatar batch хэвээр. Full refund/zero payable нь payout үүсгэхгүй; өмнө PAID болсон payable-г eligibility worker дахин нээхгүй.

## 11. Хаагдсан төлөв

Online booking-ийн gateway, hold/late callback, cancellation/no-show, inventory release, commission/rounding болон settlement-ийн P0 мөнгөн урсгал `PAY-DEC-005`–`PAY-DEC-009`-өөр хаагдсан. Provider merchant/refund/payout capability болон платформын төвлөрүүлсэн settlement-ийн хууль/гэрээний баталгаажуулалт production external gate хэвээр байна.

## 12. External verification note

QPay Merchant V2 нь invoice үүсгэх/цуцлах, callback-ийн дараа payment шалгах болон payment cancel/refund endpoint-уудтай. Гэхдээ production merchant төрөл, төвлөрүүлсэн settlement болон тодорхой payment төрлийн refund боломжийг QPay/банкны бодит гэрээгээр заавал баталгаажуулна: [QPay Merchant V2](https://developer.qpay.mn/mn/docs/merchant?version=2.0.0).

Платформ гуравдагч талын төлбөрийг өөрийн merchant/дансаар хүлээн авч цааш hotel payout хийх загварын гэрээ, зөвшөөрөл болон хариуцлагыг төлбөрийн үйлчилгээ үзүүлэгч, нягтлан болон хууль зүйн мэргэжилтнээр production-оос өмнө баталгаажуулна: [Үндэсний төлбөрийн системийн тухай хууль](https://legalinfo.mn/mn/detail/12668).
