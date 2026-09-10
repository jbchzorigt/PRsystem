# Phase 22 — Non-functional measurements

**Written:** 2026-09-10, against the Phase 22 implementation tree. Every target below is a
`PROVISIONAL_ARCHITECTURE_DEFAULT` from [docs/architecture/15-non-functional-targets.md](../architecture/15-non-functional-targets.md);
this document records what was measured beside it, how, and where the measurement fell short. A
shortfall is a gap for Phase 23 to report to the customer, never a reason to move the number
(build-plan §Phase 22). Nothing here closes P1-10.

**Conditions common to every measurement.** One developer machine (macOS, Apple silicon), the
repository's compose stack (`postgres:17.6-alpine` on 127.0.0.1:55442, `redis:7.4.2-alpine`), the
real API from `apps/api/dist` in the `ci` application environment with every external port its
deterministic simulator, request logging on, a scratch database provisioned by the platform's own
bootstrap and migrations. The client sat on the same machine, so no network is in any latency.
These are the API's own numbers under one process; a hosted deployment must repeat them.

## 1. Latency (doc 15 §2)

`node tools/load-test.mjs --requests 200 --concurrency 8` — one representative route per class,
200 requests at 8 in flight (commands: 120 at 4, each hold followed by its cancellation so the
category never runs out). Report: [phase-22-load-measurement.json](phase-22-load-measurement.json).

| Class | Route | p50 | p95 | p99 | Target p50 / p95 / p99 | Failures | Within |
| --- | --- | ---: | ---: | ---: | --- | ---: | --- |
| Read, indexed | `GET /hotels/:id/rooms/board` | 77.6 ms | 100.9 ms | 106.8 ms | 50 / 200 / 500 | 0 | **no — p50** |
| Read, paginated search | `GET /operation/subscriptions?limit=25` | 22.4 ms | 38.3 ms | 40.8 ms | 100 / 400 / 800 | 0 | yes |
| Public search | `GET /public/hotels?checkIn&checkOut` | 17.6 ms | 32.3 ms | 33.6 ms | 150 / 600 / 1 200 | 0 | yes |
| Command, simple | `POST /guest/bookings/:id/cancellation` | 26.3 ms | 34.9 ms | 40.6 ms | 100 / 300 / 700 | 0 | yes |
| Command, transactional | `POST /guest/bookings` (the hold) | 26.4 ms | 34.7 ms | 75.1 ms | 200 / 800 / 1 500 | 0 | yes |
| Command, provider-dependent | `POST …/payment-attempts/:id/invoice` (simulator) | 26.9 ms | 34.2 ms | 36.1 ms | 300 / 1 500 / 3 000 | 0 | yes |

**Gap — the room board.** The one class outside its target is the indexed read the Reception opens
most: p50 77.6 ms against 50 ms (p95 and p99 inside their targets). The board assembles, for every
room, the occupancy, the stay's time state, the cleaning state, the minibar state and its blockers
from several relations; the shortfall is in the query plan, not in the request path, and is
recorded as `A-P22-8` for the phase that tunes it. The provider-dependent class measured a
simulator; a real provider adds its own latency on top of these numbers, within the hard timeout
the port enforces.

## 2. Throughput (doc 15 §3)

The room board for 15 s at 32 in flight: **2 183 requests, 145.5 rps, p95 251.8 ms, 0 errors**
against a target of 200 rps sustained with headroom to 500. **Gap:** the same query as §1, on one
process on one core-bound machine; it is the ceiling of one instance of the heaviest read, not of the
API. Two instances behind a balancer, or the board query tuned, is what would meet the target;
neither is measured here (`A-P22-8`).

"Concurrent check-ins on one room: exactly one succeeds, always" is `GATE-CONC` (`stay.concurrency`,
three runs of 97 races); "export jobs in parallel per hotel: 1" is `reporting.concurrency`.

## 3. Asynchronous latency (doc 15 §2.1)

