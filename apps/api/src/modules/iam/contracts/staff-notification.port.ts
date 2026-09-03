/**
 * Staff email delivery (CLAUDE.md §9, doc 19 §4 and §6, `INT-MAIL-01`).
 *
 * The canonical contract lives in `@prsystem/ports` — the same port carries the
 * Phase 05 eBarimt receipt — and is re-exported here under the names Phase 04's
 * accepted callers were written against.
 */
export {
  SimulatedStaffNotification,
  StaffNotificationUnavailableError,
  UnavailableStaffNotification,
  selectStaffNotification,
} from '@prsystem/ports';
export type {
  EBarimtReceiptMessage,
  OwnerChallengeMessage,
  PasswordResetMessage,
  StaffInvitationMessage,
  StaffNotification,
  StaffNotificationPort,
} from '@prsystem/ports';
