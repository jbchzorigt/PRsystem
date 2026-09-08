# Online booking — 4-р шатны domain суурь

2026-09-08. Бизнесийн эх сурвалж: docs/09 BK-DEC-012/013,
docs/11 PAY-DEC-001–010. Implementation: `src/prsystem/booking_policy.py`.

## Хэрэгжсэн

- `quote_nights`: зөвхөн эерэг бүхэл хоног, Улаанбаатарын календарь,
  ангилал → hotel default үнэ, config/source/version, immutable quote.
  Физик өрөөний override үнэ хүлээн авах параметргүй.
- `Contract`: hotel scope, explicit basis-point rate, version, хүчинтэй
  хугацааны exclusive төгсгөл. Default commission байхгүй.
- `cancel_confirmed`: 24 цагийн яг заагт free cancellation; late cancellation
  болон зөв cutoff-оос хойших no-show first-night fee; hotel cancellation бүтэн
  refund. Үр дүн нь одоогийн `SettlementFacts` руу шууд нийцнэ. Commission
  retained amount дээр нэг удаа ROUND_HALF_UP; 0₮ refund command шаардахгүй.
- `PaymentWindow`: 10 минутын deadline, gateway солиход үлдсэн хугацаа л
  ашиглагдана; цагийг буцаах/overflow/хугацаа дууссан invoice хоригтой.
- `capture_disposition`: provider-оор нотлогдсон capture-ийг replay, duplicate,
  late-after-expiry, cancelled-hold refund, active-hold confirmation гэж ялгана.
  Expired/cancelled booking-г дахин нээх шийдвэр үүсгэхгүй.
- `InventoryInterval` ба `unassigned_capacity`: half-open interval + өөрийн
  cleaning buffer. Хоёр физик өрөөний тасархай сул хугацааг нэг тасралтгүй
  booking-ийн availability болгохгүй; category reservation-ийг stay болгон
  атомикаар шилжүүлэх adapter нэг үүргийг хоёр удаа тоолохгүй байх contract-тай.

## Одоогийн хязгаар

Энэ milestone нь **pure domain rules**, database hold эсвэл guest API биш.
Function-ууд provider status query, guest authentication, public listing,
өрөөний lock, durable idempotency, captured ledger, refund/payout гүйцэтгэхгүй.
Тиймээс 4-р шат бүхэлдээ дууссан гэж тооцохгүй. Reception-ийн өмнөх booking mock
producer хэвээр; шинэ domain-ийг түүнтэй андуурч live authority болгохгүй.

`unassigned_capacity` нь conservative admission bound: хоорондоо давхцахгүй
боловч candidate-тэй давхцсан category reservations-ийг тус бүр нэг unit гэж
тооцож багтаамжийг дутуу харуулж болно. Энэ нь public exact availability count
биш. Нийтийн хайлтанд холбохын өмнө inventory adapter-аар нарийвчилна.
Eligible room жагсаалтыг сервер lifecycle/configuration policy-оор бэлдэнэ;
зөвхөн DIRTY төлөвтэй гэдгээр ирээдүйн inventory-г хасахгүй.

Payment expiry worker нь provider-ийг нэг удаа query хийгээд booking/category
lock дотор дахин уншсан төлөв дээр шийднэ. Superseded attempt-ийн capture-г
нуухгүй; эхний valid payment хэрэглэгдсэн эсвэл hold expired бол бүтэн refund
obligation үүсгэнэ. Эдгээр mutation, permission ба provider evidence checks нь
дараагийн persistence/service integration-ийн зайлшгүй шалгалт.

## Дараагийн implementation

1. Verified booker account ба нийтийн hotel/category listing-ийн authoritative эх үүсвэр.
2. Transactional category hold/booking repository, idempotency, expiry/status query,
   unique provider capture, late/duplicate refund obligation, immutable snapshots.
3. Reception category → physical room assignment; cancellation/no-show terminal
   inventory release; refund/commission/payout ledger ба batch worker.
4. Public search/detail/book/pay/manage UI, mock provider end-to-end болон concurrency CI.

## Шалгалт

`tests/test_booking_policy.py`: 24 шинэ domain тест. Contract tenant mismatch,
calendar/year boundary, overflow, exact deadline, immutable pricing,
zero-refund settlement, provider switch/replay/late capture, interval fragmentation
ба category-to-stay conservation-ийг шалгана. Local бүх suite-ийн дүн болон
PostgreSQL CI-ийн дүнг docs/31-д тусад нь тэмдэглэнэ.

Эцсийн баталгаа: [CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34186148437),
source `a8d4f4c0bfce3ba5a4dd762cc10fa47727da65a0`: **438 тест skip-гүй**,
298.411 секунд; browser/API-contract/design/token шалгалтууд амжилттай.
