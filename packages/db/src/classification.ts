/**
 * Machine-checked database classification.
 *
 * Every kernel table is exactly one class. The manifest is the declared
 * intent; `validateClassification` compares it against what the live database
 * actually enforces, so a table added without RLS, or an audit grant widened by
 * accident, fails a gate instead of shipping.
 */

export type TableClass = 'GLOBAL' | 'TENANT_RLS' | 'PLATFORM_AUDIT' | 'POLICE_ISOLATED';

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
    | 'tenant_column_not_tenant_rls'
    | 'tenant_rls_not_forced'
    | 'unauthorised_audit_grant'
    | 'runtime_role_owns_object';
  readonly detail: string;
}
