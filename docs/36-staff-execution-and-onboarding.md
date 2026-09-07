# Staff execution, onboarding ба integration gates

**2026-09-07 · v0.7.0 · feat/approved-risk-controls · Draft PR #1**

Энэ milestone нь 2-р шатны үлдсэн таван багцын серверийн хэрэгжилт болон
email link-ийн веб хуудсыг нэмнэ. Бүх бүтээгдэхүүн production-ready болсон гэсэн
тайлан биш. Canonical бизнесийн эх сурвалж: docs/03,15–19,21–22,24,26–27.

## 1. Хэрэгжүүлсэн серверийн урсгал

| Багц | Шинэ хэрэгжилт | Бодит интеграцийн үлдэгдэл |
| --- | --- | --- |
| №1 Email | Дөрвөн Mongolian link form, shared validation/feedback, no-store/CSP, fragment secret removal; SMTP worker-тай route таарна | SMTP sender/credential, HTTPS origin/hosting, worker schedule, зөвшөөрсөн recipient-тэй бодит хүргэлт |
| №2 Onboarding | Application access token, immutable fields/price, phone challenge port, existing-account proof, stored-owner-contact challenge; paid-attempt uniqueness, all-or-nothing provisioning, Primary activation, 5-attempt leased job | Бодит SMS болон QPay/Khaan adapter, provider acceptance tests, tax/eBarimt болон duplicate-hotel screening integration |
| №5 Reception | Shift source, old owner/history, replacement selection/recovery, exact transfer receive/return, Manager cancel request, payment reconciliation intent, blind count, count revision/TTL, close/new opening, separate review, pre-expiry root completion | Анхны configured float/opening болон payment source producer; provider reconciliation delivery |
| №6 Cleaner | Immutable request snapshot, versioned assignment, source-wide remaining quantity lock, physical count/stock posting, untouched reassignment/linked continuation, old actor retention | Canonical room/config/product lifecycle producer, full inventory cost/guest-charge/readiness integration |
| №7 Recovery | Separate Platform password/TOTP realm, recent MFA, explicit permission, security resume; authoritative renewal/floor/deferred entitlement; invalid replacement recovery | Platform enrollment/secret-store deployment, payment adapters; full offline account-email ownership recovery болон intra-term upgrade integration |

Дээрх integration-уудыг mock амжилтаар дууссан гэж тооцохгүй. Core service
болон API бэлэн байгаа ч зарим source producer дараагийн Reception/Minibar
module-ийн өгөгдлөөр хангагдана. `cleaning_source`-д room/config ID байгаа нь
room lifecycle, template Publish/Archive эсвэл guest billing-ийг өөрөө хэрэгжүүлсэн
гэсэн үг биш. `register_shift` нь authoritative opening projection-ийг авдаг;
configured float үүсгэх public API биш.

## 2. Reception transaction contract

`ShiftService.register_shift`-ийг canonical shift-opening transaction дотор,
owner account lock-оос эхлэн дуудна. Current drawer projection-оос opening-г авна;
browser arbitrary opening/owner fact илгээдэг endpoint байхгүй. Historical
`cash_shift_reference` нь drawer дараагийн shift рүү шилжсэн ч хуучин холбоосыг
хадгална. Нэг hotel/account болон нэг drawer-д нэг active shift байна.

1. Suspension/role loss → work BLOCKED + exception атомикаар үүснэ.
2. Current claimant Manager/Manager Plus active Reception replacement сонгоно.
3. Replacement зөвхөн old shift-д suspension-оос өмнө үүссэн pending payment-ийн
   reconciliation хүсэлт болон canonical transfer receive/return хийнэ.
4. Transfer return нь original initiator Manager-ийн cancel request + source
   Reception-ийн бүтэн physical count шаарддаг. Partial count reservation суллахгүй.
5. Pending payment/transfer байвал count/close хориглогдоно. Client `paid=true`
   оруулж obligation terminal болгох endpoint байхгүй.
6. Count эхлээд actual авна; дараа нь expected/variance буцаана. Count immutable,
   cash book revision-тай, 5 минутын exclusive TTL-тай; хамгийн сүүлийн count л хүчинтэй.
7. Close old work/shift → шинэ shift actual opening-г нэг transaction-д үүсгэнэ.
   Opening нь revenue эсвэл шинэ cash income биш. Old owner, original opening,
   expected/actual/variance history өөрчлөгдөхгүй; review тусдаа үргэлжилнэ.
