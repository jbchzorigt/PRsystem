# UI/UX completion before live providers

2026-09-15. User-authorized UI/UX implementation pass on the existing FastAPI
application. Live integrations and a Django migration are outside this change.

## Delivered

- Shared desktop hotel navigation and a compact, scrollable mobile menu.
- Consistent table surfaces, number alignment, overflow guidance and empty states.
- Operation filter layout and an expandable MFA renewal form.
- Check-in sections for identity, guardian, stay, deposit and arrival information.
- Named forms, purposeful keyboard focus, larger checkbox label targets,
  expandable textareas, numeric keyboards and actionable bound validation.
- IME-safe submission, unchanged submit-button size, locked in-flight values,
  unchanged retry keys, correct restoration of controls after errors.
- Per-form dirty tracking so saving/closing another form cannot erase the
  unsaved-work warning. Page read errors have an explicit reload action.
- Mongolian names for walk-in/check-in, subscription status and settlement
  calculation; login and restaurant route titles/current navigation corrected.

## Design reconciliation

| Maintained rule | Finding | Resolution |
| --- | --- | --- |
| Shared visual tokens and key-sleeve rail | Existing palette/type already consistent | Preserved generated tokens; extended geometry only |
| Guard unsaved work | One shared boolean could be cleared by another form's save | Shared connected-form dirty tracking; dedicated browser assertion |
| Stable pending actions | Inputs could change during a submitted request | Lock controls and preserve button geometry; restore prior disabled state |
| Clear navigation and table scrolling | Long top navigation and no explicit column overflow guidance | Desktop sidebar for hotel routes, narrow scroll menu, observed table cue |
| Localized destination and helpful validation | Login retained previous title; generic numeric error | Correct title, current destination, bounds and integer/decimal copy |
| Long, reachable forms | Check-in was an undifferentiated form | Semantic fieldsets, focus and textarea expansion |

## Verification

Local verification on the final application source:

- 24 browser suites passed (23 existing workflow suites plus the new UX suite).
- 18 WCAG-tagged axe scans reported zero automatic violations. Incomplete
  checks for clipped horizontal navigation, modal compositing and empty tables
  are retained in the JSON evidence for manual review; this is not certification.
- The configured unit command discovered 934 tests: 146 executed and passed,
  788 skipped because this local run has no test PostgreSQL database. The prior
  backend source has separately passed 934/934 in CI; that is not presented as
  a fresh local database result.
- Strict premium audit: zero findings. Design lint: zero errors and six existing
  orphan-token warnings. Generated tokens and JavaScript syntax checks passed.
- All 159 browser command payloads across 22 request artifacts passed the existing strict API-model validation.

Local browser: Chromium 143 from the npm-distributed test binary. CI independently
uses the repository-pinned Playwright Chromium. Evidence is uploaded with the
GitHub Actions browser job, including `ui-accessibility.json` and PNG screenshots.

 The existing workflow
suites use deterministic mocked API responses, with their emitted commands
validated separately against real backend request models. They are not live
provider or PostgreSQL acceptance tests.

The dedicated `tests/browser/ui-quality.cjs` checks WCAG-tagged axe results,
IME suppression, pending control locking and button geometry, form focus,
check-in fieldsets/errors, discard/Escape, explicit read recovery, numeric
bounds, query clearing, table keyboard scroll and multiple-form dirty state.
It exercises 1440px, 640px (a reflow proxy) and 320px viewports, reduced motion,
forced colors, and all entry realms. A 640px viewport is not a claim of testing
browser zoom at 200% or a physical mobile keyboard.

## Acceptance boundary

This closes the described UI engineering pass in the approved mock environment.
Real reception/manager/cleaner users have not yet performed usability acceptance.
Their task observations and any final owner-supplied branding refinements remain
human validation work. No live messages/payments, production deployment, merge,
or centralized cross-hotel guest tracking was performed.
