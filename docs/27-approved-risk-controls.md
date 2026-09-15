# 2026-09-06 — Зөвшөөрсөн эрсдэлийн засварууд

**Төлөв:** Батлагдсан. Хэрэглэгч өмнөх аудитын саналуудыг зөвшөөрсөн. Энэ баримт R01–R03-ын implementation contract-ийг тодруулна; P1/EXT production gate-ууд хэвээр.

| Эрсдэл | Шийдвэр | Canonical эх сурвалж |
| --- | --- | --- |
| R01: subscription hard lock | Өмнөх үүргийг нарийн эрхээр дуусгана | [LIFE-DEC-008](./17-subscription-lifecycle.md), [RBAC matrix §7](./18-action-level-permission-matrix.md) |
| R02: pending cash transfer | Source reservation, available balance, atomic terminal posting | [CASH-DEC-011](./24-cash-drawer-ledger.md) |
| R03: 0₮ refund | Refund NONE, бусад hold байхгүй бол eligible | [PAY-DEC-010](./11-booking-payment-policy.md) |

## Hard lock action/root contract

`locked_at = expires_at + 48 цаг`. Boundary-оос **өмнө** эхэлсэн root л eligible. Root-ийн эхэлсэн timestamp, tenant, state history, parent холбоосыг сервер хадгалсан event-ээс гаргана. Client-ийн `existing`, `eligible_at_lock`, `authorized`, `role` boolean, parent ID эсвэл backdated actual time-д итгэхгүй.

| Domain action | Шаардлагатай root | Boundary дээрх баталгаа |
| --- | --- | --- |
| `stay.checkout`, `stay.settle`, `stay.checkout_report`, `stay.dispute_resolve` | Check-in хийсэн stay | Immutable recorded-at нь lock-оос өмнө, эхэлсэн үйлчилгээний үлдсэн үүрэг |
| `restaurant.order_complete` | Paid Restaurant order | Lock-оос өмнө confirmed/paid; remaining fulfillment/handoff |
| `payment.refund` | Stay, paid order эсвэл payment intent | Өмнөх root-тэй холбоотой approved/mandatory refund; late capture ч root intent-ээр нотлогдоно |
| `cash.transfer_finish` | Pending transfer | Lock-оос өмнө initiated, terminal болоогүй байсан |
| `cash.shift_close` | Open shift | Lock-оос өмнө open; close/handover/continuation зөвхөн үлдсэн obligation-д |
| `obligation.detail` | Дээрх root-ийн аль нэг | Зөвхөн terminalization-д хэрэгтэй field; bulk report/export биш |
| `system.reconcile` | Өмнөх root payment/stay/order/transfer/shift | Explicit service identity + permission + original root reference |
| `subscription.renew`, `help`, `logout` | Root шаардахгүй | Existing canonical account/role policy; renewal нь suspension-ийг арилгахгүй |

Шинэ booking, шинэ check-in (өмнө confirmed reservation байсан ч), шинэ order, config/rollout, ердийн export нь lock-ийн дараа хаалттай. Allowlist-ийн action бүр existing role/package, resource scope/state болон account/membership active шалгалтыг давна. Hotel security suspension operational continuation эрх нээхгүй; OPS-ийн дагуу эрхтэй active account renewal/support ашиглаж болох боловч hotel access автоматаар сэргэхгүй.

Child checkout report, refund obligation, reconciliation task нь lock-оос хойш үүссэн байж болно. Adapter тухайн child-ээс original eligible root хүртэл серверээр холбоосыг шалгана. Огноогоор хуучин боловч аль хэдийн дууссан root-ийг ашиглан шинэ үйлчилгээ үүсгэхийг resource-state/remaining-obligation gate хориглоно. Security suspension replacement нь STAFF lifecycle-ийн canonical takeover permission-ийг тусад нь шалгана.

## Cash command contract

| Command | Authoritative input | Atomically гарах үр дүн |
| --- | --- | --- |
| ReserveTransfer | Same-hotel source/destination, active shifts, positive integer MNT, available balance, Manager permission | Transfer pending + source reservation + audit/idempotency receipt |
| ConfirmTransfer | Pinned shifts, destination Reception, бодит тооллого amount-тай тэнцсэн | Reservation release + linked OUT/IN + completed transfer |
| CancelTransfer | Manager cancellation request; source Reception бодит full cash return баталсан, reason | Reservation release + cancelled transfer; posted movement байхгүй |
| SpendCash | Approved existing expense/refund/customer source record, active shift, actor permission, unique financial reference | Available invariant шалгасны дараах cash debit + source posting |

`posted >= reserved >= 0`, `available = posted − reserved`. Reservation нийт pending outgoing transfer-тэй тэнцэнэ. Бүх involved row тогтмол дарааллаар lock хийнэ; aggregate revision compare-and-set, ledger, source transaction, transfer, audit, idempotency, outbox нэг transaction-д байна. In-memory state эсвэл client balance production authority болохгүй.

Нэг idempotency key өөр actor/payload-той бол conflict. Replay нь одоогийн authorization-ийг дахин шалгаж өмнөх үр дүнг давхар effectгүй өгнө. Transfer ID болон financial source reference-д key-ээс тусдаа unique guard хэрэгтэй. Unknown/partial cash return reservation суллахгүй. Pending transfer source/destination shift хоёуланг хаахаас хамгаална.

## Settlement contract

1. Booking terminal ба room charge retained/refund breakdown balanced байна.
2. Zero room refund үед Refund NONE хэвээр, provider command үүсгэхгүй.
3. Бүх нэмэлт capture refund, chargeback, reconciliation obligation-ийг хамт шалгана. Нээлттэй байвал HELD; зөвхөн room_refund=0 гэж bypass хийхгүй.
4. Бодитоор retained amount > 0, blockers байхгүй бол ELIGIBLE. Zero retained amount нь payout үүсгэхгүй; NO_PAYABLE нь assessment result бөгөөд canonical persisted payout enum-д шинэ төлөв нэмээгүй.
5. Commission-ийг integer basis point-оор HALF_UP нэг удаа бодно. Provider-confirmed capture/refund snapshot ашиглана.
6. Анхны eligibility event-ийн цагийг нэг удаа хадгалж, тухайн hotel-local өдрийн дараах өдрийн 12:00 Asia/Ulaanbaatar batch-д оруулна. Worker poll бүрээр өдөр урагшлуулахгүй.
7. Paid/batched payable-г eligibility assessment дахин нээхгүй. Persistence adapter booking payable unique key болон conditional transition хэрэглэнэ. Provider timeout-д шинэ payout-г сохроор илгээхгүй.

## Decision → executable verification

| Шийдвэр | Test source | Хязгаар |
| --- | --- | --- |
| LIFE-DEC-008 | [test_subscription.py](../tests/test_subscription.py) | Authoritative identity/RBAC adapter одоогоор байхгүй |
| CASH-DEC-011 | [test_cash.py](../tests/test_cash.py) | Pure reducer + test-only CAS harness; PostgreSQL integration биш |
| PAY-DEC-010 | [test_settlement.py](../tests/test_settlement.py) | Assessment/calculation; бодит provider/payout posting биш |

Дараагийн implementation gate болон үлдсэн backlog: [28-backend-foundation.md](./28-backend-foundation.md).