8. Original owner-ийн opening үеийн role snapshot Manager бол Admin review;
   migration-аас өмнөх snapshot-гүй shift-ийг UNKNOWN гэж хадгалж conservative
   Admin review шаардана. Өмнөх role-ийг өнөөгийн role-оор зохиож нөхөхгүй.
9. Selected replacement эрхгүй болсон бол current claimant active шинэ Reception
   сонгож болно. Previous replacement/count history үлдэнэ; шинэ actor шинэ count хийнэ.

Account → tenant cash book → source/exception/transfer гэсэн lock дараалал.
Expiry hard lock-ийн үед queue зөвхөн lock-оос өмнө нээгдсэн, одоо OPEN/BLOCKED
shift-ийг буцаана. Claim, claimant/replacement recovery, prepare, count болон close
нь серверийн immutable `opened_at`-аар root-ийг нотолно. `opened_at == locked_at`
нь eligible биш. Transfer болон payment intent өөрийн recorded-at-аар давхар
шалгагдана; хуучин shift шинэ төлбөр/шилжүүлэгт эрх нээхгүй.

Pending үүрэг дууссан old shift-ийг lock-ийн дараа хаахад `new_shift_id` болон
`opening_actual` NULL, `closing_actual` бодит count байна. Drawer нь CLOSED old
shift дээр хадгалагдана; шинэ shift, cash income, худалдах эрх үүсэхгүй. Хаалтын
дараах санхүүгийн review болон idempotent retry тусдаа боломжтой. Security
suspension/current role шалгалт бүх үйлдэлд хэвээр. 015 migration нь root identity,
recorded open time, opening snapshot-ийг өөрчлөх болон CLOSED shift-ийг нээхийг
DB trigger-ээр хориглоно.

Staff queue API role нь `reception_shift`-д SELECT шаарддаг; root history-д UPDATE
эрх өгөхгүй. Existing generic `PostgresCash` new reserve/spend дээр BLOCKED/CLOSED registered
shift-ийг нэмэлтээр хориглоно. Mandatory cash authorizer бусад financial source,
current permission болон subscription facts-ийг цаашид ч шалгана.

## 3. Cleaner transaction contract

Trusted checkout/configuration/refill producer нь immutable `cleaning_source`
болон зөвшөөрөгдсөн `cleaning_action` plan-ийг нэг transaction-д үүсгэж,
`assign_source`-ийг дуудна. Producer нь exact room/config/version, product lifecycle,
stock source, guest/stay холбоос болон safe point-ийг canonical module-оос шалгах
үүрэгтэй. HTTP хүсэлтээр source snapshot, target quantity эсвэл stock opening
үүсгэх боломжгүй.

`CLEAN`, `COUNT`, `REFILL`, `RETURN` action нь source-wide remaining quantity-г
нэг root lock дээр consume хийнэ. Warehouse/room хоёр талын transfer нэг transaction;
stock сөрөг болохгүй. COUNT бол immutable physical observation; дангаараа guest
consumption, charge эсвэл financial adjustment үүсгэхгүй. Full inventory producer
эдгээр ялгааг canonical дүрмээр удирдана.

Хийж эхлээгүй task ижил ID, шинэ assignee/version авна. Started/count/posting
байвал original task `CONTINUED`, шинэ task original source болон parent-тай
холбогдоно. Remaining action хуучин ба шинэ task-аар давхар post болохгүй.
Resolved queue row хадгалагдана; дараагийн suspension revision нэмэн дахин нээнэ.
History болон snapshot-д UPDATE/DELETE DB trigger-ээр хориглосон.

## 4. Platform realm

Platform account/session нь staff account/session-оос тусдаа. Hotel эсвэл
Restaurant token Platform route-д хүчинтэй биш, эсрэгээр мөн адил.

- Argon2 password + TOTP заавал; 30 секунд, 6 digit, ±1 window.
- Нэг account-ийн accepted TOTP counter давтагдахгүй; concurrent login ч serialize.
- Session 1 цаг; high-risk action-д MFA 5 минутаас шинэ байна. Эдгээр нь deployment P1 default.
- Current active/permissions/revision бүрт дахин шалгагдана; permission/status/key
  change хуучин session-ийг хүчингүй болгоно.
- `SUBSCRIPTION_SUSPEND` permission security suspend/resume-д шаардлагатай.
- `ONBOARDING_PROVISION_RETRY` зөвхөн immutable paid failed job-ийг retry хийнэ.
- Reason, case/reference, idempotency, append-only Platform audit заавал.
- Security resume нь expiry, package эсвэл staff membership-ийг сэргээхгүй.

