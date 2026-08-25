# 15 — Non-Functional Targets

Measurable acceptance targets. This document **closes P1-10**, which the requirements left open as
"response time, concurrent users, uptime, backup/RPO/RTO, browser and mobile support, Mongolian
language and timezone" (doc 00 §3).

Each target is a proposed default derived from the operating profile in the requirements. Targets are
verified in Phase 22 and signed off by the customer in Phase 23. Where a target is not met, the phase
reports it rather than lowering it.

---

## 1. Operating profile assumptions

| Assumption | Value | Basis |
| --- | --- | --- |
| Hotels at MVP | 50–200 tenants | Subscription model, Operation Dashboard pagination defaults |
| Concurrent hotel staff | ≤5 per hotel, ~300 peak platform-wide | Reception + Cleaner + Manager per shift |
| Peak check-in/checkout | 10–20 per hotel per day, clustered around the fixed checkout time | `STAY-DEC-007` |
| Concurrent public searchers | ~500 peak | Public discovery is the only unauthenticated load |
| Police portal users | Tens, low volume, high sensitivity | doc 13 |
| Restaurant orders | ≤50 per hotel per day, bursty at meal times | doc 08 |
| Data volume year one | <10 M stays, <100 M ledger rows | Derived from the above |

If real volumes diverge materially, these targets are revisited by ADR rather than silently missed.

---

## 2. Latency

Server-side, measured at the API boundary, excluding client network.

| Class | Example | p50 | p95 | p99 |
| --- | --- | ---: | ---: | ---: |
| Read, indexed | Room list, order board, own bookings | 50 ms | 200 ms | 500 ms |
| Read, paginated search | Guest registry page, subscription list | 100 ms | 400 ms | 800 ms |
| Public search | Hotel search with availability | 150 ms | 600 ms | 1 200 ms |
| Command, simple | Cleaning status, task claim, acknowledge | 100 ms | 300 ms | 700 ms |
| Command, transactional | Check-in, checkout, deposit allocation, shift close | 200 ms | 800 ms | 1 500 ms |
| Command, provider-dependent | Booking payment initiation | 300 ms | 1 500 ms | 3 000 ms |

Provider-dependent commands exclude external latency from the platform budget but **include** the
timeout policy: a provider call has a hard timeout and a defined fail-closed outcome, so a slow
provider degrades into a reconciliation case rather than an unbounded request.

### 2.1 Asynchronous latency

| Path | Target |
| --- | --- |
| Outbox relay lag, p95 | < 5 s |
| Police Match alert from `check_in_recorded_at` to portal visibility, p95 | < 10 s |
| Notification dispatch after commit, p95 | < 30 s |
| Guest registry export, 10 000 rows | < 5 min |
| Service-month boundary processing | Complete within 15 min of the boundary |

Police alert latency is the most consequential asynchronous target; it is monitored and alerted
([13](13-telemetry-and-redaction.md) §6).

---

## 3. Throughput and capacity

| Metric | Target |
| --- | --- |
| Sustained API requests | 200 rps with headroom to 500 rps |
| Concurrent authenticated sessions | 1 000 |
| Worker jobs | 100 per minute sustained; queue drains within 5 min of a burst |
| Concurrent check-ins on one room | Exactly one succeeds, always (`GATE-CONC`) |
| Export jobs in parallel per hotel | 1; additional requests queue |

---

## 4. Availability

| Component | Target | Window |
| --- | --- | --- |
| API — hotel operations | 99.5% | Monthly, excluding announced maintenance |
| API — public search and booking | 99.5% | Monthly |
| Police portal | 99.5% | Monthly |
| Worker | 99.0% | Monthly; delay is tolerable, loss is not |

Hotels operate 24/7 (doc 03 §3), so there is no natural maintenance window. Deploys are rolling, and
the expand/contract migration discipline in [12](12-migration-strategy.md) exists precisely so a
deploy needs no downtime.

**Degraded modes** that must not become outages:

