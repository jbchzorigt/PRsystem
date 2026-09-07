# Reception: walk-in check-in (v0.9.0)

Reception багц 3/6-ийн **walk-in server flow** хэрэгжсэн. Бүх Reception module эсвэл production integration дууссан гэсэн утгагүй. API service бэлэн биш хэсгүүдийг mock/manual горимоор орхих хэрэглэгчийн шийдвэр хүчинтэй.

## Implemented boundary

- `POST /hotels/{tenant_id}/stays/check-in`: verified/current Reception, active subscription, security gate, өөрийн OPEN shift болон OPEN work root, drawer-ийн current shift-ийг сервер шалгана. Зэрэг command нь cash book, catalog, room root lock-оор сериалчлагдана; нэг өрөөнд нэг ACTIVE stay гэсэн DB unique constraint давхар хамгаална.
- `HOURLY`: `duration_units` нь positive integer half-hour units. Amount нь `ROUND_HALF_UP(rate * units / 2)`-ийг integer arithmetic-аар нэг удаа бодно. `NIGHTLY`: units нь calendar night count; actual check-in-ийн **Asia/Ulaanbaatar local date + N** өдрийн snapshot fixed checkout time. Planned end нь confirmation time-ээс хойш байх ёстой.
- Optional `actual_checkin_at`: timezone required, 120-minute/own shift/local midnight floor, future deny, earlier time-д mandatory reason. Серверийн confirmation clock нь бүх lock-ийг авсны дараа тогтоно. Price/config snapshot нь **recorded time**-ийн current authoritative state; actual date нь duration/age-д ашиглагдана.
- Walk-in tariffs: room → category → hotel; source entity/version, amount, deposit requirement, room/category/settings versions, fixed checkout, timezone, cleaning buffer, minibar OFF snapshot хадгална. Original dates/type/duration/amount/snapshot immutable; amendment/extension endpoint байхгүй.
- `[start,end)` occupancy + each source's own following cleaning buffer. ACTIVE stay нь planned end өнгөрсөн ч occupied. CLOSED stay-ийн actual checkout ба stored buffer, CONFIRMED reservation projection-ийн interval/buffer шинэ walk-in-ийг хаана.
- `GET /hotels/{tenant_id}/stays/active`: bounded keyset listing, overdue flag; guest raw identifier/code/Police information өгөхгүй.

## Canonical readiness producer

1. 20,000₮ package: Manager `POST /rooms/{room_id}/manager-clean`, `expected_revision`, idempotency key → DIRTY → CLEAN. Reception энэ эрхийг өвлөхгүй.
2. 25,000/30,000₮: Manager `POST /rooms/{room_id}/cleaning-requests`, assignee ID, room revision → immutable source + exactly one CLEAN action + assigned open task. Cleaner `POST /cleaning/tasks/{task_id}/start` → CLEANING. Existing source-bound `/post` command-ийн бүх action амжилттай дуусахад CLEAN болно. Request payload source snapshot, quantity plan эсвэл arbitrary clean flag өгөхгүй.
3. Room/category lifecycle болон cleaning state өөрчлөлтөөс immutable, server-recorded readiness history үүснэ. Legacy room-ийн түүх migration хийсэн мөчөөс эхэлнэ. Historical CLEAN/current CLEAN хоёр тусдаа шалгагдана; actual-аас recorded хүртэл DIRTY/inactive transition байсан бол backdate deny.
4. Cleaning posting room root-ийг source-оос өмнө lock хийнэ. Existing legacy cleaning sources canonical room bridge байхгүй үед урьдын execution behavior-оо хадгална.

## Primary guest and privacy

All four identity types are supported with mandatory names, DOB, nationality and server-owned `MANUAL` provenance. MN registration is normalized Cyrillic + eight ASCII digits with valid encoded birth date matching DOB; this is structural validation, **not XYP verification**. Passport requires issuing country, number, expiry date; other government ID requires type/country/authority/number. NO_DOCUMENT requires reason/note and is LOW_ASSURANCE. Under-18 primary guests require guardian name/phone/relationship; guardian is metadata, not another stay.

XYP is deferred; current check-in accepts manually entered identity. There is no client-controlled `XYP_VERIFIED`, fake match result or fuzzy matching. Full guest metadata and backdate reason are encrypted using versioned AES-256-GCM, random 96-bit nonce and tenant/stay/purpose-bound associated data. Identity lookup and command fingerprint use separate HMAC namespaces and a separate stable key. Identifier, names and raw guest code are absent from receipts/audit.

