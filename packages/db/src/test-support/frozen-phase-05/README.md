# Frozen Phase 05 accepted state

`0000_baseline.sql` … `0006_onboarding_remediation3.sql` exactly as they stood
when **Phase 05 was accepted**, at commit
`35314ba210f609269863f0b528bbe827e6a5d3ce`. The migrations of the phases not yet
accepted — Phase 06's and Phase 07's — are the only things applied on top of them.

The upgrade half of `GATE-MIGR` applies **this** artefact and then head, so what
is proved is the deployment step a running cluster would actually take: an
accepted Phase 05 database receiving exactly one new migration. Every file is
pinned by checksum, so an in-place edit to any of them fails the gate rather
than quietly re-baselining the upgrade path onto whatever they became — which is
what "an accepted migration is immutable" has to mean to be worth anything
(ADR-0004).

```
sha256(0000_baseline.sql)                 = 2a202d67ce10c9f8fa74166c38616c16e95216ff9f00c8cd6bf28bbb025858bc
sha256(0001_kernel.sql)                   = 00c5f11768cc1b274209465526f016f397f88d18d4343220ea0279db9a3fbff4
sha256(0002_iam_rbac_staff.sql)           = 25aae0e6cdbb6d6c18ff32068b6e0a6761bee130af45d336aa82aa269e038b47
sha256(0003_onboarding_subscription.sql)  = 0f246511c1c811aefd9d3688e7e73ee6c53c088539a3efc60b525f7357dbbee6
sha256(0004_onboarding_remediation.sql)   = d06d81d1c33f10c65f4b98269361766ff60f8160ea3e9d1f83c3bc7df46e6ea4
sha256(0005_onboarding_remediation2.sql)  = 00b3aac3e305ff806c5589266a653ddd324fe5054916530ecd6d39676492ba3f
sha256(0006_onboarding_remediation3.sql)  = 4aeba55fd1915863e8dc282550a6d3a7b46bf2c8c9996065e372e1843e9c74f5
```

`0007_hotel_catalog.sql` and `0008_minibar_inventory.sql` are deliberately **not**
here. They belong to the phases not yet accepted and are what the upgrade applies.

The Phase 03 and Phase 04 artefacts next door are kept as well, and all three
upgrade paths are exercised: 0 → 2 → 8, 0 → 3 → 8 and 0 → 7 → 8. A phase that
only ever tested the newest accepted release would stop proving that an older
cluster can still reach head.
