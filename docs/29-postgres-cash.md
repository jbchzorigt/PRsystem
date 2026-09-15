# PostgreSQL cash persistence

**Огноо:** 2026-09-06. **Scope:** CASH-DEC-011-ийн durable cash transaction. Public API, account/membership authorization, shift opening/closing, expense/refund approval, payment provider болон outbox dispatcher энэ milestone-д ороогүй.

## Transaction ба өгөгдөл

`PostgresCash.execute()` шинэ connection/transaction нээж, unsafe superuser/BYPASSRLS/table-owner role-ийг reject хийнэ. Tenant нь trusted authenticated application context-оос ирэх ёстой. Transaction-local tenant setting тогтоож cash root-ийг `FOR UPDATE` lock хийсний дараа mandatory `authorize(conn, command, context)` callback ажиллана. Callback нь тухайн transaction-д active account/membership, role/action/package, subscription, shift/count evidence болон financial approval-ийг шалгах үүрэгтэй; permissive default байхгүй. Тестийн allow callback production authentication биш.

Callback нь connection-ийг commit/rollback/close хийхгүй, tenant setting солихгүй; source-state өөрчлөлт шаардлагатай бол ижил transaction-д хийх бөгөөд replay-safe байна. Production policy хэрэгжих хүртэл adapter-ийг HTTP endpoint-д холбохгүй. Caller-ийн `CashContext.authorized` boolean нь PostgreSQL adapter дээр эрх олгохгүй.

Нэг hotel's command-ууд root lock-оор дараалж, stale revision `REVISION_CONFLICT` болно. Caller шинэ төлөв уншиж command-ийг дахин validate хийлгэнэ; мөнгөн дүнг автоматаар дахин оролдохгүй. Lock timeout 5 секунд, statement timeout 15 секунд; database exception гарвал бүх transaction rollback хийнэ. Commit-ийн үр дүн connection тасарч тодорхойгүй бол ижил idempotency key/actor/payload-аар retry хийнэ.

Projection, transfer state, cash event, receipt, outbox intent, revision нэг commit-д хадгалагдана. `cash_event`, `cash_receipt`, `cash_outbox` runtime role-д append-only. Same-tenant composite foreign key, nonnegative available balance check, unique financial reference нь давхар хамгаалалт болно. Database owner/migration credential нь trusted administration boundary хэвээр.

Receipt нь tenant + key-ээр unique; actor болон typed command payload зөрвөл conflict. Replay ч шинэ authorization шалгалт давна, шинэ journal/outbox үүсгэхгүй, **анхны commit-ийн revision**-ийг `replayed=True`-тэй буцаана. Энэ нь current balance snapshot биш. Timestamp/expected revision нь command payload-ийн хэсэг биш.

Бүх ledger history-г уншихгүй: drawer projection, pending transfer-ууд, command-ийн target transfer, нэг receipt болон financial reference л load хийнэ. Нэг hotel's drawer/pending transfer тоо өсөхөд хэмжих load gate үлдсэн. Generic debit-ийн unique reference нь expense/refund approval эсвэл тухайн source aggregate-ийн posting-ийг орлохгүй. Opening balance/shift fixture-ийг тест admin үүсгэдэг; production opening/handover workflow хараахан байхгүй.

RLS нь server-selected tenant scope-ийг SQL түвшинд хэрэгжүүлнэ. Runtime database credential эзэмшигч custom setting-ийг сольж чаддаг тул RLS нь authentication биш; credential-ийг client-д өгөхгүй. Public API нь tenant сонголтыг membership-тэй заавал холбоно.

## Суулгах ба migration

Python 3.12+, PostgreSQL 17 (CI target):

```bash
python -m pip install '.[postgres]'
# PRSYSTEM_MIGRATION_DSN-ийг deployment secret-ээс owner connection болгон тохируулна.
python -m prsystem.postgres.migrate
```

Migration runner advisory lock, transaction, version/checksum ашиглана. Applied SQL-ийг засварлахгүй, дараагийн дугаартай migration нэмнэ. Runtime role schema migration эрхгүй. Backup/restore болон deployment rollback procedure production release gate хэвээр.

Owner/admin нь тусдаа `prsystem_app` LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT role, credential-ийг secret manager-аар бэлтгэсний дараа дараах minimum grant өгнө. Энэ role нь table owner/owner role-ийн гишүүн байж болохгүй.

```sql
GRANT USAGE ON SCHEMA prsystem TO prsystem_app;
GRANT SELECT ON prsystem.cash_book, prsystem.cash_drawer, prsystem.cash_transfer,
    prsystem.cash_event, prsystem.cash_receipt, prsystem.cash_outbox TO prsystem_app;
GRANT UPDATE (revision) ON prsystem.cash_book TO prsystem_app;
GRANT UPDATE (posted, reserved) ON prsystem.cash_drawer TO prsystem_app;
GRANT UPDATE (state) ON prsystem.cash_transfer TO prsystem_app;
GRANT INSERT ON prsystem.cash_transfer, prsystem.cash_event,
    prsystem.cash_receipt, prsystem.cash_outbox TO prsystem_app;
```

Tenant/root/drawer bootstrap нь admin/application provisioning-ийн дараагийн scope. FORCE RLS-тэй owner bootstrap хийхдээ tenant setting шаардлагатай; superuser зөвхөн administration/test setup-д хэрэглэгдэнэ. Runtime adapter нь privileged connection-ийг reject хийнэ.

## Бодит сангийн тест

Зөвхөн isolated test PostgreSQL server дээр `PRSYSTEM_TEST_ADMIN_DSN` тохируулна. Test admin нь disposable database/role create/drop эрхтэй байна. Тест UUID нэртэй database/role үүсгэж төгсгөлд нь устгана; app connection нь хязгаарлагдсан тусдаа role ашиглана.

```bash
python -m unittest discover -s tests -v
```

14 integration test нь paired posting/outbox, replay, numeric/payload conflict, revoked authorization, tenant boundary, concurrent reserve/debit ба duplicate, unique source, terminal transfer, deferred commit failure rollback, RLS context reset, same-tenant FK, runtime mutation denial, unsafe role болон migration checksum-ийг шалгана. `PRSYSTEM_TEST_ADMIN_DSN` байхгүй бол integration тест skip хийнэ; CI-ийн `postgres` job DSN-ийг заавал тохируулдаг. Deferred commit failure нь process crash/restore drill-ийг орлохгүй.

Implementation references: [Psycopg transaction management](https://www.psycopg.org/psycopg3/docs/basic/transactions.html), [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).
