# Daily workflow UI/UX follow-up

Date: 2026-09-15. Scope: development UI before live provider connections.
This builds on docs/74 and the existing FastAPI implementation. It does not
migrate the backend to Django or connect live payment, messaging or email services.

## Observed problems and implemented behavior

| Observed problem | Implemented behavior |
| --- | --- |
| Cleaner could not identify a room from a generic task heading | Assigned and unclaimed checkout tasks show room number, floor and category from the existing authorized read projections |
| Claim/start/post left the previous action visible | Successful commands reload the owning queue and expose the next action or empty state |
| Task quantity could exceed visible remaining work | Shared numeric validation blocks values above the displayed remaining quantity; the server still checks current work |
| Manager creates a category but room selector stays stale | Confirmed category/room/settings commands refresh the Manager destination |
| Refresh fails after an already confirmed command | The submitted form is retired first; the notice offers read recovery without repeating the mutation |
| Saving one form can discard another form's draft | Automatic navigation pauses while another form is dirty; explicit refresh uses the shared discard guard |
| Manager manually enters technical publication revisions | Rank, profile and category publication use their loaded server snapshot revisions |
| Editing a public profile requires uploading its photo again | Existing photos are preserved unless a replacement is selected; coordinates have both lower and upper bounds |
| Three minibar shortcuts displace the room task on a narrow screen | Room tasks appear first, followed by one grouped minibar action section |

Category publication still asks for a replacement photo and explains replacement.
Its existing read model does not return category photos. Profile photos are
already part of the authenticated read model and can be preserved safely.
Legacy cleaning sources without a matching catalog room remain visible with an
explicit unknown-room label; joins never silently remove their work.

## Authority and recovery boundaries

The added room/category joins include tenant IDs. Operations remains restricted
to the assigned actor; the checkout queue remains unclaimed-or-own. The new
fields contain no guest identity, contact, room pricing or financial amounts.
The PostgreSQL regression checks a pure Cleaner session, another Cleaner,
another tenant and the pre-expiry completion path.

Commands keep their existing authorization, assignment version, CAS revision and
idempotency contracts. An unconfirmed response retains the exact command/key
for an explicit retry. A confirmed response retires the form before reads.
An unrelated draft remains in memory with its navigation warning. Reloading the
browser still does not persist private work into local/session storage.

## Verification

- `tests/browser/daily-workflows.cjs`: stateful synthetic Manager and Cleaner
  scenarios, create/select refresh, sibling draft retention, failed read after
  confirmed write, detached-submit rejection, exact retry payload, canonical
  revisions, photo preservation, coordinate/quantity limits, queue progression,
  320px reflow and absence of Cleaner room/guest detail requests.
- Its 12 generated commands validate against the real FastAPI request models.
- The existing 24 browser suites remain in CI, including 18 WCAG-tagged axe
  scans. Automated accessibility results are bounded evidence, not certification.
- `tests/test_checkout.py` adds a real PostgreSQL projection/privacy regression.
  Local execution without a PostgreSQL DSN skips this test; the required CI
  PostgreSQL shards execute the full discovered suite without skips.
- JS syntax, token drift, design lint, strict premium audit and diff hygiene
  remain verification gates. Latest commit-specific CI evidence is recorded in
  Draft PR #1: https://github.com/jbchzorigt/PRsystem/pull/1.

The synthetic screenshot `artifacts/daily-cleaner-mobile.png` is retained as a
CI artifact. It contains test data, not a real hotel or guest.

## Human acceptance session — not yet performed

Use a development hotel and synthetic guests. A real representative of each role
should perform these tasks without coaching; record observations and pass/fail.

| Role | Task sequence | Observable acceptance criterion |
| --- | --- | --- |
| Reception | Register a walk-in, correct a validation error, open stay, allocate deposit, collect remaining cash, complete checkout | Can identify the next action and understands each amount; no duplicate stay, receipt or checkout |
| Manager | Create category, register room in it, edit a second draft while saving the first, update public description without a new image | New category is selectable, unrelated draft survives, photo remains, no revision number is requested |
| Cleaner | Find room by number/floor, claim work, start, attempt an excessive quantity, correct it and complete | Finds the physical room, understands the inline limit and next action, completed task disappears |
| Manager / Cleaner | Save successfully while the subsequent read fails, then restore connectivity and reload | Understands that the write was saved; uses read recovery without resubmitting the command |

Record participant role, device/browser, task outcome, confusion points and
required changes. No human acceptance results have been invented here. Live
provider readiness, production operations and production deployment are separate
milestones. This change remains a Draft PR for review.
