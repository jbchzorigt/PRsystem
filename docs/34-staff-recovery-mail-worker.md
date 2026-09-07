# Staff recovery, security audit ба email worker

**2026-09-07 · Үе шат 2/6.** Үлдсэн 9 багцын тогтмол дугаар, acceptance төлөвийг [явцын хүснэгт](31-development-progress.md)-ээс харна.

## Admin password reset — багц 3

`POST /hotels/{tenant_id}/staff/{account_id}/password/reset`

```json
{"expected_revision":0,"idempotency_key":"admin-reset-001"}
```

Өөрийн hotel-ийн Hotel Admin current session, target membership/revision, subscription/security gate шалгуулна. Account email verified байх ёстой. Recipient нь server-ийн canonical account email; email/password/token override талбар хүлээж авахгүй. Амжилттай response `202 {"status":"ACCEPTED"}`. Reset request, actor/target audit, command receipt нэг transaction-д хадгалагдана. Worker одоо байгаа self-service reset pipeline-ийг ашиглана; нэг key-ийн retry нэг хүсэлт үүсгэнэ. Reset mail хүссэн нь membership revision/status болон session-ийг өөрчлөхгүй; recipient reset-ээ дуусгахад account epoch өсөж бүх scope-ийн session хүчингүй болно. Suspended membership/account-ийн status автоматаар сэргэхгүй.

## Unverified invite recovery — багц 4

`POST /hotels/{tenant_id}/staff/{account_id}/invitations/recover`

```json
{"expected_revision":1,"idempotency_key":"recover-invite-001","reason":"Ажилтан onboarding-оо үргэлжлүүлэх болсон"}
```

Hotel Admin нь `SUSPENDED/TERMINATED`, active global account, **unverified email**-тэй target-ийг ижил membership дээр `PENDING` болгоно. Role/package шалгана; Primary-г өөрчлөхгүй. Revision өсөх, scoped session revoke, шинэ нэг удаагийн invitation/mail intent, reason audit, receipt атомик. Хуучин invite ажиллахгүй; шинэ token-ийг recipient зөвшөөрсний дараа л operational membership идэвхжинэ. Баталгаажсан account generic `/reactivate` ашиглана; recovery-оор password/verification overwrite хийхгүй. Member accept/terminate/recover зэрэг ирвэл нэг revision л ялна.

## Claimant recovery — багц 7-ын нэг хэсэг

`POST /hotels/{tenant_id}/staff-work/exceptions/{exception_id}/recover`

Body: `expected_revision`, `idempotency_key`, mandatory `reason`. Ижил hotel-ийн active Manager/Manager Plus нь өмнөх claimant global account suspended/unverified, membership inactive, эсвэл одоогийн package-д Manager permission-гүй болсон үед claim-ийг өөртөө авна. Өмнөх claimant эрхтэй хэвээр бол 409; Hotel Admin дангаараа хийхгүй. Хоёр claimant өрсөлдвөл нэг ялна. Account-ууд sorted lock, current membership/hotel/queue revision шалгалттай; release болон шинэ claim тусдаа audit-д орно. Original work owner, assignment version, cash/history/blocker өөрчлөгдөхгүй.

Энэ нь tenant subscription/security lock-ийг тайлах endpoint биш. Hotel lock recovery нь authoritative billing renewal эсвэл Platform recovery/MFA урсгалтай холбогдох шаардлагатай тул **7-р багцыг бүхэлд нь дууссан гэж тооцоогүй**. Canonical subscription нь package downgrade зөвшөөрдөггүй; lower-entitlement test fixture нь stale entitlement нөхцөлийг шалгах зориулалттай, downgrade API үүсгэсэн гэсэн үг биш.

## Denied-action audit — багц 8

Staff API-ийн 401/403 DomainError нь үндсэн command rollback дууссаны дараа `staff_denied_event`-д тусдаа transaction-аар хадгалагдана. Framework route template, method, тогтмол error code, зөвхөн database-аас resolved actor/scope/target ID орно. Actor нь current unrevoked, unexpired, active/verified session-оор нотлогдоно; танигдаагүй/хүчингүй bearer actor болж бүртгэгдэхгүй. Замаас target-ийг canonical membership-д resolve хийж чадахгүй бол null. Public token endpoint-ийн target-ийг body-оос audit руу хуулдаггүй.

Request body, reason, raw URL/query, bearer/password/link secret болон зохиомол actor input хадгалахгүй. Runtime-д INSERT л олгоно, audit UPDATE/DELETE байхгүй. Audit хадгалж чадахгүй үед 503; хориглосон action commit болохгүй. Validation 422, optimistic conflict 409 болон database 503 нь энэ security-denial хүснэгтийн хамрах хүрээнд ороогүй. Monitoring/retention deployment gate хэвээр.

## SMTP transport ба worker — багц 1-ын код

`006_mail_worker.sql` нь mail intent-д lease, attempt/backoff, discard/dead-letter төлөв нэмнэ. `python -m prsystem.mail_worker --batch 25` нэг bounded batch ажиллуулаад гарна; scheduler/container deployment гаднаас удирдана. Одоогийн орчинд бодит SMTP/provider credential болон public UI origin тохируулагдаагүй, **бодит email илгээгээгүй**.

