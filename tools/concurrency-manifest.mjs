// The concurrency manifest — Phase 22 (build-plan §Phase 22, docs/architecture/11 §2).
//
// One entry per money- or lifecycle-changing command, keyed by the operation
// name it claims its idempotency key under. `raced: true` names the GATE-CONC
// suites that drive the command's service method from concurrent actors and
// prove the aggregate outcome; `raced: false` records, with a reason, that the
// command's only concurrency concern is the duplicate submit, which the kernel
// suite proves generically for every command that goes through `claim()`.
//
// `tools/concurrency-coverage.mjs` holds this file to the source and the suites
// in both directions; `packages/testing/src/concurrency-coverage.test.ts` runs
// it under GATE-UNIT. A new command without an entry here is a build failure.
export const CONCURRENCY_MANIFEST = [
  {
    operation: 'billing.case_claim',
    method: 'claimCase',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'billing.case_resolve',
    method: 'resolve',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'billing.correction_decide',
    method: 'decide',
    raced: true,
    suites: ['apps/api/src/modules/billing/billing.concurrency.test.ts'],
  },
  {
    operation: 'billing.correction_request',
    method: 'request',
    raced: true,
    suites: ['apps/api/src/modules/billing/billing.concurrency.test.ts'],
  },
  {
    operation: 'billing.deposit_allocate',
    method: 'allocate',
    raced: true,
    suites: ['apps/api/src/modules/billing/billing.concurrency.test.ts'],
  },
  {
    operation: 'billing.deposit_configure',
    method: 'configure',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'billing.deposit_receive',
    method: 'receive',
    raced: true,
    suites: ['apps/api/src/modules/billing/billing.concurrency.test.ts'],
  },
  {
    operation: 'billing.folio_payment',
    method: 'pay',
    raced: true,
    suites: ['apps/api/src/modules/billing/billing.concurrency.test.ts'],
  },
  {
    operation: 'billing.folio_settle',
    method: 'settle',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'billing.post_charges',
    method: 'postCharges',
    raced: true,
    suites: ['apps/api/src/modules/billing/billing.concurrency.test.ts'],
  },
  {
    operation: 'billing.refund_decide',
    method: 'decide',
    raced: true,
    suites: ['apps/api/src/modules/billing/billing.concurrency.test.ts'],
  },
  {
    operation: 'billing.refund_execute',
    method: 'execute',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'billing.refund_late_check',
    method: 'checkForLateSuccess',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'billing.refund_release',
    method: 'release',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'billing.refund_request',
    method: 'request',
    raced: true,
    suites: ['apps/api/src/modules/billing/billing.concurrency.test.ts'],
  },
  {
    operation: 'booking.cancel_hotel',
    method: 'cancelByHotel',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'booking.hold',
    method: 'hold',
    raced: true,
    suites: ['apps/api/src/modules/booking/booking.concurrency.test.ts'],
  },
  {
    operation: 'booking.no_show',
    method: 'confirmNoShow',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'catalog.configure_stay',
    method: 'configureStay',
    raced: true,
    suites: ['apps/api/src/modules/catalog/catalog.concurrency.test.ts'],
  },
  {
    operation: 'catalog.create_category',
    method: 'createCategory',
    raced: true,
    suites: ['apps/api/src/modules/catalog/catalog.concurrency.test.ts'],
  },
  {
    operation: 'catalog.create_minibar_entity',
    method: 'createMinibarEntity',
    raced: true,
    suites: ['apps/api/src/modules/catalog/catalog.concurrency.test.ts'],
  },
  {
    operation: 'catalog.create_room',
    method: 'createRoom',
    raced: true,
    suites: ['apps/api/src/modules/catalog/catalog.concurrency.test.ts'],
  },
  {
    operation: 'catalog.finalize_retirement',
    method: 'finalizeRetirement',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'catalog.hard_delete',
    method: 'hardDelete',
    raced: true,
    suites: ['apps/api/src/modules/catalog/catalog.concurrency.test.ts'],
  },
  {
    operation: 'catalog.request_deactivation',
    method: 'requestDeactivation',
    raced: true,
    suites: ['apps/api/src/modules/catalog/catalog.concurrency.test.ts'],
  },
  {
    operation: 'catalog.update_category',
    method: 'updateCategory',
    raced: true,
    suites: ['apps/api/src/modules/catalog/catalog.concurrency.test.ts'],
  },
  {
    operation: 'catalog.update_room',
    method: 'updateRoom',
    raced: true,
    suites: ['apps/api/src/modules/catalog/catalog.concurrency.test.ts'],
  },
  {
    operation: 'finance.cash_correction',
    method: 'correct',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'finance.cash_request',
    method: 'create',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'finance.cash_request_decide',
    method: 'decide',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'finance.cash_top_up',
    method: 'topUp',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'finance.expense_decide',
    method: 'decide',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'finance.expense_pay',
    method: 'pay',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'finance.expense_submit',
    method: 'submit',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'finance.location_create',
    method: 'createLocation',
    raced: true,
    suites: ['apps/api/src/modules/finance/finance.concurrency.test.ts'],
  },
  {
    operation: 'finance.location_update',
    method: 'updateLocation',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'finance.transfer_cancel',
    method: 'cancelTransfer',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'finance.transfer_confirm',
    method: 'confirmTransfer',
    raced: true,
    suites: ['apps/api/src/modules/finance/finance.concurrency.test.ts'],
  },
  {
    operation: 'finance.transfer_initiate',
    method: 'initiateTransfer',
    raced: true,
    suites: ['apps/api/src/modules/finance/finance.concurrency.test.ts'],
  },
  {
    operation: 'iam.invitation.accept',
    method: 'acceptInvitation',
    raced: true,
    suites: ['apps/api/src/modules/iam/iam.concurrency.test.ts'],
  },
  {
    operation: 'iam.invitation.create',
    method: 'createInvitation',
    raced: true,
    suites: ['apps/api/src/modules/iam/iam.concurrency.test.ts'],
  },
  {
    operation: 'iam.invitation.resend',
    method: 'resendInvitation',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'iam.invitation.revoke',
    method: 'revokeInvitation',
    raced: true,
    suites: ['apps/api/src/modules/iam/iam.concurrency.test.ts'],
  },
  {
    operation: 'iam.membership.state',
    method: 'applyMembershipState',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'iam.reset.initiate',
    method: 'initiatePasswordReset',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'minibar.archive',
    method: 'archive',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'minibar.cancel_change',
    method: 'cancelChange',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'minibar.claim_task',
    method: 'claimTask',
    raced: true,
    suites: ['apps/api/src/modules/minibar/minibar.concurrency.test.ts'],
  },
  {
    operation: 'minibar.complete_task',
    method: 'completeTask',
    raced: true,
    suites: ['apps/api/src/modules/minibar/minibar.concurrency.test.ts'],
  },
  {
    operation: 'minibar.create_draft',
    method: 'createDraft',
    raced: true,
    suites: ['apps/api/src/modules/minibar/minibar.concurrency.test.ts'],
  },
  {
    operation: 'minibar.create_override',
    method: 'createOverride',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'minibar.create_product',
    method: 'createProduct',
    raced: true,
    suites: ['apps/api/src/modules/minibar/minibar.concurrency.test.ts'],
  },
  {
    operation: 'minibar.delete_draft',
    method: 'deleteDraft',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'minibar.publish',
    method: 'publish',
    raced: true,
    suites: ['apps/api/src/modules/minibar/minibar.concurrency.test.ts'],
  },
  {
    operation: 'minibar.receive_stock',
    method: 'receiveStock',
    raced: true,
    suites: ['apps/api/src/modules/minibar/minibar.concurrency.test.ts'],
  },
  {
    operation: 'minibar.record_correction',
    method: 'recordCorrection',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'minibar.replace_draft_items',
    method: 'replaceDraftItems',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'minibar.request_change',
    method: 'requestChange',
    raced: true,
    suites: ['apps/api/src/modules/minibar/minibar.concurrency.test.ts'],
  },
  {
    operation: 'minibar.request_rollback',
    method: 'requestRollback',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'minibar.resolve_change',
    method: 'resolveChange',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'minibar.rollout_cancel_remaining',
    method: 'cancelRemaining',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'minibar.rollout_confirm',
    method: 'confirm',
    raced: true,
    suites: ['apps/api/src/modules/minibar/minibar.concurrency.test.ts'],
  },
  {
    operation: 'minibar.set_default',
    method: 'setDefault',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'minibar.update_product',
    method: 'updateProduct',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'operation.access.create',
    method: 'createAccount',
    raced: true,
    suites: ['apps/api/src/modules/operation/operation.concurrency.test.ts'],
  },
  {
    operation: 'operation.access.permission',
    method: 'setPermission',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'operation.access.state',
    method: 'setAccountState',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'operation.contact.exception',
    method: 'approveException',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'operation.contact.open',
    method: 'open',
    raced: true,
    suites: ['apps/api/src/modules/operation/operation.concurrency.test.ts'],
  },
  {
    operation: 'operation.contact.verify',
    method: 'verify',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'operation.recovery.decide',
    method: 'decide',
    raced: true,
    suites: ['apps/api/src/modules/operation/operation.concurrency.test.ts'],
  },
  {
    operation: 'operation.recovery.escalate',
    method: 'escalate',
    raced: true,
    suites: ['apps/api/src/modules/operation/operation.concurrency.test.ts'],
  },
  {
    operation: 'operation.reset.initiate',
    method: 'initialisePasswordReset',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'operation.sms.confirm',
    method: 'confirm',
    raced: true,
    suites: ['apps/api/src/modules/operation/operation.concurrency.test.ts'],
  },
  {
    operation: 'police.account_provision',
    method: 'provision',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'police.case_move',
    method: 'move',
    raced: true,
    suites: ['apps/api/src/modules/police/police.concurrency.test.ts'],
  },
  {
    operation: 'police.case_open',
    method: 'open',
    raced: true,
    suites: ['apps/api/src/modules/police/police.concurrency.test.ts'],
  },
  {
    operation: 'police.false_match',
    method: 'requestFalseMatch',
    raced: true,
    suites: ['apps/api/src/modules/police/police.concurrency.test.ts'],
  },
  {
    operation: 'police.false_match_decide',
    method: 'decideFalseMatch',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'police.found_confirm',
    method: 'confirmFound',
    raced: true,
    suites: ['apps/api/src/modules/police/police.concurrency.test.ts'],
  },
  {
    operation: 'police.found_correction',
    method: 'requestFoundCorrection',
    raced: true,
    suites: ['apps/api/src/modules/police/police.concurrency.test.ts'],
  },
  {
    operation: 'police.found_correction_decide',
    method: 'decideFoundCorrection',
    raced: true,
    suites: ['apps/api/src/modules/police/police.concurrency.test.ts'],
  },
  {
    operation: 'police.identity_decide',
    method: 'decideIdentity',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'police.match_acknowledge',
    method: 'acknowledge',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'police.wanted_export',
    method: 'run',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'police.wanted_register',
    method: 'register',
    raced: true,
    suites: ['apps/api/src/modules/police/police.concurrency.test.ts'],
  },
  {
    operation: 'reporting.category_state',
    method: 'setState',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'reporting.expense_category',
    method: 'create',
    raced: true,
    suites: ['apps/api/src/modules/reporting/reporting.concurrency.test.ts'],
  },
  {
    operation: 'reporting.export_request',
    method: 'request',
    raced: true,
    suites: ['apps/api/src/modules/reporting/reporting.concurrency.test.ts'],
  },
  {
    operation: 'reporting.hold_release',
    method: 'releaseHold',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'reporting.legal_hold',
    method: 'placeHold',
    raced: true,
    suites: ['apps/api/src/modules/reporting/reporting.concurrency.test.ts'],
  },
  {
    operation: 'restaurant.accept',
    method: 'accept',
    raced: true,
    suites: ['apps/api/src/modules/restaurant/restaurant.concurrency.test.ts'],
  },
  {
    operation: 'restaurant.cancel',
    method: 'cancelByRestaurant',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.contact_phone',
    method: 'setContactPhone',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.fulfil',
    method: 'advance',
    raced: true,
    suites: ['apps/api/src/modules/restaurant/restaurant.concurrency.test.ts'],
  },
  {
    operation: 'restaurant.guest_code',
    method: 'issueGuestCode',
    raced: true,
    suites: ['apps/api/src/modules/restaurant/restaurant.concurrency.test.ts'],
  },
  {
    operation: 'restaurant.guest_request',
    method: 'requestRefundAsGuest',
    raced: true,
    suites: ['apps/api/src/modules/restaurant/restaurant.concurrency.test.ts'],
  },
  {
    operation: 'restaurant.guest_revoke',
    method: 'revoke',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.handoff',
    method: 'recordHandoff',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.item_availability',
    method: 'setItemAvailability',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.link_state',
    method: 'setLinkState',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.menu_category',
    method: 'addCategory',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.menu_item',
    method: 'addItem',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.order',
    method: 'placeOrder',
    raced: true,
    suites: ['apps/api/src/modules/restaurant/restaurant.concurrency.test.ts'],
  },
  {
    operation: 'restaurant.reception_request',
    method: 'requestRefundAsReception',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.refund',
    method: 'start',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.register',
    method: 'register',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.request_decision',
    method: 'decideRequest',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.room_qr',
    method: 'issueRoomToken',
    raced: true,
    suites: ['apps/api/src/modules/restaurant/restaurant.concurrency.test.ts'],
  },
  {
    operation: 'restaurant.schedule',
    method: 'setSchedule',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'restaurant.schedule_override',
    method: 'addScheduleOverride',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'review.delete',
    method: 'softDelete',
    raced: true,
    suites: ['apps/api/src/modules/review/review.concurrency.test.ts'],
  },
  {
    operation: 'review.edit',
    method: 'edit',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'review.moderation_hide',
    method: 'hide',
    raced: true,
    suites: ['apps/api/src/modules/review/review.concurrency.test.ts'],
  },
  {
    operation: 'review.moderation_restore',
    method: 'restore',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'review.reply',
    method: 'reply',
    raced: true,
    suites: ['apps/api/src/modules/review/review.concurrency.test.ts'],
  },
  {
    operation: 'review.reply_edit',
    method: 'editReply',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'review.reply_state',
    method: 'setReplyState',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'review.report',
    method: 'report',
    raced: true,
    suites: ['apps/api/src/modules/review/review.concurrency.test.ts'],
  },
  {
    operation: 'review.report_resolve',
    method: 'resolveReport',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'review.write',
    method: 'write',
    raced: true,
    suites: ['apps/api/src/modules/review/review.concurrency.test.ts'],
  },
  {
    operation: 'stay.check_in',
    method: 'checkIn',
    raced: true,
    suites: [
      'apps/api/src/modules/stay/stay.concurrency.test.ts',
      'apps/api/src/modules/stay/checkout.concurrency.test.ts',
    ],
  },
  {
    operation: 'stay.checkout_cancel',
    method: 'cancel',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.checkout_record',
    method: 'recordActualCheckout',
    raced: true,
    suites: [
      'apps/api/src/modules/stay/stay.concurrency.test.ts',
      'apps/api/src/modules/stay/checkout.concurrency.test.ts',
    ],
  },
  {
    operation: 'stay.checkout_start',
    method: 'start',
    raced: true,
    suites: ['apps/api/src/modules/stay/checkout.concurrency.test.ts'],
  },
  {
    operation: 'stay.cleaning_set',
    method: 'setState',
    raced: true,
    suites: ['apps/api/src/modules/stay/stay.concurrency.test.ts'],
  },
  {
    operation: 'stay.cleaning_task_claim',
    method: 'claimTask',
    raced: true,
    suites: [
      'apps/api/src/modules/stay/stay.concurrency.test.ts',
      'apps/api/src/modules/stay/checkout.concurrency.test.ts',
    ],
  },
  {
    operation: 'stay.cleaning_task_complete',
    method: 'complete',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.correction_submit',
    method: 'submit',
    raced: true,
    suites: ['apps/api/src/modules/stay/checkout.concurrency.test.ts'],
  },
  {
    operation: 'stay.dispute_flag',
    method: 'flag',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.dispute_resolve',
    method: 'resolve',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.payment_lock',
    method: 'lockForPayment',
    raced: true,
    suites: ['apps/api/src/modules/stay/checkout.concurrency.test.ts'],
  },
  {
    operation: 'stay.payment_reconcile',
    method: 'reconcile',
    raced: true,
    suites: ['apps/api/src/modules/stay/checkout.concurrency.test.ts'],
  },
  {
    operation: 'stay.refill_claim',
    method: 'claimTask',
    raced: true,
    suites: [
      'apps/api/src/modules/stay/stay.concurrency.test.ts',
      'apps/api/src/modules/stay/checkout.concurrency.test.ts',
    ],
  },
  {
    operation: 'stay.refill_complete',
    method: 'complete',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.refill_request',
    method: 'request',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.report_adjust',
    method: 'adjust',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.report_claim',
    method: 'claimInspection',
    raced: true,
    suites: ['apps/api/src/modules/stay/checkout.concurrency.test.ts'],
  },
  {
    operation: 'stay.report_return',
    method: 'returnToCleaner',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.shift_accept',
    method: 'acceptCash',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.shift_close',
    method: 'close',
    raced: true,
    suites: [
      'apps/api/src/modules/stay/stay.concurrency.test.ts',
      'apps/api/src/modules/stay/checkout.concurrency.test.ts',
    ],
  },
  {
    operation: 'stay.shift_count',
    method: 'startClose',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.shift_handover',
    method: 'handOver',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.shift_open',
    method: 'open',
    raced: true,
    suites: [
      'apps/api/src/modules/stay/stay.concurrency.test.ts',
      'apps/api/src/modules/stay/checkout.concurrency.test.ts',
    ],
  },
  {
    operation: 'stay.shift_recount',
    method: 'requestRecount',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.shift_review',
    method: 'applyReview',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
  {
    operation: 'stay.shift_self_close',
    method: 'selfClose',
    raced: false,
    reason:
      'duplicate-submit only: the kernel idempotency proof; no aggregate race beyond the claim',
  },
];