| Failure | Behaviour |
| --- | --- |
| Provider unavailable | Cash and manual POS paths continue; provider-dependent actions fail closed with a clear state |
| XYP unavailable | Manual identity entry with `MANUAL` provenance (`RC-DEC-007`) |
| SMS unavailable | In-app alert still raised; delivery retried; Police escalation records the failure |
| Redis unavailable | Rate limits fail closed; queues stall; committed effects are preserved in the outbox |
| Object storage unavailable | Export jobs fail cleanly; no partial file is published |

---

## 5. Durability and recovery

| Target | Value |
| --- | --- |
| RPO | ≤ 5 minutes (continuous WAL archiving) |
| RTO | ≤ 4 hours for full service restoration |
| Backup retention | 30 days point-in-time, plus monthly archives per the P1-09 retention matrix |
| Restore rehearsal | Every release cycle; mandatory in Phase 22 |
| Backup encryption | At rest and in transit |

A restore must not replay already-delivered side effects; the outbox delivery marker and the
documented cut-off procedure prevent duplicate email or SMS
([02](02-container-and-deployment.md) §7).

---

## 6. Client support

| Target | Value |
| --- | --- |
| Browsers | Last two major versions of Chrome, Edge, Firefox, Safari |
| Mobile | iOS Safari and Android Chrome, last two major versions |
| Cleaner dashboard | Mobile-first; primary actions usable on a 360 px viewport with no horizontal scrolling and few taps (doc 04 §3) |
| Public booking | Fully responsive on phone and laptop (doc 09 §13) |
| Offline | Not supported in MVP; the system fails visibly rather than queuing locally |

### 6.1 Front-end budgets

| Metric | Target |
| --- | --- |
| Largest Contentful Paint, public search, 4G mobile | < 2.5 s |
| Interaction to Next Paint | < 200 ms |
| Cumulative Layout Shift | < 0.1 |
| Initial JS transferred, public pages | < 250 kB gzipped |

### 6.2 Accessibility

WCAG 2.1 AA on every primary screen: keyboard reachability, visible focus, 4.5:1 contrast, labelled
controls, screen-reader-announced errors. Verified by automated scan plus manual keyboard traversal in
Phase 21.

---

## 7. Localisation

| Target | Value |
| --- | --- |
| Primary UI language | Mongolian (Cyrillic) |
| Canonical status vocabulary | Taken verbatim from the requirements: `Цэвэр`, `Бүтэн`, `Дутуу`, `Тодорхойгүй`, `Хамаарахгүй`, `Үндсэн касс`, `Өөрөө хаасан` |
| Timezone | Per-hotel IANA zone; `Asia/Ulaanbaatar` seed; UTC storage |
| Currency display | MNT integer with thousands separators, `₮` suffix |
| Dates | Hotel-local for business dates; explicit timezone shown where ambiguity is possible |
| SMS encoding | Unicode Cyrillic; segment counting matched to the provider contract (EXT-05) |

---

## 8. Security posture targets

| Target | Value |
| --- | --- |
| Password storage | Memory-hard KDF (Argon2id or equivalent), per-user salt |
| Session idle / absolute | Hotel and Guest: per policy; Operation 30 min / 8 h; Police 15 min / 8 h |
| Step-up freshness | 10 minutes for high-risk Operation and Police actions |
| Transport | TLS 1.2 or higher; HSTS on all portals |
| Dependency vulnerabilities | Zero known Critical or High at release |
| Secret leakage findings | **Zero** — a finding blocks release |
| Penetration test | Before production, scoped to include the Police realm (EXT-10) |

---

## 9. Verification

| Target group | Gate | Phase |
| --- | --- | --- |
| Latency and throughput | Load test against seeded realistic volumes | 22 |
| Availability and degraded modes | Fault injection: provider down, Redis down, storage down | 22 |
| RPO / RTO | Restore rehearsal, measured | 22 |
| Browser and mobile support | `GATE-E2E` across the viewport matrix | 21 |
| Accessibility | Automated scan plus manual keyboard traversal | 21 |
| Localisation | Copy review against the requirement vocabulary | 21 |
| Security posture | `GATE-SEC` plus penetration test | 22 |

Any target missed in Phase 22 is reported to the customer as a release decision, not quietly adjusted.
