---
version: alpha
name: PRsystem staff operations
description: Mongolian hotel staff access and Reception operations.
colors:
  primary: "#215d73"
  primary-hover: "#164559"
  paper: "#f2f6f8"
  surface: "#ffffff"
  ink: "#172d38"
  muted: "#4e6470"
  line: "#b7c7cf"
  danger: "#a32638"
  focus: "#944908"
typography:
  body:
    fontFamily: '"Segoe UI", "Noto Sans", Arial, sans-serif'
    fontSize: "1rem"
    lineHeight: "1.6"
  display:
    fontFamily: '"Trebuchet MS", "Segoe UI", Arial, sans-serif'
rounded:
  DEFAULT: "0.5rem"
spacing:
  space: "1rem"
  measure: "34rem"
components:
  primary-button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
---

# PRsystem design system

## Overview

Product register for Mongolian hotel and restaurant staff using emailed access
links on their phone or desk computer. Business authority: docs/19 and docs/30–35.
The visual reference is a reception desk's labeled key sleeve: one narrow petrol
blue rail identifies the access form, with generous room for Cyrillic labels.
No dashboard statistics, photography, marketing claims or decorative animation.
Mongolian is the only current UI locale; no Japanese market assumption.

This file owns tokens (Model A). `scripts/export_ui_tokens.py` generates the
`:root` prefix of `src/prsystem/static/staff.css`; the rest of that shared sheet
consumes variables. No per-route theme. CI checks token drift.

## Colors

Light paper page, white form, dark ink for text, muted blue for supporting text.
Primary and primary-hover own actions. Danger always accompanies error text;
focus is a distinct three-pixel ring. The rail has no semantic meaning by itself.
No dark theme currently; forced colors retains native system controls.

## Typography

Display stack is restrained to brand and heading. Body stack supports Cyrillic,
including Ө and Ү, without network fonts. Text is never truncated. Body 16px,
line height 1.6; helper text 14px. Inputs inherit body metrics.

## Layout

One 34rem maximum-width form, natural document scrolling, 1rem base spacing.
At 600px the form margins and padding contract; all controls remain reachable
at 320px width and 200% zoom. No fixed viewport height. Helper, validation and
status regions reserve space. Scrollbar styling applies globally.

## Elevation & Depth

A border separates the white form from paper. No shadows or blur.

## Shapes

Half-rem control/form corners. A narrow full-height rail is the only signature.
Radio buttons retain native shape and keyboard behavior.

## Components

The four link routes share `staff.html`, `staff.js` and `staff.css`.
Form, field errors, password reveal, submit locking and status focus are shared.
Buttons have visible hover, active, focus and disabled states; submit geometry
stays constant while busy. No icons, dialogs, toasts, tables or date/select popup.
Native radio controls explicitly own account-type choice. The server decides
whether an account exists; this choice never changes authorization.

No motion beyond native interaction. Reduced-motion baseline is explicit.
Mongolian copy names actual actions. Failure guidance distinguishes invalid
links, wrong password, rate limits and uncertain network completion.

## Do's and Don'ts

- Keep existing-account passwords unchanged when accepting invitations.
- Keep password and link secrets out of URLs after parsing, storage and logging.
- Keep all four forms on the same validation and feedback implementation.
- Do not add a fake dashboard destination or automatic sign-in.


## Reception console extension

Reception is a working console at `/reception`: four principal destinations
for check-in, rooms, payments and Restaurant; shift, Manager and Cleaner tools
are role-specific. This extends the existing product register. The petrol rail,
colors, typography and focus treatment remain canonical. The console occupies
72rem; forms retain a readable 38rem measure. Sparse operational rows allow
room/state comparison and wrap on phones. No decorative statistics are added.
Native select/date controls deliberately retain platform-owned popup behavior.
The app-owned discard dialog uses the native modal primitive. Table regions
scroll horizontally; the document remains the sole vertical page scroller.
UX-CONTRACT.md records command, permission, privacy and failure behavior.

## Booking console extension

Customer search, account entry and Platform finance retain the petrol rail and
shared Reception form owners. Uploaded hotel/category photography supplies the
catalog's visual information; image regions reserve a 16:9 footprint and wrap on
phones. No stock imagery, fabricated ratings or decorative financial totals.
Profile and settlement commands retain natural document scrolling. No durable
color, type or spacing token changed. The behavior variants are in UX-CONTRACT.md.

## Warehouse extension

The Manager's warehouse destination uses the existing operational rows to compare
product, warehouse quantity, selling price and average cost. Receipt history uses
the shared horizontally scrollable table; forms keep natural document height.
The existing petrol rail, typography, spacing and tokens remain unchanged.

Template authoring uses the same operational rows, bounded lists and shared
forms. Exact version numbers and the named Default state identify the current
choice; a compact product/quantity table is the review surface before Publish.
No new palette, typography, overlay or local form owner is introduced.

Room configuration requests appear beside the existing room facts. Current mode,
exact target version and pending state have separate text labels. The existing
shared table and form display the target items and reason, with the assignment
warning before confirmation. This extension adds no new visual tokens.
