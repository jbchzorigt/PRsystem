# Staff link forms

Visual authority: [DESIGN.md](DESIGN.md). Business policy remains in docs/19,
docs/30, docs/32, docs/34 and docs/35; this file records UI consequences only.

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Form | static/staff.html + staff.js | docs/32, docs/35, API LinkPassword | hotel invite, restaurant invite, reset, Primary Admin activation | tests/browser/staff.cjs |
| Scrollbar | static/staff.css | DESIGN.md | global, forced colors | tests/browser/staff.cjs |
| Feedback | staff.js say | API error codes | inline status/error | tests/browser/staff.cjs |
| Select/Listbox | reception.js select | API enum fields | native platform popup | tests/browser/reception.cjs |
| Date | reception.js field | docs/05, hotel +08:00 | native date and datetime-local | tests/browser/reception.cjs |
| Dialog | reception.js guard + reception.html discard | dirty form state | native modal, safe initial focus | tests/browser/reception.cjs |
| CRUD | reception.js form + command | docs/18,20,24,26 and strict API models | pessimistic source commands | tests/browser/reception.cjs |
| Table Selection | reception.js multiSelection | docs/26 §§36–38, docs/54 | initial 2–100 rooms, linked retry 1–100 rooms | tests/browser/minibar-batches.cjs |


All pages are public link entry points. The server validates purpose, one-use
state, expiry, membership revision, scope and current permissions. There is no
client-side authorization. POST requests go only to the matching same-origin
endpoint. CSP denies frames, third parties, inline scripts and arbitrary forms.

Fragment token is parsed into memory and removed from browser history. Never
put secrets in a query, analytics, storage, logs or redirect. Pagehide clears
memory and password. On BFCache restoration the user must reopen the email.
Existing invitation recipients use their current password; new recipients
choose a 12–128-character password. Reset always sets a new password. Paste and
password managers remain enabled. No additional account-existence endpoint.

Validation is inline, localized, associated with the password field and focuses
the first invalid field. Busy submits cannot duplicate requests. Timeout has
uncertain-completion guidance, clears password, and offers an explicit retry by
submitting again. No automatic mutation retry. Success clears the token and
password, hides the form, focuses the status and tells the user to sign in to
their work system; no nonexistent destination is linked. Reset 204 is success.

Native radio selection is intentionally platform-owned. No select/date/table,
dialog, delete action or local draft storage. Locale mn, light theme only,
keyboard and narrow-screen reflow required. Project browser tests exercise the
shared form state matrix; PostgreSQL tests independently verify real endpoints.

## Reception console business variant

`/reception` uses `reception.js` Form, Feedback, CRUD and navigation owners for
operational commands; the token-only staff forms above remain the LinkPassword
variant. Shared visual tokens and global scrollbar belong to `staff.css`.
`reception.css` only owns console geometry. API models own command semantics.
Source policies: docs/02,03,05,18,20,21,24,26,38–42.

| Capability | Canonical owner | Contract |
| --- | --- | --- |
| Form | reception.js `form` | novalidate, inline errors, first-error focus, stable key per unchanged retry, pending lock, password masking |
| Select/Listbox | reception.js `select` | native select; platform popup geometry and locale accepted |
| Date | reception.js `field` | native date/datetime-local; platform popup accepted, typed input available; business instants explicitly Asia/Ulaanbaatar +08:00 |
| Dialog | reception.html `discard` + reception.js `guard` | native modal dialog, inert background, Escape, safe initial focus, return to trigger |
| CRUD | reception.js command/forms | pessimistic server confirmation, CAS, errors retain input; no optimistic financial success |
| Feedback | reception.js say/form status | persistent localized recovery, no raw server errors or secrets in global feedback |
| Navigation | reception.js navigate | four Reception destinations, role-specific tools, guarded dirty forms |
| Table | reception.js table | caption, headers, keyboard scroll region; natural document scroll |

