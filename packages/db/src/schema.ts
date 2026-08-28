import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Drizzle schema representation of the Phase 03 kernel.
 *
 * The migration SQL is authoritative — it carries the policies, grants, triggers
 * and constraints that Drizzle's DSL cannot express, and ADR-0004 keeps
 * versioned SQL as the migration mechanism. This declaration exists so the
 * shape can be *compared*: `migrate.test.ts` fails if a kernel table, column or
 * nullability in the database and in this file disagree.
 *
 * It states everything the DSL can state faithfully: types, nullability,
 * defaults, identity, and simple, composite and unique keys. Defaults are given
 * as their exact PostgreSQL text rather than as JavaScript values, because a
 * rendered value is a guess about how PostgreSQL would spell it and this file is
 * compared character for character against the canonical snapshot.
 *
 * It also states foreign keys with their referential action, check constraints
 * with the exact PostgreSQL text of the predicate, and ordinary, unique and
 * partial indexes. Those were previously described as non-expressible; Drizzle
 * 0.45.2 expresses all of them, and describing them otherwise left real schema
 * properties declared in one place only.
 *
 * Anything the DSL cannot express — RLS and policies, grants, triggers,
 * partitioning, exclusion constraints — stays in `schema-snapshot.ts` and in the
 * normalized `pg_dump` comparison, with the reason for each recorded there. What
 * must not happen is a change here passing silently because the snapshot still
 * matches the database; `schema-projection.ts` compares this declaration against
 * the snapshot for exactly that reason.
 */
export const platform = pgSchema('platform');
export const auditSchema = pgSchema('audit');
export const policeAudit = pgSchema('police_audit');

