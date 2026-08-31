/**
 * The canonical schema snapshot.
 *
 * `schema.ts` states everything Drizzle 0.45.2 can state faithfully — tables,
 * columns, types, nullability, defaults, identity, generated state, simple,
 * composite and unique keys, foreign keys with their referential action, check
 * constraints, and ordinary, unique and partial indexes — and
 * `schema-projection.ts` compares all of it against this file.
 *
 * What is left here is what the DSL genuinely cannot express, each with its
 * reason:
 *
 *  - **Row Level Security, policies and `FORCE ROW LEVEL SECURITY`** — no DSL
 *    form at all.
 *  - **Grants and default privileges** — Drizzle models schema shape, not ACLs.
 *  - **Triggers and their functions** — declared in SQL and owned by named
 *    roles; Drizzle has no trigger form.
 *  - **Partitioning** — `PARTITION BY`, partition bounds and the `ON ONLY`
 *    indexes a partitioned parent carries have no DSL form, so the audit
 *    parents' own keys are compared here and against the live catalogue.
 *  - **Exclusion constraints** — no DSL form in 0.45.2.
 *
 * Anything on that list is also covered by the normalized `pg_dump` comparison
 * and by the live-catalogue half of the comparator, so it is declared twice,
 * never left to whatever the database happens to hold.
 *
 * Regenerated deliberately, never automatically: an "update the snapshot to
 * match" step would make the comparator agree with any change, which is the
 * opposite of what it is for. A migration that alters schema shape should
 * change this file in the same commit, and a reviewer should be able to read
 * the diff as the schema change it is.
 */
export interface ColumnSnapshot {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  /** `type | NULL|NOT NULL | default … | identity … | generated …` */
  readonly shape: string;
}

export interface ConstraintSnapshot {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  /** `p` primary key, `f` foreign key, `u` unique, `c` check, `x` exclusion. */
  readonly kind: string;
  readonly definition: string;
}

