# PRsystem — Architecture and Threat Model

**Phase:** 01 — Architecture and threat model
**Status:** Documentation only. No application code, no scaffold, no dependencies exist yet.
**Authority:** Subordinate to [CLAUDE.md](../../CLAUDE.md) and to the immutable requirements
[docs/00](../00-mvp-open-decisions.md) … [docs/26](../26-room-minibar-lifecycle.md).

This directory is the design baseline every later phase builds against. Where this directory and a
requirement document disagree, the requirement document wins and the conflict is recorded in
[assumptions-and-conflicts.md](../implementation/assumptions-and-conflicts.md).

---

## Reading order

| # | Document | Answers |
| --- | --- | --- |
| 01 | [System context](01-system-context.md) | Who uses the system, what it talks to, what crosses the boundary |
| 02 | [Container and deployment view](02-container-and-deployment.md) | What runs, where state lives, how a request flows |
| 03 | [Module ownership and dependency rules](03-module-ownership-and-dependencies.md) | Which module owns which table, what may import what |
| 04 | [Logical data model](04-logical-data-model.md) | Aggregates, ERD per bounded context, key invariants |
| 05 | [Authentication realms and authorization](05-authentication-realms-and-authorization.md) | The four realms and the seven-condition authorization pipeline |
| 06 | [Tenant boundaries](06-tenant-boundaries.md) | How `hotel_id` scope is carried, enforced and tested |
| 07 | [Data classification](07-data-classification.md) | Five sensitivity classes and the handling rule per class |
| 08 | [Trust boundaries](08-trust-boundaries.md) | Every boundary an attacker can reach and what validates it |
| 09 | [Threat model](09-threat-model.md) | STRIDE per realm and per external interface, with mitigations |
| 10 | [Money and time invariants](10-money-and-time-invariants.md) | Integer money, basis points, UTC, hotel-local dates, intervals |
| 11 | [Concurrency strategy](11-concurrency-strategy.md) | Which mechanism to use for which class of race |
| 12 | [Migration strategy](12-migration-strategy.md) | Versioned migrations, fresh and upgrade testing |
| 13 | [Telemetry and redaction](13-telemetry-and-redaction.md) | What is logged, what is never logged, how it is enforced |
| 14 | [Test strategy and gates](14-test-strategy-and-gates.md) | The eight gates and what each must prove |
| 15 | [Non-functional targets](15-non-functional-targets.md) | Provisional NFR targets proposed for P1-10 (P1-10 stays open) |
| 16 | [External port catalog](16-external-port-catalog.md) | The typed port surface for each EXT gate, plus `KeyManagementPort` |
| 17 | [DEC control and test mapping](17-dec-control-mapping.md) | All 279 decisions mapped to controls and gates |
| — | [Architecture decision records](adr/README.md) | ADR-0001 … ADR-0020, incl. DM-01 … DM-04 closure |

---

## Phase 01 scope boundary

Delivered in this phase:

- the documents listed above and twenty ADRs;
- the control catalog (`CTL-*`, 41 controls) and gate catalog (`GATE-*`) that later phases cite;
- closure of the four design questions DM-01 … DM-04 as ADR-0017 … ADR-0020;
- measurable non-functional targets **proposed** for P1-10, all marked `PROVISIONAL_ARCHITECTURE_DEFAULT`; P1-10 itself remains open pending an approved DEC;
- extension of `tools/validate-governance.mjs` with the Phase 01 architecture gates.

Explicitly **not** delivered in this phase, by instruction and by
[build-plan.md](../implementation/build-plan.md) §4:

- no workspace, package manifest, lockfile or installed dependency;
- no application, module, migration or test code;
- no modification to `docs/00` … `docs/26`;
- no Phase 02 work.

---

## Conventions used throughout

- **Aggregate** — a consistency boundary written inside one database transaction.
- **Module** — a code unit owning a set of tables and exposing a `contracts` surface.
- **Realm** — an isolated authentication population (Hotel, Guest, Operation/Platform, Police).
- **`CTL-*`** — a named control defined in [17](17-dec-control-mapping.md) §2.
- **`DM-*`** — a Phase 01 design question. All four are closed by ADR-0017 … ADR-0020; none remains
  open.
- **`GATE-*`** — a named test gate defined in [14](14-test-strategy-and-gates.md) §2.
- **DEC** — a canonical requirement decision; the register is
  [requirements-traceability.md](../implementation/requirements-traceability.md).
- Mongolian terms are kept verbatim where they are canonical identifiers in the requirements
  (`Цэвэр`, `Бүтэн`, `Дутуу`, `Тодорхойгүй`, `Хамаарахгүй`, `Үндсэн касс`, `Өөрөө хаасан`).