Route document title policy: localized destination followed by `— PRsystem`.
Route error / 403 page behavior: preserve navigation, explain denial inline;
401 clears identity/context and returns to login. No automatic retries.
List state and sensitive form values stay only in memory: reception filters,
room/stay identifiers and guest names are not written to URL or storage. The
URL fragment contains only the non-sensitive destination. Lists use actual
bounded keyset pages; no fabricated page totals. Body owns vertical scrolling;
tables own horizontal overflow, forms retain natural height at 320 px.
Soft-delete vs hard-delete policy: room/category lifecycle is reversible
inactivation with explicit reason and server dependency gates, never physical
removal of historical records. Financial correction creates immutable reversal.
Confirmation is the named command form, including reason/count/destination as
applicable. Navigation cannot discard a dirty form without the modal decision.
No secret or guest draft persists. Pagehide clears credentials and rendered
private context. Browser-close warning is scoped to dirty forms.

## Booking business variants

`/booking` and `/platform/booking` reuse the Reception shell, `form`, `api`,
`guard`, `field`, `select`, feedback, formatters and global tokens. They are
product flows with the same native picker policy, dirty-form confirmation and
pessimistic command behavior. The independent booker and Platform bearer realms
are held only in memory. Booking capabilities are passed explicitly to their
scoped endpoint; they never replace the account token or enter a URL/storage.
Page exit clears private content and in-flight results cannot repopulate it.

Public search uses explicit submit (no live keystroke queries) and bounded
Load more. Dates, query and optional one-shot GPS coordinates remain in memory;
exact location is neither URL state nor a persistent profile. A search review
shows server quote and cancellation terms before creating a pending hold.
Payment and refund statuses are independent of the terminal booking outcome.
No client action asserts bank payment success. Mock invoices need the existing
local operator provider controls.

Reception online commands share `checkin` identity capture with the existing
walk-in form. The physical room is selected only at arrival. Manager profile,
category publication and rank edits use explicit server revisions. Platform
finance requires current explicit permission and fresh MFA at the API boundary;
unknown bank results offer reconciliation, never a new payment attempt.
Sources: docs/09,11,45–47. Browser coverage: tests/browser/booking.cjs.

## Warehouse receipt variant

`/reception#inventory` reuses `form`, `api`, `guard`, `record`, `table`, `navigate`,
native `select`, feedback and currency/time formatters. Source: docs/22 §§3–5,
10–11 and docs/48. Only entitled Managers see this destination; APIs independently
authorize every list, ledger, create and retry. Opening quantity means warehouse
stock. Product state is selected at creation; lifecycle changes are a later flow.

Successful create/receipt returns to the warehouse list with an accessible status.
Uncertain failures keep the form and unchanged retry key. A stale stock revision
requires an explicit refresh and review; it never silently adopts a new revision.
Lists and ledger pages use bounded keyset navigation, kept in memory. A detached
ledger request cannot overwrite a replacement form or another history page.
Exact cost numerator/denominator is authoritative; fractional averages displayed
with the existing number formatter are explicitly marked approximate. No browser
cost calculation is submitted. Ledger actor labels and product metadata are
recorded snapshots. Browser coverage: tests/browser/minibar.cjs.

## Minibar template authoring

Business authority: docs/26 §§24–29. Manager at 25,000/30,000₮ and Manager Plus
at 30,000₮ use the existing `form`, `api`, `guard`, `table`, `select`, feedback
and navigation owners in reception.js. The server reauthorizes every command.
Template and version lists use bounded keyset pages; selection and cursors stay
in memory under the Reception privacy contract. Product selection is a bounded
50-item native select page with explicit next/first controls. A version has at
most 100 items. Published product/quantity rows are read-only; changes begin by
cloning into a new server draft. Exact target quantities are not stock counts.
Publish uses a named confirmation form and a required review checkbox next to
the actual item table. Default selection names its new-configuration effect.
Create returns to the list; draft creation/clone opens the new draft; edit,
publish and default refresh the same exact version and announce server success.
Conflict preserves input and requires explicit reload/discard. Detail/picker
loads ignore stale responses; failed picker loads have an explicit retry.
Verification: tests/browser/minibar-templates.cjs and test_minibar_templates.py.

## Pending room minibar configuration

