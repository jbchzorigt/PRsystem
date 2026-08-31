import type { OperationRole } from './roles';

/**
 * doc 18 §5 — Operation and Platform Super Admin.
 *
 * The rule this table exists to make structural: **a role name grants nothing**
 * (`RBAC-DEC-004`, `RBAC-DEC-017`). `Platform Super Admin` is a label, not an
 * authority. Every row names the permission that must be granted to the account
 * explicitly, and the two columns say which population may hold it at all — the
 * document's "тусдаа" is exactly that: granted separately, per account.
 *
 * Every one of these is a high-risk action and carries a recent step-up
 * requirement (doc 05 §5, `OPS-DEC-015`, `OPS-DEC-016`).
 */
export interface OperationAction {
  readonly id: string;
  readonly source: string;
  readonly label: string;
  /**
   * The named permission an account must hold. `null` where the document
   * refuses the action to both columns outright.
   */
  readonly permission: string | null;
  /** Which populations may be granted it. Empty when the row is refused to both. */
  readonly grantableTo: readonly OperationRole[];
  readonly stepUp: boolean;
}

const BOTH: readonly OperationRole[] = ['OPERATION_ADMIN', 'PLATFORM_SUPER_ADMIN'];
const PLATFORM_ONLY: readonly OperationRole[] = ['PLATFORM_SUPER_ADMIN'];
const NEITHER: readonly OperationRole[] = [];
const S5 = '18 §5';

export const OPERATION_ACTIONS: readonly OperationAction[] = [
  {
    id: 'operation.hotel_subscription_list',
    source: S5,
    label: 'Hotel/subscription жагсаалт',
    permission: 'OPERATION_READ',
    grantableTo: BOTH,
    stepUp: true,
  },
  {
    id: 'operation.subscription_reminder_send',
    source: S5,
    label: 'Subscription reminder SMS',
    permission: 'SUBSCRIPTION_REMINDER_SEND',
    grantableTo: BOTH,
    stepUp: true,
  },
  {
    id: 'operation.hotel_admin_password_reset_initiate',
    source: S5,
    label: 'Hotel Admin password reset эхлүүлэх',
    permission: 'SUBSCRIPTION_PASSWORD_RESET_INITIATE',
    grantableTo: BOTH,
    stepUp: true,
  },
  {
    id: 'operation.onboarding_provision_retry',
    source: S5,
    label: 'Paid failed onboarding provisioning retry',
    permission: 'ONBOARDING_PROVISION_RETRY',
    grantableTo: BOTH,
    stepUp: true,
  },
  {
    id: 'operation.ebarimt_retry',
    source: S5,
    label: 'eBarimt manual retry/email task',
    permission: 'SUBSCRIPTION_EBARIMT_RETRY',
    grantableTo: BOTH,
    stepUp: true,
  },
  {
    id: 'operation.subscription_payment_reconcile',
    source: S5,
    label: 'Stale/duplicate paid billing reconciliation',
    permission: 'SUBSCRIPTION_PAYMENT_RECONCILE',
    grantableTo: BOTH,
    stepUp: true,
  },
  {
    id: 'operation.deposit_refund_reconcile',
    source: S5,
    label: 'Released deposit refund-ийн late-success reconciliation',
    permission: 'DEPOSIT_REFUND_RECONCILE',
    grantableTo: BOTH,
    stepUp: true,
  },
  {
    id: 'operation.subscription_suspend',
    source: S5,
    label: 'Subscription suspend/reactivate',
    permission: 'SUBSCRIPTION_SUSPEND',
    grantableTo: PLATFORM_ONLY,
    stepUp: true,
  },
  {
    id: 'operation.subscription_contact_change_approve',
    source: S5,
    label: 'Subscription contact offline exception approve',
    permission: 'SUBSCRIPTION_CONTACT_CHANGE_APPROVE',
    grantableTo: PLATFORM_ONLY,
    stepUp: true,
  },
  {
    id: 'operation.access_user_manage',
    source: S5,
    label: 'Operation хэрэглэгч үүсгэх/түдгэлзүүлэх',
    permission: 'PLATFORM_OPERATION_ACCESS_MANAGE',
    grantableTo: PLATFORM_ONLY,
    stepUp: true,
  },
  {
    id: 'operation.access_permission_manage',
    source: S5,
    label: 'Operation permission олгох/цуцлах',
    permission: 'PLATFORM_OPERATION_ACCESS_MANAGE',
    grantableTo: PLATFORM_ONLY,
    stepUp: true,
  },
  {
    id: 'operation.account_ownership_recovery_approve',
    source: S5,
    label: 'Email ownership offline recovery',
    permission: 'ACCOUNT_OWNERSHIP_RECOVERY_APPROVE',
    grantableTo: PLATFORM_ONLY,
    stepUp: true,
  },
  {
    id: 'operation.review_moderate',
    source: S5,
    label: 'Review moderation queue/нуух/сэргээх/report шийдвэрлэх',
    permission: 'REVIEW_MODERATE',
    grantableTo: BOTH,
    stepUp: true,
  },
  {
    id: 'operation.hotel_operational_data_manage',
    source: S5,
    label: 'Hotel operational data удирдах',
    permission: null,
    grantableTo: NEITHER,
    stepUp: true,
  },
  {
    id: 'operation.hotel_guest_registry_view',
    source: S5,
    label: 'Hotel guest registry харах',
    permission: null,
    grantableTo: NEITHER,
    stepUp: true,
  },
  {
    id: 'operation.police_data_view',
    source: S5,
    label: 'Police wanted/match/check-in data харах',
    permission: null,
    grantableTo: NEITHER,
    stepUp: true,
  },
  {
    id: 'operation.credential_material_view',
    source: S5,
    label: 'Хэрэглэгчийн одоогийн/шинэ password, OTP/token харах',
    permission: null,
    grantableTo: NEITHER,
    stepUp: true,
  },
];

/** Every Operation permission the catalog knows, sorted and de-duplicated. */
export const OPERATION_PERMISSIONS: readonly string[] = [
  ...new Set(
    OPERATION_ACTIONS.map((action) => action.permission).filter(
      (permission): permission is string => permission !== null,
    ),
  ),
].sort();

const OPERATION_BY_ID = new Map(OPERATION_ACTIONS.map((action) => [action.id, action]));

/** The doc 18 §5 row an action id names, or `undefined` if the table has none. */
export function operationAction(id: string): OperationAction | undefined {
  return OPERATION_BY_ID.get(id);
}

/**
 * Every Operation permission one role may be granted at all.
 *
 * The inverse of the table, and the only list a grant is allowed to come from:
 * a row the document refuses to both columns has `permission: null` and appears
 * in neither, so it cannot be granted to anybody by writing a row.
 */
export function operationGrantablePermissions(role: OperationRole): readonly string[] {
  return [
    ...new Set(
      OPERATION_ACTIONS.filter(
        (action) => action.permission !== null && action.grantableTo.includes(role),
      ).map((action) => action.permission as string),
    ),
  ].sort();
}
