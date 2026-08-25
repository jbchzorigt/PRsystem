# ADR-0001 — Modular monolith with one API and one worker deployment

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §1

## Context

The platform spans five portals and four security realms with strongly interdependent domains: a
check-in touches identity, tariffs, minibar configuration, price books, cash and Police matching in
one consistent step. The requirements demand transactional guarantees across those areas — one
transaction, immutable audit, transactional outbox, row locks (`ONB-DEC-006`, `STAY-DEC-008`,
`DEP-DEC-007`).

## Decision

Ship a modular monolith: exactly one `api` deployment and one `worker` deployment, plus five portal
builds. Modules are enforced code boundaries inside one process, not network services. No
microservices, no Kubernetes requirement, no distributed broker for the MVP.

## Alternatives rejected

- **Service per domain.** Would turn `ONB-DEC-006`'s all-or-nothing provisioning and the deposit
  balance identity into distributed transactions or sagas, adding failure modes the requirements do
  not ask us to solve.
- **Serverless functions.** Poor fit for row-lock-heavy workloads and long-running export and
  reconciliation jobs.
- **Single process including workers.** A slow export or reconciliation job would compete with
  interactive check-in latency.

## Consequences

- Cross-module consistency is a local transaction — the cheapest correct option.
- Module boundaries must be enforced deliberately, since the compiler alone will not stop a
  cross-module repository import. See ADR-0013.
- Realm isolation cannot rely on network separation; it is enforced in code and data. See ADR-0005.
- Horizontal scaling is per-deployment. Given the operating profile in `15-non-functional-targets.md`
  this is ample.
- Extracting a service later remains possible because modules already communicate through contracts.
