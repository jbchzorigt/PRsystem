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
