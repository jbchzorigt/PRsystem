import type { Cell } from './cells';
import {
  ALL_PACKAGES,
  PACKAGE_20,
  PACKAGE_25_30,
  PACKAGE_30,
  allow,
  deny,
  readOnly,
  requestOnly,
  requires,
} from './cells';
import type { HotelRole } from './roles';

/**
 * The canonical Hotel action matrix — doc 18 §3, §3.2 and §3.3, row for row.
 *
 * Every row carries its heading from the source document verbatim, so a
 * reviewer can put the two side by side. `matrix.test.ts` iterates every row ×
 * every column and asserts the exact cell, including every `Нэмэлт role` rule:
 * the column refuses the action and the named role grants it.
 *
 * Two rows of the document produce two entries here where the document states
 * two different powers in one cell — the `takeover_id` row separates claim/read
 * from Reception terminal execution, because the document says the executing
 * actor needs the Reception role in addition. Splitting is the only faithful
 * encoding: one permission cannot be both.
 */
export interface HotelAction {
  /** Stable machine id. Part of the API contract: added, never repurposed. */
  readonly id: string;
  /** The document and section this row comes from. */
  readonly source: string;
  /** The row heading, exactly as doc 18 states it. */
  readonly label: string;
  readonly cells: Readonly<Record<HotelRole, Cell>>;
}

const A = allow;
const D = deny();
const R = requires;
const RO = readOnly;
const REQ = requestOnly;
const ALL = ALL_PACKAGES;
const P20 = PACKAGE_20;
const P2530 = PACKAGE_25_30;
const P30 = PACKAGE_30;

function row(
  id: string,
  source: string,
  label: string,
  cells: {
    hotelAdmin: Cell;
    manager: Cell;
    managerPlus: Cell;
    reception: Cell;
    cleaner: Cell;
    restaurantManager: Cell;
  },
): HotelAction {
  return {
    id,
    source,
    label,
    cells: {
      HOTEL_ADMIN: cells.hotelAdmin,
      MANAGER: cells.manager,
      MANAGER_PLUS: cells.managerPlus,
      RECEPTION: cells.reception,
      CLEANER: cells.cleaner,
      RESTAURANT_MANAGER: cells.restaurantManager,
    },
  };
}

/** Every column refuses. Written once so a whole-row denial reads as one. */
function nobody(id: string, source: string, label: string, note: string): HotelAction {
  const cell = deny(note);
  return row(id, source, label, {
    hotelAdmin: cell,
    manager: cell,
    managerPlus: cell,
    reception: cell,
    cleaner: cell,
    restaurantManager: cell,
  });
}

const S3 = '18 §3';
const S32 = '18 §3.2';
const S33 = '18 §3.3';