- STARTTLS эсвэл implicit TLS; certificate/hostname verification заавал, plaintext fallback/debug dump байхгүй. Үндэс: [Python smtplib](https://docs.python.org/3/library/smtplib.html).
- Sender, SMTP login болон public origin нь deployment configuration, HTTP request-ээс авахгүй.
- Recipient нь canonical email; stable Message-ID нь link ID. URL token нь fragment-д орно.
- Reset request processing transaction-safe, idempotent. Delivery claim нь `FOR UPDATE SKIP LOCKED`, random lease token, default 300 секундтэй; SMTP дуудлагын үед DB transaction барихгүй.
- Temporary failure 30 секундээс эхэлсэн exponential backoff, дээд 1 цаг; default 8 attempt. Permanent reject, key/config mismatch нь dead letter. Revoked/expired/superseded/stale link-ийг email явуулахгүйгээр discarded болгоно.
- Expired lease-ийг өөр worker авч болно; хуучин worker шинэ lease-ийн ACK бичихгүй. Send амжилттай болсны дараах crash/ACK failure эсвэл timeout үед **давхар delivery боломжтой**; duplicate email ижил one-use token-той. Exactly-once хүргэлт гэж тооцоогүй.
- CLI зөвхөн outcome count эсвэл тогтмол алдааны мэдэгдэл гаргана. SMTP raw response, recipient, link, connection string логлохгүй. DB dead-letter/lease queue counters-ийг monitor хийнэ; batch outcome count нь queue-ийн нийт хэмжүүр биш.

### Deployment configuration

| Variable | Утга |
| --- | --- |
| `PRSYSTEM_MAIL_DSN` | Non-owner, minimum-grant worker credential |
| `PRSYSTEM_LINK_KEY` | API-тай ижил base64 key, хамгийн багадаа 32 decoded byte |
| `PRSYSTEM_SMTP_HOST` | Баталгаажсан mail service hostname |
| `PRSYSTEM_SMTP_MODE` | `STARTTLS` (default) эсвэл `TLS` |
| `PRSYSTEM_SMTP_PORT` | 587 (default), implicit TLS-д тохирох port-оо explicit өгнө |
| `PRSYSTEM_SMTP_USER`, `PRSYSTEM_SMTP_PASSWORD` | Secret manager-аас inject хийнэ |
| `PRSYSTEM_MAIL_FROM` | Verified sender mailbox |
| `PRSYSTEM_PUBLIC_ORIGIN` | HTTPS origin; path/query/userinfo оруулахгүй |

Илгээхийн өмнө HTTPS UI дээр `/staff/accept` болон `/staff/reset` хэрэгжсэн байх ёстой. Эдгээр page fragment token-ийг уншаад address bar-аас арилгаж, одоо байгаа `/auth/invitations/accept` эсвэл `/auth/password/reset/complete` рүү POST хийнэ; token-ийг analytics/log руу явуулахгүй. UI page, DNS sender verification, provider smoke delivery болон worker deployment нь **дуусаагүй acceptance**.

### Minimum grants

API credential-д [өмнөх grants](32-staff-invitations-reset.md) болон [membership grants](33-membership-work.md)-ийн дээр:

```sql
GRANT INSERT ON prsystem.staff_denied_event TO prsystem_api;
```

Worker нь тусдаа credential байна; жишээ role нэр `prsystem_mail`:

```sql
GRANT USAGE ON SCHEMA prsystem TO prsystem_mail;
GRANT SELECT ON prsystem.staff_account, prsystem.staff_membership,
    prsystem.staff_link, prsystem.staff_mail_intent, prsystem.password_reset_request TO prsystem_mail;
GRANT INSERT ON prsystem.staff_link, prsystem.staff_mail_intent,
    prsystem.staff_lifecycle_event TO prsystem_mail;
GRANT UPDATE (auth_epoch) ON prsystem.staff_account TO prsystem_mail;
GRANT UPDATE (state) ON prsystem.staff_link TO prsystem_mail;
GRANT UPDATE (processed_at) ON prsystem.password_reset_request TO prsystem_mail;
GRANT UPDATE (delivered_at, lease_token, lease_until, attempts, next_attempt_at,
    discarded_at, dead_letter_at, last_error_code) ON prsystem.staff_mail_intent TO prsystem_mail;
```

Account UPDATE(auth_epoch) нь reset issuance-ийн account row lock-д PostgreSQL шаарддаг privilege; worker password/verified_at, membership status/roles, cash эсвэл audit rewrite grant авахгүй. Migration owner credential-ээр worker ажиллуулахгүй.

### Recovery / monitoring

Dead-letter alert-ийн дараа SMTP/DNS/key тохиргоог засаж, canonical resend/reset request-аар **шинэ link** үүсгэнэ. User token-ийг log/SQL output-оос хуулж дахин илгээхгүй. Тасарсан worker-ийн unexpired lease-ийг булаахгүй; lease expiry-ийн дараах retry-г ашиглана. Single-key rotation үед queued хуучин intent-үүдийг дуусгах эсвэл canonical reissue хийнэ; versioned keyring, retention schedule, rate-limit cleanup нь production readiness-д үлдсэн.

## CI баталгаа

14 recovery/audit болон 11 mail transport/worker тест нэмэгдсэн. [PostgreSQL CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34069567087) нийт **138 тестийг skip-гүй** амжилттай ажиллуулсан. SMTP тестүүд controlled transport ашигласан; бодит provider recipient-д хүргэлт батлаагүй.

Restaurant identity нэмэлт: worker-д `GRANT SELECT ON prsystem.restaurant_membership` болон HTTPS `/staff/restaurant-accept` UI хэрэгтэй. Purpose/route нь [35-р contract](35-restaurant-identity.md)-аар тусгаарлагдсан.
