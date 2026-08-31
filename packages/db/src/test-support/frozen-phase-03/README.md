# Frozen Phase 03 accepted state

`0000_baseline.sql` and `0001_kernel.sql` exactly as they stood when **Phase 03
was accepted**, at commit `3ac74a6`. Phase 04's migration is the only thing that
may be applied on top of them.

The upgrade half of `GATE-MIGR` applies **this** artefact and then head, so what
is actually proved is the deployment step a running cluster would take: an
accepted Phase 03 database receiving exactly one new migration. The two files
here are pinned by checksum, so if `0000` or `0001` were ever edited in place
this test fails rather than quietly re-baselining — which is what "an accepted
migration is immutable" has to mean to be worth anything (ADR-0004).

```
sha256(0000_baseline.sql) = 2a202d67ce10c9f8fa74166c38616c16e95216ff9f00c8cd6bf28bbb025858bc
sha256(0001_kernel.sql)   = 00c5f11768cc1b274209465526f016f397f88d18d4343220ea0279db9a3fbff4
```

`0002_iam_rbac_staff.sql` is deliberately **not** here. It belongs to the phase
under repair: it has never been accepted and never been applied to a deployed
cluster, so Phase 04 corrects it in place rather than by a forward migration,
and the Phase 04 delta stays exactly one migration — which is the thing this
directory exists to test the application of.