Docs/26 §§14–22 own the request/blocker boundary. An exact Published version
opens a bounded 100-room native chooser, reason and explicit new-assignment
warning. No live stock count or price is inferred from target quantities.
Requests leave current mode and active stay intact. Room cards name the pending
blocker and suppress new check-in; walk-in and assignment pickers exclude it.
Manager can request/cancel, Reception reads current/pending and bounded history.
OFF and cancel forms use the same owners and server revisions as ON requests.
Successful writes refresh rooms and announce the result. Lost responses preserve
the idempotency key; stale revisions retain input until explicit reload. Local
panels discard detached/stale responses and provide named load retries.
Request creation, pre-movement cancellation and read are the implemented surface;
physical reconciliation/apply has no UI command yet. A pending request is not a
claim that the room is configured or that stock moved. Source request state is
recorded at creation, not inferred from planned checkout time.
Verification: test_minibar_configuration.py and the extended
 tests/browser/minibar-templates.cjs (request, retry, blocker, read/cancel,
OFF, Reception read-only, keyboard and mobile checks).

## Canonical reconciliation

The migration-046 follow-up adds Manager prepare/plan and Cleaner assigned counts
and full-plan apply. Shared forms retain actual inputs and idempotency keys across
unknown outcomes. Explicit count fields have no assumed default. Whole physical
transfer confirmation is required; shortage/variance has no override button.
Apply completes stock configuration only; cleanliness remains separate. Queue and
plan failures support retry and ignore detached responses. See docs/51 and
tests/browser/minibar-reconciliation.cjs.

## Exact minibar version archive

Version detail reuses shared forms, tables and status owners. Explicit preview
loads grouped blocker counts, with retry and detached-response protection. Default
and live references prevent the archive form. Reason and consequence acknowledgement
are required; conflict retains input until explicit refresh/discard, unknown outcomes
retain the command key. Success refreshes the same exact version and announces
archive. Archived state has history/clone, with no Default/Publish/room-target action.
Verification: test_minibar_archive.py and tests/browser/minibar-archive.cjs.

## Explicit room minibar rollout

Published version detail owns the distinct same-template rollout entry. A bounded
room page leads to an explicit read-only eligibility preview. Same-version and
other ineligible outcomes show a reason and disabled confirmation. Ready versus
scheduled text explains task timing; confirmation states the immediate room
blocker and requires reason plus acknowledgement. Current room version changes
only after physical reconciliation. Shared form/navigation owners retain inputs
and the request key after an unknown outcome; CAS reload requires fresh preview.
Automatic unassigned tasks require current Manager assignment before Cleaner work.
Verification: test_minibar_rollout.py and tests/browser/minibar-rollout.cjs.

## Multi-room rollout selection and progress

| Capability | Canonical owner | Contract | Verification |
| --- | --- | --- | --- |
| Table Selection | reception.js `multiSelection` | Native labeled checkboxes, keyboard Space, current-page select, clear/remove, live count; 100-room cap; selection retained across bounded pages in memory | tests/browser/minibar-batches.cjs |

Batch preview and commands reuse `api`, `form`, `guard`, `table`, feedback and
navigation. Initial selection is 2–100 rooms; the named retry variant allows
1–100 failed/cancelled rooms from the same historical batch. Selection alone
has no server side effect. Preview shows every selected room and uses server
revisions when confirming. An unknown result retains the same key; successful
confirmation reloads authoritative progress, including on idempotent replay.
Cancellation requires a reviewed progress revision, reason and acknowledgement;
a conflict retains inputs until explicit refresh/discard. Applied rooms remain
visible but are excluded from cancel/retry. Retry creates linked history.
Published and archived versions expose bounded batch history. Lists, selection,
IDs and reasons never enter URLs or storage. Async responses cannot repopulate
detached panels. Natural document scrolling and shared native focus styles apply.

## Canonical guest minibar inspection