export interface IndexSnapshot {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

/** An identity column's backing sequence, as PostgreSQL stores it. */
export interface IdentitySequenceSnapshot {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly sequenceSchema: string;
  readonly sequence: string;
  /** `start … increment … min … max … cache … cycle` */
  readonly shape: string;
}

/** Row level security enablement, per table. */
export interface RlsSnapshot {
  readonly schema: string;
  readonly table: string;
  readonly enabled: boolean;
  /** SQL-only: Drizzle 0.45.2 has no `FORCE ROW LEVEL SECURITY` form. */
  readonly forced: boolean;
}

/**
 * A policy in parts, never as one rendered sentence.
 *
 * The target list stays a list: one role named `a, b` and the two roles `a` and
 * `b` grant different things and joined to the same text.
 */
export interface PolicySnapshot {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  /** `PERMISSIVE` or `RESTRICTIVE`. */
  readonly as: string;
  /** `ALL`, `SELECT`, `INSERT`, `UPDATE` or `DELETE`. */
  readonly command: string;
  /** Exact role names, in the order PostgreSQL reports them. */
  readonly to: readonly string[];
  readonly using: string | null;
  readonly withCheck: string | null;
}

/**
 * A PostgreSQL enum type and its labels, in the order PostgreSQL sorts by.
 *
 * Persistent and catalogue-visible: the labels decide which values a column of
 * the type accepts, and their order decides how it sorts. Classifying Drizzle's
 * `enumValues` as a non-persistent hint was right for `text({ enum })` and wrong
 * for `pgEnum`, so the two are now told apart and this half is compared.
 */
export interface EnumSnapshot {
  readonly schema: string;
  readonly name: string;
  /**
   * Labels in `enumsortorder`, as a list.
   *
   * Joined text was lossy: a label may contain any character, so `['a, b']` and
   * `['a', 'b']` — different types — rendered identically.
   */
  readonly labels: readonly string[];
}

export interface SchemaSnapshot {
  readonly columns: readonly ColumnSnapshot[];
  readonly constraints: readonly ConstraintSnapshot[];
  readonly indexes: readonly IndexSnapshot[];
  readonly identitySequences: readonly IdentitySequenceSnapshot[];
  readonly rls: readonly RlsSnapshot[];
  readonly policies: readonly PolicySnapshot[];
  readonly enums: readonly EnumSnapshot[];
}

export const EXPECTED_SCHEMA_SNAPSHOT: SchemaSnapshot = {
  columns: [
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'action',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'actor_ref',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'causation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'correlation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'event_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'hotel_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'occurred_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'outcome',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'payload',
      shape: "jsonb | NOT NULL | default '{}'::jsonb | no identity | not generated",
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'realm',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'target_ref',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      column: 'target_type',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      column: 'account_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      column: 'credential_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      column: 'kind',
      shape: "text | NOT NULL | default 'password'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'account_credential',
      column: 'params_version',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      column: 'revision',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      column: 'secret_hash',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      column: 'updated_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      column: 'account_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      column: 'granted_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      column: 'granted_by_account_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      column: 'permission',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      column: 'permission_grant_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      column: 'realm',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      column: 'realm_role',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      column: 'revoked_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      column: 'revoked_by_account_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      column: 'revoked_reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      column: 'as_of',
      shape: 'timestamp with time zone | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      column: 'content_hash',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      column: 'expires_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      column: 'export_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      column: 'export_kind',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      column: 'job_run_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      column: 'row_count',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      column: 'storage_key',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'external_gate',
      column: 'blocker',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'external_gate',
      column: 'description',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'external_gate',
      column: 'enabled',
      shape: 'boolean | NOT NULL | default false | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'external_gate',
      column: 'gate_code',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'external_gate',
      column: 'updated_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'feature_flag',
      column: 'description',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'feature_flag',
      column: 'enabled',
      shape: 'boolean | NOT NULL | default false | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'feature_flag',
      column: 'flag_key',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'feature_flag',
      column: 'updated_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'hotel',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'hotel',
      column: 'display_name',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'hotel',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'hotel',
      column: 'revision',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'hotel',
      column: 'state',
      shape: "text | NOT NULL | default 'ACTIVE'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'hotel',
      column: 'timezone',
      shape: "text | NOT NULL | default 'Asia/Ulaanbaatar'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'actor_ref',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'client_ref',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'completed_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'correlation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'expires_at',
      shape: 'timestamp with time zone | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'idempotency_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'idempotency_key',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'operation',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'realm',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'request_hash',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'response_body',
      shape: 'jsonb | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'response_status',
      shape: 'integer | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      column: 'state',
      shape: "text | NOT NULL | default 'in_progress'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      column: 'consumer',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      column: 'consumption_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      column: 'dedup_key',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      column: 'first_consumed_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      column: 'source',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'internal_gate',
      column: 'blocker',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'internal_gate',
      column: 'control_code',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'internal_gate',
      column: 'description',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'internal_gate',
      column: 'enabled',
      shape: 'boolean | NOT NULL | default false | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'internal_gate',
      column: 'updated_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'invitation_requested_role',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'invitation_requested_role',
      column: 'invitation_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'invitation_requested_role',
      column: 'role',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'job_run',
      column: 'as_of',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'job_run',
      column: 'error_name',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'job_run',
      column: 'finished_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'job_run',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'job_run',
      column: 'issuer_ref',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'job_run',
      column: 'job_identity',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'job_run',
      column: 'job_name',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'job_run',
      column: 'job_run_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'job_run',
      column: 'scope',
      shape: "jsonb | NOT NULL | default '{}'::jsonb | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'job_run',
      column: 'started_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'job_run',
      column: 'state',
      shape: "text | NOT NULL | default 'running'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      column: 'granted_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      column: 'granted_by_account_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      column: 'membership_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      column: 'revoked_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      column: 'revoked_by_account_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      column: 'revoked_reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      column: 'role',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      column: 'role_grant_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'operational_alert',
      column: 'alert_code',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'operational_alert',
      column: 'alert_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'operational_alert',
      column: 'detail',
      shape: "jsonb | NOT NULL | default '{}'::jsonb | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'operational_alert',
      column: 'raised_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'operational_alert',
      column: 'resolved_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'operational_alert',
      column: 'severity',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      column: 'attempts',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      column: 'available_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      column: 'claimed_by',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      column: 'claimed_until',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      column: 'event_id',
      shape: 'bigint | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      column: 'last_error',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      column: 'published_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      column: 'revision',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      column: 'state',
      shape: "text | NOT NULL | default 'pending'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'aggregate_id',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'aggregate_type',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'causation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'correlation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'event_id',
      shape: 'bigint | NOT NULL | no default | identity a | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'event_type',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'event_uuid',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'event_version',
      shape: 'integer | NOT NULL | default 1 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'occurred_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'payload',
      shape: 'jsonb | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'attempts',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'claim_token',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'email_normalized',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'initiated_by',
      shape: "text | NOT NULL | default 'self'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'initiated_by_account_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'intake_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'last_error',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'lease_expires_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'next_attempt_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'outcome',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'processed_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'requested_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      column: 'state',
      shape: "text | NOT NULL | default 'PENDING'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'account_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'delivered_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'delivery_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'expires_at',
      shape: 'timestamp with time zone | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'initiated_by',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'initiated_by_account_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'reset_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'secret_ciphertext',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'secret_key_version',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'secret_wrapped_dek',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'state',
      shape: "text | NOT NULL | default 'ACTIVE'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'terminal_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'terminal_reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'token_hash',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      column: 'token_key_version',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'projection_checkpoint',
      column: 'as_of',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'projection_checkpoint',
      column: 'last_event_id',
      shape: 'bigint | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'projection_checkpoint',
      column: 'projection',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'projection_checkpoint',
      column: 'revision',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'projection_checkpoint',
      column: 'status',
      shape: "text | NOT NULL | default 'idle'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'projection_checkpoint',
      column: 'updated_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      column: 'event_kind',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      column: 'metadata',
      shape: "jsonb | NOT NULL | default '{}'::jsonb | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'provider_event',
      column: 'payload_hash',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      column: 'provider',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      column: 'provider_event_id',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      column: 'provider_event_row_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      column: 'received_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'absolute_expires_at',
      shape: 'timestamp with time zone | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'account_epoch',
      shape: 'integer | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'account_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'idle_expires_at',
      shape: 'timestamp with time zone | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'issued_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'last_seen_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'realm',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'revision',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'revoked_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'revoked_reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'session_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'step_up_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'token_hash',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'server_session',
      column: 'token_key_version',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      column: 'account_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      column: 'granted_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      column: 'membership_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      column: 'membership_revision',
      shape: 'integer | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      column: 'realm',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      column: 'revoked_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      column: 'revoked_reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      column: 'scope_grant_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      column: 'session_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'created_by_account_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'email_normalized',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'expires_at',
      shape: 'timestamp with time zone | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'invitation_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'membership_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'state',
      shape: "text | NOT NULL | default 'ACTIVE'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'superseded_by_invitation_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'terminal_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'terminal_reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'token_hash',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      column: 'token_key_version',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'account_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'activated_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'created_by_account_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'invited_email_normalized',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'is_primary_admin',
      shape: 'boolean | NOT NULL | default false | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'membership_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'membership_revision',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'restaurant_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'state',
      shape: "text | NOT NULL | default 'PENDING'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'state_changed_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      column: 'state_reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'user_account',
      column: 'account_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'user_account',
      column: 'auth_epoch',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'user_account',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'user_account',
      column: 'email_normalized',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'user_account',
      column: 'email_verified_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'user_account',
      column: 'police_scope_ref',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'user_account',
      column: 'realm',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'user_account',
      column: 'realm_role',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'user_account',
      column: 'revision',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'user_account',
      column: 'state',
      shape: "text | NOT NULL | default 'ACTIVE'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'attempts',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'discovery_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'expected_state',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'idempotency_seed',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'last_error',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'membership_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'membership_revision',
      shape: 'integer | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'opened_reason',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'settled_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'settled_reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'state',
      shape: "text | NOT NULL | default 'PENDING'::text | no identity | not generated",
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      column: 'updated_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      column: 'actor_membership_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      column: 'event_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      column: 'idempotency_key',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      column: 'item_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      column: 'kind',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      column: 'new_assignee_membership_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      column: 'occurred_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      column: 'previous_assignee_membership_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      column: 'reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      column: 'seq',
      shape: 'integer | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'assignee_membership_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'assignment_version',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'claimant_membership_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'continuation_of_item_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'item_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'movement_started',
      shape: 'boolean | NOT NULL | default false | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'opened_reason',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'previous_actor_membership_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'resolved_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'restaurant_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'state',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'subject_kind',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      column: 'subject_ref',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      column: 'action',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      column: 'actor_ref',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      column: 'case_ref',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      column: 'correlation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      column: 'event_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      column: 'occurred_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      column: 'outcome',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      column: 'payload',
      shape: "jsonb | NOT NULL | default '{}'::jsonb | no identity | not generated",
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      column: 'reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
  ],
  constraints: [
    {
      schema: 'audit',
      table: 'platform_event',
      name: 'platform_event_outcome_known',
      kind: 'c',
      definition:
        "CHECK ((outcome = ANY (ARRAY['allowed'::text, 'denied'::text, 'failed'::text])))",
    },
    {
      schema: 'audit',
      table: 'platform_event',
      name: 'platform_event_payload_sanitised',
      kind: 'c',
      definition: 'CHECK ((NOT platform.contains_denied_key(payload)))',
    },
    {
      schema: 'audit',
      table: 'platform_event',
      name: 'platform_event_pk',
      kind: 'p',
      definition: 'PRIMARY KEY (occurred_at, event_id)',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      name: 'account_credential_account_id_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (account_id) REFERENCES platform.user_account(account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      name: 'account_credential_kind_known',
      kind: 'c',
      definition: "CHECK ((kind = 'password'::text))",
    },
    {
      schema: 'platform',
      table: 'account_credential',
      name: 'account_credential_one_per_kind',
      kind: 'u',
      definition: 'UNIQUE (account_id, kind)',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      name: 'account_credential_params_shape',
      kind: 'c',
      definition: "CHECK ((params_version ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))",
    },
    {
      schema: 'platform',
      table: 'account_credential',
      name: 'account_credential_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (credential_id)',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      name: 'account_credential_revision_non_negative',
      kind: 'c',
      definition: 'CHECK ((revision >= 0))',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      name: 'account_credential_secret_is_derived',
      kind: 'c',
      definition:
        "CHECK ((secret_hash ~ '^scrypt\\$v=[0-9]+\\$n=[0-9]+,r=[0-9]+,p=[0-9]+\\$[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+$'::text))",
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      name: 'account_permission_grant_grantable',
      kind: 'c',
      definition:
        "CHECK (\nCASE realm_role\n    WHEN 'OPERATION_ADMIN'::text THEN (permission = ANY (ARRAY['DEPOSIT_REFUND_RECONCILE'::text, 'ONBOARDING_PROVISION_RETRY'::text, 'OPERATION_READ'::text, 'REVIEW_MODERATE'::text, 'SUBSCRIPTION_EBARIMT_RETRY'::text, 'SUBSCRIPTION_PASSWORD_RESET_INITIATE'::text, 'SUBSCRIPTION_PAYMENT_RECONCILE'::text, 'SUBSCRIPTION_REMINDER_SEND'::text]))\n    WHEN 'PLATFORM_SUPER_ADMIN'::text THEN (permission = ANY (ARRAY['ACCOUNT_OWNERSHIP_RECOVERY_APPROVE'::text, 'DEPOSIT_REFUND_RECONCILE'::text, 'ONBOARDING_PROVISION_RETRY'::text, 'OPERATION_READ'::text, 'PLATFORM_OPERATION_ACCESS_MANAGE'::text, 'REVIEW_MODERATE'::text, 'SUBSCRIPTION_CONTACT_CHANGE_APPROVE'::text, 'SUBSCRIPTION_EBARIMT_RETRY'::text, 'SUBSCRIPTION_PASSWORD_RESET_INITIATE'::text, 'SUBSCRIPTION_PAYMENT_RECONCILE'::text, 'SUBSCRIPTION_REMINDER_SEND'::text, 'SUBSCRIPTION_SUSPEND'::text]))\n    WHEN 'POLICE_OFFICER'::text THEN (permission = ANY (ARRAY['FALSE_MATCH_APPROVE'::text, 'FOUND_CORRECTION_APPROVE'::text, 'WANTED_CASE_STATE_MANAGE'::text, 'WANTED_IDENTITY_APPROVE'::text]))\n    WHEN 'POLICE_ADMIN'::text THEN (permission = ANY (ARRAY['FALSE_MATCH_APPROVE'::text, 'FOUND_CORRECTION_APPROVE'::text, 'WANTED_CASE_CREATE'::text, 'WANTED_CASE_EXPORT'::text, 'WANTED_CASE_STATE_MANAGE'::text, 'WANTED_IDENTITY_APPROVE'::text]))\n    ELSE false\nEND)",
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      name: 'account_permission_grant_granted_by_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (granted_by_account_id) REFERENCES platform.user_account(account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      name: 'account_permission_grant_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (permission_grant_id)',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      name: 'account_permission_grant_principal_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (account_id, realm, realm_role) REFERENCES platform.user_account(account_id, realm, realm_role) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      name: 'account_permission_grant_revocation_complete',
      kind: 'c',
      definition: 'CHECK (((revoked_at IS NULL) = (revoked_by_account_id IS NULL)))',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      name: 'account_permission_grant_revoked_by_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (revoked_by_account_id) REFERENCES platform.user_account(account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      name: 'export_artifact_hash_shape',
      kind: 'c',
      definition: "CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text))",
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      name: 'export_artifact_job_run_id_fkey',
      kind: 'f',
      definition: 'FOREIGN KEY (job_run_id) REFERENCES platform.job_run(job_run_id)',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      name: 'export_artifact_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (export_id)',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      name: 'export_artifact_rows_non_negative',
      kind: 'c',
      definition: 'CHECK ((row_count >= 0))',
    },
    {
      schema: 'platform',
      table: 'external_gate',
      name: 'external_gate_code_shape',
      kind: 'c',
      definition: "CHECK ((gate_code ~ '^EXT-\\d{2}$'::text))",
    },
    {
      schema: 'platform',
      table: 'external_gate',
      name: 'external_gate_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (gate_code)',
    },
    {
      schema: 'platform',
      table: 'feature_flag',
      name: 'feature_flag_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (flag_key)',
    },
    {
      schema: 'platform',
      table: 'hotel',
      name: 'hotel_display_name_bounded',
      kind: 'c',
      definition: 'CHECK (((length(display_name) >= 1) AND (length(display_name) <= 200)))',
    },
    {
      schema: 'platform',
      table: 'hotel',
      name: 'hotel_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (hotel_id)',
    },
    {
      schema: 'platform',
      table: 'hotel',
      name: 'hotel_revision_non_negative',
      kind: 'c',
      definition: 'CHECK ((revision >= 0))',
    },
    {
      schema: 'platform',
      table: 'hotel',
      name: 'hotel_state_known',
      kind: 'c',
      definition: "CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text])))",
    },
    {
      schema: 'platform',
      table: 'hotel',
      name: 'hotel_timezone_known',
      kind: 'c',
      definition: "CHECK ((timezone = 'Asia/Ulaanbaatar'::text))",
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      name: 'idempotency_key_not_blank',
      kind: 'c',
      definition: 'CHECK (((length(idempotency_key) >= 8) AND (length(idempotency_key) <= 200)))',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      name: 'idempotency_key_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (idempotency_id)',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      name: 'idempotency_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['in_progress'::text, 'succeeded'::text, 'failed'::text])))",
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      name: 'idempotency_terminal_has_response',
      kind: 'c',
      definition:
        "CHECK ((((state = 'in_progress'::text) AND (response_status IS NULL) AND (completed_at IS NULL)) OR ((state <> 'in_progress'::text) AND (response_status IS NOT NULL) AND (completed_at IS NOT NULL))))",
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      name: 'inbox_consumption_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (consumption_id)',
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      name: 'inbox_consumption_uq',
      kind: 'u',
      definition: 'UNIQUE (consumer, dedup_key)',
    },
    {
      schema: 'platform',
      table: 'internal_gate',
      name: 'internal_gate_code_shape',
      kind: 'c',
      definition: "CHECK ((control_code ~ '^INT-[A-Z]{2,8}-\\d{2}$'::text))",
    },
    {
      schema: 'platform',
      table: 'internal_gate',
      name: 'internal_gate_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (control_code)',
    },
    {
      schema: 'platform',
      table: 'invitation_requested_role',
      name: 'invitation_requested_role_invitation_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (hotel_id, invitation_id) REFERENCES platform.staff_invitation(hotel_id, invitation_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'invitation_requested_role',
      name: 'invitation_requested_role_known',
      kind: 'c',
      definition:
        "CHECK ((role = ANY (ARRAY['HOTEL_ADMIN'::text, 'MANAGER'::text, 'MANAGER_PLUS'::text, 'RECEPTION'::text, 'CLEANER'::text, 'RESTAURANT_MANAGER'::text])))",
    },
    {
      schema: 'platform',
      table: 'invitation_requested_role',
      name: 'invitation_requested_role_pk',
      kind: 'p',
      definition: 'PRIMARY KEY (hotel_id, invitation_id, role)',
    },
    {
      schema: 'platform',
      table: 'job_run',
      name: 'job_run_error_name_bounded',
      kind: 'c',
      definition:
        'CHECK (((error_name IS NULL) OR ((length(error_name) >= 1) AND (length(error_name) <= 128))))',
    },
    {
      schema: 'platform',
      table: 'job_run',
      name: 'job_run_identity_shape',
      kind: 'c',
      definition: "CHECK ((job_identity ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'::text))",
    },
    {
      schema: 'platform',
      table: 'job_run',
      name: 'job_run_issuer_shape',
      kind: 'c',
      definition:
        "CHECK (((issuer_ref IS NULL) OR (issuer_ref ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'::text)))",
    },
    {
      schema: 'platform',
      table: 'job_run',
      name: 'job_run_job_name_shape',
      kind: 'c',
      definition: "CHECK ((job_name ~ '^[a-z][a-z0-9_.]{2,127}$'::text))",
    },
    {
      schema: 'platform',
      table: 'job_run',
      name: 'job_run_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (job_run_id)',
    },
    {
      schema: 'platform',
      table: 'job_run',
      name: 'job_run_privileged_has_issuer',
      kind: 'c',
      definition:
        "CHECK (((job_name !~~ 'platform.maintenance.%'::text) OR (issuer_ref IS NOT NULL)))",
    },
    {
      schema: 'platform',
      table: 'job_run',
      name: 'job_run_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))",
    },
    {
      schema: 'platform',
      table: 'job_run',
      name: 'job_run_terminal_has_finish',
      kind: 'c',
      definition: "CHECK (((state = 'running'::text) = (finished_at IS NULL)))",
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      name: 'membership_role_grant_granted_by_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (granted_by_account_id) REFERENCES platform.user_account(account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      name: 'membership_role_grant_membership_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (hotel_id, membership_id) REFERENCES platform.staff_membership(hotel_id, membership_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      name: 'membership_role_grant_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (role_grant_id)',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      name: 'membership_role_grant_revocation_complete',
      kind: 'c',
      definition: 'CHECK (((revoked_at IS NULL) = (revoked_by_account_id IS NULL)))',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      name: 'membership_role_grant_revoked_by_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (revoked_by_account_id) REFERENCES platform.user_account(account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      name: 'membership_role_grant_role_known',
      kind: 'c',
      definition:
        "CHECK ((role = ANY (ARRAY['HOTEL_ADMIN'::text, 'MANAGER'::text, 'MANAGER_PLUS'::text, 'RECEPTION'::text, 'CLEANER'::text, 'RESTAURANT_MANAGER'::text])))",
    },
    {
      schema: 'platform',
      table: 'operational_alert',
      name: 'operational_alert_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (alert_id)',
    },
    {
      schema: 'platform',
      table: 'operational_alert',
      name: 'operational_alert_severity_known',
      kind: 'c',
      definition:
        "CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])))",
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      name: 'outbox_delivery_attempts_non_negative',
      kind: 'c',
      definition: 'CHECK ((attempts >= 0))',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      name: 'outbox_delivery_event_id_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (event_id) REFERENCES platform.outbox_event(event_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      name: 'outbox_delivery_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (event_id)',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      name: 'outbox_delivery_published_has_time',
      kind: 'c',
      definition: "CHECK (((state = 'published'::text) = (published_at IS NOT NULL)))",
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      name: 'outbox_delivery_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['pending'::text, 'claimed'::text, 'published'::text, 'failed'::text])))",
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      name: 'outbox_event_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (event_id)',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      name: 'outbox_event_uuid_uq',
      kind: 'u',
      definition: 'UNIQUE (event_uuid)',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      name: 'outbox_event_version_positive',
      kind: 'c',
      definition: 'CHECK ((event_version >= 1))',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      name: 'outbox_payload_sanitised',
      kind: 'c',
      definition: 'CHECK ((NOT platform.contains_denied_key(payload)))',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_attempts_non_negative',
      kind: 'c',
      definition: 'CHECK ((attempts >= 0))',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_claim_is_leased',
      kind: 'c',
      definition: "CHECK (((state = 'CLAIMED'::text) = (claim_token IS NOT NULL)))",
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_email_normalised',
      kind: 'c',
      definition: 'CHECK ((email_normalized = lower(email_normalized)))',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_initiator_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (initiated_by_account_id) REFERENCES platform.user_account(account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_initiator_known',
      kind: 'c',
      definition: "CHECK ((initiated_by = ANY (ARRAY['self'::text, 'hotel_admin'::text])))",
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_initiator_recorded',
      kind: 'c',
      definition: "CHECK (((initiated_by = 'self'::text) = (initiated_by_account_id IS NULL)))",
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_lease_paired',
      kind: 'c',
      definition: 'CHECK (((claim_token IS NULL) = (lease_expires_at IS NULL)))',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_outcome_known',
      kind: 'c',
      definition:
        "CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['sent'::text, 'ignored'::text, 'throttled'::text, 'unavailable'::text, 'dead_letter'::text]))))",
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (intake_id)',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_processed_has_time',
      kind: 'c',
      definition:
        "CHECK (((state = ANY (ARRAY['PROCESSED'::text, 'DEAD_LETTER'::text])) = (processed_at IS NOT NULL)))",
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text, 'PROCESSED'::text, 'DEAD_LETTER'::text])))",
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_account_id_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (account_id) REFERENCES platform.user_account(account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_delivery_uq',
      kind: 'u',
      definition: 'UNIQUE (delivery_id)',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_expiry_after_creation',
      kind: 'c',
      definition: 'CHECK ((expires_at > created_at))',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_initiator_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (initiated_by_account_id) REFERENCES platform.user_account(account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_initiator_known',
      kind: 'c',
      definition: "CHECK ((initiated_by = ANY (ARRAY['self'::text, 'hotel_admin'::text])))",
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_initiator_recorded',
      kind: 'c',
      definition: "CHECK (((initiated_by = 'self'::text) = (initiated_by_account_id IS NULL)))",
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (reset_id)',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_secret_complete',
      kind: 'c',
      definition:
        'CHECK ((num_nonnulls(secret_ciphertext, secret_wrapped_dek, secret_key_version) = ANY (ARRAY[0, 3])))',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'USED'::text, 'SUPERSEDED'::text, 'EXPIRED'::text, 'REVOKED'::text])))",
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_terminal_has_time',
      kind: 'c',
      definition: "CHECK (((state = 'ACTIVE'::text) = (terminal_at IS NULL)))",
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_token_shape',
      kind: 'c',
      definition: "CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))",
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_token_uq',
      kind: 'u',
      definition: 'UNIQUE (token_hash)',
    },
    {
      schema: 'platform',
      table: 'projection_checkpoint',
      name: 'projection_checkpoint_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (projection)',
    },
    {
      schema: 'platform',
      table: 'projection_checkpoint',
      name: 'projection_last_event_non_negative',
      kind: 'c',
      definition: 'CHECK ((last_event_id >= 0))',
    },
    {
      schema: 'platform',
      table: 'projection_checkpoint',
      name: 'projection_status_known',
      kind: 'c',
      definition:
        "CHECK ((status = ANY (ARRAY['idle'::text, 'running'::text, 'rebuilding'::text, 'failed'::text])))",
    },
    {
      schema: 'platform',
      table: 'provider_event',
      name: 'provider_event_hash_shape',
      kind: 'c',
      definition: "CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text))",
    },
    {
      schema: 'platform',
      table: 'provider_event',
      name: 'provider_event_metadata_sanitised',
      kind: 'c',
      definition: 'CHECK ((NOT platform.contains_denied_key(metadata)))',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      name: 'provider_event_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (provider_event_row_id)',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      name: 'provider_event_uq',
      kind: 'u',
      definition: 'UNIQUE (provider, provider_event_id)',
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_account_realm_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (account_id, realm) REFERENCES platform.user_account(account_id, realm) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_epoch_non_negative',
      kind: 'c',
      definition: 'CHECK ((account_epoch >= 0))',
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_expiry_ordered',
      kind: 'c',
      definition: 'CHECK ((idle_expires_at <= absolute_expires_at))',
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (session_id)',
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_realm_known',
      kind: 'c',
      definition: "CHECK ((realm = ANY (ARRAY['hotel'::text, 'operation'::text, 'police'::text])))",
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_identity_uq',
      kind: 'u',
      definition: 'UNIQUE (session_id, account_id, realm)',
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_revision_non_negative',
      kind: 'c',
      definition: 'CHECK ((revision >= 0))',
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_revoked_has_reason',
      kind: 'c',
      definition: 'CHECK (((revoked_at IS NULL) = (revoked_reason IS NULL)))',
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_token_shape',
      kind: 'c',
      definition: "CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))",
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_token_uq',
      kind: 'u',
      definition: 'UNIQUE (token_hash)',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      name: 'session_scope_grant_membership_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (hotel_id, membership_id, account_id) REFERENCES platform.staff_membership(hotel_id, membership_id, account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      name: 'session_scope_grant_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (scope_grant_id)',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      name: 'session_scope_grant_realm_is_hotel',
      kind: 'c',
      definition: "CHECK ((realm = 'hotel'::text))",
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      name: 'session_scope_grant_revision_non_negative',
      kind: 'c',
      definition: 'CHECK ((membership_revision >= 0))',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      name: 'session_scope_grant_revoked_has_reason',
      kind: 'c',
      definition: 'CHECK (((revoked_at IS NULL) = (revoked_reason IS NULL)))',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      name: 'session_scope_grant_session_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (session_id, account_id, realm) REFERENCES platform.server_session(session_id, account_id, realm) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_created_by_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (created_by_account_id) REFERENCES platform.user_account(account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_email_normalised',
      kind: 'c',
      definition: 'CHECK ((email_normalized = lower(email_normalized)))',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_expiry_after_creation',
      kind: 'c',
      definition: 'CHECK ((expires_at > created_at))',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_membership_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (hotel_id, membership_id) REFERENCES platform.staff_membership(hotel_id, membership_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (invitation_id)',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_scope_uq',
      kind: 'u',
      definition: 'UNIQUE (hotel_id, invitation_id)',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'ACCEPTED'::text, 'SUPERSEDED'::text, 'EXPIRED'::text, 'REVOKED'::text])))",
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_superseded_by_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (superseded_by_invitation_id) REFERENCES platform.staff_invitation(invitation_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_terminal_has_time',
      kind: 'c',
      definition: "CHECK (((state = 'ACTIVE'::text) = (terminal_at IS NULL)))",
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_token_shape',
      kind: 'c',
      definition: "CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))",
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_token_uq',
      kind: 'u',
      definition: 'UNIQUE (token_hash)',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_account_id_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (account_id) REFERENCES platform.user_account(account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_account_scope_uq',
      kind: 'u',
      definition: 'UNIQUE (hotel_id, membership_id, account_id)',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_active_has_account',
      kind: 'c',
      definition: "CHECK (((state = 'PENDING'::text) OR (account_id IS NOT NULL)))",
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_created_by_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (created_by_account_id) REFERENCES platform.user_account(account_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_email_normalised',
      kind: 'c',
      definition: 'CHECK ((invited_email_normalized = lower(invited_email_normalized)))',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_hotel_id_fkey',
      kind: 'f',
      definition: 'FOREIGN KEY (hotel_id) REFERENCES platform.hotel(hotel_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (membership_id)',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_primary_is_active',
      kind: 'c',
      definition: "CHECK (((NOT is_primary_admin) OR (state = 'ACTIVE'::text)))",
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_primary_is_hotel_scope',
      kind: 'c',
      definition: 'CHECK (((NOT is_primary_admin) OR (restaurant_id IS NULL)))',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_revision_non_negative',
      kind: 'c',
      definition: 'CHECK ((membership_revision >= 0))',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_scope_uq',
      kind: 'u',
      definition: 'UNIQUE (hotel_id, membership_id)',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['PENDING'::text, 'ACTIVE'::text, 'SUSPENDED'::text, 'TERMINATED'::text])))",
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_auth_epoch_non_negative',
      kind: 'c',
      definition: 'CHECK ((auth_epoch >= 0))',
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_email_normalised',
      kind: 'c',
      definition: 'CHECK ((email_normalized = lower(email_normalized)))',
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_email_shape',
      kind: 'c',
      definition:
        "CHECK ((email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'::text))",
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (account_id)',
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_police_scope_is_police',
      kind: 'c',
      definition: "CHECK (((police_scope_ref IS NULL) OR (realm = 'police'::text)))",
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_principal_uq',
      kind: 'u',
      definition: 'UNIQUE (account_id, realm, realm_role)',
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_realm_email_uq',
      kind: 'u',
      definition: 'UNIQUE (realm, email_normalized)',
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_realm_identity_uq',
      kind: 'u',
      definition: 'UNIQUE (account_id, realm)',
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_realm_known',
      kind: 'c',
      definition: "CHECK ((realm = ANY (ARRAY['hotel'::text, 'operation'::text, 'police'::text])))",
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_realm_role_matches_realm',
      kind: 'c',
      definition:
        "CHECK (\nCASE realm\n    WHEN 'operation'::text THEN (realm_role = ANY (ARRAY['OPERATION_ADMIN'::text, 'PLATFORM_SUPER_ADMIN'::text]))\n    WHEN 'police'::text THEN (realm_role = ANY (ARRAY['POLICE_OFFICER'::text, 'POLICE_ADMIN'::text]))\n    ELSE (realm_role IS NULL)\nEND)",
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_revision_non_negative',
      kind: 'c',
      definition: 'CHECK ((revision >= 0))',
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text, 'DISABLED'::text])))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_attempts_non_negative',
      kind: 'c',
      definition: 'CHECK ((attempts >= 0))',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_expected_state_known',
      kind: 'c',
      definition: "CHECK ((expected_state = ANY (ARRAY['SUSPENDED'::text, 'TERMINATED'::text])))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_membership_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (hotel_id, membership_id) REFERENCES platform.staff_membership(hotel_id, membership_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (discovery_id)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_reason_known',
      kind: 'c',
      definition: "CHECK ((opened_reason = ANY (ARRAY['suspension'::text, 'termination'::text])))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_reason_matches_state',
      kind: 'c',
      definition:
        "CHECK ((((opened_reason = 'suspension'::text) AND (expected_state = 'SUSPENDED'::text)) OR ((opened_reason = 'termination'::text) AND (expected_state = 'TERMINATED'::text))))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_revision_non_negative',
      kind: 'c',
      definition: 'CHECK ((membership_revision >= 0))',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_scope_uq',
      kind: 'u',
      definition: 'UNIQUE (hotel_id, discovery_id)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_seed_shape',
      kind: 'c',
      definition: 'CHECK (((length(idempotency_seed) >= 8) AND (length(idempotency_seed) <= 200)))',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_settled_has_time',
      kind: 'c',
      definition: "CHECK (((state <> 'PENDING'::text) = (settled_at IS NOT NULL)))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['PENDING'::text, 'COMPLETED'::text, 'SUPERSEDED'::text])))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      name: 'work_handoff_event_actor_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (hotel_id, actor_membership_id) REFERENCES platform.staff_membership(hotel_id, membership_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      name: 'work_handoff_event_idempotency_shape',
      kind: 'c',
      definition: 'CHECK (((length(idempotency_key) >= 8) AND (length(idempotency_key) <= 200)))',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      name: 'work_handoff_event_idempotency_uq',
      kind: 'u',
      definition: 'UNIQUE (hotel_id, item_id, idempotency_key)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      name: 'work_handoff_event_item_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (hotel_id, item_id) REFERENCES platform.work_handoff_item(hotel_id, item_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      name: 'work_handoff_event_kind_known',
      kind: 'c',
      definition:
        "CHECK ((kind = ANY (ARRAY['opened'::text, 'claimed'::text, 'released'::text, 'assigned'::text, 'resolved'::text, 'unassigned'::text, 'continuation_created'::text])))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      name: 'work_handoff_event_pk',
      kind: 'p',
      definition: 'PRIMARY KEY (hotel_id, item_id, seq)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      name: 'work_handoff_event_seq_positive',
      kind: 'c',
      definition: 'CHECK ((seq >= 1))',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_assigned_has_both',
      kind: 'c',
      definition:
        "CHECK (((state <> 'ASSIGNED'::text) OR ((claimant_membership_id IS NOT NULL) AND (assignee_membership_id IS NOT NULL))))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_assignee_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (hotel_id, assignee_membership_id) REFERENCES platform.staff_membership(hotel_id, membership_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_claimant_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (hotel_id, claimant_membership_id) REFERENCES platform.staff_membership(hotel_id, membership_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_claimed_has_claimant',
      kind: 'c',
      definition: "CHECK (((state <> 'CLAIMED'::text) OR (claimant_membership_id IS NOT NULL)))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_continuation_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (continuation_of_item_id) REFERENCES platform.work_handoff_item(item_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_continuation_is_cleaner',
      kind: 'c',
      definition:
        "CHECK (((continuation_of_item_id IS NULL) OR (subject_kind = 'cleaner_task'::text)))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_open_has_no_actor',
      kind: 'c',
      definition:
        "CHECK (((state <> ALL (ARRAY['TAKEOVER_REQUIRED'::text, 'REASSIGNMENT_REQUIRED'::text, 'UNASSIGNED_REQUIRES_ACTION'::text])) OR ((claimant_membership_id IS NULL) AND (assignee_membership_id IS NULL))))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (item_id)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_previous_actor_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (hotel_id, previous_actor_membership_id) REFERENCES platform.staff_membership(hotel_id, membership_id) ON DELETE RESTRICT',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_reason_known',
      kind: 'c',
      definition: "CHECK ((opened_reason = ANY (ARRAY['suspension'::text, 'termination'::text])))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_resolved_has_time',
      kind: 'c',
      definition: "CHECK (((state = 'RESOLVED'::text) = (resolved_at IS NOT NULL)))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_restaurant_scope',
      kind: 'c',
      definition:
        "CHECK (((subject_kind = 'restaurant_order'::text) = (restaurant_id IS NOT NULL)))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_scope_uq',
      kind: 'u',
      definition: 'UNIQUE (hotel_id, item_id)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['TAKEOVER_REQUIRED'::text, 'REASSIGNMENT_REQUIRED'::text, 'CLAIMED'::text, 'ASSIGNED'::text, 'RESOLVED'::text, 'UNASSIGNED_REQUIRES_ACTION'::text])))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_subject_known',
      kind: 'c',
      definition:
        "CHECK ((subject_kind = ANY (ARRAY['reception_shift'::text, 'cleaner_task'::text, 'restaurant_order'::text])))",
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_version_non_negative',
      kind: 'c',
      definition: 'CHECK ((assignment_version >= 0))',
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      name: 'security_event_outcome_known',
      kind: 'c',
      definition:
        "CHECK ((outcome = ANY (ARRAY['allowed'::text, 'denied'::text, 'failed'::text])))",
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      name: 'security_event_payload_sanitised',
      kind: 'c',
      definition: 'CHECK ((NOT platform.contains_denied_key(payload)))',
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      name: 'security_event_pk',
      kind: 'p',
      definition: 'PRIMARY KEY (occurred_at, event_id)',
    },
  ],
  indexes: [
    {
      schema: 'audit',
      table: 'platform_event',
      name: 'platform_event_pk',
      definition:
        'CREATE UNIQUE INDEX platform_event_pk ON ONLY audit.platform_event USING btree (occurred_at, event_id)',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      name: 'account_credential_one_per_kind',
      definition:
        'CREATE UNIQUE INDEX account_credential_one_per_kind ON platform.account_credential USING btree (account_id, kind)',
    },
    {
      schema: 'platform',
      table: 'account_credential',
      name: 'account_credential_pkey',
      definition:
        'CREATE UNIQUE INDEX account_credential_pkey ON platform.account_credential USING btree (credential_id)',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      name: 'account_permission_grant_active_uq',
      definition:
        'CREATE UNIQUE INDEX account_permission_grant_active_uq ON platform.account_permission_grant USING btree (account_id, permission) WHERE (revoked_at IS NULL)',
    },
    {
      schema: 'platform',
      table: 'account_permission_grant',
      name: 'account_permission_grant_pkey',
      definition:
        'CREATE UNIQUE INDEX account_permission_grant_pkey ON platform.account_permission_grant USING btree (permission_grant_id)',
    },
    {
      schema: 'platform',
      table: 'export_artifact',
      name: 'export_artifact_pkey',
      definition:
        'CREATE UNIQUE INDEX export_artifact_pkey ON platform.export_artifact USING btree (export_id)',
    },
    {
      schema: 'platform',
      table: 'external_gate',
      name: 'external_gate_pkey',
      definition:
        'CREATE UNIQUE INDEX external_gate_pkey ON platform.external_gate USING btree (gate_code)',
    },
    {
      schema: 'platform',
      table: 'feature_flag',
      name: 'feature_flag_pkey',
      definition:
        'CREATE UNIQUE INDEX feature_flag_pkey ON platform.feature_flag USING btree (flag_key)',
    },
    {
      schema: 'platform',
      table: 'hotel',
      name: 'hotel_pkey',
      definition: 'CREATE UNIQUE INDEX hotel_pkey ON platform.hotel USING btree (hotel_id)',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      name: 'idempotency_key_expiry_idx',
      definition:
        'CREATE INDEX idempotency_key_expiry_idx ON platform.idempotency_key USING btree (expires_at)',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      name: 'idempotency_key_pkey',
      definition:
        'CREATE UNIQUE INDEX idempotency_key_pkey ON platform.idempotency_key USING btree (idempotency_id)',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      name: 'idempotency_key_scope_uq',
      definition:
        'CREATE UNIQUE INDEX idempotency_key_scope_uq ON platform.idempotency_key USING btree (realm, actor_ref, operation, idempotency_key)',
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      name: 'inbox_consumption_pkey',
      definition:
        'CREATE UNIQUE INDEX inbox_consumption_pkey ON platform.inbox_consumption USING btree (consumption_id)',
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      name: 'inbox_consumption_uq',
      definition:
        'CREATE UNIQUE INDEX inbox_consumption_uq ON platform.inbox_consumption USING btree (consumer, dedup_key)',
    },
    {
      schema: 'platform',
      table: 'internal_gate',
      name: 'internal_gate_pkey',
      definition:
        'CREATE UNIQUE INDEX internal_gate_pkey ON platform.internal_gate USING btree (control_code)',
    },
    {
      schema: 'platform',
      table: 'invitation_requested_role',
      name: 'invitation_requested_role_pk',
      definition:
        'CREATE UNIQUE INDEX invitation_requested_role_pk ON platform.invitation_requested_role USING btree (hotel_id, invitation_id, role)',
    },
    {
      schema: 'platform',
      table: 'job_run',
      name: 'job_run_name_idx',
      definition:
        'CREATE INDEX job_run_name_idx ON platform.job_run USING btree (job_name, started_at DESC)',
    },
    {
      schema: 'platform',
      table: 'job_run',
      name: 'job_run_pkey',
      definition: 'CREATE UNIQUE INDEX job_run_pkey ON platform.job_run USING btree (job_run_id)',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      name: 'membership_role_grant_active_uq',
      definition:
        'CREATE UNIQUE INDEX membership_role_grant_active_uq ON platform.membership_role_grant USING btree (hotel_id, membership_id, role) WHERE (revoked_at IS NULL)',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      name: 'membership_role_grant_pkey',
      definition:
        'CREATE UNIQUE INDEX membership_role_grant_pkey ON platform.membership_role_grant USING btree (role_grant_id)',
    },
    {
      schema: 'platform',
      table: 'operational_alert',
      name: 'operational_alert_open_idx',
      definition:
        'CREATE INDEX operational_alert_open_idx ON platform.operational_alert USING btree (alert_code, raised_at DESC) WHERE (resolved_at IS NULL)',
    },
    {
      schema: 'platform',
      table: 'operational_alert',
      name: 'operational_alert_pkey',
      definition:
        'CREATE UNIQUE INDEX operational_alert_pkey ON platform.operational_alert USING btree (alert_id)',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      name: 'outbox_delivery_claimable_idx',
      definition:
        "CREATE INDEX outbox_delivery_claimable_idx ON platform.outbox_delivery USING btree (available_at, event_id) WHERE (state = ANY (ARRAY['pending'::text, 'claimed'::text]))",
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      name: 'outbox_delivery_pkey',
      definition:
        'CREATE UNIQUE INDEX outbox_delivery_pkey ON platform.outbox_delivery USING btree (event_id)',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      name: 'outbox_event_aggregate_idx',
      definition:
        'CREATE INDEX outbox_event_aggregate_idx ON platform.outbox_event USING btree (aggregate_type, aggregate_id, event_id)',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      name: 'outbox_event_pkey',
      definition:
        'CREATE UNIQUE INDEX outbox_event_pkey ON platform.outbox_event USING btree (event_id)',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      name: 'outbox_event_uuid_uq',
      definition:
        'CREATE UNIQUE INDEX outbox_event_uuid_uq ON platform.outbox_event USING btree (event_uuid)',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_lease_idx',
      definition:
        "CREATE INDEX password_reset_intake_lease_idx ON platform.password_reset_intake USING btree (lease_expires_at) WHERE (state = 'CLAIMED'::text)",
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_pkey',
      definition:
        'CREATE UNIQUE INDEX password_reset_intake_pkey ON platform.password_reset_intake USING btree (intake_id)',
    },
    {
      schema: 'platform',
      table: 'password_reset_intake',
      name: 'password_reset_intake_queue_idx',
      definition:
        'CREATE INDEX password_reset_intake_queue_idx ON platform.password_reset_intake USING btree (state, next_attempt_at)',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_delivery_uq',
      definition:
        'CREATE UNIQUE INDEX password_reset_request_delivery_uq ON platform.password_reset_request USING btree (delivery_id)',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_one_active_uq',
      definition:
        "CREATE UNIQUE INDEX password_reset_request_one_active_uq ON platform.password_reset_request USING btree (account_id) WHERE (state = 'ACTIVE'::text)",
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_pkey',
      definition:
        'CREATE UNIQUE INDEX password_reset_request_pkey ON platform.password_reset_request USING btree (reset_id)',
    },
    {
      schema: 'platform',
      table: 'password_reset_request',
      name: 'password_reset_request_token_uq',
      definition:
        'CREATE UNIQUE INDEX password_reset_request_token_uq ON platform.password_reset_request USING btree (token_hash)',
    },
    {
      schema: 'platform',
      table: 'projection_checkpoint',
      name: 'projection_checkpoint_pkey',
      definition:
        'CREATE UNIQUE INDEX projection_checkpoint_pkey ON platform.projection_checkpoint USING btree (projection)',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      name: 'provider_event_pkey',
      definition:
        'CREATE UNIQUE INDEX provider_event_pkey ON platform.provider_event USING btree (provider_event_row_id)',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      name: 'provider_event_uq',
      definition:
        'CREATE UNIQUE INDEX provider_event_uq ON platform.provider_event USING btree (provider, provider_event_id)',
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_identity_uq',
      definition:
        'CREATE UNIQUE INDEX server_session_identity_uq ON platform.server_session USING btree (session_id, account_id, realm)',
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_pkey',
      definition:
        'CREATE UNIQUE INDEX server_session_pkey ON platform.server_session USING btree (session_id)',
    },
    {
      schema: 'platform',
      table: 'server_session',
      name: 'server_session_token_uq',
      definition:
        'CREATE UNIQUE INDEX server_session_token_uq ON platform.server_session USING btree (token_hash)',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      name: 'session_scope_grant_live_uq',
      definition:
        'CREATE UNIQUE INDEX session_scope_grant_live_uq ON platform.session_scope_grant USING btree (session_id, membership_id) WHERE (revoked_at IS NULL)',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      name: 'session_scope_grant_pkey',
      definition:
        'CREATE UNIQUE INDEX session_scope_grant_pkey ON platform.session_scope_grant USING btree (scope_grant_id)',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_one_active_uq',
      definition:
        "CREATE UNIQUE INDEX staff_invitation_one_active_uq ON platform.staff_invitation USING btree (hotel_id, membership_id) WHERE (state = 'ACTIVE'::text)",
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_pkey',
      definition:
        'CREATE UNIQUE INDEX staff_invitation_pkey ON platform.staff_invitation USING btree (invitation_id)',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_scope_uq',
      definition:
        'CREATE UNIQUE INDEX staff_invitation_scope_uq ON platform.staff_invitation USING btree (hotel_id, invitation_id)',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'staff_invitation_token_uq',
      definition:
        'CREATE UNIQUE INDEX staff_invitation_token_uq ON platform.staff_invitation USING btree (token_hash)',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_account_idx',
      definition:
        'CREATE INDEX staff_membership_account_idx ON platform.staff_membership USING btree (account_id, hotel_id) WHERE (account_id IS NOT NULL)',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_account_scope_uq',
      definition:
        'CREATE UNIQUE INDEX staff_membership_account_scope_uq ON platform.staff_membership USING btree (hotel_id, membership_id, account_id)',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_hotel_account_uq',
      definition:
        'CREATE UNIQUE INDEX staff_membership_hotel_account_uq ON platform.staff_membership USING btree (hotel_id, account_id) WHERE ((restaurant_id IS NULL) AND (account_id IS NOT NULL))',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_hotel_email_uq',
      definition:
        'CREATE UNIQUE INDEX staff_membership_hotel_email_uq ON platform.staff_membership USING btree (hotel_id, invited_email_normalized) WHERE (restaurant_id IS NULL)',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_pkey',
      definition:
        'CREATE UNIQUE INDEX staff_membership_pkey ON platform.staff_membership USING btree (membership_id)',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_primary_admin_uq',
      definition:
        'CREATE UNIQUE INDEX staff_membership_primary_admin_uq ON platform.staff_membership USING btree (hotel_id) WHERE (is_primary_admin IS TRUE)',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_restaurant_account_uq',
      definition:
        'CREATE UNIQUE INDEX staff_membership_restaurant_account_uq ON platform.staff_membership USING btree (hotel_id, restaurant_id, account_id) WHERE ((restaurant_id IS NOT NULL) AND (account_id IS NOT NULL))',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_restaurant_email_uq',
      definition:
        'CREATE UNIQUE INDEX staff_membership_restaurant_email_uq ON platform.staff_membership USING btree (hotel_id, restaurant_id, invited_email_normalized) WHERE (restaurant_id IS NOT NULL)',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'staff_membership_scope_uq',
      definition:
        'CREATE UNIQUE INDEX staff_membership_scope_uq ON platform.staff_membership USING btree (hotel_id, membership_id)',
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_pkey',
      definition:
        'CREATE UNIQUE INDEX user_account_pkey ON platform.user_account USING btree (account_id)',
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_principal_uq',
      definition:
        'CREATE UNIQUE INDEX user_account_principal_uq ON platform.user_account USING btree (account_id, realm, realm_role)',
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_realm_email_uq',
      definition:
        'CREATE UNIQUE INDEX user_account_realm_email_uq ON platform.user_account USING btree (realm, email_normalized)',
    },
    {
      schema: 'platform',
      table: 'user_account',
      name: 'user_account_realm_identity_uq',
      definition:
        'CREATE UNIQUE INDEX user_account_realm_identity_uq ON platform.user_account USING btree (account_id, realm)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_open_uq',
      definition:
        "CREATE UNIQUE INDEX work_handoff_discovery_open_uq ON platform.work_handoff_discovery USING btree (hotel_id, membership_id) WHERE (state = 'PENDING'::text)",
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_pkey',
      definition:
        'CREATE UNIQUE INDEX work_handoff_discovery_pkey ON platform.work_handoff_discovery USING btree (discovery_id)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_queue_idx',
      definition:
        'CREATE INDEX work_handoff_discovery_queue_idx ON platform.work_handoff_discovery USING btree (hotel_id, state, created_at)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'work_handoff_discovery_scope_uq',
      definition:
        'CREATE UNIQUE INDEX work_handoff_discovery_scope_uq ON platform.work_handoff_discovery USING btree (hotel_id, discovery_id)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      name: 'work_handoff_event_idempotency_uq',
      definition:
        'CREATE UNIQUE INDEX work_handoff_event_idempotency_uq ON platform.work_handoff_event USING btree (hotel_id, item_id, idempotency_key)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      name: 'work_handoff_event_pk',
      definition:
        'CREATE UNIQUE INDEX work_handoff_event_pk ON platform.work_handoff_event USING btree (hotel_id, item_id, seq)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_open_subject_uq',
      definition:
        "CREATE UNIQUE INDEX work_handoff_item_open_subject_uq ON platform.work_handoff_item USING btree (hotel_id, subject_kind, subject_ref) WHERE (state <> 'RESOLVED'::text)",
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_pkey',
      definition:
        'CREATE UNIQUE INDEX work_handoff_item_pkey ON platform.work_handoff_item USING btree (item_id)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_queue_idx',
      definition:
        'CREATE INDEX work_handoff_item_queue_idx ON platform.work_handoff_item USING btree (hotel_id, state, created_at)',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'work_handoff_item_scope_uq',
      definition:
        'CREATE UNIQUE INDEX work_handoff_item_scope_uq ON platform.work_handoff_item USING btree (hotel_id, item_id)',
    },
    {
      schema: 'police_audit',
      table: 'security_event',
      name: 'security_event_pk',
      definition:
        'CREATE UNIQUE INDEX security_event_pk ON ONLY police_audit.security_event USING btree (occurred_at, event_id)',
    },
  ],
  identitySequences: [
    {
      schema: 'platform',
      table: 'outbox_event',
      column: 'event_id',
      sequenceSchema: 'platform',
      sequence: 'outbox_event_event_id_seq',
      shape: 'start 1 | increment 1 | min 1 | max 9223372036854775807 | cache 1 | no cycle',
    },
  ],
  rls: [
    {
      schema: 'platform',
      table: 'export_artifact',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'hotel',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'invitation_requested_role',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'job_run',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'provider_event',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      enabled: true,
      forced: true,
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      enabled: true,
      forced: true,
    },
  ],
  enums: [],
  policies: [
    {
      schema: 'platform',
      table: 'export_artifact',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'hotel',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'idempotency_key',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'inbox_consumption',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'invitation_requested_role',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'job_run',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      name: 'own_membership_roles_read',
      as: 'PERMISSIVE',
      command: 'SELECT',
      to: ['public'],
      using:
        "((platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid) AND (EXISTS ( SELECT 1\n   FROM platform.staff_membership m\n  WHERE ((m.hotel_id = membership_role_grant.hotel_id) AND (m.membership_id = membership_role_grant.membership_id) AND (m.account_id = platform.current_account_id())))))",
      withCheck: null,
    },
    {
      schema: 'platform',
      table: 'membership_role_grant',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'outbox_delivery',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'outbox_event',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'provider_event',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      name: 'own_account_scope',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using:
        "((platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid) AND (account_id = platform.current_account_id()))",
      withCheck:
        "((platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid) AND (account_id = platform.current_account_id()))",
    },
    {
      schema: 'platform',
      table: 'session_scope_grant',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'staff_invitation',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'own_membership_read',
      as: 'PERMISSIVE',
      command: 'SELECT',
      to: ['public'],
      using:
        "((platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid) AND (account_id = platform.current_account_id()))",
      withCheck: null,
    },
    {
      schema: 'platform',
      table: 'staff_membership',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'work_handoff_discovery',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'work_handoff_event',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
    {
      schema: 'platform',
      table: 'work_handoff_item',
      name: 'tenant_isolation',
      as: 'PERMISSIVE',
      command: 'ALL',
      to: ['public'],
      using: '(hotel_id = platform.current_hotel_id())',
      withCheck: '(hotel_id = platform.current_hotel_id())',
    },
  ],
};
