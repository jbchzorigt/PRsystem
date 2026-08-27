# Frozen Phase 02 baseline

A byte-for-byte copy of `packages/db/migrations/0000_baseline.sql` as it stood at
commit `f3d7b3d` — the Phase 02 scaffold commit that released it.

The upgrade half of `GATE-MIGR` applies **this** artefact, never a runtime copy
of the live `0000`. Copying the current file would make the upgrade test a
tautology: it would prove that head upgrades from head.

```
sha256(0000_baseline.sql) = 2a202d67ce10c9f8fa74166c38616c16e95216ff9f00c8cd6bf28bbb025858bc
```

The checksum is asserted by `packages/db/src/migrate.test.ts`. If the live
`0000` ever changes, this file does **not** — that is the point. A deliberate
change to the released baseline would be a new migration, not an edit here.