`reception.js` owners: `minibarPriceBook` renders the locked version, server
recording time, opening quantities and selling prices using `table`;
`guestMinibarTasks` provides bounded available/assigned work and explicit
claim/count submission using `form`, `api` and `guard`. Reception reads the
same price book in the existing stay panel and returns reports with a reason.
Cleaner counts every product with initially empty inputs; no-consumption
acknowledgement is explicit. Clients send no price, balance or success proof.
Unknown results retain entered counts and the same idempotency key. Success
reloads the authoritative queue. Refresh asks before discarding dirty counts.
Load failures expose retry, obsolete loads cannot revive detached panels, and
blocked assignments show text without an executable form. Pagination and empty
states use the existing controls. All state remains in memory. Verification:
`tests/browser/minibar-guest.cjs`, `test_minibar_guest.py`, desktop and 320px.

## Stay minibar refill

`reception.js stayRefills/refillTasks` reuse Form, CRUD, Feedback, Dialog and
pagination owners. Reception requests/cancels; Cleaner claims and confirms actual
quantity or an unavailable reason. Task screens omit selling prices. Physical
counts start blank, server failure retains input and an unchanged idempotency
key, successful writes reload the authoritative queue. Existing guest report
counts use server-provided opening + documented refill availability. Verification:
`tests/browser/minibar-refill.cjs` and real PostgreSQL `test_minibar_refill.py`.

Automatic next-stay preparation is a `reconciliationTasks` variant. An unassigned
`NEXT_STAY` task has a Cleaner self-claim form; assigned count and physical apply
reuse the same controls as configuration reconciliation. The screen explicitly
separates minibar preparation from ordinary cleaning. Evidence:
`tests/browser/minibar-next-stay.cjs` and `test_minibar_next_stay.py`.

Manager exception reports reuse `openStay` with blank physical counts, mandatory
reason and explicit no-use acknowledgement. Only a current operational Manager
sees the exception form; server policy is authoritative. Successful writes reload
stay detail and identify the exception reason. Ordinary and exceptional reports
use the same price book. Evidence: `tests/browser/minibar-exception.cjs`.

## Product/template lifecycle

Business authority: docs/26 §§2–11 and docs/22. The shared `minibarLifecycle`
variant uses `form`, `field`, `table`, `guard`, `api` and `say` in reception.js.
Manager warehouse rows and template details open the same read-only blocker
preview. Confirm names the entity, action, effect and reason; an acknowledgement
is required before changing state. A retiring entity offers cancellation; an
inactive entity offers reactivation. Data is revalidated on the server.

Success refreshes the current owning list/detail. Loading/error/retry remains
within the panel; navigation invalidates stale responses. Unknown completion
retains the same command key; stale revision requires refresh and preserves the
shared dirty-form warning. Stock history stays accessible in inactive states.
An eligible never-used record exposes a separate permanent-delete confirmation
with reason and acknowledgement. Deletion returns to the first list page,
clearing the deleted detail selection. Used records never expose this action. Evidence: tests/browser/minibar-lifecycle.cjs.

## Manager stock adjustment variant

Warehouse product rows open a bounded 100-room native location selector with
explicit first/next controls; warehouse remains selectable on every page.
Read-only preview precedes the quantity/reason/acknowledgement form. It names the
location, current physical quantity, valuation and effect on guest availability.
Successful movement returns to the owning warehouse list with shared feedback.
The immutable adjustment history has 50-item pages and a separate linked-reversal
confirmation using the original quantity/cost. Posted-report and changed-stay
locks are visible before confirmation. Only zero-stock COUNT_PLUS asks for cost.
Forms retain the shared CAS, uncertain-outcome, dirty-navigation, validation and
retry behavior. Loading and failure use the existing panel/status owners.
Cleaner count bounds use physical quantity; a separate column shows billable
availability. Generic additions never silently become a guest sale. Evidence:
`tests/browser/minibar-adjustments.cjs` and the existing guest/exception suites.

Atomic inventory correction reuses the Manager adjustment history, native kind
select, shared form validation/acknowledgement, unknown-outcome retry and owning
inventory refresh. It fixes product/location/stay to the selected history item.
The form explains that reversal and replacement commit together, with no guest
payment effect. Browser evidence: tests/browser/minibar-adjustments.cjs.