MFA алгоритм, зургаан 8-digit reference vector-ийн эх сурвалж:
[RFC 6238](https://www.rfc-editor.org/rfc/rfc6238). Implementation secret resolver
нь deployment-owned `key_ref -> bytes` callable. DB-д raw TOTP seed хадгалахгүй.
Named account enrollment, secret manager болон recovery procedure production-д
тусад нь тохируулагдана. Client key/permission/MFA-verified boolean тохируулах API байхгүй.

## 5. Onboarding ба provider ports

`create_app(..., phone_gateway=..., payment_gateways={"QPAY": ..., "KHAAN": ...})`
нь зөвхөн серверийн composition. Эдгээр аргументыг HTTP request-ээс бүтээхгүй.
Тохиргоогүй phone/payment/Platform үйлдэл 503-аар хаагдана. `PRSYSTEM_LINK_KEY`
болон өмнөх SMTP worker-ийн key ижил байх ёстой.

Phone gateway contract:

- `request(canonical_phone, challenge_id)` — challenge ID-аар delivery deduplicate.
- `verify(challenge_id, code) -> bool` — зөвхөн provider/server баталгаажуулсан,
  тухайн challenge-д bound, хугацаатай, attempt limit-тай OTP-г шалгана.
- Raw OTP-г response/audit/log-д буцаахгүй. Owner proof нь шинэ application-ийн
  утас руу бус өмнө хадгалсан owner contact руу очно.
- Provider timeout нь success биш. Transport нь timeout, retry, secret/log
  redaction болон challenge delivery state-ийг хэрэгжүүлэх ёстой; FakePhone бол зөвхөн тест.

Payment gateway contract:

- Deployment-owned `merchant_id`, QPAY эсвэл KHAAN нэртэй fixed adapter.
- `create_invoice(attempt_id, amount, "MNT") -> invoice_id`; stable attempt reference
  deduplicate хийнэ. Failed/unknown response UNCERTAIN хэвээр, replacement invoice хориглоно.
- `payment(attempt_id, invoice_id)` нь provider API-аас status, merchant_id,
  invoice_id, amount, currency, payment_id, timezone-aware confirmed_at гаргана.
- Status: PENDING/FAILED/EXPIRED/SUCCEEDED. Missing, mismatched merchant/currency/
  amount/invoice эсвэл future confirmation timestamp paid болохгүй.
- Invoice ID алдсан UNCERTAIN create-г stable client reference-ээр reconcile
  хийх provider capability шаардлагатай. Тэр нь баталгаагүй бол автоматаар дахин invoice үүсгэхгүй.
- Callback body, redirect screen, хэрэглэгчийн status/дүн authority биш.
- Нэг capture onboarding болон renewal хоёрт зэрэг ашиглагдахгүй: shared DB unique
  capture claim + immutable payment rows хамгаална.

[QPay official merchant documentation](https://developer.qpay.mn/mn/docs/merchant?version=2.0.0)
нь integration-ийн үндсэн эх сурвалж. Энэ session-д full endpoint schema таталт
timeout болсон; Khaan merchant contract/sandbox болон SMS provider тодорхойгүй.
SDK/example-ийг authoritative bank contract болгон ашиглаагүй. Бодит adapter
болон acceptance evidence одоогоор байхгүй.

Application snapshot нь personal/company mandatory fields, normalized email,
owner identifier, server plan/term/amount-тай. Identifier-ийн одоогийн validation
нь 5–20 alphanumeric structural guard; Mongolia individual/company exact format
болон tax/eBarimt merchant configuration-ийг provider integration дээр баталгаажуулна.
Энэ нь identity/KYC verification гэсэн үг биш.

Provisioning нь email/owner/application/job lock, unique constraint-аар нэг
hotel/owner link/subscription/Primary membership/default zero drawer/activation
intent үүсгэнэ. New account PENDING membership + нэг-use ADMIN_ACTIVATION link;
existing proved account ACTIVE membership авч password/link шинээр үүсгэхгүй.
Paid owner/account race proof хүлээж зогсоно. Public listing үргэлж UNPUBLISHED;
duplicate screening энэ gate-ийг автоматаар нээхгүй.

Worker `run_job` нь таван минутын lease, committed attempt counter, 5 automatic
attempt, exponential backoff-тай. Crash/COMMIT failure partial entities үлдээхгүй.
Exhausted crash job PROVISIONING_FAILED болж Platform retry-д орно. `once(limit)`
нь bounded provisioning batch; provider polling/callback adapter, job scheduling
болон eBarimt delivery нь integration deployment-ийн ажил хэвээр.

## 6. Paid renewal

Hotel Admin-ийн current account/membership permission заавал. Renewal expired
эсвэл security-suspended hotel-д account-service байдлаар боломжтой боловч төлбөр
security suspension-ийг арилгахгүй. Доод package floor руу invoice үүсгэхгүй.

Same/higher package renewal төлбөр серверээр баталгаажсаны дараа л хугацаа нэмнэ.
Grace 48 цагийн exclusive хилээс өмнө old expiry-ээс сунгана; дараа нь authoritative
paid time-оос шинэ term эхэлнэ. Asia/Ulaanbaatar календарь сар, end-of-month clamp.
Өндөр багцын floor payment commit дээр, entitlement `max(old_expiry, paid_at)`-д.
`apply_due(limit)` нь зөвхөн due paid entitlements-ийг идэвхжүүлнэ, downgrade хийхгүй.
Stale paid invoice duplicate term үүсгэхгүй; RECONCILE хадгална. Intra-term
upgrade difference, tax/eBarimt болон provider fee/net settlement нь бүрэн billing module-д үлдсэн.

## 7. Deployment boundaries ба grants

Migration 001–015-ийг privileged migration role-оор дарааллаар ажиллуулна.
Runtime table owner/superuser/BYPASSRLS ашиглахгүй. 009 migration нь existing cash
projection-оос history identities backfill хийдэг тул migration role бүх tenant
cash row-г унших эрхтэй байх ёстой. Runtime дээр `row_security` bypass хийхгүй.

Тестийн fixture grants нь integration шалгах нэгдсэн role; production-д түүнийг
бүх API-д шууд хуулж хэрэглэхгүй. Үүргээр салгана:

| Service role | Нэмэлт унших/бичих хүрээ | Хориг |
| --- | --- | --- |
| Hotel operational API | staff work/receipt; cleaning task/action/stock/posting; shift/takeover/count/transfer; INSERT-only audit | cleaning_source snapshot/opening stock insert, paid evidence, Platform account permission mutation |
| Trusted source producer | canonical source validation transaction; cleaning_source/actions/stock seed; register_shift/assign_source | client authority payload passthrough |
| Onboarding public API | own application/challenge/proof; immutable invoice request/attempt metadata | payment insert, provisioning, Primary role grant |
| Payment/provisioning worker | provider-owned invoice/payment, billing_capture INSERT; job lease; atomic owner/hotel/subscription/Primary/link/mail inserts | generic HTTP route to payment evidence or supplied paid flag |
| Platform API | current account/session SELECT, TOTP counter/session MFA update; security_suspended update; audit/receipt INSERT | staff passwords/roles/operational data grant; TOTP key access by user |
| Email worker | өмнөх docs/34–35 grants + primary membership/activation link SELECT | Primary membership activation; password read/change |

Concrete колонкын privilege-ийн executable жишээ:
`tests/operational_support.py`, `tests/test_shift_takeover.py`,
`tests/test_platform_recovery.py`, `tests/test_onboarding.py`, `tests/test_renewal.py`.
Untrusted-facing production app DSN-д worker write grants өгөхгүй; тусдаа service
instance/DSN хэрэглэж дээрх boundary-г хадгална.

## 8. Шалгалт ба deployment-д үлдсэн зүйл

[Эцсийн CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34076421615):
228 backend тест skip-гүй амжилттай. Дөрвөн form-ийн Chromium interaction suite,
DESIGN.md lint, token drift check, strict static UI audit ашигласан.
PostgreSQL tests нь restricted runtime roles болон real transactions дээр ажиллана.
Browser tests нь fake HTTP response state matrix; real endpoint rules-ийг PostgreSQL
suite тусад нь шалгана. SMTP/OTP/payment provider нь external live тест биш.

Нууц тохиргоог chat эсвэл git файлд оруулахгүй. Provider-ийн official merchant API
contract, sandbox access, SMS provider, SMTP sender болон HTTPS origin/server
бэлэн болоход concrete adapters + real delivery/payment acceptance + deployment
ажлыг гүйцээнэ. Үүнээс өмнө merge/deploy болон production-ready зарлал хийгдээгүй.
