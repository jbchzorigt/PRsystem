# Staff link forms

Visual authority: [DESIGN.md](DESIGN.md). Business policy remains in docs/19,
docs/30, docs/32, docs/34 and docs/35; this file records UI consequences only.

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Form | static/staff.html + staff.js | docs/32, docs/35, API LinkPassword | hotel invite, restaurant invite, reset | tests/browser/staff.cjs |
| Scrollbar | static/staff.css | DESIGN.md | global, forced colors | tests/browser/staff.cjs |
| Feedback | staff.js say | API error codes | inline status/error | tests/browser/staff.cjs |

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
