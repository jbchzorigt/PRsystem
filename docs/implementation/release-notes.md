# PRsystem — Release candidate notes

**Candidate:** the tree audited in [release-candidate-audit.md](release-candidate-audit.md); the
exact commit is the one the Phase 23 record in [phase-status.md](phase-status.md) names as measured.
**Version label:** the workspace packages stay at `0.0.0`; this candidate is identified by its
commit, not by a semantic version, because no release has been approved and no version has been
adopted by the customer (`A-P23-3`).
**Status:** release candidate, **not released**. Every external and internal gate is blocked; see
the audit's §2 and §9 for what a production release requires.

---

## 1. What the candidate is

A multi-tenant hotel booking and operations platform as one API deployment, one worker deployment
and five web portals (Public and Guest, Hotel Operations, Restaurant, Police, Platform Operation),
on PostgreSQL 17 with Redis for queues only, built through Phases 01–23 of
[build-plan.md](build-plan.md) against the 27 immutable requirement documents and their 279
decisions, all `COVERED`.

## 2. Contents by module

| Area | Phase | What is in the candidate |
| --- | --- | --- |
| Platform kernel | 03 | realms, tenancy, action-level authorization, immutable audit, transactional outbox, idempotency, money and time primitives, the restricted database roles and the migration principal |
| IAM, RBAC, staff | 04 | hotel staff accounts, memberships, named permissions, package entitlement as a hard gate, invitations, step-up |
| Onboarding and subscription | 05 | application → OTP → invoice → payment → provisioning; packages, renewal, grace and lock lifecycle; eBarimt issuance intent and retry queue |
| Hotel catalog | 06 | hotels, rooms, categories, hourly and nightly tariffs with precedence and snapshots |
| Minibar | 07 | products, templates and versions, room configuration, rollouts, stock movements, price books |
| Availability, identity, reception, stay | 08 | availability intervals, guest identity with encrypted identifiers and keyed lookup, walk-in quote and check-in, stay time states, actual-time correction |
| Cleaner and checkout | 09 | cleaner queues, minibar reports, checkout exceptions and disputes, cleaning tasks and readiness |
| Folio, deposit, payment | 10 | folio, deposit allocation, payments, corrections and reversals |
| Shift, cash, finance | 11 | reception shifts, cash drawer ledger, expenses, hotel finance dashboard |
| Public discovery and Guest auth | 12 | public hotel search and listing projections, guest registration by phone, e-Mongolia port |
| Online booking | 13 | ten-minute hold, category inventory, cancellation and no-show rules |
| Payment, refund, settlement | 14 | provider invoices and callbacks, refunds, commission, D+1 settlement ledger, payout batches |
| Restaurant | 15 | room QR and access codes, menus, orders with separate fulfilment, payment, refund and handoff axes |
| Reviews | 16 | verified reviews, reports, moderation, official reply |
| Guest registry, exports, reports | 17 | server-filtered registry, background exports to private storage, retention with legal hold, Hotel Admin dashboard |
| Police monitoring | 18 | Person–Case–Match, wanted registration, matcher, alerts, two-person decisions, exports, hardened bootstrap and sessions, a separate database credential |
| Platform Operation | 19 | named accounts with TOTP, KPI dashboard, subscription list, suspension, resets, onboarding and reconciliation queues, manual SMS jobs |
| External adapters | 20 | the gate register as code, adapter selection that fails closed, the S3 adapter (disabled), callback allowlists, provider jobs on the worker |
| Portals | 21 | the five portals on the real API through a shared kit; accessibility scanned |
| Security, recovery, E2E | 22 | recovery rehearsal and runbook, full journeys, runtime leakage scan, concurrency coverage, fault injection, security headers, measured targets |
| Release audit | 23 | this candidate's audit, notes, runbook and rollback plan |

## 3. Database

Twenty-two versioned migrations, `0000_baseline` to `0021_stay_booking_ref_text`, applied by the
restricted migration principal only ([database-bootstrap-runbook.md](database-bootstrap-runbook.md));
no down-migrations, no schema push. Fresh install and the upgrade paths from the Phase 02 baseline
and from the accepted Phase 03, 04 and 05 databases reach the same schema
(`pnpm run test:migrations`, 148 assertions).

## 4. What runs in production, and what does not

- **Runs, once INT-KMS-01 is cleared:** everything a hotel does at Reception without a provider —
  staff, catalog, minibar, walk-in stays, cleaning, folio with cash and manual POS references,
  shifts, finance, registry (exports need INT-STORAGE-01), reviews of completed stays, the Hotel
  and Restaurant portals, the Operation portal.
- **Fails closed behind a gate:** online payments (EXT-03/04), payouts (EXT-07), eBarimt (EXT-11),
  ХУР lookups (EXT-01), e-Mongolia (EXT-02), SMS (EXT-05), geocoding (EXT-06), email
  (INT-MAIL-01), phone OTP (INT-OTP-01), object storage (INT-STORAGE-01). Each answers `DISABLED`
  naming its gate; no network call is made.
- **Disabled without an approved configuration row:** the Police escalation timer and the
  historical check-in search (EXT-09).
- **Off by default:** the Police realm (`POLICE_ENABLED`), the scheduler capability outside
  production (`SCHEDULER_ENABLED`).
- **Does not start without:** an approved key-management adapter (`KMS_ADAPTER`; INT-KMS-01).

## 5. Known limitations recorded by the programme

- Two non-functional targets measured short on one instance: the room-board p50 and sustained
  throughput (`A-P22-8`); five targets not measured (audit §6).
- No general request rate limiter (`A-P22-6`); the outbox relay is durable but unscheduled
  (`A-P22-7`); the portals' content security policy admits inline script (`A-P22-9`).
- API reads the portals still lack: a wanted-person list, a hotel-side order and staff list, a
  Cleaner count sheet, Police account management, the reconciliation terminal outcome
  (`A-P21-4`); several domain sweeps are unscheduled (`A-P20-9`); the SMS delivery refresh is an
  Operation command rather than a job (`A-P20-5`).
- Browsers: measured on Chromium profiles only. Manual keyboard traversal not repeated after
  Phase 21.
- The three Police security exceptions are implemented as decided and unapproved (audit §3).
- Two moderate dev-only dependency advisories are contained, not closed (`DSR-01`, `DSR-02`).

## 6. Deferred scope

As recorded in [assumptions-and-conflicts.md](assumptions-and-conflicts.md) §5 and doc 00 §5:
restaurant add-ons and limits beyond P1-06, scheduled SMS campaigns and a two-way inbox, hotel
account recovery without the registered email, Police bulk export of the check-in list,
co-occupant registration, merging restaurant payments into the hotel checkout, the nightly
early-morning cutoff, retroactive Police matching, changes to a planned checkout, package
downgrade, subscription refunds, and relocation or compensation for hotel-caused overbooking.

## 7. Evidence

Per phase: `phase-NN-evidence.json`, `phase-NN-battery-log.md` and the record in
[phase-status.md](phase-status.md). Programme-wide: [requirements-traceability.md](requirements-traceability.md),
[external-integration-gates.md](external-integration-gates.md),
[dependency-security-register.md](dependency-security-register.md),
[phase-22-measurements.md](phase-22-measurements.md), [phase-22-security-review.md](phase-22-security-review.md),
[recovery-runbook.md](recovery-runbook.md).
