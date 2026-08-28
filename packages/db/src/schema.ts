import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
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
 * Anything the DSL cannot express — RLS, ownership, ACLs, partitioning, partial
 * and expression indexes, exclusion constraints, check text — stays in
 * `schema-snapshot.ts` and in the normalized `pg_dump` comparison. What must not
 * happen is a change here passing silently because the snapshot still matches
 * the database; `schema-projection.ts` compares this declaration against the
 * snapshot for exactly that reason.
 */
export const platform = pgSchema('platform');
export const auditSchema = pgSchema('audit');
export const policeAudit = pgSchema('police_audit');

export const idempotencyKey = platform.table('idempotency_key', {
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
});

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
  (table) => [unique('outbox_event_uuid_uq').on(table.eventUuid)],
);

export const outboxDelivery = platform.table('outbox_delivery', {
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
});

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
  (table) => [unique('provider_event_uq').on(table.provider, table.providerEventId)],
);

export const jobRun = platform.table('job_run', {
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
});

export const exportArtifact = platform.table('export_artifact', {
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
});

export const projectionCheckpoint = platform.table('projection_checkpoint', {
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
});

export const externalGate = platform.table('external_gate', {
  gateCode: text('gate_code').primaryKey(),
  description: text('description').notNull(),
  enabled: boolean('enabled')
    .notNull()
    .default(sql`false`),
  blocker: text('blocker'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const internalGate = platform.table('internal_gate', {
  controlCode: text('control_code').primaryKey(),
  description: text('description').notNull(),
  enabled: boolean('enabled')
    .notNull()
    .default(sql`false`),
  blocker: text('blocker'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

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

export const operationalAlert = platform.table('operational_alert', {
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
});

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
