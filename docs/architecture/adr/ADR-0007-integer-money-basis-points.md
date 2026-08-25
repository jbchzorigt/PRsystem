# ADR-0007 — Integer MNT and integer basis points

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §5; PAY-DEC-008

## Context

Money appears in folios, deposits, cash ledgers, commission, settlement and inventory valuation.
Floating point silently loses value; string decimals invite inconsistent parsing. The requirements
specify integer amounts, integer basis points and a single `ROUND_HALF_UP`.

## Decision

Amounts are `bigint` MNT with a branded TypeScript type. Rates are `integer` basis points. Rounding
happens exactly once, at the point the requirements name, using `ROUND_HALF_UP`. Division exists only
inside the two rounding helpers. Durations follow the same rule: integer minutes and integer half-hour
units, never fractional hours.

## Alternatives rejected

- **`numeric` with scale.** Invites accidental floating conversion at the JavaScript boundary.
- **Decimal library.** Adds a dependency and an arithmetic surface for a currency with no subunit.
- **Minor units.** MNT has no subunit in these requirements; a phantom scale would mislead.

## Consequences

- The API serialises `bigint` as a string so clients cannot truncate it.
- A plain `number` cannot be passed where money is expected.
- Adding a second currency later would require a currency dimension; the change is contained in
  `packages/money`.