export const HOTEL_ACTIONS: readonly HotelAction[] = [
  row('hotel.subscription.pay', S3, 'Subscription төлөх/сунгах', {
    hotelAdmin: A(),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.profile.manage', S3, 'Hotel owner/profile, хаяг, public listing', {
    hotelAdmin: A(),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.staff.invite_suspend', S3, 'Hotel staff урих/түдгэлзүүлэх', {
    hotelAdmin: A(),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.staff.role_manage', S3, 'Hotel role олгох/цуцлах', {
    hotelAdmin: A(),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'hotel.handoff.reception_cleaner_claim',
    S3,
    'Suspended Reception shift takeover / Cleaner task reassign',
    {
      hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
      manager: A(),
      managerPlus: A(P30),
      reception: D,
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row('hotel.handoff.restaurant_reassign', S3, 'Suspended Restaurant order/task reassign', {
    hotelAdmin: R('MANAGER_PLUS'),
    manager: D,
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.catalog.room_manage', S3, 'Өрөө, room category, үнэ удирдах', {
    hotelAdmin: R('MANAGER'),
    manager: A(),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'hotel.tariff.config_manage',
    S3,
    'Hourly/nightly hotel default, category override, walk-in room override тохируулах',
    {
      hotelAdmin: R('MANAGER'),
      manager: A(ALL),
      managerPlus: A(P30),
      reception: D,
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row('hotel.deposit.config_manage', S3, 'Hotel/category deposit дүн тохируулах', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(ALL),
    managerPlus: A(P30),
    reception: RO(),
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'hotel.deposit.preconfirm_correction',
    S3,
    'Confirmation-оос өмнөх Walk-in source/deposit exemption correction',
    {
      hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
      manager: A(ALL),
      managerPlus: A(P30),
      reception: D,
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row(
    'hotel.tariff.snapshot_view',
    S3,
    'Server-resolved stay tariff/source ба confirmed snapshot харах',
    {
      hotelAdmin: A(),
      manager: A(),
      managerPlus: A(P30),
      reception: RO(),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row('hotel.catalog.entity_lifecycle', S3, 'Room/category deactivation/reactivation', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.catalog.entity_hard_delete', S3, 'Never-used room/category hard-delete', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.product_manage', S3, 'Minibar product/category/худалдах үнэ', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.entity_lifecycle', S3, 'Product/template deactivation/reactivation', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.entity_hard_delete', S3, 'Never-used product/template hard-delete', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.template_draft', S3, 'Minibar template version Draft үүсгэх/засах', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.template_publish', S3, 'Minibar template version Publish/Set default', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.template_archive', S3, 'Minibar template version Archive', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'hotel.minibar.rollout_single',
    S3,
    'Eligible room-ийг exact Published version рүү Rollout хийх',
    {
      hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
      manager: A(P2530),
      managerPlus: A(P30),
      reception: D,
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row(
    'hotel.minibar.rollout_batch',
    S3,
    'Multi-room Rollout Preview/Confirm/Cancel remaining/Retry',
    {
      hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
      manager: A(P2530),
      managerPlus: A(P30),
      reception: D,
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row('hotel.minibar.rollout_batch_view', S3, 'Multi-room batch/child төлөв ба blocker харах', {
    hotelAdmin: A(P2530),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: RO(P2530),
    cleaner: A(P2530, { scope: 'own_child_task' }),
    restaurantManager: D,
  }),
  row('hotel.catalog.lifecycle_view', S3, 'Room/entity lifecycle state/blocker харах', {
    hotelAdmin: A(),
    manager: A(),
    managerPlus: A(P30),
    reception: RO(ALL, { scope: 'room_scope' }),
    // The Cleaner role exists only on 25,000/30,000₮ (doc 18 §4), so the
    // unannotated ✓ in that column is a 25/30 grant.
    cleaner: A(P2530, { scope: 'own_task' }),
    restaurantManager: D,
  }),
  row('hotel.minibar.locked_price_view', S3, 'Stay minibar locked price харах', {
    hotelAdmin: A(P2530),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: A(P2530),
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.cost_stock_manage', S3, 'Худалдан авалтын өртөг/opening stock/stock receipt', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.waste_adjustment', S3, 'Waste/stock adjustment', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'hotel.minibar.room_config_target',
    S3,
    'Initial room setup-ийн mode/template, эсвэл config request-ийн pending target сонгох',
    {
      hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
      manager: A(P2530),
      managerPlus: A(P30),
      reception: D,
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row(
    'hotel.minibar.config_change_manage',
    S3,
    'Room minibar config change үүсгэх/товлох/хөдөлгөөнгүй cancel',
    {
      hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
      manager: A(P2530),
      managerPlus: A(P30),
      reception: D,
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row('hotel.minibar.config_resolution', S3, 'Config shortage/variance/rollback шийдэх', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'hotel.minibar.config_reconciliation_execute',
    S3,
    'Assigned config reconciliation/rollback room ↔ warehouse transfer',
    {
      hotelAdmin: R('CLEANER'),
      manager: R('CLEANER'),
      managerPlus: R('CLEANER'),
      reception: D,
      cleaner: A(P2530, { scope: 'own_task' }),
      restaurantManager: D,
    },
  ),
  row(
    'hotel.minibar.config_view',
    S3,
    'Current/pending config-ийн exact template version ба check-in blocker харах',
    {
      hotelAdmin: A(P2530),
      manager: A(P2530),
      managerPlus: A(P30),
      reception: RO(P2530),
      cleaner: A(P2530, { scope: 'own_task' }),
      restaurantManager: D,
    },
  ),
  row('hotel.minibar.shortage_override', S3, '`Дутуу minibar-тайгаар нээх` override', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.refill_request', S3, 'Active-stay refill request үүсгэх/цуцлах', {
    hotelAdmin: R('RECEPTION', 'MANAGER'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: A(P2530),
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.refill_execute', S3, 'Active-stay refill task гүйцэтгэх/боломжгүй болгох', {
    hotelAdmin: R('CLEANER'),
    manager: R('CLEANER'),
    managerPlus: R('CLEANER'),
    reception: D,
    cleaner: A(P2530, { scope: 'own_task' }),
    restaurantManager: D,
  }),
  row('hotel.minibar.non_guest_stock_out', S3, 'Active-stay non-guest stock-out', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.restaurant.register', S3, 'Restaurant бүртгэх/идэвхжүүлэх', {
    hotelAdmin: R('MANAGER_PLUS'),
    manager: D,
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.restaurant.manager_invite', S3, 'Restaurant Manager account/invitation үүсгэх', {
    hotelAdmin: R('MANAGER_PLUS'),
    manager: D,
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('restaurant.menu_manage', S3, 'Restaurant menu, schedule, item availability', {
    hotelAdmin: D,
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: A(P30, { scope: 'own_restaurant' }),
  }),
  row('restaurant.order_process', S3, 'Restaurant order боловсруулах', {
    hotelAdmin: D,
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: A(P30, { scope: 'own_restaurant' }),
  }),
  row('hotel.stay.check_in', S3, 'Check-in', {
    hotelAdmin: R('RECEPTION'),
    manager: R('RECEPTION'),
    managerPlus: R('RECEPTION'),
    reception: A(),
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'hotel.stay.check_in_actual_time_select',
    S3,
    'Initial check-in confirmation-оос өмнө actual time сонгох',
    {
      hotelAdmin: R('RECEPTION'),
      manager: R('RECEPTION'),
      managerPlus: R('RECEPTION'),
      reception: A(ALL, { condition: 'stay_dec_009_bound_and_reason' }),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  nobody(
    'hotel.stay.actual_check_in_direct_edit',
    S3,
    'Activated stay-ийн `actual_check_in_at`-ийг direct edit/backdate хийх',
    'STAY-DEC-009: immutable after activation; no role holds this permission',
  ),
  row(
    'hotel.stay.actual_time_correction_submit',
    S3,
    'ACTIVE stay/checkout эхлээгүй үед actual-time correction request submit хийх',
    {
      hotelAdmin: R('RECEPTION'),
      manager: R('RECEPTION'),
      managerPlus: R('RECEPTION'),
      reception: A(ALL, { condition: 'stay_dec_009_bound_and_reason' }),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row(
    'hotel.stay.actual_time_correction_decide',
    S3,
    'Actual-time correction request approve/reject хийх',
    {
      hotelAdmin: R('MANAGER'),
      manager: A(ALL, { condition: 'self_approved_audited' }),
      managerPlus: R('MANAGER'),
      reception: R('MANAGER'),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  nobody(
    'hotel.stay.planned_checkout_direct_edit',
    S3,
    'Confirmed booking/ACTIVE stay-ийн `planned_checkout_at`-ийг direct edit/overwrite хийх',
    'STAY-DEC-011: no role holds this permission',
  ),
  nobody(
    'hotel.stay.planned_end_amendment',
    S3,
    'Planned/effective end amendment, extension, shortening, hourly ↔ nightly conversion хийх',
    'STAY-DEC-012: absent for the whole MVP; no action, button or API exists',
  ),
  row(
    'hotel.stay.checkout_record',
    S3,
    'Early/on-time/late actual checkout бүртгэх, room/minibar тооцоо',
    {
      hotelAdmin: R('RECEPTION'),
      manager: R('RECEPTION'),
      managerPlus: R('RECEPTION'),
      reception: A(),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row('hotel.deposit.collect_deduct_refund', S3, 'Барьцаа авах/суутгах/буцаах', {
    hotelAdmin: R('RECEPTION'),
    manager: R('RECEPTION'),
    managerPlus: R('RECEPTION'),
    reception: A(),
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'hotel.deposit.alternate_refund_request',
    S3,
    'Alternate-channel deposit refund / financial correction хүсэлт гаргах',
    {
      hotelAdmin: R('RECEPTION'),
      manager: R('RECEPTION'),
      managerPlus: R('RECEPTION'),
      reception: A(),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row(
    'hotel.deposit.alternate_refund_decide',
    S3,
    'Alternate-channel deposit refund / financial correction approve/reject',
    {
      hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
      manager: A(ALL),
      managerPlus: A(P30),
      reception: D,
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row(
    'hotel.deposit.refund_release',
    S3,
    'Failed/pending deposit refund cancel ба reservation release',
    {
      hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
      manager: A(ALL),
      managerPlus: A(P30),
      reception: REQ(),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row('hotel.shift.open_close_handover', S3, 'Reception shift нээх/хаах/хүлээлцэх', {
    hotelAdmin: R('RECEPTION'),
    manager: R('RECEPTION'),
    managerPlus: R('RECEPTION'),
    reception: A(),
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.shift.financial_review', S3, 'Ердийн shift-ийн санхүүгийн review/хаалт', {
    hotelAdmin: A(ALL, { condition: 'exception_review_only' }),
    manager: A(),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.shift.variance_self_close_review', S3, 'Зөрүүтэй self-close review', {
    hotelAdmin: A(ALL, { condition: 'self_reviewed_audited' }),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.housekeeping.task_claim', S3, 'Cleaner task авах', {
    hotelAdmin: D,
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: A(P2530),
    restaurantManager: D,
  }),
  row('hotel.housekeeping.cleaning_status_p20', S3, 'Cleaning status — 20,000₮', {
    hotelAdmin: R('MANAGER'),
    manager: A(P20),
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.housekeeping.cleaning_status_p2530', S3, 'Cleaning status — 25,000/30,000₮', {
    hotelAdmin: D,
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: A(P2530),
    restaurantManager: D,
  }),
  row('hotel.minibar.usage_report_create', S3, 'Minibar usage/refill report', {
    hotelAdmin: D,
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: A(P2530),
    restaurantManager: D,
  }),
  row('hotel.minibar.report_return_to_cleaner', S3, 'Minibar тайланг Cleaner-д залруулгад буцаах', {
    hotelAdmin: R('RECEPTION'),
    manager: R('RECEPTION'),
    managerPlus: R('RECEPTION'),
    reception: A(P2530),
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.exception_report_create', S3, 'Онцгой minibar тайлан үүсгэх', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.dispute_flag', S3, 'Minibar маргаантай мөр тэмдэглэх', {
    hotelAdmin: R('RECEPTION'),
    manager: R('RECEPTION'),
    managerPlus: R('RECEPTION'),
    reception: A(P2530),
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.minibar.dispute_resolve', S3, 'Төлбөрөөс өмнөх minibar маргаан шийдэх', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(P2530),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'hotel.minibar.post_payment_correction_approve',
    S3,
    'Төлбөрийн дараах minibar correction/refund',
    {
      hotelAdmin: A(P2530),
      manager: A(P2530),
      managerPlus: A(P30),
      reception: REQ(P2530),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row('hotel.registry.list_view', S3, 'Guest registry list/filter/pagination харах', {
    hotelAdmin: A(ALL),
    manager: A(ALL),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.registry.export', S3, 'Guest registry background Excel export үүсгэх/татах', {
    hotelAdmin: A(ALL),
    manager: A(ALL),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  nobody(
    'hotel.review.report_by_hotel_role',
    S3,
    'Hotel role-оор review report/moderation хийх',
    'RBAC-DEC-015: reporting a published review is a Guest-realm action; a hotel role never opens it',
  ),
  row(
    'hotel.review.official_reply_manage',
    S3,
    'Өөрийн hotel-ийн review-д official reply үүсгэх/засах/soft-delete/restore',
    {
      hotelAdmin: A(ALL),
      manager: A(ALL),
      managerPlus: A(P30),
      reception: D,
      cleaner: D,
      restaurantManager: D,
    },
  ),
  nobody(
    'hotel.review.moderation_queue',
    S3,
    'Review moderation queue/нуух/сэргээх/report шийдвэрлэх',
    'RBAC-DEC-015: only a Platform account holding the explicit REVIEW_MODERATE permission',
  ),
  row('hotel.finance.dashboard_full', S3, 'Full income/expense/top-5 financial dashboard', {
    hotelAdmin: A(),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.finance.room_excel', S3, 'Room income-expense financial Excel', {
    hotelAdmin: A(ALL),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.finance.minibar_excel', S3, 'Minibar income-expense financial Excel', {
    hotelAdmin: A(P2530),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.expense.category_manage', S3, 'Expense category үүсгэх/идэвхгүй болгох', {
    hotelAdmin: A(),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.expense.request_submit', S3, 'Expense хүсэлт үүсгэх/submit', {
    hotelAdmin: A(),
    manager: A(),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.expense.approve', S3, 'Expense approve for payment/reject', {
    hotelAdmin: A(),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.expense.payment_execute', S3, 'Approved expense payment execute', {
    hotelAdmin: A(),
    manager: A(),
    managerPlus: A(P30),
    reception: A(ALL, { condition: 'approved_request_only' }),
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.expense.reversal_approve', S3, 'Expense reversal/correction батлах', {
    hotelAdmin: A(),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.expense.own_request_view', S3, 'Өөрийн expense request харах', {
    hotelAdmin: A(ALL, { scope: 'own_request' }),
    manager: A(ALL, { scope: 'own_request' }),
    managerPlus: A(P30, { scope: 'own_request' }),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.location_manage', S3, 'Drawer/safe үүсгэх, initial configured float', {
    hotelAdmin: A(),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.count', S3, 'Actual cash count', {
    hotelAdmin: R('RECEPTION'),
    manager: R('RECEPTION'),
    managerPlus: R('RECEPTION'),
    reception: A(),
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.transfer_initiate', S3, 'Drawer transfer initiate/cancel request', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.transfer_receive', S3, 'Drawer transfer receive/confirm', {
    hotelAdmin: R('RECEPTION'),
    manager: R('RECEPTION'),
    managerPlus: R('RECEPTION'),
    reception: A(),
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.transfer_cancel_return_confirm', S3, 'Drawer transfer cancel return confirm', {
    hotelAdmin: R('RECEPTION'),
    manager: R('RECEPTION'),
    managerPlus: R('RECEPTION'),
    reception: A(),
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.drawer_safe_transfer', S3, 'Drawer ↔ Safe transfer', {
    hotelAdmin: A(),
    manager: A(),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.bank_deposit_request', S3, 'Bank deposit request', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.withdrawal_request', S3, 'Owner/other withdrawal request', {
    hotelAdmin: A(),
    manager: A(),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.withdrawal_approve', S3, 'Bank/owner withdrawal approve', {
    hotelAdmin: A(),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.top_up', S3, 'Cash top-up', {
    hotelAdmin: A(),
    manager: A(),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.correction_review', S3, 'Shift cash correction review', {
    hotelAdmin: A(ALL, { condition: 'exception_review_only' }),
    manager: A(ALL, { condition: 'not_original_actor' }),
    managerPlus: A(P30, { condition: 'not_original_actor' }),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.cash.report_full', S3, 'Full cash drawer/safe report/export', {
    hotelAdmin: A(),
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row('hotel.shift.own_operational_view', S3, 'Өөрийн shift/payment-ийн operational мэдээлэл', {
    hotelAdmin: A(ALL, { condition: 'limited_review' }),
    manager: A(ALL, { condition: 'limited_review' }),
    managerPlus: A(P30, { condition: 'limited_review' }),
    reception: A(ALL, { scope: 'own_shift' }),
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'hotel.handoff.takeover_item_read',
    S3,
    '`takeover_id`-тай old shift-ийн pre-suspension pending item status query — claim/read',
    {
      hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
      manager: A(),
      managerPlus: A(P30),
      reception: A(ALL, { scope: 'assigned_replacement' }),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row(
    'hotel.handoff.takeover_item_execute',
    S3,
    '`takeover_id`-тай old shift-ийн Reception terminal confirmation — execute',
    {
      hotelAdmin: R('RECEPTION'),
      manager: R('RECEPTION'),
      managerPlus: R('RECEPTION'),
      reception: A(ALL, { scope: 'assigned_replacement' }),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row('hotel.audit.report_view', S3, 'Hotel audit/security тайлан', {
    hotelAdmin: A(),
    manager: A(ALL, { scope: 'own_managed_events' }),
    managerPlus: A(P30, { scope: 'own_managed_events' }),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),

  // ------------------------------------------------------------- §3.2
  // The queue itself: an item exists, is claimed by exactly one Manager or
  // Manager Plus, and a replacement is chosen. Executing the replaced work is a
  // different permission — the rows above — which is the whole point of
  // `RBAC-DEC-014`: a takeover never substitutes for the operational role.
  row('hotel.handoff.queue_view', S32, 'Suspension exception queue харах', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(),
    managerPlus: A(P30),
    reception: A(ALL, { scope: 'assigned_replacement' }),
    cleaner: A(P2530, { scope: 'own_task' }),
    restaurantManager: A(P30, { scope: 'own_restaurant' }),
  }),
  row('hotel.handoff.replacement_assign', S32, 'Exception item-д replacement сонгох', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(),
    managerPlus: A(P30),
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'hotel.handoff.cleaner_continuation_create',
    S32,
    'Partial Cleaner movement-д linked CONTINUATION task үүсгэх',
    {
      hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
      manager: A(P2530),
      managerPlus: A(P30),
      reception: D,
      cleaner: D,
      restaurantManager: D,
    },
  ),

  // ------------------------------------------------------------- §3.3
  row('booking.cancel_own', S33, 'Check-in-ээс өмнө өөрийн booking цуцлах', {
    hotelAdmin: D,
    manager: D,
    managerPlus: D,
    reception: D,
    cleaner: D,
    restaurantManager: D,
  }),
  row(
    'booking.no_show_confirm',
    S33,
    'Arrival date-ийн 23:59:59 cutoff өнгөрсний дараа `NO_SHOW` батлах',
    {
      hotelAdmin: R('RECEPTION', 'MANAGER'),
      manager: A(),
      managerPlus: R('RECEPTION', 'MANAGER'),
      reception: A(),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row(
    'booking.same_category_room_assign',
    S33,
    'Conflict үед ижил category-ийн eligible room оноох',
    {
      hotelAdmin: R('RECEPTION'),
      manager: R('RECEPTION'),
      managerPlus: R('RECEPTION'),
      reception: A(),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row(
    'booking.higher_category_approve',
    S33,
    'Higher-category room-ийг нэмэлт төлбөргүй зөвшөөрөх',
    {
      hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
      manager: A(),
      managerPlus: A(P30),
      reception: R('MANAGER', 'MANAGER_PLUS'),
      cleaner: D,
      restaurantManager: D,
    },
  ),
  row('booking.cancelled_hotel', S33, 'Eligible room байхгүй үед `CANCELLED_HOTEL` болгох', {
    hotelAdmin: R('MANAGER', 'MANAGER_PLUS'),
    manager: A(),
    managerPlus: A(P30),
    reception: R('MANAGER', 'MANAGER_PLUS'),
    cleaner: D,
    restaurantManager: D,
  }),
  nobody(
    'booking.provider_refund_manual_mark',
    S33,
    'Provider refund-ийг гараар `Амжилттай/REFUNDED` болгох',
    'PAY-DEC-007: only a verified provider or server result moves the refund axis',
  ),
];

/**
 * The Guest-realm rows of doc 18 §3.3, which have their own column.
 *
 * Kept apart from the hotel matrix because a Guest holds no membership and no
 * role: authorization is ownership-based (doc 06 §4.3). Cancelling a booking is
 * the booking owner's action and no hotel role can perform it on their behalf.
 */
export interface GuestAction {
  readonly id: string;
  readonly source: string;
  readonly label: string;
  readonly cell: Cell;
}

export const GUEST_ACTIONS: readonly GuestAction[] = [
  {
    id: 'booking.cancel_own',
    source: S33,
    label: 'Check-in-ээс өмнө өөрийн booking цуцлах',
    cell: allow(ALL, { scope: 'booking_owner' }),
  },
  {
    id: 'review.report_published',
    source: '18 §8',
    label: 'Нийтлэгдсэн review-г report хийх',
    cell: allow(ALL),
  },
];

/** Every hotel role, in the order the matrix columns are written. */
export const MATRIX_COLUMNS: readonly HotelRole[] = [
  'HOTEL_ADMIN',
  'MANAGER',
  'MANAGER_PLUS',
  'RECEPTION',
  'CLEANER',
  'RESTAURANT_MANAGER',
];
