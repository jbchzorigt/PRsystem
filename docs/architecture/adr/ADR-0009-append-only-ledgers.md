# ADR-0009 — Append-only ledgers with reversal and correction records

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §5

## Context

Across deposits, cash, inventory, minibar reports, settlement and Police outcomes the requirements
repeat one rule: never edit or delete the original; correct through reversal, correction or amendment.
Auditability depends on it, and several decisions rely on reconstructing what was true at a past
moment.

## Decision

Ledger and lifecycle-history tables are append-only, enforced by database rules or triggers that
reject `UPDATE` and `DELETE`. Balances are derived by summation, never stored and overwritten.
Corrections are new rows linked to the original, carrying reason, actor and effective time. Retention
deletion, where legally required, is a privileged audited maintenance path gated by legal hold — not
an ordinary application delete.

## Alternatives rejected

- **Mutable rows with an audit shadow table.** The shadow can drift; the requirements ask for the
  original to be authoritative and intact.
- **Soft-delete flags on ledgers.** A flag is a mutation, and it invites queries that forget it.

## Consequences

- Reads sum ledgers; hot aggregates get projections rather than mutable balance columns.
- Correcting a mistake always produces at least two rows, which is what makes the history explainable.
- The append-only rule is created in the same migration as the table, so it can never be forgotten.
