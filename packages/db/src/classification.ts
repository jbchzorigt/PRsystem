/**
 * Machine-checked database classification.
 *
 * Every kernel table is exactly one class. The manifest is the declared
 * intent; `validateClassification` compares it against what the live database
 * actually enforces, so a table added without RLS, or an audit grant widened by
 * accident, fails a gate instead of shipping.
 */

export type TableClass =
  | 'GLOBAL'
  | 'ACCOUNT_GLOBAL'
  | 'TENANT_RLS'
  | 'PRE_TENANT_ISOLATED'
  | 'PLATFORM_AUDIT'
  | 'POLICE_ISOLATED';

export interface ClassifiedTable {
  readonly schema: string;
  readonly table: string;
  readonly classification: TableClass;
  readonly why: string;
}

/** The declared classification of every kernel table. */
export const TABLE_CLASSIFICATION: readonly ClassifiedTable[] = [
  {
    schema: 'platform',
    table: 'idempotency_key',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a replayed response must never cross a tenant',
  },
  {
    schema: 'platform',
    table: 'outbox_event',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; an event payload is tenant data',
  },
  {
    schema: 'platform',
    table: 'outbox_delivery',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; delivery state reveals tenant activity',
  },
  {
    schema: 'platform',
    table: 'inbox_consumption',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; consumption keys reveal tenant activity',
  },
  {
    schema: 'platform',
    table: 'provider_event',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; provider references are tenant data',
  },
  {
    schema: 'platform',
    table: 'job_run',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; job scope is tenant data',
  },
  {
    schema: 'platform',
    table: 'export_artifact',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; an export describes tenant data',
  },
  {
    schema: 'platform',
    table: 'projection_checkpoint',
    classification: 'GLOBAL',
    why: 'operational metadata about a projection, not tenant rows',
  },
  {
    schema: 'platform',
    table: 'external_gate',
    classification: 'GLOBAL',
    why: 'global reference; read-only at runtime (ADR-0017 §8)',
  },
  {
    schema: 'platform',
    table: 'internal_gate',
    classification: 'GLOBAL',
    why: 'global reference; read-only at runtime',
  },
  {
    schema: 'platform',
    table: 'feature_flag',
    classification: 'GLOBAL',
    why: 'global reference; read-only at runtime',
  },
  {
    schema: 'platform',
    table: 'operational_alert',
    classification: 'GLOBAL',
    why: 'operations surface; carries no tenant row data',
  },
  // ------------------------------------------------------------- Phase 04
  {
    schema: 'platform',
    table: 'hotel',
    classification: 'TENANT_RLS',
    why: 'the tenant root itself; its own hotel_id is the scope (doc 06 §1)',
  },
  {
    schema: 'platform',
    table: 'user_account',
    classification: 'ACCOUNT_GLOBAL',
    why: 'an account is not hotel data: one person holds memberships in several hotels (STAFF-DEC-002)',
  },
  {
    schema: 'platform',
    table: 'account_credential',
    classification: 'ACCOUNT_GLOBAL',
    why: 'the credential belongs to the account, and a password change crosses every membership (STAFF-DEC-003)',
  },
  {
    schema: 'platform',
    table: 'server_session',
    classification: 'ACCOUNT_GLOBAL',
    why: 'a session is account-wide; its authority inside one hotel is session_scope_grant, which is tenant-scoped',
  },
  {
    schema: 'platform',
    table: 'password_reset_request',
    classification: 'ACCOUNT_GLOBAL',
    why: 'a reset revokes sessions across every membership, so it can carry no single hotel scope',
  },
  {
    schema: 'platform',
    table: 'password_reset_intake',
    classification: 'ACCOUNT_GLOBAL',
    why: 'a queued reset request names an address, which may belong to no account at all and to no hotel',
  },
  {
    schema: 'platform',
    table: 'account_permission_grant',
    classification: 'ACCOUNT_GLOBAL',
    why: 'Operation, Platform and Police permissions are per account and cross no tenant (RBAC-DEC-004)',
  },
  {
    schema: 'platform',
    table: 'staff_membership',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a membership is the tenant boundary itself (doc 06 §2)',
  },
  {
    schema: 'platform',
    table: 'membership_role_grant',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a role grant is authority inside one hotel',
  },
  {
    schema: 'platform',
    table: 'staff_invitation',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; an invitation names a hotel scope and an email',
  },
  {
    schema: 'platform',
    table: 'invitation_requested_role',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the roles an invitation asks for are tenant data',
  },
  {
    schema: 'platform',
    table: 'session_scope_grant',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; it is the authority a session holds inside one hotel, revoked per scope (doc 19 §10)',
  },
  {
    schema: 'platform',
    table: 'work_handoff_item',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; unfinished work after a suspension is tenant data (STAFF-DEC-007)',
  },
  {
    schema: 'platform',
    table: 'work_handoff_event',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; append-only movement history for one hotel',
  },
  {
    schema: 'platform',
    table: 'work_handoff_discovery',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the retryable marker that a suspended membership\u2019s open work still has to be enumerated (STAFF-DEC-007)',
  },
  // ------------------------------------------------------------- Phase 05
  //
  // The pre-tenant graph. These carry no `hotel_id` — an application exists
  // before any hotel does — so they are not TENANT_RLS, and they are not
  // ACCOUNT_GLOBAL either: they belong to an applicant who may have no account
  // at all. Their isolation is `app.onboarding_ref`, which is NULL unless the
  // applicant presented the bearer secret their own draft was minted with, plus
  // an explicit Operation-realm review policy. `PRE_TENANT_ISOLATED` names that
  // and is checked the same way every other class is: RLS enabled and forced, no
  // tenant column, and a policy set that is actually present.
  {
    schema: 'platform',
    table: 'subscription_owner',
    classification: 'PRE_TENANT_ISOLATED',
    why: 'an owner profile outlives any one hotel and is reachable only from its own application or by Operation (ONB-DEC-005)',
  },
  {
    schema: 'platform',
    table: 'onboarding_application',
    classification: 'PRE_TENANT_ISOLATED',
    why: 'the pre-payment request; there is no tenant yet and a nullable hotel_id would be a scope every applicant shares (ONB-DEC-001)',
  },
  {
    schema: 'platform',
    table: 'onboarding_phone_verification',
    classification: 'PRE_TENANT_ISOLATED',
    why: 'the OTP challenge belongs to one application and to no hotel (doc 15 §2.1)',
  },
  {
    schema: 'platform',
    table: 'onboarding_owner_proof',
    classification: 'PRE_TENANT_ISOLATED',
    why: 'an ownership challenge belongs to one application and to no hotel (ONB-DEC-007)',
  },
  {
    schema: 'platform',
    table: 'onboarding_payment_attempt',
    classification: 'PRE_TENANT_ISOLATED',
    why: 'the invoice precedes the tenant it will pay for (ONB-DEC-008)',
  },
  {
    schema: 'platform',
    table: 'onboarding_event',
    classification: 'PRE_TENANT_ISOLATED',
    why: 'append-only application history, scoped to the application it describes (doc 15 §8)',
  },
  {
    schema: 'platform',
    table: 'hotel_profile',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the public name, contact and location are tenant data (doc 15 §2.1)',
  },
  {
    schema: 'platform',
    table: 'hotel_owner_link',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; which owner a hotel belongs to is tenant data (ONB-DEC-005)',
  },
  {
    schema: 'platform',
    table: 'hotel_subscription',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the authoritative entitlement row authorization stage 5 reads (OPS-DEC-016)',
  },
  {
    schema: 'platform',
    table: 'subscription_billing_intent',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a renewal or upgrade quote is one hotel\u2019s money (LIFE-DEC-006)',
  },
  {
    schema: 'platform',
    table: 'subscription_payment',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; confirmed subscription money, append-only (SUB-DEC-009)',
  },
  {
    schema: 'platform',
    table: 'subscription_event',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; append-only renewal and upgrade history (doc 17 §4)',
  },
  {
    schema: 'platform',
    table: 'ebarimt_issuance',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a tax receipt names one hotel\u2019s payment (SUB-DEC-005)',
  },
  {
    schema: 'platform',
    table: 'cash_location',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the default drawer is the hotel\u2019s own cash root (doc 24 §2.1)',
  },
  {
    schema: 'platform',
    table: 'hotel_admin_activation',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the first Hotel Admin\u2019s activation axis belongs to one hotel (doc 15 §6)',
  },
  {
    schema: 'platform',
    table: 'activation_delivery',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the sealed activation link is one hotel\u2019s outbound delivery (doc 15 §5)',
  },
  {
    schema: 'platform',
    table: 'hotel_stay_configuration',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the default tariffs, fixed check-out time and cleaning minimum are tenant configuration (STAY-DEC-004, STAY-DEC-005)',
  },
  {
    schema: 'platform',
    table: 'room_category',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a category and its overrides are tenant data (doc 07 §2)',
  },
  {
    schema: 'platform',
    table: 'room',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a physical room and its walk-in overrides are tenant data (doc 07 §3)',
  },
  {
    schema: 'platform',
    table: 'minibar_product',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a minibar product belongs to one hotel (doc 26 §6)',
  },
  {
    schema: 'platform',
    table: 'minibar_template',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a minibar template belongs to one hotel (doc 26 §7)',
  },
  {
    schema: 'platform',
    table: 'catalog_event',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; append-only catalog and lifecycle history (RML-DEC-006)',
  },
  {
    schema: 'platform',
    table: 'stay_rate_snapshot',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a confirmed price and the configuration it came from (STAY-DEC-005)',
  },
  // Phase 07 — minibar inventory and templates.
  {
    schema: 'platform',
    table: 'minibar_warehouse_stock',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the warehouse balance and average cost of one product, written only by the ledger trigger (INV-DEC-002)',
  },
  {
    schema: 'platform',
    table: 'room_minibar_stock',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; what one room physically holds of one product, written only by the ledger trigger (INV-DEC-002)',
  },
  {
    schema: 'platform',
    table: 'inventory_movement',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the append-only stock ledger every balance is derived from (INV-DEC-003)',
  },
  {
    schema: 'platform',
    table: 'minibar_template_version',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a DRAFT → PUBLISHED → ARCHIVED version of one template (RML-DEC-015)',
  },
  {
    schema: 'platform',
    table: 'minibar_template_version_item',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the product list and target quantity of one version, immutable once published (RML-DEC-016)',
  },
  {
    schema: 'platform',
    table: 'room_minibar_configuration',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the one current minibar configuration of a room (RML-DEC-007)',
  },
  {
    schema: 'platform',
    table: 'room_configuration_change',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the at-most-one pending change of a room, pinned to an exact target (RML-DEC-007, RML-DEC-023)',
  },
  {
    schema: 'platform',
    table: 'minibar_reconciliation_task',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the server-bounded Cleaner task of one configuration change (RML-DEC-013)',
  },
  {
    schema: 'platform',
    table: 'rollout_batch',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a multi-room Rollout parent and its exact target (RML-DEC-025)',
  },
  {
    schema: 'platform',
    table: 'rollout_batch_room',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; one selected room of a batch and its accepted or skipped result (RML-DEC-026)',
  },
  {
    schema: 'platform',
    table: 'minibar_shortage_override',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the Manager exception that opens a short minibar for the next stay (INV-DEC-006)',
  },
  {
    schema: 'platform',
    table: 'minibar_event',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the append-only history of version, configuration, task and batch transitions (doc 22 §11)',
  },
  {
    schema: 'platform',
    table: 'reception_shift',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the operational Reception shift a check-in is confirmed in (doc 05 §19.1); Phase 11 extends it',
  },
  {
    schema: 'platform',
    table: 'room_cleaning_state',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the current cleaning axis of a room (doc 06 §4, STAY-DEC-008)',
  },
  {
    schema: 'platform',
    table: 'room_cleaning_event',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the append-only cleaning history a backdated check-in proves readiness from (doc 05 §19.2)',
  },
  {
    schema: 'platform',
    table: 'stay',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the stay with its immutable times, snapshots and forward-only state (STAY-DEC-009, -011, -012)',
  },
  {
    schema: 'platform',
    table: 'stay_guest',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the identity of the primary guest with its encrypted identifier and keyed token, in append-only revisions (RC-DEC-044)',
  },
  {
    schema: 'platform',
    table: 'stay_minibar_snapshot',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the exact template version a check-in pinned for its price book (PRICE-DEC-001)',
  },
  {
    schema: 'platform',
    table: 'stay_minibar_price',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the selling prices a stay is charged, captured at check-in and never edited (PRICE-DEC-001)',
  },
  {
    schema: 'platform',
    table: 'stay_time_correction',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the active-stay actual-time correction request and decision (STAY-DEC-010)',
  },
  {
    schema: 'platform',
    table: 'booking_fulfillment_conflict',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the overdue conflict of a confirmed booking and its one terminal remedy (STAY-DEC-013)',
  },
  {
    schema: 'platform',
    table: 'stay_event',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the append-only stay history (doc 05 §19.3, §20.3)',
  },
  {
    schema: 'platform',
    table: 'cleaning_task',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; the Cleaner's unit of cleaning work over a room whose checkout is done (doc 04 §3, §8)",
  },
  {
    schema: 'platform',
    table: 'minibar_usage_report',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the minibar usage report a minibar-enabled checkout cannot close without (CHK-DEC-001)',
  },
  {
    schema: 'platform',
    table: 'minibar_usage_report_version',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; one immutable version of a usage report, normal or exception (CHK-DEC-002, -003)',
  },
  {
    schema: 'platform',
    table: 'minibar_usage_report_line',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; a priced line, its billable-quantity formula and the stay's snapshot price (PRICE-DEC-005, -007)",
  },
  {
    schema: 'platform',
    table: 'minibar_usage_report_movement',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the refill and non-guest movements a version counted (doc 22 §8)',
  },
  {
    schema: 'platform',
    table: 'minibar_report_dispute',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; a guest's disputed line and the Manager's decision on it (CHK-DEC-006)",
  },
  {
    schema: 'platform',
    table: 'minibar_payment_lock',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the lock a payment attempt puts on the exact version it charges (CHK-DEC-004)',
  },
  {
    schema: 'platform',
    table: 'minibar_report_adjustment',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the append-only correction of a settled charge (CHK-DEC-005)',
  },
  {
    schema: 'platform',
    table: 'minibar_refill_task',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; the active-stay refill request and the Cleaner's confirmation of it (doc 04 §5.1)",
  },
  {
    schema: 'platform',
    table: 'deposit_config',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the configured deposit default and category override (RC-DEC-002)',
  },
  {
    schema: 'platform',
    table: 'stay_folio',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the one consolidated bill of a stay (RC-DEC-001)',
  },
  {
    schema: 'platform',
    table: 'folio_line',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; an append-only charge on the folio, idempotent on its source (doc 02 §3.3)',
  },
  {
    schema: 'platform',
    table: 'deposit_aggregate',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the versioned deposit balance and the requirement it was confirmed under (DEP-DEC-007, -008)',
  },
  {
    schema: 'platform',
    table: 'payment_transaction',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the immutable money ledger of receipts, refunds, reversals and corrections (DEP-DEC-006)',
  },
  {
    schema: 'platform',
    table: 'deposit_allocation',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; what the deposit paid for, line by line (DEP-DEC-002)',
  },
  {
    schema: 'platform',
    table: 'refund_request',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a refund, its reservation and its state machine (DEP-DEC-003, -009)',
  },
  {
    schema: 'platform',
    table: 'financial_correction',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the reversal-plus-corrected-record request (DEP-DEC-006)',
  },
  {
    schema: 'platform',
    table: 'deposit_reconciliation_case',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the late-success case Platform Operation resolves (DEP-DEC-010)',
  },
  {
    schema: 'platform',
    table: 'hotel_finance_event',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; the hotel's own loss when a deposit could not cover a late refund (DEP-DEC-010)",
  },
  {
    schema: 'platform',
    table: 'cash_movement',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the typed immutable cash ledger of a hotel (CASH-DEC-004)',
  },
  {
    schema: 'platform',
    table: 'cash_transfer',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a transfer between two cash locations and the counts that resolve it (CASH-DEC-006)',
  },
  {
    schema: 'platform',
    table: 'cash_request',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; a bank deposit or owner withdrawal awaiting a Hotel Admin's approval (CASH-DEC-007)",
  },
  {
    schema: 'platform',
    table: 'expense',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the expense lifecycle whose approval is not a cash outflow (FIN-DEC-005)',
  },
  {
    schema: 'platform',
    table: 'guest_account',
    classification: 'ACCOUNT_GLOBAL',
    why: "the Guest's own account; a Guest belongs to no hotel and carries no hotel_id (BK-DEC-002, doc 09 §6.2)",
  },
  {
    schema: 'platform',
    table: 'guest_phone_verification',
    classification: 'ACCOUNT_GLOBAL',
    why: 'the one-time code proving a phone number, before any account or hotel exists (doc 09 §6.2)',
  },
  {
    schema: 'platform',
    table: 'guest_identity_link',
    classification: 'ACCOUNT_GLOBAL',
    why: 'binds an external provider subject to a Guest account; no tenant is involved (doc 09 §6.1)',
  },
  {
    schema: 'platform',
    table: 'guest_account_link_request',
    classification: 'ACCOUNT_GLOBAL',
    why: 'the dual-channel confirmation between two account-level identities (doc 09 §6.3)',
  },
  {
    schema: 'platform',
    table: 'hotel_photo',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the photographs a listing is not shown without (doc 09 §3.2, §5)',
  },
  {
    schema: 'platform',
    table: 'booking',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the online booking that occupies one category unit (BK-DEC-012, -013)',
  },
  {
    schema: 'platform',
    table: 'booking_night',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the exact nights a booking took, so releasing it releases those',
  },
  {
    schema: 'platform',
    table: 'category_night_inventory',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the capacity and units taken whose CHECK refuses overbooking (BK-DEC-013)',
  },
  {
    schema: 'platform',
    table: 'booking_payment_attempt',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; one live attempt per booking, superseded on a provider switch (doc 09 §8)',
  },
  {
    schema: 'platform',
    table: 'booking_event',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the append-only booking history an expiry and a cancellation differ in',
  },
  {
    schema: 'platform',
    table: 'hotel_commission_contract',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; the hotel's own negotiated commission rate, with no platform default (PAY-DEC-001)",
  },
  {
    schema: 'platform',
    table: 'booking_payable',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; what one booking earns the hotel, with the contract snapshot it settled under',
  },
  {
    schema: 'platform',
    table: 'booking_ledger_event',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; the append-only money ledger of the hotel's own bookings (doc 11 §9)",
  },
  {
    schema: 'platform',
    table: 'booking_refund',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the refund axis, which only a verified provider result moves (PAY-DEC-007)',
  },
  {
    schema: 'platform',
    table: 'payout_batch',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; one D+1 payout attempt against the hotel's own account (PAY-DEC-009)",
  },
  {
    schema: 'platform',
    table: 'payout_batch_item',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the lines a payout attempt is made of, one settled per payable',
  },
  {
    schema: 'platform',
    table: 'restaurant',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the restaurant a Manager Plus registered for this hotel (RC-DEC-019)',
  },
  {
    schema: 'platform',
    table: 'hotel_restaurant_link',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; whether this hotel may order from this restaurant (doc 08 §4)',
  },
  {
    schema: 'platform',
    table: 'restaurant_schedule',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the ordering window of one weekday (RC-DEC-022)',
  },
  {
    schema: 'platform',
    table: 'restaurant_schedule_override',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; a holiday or closure outranking the weekly window',
  },
  {
    schema: 'platform',
    table: 'restaurant_menu_category',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; the restaurant's own menu sections",
  },
  {
    schema: 'platform',
    table: 'restaurant_menu_item',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the item and the price the server recomputes a basket from',
  },
  {
    schema: 'platform',
    table: 'room_access_token',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; the room's permanent QR token, stored as a keyed hash (RC-DEC-026)",
  },
  {
    schema: 'platform',
    table: 'stay_guest_access',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the counter that refuses a sixth guest session (RC-DEC-027)',
  },
  {
    schema: 'platform',
    table: 'guest_access_code',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the one-time code, as a keyed hash and never in plaintext',
  },
  {
    schema: 'platform',
    table: 'guest_session',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; a guest device's session, bound to one stay and one room",
  },
  {
    schema: 'platform',
    table: 'restaurant_order',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the food order on its seven canonical axes (REST-DEC-001)',
  },
  {
    schema: 'platform',
    table: 'restaurant_order_item',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the item, price and quantity as they were when it was placed',
  },
  {
    schema: 'platform',
    table: 'restaurant_order_event',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; the order's append-only history, per axis",
  },
  {
    schema: 'platform',
    table: 'restaurant_payment_attempt',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; one invoice on the restaurant's own merchant (RC-DEC-021)",
  },
  {
    schema: 'platform',
    table: 'restaurant_refund',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the refund the restaurant executes on its own merchant (RC-DEC-024)',
  },
  {
    schema: 'platform',
    table: 'hotel_review',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the verified-stay review, one per completed booking (RV-DEC-002)',
  },
  {
    schema: 'platform',
    table: 'hotel_review_edit',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; what the reviewer wrote before an edit, kept (RV-DEC-004)',
  },
  {
    schema: 'platform',
    table: 'hotel_review_aggregate',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the published count, rating sum and derived average (doc 10 §6)',
  },
  {
    schema: 'platform',
    table: 'review_report',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; a Guest's report on a published review, one open per account (RV-DEC-005)",
  },
  {
    schema: 'platform',
    table: 'review_moderation_event',
    classification: 'TENANT_RLS',
    why: 'carries hotel_id; the append-only hide, restore and report resolution history (RV-DEC-006)',
  },
  {
    schema: 'platform',
    table: 'hotel_review_reply',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; the hotel's one official reply to a review (RV-DEC-007)",
  },
  {
    schema: 'platform',
    table: 'hotel_review_reply_event',
    classification: 'TENANT_RLS',
    why: "carries hotel_id; the reply's append-only lifecycle history (doc 10 §7.4)",
  },
  {
    schema: 'audit',
    table: 'platform_event',
    classification: 'PLATFORM_AUDIT',
    why: 'append-only platform audit stream (ADR-0018 §1)',
  },
  {
    schema: 'police_audit',
    table: 'security_event',
    classification: 'POLICE_ISOLATED',
    why: 'append-only Police audit stream, separately granted (ADR-0018 §1)',
  },
];

/** Roles that must never own a kernel object or hold a direct audit grant. */
export const RUNTIME_ROLES = [
  'prsystem_api',
  'prsystem_worker',
  'prsystem_police',
  'prsystem_audit_reader',
  'prsystem_police_audit_reader',
] as const;

/** The only grantees permitted on each audit stream, and what they may hold. */
export const AUDIT_GRANT_POLICY = {
  'audit.platform_event': {
    prsystem_audit_writer: ['INSERT'],
    prsystem_audit_reader: ['SELECT'],
  },
  'police_audit.security_event': {
    prsystem_audit_writer: ['INSERT'],
    prsystem_police_audit_reader: ['SELECT'],
  },
} as const;

export interface ClassificationViolation {
  readonly kind:
    | 'unclassified_table'
    | 'account_global_carries_tenant_column'
    | 'tenant_column_not_tenant_rls'
    | 'tenant_rls_not_forced'
    | 'pre_tenant_carries_tenant_column'
    | 'pre_tenant_not_forced'
    | 'pre_tenant_has_no_policy'
    | 'unauthorised_audit_grant'
    | 'runtime_role_owns_object';
  readonly detail: string;
}
