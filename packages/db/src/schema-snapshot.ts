/**
 * The canonical schema snapshot.
 *
 * Drizzle's DSL expresses tables, columns, types and nullability; it does not
 * express partial-index predicates, expression indexes, composite audit primary
 * keys, exclusion constraints, or the exact text of a check. Those live here, as
 * an explicit declaration rather than as whatever the database happens to hold.
 *
 * Regenerated deliberately, never automatically: an "update the snapshot to
 * match" step would make the comparator agree with any change, which is the
 * opposite of what it is for. A migration that alters schema shape should
 * change this file in the same commit, and a reviewer should be able to read
 * the diff as the schema change it is.
 */
export interface ColumnSnapshot {
  readonly table: string;
  readonly column: string;
  /** `type | NULL|NOT NULL | default … | identity … | generated …` */
  readonly shape: string;
}

export interface ConstraintSnapshot {
  readonly table: string;
  readonly name: string;
  /** `p` primary key, `f` foreign key, `u` unique, `c` check, `x` exclusion. */
  readonly kind: string;
  readonly definition: string;
}

export interface IndexSnapshot {
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

export interface SchemaSnapshot {
  readonly columns: readonly ColumnSnapshot[];
  readonly constraints: readonly ConstraintSnapshot[];
  readonly indexes: readonly IndexSnapshot[];
}

export const EXPECTED_SCHEMA_SNAPSHOT: SchemaSnapshot = {
  columns: [
    {
      table: 'audit.platform_event',
      column: 'action',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'audit.platform_event',
      column: 'actor_ref',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'audit.platform_event',
      column: 'causation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'audit.platform_event',
      column: 'correlation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'audit.platform_event',
      column: 'event_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      table: 'audit.platform_event',
      column: 'hotel_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      table: 'audit.platform_event',
      column: 'occurred_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'audit.platform_event',
      column: 'outcome',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'audit.platform_event',
      column: 'payload',
      shape: "jsonb | NOT NULL | default '{}'::jsonb | no identity | not generated",
    },
    {
      table: 'audit.platform_event',
      column: 'realm',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'audit.platform_event',
      column: 'reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'audit.platform_event',
      column: 'target_ref',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'audit.platform_event',
      column: 'target_type',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.export_artifact',
      column: 'as_of',
      shape: 'timestamp with time zone | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.export_artifact',
      column: 'content_hash',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.export_artifact',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'platform.export_artifact',
      column: 'expires_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.export_artifact',
      column: 'export_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      table: 'platform.export_artifact',
      column: 'export_kind',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.export_artifact',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.export_artifact',
      column: 'job_run_id',
      shape: 'uuid | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.export_artifact',
      column: 'row_count',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      table: 'platform.export_artifact',
      column: 'storage_key',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.external_gate',
      column: 'blocker',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.external_gate',
      column: 'description',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.external_gate',
      column: 'enabled',
      shape: 'boolean | NOT NULL | default false | no identity | not generated',
    },
    {
      table: 'platform.external_gate',
      column: 'gate_code',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.external_gate',
      column: 'updated_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'platform.feature_flag',
      column: 'description',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.feature_flag',
      column: 'enabled',
      shape: 'boolean | NOT NULL | default false | no identity | not generated',
    },
    {
      table: 'platform.feature_flag',
      column: 'flag_key',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.feature_flag',
      column: 'updated_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'actor_ref',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'client_ref',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'completed_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'correlation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'created_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'expires_at',
      shape: 'timestamp with time zone | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'idempotency_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'idempotency_key',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'operation',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'realm',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'request_hash',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'response_body',
      shape: 'jsonb | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'response_status',
      shape: 'integer | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.idempotency_key',
      column: 'state',
      shape: "text | NOT NULL | default 'in_progress'::text | no identity | not generated",
    },
    {
      table: 'platform.inbox_consumption',
      column: 'consumer',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.inbox_consumption',
      column: 'consumption_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      table: 'platform.inbox_consumption',
      column: 'dedup_key',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.inbox_consumption',
      column: 'first_consumed_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'platform.inbox_consumption',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.inbox_consumption',
      column: 'source',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.internal_gate',
      column: 'blocker',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.internal_gate',
      column: 'control_code',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.internal_gate',
      column: 'description',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.internal_gate',
      column: 'enabled',
      shape: 'boolean | NOT NULL | default false | no identity | not generated',
    },
    {
      table: 'platform.internal_gate',
      column: 'updated_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'platform.job_run',
      column: 'as_of',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.job_run',
      column: 'error_name',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.job_run',
      column: 'finished_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.job_run',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.job_run',
      column: 'issuer_ref',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.job_run',
      column: 'job_identity',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.job_run',
      column: 'job_name',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.job_run',
      column: 'job_run_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      table: 'platform.job_run',
      column: 'scope',
      shape: "jsonb | NOT NULL | default '{}'::jsonb | no identity | not generated",
    },
    {
      table: 'platform.job_run',
      column: 'started_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'platform.job_run',
      column: 'state',
      shape: "text | NOT NULL | default 'running'::text | no identity | not generated",
    },
    {
      table: 'platform.operational_alert',
      column: 'alert_code',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.operational_alert',
      column: 'alert_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      table: 'platform.operational_alert',
      column: 'detail',
      shape: "jsonb | NOT NULL | default '{}'::jsonb | no identity | not generated",
    },
    {
      table: 'platform.operational_alert',
      column: 'raised_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'platform.operational_alert',
      column: 'resolved_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.operational_alert',
      column: 'severity',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_delivery',
      column: 'attempts',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      table: 'platform.outbox_delivery',
      column: 'available_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'platform.outbox_delivery',
      column: 'claimed_by',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_delivery',
      column: 'claimed_until',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_delivery',
      column: 'event_id',
      shape: 'bigint | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_delivery',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_delivery',
      column: 'last_error',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_delivery',
      column: 'published_at',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_delivery',
      column: 'revision',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      table: 'platform.outbox_delivery',
      column: 'state',
      shape: "text | NOT NULL | default 'pending'::text | no identity | not generated",
    },
    {
      table: 'platform.outbox_event',
      column: 'aggregate_id',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_event',
      column: 'aggregate_type',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_event',
      column: 'causation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_event',
      column: 'correlation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_event',
      column: 'event_id',
      shape: 'bigint | NOT NULL | no default | identity a | not generated',
    },
    {
      table: 'platform.outbox_event',
      column: 'event_type',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_event',
      column: 'event_uuid',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      table: 'platform.outbox_event',
      column: 'event_version',
      shape: 'integer | NOT NULL | default 1 | no identity | not generated',
    },
    {
      table: 'platform.outbox_event',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.outbox_event',
      column: 'occurred_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'platform.outbox_event',
      column: 'payload',
      shape: 'jsonb | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.projection_checkpoint',
      column: 'as_of',
      shape: 'timestamp with time zone | NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.projection_checkpoint',
      column: 'last_event_id',
      shape: 'bigint | NOT NULL | default 0 | no identity | not generated',
    },
    {
      table: 'platform.projection_checkpoint',
      column: 'projection',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.projection_checkpoint',
      column: 'revision',
      shape: 'integer | NOT NULL | default 0 | no identity | not generated',
    },
    {
      table: 'platform.projection_checkpoint',
      column: 'status',
      shape: "text | NOT NULL | default 'idle'::text | no identity | not generated",
    },
    {
      table: 'platform.projection_checkpoint',
      column: 'updated_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'platform.provider_event',
      column: 'event_kind',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.provider_event',
      column: 'hotel_id',
      shape: 'uuid | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.provider_event',
      column: 'metadata',
      shape: "jsonb | NOT NULL | default '{}'::jsonb | no identity | not generated",
    },
    {
      table: 'platform.provider_event',
      column: 'payload_hash',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.provider_event',
      column: 'provider',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.provider_event',
      column: 'provider_event_id',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'platform.provider_event',
      column: 'provider_event_row_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      table: 'platform.provider_event',
      column: 'received_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'police_audit.security_event',
      column: 'action',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'police_audit.security_event',
      column: 'actor_ref',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'police_audit.security_event',
      column: 'case_ref',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'police_audit.security_event',
      column: 'correlation_id',
      shape: 'text | NULL | no default | no identity | not generated',
    },
    {
      table: 'police_audit.security_event',
      column: 'event_id',
      shape: 'uuid | NOT NULL | default gen_random_uuid() | no identity | not generated',
    },
    {
      table: 'police_audit.security_event',
      column: 'occurred_at',
      shape: 'timestamp with time zone | NOT NULL | default now() | no identity | not generated',
    },
    {
      table: 'police_audit.security_event',
      column: 'outcome',
      shape: 'text | NOT NULL | no default | no identity | not generated',
    },
    {
      table: 'police_audit.security_event',
      column: 'payload',
      shape: "jsonb | NOT NULL | default '{}'::jsonb | no identity | not generated",
    },
    {
      table: 'police_audit.security_event',
      column: 'reason',
      shape: 'text | NULL | no default | no identity | not generated',
    },
  ],
  constraints: [
    {
      table: 'audit.platform_event',
      name: 'platform_event_outcome_known',
      kind: 'c',
      definition:
        "CHECK ((outcome = ANY (ARRAY['allowed'::text, 'denied'::text, 'failed'::text])))",
    },
    {
      table: 'audit.platform_event',
      name: 'platform_event_payload_sanitised',
      kind: 'c',
      definition: 'CHECK ((NOT platform.contains_denied_key(payload)))',
    },
    {
      table: 'audit.platform_event',
      name: 'platform_event_pk',
      kind: 'p',
      definition: 'PRIMARY KEY (occurred_at, event_id)',
    },
    {
      table: 'platform.export_artifact',
      name: 'export_artifact_hash_shape',
      kind: 'c',
      definition: "CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text))",
    },
    {
      table: 'platform.export_artifact',
      name: 'export_artifact_job_run_id_fkey',
      kind: 'f',
      definition: 'FOREIGN KEY (job_run_id) REFERENCES platform.job_run(job_run_id)',
    },
    {
      table: 'platform.export_artifact',
      name: 'export_artifact_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (export_id)',
    },
    {
      table: 'platform.export_artifact',
      name: 'export_artifact_rows_non_negative',
      kind: 'c',
      definition: 'CHECK ((row_count >= 0))',
    },
    {
      table: 'platform.external_gate',
      name: 'external_gate_code_shape',
      kind: 'c',
      definition: "CHECK ((gate_code ~ '^EXT-\\d{2}$'::text))",
    },
    {
      table: 'platform.external_gate',
      name: 'external_gate_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (gate_code)',
    },
    {
      table: 'platform.feature_flag',
      name: 'feature_flag_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (flag_key)',
    },
    {
      table: 'platform.idempotency_key',
      name: 'idempotency_key_not_blank',
      kind: 'c',
      definition: 'CHECK (((length(idempotency_key) >= 8) AND (length(idempotency_key) <= 200)))',
    },
    {
      table: 'platform.idempotency_key',
      name: 'idempotency_key_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (idempotency_id)',
    },
    {
      table: 'platform.idempotency_key',
      name: 'idempotency_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['in_progress'::text, 'succeeded'::text, 'failed'::text])))",
    },
    {
      table: 'platform.idempotency_key',
      name: 'idempotency_terminal_has_response',
      kind: 'c',
      definition:
        "CHECK ((((state = 'in_progress'::text) AND (response_status IS NULL) AND (completed_at IS NULL)) OR ((state <> 'in_progress'::text) AND (response_status IS NOT NULL) AND (completed_at IS NOT NULL))))",
    },
    {
      table: 'platform.inbox_consumption',
      name: 'inbox_consumption_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (consumption_id)',
    },
    {
      table: 'platform.inbox_consumption',
      name: 'inbox_consumption_uq',
      kind: 'u',
      definition: 'UNIQUE (consumer, dedup_key)',
    },
    {
      table: 'platform.internal_gate',
      name: 'internal_gate_code_shape',
      kind: 'c',
      definition: "CHECK ((control_code ~ '^INT-[A-Z]{2,8}-\\d{2}$'::text))",
    },
    {
      table: 'platform.internal_gate',
      name: 'internal_gate_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (control_code)',
    },
    {
      table: 'platform.job_run',
      name: 'job_run_error_name_bounded',
      kind: 'c',
      definition:
        'CHECK (((error_name IS NULL) OR ((length(error_name) >= 1) AND (length(error_name) <= 128))))',
    },
    {
      table: 'platform.job_run',
      name: 'job_run_identity_shape',
      kind: 'c',
      definition: "CHECK ((job_identity ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'::text))",
    },
    {
      table: 'platform.job_run',
      name: 'job_run_issuer_shape',
      kind: 'c',
      definition:
        "CHECK (((issuer_ref IS NULL) OR (issuer_ref ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'::text)))",
    },
    {
      table: 'platform.job_run',
      name: 'job_run_job_name_shape',
      kind: 'c',
      definition: "CHECK ((job_name ~ '^[a-z][a-z0-9_.]{2,127}$'::text))",
    },
    {
      table: 'platform.job_run',
      name: 'job_run_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (job_run_id)',
    },
    {
      table: 'platform.job_run',
      name: 'job_run_privileged_has_issuer',
      kind: 'c',
      definition:
        "CHECK (((job_name !~~ 'platform.maintenance.%'::text) OR (issuer_ref IS NOT NULL)))",
    },
    {
      table: 'platform.job_run',
      name: 'job_run_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))",
    },
    {
      table: 'platform.job_run',
      name: 'job_run_terminal_has_finish',
      kind: 'c',
      definition: "CHECK (((state = 'running'::text) = (finished_at IS NULL)))",
    },
    {
      table: 'platform.operational_alert',
      name: 'operational_alert_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (alert_id)',
    },
    {
      table: 'platform.operational_alert',
      name: 'operational_alert_severity_known',
      kind: 'c',
      definition:
        "CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])))",
    },
    {
      table: 'platform.outbox_delivery',
      name: 'outbox_delivery_attempts_non_negative',
      kind: 'c',
      definition: 'CHECK ((attempts >= 0))',
    },
    {
      table: 'platform.outbox_delivery',
      name: 'outbox_delivery_event_id_fkey',
      kind: 'f',
      definition:
        'FOREIGN KEY (event_id) REFERENCES platform.outbox_event(event_id) ON DELETE RESTRICT',
    },
    {
      table: 'platform.outbox_delivery',
      name: 'outbox_delivery_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (event_id)',
    },
    {
      table: 'platform.outbox_delivery',
      name: 'outbox_delivery_published_has_time',
      kind: 'c',
      definition: "CHECK (((state = 'published'::text) = (published_at IS NOT NULL)))",
    },
    {
      table: 'platform.outbox_delivery',
      name: 'outbox_delivery_state_known',
      kind: 'c',
      definition:
        "CHECK ((state = ANY (ARRAY['pending'::text, 'claimed'::text, 'published'::text, 'failed'::text])))",
    },
    {
      table: 'platform.outbox_event',
      name: 'outbox_event_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (event_id)',
    },
    {
      table: 'platform.outbox_event',
      name: 'outbox_event_uuid_uq',
      kind: 'u',
      definition: 'UNIQUE (event_uuid)',
    },
    {
      table: 'platform.outbox_event',
      name: 'outbox_event_version_positive',
      kind: 'c',
      definition: 'CHECK ((event_version >= 1))',
    },
    {
      table: 'platform.outbox_event',
      name: 'outbox_payload_sanitised',
      kind: 'c',
      definition: 'CHECK ((NOT platform.contains_denied_key(payload)))',
    },
    {
      table: 'platform.projection_checkpoint',
      name: 'projection_checkpoint_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (projection)',
    },
    {
      table: 'platform.projection_checkpoint',
      name: 'projection_last_event_non_negative',
      kind: 'c',
      definition: 'CHECK ((last_event_id >= 0))',
    },
    {
      table: 'platform.projection_checkpoint',
      name: 'projection_status_known',
      kind: 'c',
      definition:
        "CHECK ((status = ANY (ARRAY['idle'::text, 'running'::text, 'rebuilding'::text, 'failed'::text])))",
    },
    {
      table: 'platform.provider_event',
      name: 'provider_event_hash_shape',
      kind: 'c',
      definition: "CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text))",
    },
    {
      table: 'platform.provider_event',
      name: 'provider_event_metadata_sanitised',
      kind: 'c',
      definition: 'CHECK ((NOT platform.contains_denied_key(metadata)))',
    },
    {
      table: 'platform.provider_event',
      name: 'provider_event_pkey',
      kind: 'p',
      definition: 'PRIMARY KEY (provider_event_row_id)',
    },
    {
      table: 'platform.provider_event',
      name: 'provider_event_uq',
      kind: 'u',
      definition: 'UNIQUE (provider, provider_event_id)',
    },
    {
      table: 'police_audit.security_event',
      name: 'security_event_outcome_known',
      kind: 'c',
      definition:
        "CHECK ((outcome = ANY (ARRAY['allowed'::text, 'denied'::text, 'failed'::text])))",
    },
    {
      table: 'police_audit.security_event',
      name: 'security_event_payload_sanitised',
      kind: 'c',
      definition: 'CHECK ((NOT platform.contains_denied_key(payload)))',
    },
    {
      table: 'police_audit.security_event',
      name: 'security_event_pk',
      kind: 'p',
      definition: 'PRIMARY KEY (occurred_at, event_id)',
    },
  ],
  indexes: [
    {
      table: 'audit.platform_event',
      name: 'platform_event_pk',
      definition:
        'CREATE UNIQUE INDEX platform_event_pk ON ONLY audit.platform_event USING btree (occurred_at, event_id)',
    },
    {
      table: 'platform.export_artifact',
      name: 'export_artifact_pkey',
      definition:
        'CREATE UNIQUE INDEX export_artifact_pkey ON platform.export_artifact USING btree (export_id)',
    },
    {
      table: 'platform.external_gate',
      name: 'external_gate_pkey',
      definition:
        'CREATE UNIQUE INDEX external_gate_pkey ON platform.external_gate USING btree (gate_code)',
    },
    {
      table: 'platform.feature_flag',
      name: 'feature_flag_pkey',
      definition:
        'CREATE UNIQUE INDEX feature_flag_pkey ON platform.feature_flag USING btree (flag_key)',
    },
    {
      table: 'platform.idempotency_key',
      name: 'idempotency_key_expiry_idx',
      definition:
        'CREATE INDEX idempotency_key_expiry_idx ON platform.idempotency_key USING btree (expires_at)',
    },
    {
      table: 'platform.idempotency_key',
      name: 'idempotency_key_pkey',
      definition:
        'CREATE UNIQUE INDEX idempotency_key_pkey ON platform.idempotency_key USING btree (idempotency_id)',
    },
    {
      table: 'platform.idempotency_key',
      name: 'idempotency_key_scope_uq',
      definition:
        'CREATE UNIQUE INDEX idempotency_key_scope_uq ON platform.idempotency_key USING btree (realm, actor_ref, operation, idempotency_key)',
    },
    {
      table: 'platform.inbox_consumption',
      name: 'inbox_consumption_pkey',
      definition:
        'CREATE UNIQUE INDEX inbox_consumption_pkey ON platform.inbox_consumption USING btree (consumption_id)',
    },
    {
      table: 'platform.inbox_consumption',
      name: 'inbox_consumption_uq',
      definition:
        'CREATE UNIQUE INDEX inbox_consumption_uq ON platform.inbox_consumption USING btree (consumer, dedup_key)',
    },
    {
      table: 'platform.internal_gate',
      name: 'internal_gate_pkey',
      definition:
        'CREATE UNIQUE INDEX internal_gate_pkey ON platform.internal_gate USING btree (control_code)',
    },
    {
      table: 'platform.job_run',
      name: 'job_run_name_idx',
      definition:
        'CREATE INDEX job_run_name_idx ON platform.job_run USING btree (job_name, started_at DESC)',
    },
    {
      table: 'platform.job_run',
      name: 'job_run_pkey',
      definition: 'CREATE UNIQUE INDEX job_run_pkey ON platform.job_run USING btree (job_run_id)',
    },
    {
      table: 'platform.operational_alert',
      name: 'operational_alert_open_idx',
      definition:
        'CREATE INDEX operational_alert_open_idx ON platform.operational_alert USING btree (alert_code, raised_at DESC) WHERE (resolved_at IS NULL)',
    },
    {
      table: 'platform.operational_alert',
      name: 'operational_alert_pkey',
      definition:
        'CREATE UNIQUE INDEX operational_alert_pkey ON platform.operational_alert USING btree (alert_id)',
    },
    {
      table: 'platform.outbox_delivery',
      name: 'outbox_delivery_claimable_idx',
      definition:
        "CREATE INDEX outbox_delivery_claimable_idx ON platform.outbox_delivery USING btree (available_at, event_id) WHERE (state = ANY (ARRAY['pending'::text, 'claimed'::text]))",
    },
    {
      table: 'platform.outbox_delivery',
      name: 'outbox_delivery_pkey',
      definition:
        'CREATE UNIQUE INDEX outbox_delivery_pkey ON platform.outbox_delivery USING btree (event_id)',
    },
    {
      table: 'platform.outbox_event',
      name: 'outbox_event_aggregate_idx',
      definition:
        'CREATE INDEX outbox_event_aggregate_idx ON platform.outbox_event USING btree (aggregate_type, aggregate_id, event_id)',
    },
    {
      table: 'platform.outbox_event',
      name: 'outbox_event_pkey',
      definition:
        'CREATE UNIQUE INDEX outbox_event_pkey ON platform.outbox_event USING btree (event_id)',
    },
    {
      table: 'platform.outbox_event',
      name: 'outbox_event_uuid_uq',
      definition:
        'CREATE UNIQUE INDEX outbox_event_uuid_uq ON platform.outbox_event USING btree (event_uuid)',
    },
    {
      table: 'platform.projection_checkpoint',
      name: 'projection_checkpoint_pkey',
      definition:
        'CREATE UNIQUE INDEX projection_checkpoint_pkey ON platform.projection_checkpoint USING btree (projection)',
    },
    {
      table: 'platform.provider_event',
      name: 'provider_event_pkey',
      definition:
        'CREATE UNIQUE INDEX provider_event_pkey ON platform.provider_event USING btree (provider_event_row_id)',
    },
    {
      table: 'platform.provider_event',
      name: 'provider_event_uq',
      definition:
        'CREATE UNIQUE INDEX provider_event_uq ON platform.provider_event USING btree (provider, provider_event_id)',
    },
    {
      table: 'police_audit.security_event',
      name: 'security_event_pk',
      definition:
        'CREATE UNIQUE INDEX security_event_pk ON ONLY police_audit.security_event USING btree (occurred_at, event_id)',
    },
  ],
};
