import type { CellScope } from './cells';
import type { PoliceRole } from './roles';

/**
 * doc 18 §6 — the Police base matrix.
 *
 * Two rules the table encodes rather than describes:
 *
 *  - **Police Admin does not inherit Officer mutations** (`RBAC-DEC-005`). Draft
 *    creation, manual identity approval, case lifecycle, Found/False Match
 *    correction approval and export each need their own named permission.
 *  - **Separation of duties is compared at the backend**, on immutable account
 *    ids (doc 05 §3.2): approver ≠ requester, approver ≠ creator.
 *
 * Phase 04 owns the catalog and the pipeline. The Police domain itself — wanted
 * persons, cases, matches — is Phase 18, and no Police table exists yet.
 */
export type PoliceCell =
  | { readonly kind: 'deny'; readonly note?: string }
  | { readonly kind: 'allow'; readonly scope?: CellScope }
  /** Allowed only to an account holding the named permission explicitly. */
  | { readonly kind: 'named'; readonly permission: string; readonly separation?: Separation };

export type Separation = 'approver_not_requester' | 'approver_not_creator';

export interface PoliceAction {
  readonly id: string;
  readonly source: string;
  readonly label: string;
  readonly cells: Readonly<Record<PoliceRole, PoliceCell>>;
  /** doc 05 §5: Police high-risk actions need a recent step-up. */
  readonly stepUp: boolean;
}

const S6 = '18 §6';
const allowBoth = { kind: 'allow' } as const;

function police(
  id: string,
  label: string,
  officer: PoliceCell,
  admin: PoliceCell,
  stepUp = false,
): PoliceAction {
  return {
    id,
    source: S6,
    label,
    cells: { POLICE_OFFICER: officer, POLICE_ADMIN: admin },
    stepUp,
  };
}

export const POLICE_ACTIONS: readonly PoliceAction[] = [
  police(
    'police.account_manage',
    'Police account үүсгэх/түдгэлзүүлэх, role/unit тохируулах',
    { kind: 'deny' },
    allowBoth,
    true,
  ),
  police(
    'police.wanted_case_draft_create',
    'Wanted Person/Case draft, ХУР/manual identity үүсгэх',
    allowBoth,
    { kind: 'named', permission: 'WANTED_CASE_CREATE' },
  ),
  police('police.wanted_active_view', 'Active Wanted мэдээлэл харах', allowBoth, allowBoth),
  police(
    'police.match_alert_view',
    'Match alert харах',
    { kind: 'allow', scope: 'own_police_scope' },
    allowBoth,
  ),
  police('police.exact_identifier_search', 'Exact РД/Match ID хайлт', allowBoth, allowBoth, true),
  police(
    'police.all_hotel_checkin_list',
    'Бүх hotel-ийн check-in үндсэн зочдын жагсаалт',
    { kind: 'deny' },
    allowBoth,
    true,
  ),
  police(
    'police.all_hotel_checkin_export',
    'Бүх hotel check-in Excel/CSV/bulk export',
    { kind: 'deny', note: 'MVP-д хаалттай' },
    { kind: 'deny', note: 'MVP-д хаалттай' },
    true,
  ),
  police('police.match_acknowledge', 'Match-ийг хүлээн авсан гэж тэмдэглэх', allowBoth, allowBoth),
  police('police.found_confirm', 'Өөрийн account-аар `Олдсон` батлах', allowBoth, allowBoth, true),
  police(
    'police.found_correction_request',
    'Өөрийн `Олдсон` залруулгын хүсэлт гаргах',
    allowBoth,
    allowBoth,
  ),
  police(
    'police.found_correction_decide',
    '`Олдсон` залруулга батлах/татгалзах',
    {
      kind: 'named',
      permission: 'FOUND_CORRECTION_APPROVE',
      separation: 'approver_not_requester',
    },
    {
      kind: 'named',
      permission: 'FOUND_CORRECTION_APPROVE',
      separation: 'approver_not_requester',
    },
    true,
  ),
  police('police.false_match_request', '`Худал Match` хүсэлт гаргах', allowBoth, allowBoth),
  police(
    'police.false_match_decide',
    '`Худал Match` хүсэлт батлах/татгалзах',
    { kind: 'named', permission: 'FALSE_MATCH_APPROVE', separation: 'approver_not_requester' },
    { kind: 'named', permission: 'FALSE_MATCH_APPROVE', separation: 'approver_not_requester' },
    true,
  ),
  police(
    'police.manual_identity_approve',
    'Manual identity батлах',
    { kind: 'named', permission: 'WANTED_IDENTITY_APPROVE', separation: 'approver_not_creator' },
    { kind: 'named', permission: 'WANTED_IDENTITY_APPROVE', separation: 'approver_not_creator' },
    true,
  ),
  police(
    'police.case_state_manage',
    'Case идэвхжүүлэх/түдгэлзүүлэх/сэргээх/хаах/цуцлах',
    { kind: 'named', permission: 'WANTED_CASE_STATE_MANAGE' },
    { kind: 'named', permission: 'WANTED_CASE_STATE_MANAGE' },
    true,
  ),
  police('police.dashboard_basic', 'Dashboard-ийн үндсэн тоо', allowBoth, allowBoth),
  police(
    'police.analytics_and_access_audit',
    'Ангилал/дүүргийн graph, Police access audit',
    { kind: 'deny' },
    allowBoth,
    true,
  ),
  police(
    'police.wanted_case_export',
    'Wanted Case Excel export',
    { kind: 'deny' },
    { kind: 'named', permission: 'WANTED_CASE_EXPORT' },
    true,
  ),
];

/** Every explicitly named Police permission, sorted and de-duplicated. */
export const POLICE_PERMISSIONS: readonly string[] = [
  ...new Set(
    POLICE_ACTIONS.flatMap((action) =>
      Object.values(action.cells)
        .filter((cell): cell is Extract<PoliceCell, { kind: 'named' }> => cell.kind === 'named')
        .map((cell) => cell.permission),
    ),
  ),
].sort();