export const idempotencyKey = platform.table(
  'idempotency_key',
  {
    idempotencyId: uuid('idempotency_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hotelId: uuid('hotel_id').notNull(),
    realm: text('realm').notNull(),
    actorRef: text('actor_ref').notNull(),
    clientRef: text('client_ref').notNull(),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state')
      .notNull()
      .default(sql`'in_progress'::text`),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  () => [
    check(
      'idempotency_key_not_blank',
      sql`((length(idempotency_key) >= 8) AND (length(idempotency_key) <= 200))`,
    ),
    check(
      'idempotency_state_known',
      sql`(state = ANY (ARRAY['in_progress'::text, 'succeeded'::text, 'failed'::text]))`,
    ),
    check(
      'idempotency_terminal_has_response',
      sql`(((state = 'in_progress'::text) AND (response_status IS NULL) AND (completed_at IS NULL)) OR ((state <> 'in_progress'::text) AND (response_status IS NOT NULL) AND (completed_at IS NOT NULL)))`,
    ),
    index('idempotency_key_expiry_idx').using('btree', sql`expires_at`),
    uniqueIndex('idempotency_key_scope_uq').using(
      'btree',
      sql`realm`,
      sql`actor_ref`,
      sql`operation`,
      sql`idempotency_key`,
    ),
  ],
);

export const outboxEvent = platform.table(
  'outbox_event',
  {
    eventId: bigint('event_id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    eventUuid: uuid('event_uuid')
      .notNull()
      .default(sql`gen_random_uuid()`),
    hotelId: uuid('hotel_id').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version')
      .notNull()
      .default(sql`1`),
    payload: jsonb('payload').notNull(),
    correlationId: text('correlation_id'),
    causationId: text('causation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    unique('outbox_event_uuid_uq').on(table.eventUuid),
    check('outbox_event_version_positive', sql`(event_version >= 1)`),
    check('outbox_payload_sanitised', sql`(NOT platform.contains_denied_key(payload))`),
    index('outbox_event_aggregate_idx').using(
      'btree',
      sql`aggregate_type`,
      sql`aggregate_id`,
      sql`event_id`,
    ),
  ],
);

export const outboxDelivery = platform.table(
  'outbox_delivery',
  {
    eventId: bigint('event_id', { mode: 'bigint' }).primaryKey(),
    hotelId: uuid('hotel_id').notNull(),
    state: text('state')
      .notNull()
      .default(sql`'pending'::text`),
    attempts: integer('attempts')
      .notNull()
      .default(sql`0`),
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    claimedBy: text('claimed_by'),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lastError: text('last_error'),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
  },
  (table) => [
    check('outbox_delivery_attempts_non_negative', sql`(attempts >= 0)`),
    check(
      'outbox_delivery_published_has_time',
      sql`((state = 'published'::text) = (published_at IS NOT NULL))`,
    ),
    check(
      'outbox_delivery_state_known',
      sql`(state = ANY (ARRAY['pending'::text, 'claimed'::text, 'published'::text, 'failed'::text]))`,
    ),
    foreignKey({
      name: 'outbox_delivery_event_id_fkey',
      columns: [table.eventId],
      foreignColumns: [outboxEvent.eventId],
    }).onDelete('restrict'),
    index('outbox_delivery_claimable_idx')
      .using('btree', sql`available_at`, sql`event_id`)
      .where(sql`state = ANY (ARRAY['pending'::text, 'claimed'::text])`),
  ],
);

export const inboxConsumption = platform.table(
  'inbox_consumption',
  {
    consumptionId: uuid('consumption_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hotelId: uuid('hotel_id').notNull(),
    consumer: text('consumer').notNull(),
    dedupKey: text('dedup_key').notNull(),
    source: text('source').notNull(),
    firstConsumedAt: timestamp('first_consumed_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [unique('inbox_consumption_uq').on(table.consumer, table.dedupKey)],
);

export const providerEvent = platform.table(
  'provider_event',
  {
    providerEventRowId: uuid('provider_event_row_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hotelId: uuid('hotel_id').notNull(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventKind: text('event_kind').notNull(),
    payloadHash: text('payload_hash').notNull(),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    unique('provider_event_uq').on(table.provider, table.providerEventId),
    check('provider_event_hash_shape', sql`(payload_hash ~ '^[0-9a-f]{64}$'::text)`),
    check('provider_event_metadata_sanitised', sql`(NOT platform.contains_denied_key(metadata))`),
  ],
);

export const jobRun = platform.table(
  'job_run',
  {
    jobRunId: uuid('job_run_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hotelId: uuid('hotel_id').notNull(),
    jobName: text('job_name').notNull(),
    jobIdentity: text('job_identity').notNull(),
    /** D-09: who issued the job, as distinct from who executes it. */
    issuerRef: text('issuer_ref'),
    state: text('state')
      .notNull()
      .default(sql`'running'::text`),
    scope: jsonb('scope')
      .notNull()
      .default(sql`'{}'::jsonb`),
    asOf: timestamp('as_of', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    errorName: text('error_name'),
  },
  () => [
    check(
      'job_run_error_name_bounded',
      sql`((error_name IS NULL) OR ((length(error_name) >= 1) AND (length(error_name) <= 128)))`,
    ),
    check('job_run_identity_shape', sql`(job_identity ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'::text)`),
    check(
      'job_run_issuer_shape',
      sql`((issuer_ref IS NULL) OR (issuer_ref ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'::text))`,
    ),
    check('job_run_job_name_shape', sql`(job_name ~ '^[a-z][a-z0-9_.]{2,127}$'::text)`),
    check(
      'job_run_privileged_has_issuer',
      sql`((job_name !~~ 'platform.maintenance.%'::text) OR (issuer_ref IS NOT NULL))`,
    ),
    check(
      'job_run_state_known',
      sql`(state = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text]))`,
    ),
    check('job_run_terminal_has_finish', sql`((state = 'running'::text) = (finished_at IS NULL))`),
    index('job_run_name_idx').using('btree', sql`job_name`, sql`started_at DESC`),
  ],
);

export const exportArtifact = platform.table(
  'export_artifact',
  {
    exportId: uuid('export_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hotelId: uuid('hotel_id').notNull(),
    jobRunId: uuid('job_run_id'),
    exportKind: text('export_kind').notNull(),
    storageKey: text('storage_key').notNull(),
    contentHash: text('content_hash').notNull(),
    rowCount: integer('row_count')
      .notNull()
      .default(sql`0`),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    check('export_artifact_hash_shape', sql`(content_hash ~ '^[0-9a-f]{64}$'::text)`),
    check('export_artifact_rows_non_negative', sql`(row_count >= 0)`),
    foreignKey({
      name: 'export_artifact_job_run_id_fkey',
      columns: [table.jobRunId],
      foreignColumns: [jobRun.jobRunId],
    }),
  ],
);

export const projectionCheckpoint = platform.table(
  'projection_checkpoint',
  {
    projection: text('projection').primaryKey(),
    lastEventId: bigint('last_event_id', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    asOf: timestamp('as_of', { withTimezone: true }),
    status: text('status')
      .notNull()
      .default(sql`'idle'::text`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
  },
  () => [
    check('projection_last_event_non_negative', sql`(last_event_id >= 0)`),
    check(
      'projection_status_known',
      sql`(status = ANY (ARRAY['idle'::text, 'running'::text, 'rebuilding'::text, 'failed'::text]))`,
    ),
  ],
);

export const externalGate = platform.table(
  'external_gate',
  {
    gateCode: text('gate_code').primaryKey(),
    description: text('description').notNull(),
    enabled: boolean('enabled')
      .notNull()
      .default(sql`false`),
    blocker: text('blocker'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  () => [check('external_gate_code_shape', sql`(gate_code ~ '^EXT-\\d{2}$'::text)`)],
);

export const internalGate = platform.table(
  'internal_gate',
  {
    controlCode: text('control_code').primaryKey(),
    description: text('description').notNull(),
    enabled: boolean('enabled')
      .notNull()
      .default(sql`false`),
    blocker: text('blocker'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  () => [check('internal_gate_code_shape', sql`(control_code ~ '^INT-[A-Z]{2,8}-\\d{2}$'::text)`)],
);

export const featureFlag = platform.table('feature_flag', {
  flagKey: text('flag_key').primaryKey(),
  description: text('description').notNull(),
  enabled: boolean('enabled')
    .notNull()
    .default(sql`false`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const operationalAlert = platform.table(
  'operational_alert',
  {
    alertId: uuid('alert_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    alertCode: text('alert_code').notNull(),
    severity: text('severity').notNull(),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
    raisedAt: timestamp('raised_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  () => [
    check(
      'operational_alert_severity_known',
      sql`(severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))`,
    ),
    index('operational_alert_open_idx')
      .using('btree', sql`alert_code`, sql`raised_at DESC`)
      .where(sql`resolved_at IS NULL`),
  ],
);

/**
 * The two append-only audit streams. Declared as their root partitioned tables:
 * the partitions themselves are created by
 * `platform.ensure_month_partitions`, which is SQL-only territory and is
 * covered by the normalized dump rather than by this declaration.
 */
export const platformEvent = auditSchema.table(
  'platform_event',
  {
    eventId: uuid('event_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    realm: text('realm').notNull(),
    action: text('action').notNull(),
    outcome: text('outcome').notNull(),
    actorRef: text('actor_ref'),
    hotelId: uuid('hotel_id'),
    targetType: text('target_type'),
    targetRef: text('target_ref'),
    reason: text('reason'),
    correlationId: text('correlation_id'),
    causationId: text('causation_id'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({ name: 'platform_event_pk', columns: [table.occurredAt, table.eventId] }),
    check(
      'platform_event_outcome_known',
      sql`(outcome = ANY (ARRAY['allowed'::text, 'denied'::text, 'failed'::text]))`,
    ),
    check('platform_event_payload_sanitised', sql`(NOT platform.contains_denied_key(payload))`),
  ],
);

export const securityEvent = policeAudit.table(
  'security_event',
  {
    eventId: uuid('event_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    action: text('action').notNull(),
    outcome: text('outcome').notNull(),
    actorRef: text('actor_ref'),
    caseRef: text('case_ref'),
    reason: text('reason'),
    correlationId: text('correlation_id'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({ name: 'security_event_pk', columns: [table.occurredAt, table.eventId] }),
    check(
      'security_event_outcome_known',
      sql`(outcome = ANY (ARRAY['allowed'::text, 'denied'::text, 'failed'::text]))`,
    ),
    check('security_event_payload_sanitised', sql`(NOT platform.contains_denied_key(payload))`),
  ],
);

/** The kernel tables this declaration covers, for the drift check. */
export const DECLARED_TABLES = [
  idempotencyKey,
  outboxEvent,
  outboxDelivery,
  inboxConsumption,
  providerEvent,
  jobRun,
  exportArtifact,
  projectionCheckpoint,
  externalGate,
  internalGate,
  featureFlag,
  operationalAlert,
  platformEvent,
  securityEvent,
] as const;
