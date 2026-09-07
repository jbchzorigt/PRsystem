# Development provider mocks — 2026-09-07

**Хэрэглэгчийн шийдвэр:** SMS болон payment API service бэлэн болоогүй тул mock
хэрэглэж дараагийн хөгжүүлэлт рүү шилжинэ. Бодит provider acceptance нь хойшлуулсан
release gate; өдөр тутмын код бичихийг зогсоох prerequisite биш.

## Mock-ийн хүрээ

| Үйлчилгээ | Хэрэгжилт | Бодит үйлчилгээний ялгаа |
| --- | --- | --- |
| SMS/OTP | Challenge-д bound random 6 digit, 5 минутын TTL, 5 attempt, нэг удаа consume | SMS илгээхгүй; кодыг локал inspect командаар авна |
| QPay/Khaan | Тусдаа `MOCK_ONLY_*` merchant, stable invoice/capture, анх PENDING | Мөнгө хөдлөхгүй; амжилтыг оператор командаар simulate хийнэ |
| Email | Дөрвөн purpose-ийн localhost fragment link, link ID dedupe | SMTP холболт үүсэхгүй; зөвхөн локал mailbox-д хадгална |

State нь `.dev/providers.sqlite3`-д хадгалагдаж process restart-ийн дараа үлдэнэ.
Файлыг шинэ үүсгэхэд permission 0600, directory 0700; gitignore-д `.dev/` орсон.
OTP/link агуулдаг энэ **зөвхөн тестийн** mailbox-ийг HTTP endpoint-оор нийтлэхгүй.
Бодит хэрэглэгчийн мэдээлэл, production DB-г энэ горимд ашиглахгүй.

## API ажиллуулах

Backend dependencies-ийг README-ийн дагуу суулгаж, 001–017 migration-тай тусдаа
development PostgreSQL DB болон restricted app/worker role-ууд бэлтгэсэн байна.
Database нэр `prsystem_dev*` эсвэл `prsystem_test_*` prefix-тэй байх ёстой.
Migration owner credential нь API/worker credential биш.

Доорх environment хувьсагчийг локал shell/secret тохиргоонд өгнө:

| Variable | Утга |
| --- | --- |
| `PRSYSTEM_ENV` | `development` |
| `PRSYSTEM_APP_DSN` | Restricted development API connection |
| `PRSYSTEM_DEV_WORKER_DSN` | Ижил development DB-ийн payment/provision/mail worker connection |
| `PRSYSTEM_LINK_KEY` | Base64-encoded, дор хаяж 32-byte random key; API/worker ижил, restart-д тогтвортой |
| `PRSYSTEM_MOCK_STATE` | Optional; default `.dev/providers.sqlite3`; API/CLI ижил path ашиглана |
| `PRSYSTEM_DEV_ORIGIN` | Optional; default `http://127.0.0.1:8000`; зөвхөн loopback host |

Шинэ development key үүсгэх команд (утгыг git-д commit хийхгүй):

```bash
python -c 'import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())'
uvicorn prsystem.development:create_app --factory --host 127.0.0.1 --port 8000
```

OpenAPI title нь `PRsystem MOCK ONLY API`, response бүр
`X-PRsystem-Mode: MOCK_ONLY` байна. Энгийн `prsystem.api:create_app` нь mock
gateway-г default production mode-д хүлээн авахгүй. Provider байхгүй үед бодит
factory автоматаар mock руу шилжихгүй. Platform TOTP enrollment-ийг mock хийхгүй.

## Туршилтын дараалал

1. Одоогийн `/onboarding/applications` API-аар application үүсгэнэ.
2. Application-ийн access token-оор `/onboarding/{id}/phone/request` дуудна.
3. OTP-г зөвхөн локал командаар авч, тухайн application-ийн `/phone/verify`-д өгнө:

```bash
python -m prsystem.development inspect phone
```

4. `/onboarding/{id}/invoice/QPAY` эсвэл `/invoice/KHAAN` дуудна. Анх `PENDING`;
   unpaid application account/hotel/Primary эрх үүсгэхгүй.
5. Буцсан `attempt_id`-г ашиглан төлбөрийн үр дүнг simulate хийнэ:

```bash
python -m prsystem.development inspect invoice
python -m prsystem.development payment QPAY ATTEMPT_ID SUCCEEDED
python -m prsystem.development tick --limit 25
python -m prsystem.development inspect mail
```

6. Mailbox дахь `/staff/activate#token=...` холбоосоор password үүсгэж, энгийн
   staff login хийнэ. App-ийн бизнесийн validation/atomic provisioning хэвээр ажиллана.

`FAILED`, `EXPIRED`, дараах late `SUCCEEDED`-ийг ижил payment командаар шалгаж болно.
Paid capture-ийн ID/time тогтвортой; `SUCCEEDED`-ийг unpaid рүү буцаахгүй.
Renewal-д `attempt_id`-ийн оронд `renewal_id` хэрэглэнэ. Existing-account/owner
proof, subscription floor, security suspension зэрэг дүрмийг mock тойрохгүй.

`tick` нь development-д зориулсан **нэг bounded diagnostic batch**: provider
reconcile → provisioning → due entitlement → local mail. Automatic production
scheduler биш; олон test application үүсгэсэн бол database/provider state-ийг
хосоор нь зохион байгуулж, тохирох batch limit хэрэглэнэ. Бодит paid evidence,
SMTP delivery болон production acceptance гэж тайлагнахгүй.

App role нь application/challenge/invoice request API-ийн эрхтэй. Development
worker role-д docs/36-ийн payment/provisioning/renewal болон docs/34-ийн mail
worker grants-ийг өгнө. Role-ууд owner/superuser/BYPASSRLS байхгүй. Executable
grant жишээ: `tests/test_onboarding.py`, `tests/test_renewal.py`, `tests/test_mail_worker.py`.

## Шалгалт

`tests/test_mock_providers.py` нь persistence, pending default, stable late capture,
provider isolation, OTP TTL/attempt/dedupe/concurrency, local mailbox-ийг шалгана.
`tests/test_onboarding.py` нь mock port-оор **жинхэнэ PostgreSQL application → OTP
→ invoice → simulated payment → provisioning → activation** урсгалыг ажиллуулна;
production factory mock reject болон тусдаа DB namespace guard мөн шалгагдана.

[v0.8.0 PostgreSQL CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34084343027)
дээр mock suites болон нийт 264 backend тест skip-гүй амжилттай.

## v0.9.0: mock walk-in check-in

Development factory нь тусгаарлагдсан DB дээр `mock_stay_finance=True`-г идэвхжүүлж, stable LINK_KEY-ээс identity encryption/lookup-д зориулсан тусдаа development key үүсгэнэ. Canonical room cleaning/readiness → own open shift → walk-in check-in-г туршина. Барьцааны category amount 50,000–100,000₮ байх шаардлагатай. Stay snapshot `financial_integration=DEFERRED_MOCK`, response `MOCK_ONLY`; payment/deposit авсан ledger/cash event үүсэхгүй. Production factory нь mock flag-ийг зөвшөөрөхгүй, deposit satisfaction service бэлэн болтол check-in 503 байна.

XYP-гүй үед manual primary guest entry ашиглана; XYP_VERIFIED болон Police match result зохиохгүй. Initial guest code issuance нэмэгдсэн ч QR/session consumer дараагийн integration-д орно. API/grants/key болон 299 тестийн CI: [39-walkin-check-in.md](39-walkin-check-in.md).
