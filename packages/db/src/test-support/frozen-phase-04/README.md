# Frozen Phase 04 accepted state

`0000_baseline.sql`, `0001_kernel.sql` and `0002_iam_rbac_staff.sql` exactly as
they stood when **Phase 04 was accepted**, at commit
`e5fcf19c4164c72106b6d2408f460751ad30685f`. Phase 05's migration is the only
thing that may be applied on top of them.

The upgrade half of `GATE-MIGR` applies **this** artefact and then head, so what
is proved is the deployment step a running cluster would actually take: an
accepted Phase 04 database receiving exactly one new migration. All three files
are pinned by checksum, so an in-place edit to any of them fails the gate rather
than quietly re-baselining the upgrade path onto whatever they became — which is
what "an accepted migration is immutable" has to mean to be worth anything
(ADR-0004).

```
sha256(0000_baseline.sql)       = 2a202d67ce10c9f8fa74166c38616c16e95216ff9f00c8cd6bf28bbb025858bc
sha256(0001_kernel.sql)         = 00c5f11768cc1b274209465526f016f397f88d18d4343220ea0279db9a3fbff4
sha256(0002_iam_rbac_staff.sql) = 25aae0e6cdbb6d6c18ff32068b6e0a6761bee130af45d336aa82aa269e038b47
```

`0003_onboarding_subscription.sql` is deliberately **not** here. It belongs to
the phase under construction and is the one thing the upgrade below applies.

The Phase 03 artefact next door is kept as well, and both upgrade paths are
exercised: 0 → 2 → 4 and 0 → 3 → 4. A phase that only ever tested the newest
accepted release would stop proving that the older one still upgrades.
