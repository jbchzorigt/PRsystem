# Minibar version archive — accepted stage 5 increment

Implements docs/26 §§30–32: a Published exact version can become Archived only
when it is not Default, current room configuration, pending target or source,
active stay reference, or unfinished canonical Cleaner/reconciliation work.
The Manager preview groups blocker counts without disclosing guest identities.
Final command repeats the check under the same catalog/template locks used by
Default, room requests and reconciliation. Preview is advisory and read-only.

Migration 047 adds an immutable tenant-scoped archive proof with actor, reason
and server time. Proof, terminal version state, template revision, audit and
idempotency receipt commit together. Published items/timestamps and historical
references stay unchanged. No stock, price, charge, room pointer, pending request,
Cleaner task, booking, rollout or blocker is created or modified by archive.
Only exact replay returns an already successful result. Current authorization is
checked before replay. Archived versions cannot be edited, made Default or
republished; cloning into a new Draft remains available for an active template.

Archive uses the existing current subscription/package/Manager gate: Manager on
25,000₮; Manager or Manager Plus on 30,000₮. Hotel Admin requires the operational
role too. Cleaner/Reception cannot issue archive commands. Archiving an unused
version can also finish history cleanup for a retiring/inactive parent; archive
does not reactivate that parent.

## Exact-reference boundaries

Current and pending references use canonical configuration/application IDs;
unfinished Cleaner sources also retain their target and prior application.
Terminal cancelled/applied requests and closed tasks do not block by themselves.
An OFF room retains history without being an active ON reference. Future booking
has no version pin and is not inspected as a standalone blocker.

The additive stay reference contract is `snapshot.minibar_snapshot.template_id`
and `version_id`. Migration 047 checks tenant/template/version lineage and locks
the parent/version for any new snapshot with those IDs; ACTIVE references require
Published state. Existing OFF and isolated MOCK_ON snapshots have no canonical
IDs. This protects archive concurrency for the future canonical stay producer;
it does not enable canonical guest check-in, refill or consumption reporting.
Tests of that exact snapshot contract use explicitly constructed DB fixtures,
not a claim that the public canonical check-in flow is implemented.

## API, UI and grants

GET `/hotels/{tenant}/minibar/templates/{template}/versions/{version}/archive-preview`
returns bounded blocker categories/counts, eligibility, revision and archive history.
POST the same version `/archive` accepts reason, expected_revision and idempotency_key.
The existing shared version detail adds a load/retry preview, blocker table,
reason/acknowledgement form and archived history. Archived detail exposes clone,
with Default/Publish/room-target actions removed. Shared form owners retain inputs,
CAS and the same idempotency key after an unknown response.

In addition to existing template grants, archive roles need SELECT/INSERT on
`minibar_version_archive`, SELECT on room, stay, configuration request,
reconciliation and cleaning_task for blocker checks; existing UPDATE(state) on
version, UPDATE(revision) on template and audit/receipt INSERT grants are retained.
The additive canonical stay producer needs SELECT on template/version when it
writes exact IDs. Do not grant UPDATE/DELETE on archive proof. RLS is forced.

## Verification and remaining scope

Accepted source: `c358be6ef82b973f34af4923524e2d89503db698`, tree
`73ddba3f5b65ef24f78465d016e981fb8214363d` (identical to local `fd11cb1`).
[Full CI](https://github.com/jbchzorigt/PRsystem/actions/runs/34420251943) passed
**585/585 backend tests without skips in 550.490 seconds**, including all 16 new
archive tests. All seven Chromium suites, 43 actual browser/API command contracts,
design lint and shared-token checks passed. Strict local UI audit had zero findings.
Design lint has six existing unused-token warnings and zero errors. Desktop and
320px archive screenshots were inspected. Local discovery had 100 executed tests
and 485 database tests skipped; the linked remote run is the acceptance evidence.

The user explicitly approved publishing the source/workflow payload to the existing
public `jbchzorigt/PRsystem`, branch `feat/approved-risk-controls`, Draft PR #1.
Publication succeeded; the earlier automatic approval block is resolved.

Verification corrections retained in history:
- The database guard additionally rejects direct Draft → Archived writes, with a
  regression assertion; only Published with immutable archive proof can transition.
- Initial full runs passed 584/585 tests without skips. A whitespace-only reason
  correctly returned the established HTTP 422 / INVALID_REQUEST response while a
  test expected 400. The assertion now expects 422 and verifies unchanged eligibility.
- The next run passed all 16 archive tests, but an existing Cleaner continuation
  fixture picked the first lexically sorted random suspension exception ID. Its
  worker owned both a shift and a Cleaner task, so it sometimes selected the shift
  and correctly received WORK_SOURCE_NOT_FOUND. The test now selects the exact
  CLEANING_TASK source ID. No application rule was weakened.
- The final full run passed with both deterministic test corrections.

Product/template entity lifecycle, batch rollout, reconciliation variance/override,
partial rollback, canonical guest opening/refill/report, Restaurant and Operation
remain. External providers remain approved mocks; no merge/deployment is included.