| Path | Measured | Target | Within |
| --- | --- | --- | --- |
| Police match alert, `check_in_recorded_at` → alert row | 1 122 ms, 1 132 ms, 1 747 ms (one check-in per viewport; the worker's matcher sweep at 2 s in the e2e stack) | p95 < 10 s | yes — with a sweep ≤ 5 s |
| Outbox relay lag | **not measurable**: no consumer runs the relay (`A-P22-7`) | p95 < 5 s | not measured |
| Notification dispatch after commit | the activation delivery in the onboarding journey arrived within the worker's 2 s sweep (the journey waited ≤ 60 s and never had to) | p95 < 30 s | yes, with the e2e cadence |
| Guest registry export, 10 000 rows | not measured — no 10 000-row fixture in this phase | < 5 min | not measured |
| Service-month boundary processing | not measured — the boundary sweep is exercised by `subscription.integration`, not timed | ≤ 15 min | not measured |

The worker's Police sweep default was **60 s**, which cannot meet a 10-second target; Phase 22 sets
it to 5 s (`A-P22-11`). The e2e stack's 2-second sweep is its own setting.

## 4. Availability and degraded modes (doc 15 §4)

Availability percentages need a month of a hosted deployment and are **not measured**. The degraded
modes were injected against the real API (`apps/api/src/resilience/degraded-modes.http.test.ts`, in
`GATE-INTEG`):

| Failure | Documented behaviour | Injected | Observed |
| --- | --- | --- | --- |
| Redis unavailable | rate limits fail closed; queues stall; committed effects preserved | `REDIS_URL` on a closed port for the whole suite | `/health/ready` 503, `/health/live` 200, an authenticated board read 200; the API's provisioning signal cannot enqueue and the sweep would pick the work up; there is no request rate limiter to fail closed (`A-P22-6`) |
| Provider unavailable | provider-dependent actions fail closed with a clear state | QPay simulator armed `UNAVAILABLE` | invoice 412 `PRECONDITION_FAILED`, the hold `HOLDING/ACTIVE/PENDING` untouched, the same attempt opens its invoice once the provider is back |
| ХУР unavailable | manual identity entry with `MANUAL` provenance | XYP simulator armed for one outage | walk-in check-in 201; `stay_guest.provenance = 'MANUAL'` |
| SMS unavailable | in-app alert still raised; delivery retried; failure recorded | SMS simulator armed to fail | the confirmed job persists with its failed and pending deliveries on record |
| Object storage unavailable | export jobs fail cleanly; no partial file | storage simulator armed `UNAVAILABLE` | the Police export answers without a `READY` job and nothing is downloadable |
| KMS unavailable | fail closed, no local-key fallback | `GATE-SEC` `SEC-KMS` (the KMS is the local simulator in every environment this phase can run) | fails closed |

## 5. Durability and recovery (doc 15 §5)

[recovery-runbook.md](recovery-runbook.md) §2 and [phase-22-recovery-rehearsal.json](phase-22-recovery-rehearsal.json):
RPO exposure **25.2 s** (target ≤ 300 s; bounded by a 30 s archive cadence), RTO **1.6 s** for the
restore itself on one machine from a local archive (target ≤ 4 h for the whole procedure, which the
runbook budgets), restore to the end of the archive and to a point in time both verified row for row
and schema for schema, outbox delivery markers intact. Backup encryption and retention are the
deployment's and were not exercised.

The secret-leakage scan over the run's own artefacts (`e2e/leakage.spec.ts`): 181 tables, 2,767 rows, 481,412 bytes of API log, 74 Redis keys, 81 canaries — **zero
findings**.

## 6. Client support and front-end budgets (doc 15 §6)

| Target | Measured | Note |
| --- | --- | --- |
| Browsers, last two majors of Chrome, Edge, Firefox, Safari | Chromium only: Desktop Chrome, Pixel 7 (Android Chrome profile), Galaxy Tab S4 | WebKit and Firefox are not installed here and are not claimed (`A-P21-6`) |
| Cleaner dashboard on 360 px, no horizontal scroll | 412 px (Pixel 7) and 768 px (Galaxy Tab S4) with no document overflow, every primary screen | the 360 px width itself was not driven; the layout is fluid below 768 px |
| Initial JS transferred, public pages | 102 kB First Load JS shared (Next.js production build, uncompressed figure) | target < 250 kB gzipped: within, before compression |
| LCP < 2.5 s (4G), INP < 200 ms, CLS < 0.1 | **not measured** — no throttled-network profile in this phase | Phase 23 |
| Accessibility WCAG 2.1 AA | axe-core over every primary screen at three viewports, serious and critical = fail; manual keyboard traversal not repeated | Phase 21 gate, re-run green |

## 7. Localisation (doc 15 §7)

The copy review against the requirement vocabulary was Phase 21's (`A-P21-5`); unchanged. Hotel-local
dates, `₮` amounts and `Asia/Ulaanbaatar` are the kit's formatters (`packages/web-kit` unit tests).

## 8. Security posture (doc 15 §8)

| Target | Verified by | Result |
| --- | --- | --- |
| Memory-hard KDF, per-user salt | `iam` unit and integration (`derivePassword`, params version) | as specified |
| Session idle / absolute; Operation 30 min / 8 h; Police 15 min / 8 h | `iam.integration`, `operation.security`, `police.security` | as specified |
| Step-up freshness 10 min | `authz` unit, `operation.security` | as specified |
| TLS 1.2+, HSTS | the TLS edge's; the API listens on plain HTTP behind it | not measured here |
| Zero known Critical or High at release | `pnpm run audit:prod` clean; `audit:tree` three moderate (DSR-01, DSR-02) | within |
| Secret leakage findings: zero | `scan-secrets`, `SEC-PII-LEAK`, `SEC-SECRETS`, the e2e leakage scan | zero |
| Security headers and CSP | `health.http`, e2e `security-headers` — new in Phase 22 | present on every API answer and every portal page; the portals' script policy still admits inline script (`A-P22-9`) |
| Penetration test, Police realm in scope | — | EXT-10, not performed |

## 9. What Phase 23 receives

Two measured shortfalls (`A-P22-8`: the room board at p50 and the single-instance throughput), five
targets not measured (availability, outbox relay lag, the 10 000-row export, the service-month
boundary timing, the front-end paint metrics), one default corrected to meet a target (the Police
sweep), and the two structural findings (`A-P22-6` rate limiting, `A-P22-7` outbox relay).
