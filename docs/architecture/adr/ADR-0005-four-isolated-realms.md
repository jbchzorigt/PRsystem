# ADR-0005 — Four isolated authentication realms in one deployment

**Status:** Accepted · **Date:** Phase 01 · **Mandated by:** CLAUDE.md §4; RBAC-DEC-004; POL-DEC-007

## Context

Guest, Hotel, Operation/Platform and Police populations have incompatible trust levels. The
requirements are emphatic: hotel users must never learn that a Police match exists; Operation and
Platform accounts must not reach guest or Police data; a role name must never grant data access. The
single-deployment decision (ADR-0001) removes network separation as a mechanism.

## Decision

Model four realms with separate account populations, separate credential policies, separate session
policies and no shared permissions. The realm is recorded on the session and checked first in the
authorization pipeline. The `police` module is imported by no other module; the only hotel→Police
data path is a minimal outbox event, and there is no return path.

## Alternatives rejected

- **One account table with a realm column.** One bug in a query predicate would cross realms.
- **Shared permission namespace.** Invites accidental grants across populations.
- **Separate deployment for Police.** Contradicts ADR-0001 and would not itself prevent the leak paths
  that matter — the event payload and the response-shape side channel.

## Consequences

- A hotel employee who is also a booking guest holds two unrelated accounts.
- Realm isolation must be tested explicitly, including a timing-parity test so match existence cannot
  be inferred (`T-POL-02`).
- The minimal check-in event schema is a security control, not a convenience, and changing it requires
  a new ADR.
