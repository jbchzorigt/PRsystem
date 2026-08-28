import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema representation of the Phase 03 kernel.
 *
 * The migration SQL is authoritative — it carries the policies, grants, triggers
 * and constraints that Drizzle's DSL cannot express, and ADR-0004 keeps
 * versioned SQL as the migration mechanism. This declaration exists so the
 * shape can be *compared*: `migrate.test.ts` fails if a kernel table, column or
 * nullability in the database and in this file disagree.
 *
 * Being a declaration rather than the source of truth, it deliberately states
 * only what it can state faithfully. Anything richer — RLS, ownership, ACLs,
 * partitioning — is covered by the normalized `pg_dump` comparison instead of
 * being half-expressed here.
 */
export const platform = pgSchema('platform');
export const auditSchema = pgSchema('audit');
export const policeAudit = pgSchema('police_audit');

export const idempotencyKey = platform.table('idempotency_key', {
  idempotencyId: uuid('idempotency_id').primaryKey(),
  hotelId: uuid('hotel_id').notNull(),
  realm: text('realm').notNull(),
  actorRef: text('actor_ref').notNull(),
  clientRef: text('client_ref').notNull(),
  operation: text('operation').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  state: text('state').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  correlationId: text('correlation_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const outboxEvent = platform.table('outbox_event', {
  eventId: bigint('event_id', { mode: 'bigint' }).primaryKey(),
  eventUuid: uuid('event_uuid').notNull(),
  hotelId: uuid('hotel_id').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  eventVersion: integer('event_version').notNull(),
  payload: jsonb('payload').notNull(),
  correlationId: text('correlation_id'),
  causationId: text('causation_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
});

export const outboxDelivery = platform.table('outbox_delivery', {
  eventId: bigint('event_id', { mode: 'bigint' }).primaryKey(),
  hotelId: uuid('hotel_id').notNull(),
  state: text('state').notNull(),
  attempts: integer('attempts').notNull(),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
  claimedBy: text('claimed_by'),
  claimedUntil: timestamp('claimed_until', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  lastError: text('last_error'),
  revision: integer('revision').notNull(),
});

export const inboxConsumption = platform.table('inbox_consumption', {
  consumptionId: uuid('consumption_id').primaryKey(),
  hotelId: uuid('hotel_id').notNull(),
  consumer: text('consumer').notNull(),
  dedupKey: text('dedup_key').notNull(),
  source: text('source').notNull(),
  firstConsumedAt: timestamp('first_consumed_at', { withTimezone: true }).notNull(),
});

export const providerEvent = platform.table('provider_event', {
  providerEventRowId: uuid('provider_event_row_id').primaryKey(),
  hotelId: uuid('hotel_id').notNull(),
  provider: text('provider').notNull(),
  providerEventId: text('provider_event_id').notNull(),
  eventKind: text('event_kind').notNull(),
  payloadHash: text('payload_hash').notNull(),
  metadata: jsonb('metadata').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
});

export const jobRun = platform.table('job_run', {
  jobRunId: uuid('job_run_id').primaryKey(),
  hotelId: uuid('hotel_id').notNull(),
  jobName: text('job_name').notNull(),
  jobIdentity: text('job_identity').notNull(),
  /** D-09: who issued the job, as distinct from who executes it. */
  issuerRef: text('issuer_ref'),
  state: text('state').notNull(),
  scope: jsonb('scope').notNull(),
  asOf: timestamp('as_of', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  errorName: text('error_name'),
});

export const exportArtifact = platform.table('export_artifact', {
  exportId: uuid('export_id').primaryKey(),
  hotelId: uuid('hotel_id').notNull(),
  jobRunId: uuid('job_run_id'),
  exportKind: text('export_kind').notNull(),
  storageKey: text('storage_key').notNull(),
  contentHash: text('content_hash').notNull(),
  rowCount: integer('row_count').notNull(),
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

export const projectionCheckpoint = platform.table('projection_checkpoint', {
  projection: text('projection').primaryKey(),
  lastEventId: bigint('last_event_id', { mode: 'bigint' }).notNull(),
  asOf: timestamp('as_of', { withTimezone: true }),
  status: text('status').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  revision: integer('revision').notNull(),
});

export const externalGate = platform.table('external_gate', {
  gateCode: text('gate_code').primaryKey(),
  description: text('description').notNull(),
  enabled: boolean('enabled').notNull(),
  blocker: text('blocker'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const internalGate = platform.table('internal_gate', {
  controlCode: text('control_code').primaryKey(),
  description: text('description').notNull(),
  enabled: boolean('enabled').notNull(),
  blocker: text('blocker'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const featureFlag = platform.table('feature_flag', {
  flagKey: text('flag_key').primaryKey(),
  description: text('description').notNull(),
  enabled: boolean('enabled').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const operationalAlert = platform.table('operational_alert', {
  alertId: uuid('alert_id').primaryKey(),
  alertCode: text('alert_code').notNull(),
  severity: text('severity').notNull(),
  detail: jsonb('detail').notNull(),
  raisedAt: timestamp('raised_at', { withTimezone: true }).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

/**
 * The two append-only audit streams. Declared as their root partitioned tables:
 * the partitions themselves are created by
 * `platform.ensure_month_partitions`, which is SQL-only territory and is
 * covered by the normalized dump rather than by this declaration.
 */
export const platformEvent = auditSchema.table('platform_event', {
  eventId: uuid('event_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
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
  payload: jsonb('payload').notNull(),
});

export const securityEvent = policeAudit.table('security_event', {
  eventId: uuid('event_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  action: text('action').notNull(),
  outcome: text('outcome').notNull(),
  actorRef: text('actor_ref'),
  caseRef: text('case_ref'),
  reason: text('reason'),
  correlationId: text('correlation_id'),
  payload: jsonb('payload').notNull(),
});

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