Implementation reference: [cryptography AEAD documentation](https://cryptography.io/en/latest/hazmat/primitives/aead/). API dependency is pinned to `cryptography==50.0.1`; [upstream release history](https://cryptography.io/en/latest/changelog/).

Only valid MN_REG_NO creates an immutable `identity_match_outbox` entry, with recorded time and keyed exact token. Passport/other/no-document does not enqueue RD matching (NOT_ELIGIBLE_EXACT_RD policy). This is a downstream **handoff**, not a live Police match/alert delivery. Hotel HTTP routes never expose the handoff or outcomes. Application role needs INSERT on this table, not SELECT; the eventual Police worker is separately scoped.

For 30,000₮, successful check-in creates one stay-bound six-digit code with a 10-minute server TTL. It is encrypted at rest, has a keyed verifier and is returned to the authenticated Reception. Idempotent replay decrypts the same unexpired, unconsumed code; never recreates an expired code. QR exchange, additional device codes, session limit/revocation and checkout invalidation belong to the upcoming guest access/checkout integration; this change only implements initial code issuance. Do not present it as a complete guest login flow.

## Key configuration

Production API enables check-in only with an explicitly configured identity vault. Missing vault fails 503; no plaintext fallback. Configure secrets outside the repository:

- `PRSYSTEM_IDENTITY_KEYS`: JSON object mapping version IDs to base64-encoded 32-byte encryption keys.
- `PRSYSTEM_IDENTITY_CURRENT_KEY`: active version ID.
- `PRSYSTEM_IDENTITY_LOOKUP_KEY`: separate base64-encoded 32-byte key, stable across encryption key rotation.

Keep prior encryption keys for historical reads. Lookup-key rotation requires a separate token migration; changing it casually breaks lookup/idempotency. Key custody, rotation/retention and production access controls remain deployment gates. The existing explicit development factory derives separate **development-only** keys from its stable LINK_KEY; production never uses that fallback. Development remains opt-in and isolated to development databases. No real XYP, Police, SMS, email or payment service is called by check-in.

## Minimum grants after prior Reception grants

Replace `app_role` with the deployment's restricted role; owner applies migration 018 first. Migration runs atomically/checksummed and is repeat-safe through the migration runner. Existing room writers now also need readiness history/sequence grants because inserts emit history.

```sql
GRANT SELECT, INSERT ON prsystem.room_readiness_event TO app_role;
GRANT USAGE ON SEQUENCE prsystem.room_readiness_event_sequence_seq TO app_role;
GRANT SELECT, INSERT ON prsystem.stay, prsystem.stay_guest_identity,
  prsystem.stay_guest_code, prsystem.room_cleaning_request TO app_role;
GRANT SELECT ON prsystem.room_reservation TO app_role;
GRANT INSERT ON prsystem.identity_match_outbox,
  prsystem.cleaning_source, prsystem.cleaning_action TO app_role;
GRANT UPDATE (cleaning_state, revision) ON prsystem.room TO app_role;
GRANT UPDATE (state) ON prsystem.room_cleaning_request TO app_role;
-- Row-lock privilege (existing shift service already requires state UPDATE):
GRANT UPDATE (state) ON prsystem.reception_shift TO app_role;
```

Every existing Cleaner posting runtime also needs SELECT on `room_cleaning_request`; bridged room tasks need the room/history grants above. No UPDATE/DELETE on immutable identity, readiness or matching history; no stay mutation grants are added by this step.

## Remaining integration

- Confirmed online booking must be created from authoritative booking/payment evidence, write `room_reservation` under the same room root lock, and consume its own immutable quote at check-in. No public import/paid boolean endpoint exists. Current API supports walk-ins only.
- Package 4 owns guest charges, payments/deposits/allocations/refunds and cash-source posting. `amount_mnt`/`deposit_mnt` here are immutable requirements; check-in does **not** claim payment or post cash.
- Package 5 owns actual checkout and next cleaning source. No unsafe direct checkout endpoint has been added.
- Guest QR/session execution, registry correction, Police worker/live XYP, minibar ON and operational UI remain later integration work. Source snapshots are never fabricated to bypass these gates.

## Verification

31 new tests: 12 duration/identity domain, 4 authenticated-encryption, 15 real PostgreSQL/API. Local discovery: **295 discovered, 58 executed, 237 PostgreSQL-dependent skipped** (local crypto 46.0.0); pinned-version/full PostgreSQL validation is required in CI. The tests cover two concurrent Reception accounts, room ownership, tenant/role/expiry/blocked-shift gates, historical readiness, canonical Cleaner transitions, future booking buffer, immutable SQL snapshots, encrypted idempotency replay, restricted outbox access, manual foreign identity, and transaction rollback. CI result will be recorded after execution.
